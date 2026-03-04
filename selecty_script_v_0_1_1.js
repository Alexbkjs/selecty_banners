// ==UserScript==
// @name         Selecty_v0.2
// @namespace    http://tampermonkey.net/
// @version      2026-03-03
// @description  try to take over the world!
// @author       You
// @match        *://admin.shopify.com/*
// @match        *://selectors.devit.software/*
// @match        *://cdn.selecty.devit.software/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM.xmlHttpRequest
// ==/UserScript==

 (async function() {
    'use strict';

    (function injectFetchHook() {
    const s = document.createElement("script");
    s.textContent = `
        (function(){
            const origFetch = window.fetch;

            function extractFromUrl(url) {
                // Matches: /api/operations/<HASH>/GenerateSessionToken/shopify/<STORE>
                const re = /\\/api\\/operations\\/([^\\/]+)\\/GenerateSessionToken\\/shopify\\/([^\\/]+)/;
                const match = url.match(re);
                if (!match) return null;
                return {
                    hash: match[1],
                    store: match[2]
                };
            }

            window.fetch = async function(resource, config = {}) {
                const url = typeof resource === "string" ? resource : resource.url;

                // ---- 1. Capture CSRF token ----
                const token =
                    config?.headers?.["X-CSRF-Token"] ||
                    config?.headers?.["x-csrf-token"];

                if (token) {
                    window.postMessage({
                        type: "csrf-token",
                        token
                    }, "*");
                }

                // ---- 2. Capture Hash + Store Name ----
                const details = extractFromUrl(url);
                if (details) {
                    window.postMessage({
                        type: "shopify-session-details",
                        hash: details.hash,
                        store: details.store
                    }, "*");
                }

                return origFetch(resource, config);
            };
        })();
    `;
    document.documentElement.appendChild(s);
    s.remove();
})();


    /*** ---------------------------------------------------------
 * 2. Listen for token coming from page context
 * --------------------------------------------------------- */
let csrfToken = null;
let shopHash = null;
let shopName = null;

window.addEventListener("message", (e) => {
    // CSRF TOKEN
    if (e.data?.type === "csrf-token") {
        csrfToken = e.data.token;
        GM_setValue("csrfToken", csrfToken);
        console.log("💠 CSRF Token:", csrfToken);
    }

    // HASH + STORE NAME
    if (e.data?.type === "shopify-session-details") {
        shopHash = e.data.hash;
        shopName = e.data.store;

        GM_setValue("shopHash", shopHash);
        GM_setValue("shopName", shopName);

        console.log("💠 Shopify hash:", shopHash);
        console.log("💠 Shopify store:", shopName);
    }
});

        const CSRF_TOKEN = GM_getValue("csrfToken");
    const SHOP = GM_getValue("shopName");
    const HASH = GM_getValue("shopHash");

    async function getToken() {
        const sessionTokenUrl = `https://admin.shopify.com/api/operations/${HASH}/GenerateSessionToken/shopify/${SHOP}`;

        const payload = JSON.stringify({
            operationName: 'GenerateSessionToken',
            variables: {
                appId: 'gid://shopify/App/6102499', // Selecty ID 6102499
            },
        });

        console.log('[Tampermonkey] Requesting Shopify session token...');

        const response = await new Promise((resolve, reject) => {
            GM.xmlHttpRequest({
                method: 'POST',
                url: sessionTokenUrl,
                headers: {
                    Accept: 'application/json',
                    'Content-Type': 'application/json',
                    'x-csrf-token': CSRF_TOKEN,
                },
                data: payload,
                onload: function (res) {
                    try {
                        if (res.status >= 200 && res.status < 300) {
                            const data = JSON.parse(res.responseText);
                            resolve(data);
                        } else {
                            console.error('[Tampermonkey] HTTP Error:', res.status, res.statusText);
                            reject(new Error(`HTTP ${res.status}`));
                        }
                    } catch (err) {
                        console.error('[Tampermonkey] Parse Error:', err);
                        reject(err);
                    }
                },
                onerror: function (err) {
                    console.error('[Tampermonkey] Network Error:', err);
                    reject(err);
                },
            });
        });

        const idToken = response?.data?.adminGenerateSession?.session;
        if (!idToken) {
            console.error('[Tampermonkey] ❌ Could not extract session token.');
            return null;
        }
        console.log('💠✅ Got session token for Selecty app:', idToken.substring(0, 20) + '...');
        return idToken;
    };
    const idToken = await getToken();
    // console.log(idToken, '💠idToken')
    // console.log(JSON.stringify(idToken), '💠idToken2')

     async function fetchElementData(idToken) {
                  console.log(`💠https://selectors.devit.software/fullscreen/autodetect?embedded=1&fullscreen=1&id_token=${idToken}&locale=en&shop=${SHOP}&_data=routes%2F_app%2B%2F_extension%2B%2F_store-connection%2B%2F_resources%2B%2Ffullscreen.autodetect`)

        return new Promise((resolve, reject) => {
            GM.xmlHttpRequest({
                method: "GET",
                url: `https://selectors.devit.software/fullscreen/autodetect?embedded=1&fullscreen=1&id_token=${idToken}&locale=en&shop=${SHOP}&_data=routes%2F_app%2B%2F_extension%2B%2F_store-connection%2B%2F_resources%2B%2Ffullscreen.autodetect`,
                headers: {
                    "Content-Type": "application/json",
                    "Accept": "*/*",
                    "Authorization": `Bearer ${idToken}`,
                    "Referer": `https://selectors.devit.software/fullscreen/autodetect?embedded=1&fullscreen=1&shop=${SHOP}.myshopify.com`,
                    "Origin": "https://selectors.devit.software",
                    "X-Requested-With": "XMLHttpRequest"
                },
                onload: function (res) {
                    try {
                        if (res.status >= 200 && res.status < 300) {
                            const data = JSON.parse(res.responseText);
                            console.log("💠✅ Element data received:", data);
                            resolve(data);
                        } else {
                            console.error("💠❌ Element fetch failed:", res.status);
                            reject(new Error(`HTTP ${res.status}`));
                        }
                    } catch (err) {
                        console.error("💠❌ Element parse error:", err);
                        reject(err);
                    }
                },
                onerror: function (err) {
                    console.error("💠❌ Element fetch failed:", err);
                    reject(err);
                }
            });
        });
    }

    fetchElementData(idToken);



})();