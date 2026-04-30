'use strict';

const EDITOR_URL = chrome.runtime.getURL('editor/editor.html');

// Redirect PDF navigations to the built-in editor (when auto-open is enabled).
chrome.webNavigation.onBeforeNavigate.addListener(
  async (details) => {
    if (details.frameId !== 0) return;

    const { autoOpen } = await chrome.storage.sync.get({ autoOpen: false });
    if (!autoOpen) return;

    const url = details.url;
    if (isPdfUrl(url) && !url.startsWith(EDITOR_URL)) {
      await chrome.tabs.update(details.tabId, {
        url: buildEditorUrl(url),
      });
    }
  },
  { url: [{ schemes: ['http', 'https', 'file', 'ftp'] }] }
);

// Allow the popup to open a URL in the editor.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'OPEN_IN_EDITOR') {
    chrome.tabs.update(message.tabId, { url: buildEditorUrl(message.url) });
    sendResponse({ ok: true });
  }
});

function isPdfUrl(url) {
  try {
    const u = new URL(url);
    return u.pathname.toLowerCase().endsWith('.pdf');
  } catch {
    return false;
  }
}

function buildEditorUrl(pdfUrl) {
  return `${EDITOR_URL}?url=${encodeURIComponent(pdfUrl)}`;
}
