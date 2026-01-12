// State management
let reloadTimeout = null; // Debounce fix
let draggedElement = null;
let draggedBookmark = null;
let collapsedFolders = new Set();
let openTabUrls = new Set();
let openTabsMap = new Map();
let pendingFolderId = null;
let pendingOpenFolderId = null;
let pendingWorkspaceData = null;
let activeWorkspaceFolder = null; // Current workspace folder object when in workspace mode
let looseTabsResolve = null; // For loose tabs modal promise
let orderedTabs = []; // Tabs in browser order for Active Tabs folder
let allBookmarkUrls = new Set(); // All bookmark URLs for indicator dots
let workspaceBookmarkUrls = new Set(); // URLs in current workspace (for bright dot)
let bookmarkUrlLocations = new Map(); // URL → [{id, title, parentId, parentTitle}] (for multi-location indicator)
let pendingNoteData = null; // For note modal: {id, title, displayTitle, metadata}
let connectionSvg = null; // SVG overlay for drawing connection lines
const CLOSED_FOLDER_NAME = '.closed';
const MAX_CLOSED_TABS = 20;
const COMPANION_MODE = 'floating'; // 'floating', 'sidepanel', or 'none'
const AUTO_OPEN_FLOATING = true; // Auto-open floating window when GoldenTab loads
let pendingBookmarkTabs = new Map(); // Track tabs opened from bookmarks: tabId → originalUrl
let redirectedTabs = new Map(); // Tabs that redirected: tabId → originalUrl
let floatingWindowId = null; // Track floating window for repositioning
let mainWindowId = null; // Track main window to follow
let currentWindowId = null; // This window's ID for per-window workspace storage
let floatingWindowWasOpen = false; // Track if floating window was open before minimize
let floatingWindowCreatedAt = 0; // Debounce: don't close immediately after creating

//------------------------------------------------------------
// Filter Integration (uses FilterSystem from filters.js)
//------------------------------------------------------------

function toggleStarFilter() {
  const isActive = FilterSystem.toggleStarredOnly();
  const btn = document.getElementById('starFilterBtn');
  btn.classList.toggle('active', isActive);
  btn.textContent = isActive ? '★' : '☆';
  applyCurrentFilters();
}

async function applyCurrentFilters() {
  if (!FilterSystem.isActive()) {
    loadBookmarks();
    return;
  }

  const query = FilterSystem.config.searchQuery;

  // Get appropriate bookmark tree based on workspace mode
  let bookmarks;
  if (activeWorkspaceFolder) {
    const subtree = await chrome.bookmarks.getSubTree(activeWorkspaceFolder.id);
    bookmarks = [subtree[0]];
  } else {
    const tree = await chrome.bookmarks.getTree();
    bookmarks = tree[0].children;
  }

  if (query.trim()) {
    const results = await chrome.bookmarks.search(query);
    const matchingIds = new Set(results.map(r => r.id));
    const filtered = FilterSystem.apply(bookmarks, matchingIds);

    if (filtered.length === 0) {
      document.getElementById('bookmarkTree').innerHTML =
        '<div class="no-results">No bookmarks found</div>';
      return;
    }

    renderBookmarks(filtered);
  } else {
    const filtered = FilterSystem.apply(bookmarks);

    if (filtered.length === 0) {
      document.getElementById('bookmarkTree').innerHTML =
        '<div class="no-results">No starred bookmarks</div>';
      return;
    }

    renderBookmarks(filtered);
  }
}

async function toggleStarred(bookmarkId, currentTitle) {
  const parsed = FilterSystem.parseTitle(currentTitle);
  parsed.metadata.starred = !parsed.metadata.starred;
  const newTitle = FilterSystem.buildTitle(parsed.displayTitle, parsed.metadata);

  await chrome.bookmarks.update(bookmarkId, { title: newTitle });
  applyCurrentFilters();
}


// Initialize on page load
document.addEventListener('DOMContentLoaded', async () => {
  try {
    // Get current window ID for per-window workspace storage
    const win = await chrome.windows.getCurrent();
    currentWindowId = win.id;

    // Check for workspace param (from shift+dblclick new window)
    const urlParams = new URLSearchParams(window.location.search);
    const workspaceParam = urlParams.get('workspace');

    if (workspaceParam) {
      // Clear the URL param so refresh doesn't re-trigger
      history.replaceState({}, '', window.location.pathname);
      // Activate the workspace
      await activateWorkspace(workspaceParam);
    } else {
      activeWorkspaceFolder = await WorkspaceManager.getActiveWorkspaceFolder();
      updateWorkspaceUI();
      await loadOpenTabs();
      await loadBookmarks();
      renderActiveTabs();
    }

    setupEventListeners();
    setupModalListeners();
    setupTabListeners();
    setupConnectionLines();

    // Auto-open floating companion window
    if (COMPANION_MODE === 'floating' && AUTO_OPEN_FLOATING) {
      openCompanionPanel();
    }
  } catch (error) {
    console.error('DOMContentLoaded error:', error);
  }
});

// Setup event listeners
function setupEventListeners() {
  document.getElementById('refreshBtn').addEventListener('click', async () => {
    await loadOpenTabs();
    FilterSystem.reset();
    const starBtn = document.getElementById('starFilterBtn');
    starBtn.classList.remove('active');
    starBtn.textContent = '☆';
    document.getElementById('searchInput').value = '';
    await loadBookmarks();
    renderActiveTabs();
    renderWorkspaceSidebar();
  });

  document.getElementById('starFilterBtn').addEventListener('click', toggleStarFilter);

  document.getElementById('searchInput').addEventListener('input', (e) => {
    FilterSystem.setSearchQuery(e.target.value);
    applyCurrentFilters();
  });

  document.getElementById('closeWorkspaceBtn').addEventListener('click', deactivateWorkspace);

  document.getElementById('sortTabsBtn').addEventListener('click', sortTabsByWebsite);
  document.getElementById('dedupTabsBtn').addEventListener('click', closeDuplicateTabs);
  document.getElementById('dedupTabsBtn').addEventListener('mouseenter', previewDuplicateTabs);
  document.getElementById('dedupTabsBtn').addEventListener('mouseleave', clearDuplicatePreview);
  document.getElementById('closedTabsBtn').addEventListener('click', showClosedTabsMenu);
  const companionBtn = document.getElementById('companionBtn');
  if (COMPANION_MODE === 'none') {
    companionBtn.style.display = 'none';
  } else {
    companionBtn.addEventListener('click', openCompanionPanel);
    companionBtn.textContent = COMPANION_MODE === 'floating' ? '▢' : '◧';
    companionBtn.title = COMPANION_MODE === 'floating' ? 'Open Floating Window' : 'Open Side Panel';
  }

  // Listen for workspace changes from side panel
  chrome.storage.onChanged.addListener(handleStorageChange);

  // Listen for messages from background script
  chrome.runtime.onMessage.addListener((message) => {
    if (message.action === 'openCompanion' && COMPANION_MODE !== 'none') {
      openCompanionPanel();
    }
  });

  // Track floating window position relative to main window (only if using floating mode)
  if (COMPANION_MODE === 'floating') {
    chrome.windows.onBoundsChanged.addListener(handleWindowBoundsChanged);
    chrome.windows.onRemoved.addListener(handleWindowRemoved);
    document.addEventListener('visibilitychange', handleVisibilityChange);
  }

  // Active tabs panel accepts bookmark drops (for "past the end" drops)
  const activeTabsList = document.getElementById('activeTabsList');
  activeTabsList.addEventListener('dragover', (e) => {
    if (e.dataTransfer.types.includes('bookmark-url') && !e.target.closest('.tab-item')) {
      e.preventDefault();
      activeTabsList.classList.add('drag-over');
    }
  });
  activeTabsList.addEventListener('dragleave', (e) => {
    if (!activeTabsList.contains(e.relatedTarget)) {
      activeTabsList.classList.remove('drag-over');
    }
  });
  activeTabsList.addEventListener('drop', async (e) => {
    e.preventDefault();
    activeTabsList.classList.remove('drag-over');
    const bookmarkUrl = e.dataTransfer.getData('bookmark-url');
    if (bookmarkUrl) {
      await openBookmarkUrl(bookmarkUrl, false);
    }
  });
}

function setupModalListeners() {
  // Close modal buttons
  document.getElementById('closeRecursive').addEventListener('click', async () => {
    closeModal();
    if (pendingFolderId) {
      await closeFolderTabs(pendingFolderId, true);
      pendingFolderId = null;
    }
  });
  
  document.getElementById('closeLevel').addEventListener('click', async () => {
    closeModal();
    if (pendingFolderId) {
      await closeFolderTabs(pendingFolderId, false);
      pendingFolderId = null;
    }
  });
  
  document.getElementById('closeCancel').addEventListener('click', () => {
    closeModal();
    pendingFolderId = null;
  });
  
  document.getElementById('closeModal').addEventListener('click', (e) => {
    if (e.target.id === 'closeModal') {
      closeModal();
      pendingFolderId = null;
    }
  });
  
  // Open modal buttons
  document.getElementById('openRecursive').addEventListener('click', async () => {
    closeOpenModal();
    if (pendingOpenFolderId) {
      await openFolderBookmarks(pendingOpenFolderId, true);
      pendingOpenFolderId = null;
    }
  });
  
  document.getElementById('openLevel').addEventListener('click', async () => {
    closeOpenModal();
    if (pendingOpenFolderId) {
      await openFolderBookmarks(pendingOpenFolderId, false);
      pendingOpenFolderId = null;
    }
  });
  
  document.getElementById('openCancel').addEventListener('click', () => {
    closeOpenModal();
    pendingOpenFolderId = null;
  });
  
  document.getElementById('openModal').addEventListener('click', (e) => {
    if (e.target.id === 'openModal') {
      closeOpenModal();
      pendingOpenFolderId = null;
    }
  });

  // Workspace modal buttons
  document.getElementById('workspaceConfirm').addEventListener('click', async () => {
    await toggleWorkspace();
  });

  document.getElementById('workspaceCancel').addEventListener('click', () => {
    closeWorkspaceModal();
  });

  document.getElementById('workspaceModal').addEventListener('click', (e) => {
    if (e.target.id === 'workspaceModal') {
      closeWorkspaceModal();
    }
  });

  // Loose tabs modal buttons
  document.getElementById('looseTabsBringIn').addEventListener('click', () => {
    closeLooseTabsModal('bring-in');
  });

  document.getElementById('looseTabsDiscard').addEventListener('click', () => {
    closeLooseTabsModal('discard');
  });

  document.getElementById('looseTabsCancel').addEventListener('click', () => {
    closeLooseTabsModal('cancel');
  });

  document.getElementById('looseTabsModal').addEventListener('click', (e) => {
    if (e.target.id === 'looseTabsModal') {
      closeLooseTabsModal('cancel');
    }
  });

  // Note modal buttons
  document.getElementById('noteSave').addEventListener('click', async () => {
    if (pendingNoteData) {
      const noteText = document.getElementById('noteTextarea').value.substring(0, 250);
      pendingNoteData.metadata.note = noteText;
      const newTitle = FilterSystem.buildTitle(pendingNoteData.displayTitle, pendingNoteData.metadata);
      await chrome.bookmarks.update(pendingNoteData.id, { title: newTitle });
      closeNoteModal();
      applyCurrentFilters();
    }
  });

  document.getElementById('noteDelete').addEventListener('click', async () => {
    if (pendingNoteData) {
      pendingNoteData.metadata.note = '';
      const newTitle = FilterSystem.buildTitle(pendingNoteData.displayTitle, pendingNoteData.metadata);
      await chrome.bookmarks.update(pendingNoteData.id, { title: newTitle });
      closeNoteModal();
      applyCurrentFilters();
    }
  });

  document.getElementById('noteCancel').addEventListener('click', closeNoteModal);

  document.getElementById('noteModal').addEventListener('click', (e) => {
    if (e.target.id === 'noteModal') {
      closeNoteModal();
    }
  });

  // Note textarea character counter
  document.getElementById('noteTextarea').addEventListener('input', (e) => {
    const counter = document.getElementById('noteCharCount');
    const len = e.target.value.length;
    counter.textContent = `${len}/250`;
    counter.style.color = len > 250 ? '#ff6b6b' : '#8b8d94';
  });
}

//------------------------------------------
// Connection Lines
//------------------------------------------

function setupConnectionLines() {
  connectionSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  connectionSvg.id = 'connectionLines';
  connectionSvg.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:50';
  document.body.appendChild(connectionSvg);
}

// Generate a consistent color from a URL string (same URL = same color)
function urlToColor(url) {
  let hash = 0;
  for (let i = 0; i < url.length; i++) {
    hash = ((hash << 5) - hash) + url.charCodeAt(i);
    hash = hash & hash; // Convert to 32-bit integer
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 70%, 55%)`;
}

function drawConnections(folderId) {
  if (!connectionSvg) return;
  connectionSvg.innerHTML = '';

  // Get the divider position (right panel's left edge)
  const rightPanel = document.querySelector('.right-panel');
  const maxBookmarkX = rightPanel ? rightPanel.getBoundingClientRect().left - 25 : Infinity;

  // Find all visible bookmark items that are children of this folder
  const bookmarkItems = document.querySelectorAll(`.bookmark-item[data-parent-id="${folderId}"]`);

  bookmarkItems.forEach(bookmark => {
    // Skip if not visible (collapsed or hidden)
    const rect = bookmark.getBoundingClientRect();
    if (rect.height === 0 || rect.width === 0) return;

    const url = bookmark.dataset.url;
    if (!url) return;

    const normalizedUrl = normalizeUrl(url);

    // Find matching tab by exact normalized URL
    const matchingTab = [...document.querySelectorAll('.tab-item')].find(tab => {
      const tabUrl = tab.querySelector('.tab-title')?.title;
      return tabUrl && normalizeUrl(tabUrl) === normalizedUrl;
    });

    if (matchingTab) {
      const to = matchingTab.getBoundingClientRect();

      // Skip if tab not visible
      if (to.height === 0 || to.width === 0) return;

      // Get the title element to start line just after the title text
      const titleEl = bookmark.querySelector('.title');
      const titleRect = titleEl ? titleEl.getBoundingClientRect() : rect;

      // Get consistent color for this URL
      const lineColor = urlToColor(normalizedUrl);

      // Draw highlight rects behind matched rows (narrower, ending at line start)
      const bookmarkHighlight = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      const bookmarkEndX = Math.min(titleRect.right + 8, maxBookmarkX);
      bookmarkHighlight.setAttribute('x', rect.left);
      bookmarkHighlight.setAttribute('y', rect.top);
      bookmarkHighlight.setAttribute('width', bookmarkEndX - rect.left);
      bookmarkHighlight.setAttribute('height', rect.height);
      bookmarkHighlight.setAttribute('fill', lineColor);
      bookmarkHighlight.setAttribute('opacity', '0.15');
      connectionSvg.appendChild(bookmarkHighlight);

      const tabHighlight = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      tabHighlight.setAttribute('x', to.left);
      tabHighlight.setAttribute('y', to.top);
      tabHighlight.setAttribute('width', to.width);
      tabHighlight.setAttribute('height', to.height);
      tabHighlight.setAttribute('fill', lineColor);
      tabHighlight.setAttribute('opacity', '0.15');
      connectionSvg.appendChild(tabHighlight);

      // Draw curved bezier line from just after bookmark title to tab's left edge
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      const startX = Math.min(titleRect.right + 8, maxBookmarkX); // capped at divider
      const startY = rect.top + rect.height / 2;
      const endX = to.left;
      const endY = to.top + to.height / 2;

      // Control points for smooth S-curve
      const controlOffset = Math.min(100, Math.abs(endX - startX) / 2);

      path.setAttribute('d', `M${startX},${startY} C${startX + controlOffset},${startY} ${endX - controlOffset},${endY} ${endX},${endY}`);
      path.setAttribute('stroke', lineColor);
      path.setAttribute('stroke-width', '2');
      path.setAttribute('fill', 'none');
      path.setAttribute('opacity', '0.6');
      connectionSvg.appendChild(path);

      // Add small dots at endpoints
      [{ x: startX, y: startY }, { x: endX, y: endY }].forEach(point => {
        const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        circle.setAttribute('cx', point.x);
        circle.setAttribute('cy', point.y);
        circle.setAttribute('r', '4');
        circle.setAttribute('fill', lineColor);
        connectionSvg.appendChild(circle);
      });
    }
  });
}

function clearConnections() {
  if (connectionSvg) {
    connectionSvg.innerHTML = '';
  }
}

function drawConnectionsFromTab(tabUrl) {
  if (!connectionSvg) return;
  connectionSvg.innerHTML = '';

  const normalizedTabUrl = normalizeUrl(tabUrl);

  // Get the divider position (right panel's left edge)
  const rightPanel = document.querySelector('.right-panel');
  const maxBookmarkX = rightPanel ? rightPanel.getBoundingClientRect().left - 25 : Infinity;

  // Find ALL matching tabs (exact normalized URL)
  const matchingTabs = [...document.querySelectorAll('.tab-item')].filter(tab => {
    const url = tab.querySelector('.tab-title')?.title;
    return url && normalizeUrl(url) === normalizedTabUrl;
  });

  // Find ALL matching bookmarks (visible only, exact normalized URL)
  const matchingBookmarks = [...document.querySelectorAll('.bookmark-item')].filter(bookmark => {
    const rect = bookmark.getBoundingClientRect();
    if (rect.height === 0 || rect.width === 0) return false;
    const bookmarkUrl = bookmark.dataset.url;
    return bookmarkUrl && normalizeUrl(bookmarkUrl) === normalizedTabUrl;
  });

  // Get consistent color for this URL
  const lineColor = urlToColor(normalizedTabUrl);

  // Draw highlight rects behind all matched rows first
  matchingTabs.forEach(tabEl => {
    const r = tabEl.getBoundingClientRect();
    const highlight = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    highlight.setAttribute('x', r.left);
    highlight.setAttribute('y', r.top);
    highlight.setAttribute('width', r.width);
    highlight.setAttribute('height', r.height);
    highlight.setAttribute('fill', lineColor);
    highlight.setAttribute('opacity', '0.15');
    connectionSvg.appendChild(highlight);
  });

  matchingBookmarks.forEach(bookmark => {
    const r = bookmark.getBoundingClientRect();
    const titleEl = bookmark.querySelector('.title');
    const titleRect = titleEl ? titleEl.getBoundingClientRect() : r;
    const endX = Math.min(titleRect.right + 8, maxBookmarkX);
    const highlight = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    highlight.setAttribute('x', r.left);
    highlight.setAttribute('y', r.top);
    highlight.setAttribute('width', endX - r.left);
    highlight.setAttribute('height', r.height);
    highlight.setAttribute('fill', lineColor);
    highlight.setAttribute('opacity', '0.15');
    connectionSvg.appendChild(highlight);
  });

  // Draw lines between every tab and every bookmark
  matchingTabs.forEach(tabEl => {
    const tabRect = tabEl.getBoundingClientRect();

    matchingBookmarks.forEach(bookmark => {
      const rect = bookmark.getBoundingClientRect();
      const titleEl = bookmark.querySelector('.title');
      const titleRect = titleEl ? titleEl.getBoundingClientRect() : rect;

      // Draw line from tab (left edge) to bookmark (after title, capped at divider)
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      const startX = tabRect.left;
      const startY = tabRect.top + tabRect.height / 2;
      const endX = Math.min(titleRect.right + 8, maxBookmarkX);
      const endY = rect.top + rect.height / 2;

      const controlOffset = Math.min(100, Math.abs(endX - startX) / 2);

      path.setAttribute('d', `M${startX},${startY} C${startX - controlOffset},${startY} ${endX + controlOffset},${endY} ${endX},${endY}`);
      path.setAttribute('stroke', lineColor);
      path.setAttribute('stroke-width', '2');
      path.setAttribute('fill', 'none');
      path.setAttribute('opacity', '0.6');
      connectionSvg.appendChild(path);

      // Dots at endpoints
      [{ x: startX, y: startY }, { x: endX, y: endY }].forEach(point => {
        const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        circle.setAttribute('cx', point.x);
        circle.setAttribute('cy', point.y);
        circle.setAttribute('r', '4');
        circle.setAttribute('fill', lineColor);
        connectionSvg.appendChild(circle);
      });
    });
  });
}

// TODO: Filter tab events by windowId for multi-window efficiency
// Currently all windows respond to all tab events. To fix:
// 1. Store currentWindowId in DOMContentLoaded
// 2. Check tab.windowId === currentWindowId before calling scheduleReload
// 3. For onRemoved: use removeInfo.windowId
// 4. For onDetached/onAttached: use detachInfo.oldWindowId / attachInfo.newWindowId
function setupTabListeners() {
  const scheduleReload = () => {
    // Cancel any pending reload
    if (reloadTimeout) {
      clearTimeout(reloadTimeout);
    }

    // Schedule new reload for 100ms from now
    reloadTimeout = setTimeout(async () => {
      await loadOpenTabs();
      applyCurrentFilters();
      renderActiveTabs();
      reloadTimeout = null;
    }, 100);
  };

  // Tab events
  chrome.tabs.onCreated.addListener(scheduleReload);
  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    scheduleReload();
    // Check for redirects on tabs opened from bookmarks
    if (pendingBookmarkTabs.has(tabId) && (changeInfo.url || changeInfo.status === 'complete')) {
      const originalUrl = pendingBookmarkTabs.get(tabId);
      const currentUrl = normalizeUrl(tab.url);
      if (originalUrl !== currentUrl) {
        redirectedTabs.set(tabId, originalUrl);
        pendingBookmarkTabs.delete(tabId);
      } else if (changeInfo.status === 'complete') {
        pendingBookmarkTabs.delete(tabId);
      }
    }
  });
  chrome.tabs.onRemoved.addListener((tabId) => {
    // Capture tab info before reload clears orderedTabs
    const closedTab = orderedTabs.find(t => t.id === tabId);
    if (closedTab && activeWorkspaceFolder) {
      // Don't save chrome:// or extension pages
      if (!closedTab.url.startsWith('chrome://') && !closedTab.url.startsWith('chrome-extension://')) {
        addClosedTab(activeWorkspaceFolder.id, closedTab.url, closedTab.title);
      }
    }

    scheduleReload();
    pendingBookmarkTabs.delete(tabId);
    redirectedTabs.delete(tabId);
  });
  chrome.tabs.onMoved.addListener(scheduleReload);
  chrome.tabs.onDetached.addListener(scheduleReload);
  chrome.tabs.onAttached.addListener(scheduleReload);

  // Bookmark events (to update indicator dots when bookmarks change)
  chrome.bookmarks.onCreated.addListener(scheduleReload);
  chrome.bookmarks.onRemoved.addListener(scheduleReload);
  chrome.bookmarks.onChanged.addListener(scheduleReload);
  chrome.bookmarks.onMoved.addListener(scheduleReload);
}

// Modal functions
function showModal(folderTitle) {
  const modal = document.getElementById('closeModal');
  const message = document.getElementById('modalMessage');
  message.textContent = `Close all open tabs in "${folderTitle}"?`;
  modal.style.display = 'flex';
}

function closeModal() {
  document.getElementById('closeModal').style.display = 'none';
}

function showOpenModal(folderTitle, count, hasSubfolder) {
  const modal = document.getElementById('openModal');
  const message = document.getElementById('openModalMessage');
  const recursiveBtn = document.getElementById('openRecursive');
  const levelBtn = document.getElementById('openLevel');
  
  message.textContent = `Open ${count} bookmark${count !== 1 ? 's' : ''} from "${folderTitle}"?`;
  
  if (hasSubfolder) {
    recursiveBtn.style.display = 'block';
    levelBtn.style.display = 'block';
    levelBtn.textContent = 'Open This Folder Only';
  } else {
    recursiveBtn.style.display = 'none';
    levelBtn.style.display = 'block';
    levelBtn.textContent = 'Open All';
  }
  
  modal.style.display = 'flex';
}

function closeOpenModal() {
  document.getElementById('openModal').style.display = 'none';
}

function showWorkspaceModal(bookmarkId, fullTitle, displayTitle, isCurrentlyWorkspace) {
  const modal = document.getElementById('workspaceModal');
  const header = document.getElementById('workspaceModalHeader');
  const message = document.getElementById('workspaceModalMessage');
  const confirmBtn = document.getElementById('workspaceConfirm');

  pendingWorkspaceData = { bookmarkId, fullTitle, isCurrentlyWorkspace };

  if (isCurrentlyWorkspace) {
    header.textContent = 'Remove Workspace';
    message.textContent = `Remove "${displayTitle}" as a workspace?`;
    confirmBtn.textContent = 'Remove Workspace';
  } else {
    header.textContent = 'Make Workspace';
    message.textContent = `Make "${displayTitle}" a workspace? This folder will be marked for session management.`;
    confirmBtn.textContent = 'Make Workspace';
  }

  modal.style.display = 'flex';
}

function closeWorkspaceModal() {
  document.getElementById('workspaceModal').style.display = 'none';
  pendingWorkspaceData = null;
}

async function toggleWorkspace() {
  if (!pendingWorkspaceData) return;

  const { bookmarkId, fullTitle, isCurrentlyWorkspace } = pendingWorkspaceData;
  const parsed = FilterSystem.parseTitle(fullTitle);
  parsed.metadata.workspace = !isCurrentlyWorkspace;
  const newTitle = FilterSystem.buildTitle(parsed.displayTitle, parsed.metadata);

  await chrome.bookmarks.update(bookmarkId, { title: newTitle });
  closeWorkspaceModal();
  applyCurrentFilters();
  renderWorkspaceSidebar();
}

//------------------------------------------
// Bookmark Notes
//------------------------------------------
function showNoteModal(bookmarkId, fullTitle, displayTitle, metadata) {
  pendingNoteData = { id: bookmarkId, title: fullTitle, displayTitle, metadata };
  const modal = document.getElementById('noteModal');
  const header = document.getElementById('noteModalHeader');
  const textarea = document.getElementById('noteTextarea');
  const deleteBtn = document.getElementById('noteDelete');
  const counter = document.getElementById('noteCharCount');

  header.textContent = `Note: ${displayTitle}`;
  textarea.value = metadata.note || '';
  deleteBtn.style.display = metadata.note ? 'block' : 'none';
  counter.textContent = `${(metadata.note || '').length}/250`;

  modal.style.display = 'flex';
  textarea.focus();
}

function closeNoteModal() {
  document.getElementById('noteModal').style.display = 'none';
  pendingNoteData = null;
}

//------------------------------------------
// Closed Tabs (per workspace)
//------------------------------------------
async function getOrCreateClosedFolder(workspaceId) {
  const children = await chrome.bookmarks.getChildren(workspaceId);
  const existing = children.find(c => c.title === CLOSED_FOLDER_NAME);
  if (existing) return existing.id;

  const folder = await chrome.bookmarks.create({
    parentId: workspaceId,
    title: CLOSED_FOLDER_NAME,
    index: 0
  });
  return folder.id;
}

async function addClosedTab(workspaceId, url, title) {
  if (!workspaceId || !url) return;

  const folderId = await getOrCreateClosedFolder(workspaceId);

  // Add new closed tab
  await chrome.bookmarks.create({
    parentId: folderId,
    title: title || url,
    url: url
  });

  // Prune old items if over limit
  try {
    const children = await chrome.bookmarks.getChildren(folderId);
    if (children.length > MAX_CLOSED_TABS) {
      // Sort by dateAdded, remove oldest
      const sorted = children.sort((a, b) => a.dateAdded - b.dateAdded);
      const toRemove = sorted.slice(0, children.length - MAX_CLOSED_TABS);
      for (const item of toRemove) {
        try {
          await chrome.bookmarks.remove(item.id);
        } catch (e) {} // Bookmark may already be removed
      }
    }
  } catch (e) {} // Folder may not exist

  updateClosedTabsButton();
}

async function getClosedTabs(workspaceId) {
  if (!workspaceId) return [];

  try {
    const children = await chrome.bookmarks.getChildren(workspaceId);
    const closedFolder = children.find(c => c.title === CLOSED_FOLDER_NAME);
    if (!closedFolder) return [];

    const tabs = await chrome.bookmarks.getChildren(closedFolder.id);
    // Return sorted by dateAdded descending (most recent first)
    return tabs.filter(t => t.url).sort((a, b) => b.dateAdded - a.dateAdded);
  } catch {
    return [];
  }
}

async function reopenClosedTab(bookmarkId) {
  try {
    const results = await chrome.bookmarks.get(bookmarkId);
    if (results[0] && results[0].url) {
      await chrome.tabs.create({ url: results[0].url, active: true });
      await chrome.bookmarks.remove(bookmarkId);
      updateClosedTabsButton();
    }
  } catch (e) {
    console.error('Error reopening closed tab:', e);
  }
}

async function updateClosedTabsButton() {
  const btn = document.getElementById('closedTabsBtn');
  if (!activeWorkspaceFolder) {
    btn.classList.add('hidden');
    return;
  }

  const closedTabs = await getClosedTabs(activeWorkspaceFolder.id);
  if (closedTabs.length === 0) {
    btn.classList.add('hidden');
  } else {
    btn.classList.remove('hidden');
    btn.innerHTML = `↩<span class="count">${closedTabs.length}</span>`;
  }
}

async function showClosedTabsMenu(e) {
  if (!activeWorkspaceFolder) return;

  const closedTabs = await getClosedTabs(activeWorkspaceFolder.id);
  if (closedTabs.length === 0) return;

  // Bulk actions at top (always visible)
  const items = [
    {
      label: '<strong>Restore all</strong>',
      action: async () => {
        for (const tab of closedTabs) {
          await chrome.tabs.create({ url: tab.url, active: false });
          await chrome.bookmarks.remove(tab.id);
        }
        updateClosedTabsButton();
      }
    },
    {
      label: '<strong>Clear all</strong>',
      action: async () => {
        for (const tab of closedTabs) {
          await chrome.bookmarks.remove(tab.id);
        }
        updateClosedTabsButton();
      }
    },
    { separator: true },
    // Closed tabs below (newest first, oldest at bottom may be cut off)
    ...closedTabs.map(tab => ({
      label: tab.title || tab.url,
      action: () => reopenClosedTab(tab.id)
    }))
  ];

  const rect = e.target.getBoundingClientRect();
  ContextMenu.show(rect.left, rect.bottom + 4, items);
}

//------------------------------------------
// Workspace Sidebar & UI
//------------------------------------------
function updateWorkspaceUI() {
  const closeBtn = document.getElementById('closeWorkspaceBtn');
  const rightPanel = document.querySelector('.right-panel');

  if (activeWorkspaceFolder) {
    closeBtn.classList.remove('hidden');
    rightPanel.classList.remove('hidden');
  } else {
    closeBtn.classList.add('hidden');
    rightPanel.classList.add('hidden');
  }

  renderWorkspaceSidebar();
  updateClosedTabsButton();
}

// Find all workspace folders in tree order
function findWorkspaces(node, results = []) {
  if (node.children) {
    for (const child of node.children) {
      if (child.children) {
        const { metadata } = FilterSystem.parseTitle(child.title);
        if (metadata.workspace) {
          const { displayTitle } = FilterSystem.parseTitle(child.title);
          results.push({ id: child.id, title: displayTitle });
        }
        findWorkspaces(child, results);
      }
    }
  }
  return results;
}

async function renderWorkspaceSidebar() {
  const container = document.getElementById('workspaceSidebar');
  container.innerHTML = '';

  // "All Bookmarks" item at top
  const allItem = document.createElement('div');
  allItem.className = 'workspace-item all-bookmarks';
  if (!activeWorkspaceFolder) {
    allItem.classList.add('active');
  }
  allItem.textContent = '📚 All Bookmarks';
  allItem.ondblclick = () => {
    if (activeWorkspaceFolder) {
      deactivateWorkspace();
    }
  };
  container.appendChild(allItem);

  // Find and render workspaces
  const tree = await chrome.bookmarks.getTree();
  const workspaces = findWorkspaces(tree[0]);

  workspaces.forEach(ws => {
    const item = document.createElement('div');
    item.className = 'workspace-item';
    if (activeWorkspaceFolder && activeWorkspaceFolder.id === ws.id) {
      item.classList.add('active');
    }
    item.textContent = '🗂️ ' + ws.title;
    item.title = ws.title;
    item.ondblclick = (e) => {
      if (e.shiftKey) {
        openWorkspaceInNewWindow(ws.id);
      } else {
        activateWorkspace(ws.id);
      }
    };
    container.appendChild(item);
  });
}

function showLooseTabsModal(tabCount) {
  return new Promise((resolve) => {
    looseTabsResolve = resolve;
    const modal = document.getElementById('looseTabsModal');
    const message = document.getElementById('looseTabsMessage');
    message.textContent = `You have ${tabCount} open tab${tabCount !== 1 ? 's' : ''}. What would you like to do with them?`;
    modal.style.display = 'flex';
  });
}

function closeLooseTabsModal(choice) {
  document.getElementById('looseTabsModal').style.display = 'none';
  if (looseTabsResolve) {
    looseTabsResolve(choice);
    looseTabsResolve = null;
  }
}

async function activateWorkspace(workspaceId) {
  // Save current active tab before leaving current workspace
  await saveActiveTabForWorkspace();

  const success = await WorkspaceManager.activate(workspaceId, {
    onLooseTabsPrompt: (tabCount) => showLooseTabsModal(tabCount),
    onComplete: async () => {
      activeWorkspaceFolder = await WorkspaceManager.getActiveWorkspaceFolder();
      // Sync to storage for side panel (per-window)
      await chrome.storage.local.set({ [`activeWorkspaceId_${currentWindowId}`]: workspaceId });
      updateWorkspaceUI();
      await loadOpenTabs();
      await loadBookmarks();
      renderActiveTabs();
      // Restore previously active tab for this workspace
      await restoreActiveTabForWorkspace(workspaceId);
    },
    onError: (error) => {
      alert('Error activating workspace: ' + error.message);
    }
  });
  return success;
}

// Save the current active tab for the current workspace (so we can restore it later)
async function saveActiveTabForWorkspace() {
  if (!activeWorkspaceFolder) return;

  const [activeTab] = await chrome.tabs.query({ windowId: currentWindowId, active: true });

  if (activeTab && activeTab.url) {
    const result = await chrome.storage.local.get('workspaceActiveTabs');
    const workspaceActiveTabs = result.workspaceActiveTabs || {};
    workspaceActiveTabs[activeWorkspaceFolder.id] = activeTab.url;
    await chrome.storage.local.set({ workspaceActiveTabs });
  }
}

// Restore the active tab that was open when user last left this workspace
async function restoreActiveTabForWorkspace(workspaceId) {
  if (!workspaceId) return;

  const result = await chrome.storage.local.get('workspaceActiveTabs');
  const workspaceActiveTabs = result.workspaceActiveTabs || {};
  const savedUrl = workspaceActiveTabs[workspaceId];

  if (!savedUrl) return;

  const normalizedSavedUrl = normalizeUrl(savedUrl);

  // Retry up to 15 times over 3 seconds (tabs may still be loading)
  const maxRetries = 15;
  const retryDelay = 200;

  for (let i = 0; i < maxRetries; i++) {
    const tabs = await chrome.tabs.query({ windowId: currentWindowId });
    // Look for tab with matching URL that has finished loading
    const matchingTab = tabs.find(t =>
      t.url &&
      t.status === 'complete' &&
      normalizeUrl(t.url) === normalizedSavedUrl
    );

    if (matchingTab) {
      await chrome.tabs.update(matchingTab.id, { active: true });
      return;
    }

    // Also check loading tabs in case they already have the URL assigned
    const loadingMatch = tabs.find(t =>
      t.url && normalizeUrl(t.url) === normalizedSavedUrl
    );
    if (loadingMatch && i >= 5) {
      // After 1 second, accept loading tabs too
      await chrome.tabs.update(loadingMatch.id, { active: true });
      return;
    }

    await new Promise(resolve => setTimeout(resolve, retryDelay));
  }
}

async function deactivateWorkspace() {
  const success = await WorkspaceManager.deactivate({
    onComplete: async () => {
      activeWorkspaceFolder = null;
      // Sync to storage for side panel (per-window)
      await chrome.storage.local.set({ [`activeWorkspaceId_${currentWindowId}`]: null });
      updateWorkspaceUI();
      await loadOpenTabs();
      await loadBookmarks();
      renderActiveTabs();
    },
    onError: (error) => {
      alert('Error closing workspace: ' + error.message);
    }
  });
  return success;
}

async function openWorkspaceInNewWindow(workspaceId) {
  const extensionUrl = chrome.runtime.getURL('bookmarks.html');
  const newWindow = await chrome.windows.create({
    url: `${extensionUrl}?workspace=${workspaceId}`,
    focused: true
  });
  // Pin the GoldenTab
  if (newWindow.tabs && newWindow.tabs[0]) {
    await chrome.tabs.update(newWindow.tabs[0].id, { pinned: true });
  }
}

// Companion panel (side panel or floating window based on config)
async function openCompanionPanel() {
  if (COMPANION_MODE === 'floating') {
    await openFloatingWindow();
  } else if (COMPANION_MODE === 'sidepanel') {
    await chrome.sidePanel.open({ windowId: (await chrome.windows.getCurrent()).id });
  }
}

//------------------------------------------
// Floating Window Management
// Creates a companion window that stays attached to the left side of the main window.
// Handles: positioning, minimize/restore behavior, and cleanup.
// Uses visibilitychange event to detect minimize/restore (no polling needed).
//------------------------------------------

// Opens a floating companion window positioned to the left of the main window.
// Passes the main window's ID so the floating window knows which tabs to display.
async function openFloatingWindow() {
  const currentWindow = await chrome.windows.getCurrent();
  mainWindowId = currentWindow.id;

  // Check if floating window already exists for this window (survives refresh)
  // Skip this check when restoring after minimize - we just removed it and it may
  // still be in the window list briefly, causing a race condition
  if (!floatingWindowWasOpen) {
    const sidepanelUrl = chrome.runtime.getURL(`sidepanel.html?windowId=${currentWindow.id}`);
    const allWindows = await chrome.windows.getAll({ populate: true });
    for (const win of allWindows) {
      if (win.type === 'popup' && win.tabs?.some(t => t.url === sidepanelUrl)) {
        floatingWindowId = win.id;
        // Update position to match current main window bounds
        try {
          await chrome.windows.update(floatingWindowId, {
            left: Math.max(0, currentWindow.left - 200 - 5),
            top: currentWindow.top,
            height: currentWindow.height
          });
        } catch (e) {}
        return; // Already exists, just track it
      }
    }
  }

  // Close any stale floating window reference
  if (floatingWindowId) {
    try {
      await chrome.windows.remove(floatingWindowId);
    } catch (e) {} // Window may already be closed
  }

  // Create focused so it appears on same macOS desktop as main window
  const floatingWindow = await chrome.windows.create({
    url: `sidepanel.html?windowId=${currentWindow.id}`,
    type: 'popup',
    width: 200,
    height: currentWindow.height,
    left: Math.max(0, currentWindow.left - 200 - 5),
    top: currentWindow.top,
    focused: true
  });

  floatingWindowId = floatingWindow.id;
  floatingWindowCreatedAt = Date.now();

  // Return focus to main window
  await chrome.windows.update(currentWindow.id, { focused: true });
}

// Keeps floating window attached when main window moves or resizes.
// Skips repositioning if main window is minimized (avoid moving to weird coordinates).
async function handleWindowBoundsChanged(window) {
  if (window.id !== mainWindowId || !floatingWindowId) return;
  if (window.state === 'minimized') return;

  try {
    await chrome.windows.update(floatingWindowId, {
      left: Math.max(0, window.left - 200 - 5),
      top: window.top,
      height: window.height
    });
  } catch (e) {
    // Floating window is gone
    floatingWindowId = null;
  }
}

// Cleanup when floating window or main window is closed.
async function handleWindowRemoved(windowId) {
  if (windowId === floatingWindowId) {
    floatingWindowId = null;
  } else if (windowId === mainWindowId && floatingWindowId) {
    // Main window closed - also close the floating window
    const windowToRemove = floatingWindowId;
    floatingWindowId = null;
    try {
      await chrome.windows.remove(windowToRemove);
    } catch (e) {} // May already be closed
  }
}

// Handle minimize/restore via document visibility.
// Only close floating window on actual minimize (not Space switch/Mission Control).
async function handleVisibilityChange() {
  if (document.hidden) {
    // Check if actually minimized before closing
    await new Promise(r => setTimeout(r, 100));
    try {
      const win = await chrome.windows.get(mainWindowId);
      if (win.state === 'minimized' && floatingWindowId) {
        floatingWindowWasOpen = true;
        const windowToRemove = floatingWindowId;
        floatingWindowId = null;
        await chrome.windows.remove(windowToRemove);
      }
    } catch (e) {}
  } else {
    // Window restored/visible
    if (floatingWindowWasOpen && !floatingWindowId) {
      await new Promise(r => setTimeout(r, 100));
      try {
        await openCompanionPanel();
        floatingWindowWasOpen = false;
      } catch (e) {
        console.error('Failed to restore floating window:', e);
      }
    }
  }
}

async function handleStorageChange(changes, area) {
  const storageKey = `activeWorkspaceId_${currentWindowId}`;
  if (area !== 'local' || !changes[storageKey]) return;

  const newWorkspaceId = changes[storageKey].newValue;
  const currentWorkspaceId = activeWorkspaceFolder?.id || null;

  // Ignore if already on this workspace
  if (newWorkspaceId === currentWorkspaceId) return;

  if (newWorkspaceId) {
    // Switch to workspace (skip the storage.set since it came from storage)
    const success = await WorkspaceManager.activate(newWorkspaceId, {
      onLooseTabsPrompt: () => Promise.resolve('bringIn'), // Auto bring in tabs
      onComplete: async () => {
        activeWorkspaceFolder = await WorkspaceManager.getActiveWorkspaceFolder();
        updateWorkspaceUI();
        await loadOpenTabs();
        await loadBookmarks();
        renderActiveTabs();
      },
      onError: () => {} // Silently fail
    });
  } else {
    // Deactivate workspace
    await WorkspaceManager.deactivate({
      onComplete: async () => {
        activeWorkspaceFolder = null;
        updateWorkspaceUI();
        await loadOpenTabs();
        await loadBookmarks();
        renderActiveTabs();
      },
      onError: () => {}
    });
  }
}

// Tab management
async function loadOpenTabs() {
  const window = await chrome.windows.getCurrent();
  const tabs = await chrome.tabs.query({ windowId: window.id });
  openTabUrls = new Set();
  openTabsMap = new Map();

  const extensionUrl = chrome.runtime.getURL('bookmarks.html');

  // Store ordered tabs for Active Tabs folder (exclude bookmark manager, chrome://, and empty URLs)
  orderedTabs = tabs.filter(tab =>
    tab.url &&
    !tab.url.startsWith('chrome://') &&
    !tab.url.startsWith('chrome-extension://') &&
    tab.url !== extensionUrl
  );

  tabs.forEach(tab => {
    if (!tab.url) return;
    const normalized = normalizeUrl(tab.url);
    openTabUrls.add(normalized);
    if (!openTabsMap.has(normalized)) {
      openTabsMap.set(normalized, []);
    }
    openTabsMap.get(normalized).push(tab.id);
  });
}

async function openBookmarkUrl(url, active = true, index = undefined) {
  const options = { url, active };
  if (index !== undefined) options.index = index;
  const tab = await chrome.tabs.create(options);
  pendingBookmarkTabs.set(tab.id, normalizeUrl(url));
  return tab;
}

async function sortTabsByWebsite() {
  if (orderedTabs.length === 0) return;

  // Sort by hostname, then by title
  const sorted = [...orderedTabs].sort((a, b) => {
    const hostA = new URL(a.url).hostname.replace(/^www\./, '');
    const hostB = new URL(b.url).hostname.replace(/^www\./, '');
    const hostCompare = hostA.localeCompare(hostB);
    if (hostCompare !== 0) return hostCompare;
    return (a.title || '').localeCompare(b.title || '');
  });

  // Move each tab to its new position
  for (let i = 0; i < sorted.length; i++) {
    await chrome.tabs.move(sorted[i].id, { index: i });
  }
}

function findDuplicateTabIds() {
  const seen = new Map();
  const duplicates = [];

  orderedTabs.forEach(tab => {
    const normalized = normalizeUrl(tab.url);
    if (seen.has(normalized)) {
      duplicates.push(tab.id); // duplicate
    } else {
      seen.set(normalized, tab.id); // first occurrence
    }
  });

  return duplicates;
}

async function closeDuplicateTabs() {
  const toClose = findDuplicateTabIds();
  if (toClose.length === 0) return;
  await chrome.tabs.remove(toClose);
}

function previewDuplicateTabs() {
  const duplicates = findDuplicateTabIds();
  duplicates.forEach(tabId => {
    const el = document.querySelector(`.tab-item[data-tab-id="${tabId}"]`);
    if (el) el.classList.add('will-close');
  });
}

function clearDuplicatePreview() {
  document.querySelectorAll('.tab-item.will-close').forEach(el => {
    el.classList.remove('will-close');
  });
}

function normalizeUrl(url) {
  if (!url) return '';
  try {
    let normalized = url.toLowerCase();
    normalized = normalized.replace(/^https?:\/\//, '');
    normalized = normalized.replace(/^www\./, '');
    normalized = normalized.replace(/\/$/, '');
    normalized = normalized.split('#')[0]; // keep query params, strip only hash
    return normalized;
  } catch (e) {
    return url;
  }
}

function urlMatches(bookmarkUrl, openUrls) {
  if (!bookmarkUrl) return false;
  const normalized = normalizeUrl(bookmarkUrl);
  return openUrls.has(normalized);
}

function getMatchingTabIds(bookmarkUrl) {
  const normalized = normalizeUrl(bookmarkUrl);
    
  // If we only use exact matching, we could just do this one line
  // instead of all the code below:
  //   return openTabsMap.get(normalized) || [];

  // Exact match
  if (openTabsMap.has(normalized)) {
    return openTabsMap.get(normalized);
  }

  // Fallback to prefix matching
  const tabIds = [];
  for (let [openUrl, ids] of openTabsMap.entries()) {
    if (openUrl.startsWith(normalized) || normalized.startsWith(openUrl)) {
      tabIds.push(...ids);
    }
  }
  return tabIds;
}

async function closeBookmarkTab(bookmarkUrl) {
  const tabIds = getMatchingTabIds(bookmarkUrl);
  if (tabIds.length > 0) {
    try { // Fix race condition closing lots of tabs
      await chrome.tabs.remove(tabIds);
    } catch (error) {
      // Tab might already be closed - ignore error
      console.log('Tab already closed:', error.message);
    }
    await loadOpenTabs();
    applyCurrentFilters();
  }
}

async function closeFolderTabs(folderId, recursive) {
  try {
    const bookmark = await chrome.bookmarks.getSubTree(folderId);
    const urls = collectBookmarkUrls(bookmark[0], recursive, 0);
    
    const tabIds = [];
    for (let url of urls) {
      const ids = getMatchingTabIds(url);
      tabIds.push(...ids);
    }
    
    if (tabIds.length > 0) {
      try {
        await chrome.tabs.remove(tabIds);
      } catch (error) {
        // Some tabs might already be closed - ignore error
        console.log('Some tabs already closed:', error.message);
      }
      await loadOpenTabs();
      applyCurrentFilters();
    } else {
      alert('No open tabs found for this folder');
    }
  } catch (error) {
    console.error('Error closing folder tabs:', error);
    alert('Error: ' + error.message);
  }
}

// Bookmark operations
function collectBookmarkUrls(bookmark, recursive, depth) {
  let urls = [];
  
  if (!bookmark.children) {
    return urls;
  }
  
  for (let child of bookmark.children) {
    if (child.url) {
      if (depth === 0 || recursive) {
        urls.push(child.url);
      }
    } else if (child.children) {
      if (recursive) {
        urls.push(...collectBookmarkUrls(child, recursive, depth + 1));
      } else if (depth === 0) {
        for (let grandchild of child.children) {
          if (grandchild.url) {
            urls.push(grandchild.url);
          }
        }
      }
    }
  }
  
  return urls;
}

function countFolderUrls(bookmark, recursive, depth = 0) {
  let count = 0;
  
  if (!bookmark.children) {
    return count;
  }
  
  for (let child of bookmark.children) {
    if (child.url) {
      if (depth === 0 || recursive) {
        count++;
      }
    } else if (child.children) {
      if (recursive) {
        count += countFolderUrls(child, recursive, depth + 1);
      } else if (depth === 0) {
        for (let grandchild of child.children) {
          if (grandchild.url) {
            count++;
          }
        }
      }
    }
  }
  
  return count;
}

function hasSubfolders(bookmark) {
  if (!bookmark.children) return false;
  
  for (let child of bookmark.children) {
    if (child.children) {
      return true;
    }
  }
  return false;
}

async function openFolderBookmarks(folderId, recursive) {
  try {
    const bookmark = await chrome.bookmarks.getSubTree(folderId);
    const urls = collectBookmarkUrls(bookmark[0], recursive, 0);

    for (let url of urls) {
      await openBookmarkUrl(url, false);
    }
  } catch (error) {
    console.error('Error opening folder bookmarks:', error);
    alert('Error: ' + error.message);
  }
}

async function sortFolderBookmarks(folderId) {
  try {
    const children = await chrome.bookmarks.getChildren(folderId);

    // Separate folders and bookmarks, sort each group by title
    const folders = children.filter(c => c.children !== undefined || !c.url);
    const bookmarks = children.filter(c => c.url);

    folders.sort((a, b) => a.title.localeCompare(b.title));
    bookmarks.sort((a, b) => a.title.localeCompare(b.title));

    // Move folders first, then bookmarks
    const sorted = [...folders, ...bookmarks];
    for (let i = 0; i < sorted.length; i++) {
      await chrome.bookmarks.move(sorted[i].id, { parentId: folderId, index: i });
    }

    applyCurrentFilters();
  } catch (error) {
    console.error('Error sorting folder:', error);
    alert('Error: ' + error.message);
  }
}

async function deduplicateFolderBookmarks(folderId) {
  try {
    const toRemove = await findFolderDuplicates(folderId);

    if (toRemove.length === 0) {
      alert('No duplicates found');
      return;
    }

    if (confirm(`Remove ${toRemove.length} duplicate bookmark${toRemove.length > 1 ? 's' : ''}?`)) {
      for (const bookmark of toRemove) {
        await chrome.bookmarks.remove(bookmark.id);
      }
      applyCurrentFilters();
    }
  } catch (error) {
    console.error('Error removing duplicates:', error);
    alert('Error: ' + error.message);
  }
}

async function findFolderDuplicates(folderId) {
  const children = await chrome.bookmarks.getChildren(folderId);
  const seen = new Set();
  const duplicates = [];

  for (const child of children) {
    if (!child.url) continue;

    const normalized = normalizeUrl(child.url);
    if (seen.has(normalized)) {
      duplicates.push(child);
    } else {
      seen.add(normalized);
    }
  }

  return duplicates;
}

async function previewFolderDuplicates(folderId) {
  const duplicates = await findFolderDuplicates(folderId);
  duplicates.forEach(bookmark => {
    const el = document.querySelector(`.bookmark-item[data-id="${bookmark.id}"]`);
    if (el) el.classList.add('will-close');
  });
}

function clearFolderDuplicatePreview() {
  document.querySelectorAll('.bookmark-item.will-close').forEach(el => {
    el.classList.remove('will-close');
  });
}

// Rendering
let draggedTabId = null;

function renderActiveTabs() {
  const container = document.getElementById('activeTabsList');
  container.innerHTML = '';

  orderedTabs.forEach((tab, index) => {
    const item = document.createElement('div');
    item.className = 'tab-item';
    item.draggable = true;
    item.dataset.tabId = tab.id;
    item.dataset.index = index;

    // Drag events
    item.addEventListener('dragstart', (e) => {
      draggedTabId = tab.id;
      item.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('tab-id', tab.id);
      e.dataTransfer.setData('tab-url', tab.url);
      e.dataTransfer.setData('tab-title', tab.title || tab.url);
    });

    item.addEventListener('dragend', () => {
      item.classList.remove('dragging');
      draggedTabId = null;
      // Clear all drag-over states (both panels)
      document.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
    });

    item.addEventListener('dragover', (e) => {
      e.preventDefault();
      const isTabReorder = draggedTabId && draggedTabId !== tab.id;
      const isBookmarkDrop = e.dataTransfer.types.includes('bookmark-url');
      if (isTabReorder || isBookmarkDrop) {
        item.classList.add('drag-over');
      }
    });

    item.addEventListener('dragleave', () => {
      item.classList.remove('drag-over');
    });

    item.addEventListener('drop', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      item.classList.remove('drag-over');

      // Bookmark drop - open as new tab at this position
      const bookmarkUrl = e.dataTransfer.getData('bookmark-url');
      if (bookmarkUrl) {
        await openBookmarkUrl(bookmarkUrl, false, tab.index);
        return;
      }

      // Tab reorder
      if (draggedTabId && draggedTabId !== tab.id) {
        await chrome.tabs.move(draggedTabId, { index: tab.index });
      }
    });

    // Double-click to focus tab
    item.addEventListener('dblclick', () => {
      chrome.tabs.update(tab.id, { active: true });
    });

    // Bookmark indicator dot:
    // - Bright dot = bookmarked in current workspace (safe to close)
    // - Dim dot = bookmarked elsewhere (still saved, but not in this workspace)
    const normalizedUrl = normalizeUrl(tab.url);
    const inWorkspace = workspaceBookmarkUrls.has(normalizedUrl);
    const inExternal = !inWorkspace && allBookmarkUrls.has(normalizedUrl);

    if (inWorkspace || inExternal) {
      const indicator = document.createElement('span');
      indicator.className = 'bookmark-indicator' + (inExternal ? ' external' : '');
      indicator.title = inWorkspace ? 'Bookmarked in workspace' : 'Bookmarked elsewhere';
      indicator.style.cursor = 'pointer';
      indicator.addEventListener('mouseenter', () => drawConnectionsFromTab(tab.url));
      indicator.addEventListener('mouseleave', clearConnections);
      item.appendChild(indicator);
    }

    // Redirect indicator (yellow arrow if bookmark redirected)
    if (redirectedTabs.has(tab.id)) {
      const redirectIcon = document.createElement('span');
      redirectIcon.className = 'redirect-indicator';
      redirectIcon.textContent = '↪';
      redirectIcon.title = 'Redirected from bookmark';
      item.appendChild(redirectIcon);
    }

    // Favicon
    const favicon = document.createElement('img');
    favicon.className = 'favicon';
    favicon.src = `chrome-extension://${chrome.runtime.id}/_favicon/?pageUrl=${encodeURIComponent(tab.url)}&size=16`;
    favicon.alt = '';

    // Title
    const title = document.createElement('span');
    title.className = 'tab-title';
    title.textContent = tab.title || tab.url;
    title.title = tab.url;

    // Close button
    const closeBtn = document.createElement('button');
    closeBtn.className = 'tab-close';
    closeBtn.textContent = '✕';
    closeBtn.title = 'Close Tab';
    closeBtn.onclick = async (e) => {
      e.stopPropagation();
      await chrome.tabs.remove(tab.id);
      await loadOpenTabs();
      renderActiveTabs();
    };

    item.appendChild(favicon);
    item.appendChild(title);
    item.appendChild(closeBtn);
    container.appendChild(item);
  });

  if (orderedTabs.length === 0) {
    container.innerHTML = '<div class="no-results">No open tabs</div>';
  }
}

async function loadBookmarks() {
  try {
    // Build full bookmark URL set for "external" indicator (dim dot)
    const fullTree = await chrome.bookmarks.getTree();
    allBookmarkUrls = new Set();
    bookmarkUrlLocations = new Map();
    buildBookmarkUrlSet(fullTree[0], allBookmarkUrls, true);
    collectBookmarkLocations(fullTree[0], {});

    workspaceBookmarkUrls = new Set();

    if (activeWorkspaceFolder) {
      // Workspace mode - build workspace URL set for "in workspace" indicator (bright dot)
      const subtree = await chrome.bookmarks.getSubTree(activeWorkspaceFolder.id);
      buildBookmarkUrlSet(subtree[0], workspaceBookmarkUrls, true);
      renderBookmarks([subtree[0]]);
    } else {
      renderBookmarks(fullTree[0].children);
    }
  } catch (error) {
    console.error('loadBookmarks error:', error);
  }
}

// Recursively collects all bookmark URLs from a node into the given Set
// skipSession: if true, skips .session folders (used for workspace set to exclude saved session tabs)
function buildBookmarkUrlSet(node, targetSet, skipSession = false) {
  // Skip .session and .closed folders when building workspace set (they're internal bookkeeping)
  if (skipSession && (node.title === '.session' || node.title === '.closed')) return;

  if (node.url) {
    targetSet.add(normalizeUrl(node.url));
  }
  if (node.children) {
    node.children.forEach(child => buildBookmarkUrlSet(child, targetSet, skipSession));
  }
}

// Collect locations for each bookmark URL
function collectBookmarkLocations(node, parentInfo) {
  if (node.title === '.session' || node.title === '.closed') return;

  const currentInfo = {
    id: node.id,
    title: node.title,
    parentId: parentInfo.id || null,
    parentTitle: parentInfo.title || 'Root'
  };

  if (node.url) {
    const normalized = normalizeUrl(node.url);
    if (!bookmarkUrlLocations.has(normalized)) {
      bookmarkUrlLocations.set(normalized, []);
    }
    bookmarkUrlLocations.get(normalized).push(currentInfo);
  }

  if (node.children) {
    node.children.forEach(child => collectBookmarkLocations(child, currentInfo));
  }
}

function renderBookmarks(bookmarks, parentElement = null, level = 0, parentCollapsed = false) {
  const container = parentElement || document.getElementById('bookmarkTree');
  if (!parentElement) container.innerHTML = '';

  bookmarks.forEach(bookmark => {
    // Hide .session and .closed folders (internal bookkeeping)
    if (bookmark.title === '.session' || bookmark.title === '.closed') return;

    const isCollapsed = collapsedFolders.has(bookmark.id);
    const shouldHide = parentCollapsed;

    const item = createBookmarkElement(bookmark, level, isCollapsed, shouldHide);
    container.appendChild(item);

    if (bookmark.children && bookmark.children.length > 0) {
      renderBookmarks(bookmark.children, container, level + 1, shouldHide || isCollapsed);
    }
  });
}

function createBookmarkElement(bookmark, level, isCollapsed, shouldHide) {
  // Parse title for metadata (starred, etc.)
  const { displayTitle, metadata } = FilterSystem.parseTitle(bookmark.title);

  // Check for filter metadata (context items are dimmed)
  const isContextItem = FilterSystem.isContext(bookmark);

  const div = document.createElement('div');
  div.className = bookmark.children ? 'bookmark-folder' : 'bookmark-item';
  if (isContextItem) {
    div.classList.add('filter-context');
  }
  div.dataset.id = bookmark.id;
  div.dataset.parentId = bookmark.parentId;
  div.dataset.index = bookmark.index;
  div.dataset.url = bookmark.url || '';
  div.dataset.title = displayTitle;
  div.draggable = true;

  if (shouldHide) {
    div.style.display = 'none';
  }

  // Double-click handlers
  if (!bookmark.children && bookmark.url) {
    div.addEventListener('dblclick', async (e) => {
      e.stopPropagation();
      await openBookmarkUrl(bookmark.url, !e.shiftKey);
    });
  } else if (bookmark.children) {
    div.addEventListener('dblclick', async (e) => {
      e.stopPropagation();

      // If it's a workspace...
      if (metadata.workspace) {
        // If we're already in this workspace, deactivate it
        if (activeWorkspaceFolder && activeWorkspaceFolder.id === bookmark.id) {
          await deactivateWorkspace();
          return;
        }
        // Otherwise activate it
        await activateWorkspace(bookmark.id);
        return;
      }

      const subtree = await chrome.bookmarks.getSubTree(bookmark.id);
      const hasSubfolder = hasSubfolders(subtree[0]);
      const countRecursive = countFolderUrls(subtree[0], true, 0);
      const countLevel = countFolderUrls(subtree[0], false, 0);
      const count = hasSubfolder ? countRecursive : countLevel;

      if (count === 0) {
        alert('No bookmarks to open');
        return;
      }

      if (count > 10 || hasSubfolder) {
        pendingOpenFolderId = bookmark.id;
        showOpenModal(displayTitle, count, hasSubfolder);
      } else {
        await openFolderBookmarks(bookmark.id, false);
      }
    });

    // Hover to show connection lines to open tabs
    div.addEventListener('mouseenter', () => drawConnections(bookmark.id));
    div.addEventListener('mouseleave', clearConnections);
  }

  const content = document.createElement('div');
  content.className = 'bookmark-content';
  content.style.paddingLeft = `${16 + (level * 26)}px`;

  const isOpen = !bookmark.children && bookmark.url && urlMatches(bookmark.url, openTabUrls);

  // Orange dot indicator for bookmarks that are open as tabs
  if (isOpen) {
    const dot = document.createElement('span');
    dot.className = 'open-indicator';
    dot.title = 'Tab is open';
    dot.style.cursor = 'pointer';
    dot.addEventListener('mouseenter', () => drawConnectionsFromTab(bookmark.url));
    dot.addEventListener('mouseleave', clearConnections);
    content.appendChild(dot);
  } else if (!bookmark.children) {
    const spacer = document.createElement('span');
    spacer.className = 'open-indicator-spacer';
    content.appendChild(spacer);
  }

  // Expand/collapse arrow for folders
  if (bookmark.children) {
    const arrow = document.createElement('span');
    arrow.className = 'expand-arrow';
    arrow.textContent = isCollapsed ? '▶' : '▼';
    arrow.onclick = (e) => {
      e.stopPropagation();
      toggleFolder(bookmark.id);
    };
    content.appendChild(arrow);
  }

  // Icon and title
  let icon;
  if (bookmark.children) {
    icon = document.createElement('span');
    icon.className = 'icon';
    icon.textContent = '📁';
  } else {
    icon = document.createElement('img');
    icon.className = 'icon favicon';
    icon.src = `chrome-extension://${chrome.runtime.id}/_favicon/?pageUrl=${encodeURIComponent(bookmark.url)}&size=16`;
    icon.alt = '';
  }

  const title = document.createElement('span');
  title.className = 'title';
  title.textContent = displayTitle;

  content.appendChild(icon);
  content.appendChild(title);

  // Star indicator (shown to the right of title if starred)
  if (metadata.starred) {
    const starIndicator = document.createElement('span');
    starIndicator.className = 'star-indicator';
    starIndicator.textContent = '⭐';
    starIndicator.title = 'Starred';
    content.appendChild(starIndicator);
  }

  // Workspace indicator (shown to the right of title if workspace)
  if (metadata.workspace) {
    const workspaceIndicator = document.createElement('span');
    workspaceIndicator.className = 'workspace-indicator';
    workspaceIndicator.textContent = '🗂️';
    workspaceIndicator.title = 'Workspace';
    content.appendChild(workspaceIndicator);
  }

  // Multi-location indicator (bookmark exists in multiple places)
  if (!bookmark.children && bookmark.url) {
    const normalized = normalizeUrl(bookmark.url);
    const locations = bookmarkUrlLocations.get(normalized) || [];
    if (locations.length > 1) {
      const multiIndicator = document.createElement('span');
      multiIndicator.className = 'multi-location-indicator';
      multiIndicator.textContent = `×${locations.length}`;
      multiIndicator.title = `Bookmarked in ${locations.length} locations (click to see)`;
      multiIndicator.onclick = (e) => {
        e.stopPropagation();
        const items = locations.map(loc => ({
          label: `📁 ${loc.parentTitle}`,
          action: () => {
            // Expand and scroll to the bookmark
            if (loc.parentId) {
              collapsedFolders.delete(loc.parentId);
              applyCurrentFilters();
              setTimeout(() => {
                const el = document.querySelector(`.bookmark-item[data-id="${loc.id}"]`);
                if (el) {
                  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                  el.classList.add('highlight');
                  setTimeout(() => el.classList.remove('highlight'), 4000);
                }
              }, 100);
            }
          }
        }));
        ContextMenu.show(e.clientX, e.clientY, items);
      };
      content.appendChild(multiIndicator);
    }
  }

  // Inline note preview (shown if bookmark has a note)
  const hasNote = metadata.note;
  if (hasNote) {
    const notePreview = document.createElement('span');
    notePreview.className = 'note-preview';
    // Truncate to ~50 chars for inline display
    const truncated = hasNote.length > 50 ? hasNote.substring(0, 50) + '…' : hasNote;
    notePreview.textContent = truncated;
    notePreview.title = hasNote; // Full note on hover
    notePreview.onclick = (e) => {
      e.stopPropagation();
      // Single click - show tooltip (title already does this, but could enhance later)
    };
    notePreview.ondblclick = (e) => {
      e.stopPropagation();
      showNoteModal(bookmark.id, bookmark.title, displayTitle, metadata);
    };
    content.appendChild(notePreview);
  }

  // URL display for bookmarks
  if (!bookmark.children && bookmark.url) {
    const url = document.createElement('span');
    url.className = 'url';
    url.textContent = bookmark.url;
    content.appendChild(url);
  }

  // Action buttons
  const actions = document.createElement('div');
  actions.className = 'actions';

  if (!bookmark.children) {
    // Regular bookmark actions
    // Note button
    const noteBtn = document.createElement('button');
    noteBtn.textContent = '📝';
    noteBtn.title = hasNote ? 'Edit Note' : 'Add Note';
    noteBtn.className = hasNote ? 'has-note' : '';
    noteBtn.onclick = (e) => {
      e.stopPropagation();
      showNoteModal(bookmark.id, bookmark.title, displayTitle, metadata);
    };
    actions.appendChild(noteBtn);

    // Star button
    const starBtn = document.createElement('button');
    starBtn.textContent = metadata.starred ? '★' : '☆';
    starBtn.title = metadata.starred ? 'Unstar' : 'Star';
    starBtn.className = metadata.starred ? 'starred' : '';
    starBtn.onclick = async (e) => {
      e.stopPropagation();
      await toggleStarred(bookmark.id, bookmark.title);
    };
    actions.appendChild(starBtn);

    // Close tab button (only if open)
    if (isOpen) {
      const closeTabBtn = document.createElement('button');
      closeTabBtn.innerHTML = '🚪';
      closeTabBtn.title = 'Close Tab';
      closeTabBtn.onclick = async (e) => {
        e.stopPropagation();
        await closeBookmarkTab(bookmark.url);
      };
      actions.appendChild(closeTabBtn);
    }

    // Open button
    const openBtn = document.createElement('button');
    openBtn.textContent = '↗';
    openBtn.title = 'Open (Shift+click for background)';
    openBtn.onclick = async (e) => {
      e.stopPropagation();
      await openBookmarkUrl(bookmark.url, !e.shiftKey);
    };
    actions.appendChild(openBtn);
  } else {
    // Folder actions

    // Note button
    const noteBtn = document.createElement('button');
    noteBtn.textContent = '📝';
    noteBtn.title = hasNote ? 'Edit Note' : 'Add Note';
    noteBtn.className = hasNote ? 'has-note' : '';
    noteBtn.onclick = (e) => {
      e.stopPropagation();
      showNoteModal(bookmark.id, bookmark.title, displayTitle, metadata);
    };
    actions.appendChild(noteBtn);

    // Deduplicate button
    const dedupBtn = document.createElement('button');
    dedupBtn.textContent = '2→1';
    dedupBtn.title = 'Remove duplicate bookmarks';
    dedupBtn.className = 'text-btn';
    dedupBtn.onclick = (e) => {
      e.stopPropagation();
      deduplicateFolderBookmarks(bookmark.id);
    };
    dedupBtn.onmouseenter = () => previewFolderDuplicates(bookmark.id);
    dedupBtn.onmouseleave = clearFolderDuplicatePreview;
    actions.appendChild(dedupBtn);

    // Sort button
    const sortBtn = document.createElement('button');
    sortBtn.textContent = 'A→Z';
    sortBtn.title = 'Sort bookmarks alphabetically';
    sortBtn.className = 'text-btn';
    sortBtn.onclick = (e) => {
      e.stopPropagation();
      sortFolderBookmarks(bookmark.id);
    };
    actions.appendChild(sortBtn);

    // Star button
    const starBtn = document.createElement('button');
    starBtn.textContent = metadata.starred ? '★' : '☆';
    starBtn.title = metadata.starred ? 'Unstar' : 'Star';
    starBtn.className = metadata.starred ? 'starred' : '';
    starBtn.onclick = async (e) => {
      e.stopPropagation();
      await toggleStarred(bookmark.id, bookmark.title);
    };
    actions.appendChild(starBtn);

    // Workspace toggle button
    const workspaceBtn = document.createElement('button');
    workspaceBtn.textContent = metadata.workspace ? '🗂️' : '📁';
    workspaceBtn.title = metadata.workspace ? 'Remove Workspace' : 'Make Workspace';
    workspaceBtn.className = metadata.workspace ? 'workspace-active' : '';
    workspaceBtn.onclick = (e) => {
      e.stopPropagation();
      showWorkspaceModal(bookmark.id, bookmark.title, displayTitle, metadata.workspace);
    };
    actions.appendChild(workspaceBtn);

    // Close folder tabs button
    const closeFolderBtn = document.createElement('button');
    closeFolderBtn.innerHTML = '🚪';
    closeFolderBtn.title = 'Close Tabs';
    closeFolderBtn.onclick = (e) => {
      e.stopPropagation();
      pendingFolderId = bookmark.id;
      showModal(displayTitle);
    };
    actions.appendChild(closeFolderBtn);
  }

  // Delete button
  const deleteBtn = document.createElement('button');
  deleteBtn.textContent = '×';
  deleteBtn.title = 'Delete';
  deleteBtn.onclick = (e) => {
    e.stopPropagation();
    if (confirm(`Delete "${displayTitle}"?`)) {
      chrome.bookmarks.remove(bookmark.id, async () => {
        await loadOpenTabs();
        applyCurrentFilters();
      });
    }
  };
  actions.appendChild(deleteBtn);

  content.appendChild(actions);
  div.appendChild(content);

  // Drag and drop event listeners
  div.addEventListener('dragstart', handleDragStart);
  div.addEventListener('dragend', handleDragEnd);
  div.addEventListener('dragover', handleDragOver);
  div.addEventListener('drop', handleDrop);
  div.addEventListener('dragleave', handleDragLeave);

  return div;
}

function toggleFolder(folderId) {
  if (collapsedFolders.has(folderId)) {
    collapsedFolders.delete(folderId);
  } else {
    collapsedFolders.add(folderId);
  }
  applyCurrentFilters();
}

// Drag and drop handlers
function handleDragStart(e) {
  draggedElement = e.currentTarget;
  draggedBookmark = {
    id: draggedElement.dataset.id,
    parentId: draggedElement.dataset.parentId,
    index: parseInt(draggedElement.dataset.index)
  };
  draggedElement.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';

  // Set data for dropping onto active tabs panel
  if (draggedElement.dataset.url) {
    e.dataTransfer.setData('bookmark-url', draggedElement.dataset.url);
    e.dataTransfer.setData('bookmark-title', draggedElement.dataset.title);
  }
}

function handleDragEnd(e) {
  draggedElement.classList.remove('dragging');
  document.querySelectorAll('.drag-over').forEach(el => {
    el.classList.remove('drag-over');
  });
}

function handleDragOver(e) {
  e.preventDefault();
  const target = e.target.closest('.bookmark-folder, .bookmark-item');
  if (target && target !== draggedElement) {
    target.classList.add('drag-over');
  }
}

function handleDragLeave(e) {
  const target = e.target.closest('.bookmark-folder, .bookmark-item');
  if (target) {
    target.classList.remove('drag-over');
  }
}

function handleDrop(e) {
  e.preventDefault();
  e.stopPropagation();

  const dropTarget = e.target.closest('.bookmark-folder, .bookmark-item');
  if (!dropTarget) return;

  dropTarget.classList.remove('drag-over');

  // Check if this is a tab being dropped (to create bookmark)
  const tabUrl = e.dataTransfer.getData('tab-url');
  if (tabUrl) {
    const tabTitle = e.dataTransfer.getData('tab-title');
    const isFolder = dropTarget.classList.contains('bookmark-folder');

    const createOptions = {
      parentId: isFolder ? dropTarget.dataset.id : dropTarget.dataset.parentId,
      title: tabTitle,
      url: tabUrl
    };

    // If dropping on a bookmark, insert at that position
    if (!isFolder) {
      createOptions.index = parseInt(dropTarget.dataset.index);
    }

    chrome.bookmarks.create(createOptions, async () => {
      await loadOpenTabs();
      applyCurrentFilters();
    });
    return;
  }

  // Otherwise, it's a bookmark being reordered
  if (!draggedElement || dropTarget === draggedElement) return;

  const targetId = dropTarget.dataset.id;
  const targetParentId = dropTarget.dataset.parentId;
  const targetIndex = parseInt(dropTarget.dataset.index);

  if (dropTarget.classList.contains('bookmark-folder')) {
    // Move into folder
    chrome.bookmarks.move(draggedBookmark.id, {
      parentId: targetId,
      index: 0
    }, async () => {
      await loadOpenTabs();
      applyCurrentFilters();
    });
  } else {
    // Reorder in same parent
    let newIndex = targetIndex;

    // Chrome API quirk: moving down in same folder requires index adjustment
    if (draggedBookmark.parentId === targetParentId && draggedBookmark.index < newIndex) {
      newIndex++;
    }

    chrome.bookmarks.move(draggedBookmark.id, {
      parentId: targetParentId,
      index: newIndex
    }, async () => {
      await loadOpenTabs();
      applyCurrentFilters();
    });
  }
}
