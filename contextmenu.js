//==========================================
// CONTEXT MENU
// Generic right-click menu system
//==========================================

const ContextMenu = {
  element: null,

  init() {
    // Create menu element
    this.element = document.createElement('div');
    this.element.id = 'contextMenu';
    this.element.className = 'context-menu';
    document.body.appendChild(this.element);

    // Close on click outside
    document.addEventListener('click', () => this.hide());
    document.addEventListener('contextmenu', () => this.hide());

    // Close on escape
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.hide();
    });

    // Close on scroll
    document.addEventListener('scroll', () => this.hide(), true);
  },

  // Show menu at position with items
  // items: [{ label, action, disabled, separator }]
  show(x, y, items) {
    if (!this.element) this.init();

    // Build menu HTML
    this.element.innerHTML = items.map(item => {
      if (item.separator) {
        return '<div class="context-menu-separator"></div>';
      }
      const disabledClass = item.disabled ? ' disabled' : '';
      return `<div class="context-menu-item${disabledClass}" data-action="${item.id || ''}">${item.label}</div>`;
    }).join('');

    // Attach click handlers
    this.element.querySelectorAll('.context-menu-item:not(.disabled)').forEach((el, i) => {
      const item = items.filter(it => !it.separator)[i];
      if (item && item.action) {
        el.addEventListener('click', (e) => {
          e.stopPropagation();
          this.hide();
          item.action();
        });
      }
    });

    // Position menu
    this.element.style.display = 'block';

    // Adjust if near edges
    const rect = this.element.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    let finalX = x;
    let finalY = y;

    if (x + rect.width > viewportWidth) {
      finalX = viewportWidth - rect.width - 8;
    }
    if (y + rect.height > viewportHeight) {
      finalY = viewportHeight - rect.height - 8;
    }

    this.element.style.left = `${finalX}px`;
    this.element.style.top = `${finalY}px`;
  },

  hide() {
    if (this.element) {
      this.element.style.display = 'none';
    }
  }
};

// Inject CSS
const contextMenuStyles = document.createElement('style');
contextMenuStyles.textContent = `
.context-menu {
  display: none;
  position: fixed;
  z-index: 2000;
  min-width: 160px;
  background: #23272f;
  border: 1px solid #3a3f4b;
  border-radius: 6px;
  padding: 4px 0;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
}

.context-menu-item {
  padding: 8px 14px;
  font-size: 13px;
  color: #e4e6eb;
  cursor: pointer;
  transition: background 0.1s;
}

.context-menu-item:hover {
  background: #353a45;
}

.context-menu-item.disabled {
  color: #5c5f66;
  cursor: default;
}

.context-menu-item.disabled:hover {
  background: transparent;
}

.context-menu-separator {
  height: 1px;
  background: #3a3f4b;
  margin: 4px 8px;
}
`;
document.head.appendChild(contextMenuStyles);

// Initialize on load
document.addEventListener('DOMContentLoaded', () => ContextMenu.init());
