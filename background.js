// Auto-open GoldenTab in new windows
chrome.windows.onCreated.addListener(async (window) => {
  // Only normal windows, skip incognito
  if (window.type !== 'normal' || window.incognito) return;

  await chrome.tabs.create({
    windowId: window.id,
    url: 'bookmarks.html',
    pinned: true,
    index: 0
  });
});

chrome.action.onClicked.addListener(async (tab) => {
  const extensionUrl = chrome.runtime.getURL('bookmarks.html');
  const windowId = tab.windowId;

  // Check if bookmarks.html already open in this window
  const tabs = await chrome.tabs.query({ windowId });
  const existingTab = tabs.find(t => t.url === extensionUrl || t.url?.startsWith(extensionUrl));

  if (existingTab) {
    // Already open - tell it to open companion panel
    chrome.tabs.sendMessage(existingTab.id, { action: 'openCompanion' });
  } else {
    // Not open - create pinned tab at far left
    await chrome.tabs.create({
      url: 'bookmarks.html',
      pinned: true,
      index: 0
    });
  }
});
