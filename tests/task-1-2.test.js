/**
 * Tests for Phase 1.2: Wildcard URL matcher and Request ID generator
 * Covering verification and adversarial scenarios
 */

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { matchesAny, matchesPattern } from "../src/matcher.js";
import { buildRequestId, generateSuffix } from "../src/requestId.js";

// ============================================================================
// VERIFICATION TESTS - matchesPattern
// ============================================================================

describe("matchesPattern: Verification", () => {
	describe("exact host match", () => {
		test("should match exact https URL", () => {
			assert.strictEqual(
				matchesPattern("https://example.com/path", "https://example.com/path"),
				true,
			);
		});

		test("should match exact http URL with trailing slash", () => {
			assert.strictEqual(
				matchesPattern("http://example.com/path/", "http://example.com/path/"),
				true,
			);
		});

		test("should not match if scheme differs", () => {
			assert.strictEqual(
				matchesPattern("https://example.com/path", "http://example.com/path"),
				false,
			);
		});

		test("should not match if path differs", () => {
			assert.strictEqual(
				matchesPattern("https://example.com/path", "https://example.com/other"),
				false,
			);
		});
	});

	describe("wildcard subdomain", () => {
		test("*.example.com matches subdomain", () => {
			assert.strictEqual(
				matchesPattern(
					"https://foo.example.com/api",
					"https://*.example.com/api",
				),
				true,
			);
		});

		test("*.example.com matches nested subdomain", () => {
			assert.strictEqual(
				matchesPattern(
					"https://bar.baz.example.com/api",
					"https://*.example.com/api",
				),
				true,
			);
		});

		test("*.example.com does NOT match base domain", () => {
			assert.strictEqual(
				matchesPattern("https://example.com/api", "https://*.example.com/api"),
				false,
			);
		});

		test("exact host does NOT match subdomain", () => {
			assert.strictEqual(
				matchesPattern(
					"https://foo.example.com/api",
					"https://example.com/api",
				),
				false,
			);
		});
	});

	describe("wildcard path", () => {
		test("* matches any path", () => {
			assert.strictEqual(
				matchesPattern(
					"https://example.com/any/path/here",
					"https://example.com/*",
				),
				true,
			);
		});

		test("* matches empty path", () => {
			assert.strictEqual(
				matchesPattern("https://example.com", "https://example.com/*"),
				true,
			);
		});

		test("* in middle of path", () => {
			assert.strictEqual(
				matchesPattern(
					"https://example.com/foo/bar",
					"https://example.com/*/bar",
				),
				true,
			);
		});

		test("* must match full path segment", () => {
			assert.strictEqual(
				matchesPattern(
					"https://example.com/foobar",
					"https://example.com/*bar",
				),
				true,
			);
		});
	});

	describe("no-match cases", () => {
		test("different host returns false", () => {
			assert.strictEqual(
				matchesPattern("https://other.com/path", "https://example.com/*"),
				false,
			);
		});

		test("different scheme returns false", () => {
			assert.strictEqual(
				matchesPattern("ftp://example.com/path", "https://example.com/path"),
				false,
			);
		});

		test("*:// pattern matches any scheme", () => {
			assert.strictEqual(
				matchesPattern("https://example.com/path", "*://example.com/path"),
				true,
			);
		});

		test("*:// matches ftp too", () => {
			assert.strictEqual(
				matchesPattern("ftp://example.com/path", "*://example.com/path"),
				true,
			);
		});
	});

	describe("empty pattern list", () => {
		test("empty array returns false", () => {
			assert.strictEqual(matchesAny("https://example.com", []), false);
		});

		test("null/undefined pattern list returns false", () => {
			assert.strictEqual(matchesAny("https://example.com", null), false);
			assert.strictEqual(matchesAny("https://example.com", undefined), false);
		});
	});

	describe("query params", () => {
		test("pattern with query matches URL with same query", () => {
			assert.strictEqual(
				matchesPattern(
					"https://example.com/api?key=value",
					"https://example.com/api?key=value",
				),
				true,
			);
		});

		test("pattern without query does NOT match URL with query", () => {
			assert.strictEqual(
				matchesPattern(
					"https://example.com/api",
					"https://example.com/api?key=value",
				),
				false,
			);
		});

		test("* in path matches query string", () => {
			assert.strictEqual(
				matchesPattern(
					"https://example.com/api?key=value",
					"https://example.com/*",
				),
				true,
			);
		});
	});

	describe("fragment", () => {
		test("fragment is included in matching", () => {
			assert.strictEqual(
				matchesPattern(
					"https://example.com/page#section",
					"https://example.com/page#section",
				),
				true,
			);
		});

		test("* matches fragment too", () => {
			assert.strictEqual(
				matchesPattern(
					"https://example.com/page#section",
					"https://example.com/*",
				),
				true,
			);
		});
	});

	describe("subdomain vs base", () => {
		test("exact host does not match subdomain", () => {
			assert.strictEqual(
				matchesPattern("https://sub.example.com", "https://example.com"),
				false,
			);
		});

		test("exact match works for base domain", () => {
			assert.strictEqual(
				matchesPattern("https://example.com", "https://example.com"),
				true,
			);
		});
	});

	describe("matchesAny function", () => {
		test("returns true if any pattern matches", () => {
			const patterns = ["https://other.com/*", "https://example.com/*"];
			assert.strictEqual(
				matchesAny("https://example.com/path", patterns),
				true,
			);
		});

		test("returns false if no pattern matches", () => {
			const patterns = ["https://other.com/*", "https://another.com/*"];
			assert.strictEqual(
				matchesAny("https://example.com/path", patterns),
				false,
			);
		});
	});
});

// ============================================================================
// VERIFICATION TESTS - generateSuffix
// ============================================================================

describe("generateSuffix: Verification", () => {
	describe("suffix format", () => {
		test("suffix is exactly 5 characters", () => {
			const suffix = generateSuffix();
			assert.strictEqual(suffix.length, 5);
		});

		test("suffix contains only alphanumeric characters", () => {
			const suffix = generateSuffix();
			const alnumRegex = /^[A-Za-z0-9]{5}$/;
			assert.ok(
				alnumRegex.test(suffix),
				`Suffix "${suffix}" does not match 5-char alnum pattern`,
			);
		});

		test("uppercase letters possible", () => {
			let foundLower = false;
			let foundUpper = false;
			for (let i = 0; i < 100; i++) {
				const suffix = generateSuffix();
				if (suffix !== suffix.toLowerCase()) foundUpper = true;
				if (suffix !== suffix.toUpperCase()) foundLower = true;
			}
			assert.strictEqual(foundUpper, true, "Should find uppercase in suffixes");
			assert.strictEqual(foundLower, true, "Should find lowercase in suffixes");
		});

		test("digits possible in suffix", () => {
			let foundDigit = false;
			for (let i = 0; i < 100; i++) {
				const suffix = generateSuffix();
				if (/\d/.test(suffix)) foundDigit = true;
			}
			assert.strictEqual(foundDigit, true, "Should find digits in suffixes");
		});
	});

	describe("uniqueness across calls", () => {
		test("consecutive calls produce different values", () => {
			const s1 = generateSuffix();
			const s2 = generateSuffix();
			assert.notStrictEqual(s1, s2);
		});

		test("multiple calls produce mostly unique values", () => {
			const suffixes = new Set();
			for (let i = 0; i < 100; i++) {
				suffixes.add(generateSuffix());
			}
			assert.ok(
				suffixes.size > 95,
				`Expected >95 unique values, got ${suffixes.size}`,
			);
		});
	});
});

// ============================================================================
// VERIFICATION TESTS - buildRequestId
// ============================================================================

describe("buildRequestId: Verification", () => {
	test("with prefix returns prefix-suffix format", () => {
		const id = buildRequestId("abc");
		assert.ok(id.startsWith("abc-"), `ID "${id}" should start with "abc-"`);
		assert.strictEqual(id.length, 9); // "abc-" (4) + 5 chars
	});

	test("empty prefix returns only suffix", () => {
		const id = buildRequestId("");
		assert.strictEqual(id.length, 5);
		assert.ok(/^[A-Za-z0-9]{5}$/.test(id), `ID "${id}" should be 5-alphanum`);
	});

	test("null prefix returns only suffix", () => {
		const id = buildRequestId(null);
		assert.strictEqual(id.length, 5);
	});

	test("undefined prefix returns only suffix", () => {
		const id = buildRequestId(undefined);
		assert.strictEqual(id.length, 5);
	});

	test("fresh ID on each call for same prefix", () => {
		const id1 = buildRequestId("test");
		const id2 = buildRequestId("test");
		assert.notStrictEqual(id1, id2);
	});
});

// ============================================================================
// ADVERSARIAL TESTS - matcher.js
// ============================================================================

describe("matchesPattern: Adversarial", () => {
	describe("malformed URLs", () => {
		test("invalid URL returns false fail-open", () => {
			assert.strictEqual(
				matchesPattern("not a valid url", "https://example.com/*"),
				false,
			);
		});

		test("URL missing protocol returns false", () => {
			assert.strictEqual(
				matchesPattern("example.com/path", "https://example.com/*"),
				false,
			);
		});

		test("nested schema in path does not bypass", () => {
			assert.strictEqual(
				matchesPattern(
					"https://example.com/http://evil.com",
					"https://example.com/*",
				),
				true,
			);
		});
	});

	describe("null/undefined/empty inputs", () => {
		test("null urlString returns false", () => {
			assert.strictEqual(matchesPattern(null, "https://example.com/*"), false);
		});

		test("undefined urlString returns false", () => {
			assert.strictEqual(
				matchesPattern(undefined, "https://example.com/*"),
				false,
			);
		});

		test("empty urlString returns false", () => {
			assert.strictEqual(matchesPattern("", "https://example.com/*"), false);
		});

		test("null patternString returns false", () => {
			assert.strictEqual(matchesPattern("https://example.com/", null), false);
		});

		test("undefined patternString returns false", () => {
			assert.strictEqual(
				matchesPattern("https://example.com/", undefined),
				false,
			);
		});

		test("empty patternString returns false", () => {
			assert.strictEqual(matchesPattern("https://example.com/", ""), false);
		});
	});

	describe("oversized patterns", () => {
		test("very long URL string", () => {
			const longHost = "a".repeat(1000) + ".com";
			const url = `https://${longHost}/path`;
			const pattern = `https://${longHost}/path`;
			assert.strictEqual(matchesPattern(url, pattern), true);
		});

		test("very long pattern", () => {
			const pattern = "https://" + "a".repeat(10000) + ".com/*";
			assert.strictEqual(
				matchesPattern("https://boring.com/path", pattern),
				false,
			);
		});

		test("deep path", () => {
			const deepPath = Array(100).fill("segment").join("/");
			const url = `https://example.com/${deepPath}`;
			const pattern = "https://example.com/*";
			assert.strictEqual(matchesPattern(url, pattern), true);
		});
	});

	describe("injection strings in pattern", () => {
		test("regex special characters are escaped in path", () => {
			assert.strictEqual(
				matchesPattern(
					"https://example.com/file.$txt",
					"https://example.com/file.$txt",
				),
				true,
			);
		});

		test("parentheses in path are escaped", () => {
			assert.strictEqual(
				matchesPattern(
					"https://example.com/(test)",
					"https://example.com/(test)",
				),
				true,
			);
		});

		test("brackets in path are escaped", () => {
			assert.strictEqual(
				matchesPattern(
					"https://example.com/[test]",
					"https://example.com/[test]",
				),
				true,
			);
		});

		test("pipe character in path is escaped", () => {
			assert.strictEqual(
				matchesPattern(
					"https://example.com/data|backup",
					"https://example.com/data|backup",
				),
				true,
			);
		});
	});

	describe("boundary lengths", () => {
		test("single character host", () => {
			assert.strictEqual(matchesPattern("https://a", "https://a"), true);
		});

		test("single character path", () => {
			assert.strictEqual(
				matchesPattern("https://example.com/a", "https://example.com/a"),
				true,
			);
		});

		test("wildcard subdomain with one char subdomain", () => {
			assert.strictEqual(
				matchesPattern("https://a.example.com", "https://*.example.com"),
				true,
			);
		});

		test("non-empty host must precede wildcard subdomain suffix", () => {
			assert.strictEqual(
				matchesPattern("https://example.com", "https://*.example.com"),
				false,
			);
		});
	});
});

// ============================================================================
// ADVERSARIAL TESTS - requestId.js
// ============================================================================

describe("generateSuffix: Adversarial", () => {
	describe("format validation", () => {
		test("suffix format is always 5 alphanumeric chars", () => {
			for (let i = 0; i < 50; i++) {
				const suffix = generateSuffix();
				assert.ok(
					/^[A-Za-z0-9]{5}$/.test(suffix),
					`Suffix "${suffix}" invalid`,
				);
			}
		});

		test("suffix never contains special characters", () => {
			for (let i = 0; i < 100; i++) {
				const suffix = generateSuffix();
				assert.ok(
					!/[^A-Za-z0-9]/.test(suffix),
					`Suffix "${suffix}" contains special chars`,
				);
			}
		});

		test("suffix never contains empty string or undefined", () => {
			const suffix = generateSuffix();
			assert.ok(suffix !== undefined, "Suffix should not be undefined");
			assert.notStrictEqual(suffix, "", "Suffix should not be empty string");
		});
	});

	describe("boundary lengths", () => {
		test("length never changes - always 5", () => {
			for (let i = 0; i < 100; i++) {
				assert.strictEqual(generateSuffix().length, 5);
			}
		});
	});
});

describe("buildRequestId: Adversarial", () => {
	describe("empty/invalid prefix handling fail-open false", () => {
		test("empty prefix returns just suffix without prefix char", () => {
			for (let i = 0; i < 10; i++) {
				const id = buildRequestId("");
				assert.ok(!id.includes("-"), `ID "${id}" should not contain hyphen`);
				assert.strictEqual(id.length, 5);
			}
		});

		test("null prefix returns just suffix", () => {
			for (let i = 0; i < 10; i++) {
				const id = buildRequestId(null);
				assert.ok(!id.includes("-"), `ID "${id}" should not contain hyphen`);
				assert.strictEqual(id.length, 5);
			}
		});

		test("undefined prefix returns just suffix", () => {
			for (let i = 0; i < 10; i++) {
				const id = buildRequestId(undefined);
				assert.ok(!id.includes("-"), `ID "${id}" should not contain hyphen`);
				assert.strictEqual(id.length, 5);
			}
		});

		test("whitespace-only prefix keeps prefix", () => {
			const id = buildRequestId("   ");
			assert.ok(id.startsWith("   -"), `ID "${id}" should start with "   -"`);
		});
	});

	describe("duplicate handling at call level", () => {
		test("same prefix produces different IDs on each call", () => {
			const ids = new Set();
			for (let i = 0; i < 50; i++) {
				ids.add(buildRequestId("duplicate-test"));
			}
			assert.strictEqual(ids.size, 50, "All IDs should be unique");
		});

		test("no prefix produces unique suffixes", () => {
			const ids = new Set();
			for (let i = 0; i < 50; i++) {
				ids.add(buildRequestId(""));
			}
			assert.strictEqual(ids.size, 50, "All IDs should be unique");
		});
	});

	describe("prefix edge cases", () => {
		test("very long prefix", () => {
			const longPrefix = "a".repeat(1000);
			const id = buildRequestId(longPrefix);
			assert.ok(
				id.startsWith(longPrefix + "-"),
				`ID should start with "${longPrefix}-"`,
			);
		});

		test("prefix with special chars", () => {
			const id = buildRequestId("test-special_chars.123");
			assert.ok(
				id.startsWith("test-special_chars.123-"),
				`ID should start with prefix`,
			);
		});

		test("prefix with unicode", () => {
			const id = buildRequestId("日本語");
			assert.ok(id.startsWith("日本語-"), `ID should start with "日本語-"`);
		});
	});
});

// ============================================================================
// INTEGRATION TESTS
// ============================================================================

describe("Integration: Matcher + RequestId", () => {
	test("generate IDs for matching requests", () => {
		const patterns = ["https://api.example.com/*", "*://*.internal.com/*"];

		const urls = [
			"https://api.example.com/users",
			"https://cdn.internal.com/data.json",
			"https://external.com/page",
		];

		const ids = urls.map((url) => ({
			url,
			matches: matchesAny(url, patterns),
			id: buildRequestId("req"),
		}));

		assert.strictEqual(ids[0].matches, true);
		assert.strictEqual(ids[1].matches, true);
		assert.strictEqual(ids[2].matches, false);
		assert.ok(
			ids[0].id.startsWith("req-"),
			`ID "${ids[0].id}" should start with "req-"`,
		);
		assert.ok(
			ids[1].id.startsWith("req-"),
			`ID "${ids[1].id}" should start with "req-"`,
		);
	});
});

// ============================================================================
// PHASE 1.2 (rewrite) — src/content.js chrome.storage ↔ page-world bridge
//
// content.js is a classic (non-module) content script: no imports/exports, it
// references browser globals directly (chrome, document, CustomEvent). To
// exercise it at runtime we load the source into a fresh vm context with a
// minimal harness:
//   - CustomEvent stub capturing type + detail
//   - chrome stub: storage.local.get (callback), storage.onChanged.addListener,
//     runtime.getURL
//
// Proves at runtime:
//   - dispatchConfig emits the exact event name + detail shape
//   - loadAndDispatchConfig reads storage and normalizes malformed values
//   - handleConfigRequest re-dispatches on both handshake event spellings
//   - storage.onChanged re-dispatches only for meaningful prefix/pattern changes
// ============================================================================

const CONTENT_DIR = path.dirname(fileURLToPath(import.meta.url));
const CONTENT_ROOT = path.resolve(CONTENT_DIR, "..");
const CONTENT_SRC = path.join(CONTENT_ROOT, "src", "content.js");

/**
 * Build a fresh browser-ish sandbox and load content.js into it.
 *
 * @param {{prefix?: string, patterns?: string[], store?: object,
 *          getThrows?: boolean, dispatchThrows?: boolean,
 *          createElementThrows?: boolean}} opts
 *   Pass `store` to reuse a backing store across harnesses.
 */
function makeContentHarness({
	prefix,
	patterns,
	store: existingStore,
	getThrows = false,
	dispatchThrows = false,
	createElementThrows = false,
} = {}) {
	const store = existingStore ?? {};
	if (prefix !== undefined) store.prefix = prefix;
	if (patterns !== undefined) store.patterns = patterns;

	const dispatched = [];
	const docListeners = {};
	const appendedScripts = [];
	let onChangedCb = null;

	class CustomEvent {
		constructor(type, init) {
			this.type = type;
			this.detail = init?.detail;
		}
	}

	const head = {
		appendChild(node) {
			appendedScripts.push(node);
			return node;
		},
	};

	const document = {
		head,
		documentElement: head,
		dispatchEvent(event) {
			if (dispatchThrows) throw new Error("dispatch unavailable");
			// Normalize the vm-realm detail into a host-realm plain value so
			// deepStrictEqual does not trip over cross-realm prototypes.
			dispatched.push({
				type: event.type,
				detail:
					event.detail == null
						? event.detail
						: JSON.parse(JSON.stringify(event.detail)),
			});
			return true;
		},
		addEventListener(type, cb) {
			if (!docListeners[type]) docListeners[type] = [];
			docListeners[type].push(cb);
		},
		createElement(tag) {
			if (createElementThrows) throw new Error("createElement unavailable");
			return {
				tagName: String(tag).toUpperCase(),
				src: "",
				onload: null,
				removed: false,
				remove() {
					this.removed = true;
				},
			};
		},
	};

	const chrome = {
		storage: {
			local: {
				get(keys, cb) {
					if (getThrows) throw new Error("storage unavailable");
					const arr = Array.isArray(keys) ? keys : [keys];
					const items = {};
					for (const k of arr) {
						if (Object.prototype.hasOwnProperty.call(store, k))
							items[k] = store[k];
					}
					cb(items);
				},
			},
			onChanged: {
				addListener(cb) {
					onChangedCb = cb;
				},
			},
		},
		runtime: {
			getURL(p) {
				return `chrome-extension://test/${p}`;
			},
		},
	};

	const sandbox = { chrome, document, CustomEvent, console };
	const context = vm.createContext(sandbox);
	vm.runInContext(fs.readFileSync(CONTENT_SRC, "utf8"), context, {
		filename: "content.js",
	});

	return {
		sandbox,
		store,
		dispatched,
		appendedScripts,
		docListeners,
		getOnChanged: () => onChangedCb,
		fireChange: (changes) => {
			if (typeof onChangedCb === "function") onChangedCb(changes);
		},
		fireDocumentEvent: (type) => {
			for (const cb of docListeners[type] || []) cb({ type });
		},
	};
}

// ---------------------------------------------------------------------------
// BOOTSTRAP — injection + initial config dispatch
// ---------------------------------------------------------------------------

describe("content.js bootstrap: config bridge without dynamic script injection", () => {
	test("does not append a page-world script", () => {
		const h = makeContentHarness({
			prefix: "req",
			patterns: ["https://example.com/*"],
		});
		assert.strictEqual(h.appendedScripts.length, 0);
	});

	test("bootstrap dispatches the initial requestid-config event", () => {
		const h = makeContentHarness({
			prefix: "req",
			patterns: ["https://example.com/*"],
		});
		assert.strictEqual(h.dispatched.length, 1);
		assert.strictEqual(h.dispatched[0].type, "requestid-config");
		assert.deepStrictEqual(h.dispatched[0].detail, {
			prefix: "req",
			patterns: ["https://example.com/*"],
		});
	});

	test("bootstrap with empty storage dispatches empty defaults", () => {
		const h = makeContentHarness();
		assert.deepStrictEqual(h.dispatched[0].detail, {
			prefix: "",
			patterns: [],
		});
	});
});

// ---------------------------------------------------------------------------
// dispatchConfig — exact event name + detail shape
// ---------------------------------------------------------------------------

describe("dispatchConfig emits the requestid-config CustomEvent", () => {
	test("dispatches with the exact prefix and patterns passed in", () => {
		const h = makeContentHarness();
		h.sandbox.dispatchConfig("abc", ["https://a.com/*", "https://b.com/*"]);
		const last = h.dispatched[h.dispatched.length - 1];
		assert.strictEqual(last.type, "requestid-config");
		assert.deepStrictEqual(last.detail, {
			prefix: "abc",
			patterns: ["https://a.com/*", "https://b.com/*"],
		});
	});

	test("dispatches empty prefix and empty array verbatim", () => {
		const h = makeContentHarness();
		h.sandbox.dispatchConfig("", []);
		const last = h.dispatched[h.dispatched.length - 1];
		assert.deepStrictEqual(last.detail, { prefix: "", patterns: [] });
	});

	test("preserves unicode and special characters in the prefix", () => {
		const h = makeContentHarness();
		h.sandbox.dispatchConfig("日本語-x_42", []);
		const last = h.dispatched[h.dispatched.length - 1];
		assert.strictEqual(last.detail.prefix, "日本語-x_42");
	});
});

// ---------------------------------------------------------------------------
// loadAndDispatchConfig — storage read + normalization
// ---------------------------------------------------------------------------

describe("loadAndDispatchConfig reads and normalizes storage", () => {
	test("re-reads the current store on each call", () => {
		const h = makeContentHarness({
			prefix: "first",
			patterns: ["https://a.com/*"],
		});
		h.store.prefix = "second";
		h.store.patterns = ["https://b.com/*"];
		h.sandbox.loadAndDispatchConfig();
		const last = h.dispatched[h.dispatched.length - 1];
		assert.deepStrictEqual(last.detail, {
			prefix: "second",
			patterns: ["https://b.com/*"],
		});
	});

	test("non-string prefix normalizes to empty string", () => {
		const h = makeContentHarness({
			store: { prefix: 12345, patterns: ["https://a.com/*"] },
		});
		assert.deepStrictEqual(h.dispatched[0].detail, {
			prefix: "",
			patterns: ["https://a.com/*"],
		});
	});

	test("null prefix normalizes to empty string", () => {
		const h = makeContentHarness({ store: { prefix: null, patterns: [] } });
		assert.strictEqual(h.dispatched[0].detail.prefix, "");
	});

	test("non-array patterns normalizes to empty array", () => {
		const h = makeContentHarness({
			store: { prefix: "req", patterns: "not-an-array" },
		});
		assert.deepStrictEqual(h.dispatched[0].detail.patterns, []);
	});

	test("missing keys normalize to empty defaults", () => {
		const h = makeContentHarness({ store: {} });
		assert.deepStrictEqual(h.dispatched[0].detail, {
			prefix: "",
			patterns: [],
		});
	});
});

// ---------------------------------------------------------------------------
// handleConfigRequest — handshake from the injected script
// ---------------------------------------------------------------------------

describe("handleConfigRequest answers the injected-script handshake", () => {
	test("registers listeners for both handshake event spellings", () => {
		const h = makeContentHarness();
		assert.strictEqual(
			(h.docListeners["requestid-config-request"] || []).length,
			1,
		);
		assert.strictEqual(
			(h.docListeners["requestid-request-config"] || []).length,
			1,
		);
	});

	test("requestid-config-request triggers a fresh config dispatch", () => {
		const h = makeContentHarness({
			prefix: "req",
			patterns: ["https://a.com/*"],
		});
		const before = h.dispatched.length;
		h.fireDocumentEvent("requestid-config-request");
		assert.strictEqual(h.dispatched.length, before + 1);
		assert.strictEqual(
			h.dispatched[h.dispatched.length - 1].type,
			"requestid-config",
		);
	});

	test("requestid-request-config triggers a fresh config dispatch", () => {
		const h = makeContentHarness({
			prefix: "req",
			patterns: ["https://a.com/*"],
		});
		const before = h.dispatched.length;
		h.fireDocumentEvent("requestid-request-config");
		assert.strictEqual(h.dispatched.length, before + 1);
	});

	test("handleConfigRequest called directly re-reads storage", () => {
		const h = makeContentHarness({ prefix: "old", patterns: [] });
		h.store.prefix = "new";
		h.sandbox.handleConfigRequest();
		const last = h.dispatched[h.dispatched.length - 1];
		assert.strictEqual(last.detail.prefix, "new");
	});
});

// ---------------------------------------------------------------------------
// storage.onChanged — live refresh
// ---------------------------------------------------------------------------

describe("storage.onChanged re-dispatches on meaningful changes", () => {
	test("registers exactly one onChanged listener", () => {
		const h = makeContentHarness();
		assert.strictEqual(typeof h.getOnChanged(), "function");
	});

	test("a string prefix change re-dispatches the full config", () => {
		const h = makeContentHarness({
			prefix: "old",
			patterns: ["https://a.com/*"],
		});
		const before = h.dispatched.length;
		h.store.prefix = "new";
		h.fireChange({ prefix: { newValue: "new" } });
		assert.strictEqual(h.dispatched.length, before + 1);
		assert.deepStrictEqual(h.dispatched[h.dispatched.length - 1].detail, {
			prefix: "new",
			patterns: ["https://a.com/*"],
		});
	});

	test("an array patterns change re-dispatches the full config", () => {
		const h = makeContentHarness({
			prefix: "req",
			patterns: ["https://a.com/*"],
		});
		const before = h.dispatched.length;
		h.store.patterns = ["https://b.com/*"];
		h.fireChange({ patterns: { newValue: ["https://b.com/*"] } });
		assert.strictEqual(h.dispatched.length, before + 1);
		assert.deepStrictEqual(h.dispatched[h.dispatched.length - 1].detail, {
			prefix: "req",
			patterns: ["https://b.com/*"],
		});
	});

	test("an unrelated key change is ignored", () => {
		const h = makeContentHarness({ prefix: "req", patterns: [] });
		const before = h.dispatched.length;
		h.fireChange({ unrelated: { newValue: "x" } });
		assert.strictEqual(h.dispatched.length, before);
	});

	test("an empty changes object is ignored", () => {
		const h = makeContentHarness({ prefix: "req", patterns: [] });
		const before = h.dispatched.length;
		h.fireChange({});
		assert.strictEqual(h.dispatched.length, before);
	});

	test("a null prefix newValue is ignored", () => {
		const h = makeContentHarness({ prefix: "req", patterns: [] });
		const before = h.dispatched.length;
		h.fireChange({ prefix: { newValue: null } });
		assert.strictEqual(h.dispatched.length, before);
	});

	test("a non-string prefix newValue is ignored", () => {
		const h = makeContentHarness({ prefix: "req", patterns: [] });
		const before = h.dispatched.length;
		h.fireChange({ prefix: { newValue: 42 } });
		assert.strictEqual(h.dispatched.length, before);
	});

	test("a non-array patterns newValue is ignored", () => {
		const h = makeContentHarness({ prefix: "req", patterns: [] });
		const before = h.dispatched.length;
		h.fireChange({ patterns: { newValue: "not-an-array" } });
		assert.strictEqual(h.dispatched.length, before);
	});

	test("a prefix removal (newValue undefined) is ignored", () => {
		const h = makeContentHarness({ prefix: "req", patterns: [] });
		const before = h.dispatched.length;
		h.fireChange({ prefix: { oldValue: "req" } });
		assert.strictEqual(h.dispatched.length, before);
	});
});

// ---------------------------------------------------------------------------
// FAIL-OPEN — unavailable DOM APIs
// ---------------------------------------------------------------------------

describe("content.js fails open when DOM APIs are unavailable", () => {
	test("dispatchConfig does not throw when document.dispatchEvent throws", () => {
		const h = makeContentHarness({ dispatchThrows: true });
		let threw = false;
		try {
			h.sandbox.dispatchConfig("req", ["https://a.com/*"]);
		} catch {
			threw = true;
		}
		assert.strictEqual(threw, false);
		assert.strictEqual(h.dispatched.length, 0);
	});

	test("bootstrap does not depend on document.createElement", () => {
		const h = makeContentHarness({ createElementThrows: true });
		assert.strictEqual(h.dispatched[0].type, "requestid-config");
		assert.strictEqual(h.appendedScripts.length, 0);
	});

	test("bootstrap dispatches config for the statically registered page script", () => {
		const h = makeContentHarness({
			prefix: "req",
			patterns: ["https://a.com/*"],
			createElementThrows: true,
		});
		assert.strictEqual(h.appendedScripts.length, 0);
		assert.deepStrictEqual(h.dispatched[0].detail, {
			prefix: "req",
			patterns: ["https://a.com/*"],
		});
	});
});

// ---------------------------------------------------------------------------
// SOURCE CONTRACT — content.js is a classic script (no ESM syntax)
// ---------------------------------------------------------------------------

describe("content.js source contract", () => {
	test("contains no import/export statements (classic content script)", () => {
		const src = fs.readFileSync(CONTENT_SRC, "utf8");
		assert.ok(!/^\s*import\s/m.test(src), "content.js must not use import");
		assert.ok(!/^\s*export\s/m.test(src), "content.js must not use export");
	});

	test("no longer wraps fetch or XMLHttpRequest (moved to injected.js)", () => {
		const src = fs.readFileSync(CONTENT_SRC, "utf8");
		assert.ok(
			!src.includes("XMLHttpRequest.prototype"),
			"content.js must not patch XMLHttpRequest.prototype",
		);
		assert.ok(
			!/new\s+XMLHttpRequest\b/.test(src),
			"content.js must not construct XMLHttpRequest",
		);
		assert.ok(
			!/window\.fetch\s*=/.test(src),
			"content.js must not reassign window.fetch",
		);
	});

	test("manifest declares src/content.js as a content script", () => {
		const manifest = JSON.parse(
			fs.readFileSync(path.join(CONTENT_ROOT, "manifest.json"), "utf8"),
		);
		const jsFiles = (manifest.content_scripts || []).flatMap(
			(cs) => cs.js || [],
		);
		assert.ok(jsFiles.includes("src/content.js"));
	});
});
