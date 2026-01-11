//==========================================
// WORKSPACE MANAGER
// Handles workspace activation, session save/restore
//==========================================

const WorkspaceManager = {
  //------------------------------------------
  // Configuration
  //------------------------------------------
  SESSION_FOLDER_NAME: '.session',
  STORAGE_KEY: 'activeWorkspaces',

  //------------------------------------------
  // Active Workspace Tracking (chrome.storage.local)
  //------------------------------------------
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

  //------------------------------------------
  // Session Folder Management
  //------------------------------------------
  async getOrCreateSessionFolder(workspaceId) {
    // Look for existing .session folder
    const children = await chrome.bookmarks.getChildren(workspaceId);
    const existing = children.find(c => c.title === this.SESSION_FOLDER_NAME);

    if (existing) {
      return existing.id;
    }

    // Create .session folder
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

  //------------------------------------------
  // Tab Operations
  //------------------------------------------
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

    // Filter out bookmark manager tab and chrome:// pages
    return tabs.filter(t =>
      t.id !== bmTabId &&
      !t.url.startsWith('chrome://') &&
      !t.url.startsWith('chrome-extension://')
    );
  },

  async closeAllTabs(windowId, exceptTabId) {
    const tabs = await chrome.tabs.query({ windowId });
    const tabsToClose = tabs.filter(t => t.id !== exceptTabId);

    if (tabsToClose.length > 0) {
      await chrome.tabs.remove(tabsToClose.map(t => t.id));
    }
  },

  async openTabs(tabs) {
    for (const tab of tabs) {
      await chrome.tabs.create({ url: tab.url, active: false });
    }
  },

  //------------------------------------------
  // Save/Restore Operations
  //------------------------------------------
  async saveCurrentTabs(workspaceId) {
    const sessionFolderId = await this.getOrCreateSessionFolder(workspaceId);

    // Clear existing session bookmarks
    const existing = await chrome.bookmarks.getChildren(sessionFolderId);
    for (const bookmark of existing) {
      await chrome.bookmarks.remove(bookmark.id);
    }

    // Get current tabs (excluding bookmark manager)
    const tabs = await this.getCurrentWindowTabs();

    // Save each tab as a bookmark
    for (const tab of tabs) {
      await chrome.bookmarks.create({
        parentId: sessionFolderId,
        title: tab.title || tab.url,
        url: tab.url
      });
    }

    return tabs.length;
  },

  async restoreTabs(workspaceId) {
    const tabs = await this.getSessionTabs(workspaceId);
    await this.openTabs(tabs);
    return tabs.length;
  },

  //------------------------------------------
  // High-Level Orchestration
  //------------------------------------------
  async activate(workspaceId, callbacks = {}) {
    const { onLooseTabsPrompt, onComplete, onError } = callbacks;

    try {
      const window = await chrome.windows.getCurrent();
      const windowId = window.id;
      const bmTabId = await this.getBookmarkManagerTabId(windowId);

      // Check if already in a workspace
      const currentWorkspaceId = await this.getActiveWorkspace(windowId);

      if (currentWorkspaceId) {
        // Save current workspace first
        await this.saveCurrentTabs(currentWorkspaceId);
        await this.closeAllTabs(windowId, bmTabId);
      } else {
        // Check for loose tabs
        const looseTabs = await this.getCurrentWindowTabs();

        if (looseTabs.length > 0 && onLooseTabsPrompt) {
          // Ask user what to do with loose tabs
          const choice = await onLooseTabsPrompt(looseTabs.length);

          if (choice === 'bring-in') {
            // Keep tabs, will merge and save after restore
            // Don't close tabs
          } else if (choice === 'discard') {
            await this.closeAllTabs(windowId, bmTabId);
          } else {
            // User cancelled
            return false;
          }
        } else if (looseTabs.length > 0) {
          // No prompt callback, default to closing
          await this.closeAllTabs(windowId, bmTabId);
        }
      }

      // Restore workspace tabs
      await this.restoreTabs(workspaceId);

      // If we kept loose tabs (bring-in), save merged set
      const looseTabs = await this.getCurrentWindowTabs();
      if (looseTabs.length > 0 && !currentWorkspaceId) {
        // This means we had loose tabs and brought them in
        await this.saveCurrentTabs(workspaceId);
      }

      // Update binding
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
      const bmTabId = await this.getBookmarkManagerTabId(windowId);

      const currentWorkspaceId = await this.getActiveWorkspace(windowId);

      if (!currentWorkspaceId) {
        // Not in a workspace, nothing to do
        return false;
      }

      // Save current tabs
      await this.saveCurrentTabs(currentWorkspaceId);

      // Close tabs
      await this.closeAllTabs(windowId, bmTabId);

      // Clear binding
      await this.clearActiveWorkspace(windowId);

      if (onComplete) await onComplete();
      return true;

    } catch (error) {
      console.error('WorkspaceManager.deactivate error:', error);
      if (onError) onError(error);
      return false;
    }
  },

  //------------------------------------------
  // Utilities
  //------------------------------------------
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
      // Workspace bookmark may have been deleted
      await this.clearActiveWorkspace(windowId);
      return null;
    }
  }
};
