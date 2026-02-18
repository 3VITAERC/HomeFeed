/**
 * Centralized state management for LocalFeed.
 * All application state is stored and managed here.
 */

// Constants
export const BATCH_SIZE = 50;
export const DOUBLE_TAP_DELAY = 300; // ms
export const IMAGE_POOL_BUFFER = 5;

/**
 * Application state object
 * All state variables are stored here for easy access and debugging
 */
export const state = {
    // Image state
    images: [],              // Current displayed images (changes based on mode)
    allImages: [],           // Backup when in favorites mode
    savedImages: [],         // Backup when in folder mode
    unshuffledImages: [],    // Backup of images before shuffle
    currentIndex: 0,
    slidesCreated: 0,
    
    // Lazy slide creation state
    deferredQueue: [],       // Queue of slide indices waiting to be created
    deferredRicId: null,     // requestIdleCallback ID for deferred creation
    immediateBuffer: 10,     // Number of slides to create immediately around current position
    chunkSize: 50,           // Slides to create per idle callback
    
    // Global audio state (owned by viewport.js, mirrored here for inspection)
    globalMuted: true,

    // User preferences
    shuffleEnabled: false,
    sortOrder: 'newest',     // 'newest' = New → Old, 'oldest' = Old → New
    currentSortOrder: 'newest', // Current active sort order (persists across view modes)
    
    // Optimization settings (loaded from server)
    optimizations: {
        thumbnail_cache: false,
        video_poster_cache: false,
        fill_screen: false,
        auto_advance: false,
        auto_advance_delay: 3
    },
    
    // User data
    favorites: new Set(),    // Set of favorited image paths
    trash: new Set(),        // Set of trashed image paths
    
    // View modes
    showingFavoritesOnly: false,
    showingTrashOnly: false,
    showingFolderOnly: false,
    currentFolderFilter: null,
    
    // Folder state
    savedIndex: 0,           // Saved position before entering folder mode
    
    // Top nav state
    topNavFolders: [],       // Array of {path, name, count, newest_mtime}
    topNavLoaded: false,     // Whether folders have been loaded
    currentTopNavFolder: 'all', // Current folder selection ('all' or folder path)
    
    // UI state
    lastTapTime: 0,
};

/**
 * Get dynamic preload count based on library size
 * Large libraries (1000+ images) preload less aggressively to reduce memory pressure
 * 
 * @returns {number} Number of images to preload
 */
export function getPreloadCount() {
    return state.images.length > 1000 ? 1 : 3;
}

/**
 * Reset state to initial values
 * Useful for testing or complete refresh
 */
export function resetState() {
    state.images = [];
    state.allImages = [];
    state.savedImages = [];
    state.unshuffledImages = [];
    state.currentIndex = 0;
    state.slidesCreated = 0;
    state.deferredQueue = [];
    state.deferredRicId = null;
    state.globalMuted = true;
    state.shuffleEnabled = false;
    state.sortOrder = 'newest';
    state.favorites = new Set();
    state.trash = new Set();
    state.showingFavoritesOnly = false;
    state.showingTrashOnly = false;
    state.showingFolderOnly = false;
    state.currentFolderFilter = null;
    state.savedIndex = 0;
    state.topNavFolders = [];
    state.topNavLoaded = false;
    state.currentTopNavFolder = 'all';
    state.lastTapTime = 0;
}

/**
 * Enter a view mode (favorites, trash, or folder)
 * Saves current state for restoration later
 * 
 * @param {string} mode - The mode to enter ('favorites', 'trash', 'folder')
 * @param {string|null} folderPath - Folder path for folder mode
 */
export function enterMode(mode, folderPath = null) {
    // Save current position
    state.savedIndex = state.currentIndex;
    
    if (mode === 'favorites') {
        state.allImages = [...state.images];
        state.showingFavoritesOnly = true;
    } else if (mode === 'trash') {
        state.showingTrashOnly = true;
    } else if (mode === 'folder') {
        state.savedImages = [...state.images];
        state.showingFolderOnly = true;
        state.currentFolderFilter = folderPath;
    }
}

/**
 * Exit a view mode
 * Restores previous state
 * 
 * @param {string} mode - The mode to exit ('favorites', 'trash', or 'folder')
 */
export function exitMode(mode) {
    if (mode === 'favorites') {
        state.showingFavoritesOnly = false;
        // Check if also in folder mode
        if (state.showingFolderOnly) {
            // Stay in folder mode, reload folder images
        } else {
            // Restore from backup
            state.images = [...state.allImages];
        }
        state.allImages = [];
    } else if (mode === 'trash') {
        state.showingTrashOnly = false;
    } else if (mode === 'folder') {
        state.showingFolderOnly = false;
        state.currentFolderFilter = null;
        // Check if also in favorites mode
        if (state.showingFavoritesOnly) {
            // Stay in favorites mode
        } else {
            // Restore from backup
            state.images = [...state.savedImages];
        }
        state.savedImages = [];
    }
}

/**
 * Check if any modal is currently open
 * 
 * @returns {boolean} True if any modal is open
 */
export function isAnyModalOpen() {
    const modals = [
        'settingsModal',
        'infoModal', 
        'foldersModal',
        'jumpModal',
        'shortcutsModal',
        'trashModal',
        'deleteConfirmModal'
    ];
    
    return modals.some(id => {
        const modal = document.getElementById(id);
        return modal && modal.style.display !== 'none' && modal.style.display !== '';
    });
}

export default {
    state,
    BATCH_SIZE,
    DOUBLE_TAP_DELAY,
    IMAGE_POOL_BUFFER,
    getPreloadCount,
    resetState,
    enterMode,
    exitMode,
    isAnyModalOpen,
};
