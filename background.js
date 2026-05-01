function deriveFileName(url) {
  try { return new URL(url).pathname.split("/").pop() || "document.pdf"; }
  catch { return "document.pdf"; }
}

chrome.runtime.onMessage.addListener((msg, _sender, _sendResponse) => {
  if (msg.type !== "FETCH_AND_STORE_PDF") return false;
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
});
