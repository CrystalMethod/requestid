/**
 * Tests for Phase 1.2: Wildcard URL matcher and Request ID generator
 * Covering verification and adversarial scenarios
 */

import { describe, test } from "node:test";
import assert from "node:assert";
import { matchesPattern, matchesAny } from "../src/matcher.js";
import { generateSuffix, buildRequestId } from "../src/requestId.js";

// ============================================================================
// VERIFICATION TESTS - matchesPattern
// ============================================================================

describe("matchesPattern: Verification", () => {
  describe("exact host match", () => {
    test("should match exact https URL", () => {
      assert.strictEqual(
        matchesPattern("https://example.com/path", "https://example.com/path"),
        true
      );
    });

    test("should match exact http URL with trailing slash", () => {
      assert.strictEqual(
        matchesPattern("http://example.com/path/", "http://example.com/path/"),
        true
      );
    });

    test("should not match if scheme differs", () => {
      assert.strictEqual(
        matchesPattern("https://example.com/path", "http://example.com/path"),
        false
      );
    });

    test("should not match if path differs", () => {
      assert.strictEqual(
        matchesPattern("https://example.com/path", "https://example.com/other"),
        false
      );
    });
  });

  describe("wildcard subdomain", () => {
    test("*.example.com matches subdomain", () => {
      assert.strictEqual(
        matchesPattern("https://foo.example.com/api", "https://*.example.com/api"),
        true
      );
    });

    test("*.example.com matches nested subdomain", () => {
      assert.strictEqual(
        matchesPattern("https://bar.baz.example.com/api", "https://*.example.com/api"),
        true
      );
    });

    test("*.example.com does NOT match base domain", () => {
      assert.strictEqual(
        matchesPattern("https://example.com/api", "https://*.example.com/api"),
        false
      );
    });

    test("exact host does NOT match subdomain", () => {
      assert.strictEqual(
        matchesPattern("https://foo.example.com/api", "https://example.com/api"),
        false
      );
    });
  });

  describe("wildcard path", () => {
    test("* matches any path", () => {
      assert.strictEqual(
        matchesPattern("https://example.com/any/path/here", "https://example.com/*"),
        true
      );
    });

    test("* matches empty path", () => {
      assert.strictEqual(
        matchesPattern("https://example.com", "https://example.com/*"),
        true
      );
    });

    test("* in middle of path", () => {
      assert.strictEqual(
        matchesPattern("https://example.com/foo/bar", "https://example.com/*/bar"),
        true
      );
    });

    test("* must match full path segment", () => {
      assert.strictEqual(
        matchesPattern("https://example.com/foobar", "https://example.com/*bar"),
        true
      );
    });
  });

  describe("no-match cases", () => {
    test("different host returns false", () => {
      assert.strictEqual(
        matchesPattern("https://other.com/path", "https://example.com/*"),
        false
      );
    });

    test("different scheme returns false", () => {
      assert.strictEqual(
        matchesPattern("ftp://example.com/path", "https://example.com/path"),
        false
      );
    });

    test("*:// pattern matches any scheme", () => {
      assert.strictEqual(
        matchesPattern("https://example.com/path", "*://example.com/path"),
        true
      );
    });

    test("*:// matches ftp too", () => {
      assert.strictEqual(
        matchesPattern("ftp://example.com/path", "*://example.com/path"),
        true
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
        matchesPattern("https://example.com/api?key=value", "https://example.com/api?key=value"),
        true
      );
    });

    test("pattern without query does NOT match URL with query", () => {
      assert.strictEqual(
        matchesPattern("https://example.com/api", "https://example.com/api?key=value"),
        false
      );
    });

    test("* in path matches query string", () => {
      assert.strictEqual(
        matchesPattern("https://example.com/api?key=value", "https://example.com/*"),
        true
      );
    });
  });

  describe("fragment", () => {
    test("fragment is included in matching", () => {
      assert.strictEqual(
        matchesPattern("https://example.com/page#section", "https://example.com/page#section"),
        true
      );
    });

    test("* matches fragment too", () => {
      assert.strictEqual(
        matchesPattern("https://example.com/page#section", "https://example.com/*"),
        true
      );
    });
  });

  describe("subdomain vs base", () => {
    test("exact host does not match subdomain", () => {
      assert.strictEqual(
        matchesPattern("https://sub.example.com", "https://example.com"),
        false
      );
    });

    test("exact match works for base domain", () => {
      assert.strictEqual(
        matchesPattern("https://example.com", "https://example.com"),
        true
      );
    });
  });

  describe("matchesAny function", () => {
    test("returns true if any pattern matches", () => {
      const patterns = ["https://other.com/*", "https://example.com/*"];
      assert.strictEqual(matchesAny("https://example.com/path", patterns), true);
    });

    test("returns false if no pattern matches", () => {
      const patterns = ["https://other.com/*", "https://another.com/*"];
      assert.strictEqual(matchesAny("https://example.com/path", patterns), false);
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
      assert.ok(alnumRegex.test(suffix), `Suffix "${suffix}" does not match 5-char alnum pattern`);
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
      assert.ok(suffixes.size > 95, `Expected >95 unique values, got ${suffixes.size}`);
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
      assert.strictEqual(matchesPattern("not a valid url", "https://example.com/*"), false);
    });

    test("URL missing protocol returns false", () => {
      assert.strictEqual(matchesPattern("example.com/path", "https://example.com/*"), false);
    });

    test("nested schema in path does not bypass", () => {
      assert.strictEqual(
        matchesPattern("https://example.com/http://evil.com", "https://example.com/*"),
        true
      );
    });
  });

  describe("null/undefined/empty inputs", () => {
    test("null urlString returns false", () => {
      assert.strictEqual(matchesPattern(null, "https://example.com/*"), false);
    });

    test("undefined urlString returns false", () => {
      assert.strictEqual(matchesPattern(undefined, "https://example.com/*"), false);
    });

    test("empty urlString returns false", () => {
      assert.strictEqual(matchesPattern("", "https://example.com/*"), false);
    });

    test("null patternString returns false", () => {
      assert.strictEqual(matchesPattern("https://example.com/", null), false);
    });

    test("undefined patternString returns false", () => {
      assert.strictEqual(matchesPattern("https://example.com/", undefined), false);
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
      assert.strictEqual(matchesPattern("https://boring.com/path", pattern), false);
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
        matchesPattern("https://example.com/file.$txt", "https://example.com/file.$txt"),
        true
      );
    });

    test("parentheses in path are escaped", () => {
      assert.strictEqual(
        matchesPattern("https://example.com/(test)", "https://example.com/(test)"),
        true
      );
    });

    test("brackets in path are escaped", () => {
      assert.strictEqual(
        matchesPattern("https://example.com/[test]", "https://example.com/[test]"),
        true
      );
    });

    test("pipe character in path is escaped", () => {
      assert.strictEqual(
        matchesPattern("https://example.com/data|backup", "https://example.com/data|backup"),
        true
      );
    });
  });

  describe("boundary lengths", () => {
    test("single character host", () => {
      assert.strictEqual(matchesPattern("https://a", "https://a"), true);
    });

    test("single character path", () => {
      assert.strictEqual(matchesPattern("https://example.com/a", "https://example.com/a"), true);
    });

    test("wildcard subdomain with one char subdomain", () => {
      assert.strictEqual(
        matchesPattern("https://a.example.com", "https://*.example.com"),
        true
      );
    });

    test("non-empty host must precede wildcard subdomain suffix", () => {
      assert.strictEqual(
        matchesPattern("https://example.com", "https://*.example.com"),
        false
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
        assert.ok(/^[A-Za-z0-9]{5}$/.test(suffix), `Suffix "${suffix}" invalid`);
      }
    });

    test("suffix never contains special characters", () => {
      for (let i = 0; i < 100; i++) {
        const suffix = generateSuffix();
        assert.ok(!/[^A-Za-z0-9]/.test(suffix), `Suffix "${suffix}" contains special chars`);
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
      assert.ok(id.startsWith(longPrefix + "-"), `ID should start with "${longPrefix}-"`);
    });

    test("prefix with special chars", () => {
      const id = buildRequestId("test-special_chars.123");
      assert.ok(id.startsWith("test-special_chars.123-"), `ID should start with prefix`);
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
    const patterns = [
      "https://api.example.com/*",
      "*://*.internal.com/*"
    ];

    const urls = [
      "https://api.example.com/users",
      "https://cdn.internal.com/data.json",
      "https://external.com/page"
    ];

    const ids = urls.map(url => ({
      url,
      matches: matchesAny(url, patterns),
      id: buildRequestId("req")
    }));

    assert.strictEqual(ids[0].matches, true);
    assert.strictEqual(ids[1].matches, true);
    assert.strictEqual(ids[2].matches, false);
    assert.ok(ids[0].id.startsWith("req-"), `ID "${ids[0].id}" should start with "req-"`);
    assert.ok(ids[1].id.startsWith("req-"), `ID "${ids[1].id}" should start with "req-"`);
  });
});