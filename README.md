# RequestID

Chrome MV3 extension that injects `X-Request-ID: <prefix>-<random>` headers into outgoing HTTP requests for debugging and traceability.

When a request URL matches a configured pattern, the extension automatically appends a `X-Request-ID` header so that backend server logs are immediately traceable back to the originating browser request.

## Features

- **Pattern-based filtering** — configure URL patterns; only matching requests receive the header.
- **Wildcard matching** — `*` matches any character sequence in host and path; `*.example.com` matches subdomains.
- **Prefix + unique suffix** — format is `<user-prefix>-<5-char-alphanum-suffix>` (e.g., `req-a3Xk9`).
- **Fetch + XHR interception** — hooks both `window.fetch` and `XMLHttpRequest`.
- **Fail-open** — never blocks, cancels, or alters requests even when misconfigured.
- **Popup configuration panel** — edit the prefix and add/remove URL patterns from the toolbar popup, with inline validation for malformed patterns.
- **First-run onboarding** — opens automatically on install when no prefix is set, with a warning indicator until a prefix is configured.
- **Persisted configuration** — prefix and patterns survive browser restarts via `chrome.storage.local`.
- **Badge indicator** — toolbar icon shows `!` (orange) when prefix is unset, `R` (blue) when active.

## Quick Start

### Install for development

1. Load the extension in Chrome:
   - Open `chrome://extensions/`
   - Enable **Developer mode**
   - Click **Load unpacked** and select this directory

2. Set a prefix on first launch — the extension opens an onboarding tab where you can enter a prefix (e.g. `dev`, `v12345`).

3. Add URL patterns to limit which requests receive the header. Default: empty list (no injection). Reopen the popup from the toolbar icon at any time to change the prefix or patterns.

### Development setup

```bash
# Install dev dependencies
npm install          # or: bun install

# Run the linting checks
npm run lint

# Fix lint issues automatically
npm run lint:fix

# Run all tests (193 tests)
npm test
```

**Requirements:** Node.js 20+ (uses the built-in `node:test` runner). No test dependencies — tests use only the Node.js standard library.

## Architecture

```
manifest.json          — MV3 manifest (background service worker, content script, action popup)
src/background.js      — Service worker: onboarding gate, badge maintenance
src/storage.js         — Persistent storage API: getPrefix/setPrefix, getPatterns/setPatterns
src/matcher.js         — Pure wildcard URL pattern matcher (no chrome APIs)
src/requestId.js       — Pure 5-char suffix generator (crypto.getRandomValues preferred)
src/content.js         — Classic content script: fetch + XHR interceptor (self-contained)
src/popup.html/js/css  — Toolbar popup: prefix + pattern configuration panel
src/onboarding.html/js — First-run setup view (prefix + initial patterns)
tests/                 — 193 Node.js tests (1.1 manifest+storage, 1.2 matcher+generator, 1.3 runtime harness, 2.1 popup, 2.2 onboarding)
```

### Module responsibilities

| Module | Exports | Chrome API | Pure |
|--------|---------|------------|------|
| `storage.js` | `getPrefix()`, `setPrefix()`, `getPatterns()`, `setPatterns()` | `chrome.storage.local` | No |
| `matcher.js` | `matchesPattern()`, `matchesAny()` | — | Yes |
| `requestId.js` | `generateSuffix()`, `buildRequestId()` | — | Yes |
| `content.js` | — (classic script, no exports) | `chrome.storage.local`, `chrome.storage.onChanged` | No |
| `background.js` | — (classic service worker) | `chrome.runtime`, `chrome.action`, `chrome.tabs` | No |
| `popup.js` | — (classic script, no exports) | `chrome.storage.local`, `chrome.runtime` | No |
| `onboarding.js` | — (classic script, no exports) | `chrome.storage.local`, `chrome.runtime` | No |

### Data flow

```
Popup / onboarding sets prefix/patterns → chrome.storage.local
                           ↕ (onChanged listener)
                     content.js local cache
                           ↕ (per request)
                     matchesAny(url, patterns)
                           ↕ (match + prefix set)
                     buildRequestId(prefix) → "prefix-suffix"
                           ↕ (inject)
                     X-Request-ID header on fetch/XHR
```

## Configuration

### Prefix

A user-defined string attached to every generated request ID. Edit it from the toolbar popup (or the first-run onboarding view). An empty prefix is allowed and triggers the warning badge (`!`).

### URL Patterns

Array of wildcard URL patterns (Chrome MV3 format), managed from the popup with add/remove controls. Patterns are validated before they are saved; malformed entries (empty, whitespace, missing host, unsupported scheme) are rejected with an inline message. Examples:

| Pattern | Matches |
|---------|---------|
| `https://api.example.com/*` | `https://api.example.com/v1/users` |
| `*://*.internal.com/*` | `http://staging.internal.com/data`, `https://api.internal.com/` |
| `https://example.com/api?key=value` | Exact query match only |
| `https://example.com/*` | Any path, query, or fragment on example.com |

**Important:** Exact host patterns do **not** match subdomains. Use `*.example.com` for subdomain matching.

## How It Works

### Header injection

For **fetch**: wraps `window.fetch`, inspects the request URL against configured patterns, and injects the header into the `Headers` object. Existing `X-Request-ID` headers are preserved (no overwrite). Original `Request` objects are never mutated.

For **XHR**: wraps `XMLHttpRequest.prototype.open` (captures the URL) and `send` (injects the header via `setRequestHeader`). Reused XHR objects inject fresh headers on each open+send cycle.

### Fail-open guarantees

- If the prefix is empty, no header is injected; requests pass through unmodified.
- If the pattern list is empty, no header is injected.
- If `chrome.storage.local` fails, getters return defaults (`""`, `[]`) without throwing.
- If any injection step throws, the original request continues unchanged.

## Testing

The test suite (193 tests, 58 suites) covers:

| Suite | Scope |
|-------|-------|
| `task-1-1.test.js` | Manifest validity, background shell, storage round-trip, adversarial inputs, fail-open without chrome global |
| `task-1-2.test.js` | Wildcard URL matcher (exact, subdomain, path, query, fragment, regex injection), suffix format/uniqueness, request ID build, integration |
| `task-1-3.test.js` | Runtime harness: fetch interceptors, XHR interceptors, fail-open, storage onChanged live updates, manifest content_scripts block |
| `task-2-1.test.js` | Popup configuration panel: prefix save, pattern add/remove, validation, status indicator, storage hydration, manifest popup wiring |
| `task-2-2.test.js` | First-run onboarding: empty-storage boot, warning indicator, persistence across simulated reload, finish flow, HTML wiring |

```bash
npm test        # all tests
```

## Known Limitations

- **CORS preflight**: The extension does not handle CORS preflight (OPTIONS) requests. Backends must declare `X-Request-ID` in their `Access-Control-Allow-Headers` CORS policy.
- **Chromium only**: Built for Chrome MV3; not tested on Firefox, Edge, or other browsers.
- **Incognito**: Works in incognito if "Allow in incognito" is enabled for the extension.
- **Single suffix**: The 5-character suffix (62^5 ≈ 916M combinations) is not cryptographically unique across the internet; it is intended for local development log correlation.

## License

Private repository.
