let draggedElement = null;
let draggedBookmark = null;

document.addEventListener('DOMContentLoaded', () => {
  loadBookmarks();
  setupEventListeners();
});

function setupEventListeners() {
  document.getElementById('refreshBtn').addEventListener('click', loadBookmarks);
  document.getElementById('searchInput').addEventListener('input', (e) => {
    filterBookmarks(e.target.value);
  });
}

async function loadBookmarks() {
  const tree = await chrome.bookmarks.getTree();
  renderBookmarks(tree[0].children);
}

function renderBookmarks(bookmarks, parentElement = null, level = 0) {
  const container = parentElement || document.getElementById('bookmarkTree');
  if (!parentElement) container.innerHTML = '';

  bookmarks.forEach(bookmark => {
    const item = createBookmarkElement(bookmark, level);
    container.appendChild(item);

    if (bookmark.children && bookmark.children.length > 0) {
      renderBookmarks(bookmark.children, container, level + 1);
    }
  });
}

function createBookmarkElement(bookmark, level) {
  const div = document.createElement('div');
  div.className = bookmark.children ? 'bookmark-folder' : 'bookmark-item';
  div.dataset.id = bookmark.id;
  div.dataset.parentId = bookmark.parentId;
  div.dataset.index = bookmark.index;
  div.draggable = true;

  const content = document.createElement('div');
  content.className = 'bookmark-content';
  content.style.paddingLeft = `${16 + (level * 26)}px`;

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
      chrome.bookmarks.remove(bookmark.id, loadBookmarks);
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

  // If dropping on a folder, move into it at position 0
  if (dropTarget.classList.contains('bookmark-folder')) {
    chrome.bookmarks.move(draggedBookmark.id, {
      parentId: targetId,
      index: 0
    }, () => {
      loadBookmarks();
    });
  } else {
    // Reordering: move to the same parent as the drop target
    let newIndex = targetIndex;
    
    // Apply Chrome API quirk fix: if moving down in same parent, increment index
    if (draggedBookmark.parentId === targetParentId && draggedBookmark.index < newIndex) {
      newIndex++;
    }

    chrome.bookmarks.move(draggedBookmark.id, {
      parentId: targetParentId,
      index: newIndex
    }, () => {
      loadBookmarks();
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
      const item = createBookmarkElement(bookmark, 0);
      container.appendChild(item);
    });
  });
}
