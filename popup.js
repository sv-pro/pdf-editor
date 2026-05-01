function looksLikePdf(url) {
  if (!url) return false;
  if (/^(blob:|data:|chrome:|chrome-extension:|about:)/i.test(url)) return false;
  return /\.pdf(\?|$)/i.test(url);
}

document.getElementById("open-editor").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("editor.html") });
  window.close();
});

chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
  if (!tab || !looksLikePdf(tab.url)) return;
  const btn = document.getElementById("edit-this-pdf");
  btn.style.display = "";
  btn.addEventListener("click", () => {
    if (tab.url.startsWith("file://")) {
      // Service worker cannot fetch file:// URLs — open editor and let the
      // editor page fetch directly (works when "Allow access to file URLs"
      // is enabled in chrome://extensions for this extension)
      chrome.tabs.create({
        url: chrome.runtime.getURL("editor.html") + "?src=" + encodeURIComponent(tab.url),
      });
    } else {
      chrome.runtime.sendMessage({ type: "FETCH_AND_STORE_PDF", url: tab.url });
    }
    window.close();
  });
});

// Intercept toggle
const toggle = document.getElementById("intercept-toggle");

chrome.storage.local.get("pdfInterceptionEnabled", ({ pdfInterceptionEnabled }) => {
  toggle.checked = !!pdfInterceptionEnabled;
});

toggle.addEventListener("change", () => {
  chrome.runtime.sendMessage({ type: "SET_PDF_INTERCEPTION", enabled: toggle.checked });
});
