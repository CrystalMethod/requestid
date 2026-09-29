/**
 * RequestID popup — classic non-module script.
 *
 * Provides a configuration panel for the extension prefix and URL-matching
 * patterns.  Storage helpers are inlined so the script works without any
 * bundler or ES-module support (Chrome popups cannot be type="module").
 */

// ---------------------------------------------------------------------------
// Storage helpers — mirrors src/storage.js so the popup is self-contained
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
		// Fail-open — badge update is not critical for popup UX.
	}
}

// ---------------------------------------------------------------------------
// DOM references
// ---------------------------------------------------------------------------

const prefixInput = document.getElementById("prefix-input");
const savePrefixBtn = document.getElementById("save-prefix-btn");
const patternInput = document.getElementById("pattern-input");
const addPatternBtn = document.getElementById("add-pattern-btn");
const patternList = document.getElementById("pattern-list");
const invalidMessage = document.getElementById("invalid-message");
const statusIndicator = document.getElementById("status-indicator");

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
 * Update the footer status indicator to show Active or warning state.
 */
function updateStatus() {
	const prefix = prefixInput.value;
	if (!prefix || prefix.trim() === "") {
		statusIndicator.textContent = "Warning: prefix is empty";
		statusIndicator.className = "status-indicator warning";
	} else {
		statusIndicator.textContent = "Active";
		statusIndicator.className = "status-indicator active";
	}
}

// ---------------------------------------------------------------------------
// Clear the invalid-pattern message
// ---------------------------------------------------------------------------

function clearInvalidMessage() {
	invalidMessage.textContent = "";
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
	const pattern = patternInput.value;

	// Reject empty / whitespace-only input.
	if (!pattern || pattern.trim() === "") {
		invalidMessage.textContent = "Pattern cannot be empty.";
		return;
	}

	// Reject duplicates.
	if (currentPatterns.includes(pattern.trim())) {
		invalidMessage.textContent = "This pattern already exists.";
		return;
	}

	currentPatterns.push(pattern.trim());
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
});
