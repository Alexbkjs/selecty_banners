// Service worker: opens side panel and persists session data

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

// Persist session data received from content scripts
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "csrf-token") {
    chrome.storage.local.get("sessionData", ({ sessionData }) => {
      sessionData = sessionData || {};
      sessionData.csrfToken = msg.token;
      chrome.storage.local.set({ sessionData });
    });
  }

  if (msg.type === "session-details") {
    chrome.storage.local.get("sessionData", ({ sessionData }) => {
      sessionData = sessionData || {};
      sessionData.hash = msg.hash;
      sessionData.store = msg.store;
      chrome.storage.local.set({ sessionData });
    });
  }
});
