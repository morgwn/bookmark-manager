chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: 'bookmarks.html' });
});
