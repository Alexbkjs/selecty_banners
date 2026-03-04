// Runs in ISOLATED world on admin.shopify.com
// Bridges postMessage from inject.js (MAIN world) to chrome.runtime
// Also handles getToken requests from the side panel

// ─── Bridge: page context → extension ───────────────
window.addEventListener("message", (e) => {
  if (e.source !== window) return;

  if (e.data?.type === "selecty-csrf-token") {
    chrome.runtime.sendMessage({ type: "csrf-token", token: e.data.token });
    console.log("[Selecty] CSRF token captured");
  }

  if (e.data?.type === "selecty-session-details") {
    chrome.runtime.sendMessage({
      type: "session-details",
      hash: e.data.hash,
      store: e.data.store,
    });
    console.log("[Selecty] Session details captured:", e.data.store);
  }
});

// ─── Handle getToken requests from side panel ───────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "get-token") {
    getToken(msg.hash, msg.store, msg.csrfToken)
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }
});

async function getToken(hash, store, csrfToken) {
  const url = `https://admin.shopify.com/api/operations/${hash}/GenerateSessionToken/shopify/${store}`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "x-csrf-token": csrfToken,
    },
    body: JSON.stringify({
      operationName: "GenerateSessionToken",
      variables: { appId: "gid://shopify/App/6102499" },
    }),
  });

  if (!response.ok) {
    throw new Error(`Token request failed: HTTP ${response.status}`);
  }

  const data = await response.json();
  const idToken = data?.data?.adminGenerateSession?.session;

  if (!idToken) {
    throw new Error("Could not extract session token from response");
  }

  console.log("[Selecty] Session token obtained");
  return { success: true, idToken };
}
