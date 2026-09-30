/**
 * RequestID onboarding — classic non-module script.
 *
 * First-run view that lets the user set a request-id prefix and initial URL
 * patterns.  Storage helpers are inlined so the script works without any
 * bundler or ES-module support (extension pages cannot be type="module").
 */

// ---------------------------------------------------------------------------
// Storage helpers — mirrors src/popup.js so onboarding is self-contained
// ---------------------------------------------------------------------------

/**
 * Read the configured prefix from chrome.storage.local.
 * @returns {Promise<string>}
 */
async function getPrefix() {
	try {
		const result = await chrome.storage.local.get("prefix");
		return result.prefix ?? "";
	} catch {
		return "";
	}
}

/**
 * Persist a prefix string.
 * @param {string} prefix
 * @returns {Promise<void>}
 */
async function setPrefix(prefix) {
	try {
		if (prefix == null || typeof prefix !== "string") {
			throw new TypeError("prefix must be a string");
		}
		await chrome.storage.local.set({ prefix });
	} catch (err) {
		console.warn("[RequestID] storage.setPrefix failed:", err);
	}
}

/**
 * Read the configured URL-matching patterns.
 * @returns {Promise<string[]>}
 */
async function getPatterns() {
	try {
		const result = await chrome.storage.local.get("patterns");
		return Array.isArray(result.patterns) ? result.patterns : [];
	} catch {
		return [];
	}
}

/**
 * Persist an array of URL-matching patterns after validating each entry.
 * @param {string[]} patterns
 * @returns {Promise<void>}
 */
async function setPatterns(patterns) {
	try {
		if (!Array.isArray(patterns)) {
			throw new TypeError("patterns must be an array");
		}
		const valid = patterns.filter(
			(v) => typeof v === "string" && v.trim().length > 0,
		);
		await chrome.storage.local.set({ patterns: valid });
	} catch (err) {
		console.warn("[RequestID] storage.setPatterns failed:", err);
	}
}

/**
 * Notify the background service worker that the prefix changed so it can
 * update the extension badge.
 * @param {string} prefix
 * @returns {Promise<void>}
 */
async function notifyBadge(prefix) {
	try {
		await chrome.runtime.sendMessage({ action: "prefixUpdated", prefix });
	} catch {
		// Fail-open — badge update is not critical for onboarding UX.
	}
}

// ---------------------------------------------------------------------------
// DOM references
// ---------------------------------------------------------------------------

const prefixInput = document.getElementById("prefix-input");
const savePrefixBtn = document.getElementById("save-prefix-btn");
const prefixWarning = document.getElementById("prefix-warning");
const patternInput = document.getElementById("pattern-input");
const addPatternBtn = document.getElementById("add-pattern-btn");
const patternList = document.getElementById("pattern-list");
const invalidMessage = document.getElementById("invalid-message");
const statusIndicator = document.getElementById("status-indicator");
const finishBtn = document.getElementById("finish-btn");

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let currentPatterns = [];

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * Render the pattern list into the DOM.
 */
function renderPatterns() {
	patternList.textContent = "";

	if (currentPatterns.length === 0) {
		const li = document.createElement("li");
		li.className = "empty-state";
		li.textContent = "No patterns configured";
		patternList.appendChild(li);
		return;
	}

	currentPatterns.forEach((pattern) => {
		const li = document.createElement("li");
		li.className = "pattern-item";

		const code = document.createElement("code");
		code.textContent = pattern;
		li.appendChild(code);

		const removeBtn = document.createElement("button");
		removeBtn.className = "remove-btn";
		removeBtn.type = "button";
		removeBtn.setAttribute("aria-label", `Remove pattern ${pattern}`);
		removeBtn.textContent = "×";

		removeBtn.addEventListener("click", () => {
			currentPatterns = currentPatterns.filter((p) => p !== pattern);
			setPatterns(currentPatterns).catch(() => {});
			renderPatterns();
			updateStatus();
		});

		li.appendChild(removeBtn);
		patternList.appendChild(li);
	});
}

/**
 * Update the footer status indicator and prefix warning to reflect whether a
 * prefix is configured.
 */
function updateStatus() {
	const prefix = prefixInput.value;
	if (!prefix || prefix.trim() === "") {
		statusIndicator.textContent = "Warning: prefix is empty";
		statusIndicator.className = "status-indicator warning";
		prefixWarning.textContent =
			"Warning: prefix is empty. Requests will be sent without an X-Request-ID header.";
	} else {
		statusIndicator.textContent = "Active";
		statusIndicator.className = "status-indicator active";
		prefixWarning.textContent = "";
	}
}

// ---------------------------------------------------------------------------
// Clear the invalid-pattern message
// ---------------------------------------------------------------------------

function clearInvalidMessage() {
	invalidMessage.textContent = "";
}

// ---------------------------------------------------------------------------
// Pattern validation
// ---------------------------------------------------------------------------

/**
 * Validate a raw URL pattern string.
 *
 * A usable pattern must be non-empty, contain no whitespace, and include a
 * host component (e.g. `api.example.com`, `*.example.com`, `*`).  The host may
 * be preceded by an optional `scheme://` prefix.  This mirrors the parsing
 * performed by src/matcher.js so patterns that could never match are rejected
 * before they are persisted.
 *
 * @param {string} raw - The raw input value.
 * @returns {string | null} A human-readable error message, or null when valid.
 */
function validatePattern(raw) {
	const pattern = typeof raw === "string" ? raw.trim() : "";

	if (pattern === "") {
		return "Pattern cannot be empty.";
	}

	if (/\s/.test(pattern)) {
		return "Pattern cannot contain spaces.";
	}

	let remainder = pattern;
	const schemeIdx = pattern.indexOf("://");
	if (schemeIdx !== -1) {
		const scheme = pattern.slice(0, schemeIdx);
		if (!/^[A-Za-z*][A-Za-z0-9+.-]*$/.test(scheme)) {
			return "Invalid pattern: unsupported scheme.";
		}
		remainder = pattern.slice(schemeIdx + 3);
	}

	const slashIdx = remainder.indexOf("/");
	const host = slashIdx === -1 ? remainder : remainder.slice(0, slashIdx);

	if (host === "") {
		return "Invalid pattern: a host is required (e.g. example.com).";
	}

	if (!/^[A-Za-z0-9*]([A-Za-z0-9.*:-]*[A-Za-z0-9*])?$/.test(host)) {
		return "Invalid pattern: host contains unsupported characters.";
	}

	return null;
}

// ---------------------------------------------------------------------------
// Event listeners
// ---------------------------------------------------------------------------

/** Save prefix to storage and notify background. */
savePrefixBtn.addEventListener("click", async () => {
	const prefix = prefixInput.value;
	await setPrefix(prefix);
	await notifyBadge(prefix);
	updateStatus();
});

/** Add a new pattern. */
addPatternBtn.addEventListener("click", () => {
	const raw = patternInput.value;
	const pattern = typeof raw === "string" ? raw.trim() : "";

	// Reject empty, whitespace, or otherwise malformed input.
	const validationError = validatePattern(raw);
	if (validationError) {
		invalidMessage.textContent = validationError;
		return;
	}

	// Reject duplicates.
	if (currentPatterns.includes(pattern)) {
		invalidMessage.textContent = "This pattern already exists.";
		return;
	}

	currentPatterns.push(pattern);
	setPatterns(currentPatterns).catch(() => {});
	patternInput.value = "";
	clearInvalidMessage();
	renderPatterns();
	updateStatus();
});

/** Enter key in the pattern input triggers add. */
patternInput.addEventListener("keydown", (e) => {
	if (e.key === "Enter") {
		e.preventDefault();
		addPatternBtn.click();
	}
});

/** Re-evaluate status whenever the prefix input changes. */
prefixInput.addEventListener("input", updateStatus);

/** Finish onboarding: persist current settings, then close the tab. */
finishBtn.addEventListener("click", async () => {
	const prefix = prefixInput.value;
	await setPrefix(prefix);
	await notifyBadge(prefix);
	await setPatterns(currentPatterns);
	window.close();
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

document.addEventListener("DOMContentLoaded", async () => {
	try {
		const prefix = await getPrefix();
		prefixInput.value = prefix;

		currentPatterns = await getPatterns();
		renderPatterns();
	} catch {
		// Fail-open: show an empty form.
	}

	updateStatus();
	prefixInput.focus();
});
