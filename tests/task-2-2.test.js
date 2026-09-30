/**
 * Tests for Phase 2.2: First-run onboarding view.
 *
 * onboarding.js is a classic (non-module) script that references browser
 * globals directly (chrome.storage.local, chrome.runtime.sendMessage,
 * document/DOM, window.close). To exercise it at runtime we build a minimal
 * node harness (mirroring tests/task-2-1.test.js):
 *   - stub chrome.storage.local (in-memory backing store, optional failure)
 *   - stub chrome.runtime.sendMessage (captures messages, optional failure)
 *   - lightweight DOM stub (getElementById / createElement / addEventListener)
 *   - stub window.close so the finish handler can be exercised
 * then load onboarding.js source into a fresh vm context.
 *
 * Proves at runtime:
 *   - first run (empty storage) shows onboarding with empty prefix + empty list
 *   - empty prefix shows the warning indicator (class + prefix-warning text)
 *   - saving prefix/patterns persists to the store and survives a simulated
 *     reload (fresh harness seeded from the same store)
 *   - invalid / empty / duplicate patterns are rejected with a message
 *   - finish persists settings and notifies background via prefixUpdated
 *   - fail-open behaviour when storage / messaging is unavailable
 *   - onboarding.html wiring references onboarding.js and declares every id
 */

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const ONBOARDING_SRC = path.join(ROOT, "src", "onboarding.js");
const ONBOARDING_HTML = path.join(ROOT, "src", "onboarding.html");

const ELEMENT_IDS = [
	"prefix-input",
	"save-prefix-btn",
	"prefix-warning",
	"pattern-input",
	"add-pattern-btn",
	"pattern-list",
	"invalid-message",
	"status-indicator",
	"finish-btn",
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
		this.focused = false;
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

	focus() {
		this.focused = true;
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
 * Build a fresh sandbox and load onboarding.js into it.
 *
 * @param {{prefix?: string, patterns?: string[], store?: object,
 *          storageThrows?: boolean, sendMessageThrows?: boolean}} opts
 *   Pass `store` to reuse an existing backing store — this simulates a
 *   browser reload where the same chrome.storage.local contents are read
 *   back by a freshly loaded page.
 */
function makeHarness({
	prefix,
	patterns,
	store: existingStore,
	storageThrows = false,
	sendMessageThrows = false,
} = {}) {
	const store = existingStore ?? {};
	if (prefix !== undefined) store.prefix = prefix;
	if (patterns !== undefined) store.patterns = patterns;

	const messages = [];
	let closed = 0;

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

	const window = {
		close() {
			closed += 1;
		},
	};

	const sandbox = { chrome, document, window, console };
	const context = vm.createContext(sandbox);
	vm.runInContext(fs.readFileSync(ONBOARDING_SRC, "utf8"), context, {
		filename: "onboarding.js",
	});

	return {
		sandbox,
		store,
		messages,
		elements,
		get closed() {
			return closed;
		},
		fireDOMContentLoaded: async () => {
			for (const cb of domListeners.DOMContentLoaded || []) await cb();
		},
	};
}

// ============================================================================
// FIRST RUN — empty storage shows onboarding state (FR-003 3.1)
// ============================================================================

describe("first run with empty storage shows onboarding state", () => {
	test("empty storage boots with empty prefix input and empty pattern list", async () => {
		const h = makeHarness();
		await h.fireDOMContentLoaded();

		assert.strictEqual(h.elements["prefix-input"].value, "");
		assert.strictEqual(h.elements["pattern-list"].children.length, 1);
		assert.strictEqual(
			h.elements["pattern-list"].children[0].className,
			"empty-state",
		);
		assert.strictEqual(
			h.elements["pattern-list"].children[0].textContent,
			"No patterns configured",
		);
	});

	test("first run focuses the prefix input", async () => {
		const h = makeHarness();
		await h.fireDOMContentLoaded();

		assert.strictEqual(h.elements["prefix-input"].focused, true);
	});

	test("first run with no stored keys leaves the store untouched", async () => {
		const h = makeHarness();
		await h.fireDOMContentLoaded();

		assert.deepStrictEqual(plain(h.store), {});
	});
});

// ============================================================================
// WARNING INDICATOR — empty prefix (FR-005 / FR-003)
// ============================================================================

describe("empty prefix shows the warning indicator", () => {
	test("empty prefix sets warning class and prefix-warning text", async () => {
		const h = makeHarness();
		await h.fireDOMContentLoaded();

		assert.strictEqual(
			h.elements["status-indicator"].className,
			"status-indicator warning",
		);
		assert.strictEqual(
			h.elements["status-indicator"].textContent,
			"Warning: prefix is empty",
		);
		assert.strictEqual(
			h.elements["prefix-warning"].textContent,
			"Warning: prefix is empty. Requests will be sent without an X-Request-ID header.",
		);
	});

	test("whitespace-only prefix still shows the warning", () => {
		const h = makeHarness();
		h.elements["prefix-input"].value = "   ";
		h.sandbox.updateStatus();

		assert.strictEqual(
			h.elements["status-indicator"].className,
			"status-indicator warning",
		);
		assert.strictEqual(
			h.elements["prefix-warning"].textContent,
			"Warning: prefix is empty. Requests will be sent without an X-Request-ID header.",
		);
	});

	test("non-empty prefix shows Active and clears the warning text", () => {
		const h = makeHarness();
		h.elements["prefix-input"].value = "myapp";
		h.sandbox.updateStatus();

		assert.strictEqual(
			h.elements["status-indicator"].className,
			"status-indicator active",
		);
		assert.strictEqual(h.elements["status-indicator"].textContent, "Active");
		assert.strictEqual(h.elements["prefix-warning"].textContent, "");
	});

	test("input event on the prefix field re-evaluates the warning", () => {
		const h = makeHarness();
		h.elements["prefix-input"].value = "live";
		h.elements["prefix-input"].dispatch("input");
		assert.strictEqual(h.elements["status-indicator"].textContent, "Active");

		h.elements["prefix-input"].value = "";
		h.elements["prefix-input"].dispatch("input");
		assert.strictEqual(
			h.elements["status-indicator"].className,
			"status-indicator warning",
		);
	});
});

// ============================================================================
// PERSISTENCE + RELOAD — settings survive a fresh page load (FR-006 6.1)
// ============================================================================

describe("saving settings persists and survives a simulated reload", () => {
	test("saving a prefix writes it to the stub store", async () => {
		const h = makeHarness();
		h.elements["prefix-input"].value = "myapp";
		await h.elements["save-prefix-btn"].click();
		await tick();

		assert.strictEqual(h.store.prefix, "myapp");
		assert.deepStrictEqual(plain(h.messages), [
			{ action: "prefixUpdated", prefix: "myapp" },
		]);
	});

	test("adding a pattern writes it to the stub store", async () => {
		const h = makeHarness();
		h.elements["pattern-input"].value = "https://example.com/*";
		await h.elements["add-pattern-btn"].click();
		await tick();

		assert.deepStrictEqual(plain(h.store.patterns), ["https://example.com/*"]);
		assert.strictEqual(h.elements["pattern-input"].value, "");
	});

	test("reload with the same store keeps prefix and patterns", async () => {
		const first = makeHarness();
		first.elements["prefix-input"].value = "reload-prefix";
		await first.elements["save-prefix-btn"].click();
		first.elements["pattern-input"].value = "https://a.com/*";
		await first.elements["add-pattern-btn"].click();
		first.elements["pattern-input"].value = "https://b.com/*";
		await first.elements["add-pattern-btn"].click();
		await tick();

		// Simulated browser restart: fresh page, same backing store.
		const second = makeHarness({ store: first.store });
		await second.fireDOMContentLoaded();

		assert.strictEqual(second.elements["prefix-input"].value, "reload-prefix");
		assert.strictEqual(second.elements["pattern-list"].children.length, 2);
		assert.strictEqual(
			second.elements["pattern-list"].children[0].children[0].textContent,
			"https://a.com/*",
		);
		assert.strictEqual(
			second.elements["pattern-list"].children[1].children[0].textContent,
			"https://b.com/*",
		);
		assert.strictEqual(
			second.elements["status-indicator"].className,
			"status-indicator active",
		);
	});

	test("reload after removing a pattern keeps only the remaining one", async () => {
		const first = makeHarness({
			patterns: ["https://keep.com/*", "https://drop.com/*"],
		});
		await first.fireDOMContentLoaded();

		// Remove the first rendered item.
		await first.elements["pattern-list"].children[0].children[1].click();
		await tick();

		const second = makeHarness({ store: first.store });
		await second.fireDOMContentLoaded();

		assert.deepStrictEqual(plain(second.store.patterns), ["https://drop.com/*"]);
		assert.strictEqual(second.elements["pattern-list"].children.length, 1);
		assert.strictEqual(
			second.elements["pattern-list"].children[0].children[0].textContent,
			"https://drop.com/*",
		);
	});
});

// ============================================================================
// INVALID PATTERN — rejected with a validation message
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

	test("malformed pattern is rejected with a message and kept for correction", async () => {
		const h = makeHarness();
		h.elements["pattern-input"].value = "hello world";
		await h.elements["add-pattern-btn"].click();
		await tick();

		assert.strictEqual(
			h.elements["invalid-message"].textContent,
			"Pattern cannot contain spaces.",
		);
		assert.ok(!("patterns" in h.store));
		assert.strictEqual(h.elements["pattern-input"].value, "hello world");
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
		assert.strictEqual(h.sandbox.validatePattern("api.example.com/*"), null);
	});
});

// ============================================================================
// FINISH — persists settings and notifies background
// ============================================================================

describe("finish persists settings and notifies background", () => {
	test("finish writes prefix + patterns, sends prefixUpdated, closes window", async () => {
		const h = makeHarness();
		h.elements["prefix-input"].value = "finish-prefix";
		h.elements["pattern-input"].value = "https://finish.com/*";
		await h.elements["add-pattern-btn"].click();
		await tick();

		await h.elements["finish-btn"].click();
		await tick();

		assert.strictEqual(h.store.prefix, "finish-prefix");
		assert.deepStrictEqual(plain(h.store.patterns), ["https://finish.com/*"]);
		assert.deepStrictEqual(plain(h.messages), [
			{ action: "prefixUpdated", prefix: "finish-prefix" },
		]);
		assert.strictEqual(h.closed, 1);
	});

	test("finish with empty prefix persists empty and still notifies", async () => {
		const h = makeHarness();
		await h.elements["finish-btn"].click();
		await tick();

		assert.strictEqual(h.store.prefix, "");
		assert.deepStrictEqual(plain(h.store.patterns), []);
		assert.deepStrictEqual(plain(h.messages), [
			{ action: "prefixUpdated", prefix: "" },
		]);
		assert.strictEqual(h.closed, 1);
	});

	test("finish settings survive a simulated reload", async () => {
		const first = makeHarness();
		first.elements["prefix-input"].value = "persisted";
		first.elements["pattern-input"].value = "https://persist.com/*";
		await first.elements["add-pattern-btn"].click();
		await first.elements["finish-btn"].click();
		await tick();

		const second = makeHarness({ store: first.store });
		await second.fireDOMContentLoaded();

		assert.strictEqual(second.elements["prefix-input"].value, "persisted");
		assert.strictEqual(
			second.elements["pattern-list"].children[0].children[0].textContent,
			"https://persist.com/*",
		);
	});
});

// ============================================================================
// FAIL-OPEN — unavailable storage / messaging
// ============================================================================

describe("fail-open behaviour when chrome APIs are unavailable", () => {
	test("getPrefix returns empty string when storage throws", async () => {
		const h = makeHarness({ storageThrows: true });
		assert.strictEqual(await h.sandbox.getPrefix(), "");
	});

	test("getPatterns returns empty array when storage throws", async () => {
		const h = makeHarness({ storageThrows: true });
		assert.deepStrictEqual(plain(await h.sandbox.getPatterns()), []);
	});

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

	test("boot with unavailable storage does not throw and still warns", async () => {
		const h = makeHarness({ storageThrows: true });
		let threw = false;
		try {
			await h.fireDOMContentLoaded();
		} catch {
			threw = true;
		}
		assert.strictEqual(threw, false);
		assert.strictEqual(
			h.elements["status-indicator"].className,
			"status-indicator warning",
		);
	});
});

// ============================================================================
// HTML WIRING
// ============================================================================

describe("onboarding.html wiring", () => {
	test("onboarding.html references onboarding.js which exists", () => {
		const html = fs.readFileSync(ONBOARDING_HTML, "utf8");
		assert.match(html, /src="onboarding\.js"/);
		assert.ok(fs.existsSync(ONBOARDING_SRC));
	});

	test("onboarding.html declares every element id onboarding.js queries", () => {
		const html = fs.readFileSync(ONBOARDING_HTML, "utf8");
		for (const id of ELEMENT_IDS) {
			assert.ok(
				html.includes(`id="${id}"`),
				`onboarding.html should declare id="${id}"`,
			);
		}
	});

	test("onboarding.js never uses innerHTML/outerHTML", () => {
		const src = fs.readFileSync(ONBOARDING_SRC, "utf8");
		assert.ok(!src.includes("innerHTML"), "onboarding.js must not use innerHTML");
		assert.ok(!src.includes("outerHTML"), "onboarding.js must not use outerHTML");
	});
});
