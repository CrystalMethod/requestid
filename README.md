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

# Run all tests (265 tests, 73 suites)
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
src/injected.js        — Page (MAIN world) script: fetch + XHR interceptor, registered statically at document_start
src/content.js         — Isolated content script: storage bridge, sends prefix/patterns to the page script
src/popup.html/js/css  — Toolbar popup: prefix + pattern configuration panel
src/onboarding.html/js — First-run setup view (prefix + initial patterns)
tests/                 — 265 Node.js tests, 73 suites (1.1 manifest+storage, 1.2 matcher+generator, 1.3 runtime harness, 2.1 popup, 2.2 onboarding)
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

### Backend patterns and CORS

The extension has no built-in backend hosts. The default pattern list is empty; you add every pattern yourself. Relative request URLs (`/api/x`) are resolved against the page base URL for matching only. The URL sent on the wire is not rewritten.

Same-origin Angular backend (relative URL, nothing cross-origin), served at `https://app.example.com`:

```ts
this.http.get('/api/users');        // HttpClient uses XHR by default
fetch('/api/users');
```

Pattern: `https://app.example.com/api/*`

Separately configured API origin, for example `https://api.example.com`:

```ts
this.http.get('https://api.example.com/v1/users');
```

Pattern: `https://api.example.com/*`

Pattern cautions: `*` as host or `*://*/*` tags every request, including third-party ones. Keep patterns as narrow as your backend allows.

CORS: the extension does not bypass CORS and does not control server responses. On a cross-origin request, the custom `X-Request-ID` header makes the browser send an `OPTIONS` preflight first. The backend must answer the preflight with an allowed origin, allowed method, and `Access-Control-Allow-Headers` that includes `X-Request-ID`. Otherwise the browser blocks the request. Same-origin requests need no preflight.

Scope: only `fetch` and `XMLHttpRequest` are intercepted. Media elements, `EventSource`, and `WebSocket` are not intercepted. Media playback was not tested.

## How It Works

### Header injection

For **fetch**: wraps `window.fetch`, inspects the request URL against configured patterns, and injects the header into the `Headers` object. Existing `X-Request-ID` headers are preserved (no overwrite). Original `Request` objects are never mutated.

For **XHR**: wraps `XMLHttpRequest.prototype.open` (captures the URL) and `send` (injects the header via `setRequestHeader`). Reused XHR objects inject fresh headers on each open+send cycle.

### Fail-open guarantees

- If the prefix is empty, no header is injected; requests pass through unmodified.
- If the pattern list is empty, no header is injected.
- If `chrome.storage.local` fails, getters return defaults (`""`, `[]`) without throwing.
- If request-ID generation fails, the original request continues unchanged. Invalid application fetch arguments still reject with native Fetch behavior.

## Chrome Diagnostics

Timing model: `src/injected.js` is registered statically in the `MAIN` world at `document_start`, so the hooks exist before app scripts run. This does not depend on a page-inserted `<script>`, and it worked under page CSP `script-src 'self'` in Chrome for Testing 155.0.8059.39. Config (prefix and patterns) arrives separately and asynchronously from `chrome.storage.local` through `src/content.js`. A request made before config arrives passes through with no `X-Request-ID` (fail-open). Requests after config arrives get IDs.

If no ID appears, check in order:

1. `chrome://extensions/`: RequestID is enabled (and allowed in incognito if used). Open the popup: prefix is set and a pattern matches the request URL.
2. Page DevTools Console: look for script or CSP errors mentioning the extension.
3. Network tab, filter `Fetch/XHR`: pick the request, open Headers, look for `X-Request-ID: <prefix>-<5 chars>` under Request Headers. Missing on only the first requests after load means config was not ready yet.
4. Cross-origin only: look for an `OPTIONS` row before the request. Check its response has `Access-Control-Allow-Origin`, `Access-Control-Allow-Methods`, and `Access-Control-Allow-Headers` including `X-Request-ID`. A failed preflight shows as a CORS error in Console.

Browser evidence: static injection, ID on fetch and XHR, wrong-host pass-through, empty-prefix pass-through, and CSP `script-src 'self'` were observed in Chrome for Testing 155.0.8059.39 (see `.omo/evidence/requestid-streaming-angular/task-4.md`). Media playback was not tested.

## Testing

The test suite (265 tests, 73 suites per `npm test`) covers:

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

- **CORS preflight**: The extension does not handle or bypass CORS preflight (OPTIONS) requests. Cross-origin backends must allow the origin, method, and `X-Request-ID` in `Access-Control-Allow-Headers`.
- **Chromium only**: Built for Chrome MV3; not tested on Firefox, Edge, or other browsers.
- **Incognito**: Works in incognito if "Allow in incognito" is enabled for the extension.
- **Single suffix**: The 5-character suffix (62^5 ≈ 916M combinations) is not cryptographically unique across the internet; it is intended for local development log correlation.

## License

Private repository.
