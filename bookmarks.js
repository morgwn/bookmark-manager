let draggedElement = null;
let draggedBookmark = null;
let collapsedFolders = new Set();
let openTabUrls = new Set();
let openTabsMap = new Map();
let pendingFolderId = null;

document.addEventListener('DOMContentLoaded', async () => {
  await loadOpenTabs();
  await loadBookmarks();
  setupEventListeners();
  setupTabListeners();
  setupModalListeners();
});

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
  document.getElementById('closeRecursive').addEventListener('click', async () => {
    console.log('Close recursive clicked, pendingFolderId:', pendingFolderId);
    closeModal();
    if (pendingFolderId) {
      await closeFolderTabs(pendingFolderId, true);
      pendingFolderId = null;
    }
  });
  
  document.getElementById('closeLevel').addEventListener('click', async () => {
    console.log('Close level clicked, pendingFolderId:', pendingFolderId);
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
}

function showModal(folderTitle) {
  console.log('showModal called for:', folderTitle);
  const modal = document.getElementById('closeModal');
  console.log('Modal element:', modal);
  const message = document.getElementById('modalMessage');
  console.log('Message element:', message);
  
  message.textContent = `Close all open tabs in "${folderTitle}"?`;
  modal.style.display = 'flex';
  
  console.log('Modal display set to:', modal.style.display);
}
//mqm
// function showModal(folderTitle) {
//   document.getElementById('modalMessage').textContent = 
//     `Close all open tabs in "${folderTitle}"?`;
//   document.getElementById('closeModal').style.display = 'flex';
// }

function closeModal() {
  document.getElementById('closeModal').style.display = 'none';
}

function setupTabListeners() {
  chrome.tabs.onCreated.addListener(async () => {
    await loadOpenTabs();
    await loadBookmarks();
  });
  
  chrome.tabs.onUpdated.addListener(async () => {
    await loadOpenTabs();
    await loadBookmarks();
  });
  
  chrome.tabs.onRemoved.addListener(async () => {
    await loadOpenTabs();
    await loadBookmarks();
  });
}

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
  
  console.log('Open tabs loaded:', openTabUrls.size);
  console.log('Tab map:', Array.from(openTabsMap.entries()));
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
  console.log('Looking for tabs matching:', bookmarkUrl, '-> normalized:', normalized);
  
  if (openTabsMap.has(normalized)) {
    console.log('  Direct match found:', openTabsMap.get(normalized));
    return openTabsMap.get(normalized);
  }
  
  const tabIds = [];
  for (let [openUrl, ids] of openTabsMap.entries()) {
    if (openUrl.startsWith(normalized) || normalized.startsWith(openUrl)) {
      console.log('  Fuzzy match found:', openUrl, ids);
      tabIds.push(...ids);
    }
  }
  return tabIds;
}

async function closeBookmarkTab(bookmarkUrl) {
  console.log('Closing bookmark tab:', bookmarkUrl);
  const tabIds = getMatchingTabIds(bookmarkUrl);
  console.log('Tab IDs to close:', tabIds);
  if (tabIds.length > 0) {
    await chrome.tabs.remove(tabIds);
    await loadOpenTabs();
    await loadBookmarks();
  }
}

async function closeFolderTabs(folderId, recursive) {
  console.log('=== closeFolderTabs called ===');
  console.log('Folder ID:', folderId, 'Recursive:', recursive);
  
  try {
    const bookmark = await chrome.bookmarks.getSubTree(folderId);
    console.log('Got subtree:', bookmark);
    
    const urls = collectBookmarkUrls(bookmark[0], recursive, 0);
    console.log('Collected URLs:', urls);
    
    const tabIds = [];
    for (let url of urls) {
      const ids = getMatchingTabIds(url);
      tabIds.push(...ids);
    }
    
    console.log('Total tab IDs to close:', tabIds);
    
    if (tabIds.length > 0) {
      await chrome.tabs.remove(tabIds);
      console.log('Tabs closed successfully');
      await loadOpenTabs();
      await loadBookmarks();
    } else {
      console.log('No matching tabs found');
      alert('No open tabs found for this folder');
    }
  } catch (error) {
    console.error('Error closing folder tabs:', error);
    alert('Error: ' + error.message);
  }
}

function collectBookmarkUrls(bookmark, recursive, depth) {
  console.log('collectBookmarkUrls:', bookmark.title, 'depth:', depth, 'recursive:', recursive);
  let urls = [];
  
  if (!bookmark.children) {
    return urls;
  }
  
  for (let child of bookmark.children) {
    if (child.url) {
      if (depth === 0 || recursive) {
        console.log('  Adding URL:', child.url);
        urls.push(child.url);
      }
    } else if (child.children) {
      if (recursive) {
        urls.push(...collectBookmarkUrls(child, recursive, depth + 1));
      } else if (depth === 0) {
        for (let grandchild of child.children) {
          if (grandchild.url) {
            console.log('  Adding URL from subfolder:', grandchild.url);
            urls.push(grandchild.url);
          }
        }
      }
    }
  }
  
  return urls;
}

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
  const div = document.createElement('div');
  div.className = bookmark.children ? 'bookmark-folder' : 'bookmark-item';
  div.dataset.id = bookmark.id;
  div.dataset.parentId = bookmark.parentId;
  div.dataset.index = bookmark.index;
  div.draggable = true;
  
  if (shouldHide) {
    div.style.display = 'none';
  }
  
  if (!bookmark.children && bookmark.url) {
    div.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      chrome.tabs.create({ url: bookmark.url });
    });
  }

  const content = document.createElement('div');
  content.className = 'bookmark-content';
  content.style.paddingLeft = `${16 + (level * 26)}px`;

  const isOpen = !bookmark.children && bookmark.url && urlMatches(bookmark.url, openTabUrls);
  
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

  const icon = document.createElement('span');
  icon.className = 'icon';
  icon.textContent = bookmark.children ? '📁' : '🔖';

  const title = document.createElement('span');
  title.className = 'title';
  title.textContent = bookmark.title || 'Untitled';

  content.appendChild(icon);
  content.appendChild(title);

  if (!bookmark.children && bookmark.url) {
    const url = document.createElement('span');
    url.className = 'url';
    url.textContent = bookmark.url;
    content.appendChild(url);
  }

  const actions = document.createElement('div');
  actions.className = 'actions';

  if (!bookmark.children) {
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
    
    const openBtn = document.createElement('button');
    openBtn.textContent = '↗';
    openBtn.title = 'Open';
    openBtn.onclick = (e) => {
      e.stopPropagation();
      chrome.tabs.create({ url: bookmark.url });
    };
    actions.appendChild(openBtn);
  } else {
    const closeFolderBtn = document.createElement('button');
    closeFolderBtn.innerHTML = '🚪';
    closeFolderBtn.title = 'Close Tabs';
    closeFolderBtn.onclick = (e) => {
      e.stopPropagation();
      console.log('Folder close button clicked for:', bookmark.title, bookmark.id);
      pendingFolderId = bookmark.id;
      showModal(bookmark.title);
    };
    actions.appendChild(closeFolderBtn);
  }

  const deleteBtn = document.createElement('button');
  deleteBtn.textContent = '×';
  deleteBtn.title = 'Delete';
  deleteBtn.onclick = (e) => {
    e.stopPropagation();
    if (confirm(`Delete "${bookmark.title}"?`)) {
      chrome.bookmarks.remove(bookmark.id, async () => {
        await loadOpenTabs();
        await loadBookmarks();
      });
    }
  };
  actions.appendChild(deleteBtn);

  content.appendChild(actions);
  div.appendChild(content);

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
    chrome.bookmarks.move(draggedBookmark.id, {
      parentId: targetId,
      index: 0
    }, async () => {
      await loadOpenTabs();
      await loadBookmarks();
    });
  } else {
    let newIndex = targetIndex;
    
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

function filterBookmarks(query) {
  if (!query.trim()) {
    loadBookmarks();
    return;
  }

  chrome.bookmarks.search(query, (results) => {
    const container = document.getElementById('bookmarkTree');
    container.innerHTML = '';
    
    if (results.length === 0) {
      container.innerHTML = '<div class="no-results">No bookmarks found</div>';
      return;
    }

    results.forEach(bookmark => {
      const item = createBookmarkElement(bookmark, 0, false, false);
      container.appendChild(item);
    });
  });
}
