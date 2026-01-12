//==========================================
// WORKSPACE MANAGER
// Handles workspace activation, session save/restore
//==========================================

const WorkspaceManager = {

  //==========================================
  // CONFIGURATION
  //==========================================
  PRESERVE_TAB_STATE: false, // true = storage windows (keeps tabs alive), false = close/reopen
  SESSION_FOLDER_NAME: '.session',
  STORAGE_KEY: 'activeWorkspaces',
  STORAGE_WINDOWS_KEY: 'storageWindows',

  //==========================================
  // SHARED: Active Workspace Tracking
  //==========================================
  async getActiveWorkspace(windowId) {
    const result = await chrome.storage.local.get(this.STORAGE_KEY);
    const workspaces = result[this.STORAGE_KEY] || {};
    return workspaces[windowId] || null;
  },

  async setActiveWorkspace(windowId, workspaceId) {
    const result = await chrome.storage.local.get(this.STORAGE_KEY);
    const workspaces = result[this.STORAGE_KEY] || {};
    workspaces[windowId] = workspaceId;
    await chrome.storage.local.set({ [this.STORAGE_KEY]: workspaces });
  },

  async clearActiveWorkspace(windowId) {
    const result = await chrome.storage.local.get(this.STORAGE_KEY);
    const workspaces = result[this.STORAGE_KEY] || {};
    delete workspaces[windowId];
    await chrome.storage.local.set({ [this.STORAGE_KEY]: workspaces });
  },

  //==========================================
  // SHARED: Tab Utilities
  //==========================================
  async getBookmarkManagerTabId(windowId) {
    const tabs = await chrome.tabs.query({ windowId });
    const extensionUrl = chrome.runtime.getURL('bookmarks.html');
    const bmTab = tabs.find(t => t.url === extensionUrl || t.url.startsWith(extensionUrl));
    return bmTab ? bmTab.id : null;
  },

  async getCurrentWindowTabs() {
    const window = await chrome.windows.getCurrent();
    const tabs = await chrome.tabs.query({ windowId: window.id });
    const bmTabId = await this.getBookmarkManagerTabId(window.id);

    return tabs.filter(t =>
      t.id !== bmTabId &&
      !t.url.startsWith('chrome://') &&
      !t.url.startsWith('chrome-extension://')
    );
  },

  //==========================================
  // MODE A: Storage Windows (PRESERVE_TAB_STATE=true)
  // Swaps tabs with minimized windows to preserve state
  //==========================================
  async getStorageWindowId(workspaceId) {
    const result = await chrome.storage.local.get(this.STORAGE_WINDOWS_KEY);
    const windows = result[this.STORAGE_WINDOWS_KEY] || {};
    const windowId = windows[workspaceId];

    if (windowId) {
      try {
        await chrome.windows.get(windowId);
        return windowId;
      } catch {
        delete windows[workspaceId];
        await chrome.storage.local.set({ [this.STORAGE_WINDOWS_KEY]: windows });
        return null;
      }
    }
    return null;
  },

  async setStorageWindowId(workspaceId, windowId) {
    const result = await chrome.storage.local.get(this.STORAGE_WINDOWS_KEY);
    const windows = result[this.STORAGE_WINDOWS_KEY] || {};
    windows[workspaceId] = windowId;
    await chrome.storage.local.set({ [this.STORAGE_WINDOWS_KEY]: windows });
  },

  async clearStorageWindowId(workspaceId) {
    const result = await chrome.storage.local.get(this.STORAGE_WINDOWS_KEY);
    const windows = result[this.STORAGE_WINDOWS_KEY] || {};
    delete windows[workspaceId];
    await chrome.storage.local.set({ [this.STORAGE_WINDOWS_KEY]: windows });
  },

  async moveTabsToStorage(workspaceId, tabs) {
    if (tabs.length === 0) return;

    let storageWindowId = await this.getStorageWindowId(workspaceId);

    if (!storageWindowId) {
      const newWindow = await chrome.windows.create({
        tabId: tabs[0].id,
        state: 'minimized'
      });
      storageWindowId = newWindow.id;
      await this.setStorageWindowId(workspaceId, storageWindowId);
      tabs = tabs.slice(1);
    }

    if (tabs.length > 0) {
      try {
        await chrome.tabs.move(tabs.map(t => t.id), { windowId: storageWindowId, index: -1 });
      } catch (e) {
        console.error('[workspace] Move to storage failed:', e);
      }
    }
  },

  async getStorageTabs(workspaceId) {
    const storageWindowId = await this.getStorageWindowId(workspaceId);
    if (!storageWindowId) return [];

    try {
      return await chrome.tabs.query({ windowId: storageWindowId });
    } catch {
      await this.clearStorageWindowId(workspaceId);
      return [];
    }
  },

  async moveTabsFromStorage(workspaceId, targetWindowId) {
    const tabs = await this.getStorageTabs(workspaceId);
    if (tabs.length === 0) return 0;

    try {
      await chrome.tabs.move(tabs.map(t => t.id), { windowId: targetWindowId, index: -1 });
      return tabs.length;
    } catch (e) {
      console.error('[workspace] Move from storage failed:', e);
      return 0;
    }
  },

  //==========================================
  // MODE B: Bookmarks (PRESERVE_TAB_STATE=false)
  // Saves URLs to bookmarks, closes tabs, reopens on restore
  //==========================================
  async getOrCreateSessionFolder(workspaceId) {
    const children = await chrome.bookmarks.getChildren(workspaceId);
    const existing = children.find(c => c.title === this.SESSION_FOLDER_NAME);

    if (existing) {
      return existing.id;
    }

    const folder = await chrome.bookmarks.create({
      parentId: workspaceId,
      title: this.SESSION_FOLDER_NAME,
      index: 0
    });
    return folder.id;
  },

  async getSessionTabs(workspaceId) {
    const children = await chrome.bookmarks.getChildren(workspaceId);
    const sessionFolder = children.find(c => c.title === this.SESSION_FOLDER_NAME);

    if (!sessionFolder) {
      return [];
    }

    const bookmarks = await chrome.bookmarks.getChildren(sessionFolder.id);
    return bookmarks
      .filter(b => b.url)
      .map(b => ({ url: b.url, title: b.title }));
  },

  async saveCurrentTabs(workspaceId) {
    const sessionFolderId = await this.getOrCreateSessionFolder(workspaceId);

    // Clear existing session bookmarks (parallel)
    const existing = await chrome.bookmarks.getChildren(sessionFolderId);
    await Promise.all(existing.map(b => chrome.bookmarks.remove(b.id)));

    // Save current tabs as bookmarks (parallel)
    const tabs = await this.getCurrentWindowTabs();
    await Promise.all(tabs.map(tab =>
      chrome.bookmarks.create({
        parentId: sessionFolderId,
        title: tab.title || tab.url,
        url: tab.url
      })
    ));

    return tabs.length;
  },

  async restoreTabs(workspaceId) {
    const tabs = await this.getSessionTabs(workspaceId);
    // Open all tabs in parallel
    await Promise.all(tabs.map(tab =>
      chrome.tabs.create({ url: tab.url, active: false })
    ));
    return tabs.length;
  },

  async closeAllTabs(windowId, exceptTabId) {
    const tabs = await chrome.tabs.query({ windowId });
    const tabsToClose = tabs.filter(t => t.id !== exceptTabId);

    if (tabsToClose.length > 0) {
      await chrome.tabs.remove(tabsToClose.map(t => t.id));
    }
  },

  //==========================================
  // ORCHESTRATION
  //==========================================
  async activate(workspaceId, callbacks = {}) {
    const { onLooseTabsPrompt, onComplete, onError } = callbacks;

    try {
      const window = await chrome.windows.getCurrent();
      const windowId = window.id;
      const currentWorkspaceId = await this.getActiveWorkspace(windowId);
      const currentTabs = await this.getCurrentWindowTabs();
      const bmTabId = await this.getBookmarkManagerTabId(windowId);

      // Handle loose tabs (not in a workspace)
      if (!currentWorkspaceId && currentTabs.length > 0 && onLooseTabsPrompt) {
        const choice = await onLooseTabsPrompt(currentTabs.length);
        if (choice === 'discard') {
          await chrome.tabs.remove(currentTabs.map(t => t.id));
        } else if (choice !== 'bring-in') {
          return false;
        }
      }

      if (this.PRESERVE_TAB_STATE) {
        // MODE A: Swap with storage windows
        if (currentWorkspaceId && currentTabs.length > 0) {
          await this.moveTabsToStorage(currentWorkspaceId, currentTabs);
        }
        const restored = await this.moveTabsFromStorage(workspaceId, windowId);
        if (restored === 0) {
          await this.restoreTabs(workspaceId);
        }
      } else {
        // MODE B: Save to bookmarks, close, reopen
        if (currentWorkspaceId) {
          await this.saveCurrentTabs(currentWorkspaceId);
        }
        await this.closeAllTabs(windowId, bmTabId);
        await this.restoreTabs(workspaceId);
      }

      await this.setActiveWorkspace(windowId, workspaceId);
      if (onComplete) await onComplete();
      return true;

    } catch (error) {
      console.error('WorkspaceManager.activate error:', error);
      if (onError) onError(error);
      return false;
    }
  },

  async deactivate(callbacks = {}) {
    const { onComplete, onError } = callbacks;

    try {
      const window = await chrome.windows.getCurrent();
      const windowId = window.id;
      const currentWorkspaceId = await this.getActiveWorkspace(windowId);

      if (!currentWorkspaceId) return false;

      const currentTabs = await this.getCurrentWindowTabs();
      const bmTabId = await this.getBookmarkManagerTabId(windowId);

      if (this.PRESERVE_TAB_STATE) {
        // MODE A: Move to storage window
        if (currentTabs.length > 0) {
          await this.moveTabsToStorage(currentWorkspaceId, currentTabs);
        }
      } else {
        // MODE B: Save to bookmarks and close
        await this.saveCurrentTabs(currentWorkspaceId);
        await this.closeAllTabs(windowId, bmTabId);
      }

      await this.clearActiveWorkspace(windowId);
      if (onComplete) await onComplete();
      return true;

    } catch (error) {
      console.error('WorkspaceManager.deactivate error:', error);
      if (onError) onError(error);
      return false;
    }
  },

  //==========================================
  // UTILITIES
  //==========================================
  async getCurrentWindowId() {
    const window = await chrome.windows.getCurrent();
    return window.id;
  },

  async isInWorkspace() {
    const windowId = await this.getCurrentWindowId();
    const workspaceId = await this.getActiveWorkspace(windowId);
    return workspaceId !== null;
  },

  async getActiveWorkspaceFolder() {
    const windowId = await this.getCurrentWindowId();
    const workspaceId = await this.getActiveWorkspace(windowId);

    if (!workspaceId) return null;

    try {
      const results = await chrome.bookmarks.get(workspaceId);
      return results[0] || null;
    } catch {
      await this.clearActiveWorkspace(windowId);
      return null;
    }
  }
};
