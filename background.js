// Service worker for PDF Editor extension
chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL('editor.html') });
});
