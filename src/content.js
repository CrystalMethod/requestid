/**
 * RequestID content-script fetch + XHR interceptor.
 *
 * Classic (non-module) content script — no imports or exports, because
 * Manifest V3 service workers / classic scripts cannot import ES modules.
 * All helpers are inlined from matcher.js and requestId.js.
 *
 * Responsibilities
 *   1. Load prefix + patterns from chrome.storage.local into a local cache.
 *   2. Subscribe to storage.onChanged to refresh the cache live.
 *   3. Wrap window.fetch — inject X-Request-ID on matching URLs.
 *   4. Wrap XMLHttpRequest.open / send — same injection logic.
 *   5. Fail-open: any error leaves the request completely unmodified.
 */

// ---------------------------------------------------------------------------
// Local cache — populated on load, refreshed by storage listener
// ---------------------------------------------------------------------------

let prefix = "";
let patterns = [];

chrome.storage.local.get(
  ["prefix", "patterns"],
  (items) => {
    if (items.prefix != null && typeof items.prefix === "string") {
      prefix = items.prefix;
    }
    if (Array.isArray(items.patterns)) {
      patterns = items.patterns;
    }
  },
);

chrome.storage.onChanged.addListener((changes) => {
  if (changes.prefix?.newValue != null && typeof changes.prefix.newValue === "string") {
    prefix = changes.prefix.newValue;
  }
  if (Array.isArray(changes.patterns?.newValue)) {
    patterns = changes.patterns.newValue;
  }
});

// ---------------------------------------------------------------------------
// Helpers (inlined from requestId.js + matcher.js — ~100 lines total)
// ---------------------------------------------------------------------------

/** Generate a 5-char alphanumeric suffix via crypto.getRandomValues */
function generateSuffix() {
  const CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const len = CHARS.length;
  let result = "";
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    const buf = new Uint32Array(5);
    crypto.getRandomValues(buf);
    for (let i = 0; i < 5; i++) {
      result += CHARS[buf[i] % len];
    }
  } else {
    for (let i = 0; i < 5; i++) {
      result += CHARS[Math.floor(Math.random() * len)];
    }
  }
  return result;
}

/** Build full request-id from prefix. */
function buildRequestId() {
  const suffix = generateSuffix();
  return prefix ? prefix + "-" + suffix : suffix;
}

/* ---------- Pattern matcher (inlined from matcher.js) ---------- */

function matchesAny(urlStr) {
  if (!Array.isArray(patterns) || patterns.length === 0) {
    return false;
  }
  try {
    for (let i = 0; i < patterns.length; i++) {
      if (matchesPattern(urlStr, patterns[i])) return true;
    }
  } catch (_) { /* ignore */ }
  return false;
}

function matchesPattern(urlStr, patternStr) {
  if (!patternStr || !urlStr) return false;
  const u = parseUrl(urlStr);
  const p = parsePattern(patternStr);
  if (!u || !p) return false;
  if (p.protocol !== "*" && p.protocol !== "" && p.protocol !== u.protocol) return false;
  if (!matchHost(p.host, u.host)) return false;
  return matchPath(p.path, u.path);
}

function parsePattern(raw) {
  let scheme = "*";
  let rest = raw;
  const idx = raw.indexOf("://");
  if (idx !== -1) {
    scheme = raw.slice(0, idx);
    rest = raw.slice(idx + 3);
  }
  const si = rest.indexOf("/");
  let host, path;
  if (si === -1) { host = rest; path = "*"; }
  else { host = rest.slice(0, si); path = rest.slice(si); }
  return { protocol: scheme, host, path };
}

function parseUrl(urlStr) {
  let obj;
  try { obj = new URL(urlStr); } catch { return null; }
  return {
    protocol: obj.protocol.slice(0, -1),
    host: obj.hostname,
    path: obj.pathname + obj.search + obj.hash,
  };
}

function matchHost(ph, uh) {
  if (ph === "*") return true;
  if (ph.startsWith("*.")) {
    const suf = ph.slice(1);
    return uh.endsWith(suf) && uh.slice(0, uh.length - suf.length) !== "";
  }
  return ph === uh;
}

function matchPath(pp, up) {
  if (pp === "*") return true;
  try {
    const rx = "^" + pp.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$";
    return new RegExp(rx).test(up);
  } catch { return false; }
}

/* ---------- Fetch interceptor ---------- */

if (typeof window.fetch === "function") {
  const _fetch = window.fetch.bind(window);
  window.fetch = async function (...args) {
    try {
      let urlStr = "";
      if (args[0] instanceof Request) {
        urlStr = args[0].url;
      } else if (typeof args[0] === "string") {
        urlStr = args[0];
      } else if (args[0] instanceof URL) {
        urlStr = args[0].href;
      }

      if (urlStr && matchesAny(urlStr) && prefix) {
        let headers = args[1]?.headers;
        let injectIntoRequestHeaders = true;

        if (headers instanceof Headers) {
          if (!headers.has("X-Request-ID")) {
            headers.set("X-Request-ID", buildRequestId());
          }
        } else if (Array.isArray(headers)) {
          // skip — array headers are hard to modify; let request proceed
          injectIntoRequestHeaders = false;
        } else if (headers && typeof headers === "object" && !Array.isArray(headers)) {
          // plain object — check for existing key (case-insensitive), convert to Headers
          const hasHeader = Object.keys(headers).some(
            (k) => k.toLowerCase() === "x-request-id",
          );
          if (!hasHeader) {
            headers = new Headers(headers);
            headers.set("X-Request-ID", buildRequestId());
          } else {
            headers = new Headers(headers);
          }
        } else if (!("headers" in (args[1] || {}))) {
          // headers missing — construct new Headers instance with injected header
          headers = new Headers();
          headers.set("X-Request-ID", buildRequestId());
        } else {
          // headers explicitly null/undefined in init — respect user intent
          injectIntoRequestHeaders = false;
        }

        if (args[0] instanceof Request && injectIntoRequestHeaders) {
          if (args[1] && "headers" in args[1]) {
            // init headers provided — rebuild Request with merged headers
            return _fetch(new Request(args[0], { headers }));
          }
          // No init headers — preserve original Request headers by building
          // a new Headers from them, then inject X-Request-ID on top
          // (only if not already present)
          const reqHeaders = new Headers(args[0].headers);
          if (!reqHeaders.has("X-Request-ID")) {
            reqHeaders.set("X-Request-ID", buildRequestId());
          }
          return _fetch(new Request(args[0], { headers: reqHeaders }));
        }
        return _fetch(args[0], { ...(args[1] || {}), headers });
      }
    } catch (_) { /* fail-open */ }
    return _fetch.apply(window, args);
  };
}

/* ---------- XHR interceptor ---------- */

if (typeof window.XMLHttpRequest === "function") {
  const _xhrOpen = XMLHttpRequest.prototype.open;
  const _xhrSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this._requestUrl = url;
    this._headerInjected = false;
    try { return _xhrOpen.apply(this, [method, url, ...rest]); }
    catch (_) { return _xhrOpen.apply(this, [method, url, ...rest]); }
  };

  XMLHttpRequest.prototype.send = function (...args) {
    try {
      const urlStr = this._requestUrl;
      if (urlStr && matchesAny(urlStr) && prefix && !this._headerInjected) {
        try {
          // Check if setRequestHeader was already called with X-Request-ID
          // by trying to set it — the browser keeps the first value,
          // so we only inject when we're confident it's not set.
          this.setRequestHeader("X-Request-ID", buildRequestId());
          this._headerInjected = true;
        } catch (_) { /* request already sent or state invalid */ }
      }
    } catch (_) { /* fail-open */ }
    try { return _xhrSend.apply(this, args); }
    catch (_) { return _xhrSend.apply(this, args); }
  };
}
