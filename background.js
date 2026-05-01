function deriveFileName(url) {
  try { return new URL(url).pathname.split("/").pop() || "document.pdf"; }
  catch { return "document.pdf"; }
}

/* ─── declarativeNetRequest rule for PDF tab interception ─── */
const PDF_INTERCEPT_RULE = {
  id: 1,
  priority: 1,
  action: {
    type: "redirect",
    redirect: { regexSubstitution: chrome.runtime.getURL("editor.html") + "?src=\\0" },
  },
  condition: {
    // matches http(s) URLs ending in .pdf or .pdf?...  (main frame only)
    regexFilter: "^https?://.+\\.pdf(\\?.*)?$",
    resourceTypes: ["main_frame"],
  },
};

async function enablePdfInterception() {
  await chrome.declarativeNetRequest.updateDynamicRules({
    addRules: [PDF_INTERCEPT_RULE],
    removeRuleIds: [],
  });
  await chrome.storage.local.set({ pdfInterceptionEnabled: true });
}

async function disablePdfInterception() {
  await chrome.declarativeNetRequest.updateDynamicRules({
    addRules: [],
    removeRuleIds: [1],
  });
  await chrome.storage.local.set({ pdfInterceptionEnabled: false });
}

// Ensure interception is off by default on install/update
chrome.runtime.onInstalled.addListener(() => {
  disablePdfInterception();
});

/* ─── Message handler ─── */
chrome.runtime.onMessage.addListener((msg, _sender, _sendResponse) => {
  if (msg.type === "SET_PDF_INTERCEPTION") {
    (msg.enabled ? enablePdfInterception() : disablePdfInterception());
    return false;
  }

  if (msg.type === "FETCH_AND_STORE_PDF") {
    (async () => {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 30000);
        const res = await fetch(msg.url, { signal: controller.signal });
        clearTimeout(timer);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = await res.arrayBuffer();
        const key = "pdf_" + Date.now();
        // chrome.storage cannot serialize Uint8Array — store as plain array
        await chrome.storage.session.set({
          [key]: { bytes: Array.from(new Uint8Array(buf)), fileName: deriveFileName(msg.url) },
        });
        chrome.tabs.create({ url: chrome.runtime.getURL("editor.html") + "?pdfKey=" + key });
      } catch {
        // CORS or network failure — open editor without preload
        chrome.tabs.create({ url: chrome.runtime.getURL("editor.html") });
      }
    })();
    return true;
  }

  return false;
});
