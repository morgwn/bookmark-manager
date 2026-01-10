let draggedElement = null;
let draggedBookmark = null;
let collapsedFolders = new Set();
let openTabUrls = new Set();

document.addEventListener('DOMContentLoaded', async () => {
  await loadOpenTabs();
  await loadBookmarks();
  setupEventListeners();
  setupTabListeners();
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

function setupTabListeners() {
  // Update dots when tabs are created, updated, or closed
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
  openTabUrls = new Set(tabs.map(tab => normalizeUrl(tab.url)));
  console.log('Open tabs loaded:', openTabUrls.size);
}

function normalizeUrl(url) {
  if (!url) return '';
  try {
    let normalized = url.toLowerCase();
    // Remove protocol entirely (http:// or https://)
    normalized = normalized.replace(/^https?:\/\//, '');
    // Remove www. prefix
    normalized = normalized.replace(/^www\./, '');
    // Remove trailing slash
    normalized = normalized.replace(/\/$/, '');
    // Remove common tracking parameters
    normalized = normalized.split('?')[0].split('#')[0];
    return normalized;
  } catch (e) {
    return url;
  }
}

function urlMatches(bookmarkUrl, openUrls) {
  if (!bookmarkUrl) return false;
  const normalized = normalizeUrl(bookmarkUrl);
  
  // Direct match
  if (openUrls.has(normalized)) return true;
  
  // Check if any open URL starts with the bookmark URL or vice versa
  for (let openUrl of openUrls) {
    if (openUrl.startsWith(normalized) || normalized.startsWith(openUrl)) {
      return true;
    }
  }
  
  return false;
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
  
  // Hide if parent is collapsed
  if (shouldHide) {
    div.style.display = 'none';
  }
  
  // Double-click to open bookmarks
  if (!bookmark.children && bookmark.url) {
    div.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      chrome.tabs.create({ url: bookmark.url });
    });
  }

  const content = document.createElement('div');
  content.className = 'bookmark-content';
  content.style.paddingLeft = `${16 + (level * 26)}px`;

  // Orange dot if tab is open - MOVED TO LEFT
  if (!bookmark.children && bookmark.url && urlMatches(bookmark.url, openTabUrls)) {
    const dot = document.createElement('span');
    dot.className = 'open-indicator';
    dot.title = 'Tab is open';
    content.appendChild(dot);
  } else if (!bookmark.children) {
    // Empty spacer to keep alignment
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
    const openBtn = document.createElement('button');
    openBtn.textContent = '↗';
    openBtn.title = 'Open';
    openBtn.onclick = (e) => {
      e.stopPropagation();
      chrome.tabs.create({ url: bookmark.url });
    };
    actions.appendChild(openBtn);
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
