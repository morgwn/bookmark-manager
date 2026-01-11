// State management
let reloadTimeout = null; //mqm for debounce fix
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

//------------------------------------------
// Filter Integration (uses FilterSystem from filters.js)
//------------------------------------------

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

//------------------------
// mqm search arrows (bork)
let selectedIndex = -1;
let searchResults = [];

// In search input event listener:
document.getElementById('searchInput').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    selectedIndex = Math.min(selectedIndex + 1, searchResults.length - 1);
    updateSelection();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    selectedIndex = Math.max(selectedIndex - 1, -1);
    updateSelection();
  } else if (e.key === 'Enter' && selectedIndex >= 0) {
    e.preventDefault();
    chrome.tabs.update({ url: searchResults[selectedIndex].url });
  }
});
//---------------------------

// Initialize on page load
document.addEventListener('DOMContentLoaded', async () => {
  console.log('DOMContentLoaded starting...');
  try {
    // Check if we're already in a workspace
    activeWorkspaceFolder = await WorkspaceManager.getActiveWorkspaceFolder();
    console.log('activeWorkspaceFolder:', activeWorkspaceFolder);
    updateWorkspaceUI();

    await loadOpenTabs();
    console.log('loadOpenTabs done, orderedTabs:', orderedTabs.length);
    await loadBookmarks();
    console.log('loadBookmarks done');
    renderActiveTabs();
    console.log('renderActiveTabs done');
    setupEventListeners();
    setupModalListeners();
    setupTabListeners();
    console.log('DOMContentLoaded complete');
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
  });

  document.getElementById('starFilterBtn').addEventListener('click', toggleStarFilter);

  document.getElementById('searchInput').addEventListener('input', (e) => {
    FilterSystem.setSearchQuery(e.target.value);
    applyCurrentFilters();
  });

  document.getElementById('closeWorkspaceBtn').addEventListener('click', deactivateWorkspace);

  document.getElementById('sortTabsBtn').addEventListener('click', sortTabsByWebsite);

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
      await chrome.tabs.create({ url: bookmarkUrl, active: false });
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
}

//------------------------------------
// mqm debounce fix

function setupTabListeners() {
  const scheduleReload = () => {
    // Cancel any pending reload
    if (reloadTimeout) {
      clearTimeout(reloadTimeout);
    }

    // Schedule new reload for 300ms from now
    reloadTimeout = setTimeout(async () => {
      await loadOpenTabs();
      applyCurrentFilters();
      renderActiveTabs();
      reloadTimeout = null;
    }, 300);
  };

  // Tab events
  chrome.tabs.onCreated.addListener(scheduleReload);
  chrome.tabs.onUpdated.addListener(scheduleReload);
  chrome.tabs.onRemoved.addListener(scheduleReload);
  chrome.tabs.onMoved.addListener(scheduleReload);
  chrome.tabs.onDetached.addListener(scheduleReload);
  chrome.tabs.onAttached.addListener(scheduleReload);

  // Bookmark events (to update indicator dots when bookmarks change)
  chrome.bookmarks.onCreated.addListener(scheduleReload);
  chrome.bookmarks.onRemoved.addListener(scheduleReload);
  chrome.bookmarks.onChanged.addListener(scheduleReload);
  chrome.bookmarks.onMoved.addListener(scheduleReload);
}

// function setupTabListeners() {
//   chrome.tabs.onCreated.addListener(async () => {
//     await loadOpenTabs();
//     await loadBookmarks();
//   });
  
//   chrome.tabs.onUpdated.addListener(async () => {
//     await loadOpenTabs();
//     await loadBookmarks();
//   });
  
//   chrome.tabs.onRemoved.addListener(async () => {
//     await loadOpenTabs();
//     await loadBookmarks();
//   });
// }

//------------------------------------

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
}

//------------------------------------------
// Workspace Activation UI
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
  const success = await WorkspaceManager.activate(workspaceId, {
    onLooseTabsPrompt: (tabCount) => showLooseTabsModal(tabCount),
    onComplete: async () => {
      activeWorkspaceFolder = await WorkspaceManager.getActiveWorkspaceFolder();
      updateWorkspaceUI();
      await loadOpenTabs();
      await loadBookmarks();
      renderActiveTabs();
    },
    onError: (error) => {
      alert('Error activating workspace: ' + error.message);
    }
  });
  return success;
}

async function deactivateWorkspace() {
  const success = await WorkspaceManager.deactivate({
    onComplete: async () => {
      activeWorkspaceFolder = null;
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

// Tab management
async function loadOpenTabs() {
  const window = await chrome.windows.getCurrent();
  const tabs = await chrome.tabs.query({ windowId: window.id });
  openTabUrls = new Set();
  openTabsMap = new Map();

  const extensionUrl = chrome.runtime.getURL('bookmarks.html');

  // Store ordered tabs for Active Tabs folder (exclude bookmark manager and chrome:// pages)
  orderedTabs = tabs.filter(tab =>
    !tab.url.startsWith('chrome://') &&
    !tab.url.startsWith('chrome-extension://') &&
    tab.url !== extensionUrl
  );

  tabs.forEach(tab => {
    const normalized = normalizeUrl(tab.url);
    openTabUrls.add(normalized);
    if (!openTabsMap.has(normalized)) {
      openTabsMap.set(normalized, []);
    }
    openTabsMap.get(normalized).push(tab.id);
  });
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
  
  if (openUrls.has(normalized)) return true;
  
  for (let openUrl of openUrls) {
    if (openUrl.startsWith(normalized) || normalized.startsWith(openUrl)) {
      return true;
    }
  }
  
  return false;
}

function getMatchingTabIds(bookmarkUrl) {
  const normalized = normalizeUrl(bookmarkUrl);
  
  if (openTabsMap.has(normalized)) {
    return openTabsMap.get(normalized);
  }
  
  const tabIds = [];
  for (let [openUrl, ids] of openTabsMap.entries()) {
    if (openUrl.startsWith(normalized) || normalized.startsWith(openUrl)) {
      tabIds.push(...ids);
    }
  }
  return tabIds;
}

//----------------------------------------------
// mqm fix race condition closing lots of tabs

async function closeBookmarkTab(bookmarkUrl) {
  const tabIds = getMatchingTabIds(bookmarkUrl);
  if (tabIds.length > 0) {
    try {
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

// async function closeBookmarkTab(bookmarkUrl) {
//   const tabIds = getMatchingTabIds(bookmarkUrl);
//   if (tabIds.length > 0) {
//     await chrome.tabs.remove(tabIds);
//     await loadOpenTabs();
//     await loadBookmarks();
//   }
// }

// async function closeFolderTabs(folderId, recursive) {
//   try {
//     const bookmark = await chrome.bookmarks.getSubTree(folderId);
//     const urls = collectBookmarkUrls(bookmark[0], recursive, 0);
    
//     const tabIds = [];
//     for (let url of urls) {
//       const ids = getMatchingTabIds(url);
//       tabIds.push(...ids);
//     }
    
//     if (tabIds.length > 0) {
//       await chrome.tabs.remove(tabIds);
//       await loadOpenTabs();
//       await loadBookmarks();
//     } else {
//       alert('No open tabs found for this folder');
//     }
//   } catch (error) {
//     console.error('Error closing folder tabs:', error);
//     alert('Error: ' + error.message);
//   }
// }

//-----------------------------------------

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
      await chrome.tabs.create({ url: url, active: false });
    }
  } catch (error) {
    console.error('Error opening folder bookmarks:', error);
    alert('Error: ' + error.message);
  }
}

// Rendering
let draggedTabId = null;

function renderActiveTabs() {
  console.log('renderActiveTabs called, orderedTabs:', orderedTabs.length);
  const container = document.getElementById('activeTabsList');
  console.log('activeTabsList container:', container);
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
        await chrome.tabs.create({ url: bookmarkUrl, index: tab.index, active: false });
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
      item.appendChild(indicator);
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
  console.log('loadBookmarks called, activeWorkspaceFolder:', activeWorkspaceFolder);
  try {
    // Build full bookmark URL set (for "external" indicator - dim dot)
    const fullTree = await chrome.bookmarks.getTree();
    allBookmarkUrls = new Set();
    buildBookmarkUrlSet(fullTree[0], allBookmarkUrls);

    // Reset workspace set
    workspaceBookmarkUrls = new Set();

    if (activeWorkspaceFolder) {
      // In workspace mode - also build workspace URL set (for "in workspace" indicator - bright dot)
      // Pass skipSession=true to exclude .session folder (saved session tabs aren't "real" bookmarks)
      console.log('Workspace mode, getting subtree for id:', activeWorkspaceFolder.id);
      const subtree = await chrome.bookmarks.getSubTree(activeWorkspaceFolder.id);
      buildBookmarkUrlSet(subtree[0], workspaceBookmarkUrls, true);
      console.log('Got subtree:', subtree);
      renderBookmarks([subtree[0]]);
    } else {
      // Normal mode - render all bookmarks
      console.log('Normal mode, getting full tree');
      renderBookmarks(fullTree[0].children);
    }
  } catch (error) {
    console.error('loadBookmarks error:', error);
  }
}

// Recursively collects all bookmark URLs from a node into the given Set
// skipSession: if true, skips .session folders (used for workspace set to exclude saved session tabs)
function buildBookmarkUrlSet(node, targetSet, skipSession = false) {
  // Skip .session folders when building workspace set (they're temporary storage, not real bookmarks)
  if (skipSession && node.title === '.session') return;

  if (node.url) {
    targetSet.add(normalizeUrl(node.url));
  }
  if (node.children) {
    node.children.forEach(child => buildBookmarkUrlSet(child, targetSet, skipSession));
  }
}

function renderBookmarks(bookmarks, parentElement = null, level = 0, parentCollapsed = false) {
  console.log('renderBookmarks called, bookmarks:', bookmarks, 'level:', level);
  const container = parentElement || document.getElementById('bookmarkTree');
  console.log('container:', container);
  if (!parentElement) container.innerHTML = '';

  bookmarks.forEach(bookmark => {
    // Hide .session folders (internal bookkeeping)
    if (bookmark.title === '.session') return;

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
    div.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      chrome.tabs.create({ url: bookmark.url, active: !e.shiftKey });
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
    openBtn.onclick = (e) => {
      e.stopPropagation();
      chrome.tabs.create({ url: bookmark.url, active: !e.shiftKey });
    };
    actions.appendChild(openBtn);
  } else {
    // Folder actions

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

//----------------------------------------
