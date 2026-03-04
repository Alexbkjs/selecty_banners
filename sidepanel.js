// ─── State ───────────────────────────────────────────
let sessionData = null;
let selectedBannerId = null;
let exportAvailable = false;

// ─── DOM ─────────────────────────────────────────────
const statusBadge = document.getElementById("status-badge");
const storeRow = document.getElementById("store-row");
const storeNameEl = document.getElementById("store-name");
const btnExport = document.getElementById("btn-export");
const btnImport = document.getElementById("btn-import");
const bannerListEl = document.getElementById("banner-list");
const bannerCountEl = document.getElementById("banner-count");

// ─── Init ────────────────────────────────────────────
async function init() {
  const stored = await chrome.storage.local.get(["sessionData", "banners"]);
  sessionData = stored.sessionData || null;
  updateStatus();
  renderBanners(stored.banners || []);
  checkExportAvailable();

  // Re-check export when the user switches or loads tabs
  chrome.tabs.onActivated.addListener(() => {
    setTimeout(checkExportAvailable, 300);
  });
  chrome.tabs.onUpdated.addListener((_tabId, changeInfo) => {
    if (changeInfo.status === "complete") {
      setTimeout(checkExportAvailable, 500);
    }
  });

  // Live session updates from content scripts
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "csrf-token") {
      if (!sessionData) sessionData = {};
      sessionData.csrfToken = msg.token;
      updateStatus();
    }
    if (msg.type === "session-details") {
      if (!sessionData) sessionData = {};
      sessionData.hash = msg.hash;
      sessionData.store = msg.store;
      updateStatus();
    }
  });
}

// ─── Status ──────────────────────────────────────────
function updateStatus() {
  const connected = !!(
    sessionData?.csrfToken &&
    sessionData?.hash &&
    sessionData?.store
  );

  statusBadge.textContent = connected ? "Connected" : "Disconnected";
  statusBadge.className = `status-badge ${connected ? "connected" : "disconnected"}`;

  if (connected) {
    storeRow.style.display = "flex";
    storeNameEl.textContent = sessionData.store;
  } else {
    storeRow.style.display = "none";
  }

  updateButtonStates();
}

async function checkExportAvailable() {
  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (!tab?.id || !tab.url?.startsWith("http")) {
      exportAvailable = false;
      updateButtonStates();
      return;
    }

    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: "MAIN",
      func: () => !!(window.__selectors?.autodetect),
    });

    exportAvailable = results?.[0]?.result || false;
  } catch {
    exportAvailable = false;
  }
  updateButtonStates();
}

function updateButtonStates() {
  btnExport.disabled = !exportAvailable;
  btnImport.disabled = !(
    sessionData?.csrfToken &&
    sessionData?.hash &&
    sessionData?.store &&
    selectedBannerId
  );
}

// ─── Export ──────────────────────────────────────────
btnExport.addEventListener("click", async () => {
  btnExport.disabled = true;
  btnExport.textContent = "Exporting...";

  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (!tab?.id) throw new Error("No active tab");

    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: "MAIN",
      func: () => {
        const ad = window.__selectors?.autodetect;
        if (!ad) return null;
        // Structured clone via JSON to strip non-serialisable refs
        return JSON.parse(JSON.stringify({ design: ad.design, i18n: ad.i18n }));
      },
    });

    const data = results?.[0]?.result;
    if (!data) throw new Error("window.__selectors.autodetect not found");

    const { banners = [] } = await chrome.storage.local.get("banners");

    const sourceName = new URL(tab.url).hostname.replace(".myshopify.com", "");
    const banner = {
      id: Date.now().toString(),
      name: sourceName,
      exportedAt: new Date().toISOString(),
      sourceUrl: tab.url,
      design: data.design,
      i18n: data.i18n,
    };

    banners.push(banner);
    await chrome.storage.local.set({ banners });
    renderBanners(banners);
    showToast("Banner exported", "success");
  } catch (err) {
    showToast("Export failed: " + err.message, "error");
  } finally {
    btnExport.textContent = "Export";
    checkExportAvailable();
  }
});

// ─── Import ──────────────────────────────────────────
btnImport.addEventListener("click", async () => {
  if (!selectedBannerId) return showToast("Select a banner first", "error");

  btnImport.disabled = true;
  btnImport.textContent = "Importing...";

  try {
    const { banners = [] } = await chrome.storage.local.get("banners");
    const banner = banners.find((b) => b.id === selectedBannerId);
    if (!banner) throw new Error("Banner not found in library");

    // 1. Get a fresh session token by injecting into the admin tab directly
    //    (executeScript into MAIN world has page cookies → same-origin fetch works)
    const adminTabs = await chrome.tabs.query({
      url: "*://admin.shopify.com/*",
    });
    if (!adminTabs.length) throw new Error("Open Shopify admin first");

    const tokenResults = await chrome.scripting.executeScript({
      target: { tabId: adminTabs[0].id },
      world: "MAIN",
      func: async (hash, store, csrfToken) => {
        try {
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
          if (!response.ok) return { error: `HTTP ${response.status}` };
          const data = await response.json();
          const token = data?.data?.adminGenerateSession?.session;
          if (!token) return { error: "No session token in response" };
          return { idToken: token };
        } catch (e) {
          return { error: e.message };
        }
      },
      args: [sessionData.hash, sessionData.store, sessionData.csrfToken],
    });

    const tokenResult = tokenResults?.[0]?.result;
    if (!tokenResult || tokenResult.error) {
      throw new Error(tokenResult?.error || "Could not get session token");
    }
    const idToken = tokenResult.idToken;

    // 2. Fetch current autodetect data from the destination store
    const elementData = await fetchElementData(idToken, sessionData.store);

    // 3. Merge: overwrite design and i18n with the exported banner's values
    const merged = {
      ...elementData,
      design: banner.design,
      i18n: banner.i18n,
    };

    // 4. PUT save
    await saveElementData(idToken, sessionData.store, merged);
    showToast("Banner imported successfully", "success");
  } catch (err) {
    showToast("Import failed: " + err.message, "error");
  } finally {
    btnImport.textContent = "Import";
    updateButtonStates();
  }
});

// ─── API helpers ─────────────────────────────────────
async function fetchElementData(idToken, store) {
  const params = new URLSearchParams({
    embedded: "1",
    fullscreen: "1",
    id_token: idToken,
    locale: "en",
    shop: store,
    _data:
      "routes/_app+/_extension+/_store-connection+/_resources+/fullscreen.autodetect",
  });

  const res = await fetch(
    `https://selectors.devit.software/fullscreen/autodetect?${params}`,
    {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        Accept: "*/*",
        Authorization: `Bearer ${idToken}`,
        "X-Requested-With": "XMLHttpRequest",
      },
    }
  );

  if (!res.ok) throw new Error(`Fetch element data failed: HTTP ${res.status}`);

  const data = await res.json();
  // Response may wrap autodetect or return it directly
  return data.autodetect || data;
}

async function saveElementData(idToken, store, autodetectData) {
  const params = new URLSearchParams({
    embedded: "1",
    fullscreen: "1",
    id_token: idToken,
    locale: "en",
    shop: store,
    _data:
      "routes/_app+/_extension+/_store-connection+/_resources+/fullscreen.autodetect",
  });

  const res = await fetch(
    `https://selectors.devit.software/fullscreen/autodetect?${params}`,
    {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Accept: "*/*",
        Authorization: `Bearer ${idToken}`,
        "X-Requested-With": "XMLHttpRequest",
      },
      body: JSON.stringify({
        actionType: "save-autodetect",
        data: { autodetect: autodetectData },
      }),
    }
  );

  if (!res.ok) throw new Error(`Save failed: HTTP ${res.status}`);
  return res.json();
}

// ─── Render Banners ──────────────────────────────────
function renderBanners(banners) {
  bannerCountEl.textContent = banners.length;

  if (!banners.length) {
    bannerListEl.innerHTML =
      '<div class="empty-state">No banners saved yet.<br>Visit a store with Selecty and click Export.</div>';
    return;
  }

  bannerListEl.innerHTML = banners
    .map((b) => {
      const date = new Date(b.exportedAt).toLocaleDateString();
      const type = b.design?.type || "unknown";
      const selected = b.id === selectedBannerId;

      const bg = b.design?.colors?.background;
      const txt = b.design?.colors?.text;
      const acc = b.design?.colors?.accent;
      const bgC = bg ? `rgb(${bg.red},${bg.green},${bg.blue})` : "#fff";
      const txtC = txt ? `rgb(${txt.red},${txt.green},${txt.blue})` : "#000";
      const accC = acc ? `rgb(${acc.red},${acc.green},${acc.blue})` : "#333";

      return `
      <div class="banner-card${selected ? " selected" : ""}" data-id="${b.id}">
        <div class="banner-card-header">
          <span class="banner-name">${esc(b.name)}</span>
          <button class="banner-delete" data-delete="${b.id}" title="Delete">&times;</button>
        </div>
        <div class="banner-meta">
          <span>${esc(type)}</span>
          <span>${date}</span>
        </div>
        <div class="banner-preview">
          <div class="color-swatch" style="background:${bgC}" title="Background"></div>
          <div class="color-swatch" style="background:${txtC}" title="Text"></div>
          <div class="color-swatch" style="background:${accC}" title="Accent"></div>
        </div>
      </div>`;
    })
    .join("");

  // Selection
  bannerListEl.querySelectorAll(".banner-card").forEach((card) => {
    card.addEventListener("click", (e) => {
      if (e.target.closest("[data-delete]")) return;
      selectedBannerId =
        selectedBannerId === card.dataset.id ? null : card.dataset.id;
      renderBanners(banners);
      updateButtonStates();
    });
  });

  // Delete
  bannerListEl.querySelectorAll("[data-delete]").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const id = btn.dataset.delete;
      const { banners: stored = [] } = await chrome.storage.local.get(
        "banners"
      );
      const updated = stored.filter((b) => b.id !== id);
      await chrome.storage.local.set({ banners: updated });
      if (selectedBannerId === id) selectedBannerId = null;
      renderBanners(updated);
      updateButtonStates();
      showToast("Banner deleted", "info");
    });
  });
}

// ─── Toast ───────────────────────────────────────────
function showToast(message, type = "info") {
  document.querySelector(".toast")?.remove();
  const t = document.createElement("div");
  t.className = `toast ${type}`;
  t.textContent = message;
  document.body.appendChild(t);
  requestAnimationFrame(() => t.classList.add("show"));
  setTimeout(() => {
    t.classList.remove("show");
    setTimeout(() => t.remove(), 200);
  }, 3000);
}

// ─── Util ────────────────────────────────────────────
function esc(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

// ─── Start ───────────────────────────────────────────
init();
