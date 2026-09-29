/**
 * Tests for Phase 1.3: Content-script fetch + XHR interceptor.
 *
 * content.js is a classic (non-module) content script — no imports/exports.
 * It references browser globals directly (chrome, window, Request, Headers,
 * URL, XMLHttpRequest, crypto). To test it at runtime we build a minimal
 * node harness:
 *   - stub chrome.storage.local (preset prefix + patterns, onChanged capture)
 *   - stub window.fetch (captures url + init)
 *   - provide Request, Headers, URL, Response, crypto globals
 *   - stub XMLHttpRequest (captures open + send + setRequestHeader)
 * then load the content.js source into a fresh vm context (its globals).
 *
 * Proves at runtime:
 *   - plain fetch without init injects a fresh X-Request-ID on matching URLs
 *   - Request-arg fetch preserves original Request headers (Content-Type,
 *     Authorization) and preserves a pre-existing X-Request-ID (no overwrite)
 *   - empty prefix sends requests unmodified (fail-open)
 *   - non-matching URLs carry no header
 *   - reused XHR object injects on each open+send cycle
 *   - empty and nil inputs fail open without throwing
 *   - empty-pattern-list and null-input edge cases
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

/**
 * Build a fresh browser-ish sandbox and load content.js into it.
 *
 * @param {{prefix?: string|undefined, patterns?: Array|undefined}} opts
 * @returns {{
 *   sandbox: object, fetchCalls: Array, xhrCalls: Array,
 *   getOnChanged: () => function|null, fireChange: (c: object) => void,
 *   windowXHR: Function
 * }}
 */
function makeLoaded({ prefix = "", patterns = [] } = {}) {
  const store = { prefix, patterns };
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
  };

  // Capture every real fetch(...) call made by the interceptor.
  const fetchCalls = [];
  const fetchStub = (...args) => {
    fetchCalls.push(args);
    return Promise.resolve({ ok: true, status: 200 });
  };

  // Capture open/send/setRequestHeader on XHR instances.
  const xhrCalls = [];
  class XMLHttpRequest {
    constructor() {
      this._injected = {};
      this._requestUrl = undefined;
      this._headerInjected = false;
      this.opened = false;
      this.sent = false;
    }
    open(method, url, async_, user, password) {
      this.method = method;
      this._requestUrl = url;
      this.opened = true;
      xhrCalls.push({ type: "open", method, url });
    }
    setRequestHeader(name, value) {
      this._injected[name] = value;
    }
    send(...args) {
      this.sent = true;
      xhrCalls.push({ type: "send", url: this._requestUrl, injected: { ...this._injected } });
    }
  }

  const sandbox = {
    chrome,
    Request,
    Headers,
    URL,
    Response,
    XMLHttpRequest,
    crypto,
    console,
  };
  // In a browser `window` is the global object; make bare globals === window.*.
  sandbox.window = sandbox;
  sandbox.fetch = fetchStub;
  sandbox.XMLHttpRequest = XMLHttpRequest;

  const context = vm.createContext(sandbox);
  const source = fs.readFileSync(CONTENT_SRC, "utf8");
  vm.runInContext(source, context);

  return {
    sandbox,
    fetchCalls,
    xhrCalls,
    getOnChanged: () => onChangedCb,
    fireChange: (changes) => {
      if (typeof onChangedCb === "function") onChangedCb(changes);
    },
    windowXHR: XMLHttpRequest,
  };
}

/** Extract a header value from a captured fetch call.
 *  Supports init-object form (url, {headers}) and Request-object form. */
function fetchHeader(fetchCalls, index, name) {
  const args = fetchCalls[index];
  const init = args[1];
  const first = args[0];
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
    const pair = headers.find((h) => h[0] && String(h[0]).toLowerCase() === name.toLowerCase());
    return pair ? pair[1] : undefined;
  }
  const key = Object.keys(headers || {}).find(
    (k) => k.toLowerCase() === name.toLowerCase(),
  );
  return key ? headers[key] : undefined;
}

const ID_RE = /^req-[A-Za-z0-9]{5}$/;

// ============================================================================
// PLAIN FETCH — inject fresh X-Request-ID on matching URL
// ============================================================================

describe("plain fetch without init injects a fresh X-Request-ID", () => {
  let h;
  before(() => {
    h = makeLoaded({ prefix: "req", patterns: ["https://example.com/*"] });
  });

  test("injects header on a matching URL", async () => {
    h.sandbox.fetch("https://example.com/api");
    await Promise.resolve();
    assert.strictEqual(h.fetchCalls.length, 1);
    const id = fetchHeader(h.fetchCalls, 0, "X-Request-ID");
    assert.match(id, ID_RE);
  });

  test("a second matching call injects a fresh, different value", async () => {
    h.sandbox.fetch("https://example.com/users");
    await Promise.resolve();
    const first = fetchHeader(h.fetchCalls, 0, "X-Request-ID");
    const second = fetchHeader(h.fetchCalls, 1, "X-Request-ID");
    assert.match(second, ID_RE);
    assert.notStrictEqual(second, first, "each call should produce a fresh id");
  });

  test("non-matching URL carries no header (passed through unmodified)", async () => {
    h.sandbox.fetch("https://other-example.com/api");
    await Promise.resolve();
    const last = h.fetchCalls.length - 1;
    assert.strictEqual(fetchHeader(h.fetchCalls, last, "X-Request-ID"), undefined);
  });
});

// ============================================================================
// REQUEST-ARG FETCH — preserve original headers + existing X-Request-ID
// ============================================================================

describe("Request-arg fetch preserves original request headers", () => {
  let h;
  before(() => {
    h = makeLoaded({ prefix: "req", patterns: ["https://example.com/*"] });
  });

  test("preserves Content-Type and Authorization, adds X-Request-ID", async () => {
    const req = new Request("https://example.com/api", {
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer top-secret-token",
      },
    });
    h.sandbox.fetch(req);
    await Promise.resolve();
    assert.strictEqual(h.fetchCalls.length, 1);
    assert.strictEqual(fetchHeader(h.fetchCalls, 0, "Content-Type"), "application/json");
    assert.strictEqual(fetchHeader(h.fetchCalls, 0, "Authorization"), "Bearer top-secret-token");
    assert.match(fetchHeader(h.fetchCalls, 0, "X-Request-ID"), ID_RE);
  });

  test("preserves a pre-existing X-Request-ID instead of overwriting it", async () => {
    const req = new Request("https://example.com/api", {
      headers: { "X-Request-ID": "existing-id" },
    });
    h.sandbox.fetch(req);
    await Promise.resolve();
    assert.strictEqual(h.fetchCalls.length, 2);
    assert.strictEqual(fetchHeader(h.fetchCalls, 1, "X-Request-ID"), "existing-id");
  });

  test("does not mutate the caller's original Request", async () => {
    const req = new Request("https://example.com/api", {
      headers: { "Content-Type": "text/plain" },
    });
    h.sandbox.fetch(req);
    await Promise.resolve();
    assert.strictEqual(req.headers.get("X-Request-ID"), null, "original Request must not be mutated");
    assert.strictEqual(req.headers.get("Content-Type"), "text/plain");
  });
});

// ============================================================================
// FAIL-OPEN — empty prefix, empty patterns → pass-through
// ============================================================================

describe("fail-open behavior", () => {
  test("empty prefix sends requests unmodified (no header injection)", async () => {
    const h = makeLoaded({ prefix: "", patterns: ["https://example.com/*"] });
    h.sandbox.fetch("https://example.com/api");
    await Promise.resolve();
    assert.strictEqual(h.fetchCalls.length, 1);
    const args = h.fetchCalls[0];
    // No init at all → request is passed through with exactly the input args.
    assert.strictEqual(args[0], "https://example.com/api");
    assert.strictEqual(args[1], undefined);
  });

  test("empty pattern list sends requests unmodified (fail-open)", async () => {
    const h = makeLoaded({ prefix: "req", patterns: [] });
    h.sandbox.fetch("https://example.com/api");
    await Promise.resolve();
    assert.strictEqual(h.fetchCalls.length, 1);
    assert.strictEqual(h.fetchCalls[0][0], "https://example.com/api");
    assert.strictEqual(h.fetchCalls[0][1], undefined);
  });
});

// ============================================================================
// NULL / UNDEFINED INPUTS — fail open without throwing
// ============================================================================

describe("null and undefined inputs fail open", () => {
  test("fetch(null) passes through without throwing", async () => {
    const h = makeLoaded({ prefix: "req", patterns: ["https://example.com/*"] });
    let threw = false;
    await h.sandbox.fetch(null).catch(() => {
      // The interceptor may rejoin a real fetch(null) which itself may reject
      // in Node; that is still a pass-through of the original error, not a
      // throw from the interceptor.
      threw = true;
    });
    // Assert the call was forwarded to the underlying stub with urlStr null.
    assert.strictEqual(h.fetchCalls.length, 1);
    assert.ok(h.fetchCalls[0][0] === null || h.fetchCalls[0][0] === undefined);
  });

  test("fetch(undefined) passes through without throwing", async () => {
    const h = makeLoaded({ prefix: "req", patterns: ["https://example.com/*"] });
    let threw = false;
    await h.sandbox.fetch(undefined).catch(() => {
      threw = true;
    });
    assert.strictEqual(h.fetchCalls.length, 1);
  });

  test("fetch with undefined init and matching URL injects header (headers not supplied)", async () => {
    const h = makeLoaded({ prefix: "req", patterns: ["https://example.com/*"] });
    h.sandbox.fetch("https://example.com/path", undefined);
    await Promise.resolve();
    assert.match(fetchHeader(h.fetchCalls, 0, "X-Request-ID"), ID_RE);
  });

  test("fetch with null init on matching URL still injects header", async () => {
    const h = makeLoaded({ prefix: "req", patterns: ["https://example.com/*"] });
    h.sandbox.fetch("https://example.com/path", null);
    await Promise.resolve();
    assert.match(fetchHeader(h.fetchCalls, 0, "X-Request-ID"), ID_RE);
  });

  test("null and empty pattern strings never match (fail-open, no throw)", async () => {
    const h = makeLoaded({ prefix: "req", patterns: [null, "", "   "] });
    h.sandbox.fetch("https://example.com/api");
    await Promise.resolve();
    assert.strictEqual(h.fetchCalls.length, 1);
    assert.strictEqual(h.fetchCalls[0][1], undefined, "no header should be injected");
  });
});

// ============================================================================
// XHR — inject on each open + send cycle
// ============================================================================

describe("reused XHR object injects on each open+send cycle", () => {
  test("same instance injects a fresh header on each open+send cycle", async () => {
    const h = makeLoaded({ prefix: "req", patterns: ["https://example.com/*"] });
    const xhr = new h.windowXHR();

    xhr.open("GET", "https://example.com/api");
    xhr.send();
    const firstCycle = h.xhrCalls.filter((c) => c.type === "send")[0];

    xhr.open("GET", "https://example.com/api");
    xhr.send();
    const secondCycle = h.xhrCalls.filter((c) => c.type === "send")[1];

    assert.match(firstCycle.injected["X-Request-ID"], ID_RE);
    assert.match(secondCycle.injected["X-Request-ID"], ID_RE);
    assert.notStrictEqual(
      firstCycle.injected["X-Request-ID"],
      secondCycle.injected["X-Request-ID"],
      "each cycle should inject a fresh header",
    );
  });

  test("XHR does not inject on non-matching URL", async () => {
    const h = makeLoaded({ prefix: "req", patterns: ["https://example.com/*"] });
    const xhr = new h.windowXHR();
    xhr.open("GET", "https://different.com/api");
    xhr.send();
    const send = h.xhrCalls.find((c) => c.type === "send");
    assert.strictEqual(send.injected["X-Request-ID"], undefined);
  });
});

// ============================================================================
// STORAGE LISTENER — onChanged refreshes the live cache
// ============================================================================

describe("storage.onChanged refreshes prefix and patterns live", () => {
  test("changing patterns via onChanged flips injection on/off", () => {
    const h = makeLoaded({ prefix: "req", patterns: ["https://a.com/*"] });
    assert.strictEqual(typeof h.getOnChanged(), "function");

    // Toggle patterns to a non-matching set going forward.
    h.fireChange({ patterns: { newValue: ["https://b.com/*"] } });

    h.sandbox.fetch("https://a.com/api");
    assert.strictEqual(fetchHeader(h.fetchCalls, 0, "X-Request-ID"), undefined);

    // Restore a matching pattern set.
    h.fireChange({ patterns: { newValue: ["https://a.com/*"] } });
    h.sandbox.fetch("https://a.com/api");
    assert.match(fetchHeader(h.fetchCalls, 1, "X-Request-ID"), ID_RE);
  });
});

// ============================================================================
// MANIFEST — content_scripts block references an existing file
// ============================================================================

describe("manifest content_scripts references existing files", () => {
  test("manifest declares content_scripts with src/content.js present on disk", () => {
    const raw = fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8");
    const manifest = JSON.parse(raw);
    const jsFiles = (manifest.content_scripts || []).flatMap((cs) => cs.js || []);
    assert.ok(jsFiles.includes("src/content.js"), "content script should reference src/content.js");
    for (const rel of jsFiles) {
      assert.ok(fs.existsSync(path.join(ROOT, rel)), `missing referenced file: ${rel}`);
    }
  });
});


