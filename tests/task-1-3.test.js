/**
 * Tests for Phase 1.4: Page-world script injection + CustomEvent config bridge.
 *
 * The interception architecture changed from a single content-script
 * interceptor to a two-part design:
 *
 *   - src/content.js is now a thin bridge. It injects src/injected.js into the
 *     page's main JavaScript world via a dynamically created <script> tag and
 *     forwards chrome.storage prefix/patterns over a "requestid-config"
 *     CustomEvent. It NO LONGER wraps window.fetch or XMLHttpRequest directly.
 *
 *   - src/injected.js runs in the page world. It listens for "requestid-config"
 *     (updating its prefix/patterns), asks the content script for config via a
 *     "requestid-request-config" handshake, and wraps window.fetch /
 *     XMLHttpRequest for all page-originated requests.
 *
 * Both scripts are classic (non-module) browser scripts that reference globals
 * directly, so each is loaded into a fresh vm context with a minimal harness:
 *   - content.js: chrome.storage.local.get (callback), storage.onChanged,
 *     chrome.runtime.getURL, document (createElement + head.appendChild +
 *     event dispatch/listener), CustomEvent.
 *   - injected.js: window.fetch stub, XMLHttpRequest stub, document events,
 *     CustomEvent, plus Request/Headers/URL/Response/crypto globals.
 *
 * The two harnesses can share one event bus to prove the end-to-end flow:
 *   chrome.storage → content.js → "requestid-config" → injected.js → header.
 */

import { describe, test, before } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const CONTENT_SRC = path.join(ROOT, "src", "content.js");
const INJECTED_SRC = path.join(ROOT, "src", "injected.js");
const MANIFEST_PATH = path.join(ROOT, "manifest.json");

const CONTENT_SOURCE = fs.readFileSync(CONTENT_SRC, "utf8");
const INJECTED_SOURCE = fs.readFileSync(INJECTED_SRC, "utf8");

const ID_RE = /^req-[A-Za-z0-9]{5}$/;
const SUFFIX_RE = /^[A-Za-z0-9]{5}$/;

// ============================================================================
// HARNESS PRIMITIVES
// ============================================================================

/** Deep-clone a vm-realm value into a host-realm plain value for assertions. */
function toHostValue(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

/** Host-realm CustomEvent stub shared by sandboxed scripts and the test. */
class HostCustomEvent {
  constructor(type, init) {
    this.type = type;
    this.detail = init?.detail;
  }
}

/**
 * Build a shared document stub with a real event bus (listeners + dispatch).
 *
 * @param {{createElementThrows?: boolean, dispatchThrows?: boolean}} opts
 */
function makeDom({ createElementThrows = false, dispatchThrows = false } = {}) {
  const listeners = new Map();
  const dispatched = [];
  const appendedScripts = [];

  const head = {
    appendChild(node) {
      appendedScripts.push(node);
      return node;
    },
  };

  const document = {
    head,
    documentElement: head,
    addEventListener(type, cb) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(cb);
    },
    removeEventListener(type, cb) {
      const arr = listeners.get(type);
      if (!arr) return;
      const idx = arr.indexOf(cb);
      if (idx !== -1) arr.splice(idx, 1);
    },
    dispatchEvent(event) {
      if (dispatchThrows) throw new Error("dispatch unavailable");
      dispatched.push({ type: event.type, detail: toHostValue(event.detail) });
      const arr = listeners.get(event.type);
      if (arr) for (const cb of arr.slice()) cb(event);
      return true;
    },
    createElement(tag) {
      if (createElementThrows) throw new Error("createElement unavailable");
      return {
        tagName: String(tag).toUpperCase(),
        src: "",
        onload: null,
        removed: false,
        remove() {
          this.removed = true;
        },
      };
    },
  };

  return {
    document,
    dispatched,
    appendedScripts,
    fire(type, detail) {
      return document.dispatchEvent({ type, detail });
    },
    count(type) {
      return dispatched.filter((e) => e.type === type).length;
    },
    lastOf(type) {
      return dispatched.filter((e) => e.type === type).pop();
    },
    scripts() {
      return appendedScripts;
    },
  };
}

/**
 * Build a chrome.* stub over a shared backing store.
 *
 * @param {object} store backing object for chrome.storage.local
 */
function makeChromeStub(store) {
  let onChangedCb = null;
  const chrome = {
    storage: {
      local: {
        get(keys, cb) {
          const arr = Array.isArray(keys) ? keys : [keys];
          const items = {};
          for (const k of arr) {
            if (Object.prototype.hasOwnProperty.call(store, k)) items[k] = store[k];
          }
          cb(items);
        },
      },
      onChanged: {
        addListener(cb) {
          onChangedCb = cb;
        },
      },
    },
    runtime: {
      getURL(resourcePath) {
        return `chrome-extension://abcdefghijklmnopabcdefghijklmnop/${resourcePath}`;
      },
    },
  };

  return {
    chrome,
    fireChange(changes) {
      // Mirror the browser: storage is already updated when onChanged fires.
      for (const key of Object.keys(changes)) {
        const { newValue } = changes[key];
        if (newValue === undefined) delete store[key];
        else store[key] = newValue;
      }
      if (typeof onChangedCb === "function") onChangedCb(changes);
    },
    getOnChanged() {
      return onChangedCb;
    },
  };
}

/**
 * Load src/content.js into a fresh vm context.
 *
 * @param {{store?: object, dom?: object, dispatchThrows?: boolean,
 *          createElementThrows?: boolean}} opts
 */
function makeContent({
  store = {},
  dom,
  dispatchThrows = false,
  createElementThrows = false,
} = {}) {
  const domImpl = dom ?? makeDom({ dispatchThrows, createElementThrows });
  const chromeStub = makeChromeStub(store);
  const sandbox = {
    chrome: chromeStub.chrome,
    document: domImpl.document,
    CustomEvent: HostCustomEvent,
    console,
  };
  sandbox.window = sandbox;
  const context = vm.createContext(sandbox);
  vm.runInContext(CONTENT_SOURCE, context);
  return { dom: domImpl, chromeStub, sandbox };
}

/** Default XMLHttpRequest stub capturing open/send/setRequestHeader. */
function makeXhrStub(xhrCalls) {
  return class XMLHttpRequestStub {
    constructor() {
      this._injected = {};
      this._requestUrl = undefined;
      this._headerInjected = false;
    }
    open(method, url) {
      this.method = method;
      this._requestUrl = url;
      xhrCalls.push({ type: "open", method, url });
    }
    setRequestHeader(name, value) {
      this._injected[name] = value;
    }
    send(...args) {
      xhrCalls.push({
        type: "send",
        url: this._requestUrl,
        injected: { ...this._injected },
      });
    }
  };
}

/**
 * Load src/injected.js into a fresh vm context.
 *
 * @param {{dom?: object, fetchStub?: Function, XHRStub?: Function}} opts
 */
function makeInjected({ dom, fetchStub, XHRStub } = {}) {
  const domImpl = dom ?? makeDom();
  const fetchCalls = [];
  const fetchImpl =
    fetchStub ??
    ((...args) => {
      fetchCalls.push(args);
      return Promise.resolve({ ok: true, status: 200 });
    });
  const xhrCalls = [];
  const XHRClass = XHRStub ?? makeXhrStub(xhrCalls);

  const sandbox = {
    document: domImpl.document,
    CustomEvent: HostCustomEvent,
    Request,
    Headers,
    URL,
    Response,
    crypto,
    console,
    fetch: fetchImpl,
    XMLHttpRequest: XHRClass,
  };
  sandbox.window = sandbox;
  const context = vm.createContext(sandbox);
  vm.runInContext(INJECTED_SOURCE, context);
  return { dom: domImpl, sandbox, fetchCalls, xhrCalls, XHRClass };
}

/** Extract a header value from a captured fetch call (init or Request form). */
function fetchHeader(fetchCalls, index, name) {
  const args = fetchCalls[index];
  if (!args) return undefined;
  const first = args[0];
  const init = args[1];
  let headers;
  if (first instanceof Request) {
    headers = first.headers;
  } else if (init && init.headers) {
    headers = init.headers;
  } else {
    return undefined;
  }
  if (headers instanceof Headers) return headers.get(name);
  if (Array.isArray(headers)) {
    const pair = headers.find(
      (h) => h[0] && String(h[0]).toLowerCase() === name.toLowerCase(),
    );
    return pair ? pair[1] : undefined;
  }
  const key = Object.keys(headers || {}).find(
    (k) => k.toLowerCase() === name.toLowerCase(),
  );
  return key ? headers[key] : undefined;
}

// ============================================================================
// CONTENT.JS — STATIC CONTRACT (the bridge replaced direct wrapping)
// ============================================================================

describe("content.js is a thin bridge (no direct fetch/XHR wrapping)", () => {
  test("source still exists and is non-trivial", () => {
    assert.ok(fs.existsSync(CONTENT_SRC), "src/content.js must exist");
    assert.ok(CONTENT_SOURCE.length > 0);
  });

  test("dispatches a requestid-config CustomEvent", () => {
    assert.match(CONTENT_SOURCE, /requestid-config/);
    assert.match(CONTENT_SOURCE, /document\.dispatchEvent/);
  });

  test("injects src/injected.js via chrome.runtime.getURL", () => {
    assert.match(
      CONTENT_SOURCE,
      /chrome\.runtime\.getURL\(\s*["']src\/injected\.js["']\s*\)/,
      "content.js must resolve src/injected.js with chrome.runtime.getURL",
    );
    assert.match(
      CONTENT_SOURCE,
      /createElement\(\s*["']script["']\s*\)/,
      "content.js must create a <script> element",
    );
  });

  test("does NOT wrap window.fetch directly", () => {
    assert.ok(
      !/window\.fetch\s*=/.test(CONTENT_SOURCE),
      "content.js must not assign window.fetch (interception lives in injected.js)",
    );
  });

  test("does NOT patch XMLHttpRequest.prototype directly", () => {
    assert.ok(
      !/XMLHttpRequest\.prototype/.test(CONTENT_SOURCE),
      "content.js must not patch XMLHttpRequest.prototype (interception lives in injected.js)",
    );
  });
});

// ============================================================================
// CONTENT.JS — RUNTIME CONTRACT (loaded in a vm with browser stubs)
// ============================================================================

describe("content.js bootstrap: injects page-world script + dispatches config", () => {
  test("creates a <script> tag pointing at the injected script and appends it", () => {
    const store = { prefix: "req", patterns: ["https://example.com/*"] };
    const { dom } = makeContent({ store });
    const scripts = dom.scripts();
    assert.strictEqual(scripts.length, 1, "exactly one script tag should be injected");
    assert.strictEqual(
      scripts[0].src,
      "chrome-extension://abcdefghijklmnopabcdefghijklmnop/src/injected.js",
    );
  });

  test("script.onload removes the injected tag", () => {
    const { dom } = makeContent({ store: {} });
    const script = dom.scripts()[0];
    assert.strictEqual(typeof script.onload, "function");
    script.onload();
    assert.strictEqual(script.removed, true);
  });

  test("dispatches requestid-config with prefix/patterns from storage on load", () => {
    const store = { prefix: "req", patterns: ["https://example.com/*"] };
    const { dom } = makeContent({ store });
    const evt = dom.lastOf("requestid-config");
    assert.ok(evt, "content.js should dispatch an initial requestid-config event");
    assert.deepStrictEqual(evt.detail, {
      prefix: "req",
      patterns: ["https://example.com/*"],
    });
  });

  test("normalizes malformed storage values (non-string prefix, non-array patterns)", () => {
    const store = { prefix: 123, patterns: "not-an-array" };
    const { dom } = makeContent({ store });
    const evt = dom.lastOf("requestid-config");
    assert.deepStrictEqual(evt.detail, { prefix: "", patterns: [] });
  });

  test("missing storage keys fall back to empty prefix and empty patterns", () => {
    const { dom } = makeContent({ store: {} });
    const evt = dom.lastOf("requestid-config");
    assert.deepStrictEqual(evt.detail, { prefix: "", patterns: [] });
  });
});

describe("content.js handshake: replies to config requests", () => {
  test("responds to the injected script's requestid-request-config handshake", () => {
    const store = { prefix: "req", patterns: ["https://example.com/*"] };
    const { dom } = makeContent({ store });
    const before = dom.count("requestid-config");
    dom.fire("requestid-request-config");
    assert.strictEqual(dom.count("requestid-config"), before + 1);
    assert.deepStrictEqual(dom.lastOf("requestid-config").detail, {
      prefix: "req",
      patterns: ["https://example.com/*"],
    });
  });

  test("also responds to the alternate requestid-config-request spelling", () => {
    const store = { prefix: "abc", patterns: ["https://a.com/*"] };
    const { dom } = makeContent({ store });
    const before = dom.count("requestid-config");
    dom.fire("requestid-config-request");
    assert.strictEqual(dom.count("requestid-config"), before + 1);
    assert.strictEqual(dom.lastOf("requestid-config").detail.prefix, "abc");
  });
});

describe("content.js live refresh: chrome.storage.onChanged re-dispatches config", () => {
  test("registers a storage.onChanged listener", () => {
    const { chromeStub } = makeContent({ store: {} });
    assert.strictEqual(typeof chromeStub.getOnChanged(), "function");
  });

  test("a patterns change re-dispatches the new config", () => {
    const store = { prefix: "req", patterns: ["https://a.com/*"] };
    const { dom, chromeStub } = makeContent({ store });
    const before = dom.count("requestid-config");
    chromeStub.fireChange({ patterns: { newValue: ["https://b.com/*"] } });
    assert.strictEqual(dom.count("requestid-config"), before + 1);
    assert.deepStrictEqual(dom.lastOf("requestid-config").detail, {
      prefix: "req",
      patterns: ["https://b.com/*"],
    });
  });

  test("a prefix change re-dispatches the new config", () => {
    const store = { prefix: "req", patterns: ["https://a.com/*"] };
    const { dom, chromeStub } = makeContent({ store });
    const before = dom.count("requestid-config");
    chromeStub.fireChange({ prefix: { newValue: "trace" } });
    assert.strictEqual(dom.count("requestid-config"), before + 1);
    assert.strictEqual(dom.lastOf("requestid-config").detail.prefix, "trace");
  });

  test("an unrelated change does not re-dispatch config", () => {
    const store = { prefix: "req", patterns: ["https://a.com/*"] };
    const { dom, chromeStub } = makeContent({ store });
    const before = dom.count("requestid-config");
    chromeStub.fireChange({ somethingElse: { newValue: 1 } });
    assert.strictEqual(dom.count("requestid-config"), before);
  });
});

describe("content.js fail-open when DOM APIs are unavailable", () => {
  test("does not throw when document.dispatchEvent throws", () => {
    assert.doesNotThrow(() => {
      makeContent({ store: { prefix: "req" }, dispatchThrows: true });
    });
  });

  test("does not throw when document.createElement throws", () => {
    assert.doesNotThrow(() => {
      makeContent({ store: { prefix: "req" }, createElementThrows: true });
    });
  });
});

// ============================================================================
// INJECTED.JS — CONFIG BRIDGE
// ============================================================================

describe("injected.js requests config on load (handshake)", () => {
  test("dispatches requestid-request-config at bootstrap", () => {
    const { dom } = makeInjected();
    assert.ok(
      dom.count("requestid-request-config") >= 1,
      "injected.js should ask the content script for config on load",
    );
  });
});

describe("injected.js applies requestid-config from the content script", () => {
  test("a matching URL receives a fresh X-Request-ID after config arrives", async () => {
    const { dom, sandbox, fetchCalls } = makeInjected();
    dom.fire("requestid-config", {
      prefix: "req",
      patterns: ["https://example.com/*"],
    });
    sandbox.window.fetch("https://example.com/api");
    await Promise.resolve();
    assert.strictEqual(fetchCalls.length, 1);
    assert.match(fetchHeader(fetchCalls, 0, "X-Request-ID"), ID_RE);
  });

  test("two matching calls produce different request ids", async () => {
    const { dom, sandbox, fetchCalls } = makeInjected();
    dom.fire("requestid-config", {
      prefix: "req",
      patterns: ["https://example.com/*"],
    });
    sandbox.window.fetch("https://example.com/a");
    sandbox.window.fetch("https://example.com/b");
    await Promise.resolve();
    const first = fetchHeader(fetchCalls, 0, "X-Request-ID");
    const second = fetchHeader(fetchCalls, 1, "X-Request-ID");
    assert.match(second, ID_RE);
    assert.notStrictEqual(second, first);
  });

  test("a non-matching URL passes through unmodified", async () => {
    const { dom, sandbox, fetchCalls } = makeInjected();
    dom.fire("requestid-config", {
      prefix: "req",
      patterns: ["https://example.com/*"],
    });
    sandbox.window.fetch("https://other.com/api");
    await Promise.resolve();
    assert.strictEqual(fetchCalls.length, 1);
    assert.strictEqual(fetchHeader(fetchCalls, 0, "X-Request-ID"), undefined);
    assert.strictEqual(fetchCalls[0][1], undefined);
  });

  test("an empty prefix fails open (no injection)", async () => {
    const { dom, sandbox, fetchCalls } = makeInjected();
    dom.fire("requestid-config", {
      prefix: "",
      patterns: ["https://example.com/*"],
    });
    sandbox.window.fetch("https://example.com/api");
    await Promise.resolve();
    assert.strictEqual(fetchCalls.length, 1);
    assert.strictEqual(fetchHeader(fetchCalls, 0, "X-Request-ID"), undefined);
  });

  test("an empty pattern list fails open (no injection)", async () => {
    const { dom, sandbox, fetchCalls } = makeInjected();
    dom.fire("requestid-config", { prefix: "req", patterns: [] });
    sandbox.window.fetch("https://example.com/api");
    await Promise.resolve();
    assert.strictEqual(fetchCalls.length, 1);
    assert.strictEqual(fetchHeader(fetchCalls, 0, "X-Request-ID"), undefined);
  });

  test("malformed config values are ignored (previous config retained)", async () => {
    const { dom, sandbox, fetchCalls } = makeInjected();
    dom.fire("requestid-config", {
      prefix: "req",
      patterns: ["https://example.com/*"],
    });
    dom.fire("requestid-config", { prefix: 999, patterns: "nope" });
    sandbox.window.fetch("https://example.com/api");
    await Promise.resolve();
    assert.match(fetchHeader(fetchCalls, 0, "X-Request-ID"), ID_RE);
  });
});

// ============================================================================
// INJECTED.JS — REQUEST SHAPE HANDLING
// ============================================================================

describe("injected.js Request-argument fetch preserves headers", () => {
  test("preserves Content-Type/Authorization and adds X-Request-ID", async () => {
    const { dom, sandbox, fetchCalls } = makeInjected();
    dom.fire("requestid-config", {
      prefix: "req",
      patterns: ["https://example.com/*"],
    });
    const req = new Request("https://example.com/api", {
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer top-secret-token",
      },
    });
    sandbox.window.fetch(req);
    await Promise.resolve();
    assert.strictEqual(fetchCalls.length, 1);
    assert.strictEqual(fetchHeader(fetchCalls, 0, "Content-Type"), "application/json");
    assert.strictEqual(
      fetchHeader(fetchCalls, 0, "Authorization"),
      "Bearer top-secret-token",
    );
    assert.match(fetchHeader(fetchCalls, 0, "X-Request-ID"), ID_RE);
  });

  test("preserves a caller-supplied X-Request-ID instead of overwriting it", async () => {
    const { dom, sandbox, fetchCalls } = makeInjected();
    dom.fire("requestid-config", {
      prefix: "req",
      patterns: ["https://example.com/*"],
    });
    const req = new Request("https://example.com/api", {
      headers: { "X-Request-ID": "existing-id" },
    });
    sandbox.window.fetch(req);
    await Promise.resolve();
    assert.strictEqual(fetchHeader(fetchCalls, 0, "X-Request-ID"), "existing-id");
  });

  test("does not mutate the caller's original Request", async () => {
    const { dom, sandbox, fetchCalls } = makeInjected();
    dom.fire("requestid-config", {
      prefix: "req",
      patterns: ["https://example.com/*"],
    });
    const req = new Request("https://example.com/api", {
      headers: { "Content-Type": "text/plain" },
    });
    sandbox.window.fetch(req);
    await Promise.resolve();
    assert.strictEqual(req.headers.get("X-Request-ID"), null);
    assert.strictEqual(req.headers.get("Content-Type"), "text/plain");
    assert.ok(fetchCalls[0][0] instanceof Request);
  });

  test("plain-object headers init is converted and augmented", async () => {
    const { dom, sandbox, fetchCalls } = makeInjected();
    dom.fire("requestid-config", {
      prefix: "req",
      patterns: ["https://example.com/*"],
    });
    sandbox.window.fetch("https://example.com/api", {
      headers: { "Content-Type": "application/json" },
    });
    await Promise.resolve();
    assert.strictEqual(fetchHeader(fetchCalls, 0, "Content-Type"), "application/json");
    assert.match(fetchHeader(fetchCalls, 0, "X-Request-ID"), ID_RE);
  });
});

// ============================================================================
// INJECTED.JS — XHR INTERCEPTION
// ============================================================================

describe("injected.js XHR interception", () => {
  test("injects X-Request-ID on a matching XHR open+send", () => {
    const { dom, sandbox, xhrCalls } = makeInjected();
    dom.fire("requestid-config", {
      prefix: "req",
      patterns: ["https://example.com/*"],
    });
    const xhr = new sandbox.XMLHttpRequest();
    xhr.open("GET", "https://example.com/api");
    xhr.send();
    const send = xhrCalls.find((c) => c.type === "send");
    assert.match(send.injected["X-Request-ID"], ID_RE);
  });

  test("does not inject on a non-matching XHR URL", () => {
    const { dom, sandbox, xhrCalls } = makeInjected();
    dom.fire("requestid-config", {
      prefix: "req",
      patterns: ["https://example.com/*"],
    });
    const xhr = new sandbox.XMLHttpRequest();
    xhr.open("GET", "https://different.com/api");
    xhr.send();
    const send = xhrCalls.find((c) => c.type === "send");
    assert.strictEqual(send.injected["X-Request-ID"], undefined);
  });

  test("a reused XHR injects a fresh header on each open+send cycle", () => {
    const { dom, sandbox, xhrCalls } = makeInjected();
    dom.fire("requestid-config", {
      prefix: "req",
      patterns: ["https://example.com/*"],
    });
    const xhr = new sandbox.XMLHttpRequest();
    xhr.open("GET", "https://example.com/api");
    xhr.send();
    xhr.open("GET", "https://example.com/api");
    xhr.send();
    const sends = xhrCalls.filter((c) => c.type === "send");
    assert.match(sends[0].injected["X-Request-ID"], ID_RE);
    assert.match(sends[1].injected["X-Request-ID"], ID_RE);
    assert.notStrictEqual(
      sends[0].injected["X-Request-ID"],
      sends[1].injected["X-Request-ID"],
    );
  });
});

// ============================================================================
// INTEGRATION — storage → content.js → CustomEvent → injected.js → header
// ============================================================================

describe("integration: storage to injected header injection", () => {
  test("config flows through the CustomEvent bridge into page-world fetch", async () => {
    const store = { prefix: "req", patterns: ["https://example.com/*"] };
    const dom = makeDom();
    // Content script bootstraps first: injects the page-world script and
    // dispatches the initial config (before the page script has subscribed).
    makeContent({ store, dom });
    // Injected script loads, registers its config listener, and performs the
    // handshake — the content script answers with the stored config.
    const injected = makeInjected({ dom });
    assert.ok(
      dom.count("requestid-config") >= 2,
      "bridge should deliver config at least once after the handshake",
    );

    injected.sandbox.window.fetch("https://example.com/api");
    await Promise.resolve();
    assert.match(fetchHeader(injected.fetchCalls, 0, "X-Request-ID"), ID_RE);
  });

  test("only matching URLs receive a prefixed id", async () => {
    const store = { prefix: "trace", patterns: ["*://*.internal.com/*"] };
    const dom = makeDom();
    makeContent({ store, dom });
    const injected = makeInjected({ dom });

    injected.sandbox.window.fetch("https://api.internal.com/data");
    injected.sandbox.window.fetch("https://public.example.com/data");
    await Promise.resolve();

    assert.match(fetchHeader(injected.fetchCalls, 0, "X-Request-ID"), /^trace-[A-Za-z0-9]{5}$/);
    assert.strictEqual(fetchHeader(injected.fetchCalls, 1, "X-Request-ID"), undefined);
  });

  test("a live storage change updates injection without reloading the page", async () => {
    const store = { prefix: "req", patterns: ["https://a.com/*"] };
    const dom = makeDom();
    const { chromeStub } = makeContent({ store, dom });
    const injected = makeInjected({ dom });

    injected.sandbox.window.fetch("https://a.com/api");
    await Promise.resolve();
    assert.match(fetchHeader(injected.fetchCalls, 0, "X-Request-ID"), ID_RE);

    // Change the configured patterns; the bridge re-dispatches and the
    // page-world interceptor follows the new pattern set.
    chromeStub.fireChange({ patterns: { newValue: ["https://b.com/*"] } });

    injected.sandbox.window.fetch("https://a.com/api");
    injected.sandbox.window.fetch("https://b.com/api");
    await Promise.resolve();

    assert.strictEqual(
      fetchHeader(injected.fetchCalls, 1, "X-Request-ID"),
      undefined,
      "old pattern should no longer be intercepted",
    );
    assert.match(fetchHeader(injected.fetchCalls, 2, "X-Request-ID"), ID_RE);
  });
});

// ============================================================================
// INJECTED.JS — REQUEST-ID GENERATION
// ============================================================================

describe("injected.js request id generation (observed via fetch)", () => {
  test("with a prefix, ids are prefix-<5 alnum chars>", async () => {
    const { dom, sandbox, fetchCalls } = makeInjected();
    dom.fire("requestid-config", {
      prefix: "svc",
      patterns: ["https://example.com/*"],
    });
    sandbox.window.fetch("https://example.com/api");
    await Promise.resolve();
    const id = fetchHeader(fetchCalls, 0, "X-Request-ID");
    assert.match(id, /^svc-[A-Za-z0-9]{5}$/);
  });

  test("the suffix portion is exactly 5 alphanumeric characters", async () => {
    const { dom, sandbox, fetchCalls } = makeInjected();
    dom.fire("requestid-config", {
      prefix: "x",
      patterns: ["https://example.com/*"],
    });
    sandbox.window.fetch("https://example.com/api");
    await Promise.resolve();
    const id = fetchHeader(fetchCalls, 0, "X-Request-ID");
    assert.match(id, /^x-/);
    assert.match(id.slice("x-".length), SUFFIX_RE);
  });
});

// ============================================================================
// MANIFEST — page-world script is web-accessible
// ============================================================================

describe("manifest exposes src/injected.js to the page world", () => {
  let manifest;

  before(() => {
    manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  });

  test("manifest still loads the content-script bridge", () => {
    const jsFiles = (manifest.content_scripts || []).flatMap((cs) => cs.js || []);
    assert.ok(jsFiles.includes("src/content.js"));
    for (const rel of jsFiles) {
      assert.ok(fs.existsSync(path.join(ROOT, rel)), `missing referenced file: ${rel}`);
    }
  });

  test("web_accessible_resources exposes src/injected.js to <all_urls>", () => {
    const war = manifest.web_accessible_resources;
    assert.ok(Array.isArray(war), "web_accessible_resources must be an array");

    // Support both the MV3 object form and the legacy flat string form.
    const resources = [];
    const matches = [];
    for (const entry of war) {
      if (typeof entry === "string") {
        resources.push(entry);
      } else {
        for (const r of entry.resources || []) resources.push(r);
        for (const m of entry.matches || []) matches.push(m);
      }
    }

    assert.ok(
      resources.includes("src/injected.js"),
      "src/injected.js must be a web-accessible resource",
    );
    assert.ok(
      matches.includes("<all_urls>"),
      "src/injected.js must be exposed to <all_urls>",
    );
    assert.ok(
      fs.existsSync(path.join(ROOT, "src", "injected.js")),
      "the exposed resource must exist on disk",
    );
  });
});
