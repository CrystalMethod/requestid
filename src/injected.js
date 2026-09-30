/**
 * RequestID injected page-world interceptor.
 *
 * This script is injected into the page via a dynamically created <script> tag
 * from the content script. Because it runs in the page's main JavaScript world
 * (not the content script's isolated world), it can wrap window.fetch and
 * XMLHttpRequest for all page-originated requests — including requests made by
 * page frameworks such as Angular's HttpClient.
 *
 * Communication with the content script happens via CustomEvent:
 *   - "requestid-config" — content script → injected: delivers prefix + patterns
 *   - "requestid-request-config" — injected → content script: asks for config on load
 *
 * The script is a classic (non-module) IIFE: no imports or exports, because it
 * is loaded via a <script src> tag in the page world. All helpers
 * (generateSuffix, buildRequestId, pattern matching) are inlined from
 * requestId.js and matcher.js.
 *
 * Fail-open: any error leaves the request completely unmodified.
 */

(function () {
  "use strict";

  // ---------------------------------------------------------------------------
  // Local state — populated via CustomEvent from the content script
  // ---------------------------------------------------------------------------

  let prefix = "";
  let patterns = [];

  // ---------------------------------------------------------------------------
  // Request ID generation (inlined from requestId.js)
  // ---------------------------------------------------------------------------

  const SUFFIX_LENGTH = 5;
  const CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const CHARS_LENGTH = CHARS.length;

  /** Generate a 5-char alphanumeric suffix (crypto preferred, Math.random fallback). */
  function generateSuffix() {
    let result = "";
    if (typeof crypto !== "undefined" && crypto.getRandomValues) {
      const values = new Uint32Array(SUFFIX_LENGTH);
      crypto.getRandomValues(values);
      for (let i = 0; i < SUFFIX_LENGTH; i++) {
        result += CHARS[values[i] % CHARS_LENGTH];
      }
    } else {
      for (let i = 0; i < SUFFIX_LENGTH; i++) {
        result += CHARS[Math.floor(Math.random() * CHARS_LENGTH)];
      }
    }
    return result;
  }

  /** Build `prefix-suffix`, or just the suffix when prefix is empty. */
  function buildRequestId() {
    const suffix = generateSuffix();
    return prefix ? prefix + "-" + suffix : suffix;
  }

  // ---------------------------------------------------------------------------
  // Pattern matcher (inlined from matcher.js)
  // ---------------------------------------------------------------------------

  function matchesAny(urlStr) {
    if (!Array.isArray(patterns) || patterns.length === 0) {
      return false;
    }
    try {
      for (let i = 0; i < patterns.length; i++) {
        if (matchesPattern(urlStr, patterns[i])) return true;
      }
    } catch (_) {
      /* ignore */
    }
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
    if (si === -1) {
      host = rest;
      path = "*";
    } else {
      host = rest.slice(0, si);
      path = rest.slice(si);
    }
    return { protocol: scheme, host, path };
  }

  function parseUrl(urlStr) {
    let obj;
    try {
      obj = new URL(urlStr);
    } catch {
      return null;
    }
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
    } catch {
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // Configuration bridge — listen for config from content script
  // ---------------------------------------------------------------------------

  try {
    document.addEventListener("requestid-config", function (e) {
      if (e.detail && typeof e.detail === "object") {
        if (typeof e.detail.prefix === "string") {
          prefix = e.detail.prefix;
        }
        if (Array.isArray(e.detail.patterns)) {
          patterns = e.detail.patterns;
        }
      }
    });
  } catch (_) {
    /* fail-open: config bridge unavailable (non-DOM context) */
  }

  // Request config from content script on load
  try {
    document.dispatchEvent(new CustomEvent("requestid-request-config"));
  } catch (_) {
    /* fail-open: content script handshake unavailable */
  }

  // ---------------------------------------------------------------------------
  // Fetch interceptor — runs in page world, wraps page-originated fetch
  // ---------------------------------------------------------------------------

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
            // Array headers — hard to modify safely; let request proceed
            injectIntoRequestHeaders = false;
          } else if (headers && typeof headers === "object" && !Array.isArray(headers)) {
            // Plain object headers
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
            // No headers in init — create new Headers with injected header
            headers = new Headers();
            headers.set("X-Request-ID", buildRequestId());
          } else {
            // headers explicitly null/undefined — respect user intent
            injectIntoRequestHeaders = false;
          }

          if (args[0] instanceof Request && injectIntoRequestHeaders) {
            if (args[1] && "headers" in args[1]) {
              return _fetch(new Request(args[0], { headers }));
            }
            // No init headers — preserve original Request headers
            const reqHeaders = new Headers(args[0].headers);
            if (!reqHeaders.has("X-Request-ID")) {
              reqHeaders.set("X-Request-ID", buildRequestId());
            }
            return _fetch(new Request(args[0], { headers: reqHeaders }));
          }
          return _fetch(args[0], { ...(args[1] || {}), headers });
        }
      } catch (_) {
        /* fail-open */
      }
      return _fetch.apply(window, args);
    };
  }

  // ---------------------------------------------------------------------------
  // XHR interceptor — runs in page world, wraps page-originated XHR
  // ---------------------------------------------------------------------------

  if (typeof window.XMLHttpRequest === "function") {
    const _xhrOpen = XMLHttpRequest.prototype.open;
    const _xhrSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      this._requestUrl = url;
      this._headerInjected = false;
      try {
        return _xhrOpen.apply(this, [method, url, ...rest]);
      } catch (_) {
        return _xhrOpen.apply(this, [method, url, ...rest]);
      }
    };

    XMLHttpRequest.prototype.send = function (...args) {
      try {
        const urlStr = this._requestUrl;
        if (urlStr && matchesAny(urlStr) && prefix && !this._headerInjected) {
          try {
            this.setRequestHeader("X-Request-ID", buildRequestId());
            this._headerInjected = true;
          } catch (_) {
            /* request already sent or state invalid */
          }
        }
      } catch (_) {
        /* fail-open */
      }
      try {
        return _xhrSend.apply(this, args);
      } catch (_) {
        return _xhrSend.apply(this, args);
      }
    };
  }
})();
