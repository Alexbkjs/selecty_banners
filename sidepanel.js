// ─── Constants ───────────────────────────────────────
const SUBTITLES = [
  "Let\u2019s get this show on the road.",
  "I\u2019ve had my coffee. Ready when you are.",
  "Hit me \u2014 what are we accomplishing today?",
  "Tell me what you need. I\u2019m all ears.",
  "Hey superstar, what\u2019s on the list?",
];

// ─── State ───────────────────────────────────────────
let sessionData = null;
let selectedBannerId = null;
let exportAvailable = false;
let exportMode = null; // "storefront" | "admin"

// ─── DOM ─────────────────────────────────────────────
const statusBadge = document.getElementById("status-badge");
const storeRow = document.getElementById("store-row");
const storeNameEl = document.getElementById("store-name");
const btnExport = document.getElementById("btn-export");
const btnImport = document.getElementById("btn-import");
const bannerListEl = document.getElementById("banner-list");
const bannerCountEl = document.getElementById("banner-count");
const subtitleEl = document.getElementById("subtitle");
const themeToggle = document.getElementById("theme-toggle");

// ─── Init ────────────────────────────────────────────
async function init() {
  // Theme
  const { theme } = await chrome.storage.local.get("theme");
  if (theme === "dark") document.body.classList.add("dark");

  // Background
  const { bgImage } = await chrome.storage.local.get("bgImage");
  applyBackground(bgImage || "none");

  // Subtitle (weekdays only, consistent per day)
  const now = new Date();
  const day = now.getDay();
  if (day >= 1 && day <= 5) {
    const seed = now.toISOString().slice(0, 10);
    let h = 0;
    for (let i = 0; i < seed.length; i++) h = ((h << 5) - h + seed.charCodeAt(i)) | 0;
    subtitleEl.textContent = SUBTITLES[Math.abs(h) % SUBTITLES.length];
  }

  // Data
  const stored = await chrome.storage.local.get(["sessionData", "banners"]);
  sessionData = stored.sessionData || null;
  updateStatus();
  renderBanners(stored.banners || []);
  checkExportAvailable();

  // Re-check export on tab changes
  chrome.tabs.onActivated.addListener(() => setTimeout(checkExportAvailable, 300));
  chrome.tabs.onUpdated.addListener((_id, info) => {
    if (info.status === "complete") setTimeout(checkExportAvailable, 500);
  });

  // Live session updates from content scripts
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "csrf-token") {
      if (!sessionData) sessionData = {};
      sessionData.csrfToken = msg.token;
      updateStatus();
      checkExportAvailable();
    }
    if (msg.type === "session-details") {
      if (!sessionData) sessionData = {};
      sessionData.hash = msg.hash;
      sessionData.store = msg.store;
      updateStatus();
      checkExportAvailable();
    }
  });
}

// ─── Theme Toggle ────────────────────────────────────
themeToggle.addEventListener("click", async () => {
  document.body.classList.toggle("dark");
  const isDark = document.body.classList.contains("dark");
  await chrome.storage.local.set({ theme: isDark ? "dark" : "light" });
});

// ─── Background Switcher ─────────────────────────────
document.getElementById("bg-switcher").addEventListener("change", async (e) => {
  const value = e.target.value;
  applyBackground(value);
  await chrome.storage.local.set({ bgImage: value });
});

function applyBackground(value) {
  if (value && value !== "none") {
    document.body.style.backgroundImage = `url('backgrounds/${value}')`;
  } else {
    document.body.style.backgroundImage = "none";
  }
  // Sync radio button state
  const radio = document.querySelector(`input[name="bg"][value="${value || "none"}"]`);
  if (radio) radio.checked = true;
}

// ─── Status ──────────────────────────────────────────
function updateStatus() {
  const connected = !!(sessionData?.csrfToken && sessionData?.hash && sessionData?.store);
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
  exportMode = null;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !tab.url?.startsWith("http")) {
      exportAvailable = false;
      updateButtonStates();
      return;
    }

    // 1. Check storefront: window.__selectors.autodetect
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: "MAIN",
        func: () => !!(window.__selectors?.autodetect),
      });
      if (results?.[0]?.result) {
        exportAvailable = true;
        exportMode = "storefront";
        updateButtonStates();
        return;
      }
    } catch {}

    // 2. Check admin: on admin.shopify.com with tokens captured
    if (
      tab.url.includes("admin.shopify.com") &&
      sessionData?.csrfToken &&
      sessionData?.hash &&
      sessionData?.store
    ) {
      exportAvailable = true;
      exportMode = "admin";
      updateButtonStates();
      return;
    }

    exportAvailable = false;
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

// ─── Get Token (shared helper) ───────────────────────
async function getAdminToken() {
  const adminTabs = await chrome.tabs.query({ url: "*://admin.shopify.com/*" });
  if (!adminTabs.length) throw new Error("Open Shopify admin first");

  const results = await chrome.scripting.executeScript({
    target: { tabId: adminTabs[0].id },
    world: "MAIN",
    func: async (hash, store, csrfToken) => {
      try {
        const url = `https://admin.shopify.com/api/operations/${hash}/GenerateSessionToken/shopify/${store}`;
        const r = await fetch(url, {
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
        if (!r.ok) return { error: `HTTP ${r.status}` };
        const data = await r.json();
        const token = data?.data?.adminGenerateSession?.session;
        return token ? { idToken: token } : { error: "No session token in response" };
      } catch (e) {
        return { error: e.message };
      }
    },
    args: [sessionData.hash, sessionData.store, sessionData.csrfToken],
  });

  const res = results?.[0]?.result;
  if (!res || res.error) throw new Error(res?.error || "Could not get session token");
  return res.idToken;
}

// ─── Export ──────────────────────────────────────────
btnExport.addEventListener("click", async () => {
  btnExport.disabled = true;
  const origHTML = btnExport.innerHTML;
  btnExport.querySelector("span").textContent = "Exporting...";

  try {
    let data;

    if (exportMode === "storefront") {
      // Read from window.__selectors.autodetect
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) throw new Error("No active tab");
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: "MAIN",
        func: () => {
          const ad = window.__selectors?.autodetect;
          if (!ad) return null;
          return JSON.parse(JSON.stringify({ design: ad.design, i18n: ad.i18n }));
        },
      });
      data = results?.[0]?.result;
      if (!data) throw new Error("window.__selectors.autodetect not found");
    } else if (exportMode === "admin") {
      // Fetch via API
      const idToken = await getAdminToken();
      const elementData = await fetchElementData(idToken, sessionData.store);
      data = { design: elementData.design, i18n: elementData.i18n };
    } else {
      throw new Error("Export not available");
    }

    // Save to library
    const { banners = [] } = await chrome.storage.local.get("banners");
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const sourceName =
      exportMode === "admin"
        ? sessionData.store
        : new URL(tab.url).hostname.replace(".myshopify.com", "");

    const banner = {
      id: Date.now().toString(),
      name: sourceName,
      exportedAt: new Date().toISOString(),
      sourceUrl: tab?.url || "",
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
    btnExport.innerHTML = origHTML;
    checkExportAvailable();
  }
});

// ─── Import ──────────────────────────────────────────
btnImport.addEventListener("click", async () => {
  if (!selectedBannerId) return showToast("Select a banner first", "error");

  btnImport.disabled = true;
  const origHTML = btnImport.innerHTML;
  btnImport.querySelector("span").textContent = "Importing...";

  try {
    const { banners = [] } = await chrome.storage.local.get("banners");
    const banner = banners.find((b) => b.id === selectedBannerId);
    if (!banner) throw new Error("Banner not found in library");

    const idToken = await getAdminToken();
    const elementData = await fetchElementData(idToken, sessionData.store);
    const merged = { ...elementData, design: banner.design, i18n: banner.i18n };

    await saveElementData(idToken, sessionData.store, merged);
    showToast("Banner imported successfully", "success");
  } catch (err) {
    showToast("Import failed: " + err.message, "error");
  } finally {
    btnImport.innerHTML = origHTML;
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
    _data: "routes/_app+/_extension+/_store-connection+/_resources+/fullscreen.autodetect",
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
  return data.autodetect || data;
}

async function saveElementData(idToken, store, autodetectData) {
  const params = new URLSearchParams({
    embedded: "1",
    fullscreen: "1",
    id_token: idToken,
    locale: "en",
    shop: store,
    _data: "routes/_app+/_extension+/_store-connection+/_resources+/fullscreen.autodetect",
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

// ─── Preview Builder ─────────────────────────────────
function buildPreviewHTML(design, i18n) {
  const bg = design.colors?.background;
  const bgColor = bg ? `rgba(${bg.red},${bg.green},${bg.blue},${bg.alpha ?? 1})` : "#fff";
  const txt = design.colors?.text;
  const textColor = txt ? `rgba(${txt.red},${txt.green},${txt.blue},${txt.alpha ?? 1})` : "#333";

  const resource = design.resource || "markets";
  const { header, body } = parseI18nHTML(getI18nForResource(resource, i18n));
  const buttonLabel = i18n?.original?.button || "Continue";

  const titleFont = design.typography?.title?.fontFamily || "sans-serif";
  const titleSize = design.typography?.title?.size?.value || 18;
  const titleWeight = design.typography?.title?.fontWeight || "bold";
  const bodyFont = design.typography?.default?.fontFamily || "sans-serif";
  const bodySize = design.typography?.default?.size?.value || 14;

  const btn = design.primaryButtonStyle;
  const btnBg = btn?.colors?.backgroundColor || "#202223";
  const btnFg = btn?.colors?.color || "#ffffff";
  const btnR = btn?.border?.radius;
  const btnRadius = btnR
    ? `${btnR.topLeft}px ${btnR.topRight}px ${btnR.bottomRight}px ${btnR.bottomLeft}px`
    : "4px";

  const br = design.border?.radius;
  const borderRadius = br
    ? `${br.topLeft}px ${br.topRight}px ${br.bottomRight}px ${br.bottomLeft}px`
    : "0";

  const sideImg = design.sideImage;
  const hasSideImg = !!(sideImg?.url);
  const imgPos = sideImg?.position || "left";

  const resourceList = (design.resourceList || []).filter(Boolean);
  const labels =
    resourceList.length > 0
      ? resourceList.map((r) => i18n?.original?.[`${r}_label`] || r)
      : [i18n?.original?.[`${resource}_label`] || resource];

  const previewW = hasSideImg ? 400 : 300;

  const dropdownsHTML = labels
    .map(
      (l) =>
        `<div style="flex:1;min-width:0">` +
        `<div style="font-size:10px;color:${textColor};opacity:0.5;margin-bottom:3px">${esc(l)}</div>` +
        `<div style="background:rgba(128,128,128,0.1);padding:5px 8px;border-radius:3px;font-size:10px;color:${textColor};opacity:0.7;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">Select &#9662;</div>` +
        `</div>`
    )
    .join("");

  const contentHTML =
    `<div style="padding:14px;flex:1;min-width:0">` +
    (design.showFlag
      ? `<div style="text-align:center;margin-bottom:8px"><div style="display:inline-block;width:20px;height:14px;background:linear-gradient(90deg,#002395 33%,#fff 33%,#fff 66%,#ed2939 66%);border-radius:2px"></div></div>`
      : "") +
    `<div style="font-family:${titleFont},sans-serif;font-size:${titleSize}px;font-weight:${titleWeight};color:${textColor};margin-bottom:5px;line-height:1.25">${esc(header)}</div>` +
    `<div style="font-family:${bodyFont},sans-serif;font-size:${bodySize}px;color:${textColor};opacity:0.7;margin-bottom:10px;line-height:1.35">${esc(body)}</div>` +
    `<div style="display:flex;gap:6px;margin-bottom:10px">${dropdownsHTML}</div>` +
    `<div style="display:${hasSideImg ? "inline-block" : "block"};text-align:center;padding:7px 14px;background:${btnBg};color:${btnFg};border-radius:${btnRadius};font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.3px">${esc(buttonLabel)}</div>` +
    `</div>`;

  let html;
  if (hasSideImg) {
    const imgHTML = `<div style="width:38%;min-height:160px;background:url('${sideImg.url}') center/cover no-repeat;flex-shrink:0"></div>`;
    html =
      `<div style="display:flex;width:${previewW}px;background:${bgColor};border-radius:${borderRadius};overflow:hidden">` +
      (imgPos === "left" ? imgHTML + contentHTML : contentHTML + imgHTML) +
      `</div>`;
  } else {
    html = `<div style="width:${previewW}px;background:${bgColor};border-radius:${borderRadius};overflow:hidden">${contentHTML}</div>`;
  }

  return { html, width: previewW };
}

function getI18nForResource(resource, i18n) {
  const orig = i18n?.original || {};
  if (orig[resource]) return orig[resource];
  const parts = resource.split("_");
  for (let len = parts.length - 1; len >= 1; len--) {
    const key = parts.slice(0, len).join("_");
    if (orig[key]) return orig[key];
  }
  return orig.markets || orig.countries || orig.languages || "";
}

function parseI18nHTML(html) {
  if (!html) return { header: "", body: "" };
  const doc = new DOMParser().parseFromString(html, "text/html");
  const headerEl = doc.querySelector(".adt-content__header");
  const textEl = doc.querySelector(".adt-content__text");
  if (headerEl || textEl) {
    return { header: headerEl?.textContent || "", body: textEl?.textContent || "" };
  }
  return { header: doc.body.textContent || "", body: "" };
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

      // Build preview
      const preview = buildPreviewHTML(b.design || {}, b.i18n || {});
      const thumbScale = 105 / preview.width;

      return `
      <div class="banner-card${selected ? " selected" : ""}" data-id="${b.id}">
        <div class="banner-card-header">
          <span class="banner-name">${esc(b.name)}</span>
          <button class="banner-delete" data-delete="${b.id}" title="Delete">&times;</button>
        </div>
        <div class="banner-card-body">
          <div class="banner-thumb">
            <div class="banner-thumb-inner" style="transform:scale(${thumbScale.toFixed(4)})">${preview.html}</div>
          </div>
          <div class="banner-info">
            <div class="banner-meta">
              <span>${esc(type)}</span>
              <span>${date}</span>
            </div>
            <div class="banner-colors">
              <div class="color-swatch" style="background:${bgC}" title="Background"></div>
              <div class="color-swatch" style="background:${txtC}" title="Text"></div>
              <div class="color-swatch" style="background:${accC}" title="Accent"></div>
            </div>
          </div>
        </div>
      </div>`;
    })
    .join("");

  // Selection
  bannerListEl.querySelectorAll(".banner-card").forEach((card) => {
    card.addEventListener("click", (e) => {
      if (e.target.closest("[data-delete]")) return;
      selectedBannerId = selectedBannerId === card.dataset.id ? null : card.dataset.id;
      renderBanners(banners);
      updateButtonStates();
    });
  });

  // Delete
  bannerListEl.querySelectorAll("[data-delete]").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const id = btn.dataset.delete;
      const { banners: stored = [] } = await chrome.storage.local.get("banners");
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
