//==========================================
// FILTER SYSTEM
// Self-contained module for bookmark filtering
//==========================================

const FilterSystem = {
  //------------------------------------------
  // Configuration
  //------------------------------------------
  config: {
    starredOnly: false,
    starredFoldersExpandable: true,
    showContextParents: true,
    searchQuery: ''
  },

  //------------------------------------------
  // Metadata Parsing (title format: "Title {*,flag1,flag2}")
  //------------------------------------------
  parseTitle(title) {
    if (!title) return { displayTitle: 'Untitled', metadata: { starred: false, workspace: false, _flags: [] } };

    const match = title.match(/^(.*?) \{([^}]*)\}$/);
    if (!match) {
      return { displayTitle: title, metadata: { starred: false, workspace: false, _flags: [] } };
    }

    const displayTitle = match[1] || 'Untitled';
    const flags = match[2].split(',').map(f => f.trim()).filter(f => f);

    return {
      displayTitle,
      metadata: {
        starred: flags.includes('*'),
        workspace: flags.includes('workspace'),
        _flags: flags
      }
    };
  },

  buildTitle(displayTitle, metadata) {
    const flags = [...(metadata._flags || [])];

    // Handle starred flag
    const starIndex = flags.indexOf('*');
    if (metadata.starred && starIndex === -1) {
      flags.unshift('*');
    } else if (!metadata.starred && starIndex !== -1) {
      flags.splice(starIndex, 1);
    }

    // Handle workspace flag
    const workspaceIndex = flags.indexOf('workspace');
    if (metadata.workspace && workspaceIndex === -1) {
      flags.push('workspace');
    } else if (!metadata.workspace && workspaceIndex !== -1) {
      flags.splice(workspaceIndex, 1);
    }

    if (flags.length === 0) return displayTitle;
    return `${displayTitle} {${flags.join(',')}}`;
  },

  //------------------------------------------
  // Filter Predicates
  //------------------------------------------
  isStarred(bookmark) {
    const { metadata } = this.parseTitle(bookmark.title);
    return metadata.starred;
  },

  isWorkspace(bookmark) {
    const { metadata } = this.parseTitle(bookmark.title);
    return metadata.workspace;
  },

  hasStarredDescendant(bookmark) {
    if (this.isStarred(bookmark)) return true;
    if (bookmark.children) {
      return bookmark.children.some(child => this.hasStarredDescendant(child));
    }
    return false;
  },

  //------------------------------------------
  // Display Helpers
  //------------------------------------------
  getFilterMeta(bookmark) {
    return bookmark._filterMeta || { isStarred: false, isContext: false, expandable: true };
  },

  isContext(bookmark) {
    return this.getFilterMeta(bookmark).isContext;
  },

  isActive() {
    return this.config.starredOnly || this.config.searchQuery.trim() !== '';
  },

  //------------------------------------------
  // Core Filtering
  //------------------------------------------
  applyStarFilter(bookmarks) {
    const result = [];

    for (const bookmark of bookmarks) {
      const isStarred = this.isStarred(bookmark);
      const hasStarredDesc = bookmark.children
        ? bookmark.children.some(child => this.hasStarredDescendant(child))
        : false;

      if (isStarred || hasStarredDesc) {
        const item = {
          ...bookmark,
          _filterMeta: {
            isStarred,
            isContext: !isStarred && hasStarredDesc,
            expandable: isStarred || !this.config.starredOnly
          }
        };

        if (bookmark.children) {
          item.children = isStarred && this.config.starredFoldersExpandable
            ? bookmark.children.map(c => ({
                ...c,
                _filterMeta: { isStarred: this.isStarred(c), isContext: false, expandable: true }
              }))
            : this.applyStarFilter(bookmark.children);
        }

        result.push(item);
      }
    }

    return result;
  },

  filterTreeByIds(bookmarks, matchingIds) {
    const filtered = [];

    for (const bookmark of bookmarks) {
      if (bookmark.children) {
        const filteredChildren = this.filterTreeByIds(bookmark.children, matchingIds);
        if (filteredChildren.length > 0 || matchingIds.has(bookmark.id)) {
          filtered.push({ ...bookmark, children: filteredChildren });
        }
      } else {
        if (matchingIds.has(bookmark.id)) {
          filtered.push(bookmark);
        }
      }
    }

    return filtered;
  },

  //------------------------------------------
  // Main API
  //------------------------------------------
  apply(bookmarks, searchMatchIds = null) {
    let result = bookmarks;

    if (this.config.starredOnly) {
      result = this.applyStarFilter(result);
    }

    if (searchMatchIds) {
      result = this.filterTreeByIds(result, searchMatchIds);
    }

    return result;
  },

  setStarredOnly(enabled) {
    this.config.starredOnly = enabled;
  },

  setSearchQuery(query) {
    this.config.searchQuery = query;
  },

  toggleStarredOnly() {
    this.config.starredOnly = !this.config.starredOnly;
    return this.config.starredOnly;
  },

  reset() {
    this.config.starredOnly = false;
    this.config.searchQuery = '';
  }
};
