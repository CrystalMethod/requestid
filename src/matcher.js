/**
 * RequestID URL pattern matcher.
 *
 * Implements Chrome Manifest V3-style wildcard URL matching:
 *   - `*` matches any character sequence in host and path
 *   - Exact host patterns (no `*` in host) do NOT match subdomains
 *   - Wildcard host patterns (`*.example.com`) DO match subdomains
 *   - Query parameters and fragments are matched as part of the path
 *
 * Pure functions — no chrome APIs.
 */

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Check if a URL string matches a single pattern string.
 *
 * @param {string} urlString - The full URL to test.
 * @param {string} patternString - The URL pattern (e.g. `https://*.example.com/*`).
 * @returns {boolean}
 */
export function matchesPattern(urlString, patternString) {
  if (!patternString || !urlString) {
    return false;
  }

  const parsedPattern = parsePattern(patternString);
  const parsedUrl = parseUrl(urlString);

  if (!parsedPattern || !parsedUrl) {
    return false;
  }

  // Protocol: `*` matches any scheme; otherwise exact match.
  if (parsedPattern.protocol !== "*" && parsedPattern.protocol !== parsedUrl.protocol) {
    return false;
  }

  // Host with subdomain-aware wildcard logic.
  if (!matchHost(parsedPattern.host, parsedUrl.host)) {
    return false;
  }

  // Path (including query + fragment) with `*` wildcard.
  return matchPath(parsedPattern.path, parsedUrl.path);
}

/**
 * Check if a URL matches any pattern in a list.
 *
 * @param {string} urlString
 * @param {string[]} patternList
 * @returns {boolean}
 */
export function matchesAny(urlString, patternList) {
  if (!Array.isArray(patternList) || patternList.length === 0) {
    return false;
  }
  return patternList.some((p) => matchesPattern(urlString, p));
}

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

/**
 * Parse a URL pattern string into structured parts.
 *
 * Pattern format: `[scheme://]host[/path]`
 *   - scheme defaults to `*`
 *   - host defaults to `*`
 *   - path defaults to `*`
 *
 * @param {string} patternString
 * @returns {{ protocol: string, host: string, path: string } | null}
 */
function parsePattern(patternString) {
  let scheme = "";
  let remainder = patternString;

  // Extract protocol (e.g. `https://`, `*://`, `ftp://`).
  const schemeIdx = patternString.indexOf("://");
  if (schemeIdx !== -1) {
    scheme = patternString.slice(0, schemeIdx);
    remainder = patternString.slice(schemeIdx + 3);
  }

  // Split host from path: first `/` after scheme is the delimiter.
  const slashIdx = remainder.indexOf("/");
  let host;
  let path;

  if (slashIdx === -1) {
    host = remainder;
    path = "*";
  } else {
    host = remainder.slice(0, slashIdx);
    path = remainder.slice(slashIdx); // includes leading `/`
  }

  return { protocol: scheme, host, path };
}

/**
 * Parse a full URL string into structured parts.
 *
 * @param {string} urlString
 * @returns {{ protocol: string, host: string, path: string } | null}
 */
function parseUrl(urlString) {
  let urlObj;
  try {
    urlObj = new URL(urlString);
  } catch {
    return null;
  }

  // Reconstruct the full path including search + hash for matching.
  const fullPath = urlObj.pathname + urlObj.search + urlObj.hash;

  return {
    protocol: urlObj.protocol.slice(0, -1), // strip trailing `:`
    host: urlObj.hostname,
    path: fullPath,
  };
}

// ---------------------------------------------------------------------------
// Host matching
// ---------------------------------------------------------------------------

/**
 * Match a URL host against a pattern host.
 *
 * Rules:
 *   - `*` matches any host.
 *   - `*.example.com` matches any single-level subdomain (e.g. `foo.example.com`).
 *   - Exact host match is required when the pattern host has no `*`.
 *
 * @param {string} patternHost
 * @param {string} urlHost
 * @returns {boolean}
 */
function matchHost(patternHost, urlHost) {
  if (patternHost === "*") {
    return true;
  }

  // Subdomain wildcard: `*.example.com` matches `foo.example.com` but NOT `example.com`.
  if (patternHost.startsWith("*.")) {
    const suffix = patternHost.slice(1); // strip `*` → `.example.com`
    // urlHost must end with `.example.com` AND have something before the dot.
    return urlHost.endsWith(suffix) && urlHost.slice(0, urlHost.length - suffix.length) !== "";
  }

  // Exact host match (no wildcards).
  return patternHost === urlHost;
}

// ---------------------------------------------------------------------------
// Path matching
// ---------------------------------------------------------------------------

/**
 * Match a URL path against a pattern path segment-by-segment.
 *
 * `*` segments match any corresponding URL segment.
 * Non-wildcard segments require an exact character-by-character match.
 *
 * @param {string} patternPath
 * @param {string} urlPath
 * @returns {boolean}
 */
function matchPath(patternPath, urlPath) {
  if (patternPath === "*") {
    return true;
  }

  const patternSegments = patternPath.split("/");
  const urlSegments = urlPath.split("/");

  for (let i = 0; i < patternSegments.length; i++) {
    const ps = patternSegments[i];
    const us = urlSegments[i];

    // Pattern segment ended but URL still has segments — no match.
    if (ps === undefined) {
      return false;
    }

    // Wildcard segment matches anything.
    if (ps === "*") {
      continue;
    }

    // Exact character match required.
    if (ps !== us) {
      return false;
    }
  }

  // URL must not have extra trailing segments beyond the pattern.
  return urlSegments.length <= patternSegments.length;
}
