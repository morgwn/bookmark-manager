// State management
let reloadTimeout = null; //mqm for debounce fix
let draggedElement = null;
let draggedBookmark = null;
let collapsedFolders = new Set();
let openTabUrls = new Set();
let openTabsMap = new Map();
let pendingFolderId = null;
let pendingOpenFolderId = null;

// Metadata helpers for bookmark titles
// Format: "Title {*}" or "Title {*,pin,etc}" with space before brace
function parseBookmarkTitle(title) {
  if (!title) return { displayTitle: 'Untitled', metadata: { starred: false, _flags: [] } };

  const match = title.match(/^(.*?) \{([^}]*)\}$/);
  if (!match) {
    return { displayTitle: title, metadata: { starred: false, _flags: [] } };
  }

  const displayTitle = match[1] || 'Untitled';
  const flags = match[2].split(',').map(f => f.trim()).filter(f => f);

  return {
    displayTitle,
    metadata: {
      starred: flags.includes('*'),
      _flags: flags
    }
  };
}

function buildTitleWithMetadata(displayTitle, metadata) {
  const flags = [...(metadata._flags || [])];

  // Update starred flag
  const starIndex = flags.indexOf('*');
  if (metadata.starred && starIndex === -1) {
    flags.unshift('*');
  } else if (!metadata.starred && starIndex !== -1) {
    flags.splice(starIndex, 1);
  }

  if (flags.length === 0) return displayTitle;
  return `${displayTitle} {${flags.join(',')}}`;
}

async function toggleStarred(bookmarkId, currentTitle) {
  const parsed = parseBookmarkTitle(currentTitle);
  parsed.metadata.starred = !parsed.metadata.starred;
  const newTitle = buildTitleWithMetadata(parsed.displayTitle, parsed.metadata);

  await chrome.bookmarks.update(bookmarkId, { title: newTitle });
  await loadBookmarks();
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
  await loadOpenTabs();
  await loadBookmarks();
  setupEventListeners();
  setupModalListeners();
  setupTabListeners();
});

// Setup event listeners
function setupEventListeners() {
  document.getElementById('refreshBtn').addEventListener('click', async () => {
    await loadOpenTabs();
    await loadBookmarks();
  });
  
  document.getElementById('searchInput').addEventListener('input', (e) => {
    filterBookmarks(e.target.value);
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
      await loadBookmarks();
      reloadTimeout = null;
    }, 300);
  };
    
  chrome.tabs.onCreated.addListener(scheduleReload);
  chrome.tabs.onUpdated.addListener(scheduleReload);
  chrome.tabs.onRemoved.addListener(scheduleReload);
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

// Tab management
async function loadOpenTabs() {
  const tabs = await chrome.tabs.query({});
  openTabUrls = new Set();
  openTabsMap = new Map();
  
  tabs.forEach(tab => {
    const normalized = normalizeUrl(tab.url);
    openTabUrls.add(normalized);
    if (!openTabsMap.has(normalized)) {
      openTabsMap.set(normalized, []);
    }
    openTabsMap.get(normalized).push(tab.id);
  });
}

function normalizeUrl(url) {
  if (!url) return '';
  try {
    let normalized = url.toLowerCase();
    normalized = normalized.replace(/^https?:\/\//, '');
    normalized = normalized.replace(/^www\./, '');
    normalized = normalized.replace(/\/$/, '');
    normalized = normalized.split('?')[0].split('#')[0];
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
    await loadBookmarks();
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
      await loadBookmarks();
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
async function loadBookmarks() {
  const tree = await chrome.bookmarks.getTree();
  renderBookmarks(tree[0].children);
}

function renderBookmarks(bookmarks, parentElement = null, level = 0, parentCollapsed = false) {
  const container = parentElement || document.getElementById('bookmarkTree');
  if (!parentElement) container.innerHTML = '';

  bookmarks.forEach(bookmark => {
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
  const { displayTitle, metadata } = parseBookmarkTitle(bookmark.title);

  const div = document.createElement('div');
  div.className = bookmark.children ? 'bookmark-folder' : 'bookmark-item';
  div.dataset.id = bookmark.id;
  div.dataset.parentId = bookmark.parentId;
  div.dataset.index = bookmark.index;
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
  
  // Orange dot indicator
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
  const icon = document.createElement('span');
  icon.className = 'icon';
  icon.textContent = bookmark.children ? '📁' : '🔖';

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

  // Star button (for both bookmarks and folders)
  const starBtn = document.createElement('button');
  starBtn.textContent = metadata.starred ? '★' : '☆';
  starBtn.title = metadata.starred ? 'Unstar' : 'Star';
  starBtn.className = metadata.starred ? 'starred' : '';
  starBtn.onclick = async (e) => {
    e.stopPropagation();
    await toggleStarred(bookmark.id, bookmark.title);
  };
  actions.appendChild(starBtn);

  if (!bookmark.children) {
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
        await loadBookmarks();
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
  loadBookmarks();
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
  if (!dropTarget || !draggedElement || dropTarget === draggedElement) {
    return;
  }

  dropTarget.classList.remove('drag-over');

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
      await loadBookmarks();
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
      await loadBookmarks();
    });
  }
}

//-------------------------------------
// Filter but leave tree structure

function filterBookmarks(query) {
  if (!query.trim()) {
    loadBookmarks();
    return;
  }

  chrome.bookmarks.search(query, (results) => {
    if (results.length === 0) {
      const container = document.getElementById('bookmarkTree');
      container.innerHTML = '<div class="no-results">No bookmarks found</div>';
      return;
    }
    
    // Get matching bookmark IDs
    const matchingIds = new Set(results.map(r => r.id));
    
    // Build tree with matching items and their parents
    chrome.bookmarks.getTree((tree) => {
      const filteredTree = filterTree(tree[0].children, matchingIds);
      renderBookmarks(filteredTree);
    });
  });
}

function filterTree(bookmarks, matchingIds, level = 0) {
  const filtered = [];
  
  for (let bookmark of bookmarks) {
    if (bookmark.children) {
      // It's a folder - recursively filter children
      const filteredChildren = filterTree(bookmark.children, matchingIds, level + 1);
      
      // Include folder if it has matching children OR if folder itself matches
      if (filteredChildren.length > 0 || matchingIds.has(bookmark.id)) {
        filtered.push({
          ...bookmark,
          children: filteredChildren
        });
      }
    } else {
      // It's a bookmark - include if it matches
      if (matchingIds.has(bookmark.id)) {
        filtered.push(bookmark);
      }
    }
  }
  
  return filtered;
}

// // Search/filter
// function filterBookmarks(query) {
//   if (!query.trim()) {
//     loadBookmarks();
//     return;
//   }

//   chrome.bookmarks.search(query, (results) => {
//     const container = document.getElementById('bookmarkTree');
//     container.innerHTML = '';
    
//     if (results.length === 0) {
//       container.innerHTML = '<div class="no-results">No bookmarks found</div>';
//       return;
//     }

//     results.forEach(bookmark => {
//       const item = createBookmarkElement(bookmark, 0, false, false);
//       container.appendChild(item);
//     });
//   });
// }

//----------------------------------------
