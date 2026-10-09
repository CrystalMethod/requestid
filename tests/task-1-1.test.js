/**
 * Tests for Phase 1.1: Manifest V3 shell and persistent storage.
 *
 * Covering:
 *   (1) Manifest load-equivalence — JSON parses, manifest_version 3,
 *       every file referenced by the manifest exists on disk,
 *       declared permissions cover the chrome APIs used.
 *   (2) Storage round-trip — set then get prefix and patterns, defaults
 *       when storage is empty, invalid inputs rejected.
 *   (3) Adversarial — null/undefined/empty inputs, storage failure
 *       fail-open (run without chrome global, expect defaults and no
 *       throw), oversized prefix.
 *
 * background.js is NOT executed (it registers top-level chrome listeners at
 * import time). It is verified via file existence plus content checks for the
 * onInstalled handler and badge maintenance.
 */

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { after, afterEach, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

// ============================================================================
// (1) MANIFEST LOAD-EQUIVALENCE
// ============================================================================

describe("Manifest load-equivalence", () => {
	let manifest;

	before(() => {
		const raw = fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8");
		manifest = JSON.parse(raw);
	});

	test("manifest.json exists and parses as valid JSON", () => {
		assert.ok(manifest, "manifest should parse to an object");
		assert.strictEqual(typeof manifest, "object");
	});

	test("manifest_version is 3", () => {
		assert.strictEqual(manifest.manifest_version, 3);
	});

	test("name and version are present", () => {
		assert.strictEqual(typeof manifest.name, "string");
		assert.ok(manifest.name.length > 0, "name should be non-empty");
		assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
	});

	test("every file referenced by the manifest exists on disk", () => {
		// Collect all manifest-referenced file paths.
		const referenced = [];

		if (manifest.background?.service_worker) {
			referenced.push(manifest.background.service_worker);
		}

		for (const contentScript of manifest.content_scripts || []) {
			for (const js of contentScript.js || []) referenced.push(js);
			for (const css of contentScript.css || []) referenced.push(css);
		}

		// Assert at least one background worker is declared (background-only shell).
		assert.ok(
			manifest.background?.service_worker,
			"manifest should declare a background service_worker",
		);

		for (const rel of referenced) {
			assert.strictEqual(
				typeof rel,
				"string",
				`manifest reference should be a string, got ${typeof rel}`,
			);
			const abs = path.join(ROOT, rel);
			assert.ok(
				fs.existsSync(abs),
				`manifest-referenced file missing on disk: ${rel}`,
			);
		}
	});

	test("declared permissions cover the chrome APIs used by the background worker", () => {
		const permissions = manifest.permissions || [];
		assert.ok(
			permissions.includes("storage"),
			"storage permission must be declared (storage.js uses chrome.storage.local)",
		);
		assert.strictEqual(permissions[0], "storage");
	});

	test("background is scoped to a single service_worker script", () => {
		assert.ok(manifest.background, "background section must exist");
		assert.strictEqual(
			manifest.background.service_worker,
			"src/background.js",
			"service_worker should point at src/background.js",
		);
	});
});

// ============================================================================
// (1b) BACKGROUND.JS SHELL VERIFICATION (no execution — top-level chrome)
// ============================================================================

describe("background.js shell (file-existence + content, not executed)", () => {
	let src;

	before(() => {
		const abs = path.join(ROOT, "src", "background.js");
		assert.ok(fs.existsSync(abs), "src/background.js must exist");
		src = fs.readFileSync(abs, "utf8");
	});

	test("registers an onInstalled listener", () => {
		assert.match(
			src,
			/chrome\.runtime\.onInstalled\.addListener/,
			"background.js should register chrome.runtime.onInstalled.addListener",
		);
	});

	test("reads prefix from chrome.storage.local in onInstalled flow", () => {
		assert.match(
			src,
			/chrome\.storage\.local\.get\("prefix"\)/,
			"background.js should read prefix from chrome.storage.local",
		);
	});

	test("maintains badge state via chrome.action APIs", () => {
		assert.match(
			src,
			/chrome\.action\.setBadgeText/,
			"background.js should call chrome.action.setBadgeText",
		);
		assert.match(
			src,
			/chrome\.action\.setBadgeBackgroundColor/,
			"background.js should call chrome.action.setBadgeBackgroundColor",
		);
	});

	test("listens for a prefixUpdated message to keep badge in sync", () => {
		assert.match(
			src,
			/chrome\.runtime\.onMessage\.addListener/,
			"background.js should register chrome.runtime.onMessage.addListener",
		);
		assert.match(
			src,
			/prefixUpdated/,
			"background.js should handle prefixUpdated",
		);
	});
});

// ============================================================================
// STORAGE MODULE — in-memory fake chrome.storage.local
// ============================================================================

/**
 * Build an in-memory chrome.storage.local stub and a control object.
 * The stub supports get/set with a shared backing store.
 */
function makeChromeStub(initial = {}) {
	const store = { ...initial };
	const chrome = {
		storage: {
			local: {
				async get(keys) {
					const keysArr = Array.isArray(keys) ? keys : [keys];
					const out = {};
					for (const k of keysArr) {
						if (Object.prototype.hasOwnProperty.call(store, k)) {
							out[k] = store[k];
						}
					}
					return out;
				},
				async set(items) {
					Object.assign(store, items);
				},
			},
		},
	};
	return { chrome, store };
}

/**
 * Import the storage module fresh with the current global chrome stub injected
 * before import. ES module imports are cached, so to re-import with a fresh
 * chrome global we use a query-string cache-buster on the file URL.
 */
async function importStorage() {
	const cacheBust = `cb=${Date.now()}-${Math.random()}`;
	const urlFile = new URL(
		`file://${path.join(ROOT, "src", "storage.js")}?${cacheBust}`,
	);
	return await import(urlFile.href);
}

// ============================================================================
// (2) STORAGE ROUND-TRIP
// ============================================================================

describe("storage: round-trip and defaults", () => {
	let chrome;
	let store;
	let storage;

	before(async () => {
		const stub = makeChromeStub({});
		chrome = stub.chrome;
		store = stub.store;
		globalThis.chrome = chrome;
		storage = await importStorage();
	});

	afterEach(() => {
		// Clear the backing store between tests.
		for (const k of Object.keys(store)) delete store[k];
	});

	test("setPrefix then getPrefix round-trips a plain prefix", async () => {
		await storage.setPrefix("req");
		assert.strictEqual(await storage.getPrefix(), "req");
	});

	test("setPrefix with special characters round-trips", async () => {
		await storage.setPrefix("x-request-id");
		assert.strictEqual(await storage.getPrefix(), "x-request-id");
	});

	test("setPatterns then getPatterns round-trips valid patterns", async () => {
		await storage.setPatterns([
			"https://example.com/*",
			"*://api.internal.com/*",
		]);
		assert.deepStrictEqual(await storage.getPatterns(), [
			"https://example.com/*",
			"*://api.internal.com/*",
		]);
	});

	test("getPrefix returns empty string default when storage is empty", async () => {
		assert.strictEqual(await storage.getPrefix(), "");
	});

	test("getPatterns returns empty array default when storage is empty", async () => {
		assert.deepStrictEqual(await storage.getPatterns(), []);
	});

	test("getPatterns returns only stored array, never a non-array", async () => {
		store.patterns = "not-an-array";
		const mod = await importStorage();
		assert.deepStrictEqual(await mod.getPatterns(), []);
	});
});

// ============================================================================
// (3) ADVERSARIAL — invalid inputs and validation
// ============================================================================

describe("storage: invalid inputs rejected / sanitized", () => {
	let chrome;
	let store;
	let storage;

	before(async () => {
		const stub = makeChromeStub({});
		chrome = stub.chrome;
		store = stub.store;
		globalThis.chrome = chrome;
		storage = await importStorage();
	});

	afterEach(() => {
		for (const k of Object.keys(store)) delete store[k];
	});

	test("setPrefix(null) is rejected and not persisted", async () => {
		await storage.setPrefix(null);
		assert.strictEqual(await storage.getPrefix(), "");
		assert.ok(!("prefix" in store), "null prefix must not be persisted");
	});

	test("setPrefix(undefined) is rejected and not persisted", async () => {
		await storage.setPrefix(undefined);
		assert.strictEqual(await storage.getPrefix(), "");
		assert.ok(!("prefix" in store), "undefined prefix must not be persisted");
	});

	test("setPrefix(number) is rejected and not persisted", async () => {
		await storage.setPrefix(12345);
		assert.strictEqual(await storage.getPrefix(), "");
		assert.ok(!("prefix" in store), "number prefix must not be persisted");
	});

	test("setPrefix(object) is rejected and not persisted", async () => {
		await storage.setPrefix({ prefix: "x" });
		assert.strictEqual(await storage.getPrefix(), "");
		assert.ok(!("prefix" in store), "object prefix must not be persisted");
	});

	test("setPatterns(null) is rejected and not persisted", async () => {
		await storage.setPatterns(null);
		assert.deepStrictEqual(await storage.getPatterns(), []);
		assert.ok(!("patterns" in store), "null patterns must not be persisted");
	});

	test("setPatterns(undefined) is rejected and not persisted", async () => {
		await storage.setPatterns(undefined);
		assert.deepStrictEqual(await storage.getPatterns(), []);
		assert.ok(
			!("patterns" in store),
			"undefined patterns must not be persisted",
		);
	});

	test("setPatterns(string) is rejected and not persisted", async () => {
		await storage.setPatterns("https://example.com/*");
		assert.deepStrictEqual(await storage.getPatterns(), []);
		assert.ok(!("patterns" in store), "string patterns must not be persisted");
	});

	test("setPatterns filters out invalid entries and keeps valid ones", async () => {
		await storage.setPatterns([
			"https://ok.com/*",
			"",
			"   ",
			123,
			null,
			undefined,
			{},
			"https://also-ok.com/*",
		]);
		assert.deepStrictEqual(await storage.getPatterns(), [
			"https://ok.com/*",
			"https://also-ok.com/*",
		]);
	});

	test("empty string prefix is allowed and round-trips (onboarding trigger)", async () => {
		await storage.setPrefix("");
		assert.strictEqual(await storage.getPrefix(), "");
		assert.ok("prefix" in store, "empty string prefix should be persisted");
		assert.strictEqual(store.prefix, "");
	});

	test("empty patterns array is allowed and round-trips", async () => {
		await storage.setPatterns([]);
		assert.deepStrictEqual(await storage.getPatterns(), []);
		assert.ok("patterns" in store, "empty patterns array should be persisted");
		assert.deepStrictEqual(store.patterns, []);
	});

	test("oversized prefix (100KB) round-trips without corrupting", async () => {
		const big = "a".repeat(100 * 1024);
		await storage.setPrefix(big);
		const got = await storage.getPrefix();
		assert.strictEqual(got, big);
		assert.strictEqual(got.length, 100 * 1024);
	});
});

// ============================================================================
// (3b) ADVERSARIAL — storage failure fail-open (no chrome global)
// ============================================================================

describe("storage: fail-open when chrome is unavailable", () => {
	let previousChrome;

	before(async () => {
		previousChrome = globalThis.chrome;
		// Remove the chrome global so chrome.storage.local throws during access.
		delete globalThis.chrome;
	});

	after(async () => {
		if (previousChrome !== undefined) {
			globalThis.chrome = previousChrome;
		} else {
			delete globalThis.chrome;
		}
	});

	test("getPrefix returns empty string default without throwing (no chrome)", async () => {
		const storage = await importStorage();
		let result;
		let threw = false;
		try {
			result = await storage.getPrefix();
		} catch {
			threw = true;
		}
		assert.strictEqual(threw, false, "getPrefix must not throw without chrome");
		assert.strictEqual(result, "");
	});

	test("getPatterns returns empty array default without throwing (no chrome)", async () => {
		const storage = await importStorage();
		let result;
		let threw = false;
		try {
			result = await storage.getPatterns();
		} catch {
			threw = true;
		}
		assert.strictEqual(
			threw,
			false,
			"getPatterns must not throw without chrome",
		);
		assert.deepStrictEqual(result, []);
	});

	test("setPrefix does not throw when chrome is unavailable (fail-open)", async () => {
		const storage = await importStorage();
		let threw = false;
		try {
			await storage.setPrefix("req");
		} catch {
			threw = true;
		}
		assert.strictEqual(threw, false, "setPrefix must fail-open without chrome");
	});

	test("setPatterns does not throw when chrome is unavailable (fail-open)", async () => {
		const storage = await importStorage();
		let threw = false;
		try {
			await storage.setPatterns(["https://example.com/*"]);
		} catch {
			threw = true;
		}
		assert.strictEqual(
			threw,
			false,
			"setPatterns must fail-open without chrome",
		);
	});

	test("getter are still safe after repeated access with no chrome", async () => {
		const storage = await importStorage();
		for (let i = 0; i < 5; i++) {
			assert.strictEqual(await storage.getPrefix(), "");
			assert.deepStrictEqual(await storage.getPatterns(), []);
		}
	});
});

// ============================================================================
// (3c) ADVERSARIAL — getters tolerant of malformed stored values
// ============================================================================

describe("storage: getters tolerant of malformed stored values", () => {
	test("getPatterns returns default when stored patterns is a non-array object", async () => {
		const { chrome, store } = makeChromeStub({});
		store.patterns = { 0: "x" };
		globalThis.chrome = chrome;
		const storage = await importStorage();
		assert.deepStrictEqual(await storage.getPatterns(), []);
	});

	test("getPrefix returns default when stored prefix is undefined", async () => {
		const { chrome, store } = makeChromeStub({});
		store.prefix = undefined;
		globalThis.chrome = chrome;
		const storage = await importStorage();
		// chrome.storage.local.get omits undefined values, so default "" applies.
		assert.strictEqual(await storage.getPrefix(), "");
	});
});
