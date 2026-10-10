# RequestID

Chrome MV3 extension that injects `X-Request-ID: <prefix>-<5 alnum chars>` (e.g. `dev-a3Xk9`) into matching `fetch` and `XMLHttpRequest` requests, so backend logs trace back to the browser request.

## Quick Start

1. Open `chrome://extensions/`, enable **Developer mode**, click **Load unpacked**, select this directory.
2. Set a prefix in the onboarding tab (e.g. `dev`). Reopen the toolbar popup any time to change it.
3. Add URL patterns in the popup. The default list is empty, so nothing is injected until you add one.

End-to-end walkthrough with captured evidence: [docs/sample-usage.md](docs/sample-usage.md).

## URL Patterns

| Pattern | Matches |
|---------|---------|
| `https://api.example.com/*` | `https://api.example.com/v1/users` |
| `*://*.internal.com/*` | `http://staging.internal.com/data`, `https://api.internal.com/` |
| `https://example.com/api?key=value` | exact query only |

- An exact host excludes subdomains. `*.example.com` includes subdomains but not `example.com` itself.
- The scheme may be `*`.
- Matching uses `URL.hostname`, which has no port. An exact pattern host must omit the port: `https://host:8443/*` never matches. `https://host/*` matches `https://host:8443/api` (any port).
- Relative URLs (`/api/x`) are resolved against `document.baseURI` in the page for matching only. The URL on the wire is not rewritten.
- `*` as host or `*://*/*` tags every request, including third-party ones. Keep patterns narrow.

## Behavior

- Only `fetch` and `XMLHttpRequest` are intercepted. Media elements, `EventSource`, and `WebSocket` are untouched. Media playback was verified unaffected on a real streaming page (HTML5 video, HTTP 206, Chrome for Testing 155.0.8059.39).
- Caller `Request` and `Headers` objects are never mutated. A supplied `init.headers` replaces `Request` headers, as native Fetch does. A caller-set `X-Request-ID` is preserved. The original `Response` body and stream are untouched.
- Fail-open: empty prefix or empty patterns means no injection. Storage failure falls back to defaults without throwing. If ID generation fails, the request passes through. Invalid fetch arguments still reject with native Fetch behavior.
- Startup: `src/injected.js` is registered statically in the `MAIN` world at `document_start`, so hooks exist before app scripts run (works under CSP `script-src 'self'`). `src/content.js` bridges `chrome.storage.local` to the page asynchronously. Requests sent before config arrives go out without an ID.

## CORS

The extension does not bypass CORS. A cross-origin request with the custom header triggers an `OPTIONS` preflight. The backend must allow the origin, method, and `X-Request-ID` in `Access-Control-Allow-Headers`, or the browser blocks the request. Same-origin requests need no preflight.

## Troubleshooting

1. `chrome://extensions/`: extension enabled (and allowed in incognito if used). Popup: prefix set, a pattern matches the URL.
2. DevTools Console: script or CSP errors mentioning the extension.
3. Network tab, filter `Fetch/XHR`: look for `X-Request-ID` under Request Headers. Missing only on the first requests after load means config was not ready yet.
4. Cross-origin: check the `OPTIONS` response for `Access-Control-Allow-Headers` including `X-Request-ID`. A failed preflight shows as a CORS error in Console.

## Development

```bash
npm install
npm run lint
npm run lint:fix
npm test        # 265 tests, 73 suites
```

Node.js 20+. Tests use the built-in `node:test` runner, no test dependencies.

```
manifest.json           MV3 manifest
src/background.js       service worker: onboarding gate, badge
src/storage.js          chrome.storage.local wrapper (prefix, patterns)
src/matcher.js          pure wildcard URL matcher
src/requestId.js        pure suffix generator and ID builder
src/injected.js         MAIN-world document_start fetch/XHR interceptor
src/content.js          isolated content script: storage bridge to injected.js
src/popup.*             toolbar popup: prefix and pattern config
src/onboarding.*        first-run setup
tests/                  Node.js tests
```

## Known Limitations

- CORS preflight is not handled or bypassed. Cross-origin backends must allow `X-Request-ID`.
- Chromium only. Not tested on Firefox, Edge, or others.
- Incognito requires "Allow in incognito" on the extension.
- The 5-char suffix (62^5, about 916M values) is not globally unique. It is for local log correlation.

## License

[MIT LICENSE](./LICENSE)
