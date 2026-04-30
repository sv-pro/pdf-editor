'use strict';

const EDITOR_URL = chrome.runtime.getURL('editor/editor.html');

// ── Load saved settings ──────────────────────────────────────────────────────
chrome.storage.sync.get({ autoOpen: false }, ({ autoOpen }) => {
  document.getElementById('toggle-auto-open').checked = autoOpen;
});

// ── Check active tab for a PDF URL ───────────────────────────────────────────
chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
  if (tab && isPdfUrl(tab.url)) {
    document.getElementById('pdf-section').classList.remove('hidden');
    document.getElementById('no-pdf-section').classList.add('hidden');

    document.getElementById('btn-edit').addEventListener('click', () => {
      chrome.runtime.sendMessage(
        { type: 'OPEN_IN_EDITOR', tabId: tab.id, url: tab.url },
        () => window.close()
      );
    });
  }
});

// ── Open local file ──────────────────────────────────────────────────────────
const fileInput = document.getElementById('file-input');
document.getElementById('btn-open-file').addEventListener('click', () => fileInput.click());

fileInput.addEventListener('change', async () => {
  const file = fileInput.files[0];
  if (!file) return;

  // Read file as data URL and open the editor in a new tab, embedding the data.
  const reader = new FileReader();
  reader.onload = () => {
    const dataUrl = reader.result;
    chrome.tabs.create({ url: `${EDITOR_URL}?url=${encodeURIComponent(dataUrl)}` });
    window.close();
  };
  reader.readAsDataURL(file);
});

// ── Auto-open toggle ─────────────────────────────────────────────────────────
document.getElementById('toggle-auto-open').addEventListener('change', (e) => {
  chrome.storage.sync.set({ autoOpen: e.target.checked });
});

// ── Helpers ──────────────────────────────────────────────────────────────────
function isPdfUrl(url) {
  if (!url) return false;
  try {
    return new URL(url).pathname.toLowerCase().endsWith('.pdf');
  } catch {
    return false;
  }
}
