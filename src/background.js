/**
 * RequestID background service worker.
 *
 * Handles onboarding flow on install/upgrade and maintains
 * badge state so the toolbar icon warns when the required
 * request-id prefix has not been configured.
 */

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the current prefix from chrome.storage.local.
 * @returns {Promise<string>}
 */
async function getPrefix() {
  const result = await chrome.storage.local.get("prefix");
  return result.prefix ?? "";
}

// ---------------------------------------------------------------------------
// onInstalled — onboarding gate
// ---------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(async (details) => {
  const prefix = await getPrefix();

  // First install (or re-install after removal): show onboarding page.
  if (details.reason === "install" || details.reason === "update") {
    // If the user already configured a prefix, skip onboarding.
    if (prefix !== "") {
      return;
    }

    // Open the onboarding popup on the extension's own page so the user
    // can set their request-id prefix without navigating away from
    // RequestID.
    const onboardingUrl = chrome.runtime.getURL("src/onboarding.html");
    chrome.tabs.create({ url: onboardingUrl });
  }

  // After onboarding (or re-install with existing prefix), set the badge.
  updateBadge(prefix);
});

// ---------------------------------------------------------------------------
// Badge maintenance — warn when prefix is empty
// ---------------------------------------------------------------------------

/**
 * Update the extension badge to reflect configuration state.
 *
 * - prefix is empty  →  warning badge ("!")
 * - prefix is set    →  informational badge ("R")
 *
 * @param {string} prefix
 */
async function updateBadge(prefix) {
  if (!prefix || prefix.trim() === "") {
    await chrome.action.setBadgeText({ text: "!" });
    await chrome.action.setBadgeBackgroundColor({ color: "#FF6600" }); // orange warning
  } else {
    await chrome.action.setBadgeText({ text: "R" });
    await chrome.action.setBadgeBackgroundColor({ color: "#2196F3" }); // blue info
  }
}

// ---------------------------------------------------------------------------
// Runtime listeners — keep badge in sync after user changes settings
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.action === "prefixUpdated") {
    updateBadge(message.prefix ?? "").catch(() => {});
    sendResponse({ ok: true });
  }

  return true; // keep message port open for async sendResponse
});
