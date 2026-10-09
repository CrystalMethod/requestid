/**
 * RequestID generator module.
 *
 * Produces short, random alphanumeric suffixes (5 chars, A-Z, a-z, 0-9)
 * suitable for embedding in HTTP headers.
 *
 * Pure functions — no chrome APIs, no global state mutation between calls
 * (each call to `generateSuffix` is independent).
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SUFFIX_LENGTH = 5;
const CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const CHARS_LENGTH = CHARS.length;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate a fresh 5-character random alphanumeric suffix.
 *
 * Uses `crypto.getRandomValues` in browser/Node environments that support it,
 * falling back to `Math.random` otherwise.
 *
 * Each call produces a value that differs from its neighbours (statistically
 * independent with 62^5 ≈ 916M possible values).
 *
 * @returns {string}
 */
export function generateSuffix() {
	let chars = "";
	if (typeof crypto !== "undefined" && crypto.getRandomValues) {
		chars = generateWithCrypto();
	} else {
		chars = generateWithMath();
	}
	return chars;
}

/**
 * Build a full RequestID from a prefix and a generated suffix.
 *
 * @param {string} prefix - The prefix string (may be empty).
 * @returns {string} `prefix-suffix` format; empty prefix yields just the suffix.
 */
export function buildRequestId(prefix) {
	const suffix = generateSuffix();
	if (prefix === undefined || prefix === null || prefix === "") {
		return suffix;
	}
	return `${prefix}-${suffix}`;
}

// ---------------------------------------------------------------------------
// Internal generators
// ---------------------------------------------------------------------------

/**
 * Generate a suffix using crypto.getRandomValues (preferred — cryptographically
 * strong randomness).
 *
 * @returns {string}
 */
function generateWithCrypto() {
	const values = new Uint32Array(SUFFIX_LENGTH);
	crypto.getRandomValues(values);
	let result = "";
	for (let i = 0; i < SUFFIX_LENGTH; i++) {
		result += CHARS[values[i] % CHARS_LENGTH];
	}
	return result;
}

/**
 * Fallback generator using Math.random.
 *
 * @returns {string}
 */
function generateWithMath() {
	let result = "";
	for (let i = 0; i < SUFFIX_LENGTH; i++) {
		result += CHARS[Math.floor(Math.random() * CHARS_LENGTH)];
	}
	return result;
}
