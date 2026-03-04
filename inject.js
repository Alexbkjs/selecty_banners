// Runs in MAIN world on admin.shopify.com
// Hooks window.fetch to capture CSRF token, operation hash, and store name
(function () {
  const origFetch = window.fetch;

  function extractFromUrl(url) {
    const re =
      /\/api\/operations\/([^\/]+)\/GenerateSessionToken\/shopify\/([^\/]+)/;
    const match = url.match(re);
    if (!match) return null;
    return { hash: match[1], store: match[2] };
  }

  window.fetch = async function (resource, config = {}) {
    const url = typeof resource === "string" ? resource : resource.url;

    // Capture CSRF token from any request that carries one
    const token =
      config?.headers?.["X-CSRF-Token"] ||
      config?.headers?.["x-csrf-token"];
    if (token) {
      window.postMessage({ type: "selecty-csrf-token", token }, "*");
    }

    // Capture hash + store name from GenerateSessionToken calls
    const details = extractFromUrl(url);
    if (details) {
      window.postMessage(
        {
          type: "selecty-session-details",
          hash: details.hash,
          store: details.store,
        },
        "*"
      );
    }

    return origFetch.apply(this, arguments);
  };
})();
