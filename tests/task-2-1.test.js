/**
 * Tests for Phase 2.1: Popup configuration panel.
 *
 * popup.js is a classic (non-module) script that references browser globals
 * directly (chrome.storage.local, chrome.runtime.sendMessage, document/DOM).
 * To exercise it at runtime we build a minimal node harness:
 *   - stub chrome.storage.local (in-memory backing store, optional failure)
 *   - stub chrome.runtime.sendMessage (captures messages, optional failure)
 *   - lightweight DOM stub (getElementById / createElement / addEventListener)
 * then load popup.js source into a fresh vm context.
 *
 * Proves at runtime:
 *   - prefix save persists via setPrefix and sends prefixUpdated message
 *   - pattern add appends and persists via setPatterns
 *   - pattern remove deletes and persists
 *   - invalid / empty / duplicate pattern rejected with validation message
 *   - status indicator shows Active when prefix set, warning when empty
 *   - pattern list renders via textContent (no innerHTML anywhere)
 *   - empty / nil inputs fail open without throwing
 *   - boot (DOMContentLoaded) hydrates prefix + patterns from storage
 *   - manifest action.default_popup points at an existing popup.html
 */

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const POPUP_SRC = path.join(ROOT, "src", "popup.js");
const POPUP_HTML = path.join(ROOT, "src", "popup.html");

const ELEMENT_IDS = [
	"prefix-input",
	"save-prefix-btn",
	"pattern-input",
	"add-pattern-btn",
	"pattern-list",
	"invalid-message",
	"status-indicator",
];

/** Flush pending microtasks + timers so floating promises settle. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Normalize a value created inside the vm realm into a host-realm plain
 * value so deepStrictEqual does not trip over cross-realm prototypes.
 */
const plain = (v) => JSON.parse(JSON.stringify(v));

/**
 * Minimal DOM element stub. textContent is a real accessor: assigning it
 * clears children (mirrors the browser), reading it concatenates own text
 * plus descendants.
 */
class Element {
	constructor(tag) {
		this.tagName = String(tag).toUpperCase();
		this.children = [];
		this.attributes = {};
		this.listeners = {};
		this._text = "";
		this.value = "";
		this.className = "";
		this.type = "";
		this.id = "";
	}

	get textContent() {
		if (this.children.length === 0) return this._text;
		return this._text + this.children.map((c) => c.textContent).join("");
	}

	set textContent(v) {
		this._text = String(v);
		this.children = [];
	}

	appendChild(child) {
		this.children.push(child);
		return child;
	}

	setAttribute(name, value) {
		this.attributes[name] = String(value);
	}

	getAttribute(name) {
		return this.attributes[name];
	}

	addEventListener(type, cb) {
		if (!this.listeners[type]) this.listeners[type] = [];
		this.listeners[type].push(cb);
	}

	/** Invoke click listeners; returns a promise resolving when they settle. */
	click() {
		const results = (this.listeners.click || []).map((cb) =>
			cb({ preventDefault() {} }),
		);
		return Promise.all(results);
	}

	/** Invoke arbitrary event listeners synchronously. */
	dispatch(type, event = {}) {
		for (const cb of this.listeners[type] || []) cb(event);
	}
}

/**
 * Build a fresh sandbox and load popup.js into it.
 *
 * @param {{prefix?: string, patterns?: string[], storageThrows?: boolean,
 *          sendMessageThrows?: boolean}} opts
 */
function makeHarness({
	prefix,
	patterns,
	storageThrows = false,
	sendMessageThrows = false,
} = {}) {
	const store = {};
	if (prefix !== undefined) store.prefix = prefix;
	if (patterns !== undefined) store.patterns = patterns;

	const messages = [];

	const chrome = {
		storage: {
			local: {
				async get(key) {
					if (storageThrows) throw new Error("storage unavailable");
					const keys = Array.isArray(key) ? key : [key];
					const out = {};
					for (const k of keys) {
						if (Object.hasOwn(store, k)) out[k] = store[k];
					}
					return out;
				},
				async set(items) {
					if (storageThrows) throw new Error("storage unavailable");
					Object.assign(store, items);
				},
			},
		},
		runtime: {
			async sendMessage(msg) {
				if (sendMessageThrows) throw new Error("no receiver");
				messages.push(msg);
				return {};
			},
		},
	};

	const elements = {};
	for (const id of ELEMENT_IDS) {
		const el = new Element("div");
		el.id = id;
		elements[id] = el;
	}

	const domListeners = {};
	const document = {
		getElementById: (id) => elements[id] ?? null,
		createElement: (tag) => new Element(tag),
		addEventListener: (type, cb) => {
			if (!domListeners[type]) domListeners[type] = [];
			domListeners[type].push(cb);
		},
	};

	const sandbox = { chrome, document, console };
	const context = vm.createContext(sandbox);
	vm.runInContext(fs.readFileSync(POPUP_SRC, "utf8"), context, {
		filename: "popup.js",
	});

	return {
		sandbox,
		store,
		messages,
		elements,
		fireDOMContentLoaded: async () => {
			for (const cb of domListeners.DOMContentLoaded || []) await cb();
		},
	};
}

// ============================================================================
// PREFIX SAVE — persists via setPrefix + sends prefixUpdated
// ============================================================================

describe("prefix save persists and notifies background", () => {
	test("saving a prefix writes storage and sends prefixUpdated", async () => {
		const h = makeHarness();
		h.elements["prefix-input"].value = "myapp";
		await h.elements["save-prefix-btn"].click();
		await tick();

		assert.strictEqual(h.store.prefix, "myapp");
		assert.deepStrictEqual(plain(h.messages), [
			{ action: "prefixUpdated", prefix: "myapp" },
		]);
		assert.strictEqual(h.elements["status-indicator"].textContent, "Active");
	});

	test("saving an empty prefix persists empty string and warns", async () => {
		const h = makeHarness();
		h.elements["prefix-input"].value = "";
		await h.elements["save-prefix-btn"].click();
		await tick();

		assert.strictEqual(h.store.prefix, "");
		assert.deepStrictEqual(plain(h.messages), [
			{ action: "prefixUpdated", prefix: "" },
		]);
		assert.strictEqual(
			h.elements["status-indicator"].textContent,
			"Warning: prefix is empty",
		);
	});

	test("saving a prefix with special characters round-trips exactly", async () => {
		const h = makeHarness();
		h.elements["prefix-input"].value = "x-request.id_42";
		await h.elements["save-prefix-btn"].click();
		await tick();

		assert.strictEqual(h.store.prefix, "x-request.id_42");
		assert.strictEqual(h.messages[0].prefix, "x-request.id_42");
	});
});

// ============================================================================
// PATTERN ADD — appends + persists via setPatterns
// ============================================================================

describe("pattern add appends and persists", () => {
	test("adding a pattern persists it and clears the input", async () => {
		const h = makeHarness();
		h.elements["pattern-input"].value = "https://example.com/*";
		await h.elements["add-pattern-btn"].click();
		await tick();

		assert.deepStrictEqual(plain(h.store.patterns), ["https://example.com/*"]);
		assert.strictEqual(h.elements["pattern-input"].value, "");
		assert.strictEqual(h.elements["invalid-message"].textContent, "");
	});

	test("adding a second pattern appends to the existing list", async () => {
		const h = makeHarness({ patterns: ["https://a.com/*"] });
		await h.fireDOMContentLoaded();
		h.elements["pattern-input"].value = "https://b.com/*";
		await h.elements["add-pattern-btn"].click();
		await tick();

		assert.deepStrictEqual(plain(h.store.patterns), [
			"https://a.com/*",
			"https://b.com/*",
		]);
	});

	test("pattern is trimmed before persisting", async () => {
		const h = makeHarness();
		h.elements["pattern-input"].value = "  https://trim.com/*  ";
		await h.elements["add-pattern-btn"].click();
		await tick();

		assert.deepStrictEqual(plain(h.store.patterns), ["https://trim.com/*"]);
	});

	test("Enter key in the pattern input triggers add", async () => {
		const h = makeHarness();
		h.elements["pattern-input"].value = "https://enter.com/*";
		h.elements["pattern-input"].dispatch("keydown", {
			key: "Enter",
			preventDefault() {},
		});
		await tick();

		assert.deepStrictEqual(plain(h.store.patterns), ["https://enter.com/*"]);
	});
});

// ============================================================================
// PATTERN REMOVE — deletes + persists
// ============================================================================

describe("pattern remove deletes and persists", () => {
	test("clicking remove deletes the pattern from storage and DOM", async () => {
		const h = makeHarness({ patterns: ["https://a.com/*", "https://b.com/*"] });
		await h.fireDOMContentLoaded();

		const list = h.elements["pattern-list"];
		assert.strictEqual(list.children.length, 2);

		// Each rendered item is [code, removeButton].
		const removeBtn = list.children[0].children[1];
		assert.strictEqual(removeBtn.tagName, "BUTTON");
		await removeBtn.click();
		await tick();

		assert.deepStrictEqual(plain(h.store.patterns), ["https://b.com/*"]);
		assert.strictEqual(list.children.length, 1);
		assert.strictEqual(
			list.children[0].children[0].textContent,
			"https://b.com/*",
		);
	});

	test("removing the last pattern renders the empty state", async () => {
		const h = makeHarness({ patterns: ["https://only.com/*"] });
		await h.fireDOMContentLoaded();

		const list = h.elements["pattern-list"];
		await list.children[0].children[1].click();
		await tick();

		assert.deepStrictEqual(plain(h.store.patterns), []);
		assert.strictEqual(list.children.length, 1);
		assert.strictEqual(list.children[0].className, "empty-state");
		assert.strictEqual(list.children[0].textContent, "No patterns configured");
	});
});

// ============================================================================
// INVALID PATTERN — rejected with validation message
// ============================================================================

describe("invalid patterns are rejected with a validation message", () => {
	test("empty pattern is rejected and not persisted", async () => {
		const h = makeHarness();
		h.elements["pattern-input"].value = "";
		await h.elements["add-pattern-btn"].click();
		await tick();

		assert.strictEqual(
			h.elements["invalid-message"].textContent,
			"Pattern cannot be empty.",
		);
		assert.ok(!("patterns" in h.store), "no patterns key should be written");
	});

	test("whitespace-only pattern is rejected and not persisted", async () => {
		const h = makeHarness();
		h.elements["pattern-input"].value = "   ";
		await h.elements["add-pattern-btn"].click();
		await tick();

		assert.strictEqual(
			h.elements["invalid-message"].textContent,
			"Pattern cannot be empty.",
		);
		assert.ok(!("patterns" in h.store));
	});

	test("duplicate pattern is rejected and not persisted twice", async () => {
		const h = makeHarness({ patterns: ["https://dup.com/*"] });
		await h.fireDOMContentLoaded();
		h.elements["pattern-input"].value = "https://dup.com/*";
		await h.elements["add-pattern-btn"].click();
		await tick();

		assert.strictEqual(
			h.elements["invalid-message"].textContent,
			"This pattern already exists.",
		);
		assert.deepStrictEqual(plain(h.store.patterns), ["https://dup.com/*"]);
	});

	test("a valid add clears a previously shown validation message", async () => {
		const h = makeHarness();
		h.elements["pattern-input"].value = "";
		await h.elements["add-pattern-btn"].click();
		await tick();
		assert.strictEqual(
			h.elements["invalid-message"].textContent,
			"Pattern cannot be empty.",
		);

		h.elements["pattern-input"].value = "https://ok.com/*";
		await h.elements["add-pattern-btn"].click();
		await tick();
		assert.strictEqual(h.elements["invalid-message"].textContent, "");
		assert.deepStrictEqual(plain(h.store.patterns), ["https://ok.com/*"]);
	});
});

// ============================================================================
// MALFORMED PATTERNS — rejected with validation message (FR-004 scenario 4.3)
// ============================================================================

describe("malformed patterns are rejected with a validation message", () => {
	const MALFORMED = ["hello world", "http://", "://", "???"];

	for (const bad of MALFORMED) {
		test(`rejects malformed pattern ${JSON.stringify(bad)}`, async () => {
			const h = makeHarness();
			h.elements["pattern-input"].value = bad;
			await h.elements["add-pattern-btn"].click();
			await tick();

			assert.ok(
				h.elements["invalid-message"].textContent.length > 0,
				"a validation message should be shown",
			);
			assert.ok(
				!("patterns" in h.store) || h.store.patterns.length === 0,
				"malformed pattern must not be persisted",
			);
			assert.strictEqual(
				h.elements["pattern-input"].value,
				bad,
				"rejected input should remain for correction",
			);
		});
	}

	test("malformed pattern leaves the existing pattern list unchanged", async () => {
		const h = makeHarness({ patterns: ["https://keep.com/*"] });
		await h.fireDOMContentLoaded();
		h.elements["pattern-input"].value = "not a url";
		await h.elements["add-pattern-btn"].click();
		await tick();

		assert.notStrictEqual(h.elements["invalid-message"].textContent, "");
		assert.deepStrictEqual(plain(h.store.patterns), ["https://keep.com/*"]);
		assert.strictEqual(h.elements["pattern-list"].children.length, 1);
	});

	test("validatePattern reports a reason for each malformed class", () => {
		const h = makeHarness();

		assert.strictEqual(
			h.sandbox.validatePattern(""),
			"Pattern cannot be empty.",
		);
		assert.strictEqual(
			h.sandbox.validatePattern("   "),
			"Pattern cannot be empty.",
		);
		assert.strictEqual(
			h.sandbox.validatePattern("hello world"),
			"Pattern cannot contain spaces.",
		);
		assert.strictEqual(
			h.sandbox.validatePattern("http://"),
			"Invalid pattern: a host is required (e.g. example.com).",
		);
		assert.strictEqual(
			h.sandbox.validatePattern("://"),
			"Invalid pattern: unsupported scheme.",
		);
		assert.strictEqual(
			h.sandbox.validatePattern("???"),
			"Invalid pattern: host contains unsupported characters.",
		);
	});

	test("valid patterns are accepted by validatePattern and the add handler", async () => {
		const valid = [
			"api.example.com/*",
			"*.example.com/*",
			"https://api.example.com/v1/*",
		];

		const h = makeHarness();
		for (const pattern of valid) {
			assert.strictEqual(
				h.sandbox.validatePattern(pattern),
				null,
				`${pattern} should validate`,
			);
		}

		for (const pattern of valid) {
			const addHarness = makeHarness();
			addHarness.elements["pattern-input"].value = pattern;
			await addHarness.elements["add-pattern-btn"].click();
			await tick();

			assert.deepStrictEqual(plain(addHarness.store.patterns), [pattern]);
			assert.strictEqual(
				addHarness.elements["invalid-message"].textContent,
				"",
			);
		}
	});
});

// ============================================================================
// STATUS INDICATOR — Active vs warning
// ============================================================================

describe("status indicator reflects prefix state", () => {
	test("non-empty prefix shows Active", () => {
		const h = makeHarness();
		h.elements["prefix-input"].value = "req";
		h.sandbox.updateStatus();

		assert.strictEqual(h.elements["status-indicator"].textContent, "Active");
		assert.strictEqual(
			h.elements["status-indicator"].className,
			"status-indicator active",
		);
	});

	test("empty prefix shows warning", () => {
		const h = makeHarness();
		h.elements["prefix-input"].value = "";
		h.sandbox.updateStatus();

		assert.strictEqual(
			h.elements["status-indicator"].textContent,
			"Warning: prefix is empty",
		);
		assert.strictEqual(
			h.elements["status-indicator"].className,
			"status-indicator warning",
		);
	});

	test("whitespace-only prefix shows warning", () => {
		const h = makeHarness();
		h.elements["prefix-input"].value = "   ";
		h.sandbox.updateStatus();

		assert.strictEqual(
			h.elements["status-indicator"].textContent,
			"Warning: prefix is empty",
		);
		assert.strictEqual(
			h.elements["status-indicator"].className,
			"status-indicator warning",
		);
	});

	test("input event on the prefix field re-evaluates status", () => {
		const h = makeHarness();
		h.elements["prefix-input"].value = "live";
		h.elements["prefix-input"].dispatch("input");
		assert.strictEqual(h.elements["status-indicator"].textContent, "Active");

		h.elements["prefix-input"].value = "";
		h.elements["prefix-input"].dispatch("input");
		assert.strictEqual(
			h.elements["status-indicator"].textContent,
			"Warning: prefix is empty",
		);
	});
});

// ============================================================================
// RENDERING — textContent only, no innerHTML
// ============================================================================

describe("pattern list renders via textContent (no innerHTML)", () => {
	test("popup.js source never uses innerHTML/outerHTML", () => {
		const src = fs.readFileSync(POPUP_SRC, "utf8");
		assert.ok(!src.includes("innerHTML"), "popup.js must not use innerHTML");
		assert.ok(!src.includes("outerHTML"), "popup.js must not use outerHTML");
		assert.match(
			src,
			/\.textContent\s*=/,
			"rendering should assign textContent",
		);
	});

	test("popup.html source never uses innerHTML", () => {
		const html = fs.readFileSync(POPUP_HTML, "utf8");
		assert.ok(!html.includes("innerHTML"), "popup.html must not use innerHTML");
	});

	test("rendered pattern items expose the pattern as textContent", async () => {
		const h = makeHarness({ patterns: ["https://render.com/*"] });
		await h.fireDOMContentLoaded();

		const list = h.elements["pattern-list"];
		assert.strictEqual(list.children.length, 1);
		const item = list.children[0];
		assert.strictEqual(item.className, "pattern-item");
		assert.strictEqual(item.children[0].tagName, "CODE");
		assert.strictEqual(item.children[0].textContent, "https://render.com/*");
	});

	test("empty pattern list renders the empty-state item", async () => {
		const h = makeHarness({ patterns: [] });
		await h.fireDOMContentLoaded();

		const list = h.elements["pattern-list"];
		assert.strictEqual(list.children.length, 1);
		assert.strictEqual(list.children[0].className, "empty-state");
		assert.strictEqual(list.children[0].textContent, "No patterns configured");
	});

	test("remove button carries an aria-label naming the pattern", async () => {
		const h = makeHarness({ patterns: ["https://aria.com/*"] });
		await h.fireDOMContentLoaded();

		const removeBtn = h.elements["pattern-list"].children[0].children[1];
		assert.strictEqual(
			removeBtn.getAttribute("aria-label"),
			"Remove pattern https://aria.com/*",
		);
	});
});

// ============================================================================
// BOOT — DOMContentLoaded hydrates from storage
// ============================================================================

describe("boot hydrates prefix and patterns from storage", () => {
	test("DOMContentLoaded loads stored prefix and patterns", async () => {
		const h = makeHarness({
			prefix: "boot",
			patterns: ["https://a.com/*", "https://b.com/*"],
		});
		await h.fireDOMContentLoaded();

		assert.strictEqual(h.elements["prefix-input"].value, "boot");
		assert.strictEqual(h.elements["pattern-list"].children.length, 2);
		assert.strictEqual(h.elements["status-indicator"].textContent, "Active");
	});

	test("boot with empty storage shows empty form and warning", async () => {
		const h = makeHarness();
		await h.fireDOMContentLoaded();

		assert.strictEqual(h.elements["prefix-input"].value, "");
		assert.strictEqual(
			h.elements["status-indicator"].textContent,
			"Warning: prefix is empty",
		);
		assert.strictEqual(
			h.elements["pattern-list"].children[0].textContent,
			"No patterns configured",
		);
	});
});

// ============================================================================
// FAIL-OPEN — empty / nil inputs and unavailable chrome
// ============================================================================

describe("empty and nil inputs fail open without throwing", () => {
	test("setPrefix(null) does not throw and does not persist", async () => {
		const h = makeHarness();
		let threw = false;
		try {
			await h.sandbox.setPrefix(null);
		} catch {
			threw = true;
		}
		assert.strictEqual(threw, false);
		assert.ok(!("prefix" in h.store));
	});

	test("setPrefix(undefined) and setPrefix(number) do not throw", async () => {
		const h = makeHarness();
		let threw = false;
		try {
			await h.sandbox.setPrefix(undefined);
			await h.sandbox.setPrefix(12345);
		} catch {
			threw = true;
		}
		assert.strictEqual(threw, false);
		assert.ok(!("prefix" in h.store));
	});

	test("setPatterns(null) does not throw and does not persist", async () => {
		const h = makeHarness();
		let threw = false;
		try {
			await h.sandbox.setPatterns(null);
		} catch {
			threw = true;
		}
		assert.strictEqual(threw, false);
		assert.ok(!("patterns" in h.store));
	});

	test("getPrefix returns empty string when storage throws", async () => {
		const h = makeHarness({ storageThrows: true });
		assert.strictEqual(await h.sandbox.getPrefix(), "");
	});

	test("getPatterns returns empty array when storage throws", async () => {
		const h = makeHarness({ storageThrows: true });
		assert.deepStrictEqual(plain(await h.sandbox.getPatterns()), []);
	});

	test("notifyBadge does not throw when sendMessage rejects", async () => {
		const h = makeHarness({ sendMessageThrows: true });
		let threw = false;
		try {
			await h.sandbox.notifyBadge("req");
		} catch {
			threw = true;
		}
		assert.strictEqual(threw, false);
	});

	test("boot with unavailable storage does not throw and still sets status", async () => {
		const h = makeHarness({ storageThrows: true });
		let threw = false;
		try {
			await h.fireDOMContentLoaded();
		} catch {
			threw = true;
		}
		assert.strictEqual(threw, false);
		assert.strictEqual(
			h.elements["status-indicator"].textContent,
			"Warning: prefix is empty",
		);
	});
});

// ============================================================================
// MANIFEST + HTML WIRING
// ============================================================================

describe("manifest and popup.html wiring", () => {
	test("manifest action.default_popup points at an existing popup.html", () => {
		const manifest = JSON.parse(
			fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"),
		);
		assert.strictEqual(manifest.action.default_popup, "src/popup.html");
		assert.ok(
			fs.existsSync(path.join(ROOT, manifest.action.default_popup)),
			"default_popup file must exist on disk",
		);
	});

	test("popup.html references popup.js and popup.css which exist", () => {
		const html = fs.readFileSync(POPUP_HTML, "utf8");
		assert.match(html, /src="popup\.js"/);
		assert.match(html, /href="popup\.css"/);
		assert.ok(fs.existsSync(path.join(ROOT, "src", "popup.js")));
		assert.ok(fs.existsSync(path.join(ROOT, "src", "popup.css")));
	});

	test("popup.html declares every element id popup.js queries", () => {
		const html = fs.readFileSync(POPUP_HTML, "utf8");
		for (const id of ELEMENT_IDS) {
			assert.ok(
				html.includes(`id="${id}"`),
				`popup.html should declare id="${id}"`,
			);
		}
	});
});
