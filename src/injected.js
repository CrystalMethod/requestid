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
 * requestId.js and matcher.js, and the interceptor logic is decomposed into
 * small, single-purpose functions to keep per-function complexity low.
 *
 * Fail-open: instrumentation failures leave the request unmodified; invalid
 * application fetch arguments retain native Fetch rejection behavior.
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

  /** Generate a suffix from cryptographically strong random values. */
  function generateWithCrypto() {
    const values = new Uint32Array(SUFFIX_LENGTH);
    crypto.getRandomValues(values);
    let suffix = "";
    for (let i = 0; i < SUFFIX_LENGTH; i++) {
      suffix += CHARS[values[i] % CHARS_LENGTH];
    }
    return suffix;
  }

  /** Generate a suffix from Math.random (fallback when crypto is unavailable). */
  function generateWithMath() {
    let suffix = "";
    for (let i = 0; i < SUFFIX_LENGTH; i++) {
      suffix += CHARS[Math.floor(Math.random() * CHARS_LENGTH)];
    }
    return suffix;
  }

  /** Generate a 5-char alphanumeric suffix (crypto preferred, Math.random fallback). */
  function generateSuffix() {
    if (typeof crypto !== "undefined" && crypto.getRandomValues) {
      return generateWithCrypto();
    }
    return generateWithMath();
  }

  /** Build `prefix-suffix`, or just the suffix when prefix is empty. */
  function buildRequestId() {
    const suffix = generateSuffix();
    return prefix ? prefix + "-" + suffix : suffix;
  }

  // ---------------------------------------------------------------------------
  // Pattern matcher (inlined from matcher.js)
  // ---------------------------------------------------------------------------

  /** True when the URL matches at least one configured pattern. */
  function matchesAny(urlStr) {
    if (!Array.isArray(patterns) || patterns.length === 0) {
      return false;
    }
    try {
      return patterns.some(function (pattern) {
        return matchesPattern(urlStr, pattern);
      });
    } catch (_) {
      return false;
    }
  }

  /** True when the URL matches a single pattern string. */
  function matchesPattern(urlStr, patternStr) {
    const target = parseMatchTarget(urlStr, patternStr);
    if (!target) return false;
    return partsMatch(target.pattern, target.url);
  }

  /** Parse both sides of a match, or null when either side is unusable. */
  function parseMatchTarget(urlStr, patternStr) {
    if (!urlStr || !patternStr) return null;
    const parsedUrl = parseUrl(urlStr);
    if (!parsedUrl) return null;
    return { pattern: parsePattern(patternStr), url: parsedUrl };
  }

  /** Match protocol, host and path of a parsed pattern against a parsed URL. */
  function partsMatch(pattern, url) {
    return (
      protocolMatches(pattern, url) &&
      matchHost(pattern.host, url.host) &&
      matchPath(pattern.path, url.path)
    );
  }

  /** Protocol matches when the pattern is empty/`*`, else requires an exact scheme. */
  function protocolMatches(pattern, url) {
    if (!pattern.protocol || pattern.protocol === "*") return true;
    return pattern.protocol === url.protocol;
  }

  /** Parse a URL pattern (`[scheme://]host[/path]`) into structured parts. */
  function parsePattern(raw) {
    let scheme = "*";
    let rest = raw;
    const schemeIdx = raw.indexOf("://");
    if (schemeIdx !== -1) {
      scheme = raw.slice(0, schemeIdx);
      rest = raw.slice(schemeIdx + 3);
    }
    const slashIdx = rest.indexOf("/");
    if (slashIdx === -1) {
      return { protocol: scheme, host: rest, path: "*" };
    }
    return {
      protocol: scheme,
      host: rest.slice(0, slashIdx),
      path: rest.slice(slashIdx),
    };
  }

  /** Parse a full URL string into structured parts, or null when invalid. */
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

  /** Match a URL host against a pattern host (supports `*` and `*.domain`). */
  function matchHost(ph, uh) {
    if (ph === "*") return true;
    if (ph.startsWith("*.")) return matchSubdomain(ph, uh);
    return ph === uh;
  }

  /** Match `*.domain` patterns: a subdomain must precede the suffix. */
  function matchSubdomain(ph, uh) {
    const suffix = ph.slice(1);
    return uh.endsWith(suffix) && uh.slice(0, uh.length - suffix.length) !== "";
  }

  /** Match a URL path against a pattern path (`*` becomes a wildcard). */
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

  /** Apply a `requestid-config` event payload to the local prefix/patterns. */
  function applyConfig(detail) {
    if (!detail || typeof detail !== "object") return;
    applyPrefix(detail.prefix);
    applyPatterns(detail.patterns);
  }

  /** Store the configured prefix when it is a string. */
  function applyPrefix(value) {
    if (typeof value === "string") {
      prefix = value;
    }
  }

  /** Store the configured pattern list when it is an array. */
  function applyPatterns(value) {
    if (Array.isArray(value)) {
      patterns = value;
    }
  }

  /** Register the config listener; fail-open when the DOM API is unavailable. */
  function listenForConfig() {
    try {
      document.addEventListener("requestid-config", function (e) {
        applyConfig(e.detail);
      });
    } catch (_) {
      /* fail-open: config bridge unavailable (non-DOM context) */
    }
  }

  /** Ask the content script for the current config on load. */
  function requestConfig() {
    try {
      document.dispatchEvent(new CustomEvent("requestid-request-config"));
    } catch (_) {
      /* fail-open: content script handshake unavailable */
    }
  }

  // ---------------------------------------------------------------------------
  // Fetch interceptor — runs in page world, wraps page-originated fetch
  // ---------------------------------------------------------------------------

  /** Extract the request URL from fetch arguments, or "" when unknown. */
  function extractUrl(args) {
    const input = args[0];
    if (input instanceof Request) return input.url;
    if (typeof input === "string") return input;
    if (input instanceof URL) return input.href;
    return "";
  }

  /** True when a URL should receive an injected request ID. */
  function shouldIntercept(urlStr) {
    if (!urlStr || !prefix) return false;
    try {
      return matchesAny(new URL(urlStr, document.baseURI).href);
    } catch (_) {
      return false;
    }
  }

  function resolveFetchHeaders(init) {
    const headers = new Headers(init?.headers);
    if (!headers.has("X-Request-ID")) {
      let requestId;
      try {
        requestId = buildRequestId();
      } catch (_) {
        return null;
      }
      headers.set("X-Request-ID", requestId);
    }
    return { headers };
  }

  /** Apply the resolved headers to a fetch call. */
  function fetchWithRequestId(originalFetch, args) {
    if (args[0] instanceof Request) {
      return fetchRequestWithHeaders(originalFetch, args);
    }
    if (args[1]?.headers === null) {
      return originalFetch(args[0], args[1]);
    }
    const resolved = resolveFetchHeaders(args[1]);
    if (!resolved) return originalFetch(args[0], args[1]);
    return originalFetch(args[0], { ...(args[1] || {}), headers: resolved.headers });
  }

  function fetchRequestWithHeaders(originalFetch, args) {
    const [request, init] = args;
    if (request.bodyUsed && init?.headers !== null) {
      return originalFetch.apply(window, args);
    }
    if (init?.headers === null) {
      return originalFetch(new Request(request, init));
    }
    const headers = new Headers(
      init?.headers === undefined ? request.headers : init.headers,
    );
    if (!headers.has("X-Request-ID")) {
      let requestId;
      try {
        requestId = buildRequestId();
      } catch (_) {
        return originalFetch.apply(window, args);
      }
      headers.set("X-Request-ID", requestId);
    }
    return originalFetch(new Request(request, { ...(init || {}), headers: headers }));
  }

  /** Wrap window.fetch; fail-open to the original fetch on any error. */
  function installFetchInterceptor() {
    if (typeof window.fetch !== "function") return;
    const originalFetch = window.fetch.bind(window);
    window.fetch = async function (...args) {
      const urlStr = extractUrl(args);
      if (shouldIntercept(urlStr)) return fetchWithRequestId(originalFetch, args);
      return originalFetch.apply(window, args);
    };
  }

  // ---------------------------------------------------------------------------
  // XHR interceptor — runs in page world, wraps page-originated XHR
  // ---------------------------------------------------------------------------

  /** Inject the request ID header on an XHR, fail-open on invalid state. */
  function injectRequestIdHeader(xhr) {
    try {
      if (shouldIntercept(xhr._requestUrl) && !xhr._headerInjected) {
        xhr.setRequestHeader("X-Request-ID", buildRequestId());
        xhr._headerInjected = true;
      }
    } catch (_) {
      /* fail-open: request already sent or state invalid */
    }
  }

  /** Wrap XMLHttpRequest open/send to inject the header before dispatch. */
  function installXhrInterceptor() {
    if (typeof window.XMLHttpRequest !== "function") return;
    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      this._requestUrl = url;
      this._headerInjected = false;
      return originalOpen.apply(this, [method, url, ...rest]);
    };

    XMLHttpRequest.prototype.send = function (...args) {
      injectRequestIdHeader(this);
      return originalSend.apply(this, args);
    };
  }

  // ---------------------------------------------------------------------------
  // Bootstrap
  // ---------------------------------------------------------------------------

  listenForConfig();
  requestConfig();
  installFetchInterceptor();
  installXhrInterceptor();
})();
