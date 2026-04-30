document.getElementById('open-editor').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('editor.html') });
  window.close();
});
