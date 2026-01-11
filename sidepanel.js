//==========================================
// SIDE PANEL
// Lightweight workspace & tabs viewer
//==========================================

let workspaces = [];
let activeWorkspaceId = null;
let currentTabs = [];
let targetWindowId = null; // Window to show tabs for (null = current window)

//------------------------------------------
// Initialization
//------------------------------------------
document.addEventListener('DOMContentLoaded', async () => {
  // Check if opened as floating window with specific window target
  const params = new URLSearchParams(window.location.search);
  const windowIdParam = params.get('windowId');
  if (windowIdParam) {
    targetWindowId = parseInt(windowIdParam);
  } else {
    // Side panel - get current window
    const win = await chrome.windows.getCurrent();
    targetWindowId = win.id;
  }

  await loadWorkspaces();
  await loadActiveWorkspace();
  await loadTabs();
  render();
  setupListeners();
});

//------------------------------------------
// Data Loading
//------------------------------------------
async function loadWorkspaces() {
  // Get all bookmarks and find workspace folders
  const tree = await chrome.bookmarks.getTree();
  workspaces = [];
  findWorkspaces(tree[0]);
}

function findWorkspaces(node) {
  if (node.children) {
    // Check if this folder is a workspace
    if (node.title && node.title.includes('{') && node.title.includes('workspace')) {
      const displayTitle = node.title.replace(/\s*\{[^}]*\}$/, '');
      workspaces.push({
        id: node.id,
        title: displayTitle
      });
    }
    // Recurse into children
    for (const child of node.children) {
      findWorkspaces(child);
    }
  }
}

async function loadActiveWorkspace() {
  const storageKey = `activeWorkspaceId_${targetWindowId}`;
  const result = await chrome.storage.local.get(storageKey);
  activeWorkspaceId = result[storageKey] || null;
}

async function loadTabs() {
  currentTabs = await chrome.tabs.query({ windowId: targetWindowId });
  // Filter out chrome://, extension pages, and tabs without URLs
  currentTabs = currentTabs.filter(tab =>
    tab.url &&
    !tab.url.startsWith('chrome://') &&
    !tab.url.startsWith('chrome-extension://')
  );
}

//------------------------------------------
// Rendering
//------------------------------------------
function render() {
  renderWorkspaces();
  renderTabs();
}

function renderWorkspaces() {
  const container = document.getElementById('workspaceList');

  if (workspaces.length === 0) {
    container.innerHTML = '<div class="empty">No workspaces found</div>';
    return;
  }

  let html = `<div class="workspace-item all-bookmarks${!activeWorkspaceId ? ' active' : ''}" data-id="">All Bookmarks</div>`;

  html += workspaces.map(ws => {
    const activeClass = ws.id === activeWorkspaceId ? ' active' : '';
    return `<div class="workspace-item${activeClass}" data-id="${ws.id}">${ws.title}</div>`;
  }).join('');

  container.innerHTML = html;

  // Attach double-click handlers (matches main UI)
  container.querySelectorAll('.workspace-item').forEach(el => {
    el.addEventListener('dblclick', () => selectWorkspace(el.dataset.id || null));
  });
}

function renderTabs() {
  const container = document.getElementById('tabList');

  if (currentTabs.length === 0) {
    container.innerHTML = '<div class="empty">No tabs open</div>';
    return;
  }

  const html = currentTabs.map(tab => {
    const favicon = tab.favIconUrl || `chrome-extension://${chrome.runtime.id}/_favicon/?pageUrl=${encodeURIComponent(tab.url)}&size=16`;
    const title = tab.title || tab.url;
    const activeClass = tab.active ? ' active' : '';
    return `
      <div class="tab-item${activeClass}" data-tab-id="${tab.id}">
        <img class="favicon" src="${favicon}" alt="">
        <span class="tab-title">${escapeHtml(title)}</span>
      </div>
    `;
  }).join('');

  container.innerHTML = html;

  // Attach click handlers
  container.querySelectorAll('.tab-item').forEach(el => {
    el.addEventListener('click', () => {
      const tabId = parseInt(el.dataset.tabId);
      chrome.tabs.update(tabId, { active: true });
    });
  });
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

//------------------------------------------
// Actions
//------------------------------------------
async function selectWorkspace(workspaceId) {
  // Save current active tab for the workspace we're leaving
  await saveActiveTabForWorkspace();

  activeWorkspaceId = workspaceId;
  const storageKey = `activeWorkspaceId_${targetWindowId}`;
  await chrome.storage.local.set({ [storageKey]: workspaceId });
  render();

  // Restore active tab for the workspace we're entering
  await restoreActiveTabForWorkspace(workspaceId);
}

async function saveActiveTabForWorkspace() {
  if (!activeWorkspaceId) return;

  const [activeTab] = await chrome.tabs.query({ windowId: targetWindowId, active: true });

  if (activeTab && activeTab.url) {
    const result = await chrome.storage.local.get('workspaceActiveTabs');
    const workspaceActiveTabs = result.workspaceActiveTabs || {};
    workspaceActiveTabs[activeWorkspaceId] = activeTab.url;
    await chrome.storage.local.set({ workspaceActiveTabs });
  }
}

async function restoreActiveTabForWorkspace(workspaceId) {
  if (!workspaceId) return;

  const result = await chrome.storage.local.get('workspaceActiveTabs');
  const workspaceActiveTabs = result.workspaceActiveTabs || {};
  const savedUrl = workspaceActiveTabs[workspaceId];

  if (!savedUrl) return;

  // Retry up to 10 times over 2 seconds
  const maxRetries = 10;
  const retryDelay = 200;

  for (let i = 0; i < maxRetries; i++) {
    const tabs = await chrome.tabs.query({ windowId: targetWindowId });
    const matchingTab = tabs.find(t => t.url === savedUrl);

    if (matchingTab) {
      await chrome.tabs.update(matchingTab.id, { active: true });
      return; // Success
    }

    // Wait before retry
    await new Promise(resolve => setTimeout(resolve, retryDelay));
  }
  // Gave up - tab not found after retries (graceful fail, no error)
}

//------------------------------------------
// Event Listeners
//------------------------------------------
function setupListeners() {
  // Open main bookmark manager
  document.getElementById('openMainBtn').addEventListener('click', () => {
    chrome.tabs.create({ url: 'bookmarks.html' });
  });

  // Listen for tab changes
  chrome.tabs.onCreated.addListener(refreshTabs);
  chrome.tabs.onRemoved.addListener(refreshTabs);
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.title || changeInfo.url) refreshTabs();
  });
  chrome.tabs.onActivated.addListener(refreshTabs);

  // Listen for bookmark changes (workspace might be added/removed)
  chrome.bookmarks.onCreated.addListener(refreshWorkspaces);
  chrome.bookmarks.onRemoved.addListener(refreshWorkspaces);
  chrome.bookmarks.onChanged.addListener(refreshWorkspaces);

  // Listen for storage changes (workspace switched from main page)
  chrome.storage.onChanged.addListener((changes, area) => {
    const storageKey = `activeWorkspaceId_${targetWindowId}`;
    if (area === 'local' && changes[storageKey]) {
      activeWorkspaceId = changes[storageKey].newValue || null;
      render();
    }
  });
}

async function refreshTabs() {
  await loadTabs();
  renderTabs();
}

async function refreshWorkspaces() {
  await loadWorkspaces();
  renderWorkspaces();
}
