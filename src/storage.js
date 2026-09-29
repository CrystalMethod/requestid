/**
 * RequestID persistent storage module.
 *
 * Wraps chrome.storage.local with a typed API:
 *   - getPrefix() / setPrefix(prefix)
 *   - getPatterns() / setPatterns(patterns)
 *
 * Defaults:
 *   prefix   = ""   (empty string — onboarding required)
 *   patterns = []   (empty array)
 *
 * Fail-open: every getter returns a sensible default when the
 * storage call fails so the extension keeps working.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_PREFIX = "";
const DEFAULT_PATTERNS = [];

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

/**
 * Validate a request-id pattern value.
 * @param {*} value
 * @returns {value is string}
 */
function isValidPattern(value) {
  return typeof value === "string" && value.trim().length > 0;
}

// ---------------------------------------------------------------------------
// Prefix API
// ---------------------------------------------------------------------------

/**
 * Read the configured request-id prefix.
 * @returns {Promise<string>}
 */
export async function getPrefix() {
  try {
    const result = await chrome.storage.local.get("prefix");
    return result.prefix ?? DEFAULT_PREFIX;
  } catch {
    // Fail-open: default to empty string.
    return DEFAULT_PREFIX;
  }
}

/**
 * Persist a request-id prefix after validating it.
 * @param {string} prefix
 * @returns {Promise<void>}
 */
export async function setPrefix(prefix) {
  try {
    if (prefix == null || typeof prefix !== "string") {
      throw new TypeError("prefix must be a string");
    }
    // Empty prefix is allowed — it triggers onboarding.
    await chrome.storage.local.set({ prefix });
  } catch (err) {
    // Fail-open: silently ignore; the default is returned on read.
    console.warn("[RequestID] storage.setPrefix failed:", err);
  }
}

// ---------------------------------------------------------------------------
// Patterns API
// ---------------------------------------------------------------------------

/**
 * Read the configured URL-matching patterns.
 * @returns {Promise<string[]>}
 */
export async function getPatterns() {
  try {
    const result = await chrome.storage.local.get("patterns");
    return Array.isArray(result.patterns) ? result.patterns : DEFAULT_PATTERNS;
  } catch {
    return DEFAULT_PATTERNS;
  }
}

/**
 * Persist URL-matching patterns after validating each entry.
 *
 * @param {string[]} patterns
 * @returns {Promise<void>}
 */
export async function setPatterns(patterns) {
  try {
    if (!Array.isArray(patterns)) {
      throw new TypeError("patterns must be an array");
    }

    // Filter to only valid (non-empty string) patterns.
    const valid = patterns.filter(isValidPattern);
    await chrome.storage.local.set({ patterns: valid });
  } catch (err) {
    console.warn("[RequestID] storage.setPatterns failed:", err);
  }
}
