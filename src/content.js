/**
 * RequestID content-script bridge.
 *
 * Classic (non-module) content script — no imports or exports, because
 * Manifest V3 classic scripts cannot import ES modules.
 *
 * Responsibilities
 *   1. Inject src/injected.js into the page world via a dynamically created
 *      <script> tag so the page-world interceptor can wrap window.fetch and
 *      XMLHttpRequest for page-originated requests.
 *   2. Load prefix + patterns from chrome.storage.local and forward them to
 *      the injected script via a "requestid-config" CustomEvent.
 *   3. Refresh the injected script's config live via storage.onChanged.
 *   4. Answer config-request handshakes from the injected script.
 *
 * All fetch/XHR interception lives in src/injected.js (page world); this
 * script is only the chrome.storage ↔ page-world bridge.
 */

// ---------------------------------------------------------------------------
// Config bridge — content script → injected page-world script
// ---------------------------------------------------------------------------

/**
 * Dispatch the current prefix + patterns to the injected page-world script.
 * @param {string} configPrefix
 * @param {string[]} configPatterns
 */
function dispatchConfig(configPrefix, configPatterns) {
  try {
    document.dispatchEvent(
      new CustomEvent("requestid-config", {
        detail: { prefix: configPrefix, patterns: configPatterns },
      }),
    );
  } catch (_) {
    /* fail-open: non-DOM context */
  }
}

/** Read prefix + patterns from chrome.storage.local and forward them. */
function loadAndDispatchConfig() {
  chrome.storage.local.get(["prefix", "patterns"], (items) => {
    const configPrefix =
      items.prefix != null && typeof items.prefix === "string" ? items.prefix : "";
    const configPatterns = Array.isArray(items.patterns) ? items.patterns : [];
    dispatchConfig(configPrefix, configPatterns);
  });
}

// ---------------------------------------------------------------------------
// Page-world injection
// ---------------------------------------------------------------------------

/** Inject src/injected.js into the page world via a dynamically created script tag. */
function injectPageWorldScript() {
  try {
    const script = document.createElement("script");
    script.src = chrome.runtime.getURL("src/injected.js");
    script.onload = () => script.remove();
    (document.head || document.documentElement).appendChild(script);
  } catch (_) {
    /* fail-open: injection unavailable */
  }
}

// ---------------------------------------------------------------------------
// Handshake — injected script asks for config on load
// ---------------------------------------------------------------------------

/**
 * Reply to a config request from the injected script with fresh storage values.
 * Listens for both event spellings so the bridge stays compatible with the
 * injected script's "requestid-request-config" handshake.
 */
function handleConfigRequest() {
  loadAndDispatchConfig();
}

document.addEventListener("requestid-config-request", handleConfigRequest);
document.addEventListener("requestid-request-config", handleConfigRequest);

// ---------------------------------------------------------------------------
// Live refresh — forward storage changes to the injected script
// ---------------------------------------------------------------------------

chrome.storage.onChanged.addListener((changes) => {
  const prefixChanged =
    changes.prefix?.newValue != null && typeof changes.prefix.newValue === "string";
  const patternsChanged = Array.isArray(changes.patterns?.newValue);
  if (!prefixChanged && !patternsChanged) return;
  // Re-read the full config so both fields stay consistent.
  loadAndDispatchConfig();
});

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

injectPageWorldScript();
loadAndDispatchConfig();
