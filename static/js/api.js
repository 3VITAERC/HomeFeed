/**
 * API client for LocalFeed.
 * Provides functions for all backend API calls.
 */

/**
 * Make a GET request to the API
 * 
 * @param {string} endpoint - API endpoint path
 * @returns {Promise<any>} Response data
 */
async function get(endpoint) {
    const response = await fetch(endpoint);
    if (!response.ok) {
        throw new Error(`API error: ${response.status}`);
    }
    return response.json();
}

/**
 * Make a POST request to the API
 * 
 * @param {string} endpoint - API endpoint path
 * @param {object} data - Request body data
 * @returns {Promise<any>} Response data
 */
async function post(endpoint, data) {
    const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(data),
    });
    if (!response.ok) {
        throw new Error(`API error: ${response.status}`);
    }
    return response.json();
}

/**
 * Make a DELETE request to the API
 * 
 * @param {string} endpoint - API endpoint path
 * @param {object} data - Request body data
 * @returns {Promise<any>} Response data
 */
async function del(endpoint, data) {
    const response = await fetch(endpoint, {
        method: 'DELETE',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(data),
    });
    if (!response.ok) {
        throw new Error(`API error: ${response.status}`);
    }
    return response.json();
}

// ============ Images API ============

/**
 * Get list of all images
 * 
 * @param {string} sortOrder - Optional sort order ('newest', 'oldest')
 * @returns {Promise<string[]>} Array of image URLs
 */
export async function getImages(sortOrder) {
    if (sortOrder) {
        return get(`/api/images?sort=${sortOrder}`);
    }
    return get('/api/images');
}

/**
 * Get images from a specific folder
 * 
 * @param {string} folder - Folder path
 * @param {string} sortOrder - Optional sort order ('newest', 'oldest')
 * @returns {Promise<string[]>} Array of image URLs
 */
export async function getImagesByFolder(folder, sortOrder) {
    const encodedFolder = encodeURIComponent(folder);
    if (sortOrder) {
        return get(`/api/images/folder?folder=${encodedFolder}&sort=${sortOrder}`);
    }
    return get(`/api/images/folder?folder=${encodedFolder}`);
}

/**
 * Get image count and folder count
 * 
 * @returns {Promise<{imageCount: number, folderCount: number}>}
 */
export async function getImageCount() {
    return get('/api/image-count');
}

/**
 * Get metadata for an image
 * 
 * @param {string} imagePath - Image path
 * @returns {Promise<object>} Image metadata
 */
export async function getImageMetadata(imagePath) {
    const encodedPath = encodeURIComponent(imagePath);
    return get(`/api/metadata?path=${encodedPath}`);
}

// ============ Folders API ============

/**
 * Get list of configured folders
 * 
 * @returns {Promise<string[]>} Array of folder paths
 */
export async function getFolders() {
    return get('/api/folders');
}

/**
 * Get list of leaf folders (folders containing images)
 * 
 * @returns {Promise<Array<{path: string, name: string, count: number, newest_mtime: number}>>}
 */
export async function getLeafFolders() {
    return get('/api/folders/leaf');
}

/**
 * Add a folder to configuration
 * 
 * @param {string} path - Folder path to add
 * @returns {Promise<{success: boolean, folders: string[]}>}
 */
export async function addFolder(path) {
    return post('/api/folders', { path });
}

/**
 * Remove a folder from configuration
 * 
 * @param {string} path - Folder path to remove
 * @returns {Promise<{success: boolean, folders: string[]}>}
 */
export async function removeFolder(path) {
    return del('/api/folders', { path });
}

// ============ Favorites API ============

/**
 * Get list of favorite image paths
 * 
 * @returns {Promise<{favorites: string[]}>}
 */
export async function getFavorites() {
    return get('/api/favorites');
}

/**
 * Add image to favorites
 * 
 * @param {string} path - Image path to add
 * @returns {Promise<{success: boolean, favorites: string[]}>}
 */
export async function addFavorite(path) {
    return post('/api/favorites', { path });
}

/**
 * Remove image from favorites
 * 
 * @param {string} path - Image path to remove
 * @returns {Promise<{success: boolean, favorites: string[]}>}
 */
export async function removeFavorite(path) {
    return del('/api/favorites', { path });
}

/**
 * Get favorite images as URLs
 * 
 * @param {string} sortOrder - Optional sort order ('newest', 'oldest')
 * @returns {Promise<string[]>} Array of image URLs
 */
export async function getFavoriteImages(sortOrder) {
    if (sortOrder) {
        return get(`/api/favorites/images?sort=${sortOrder}`);
    }
    return get('/api/favorites/images');
}

/**
 * Get favorite images from a specific folder
 * 
 * @param {string} folder - Folder path
 * @returns {Promise<string[]>} Array of image URLs
 */
export async function getFavoriteImagesByFolder(folder) {
    const encodedFolder = encodeURIComponent(folder);
    return get(`/api/favorites/images/folder?folder=${encodedFolder}`);
}

/**
 * Get count of favorites
 * 
 * @returns {Promise<{count: number}>}
 */
export async function getFavoritesCount() {
    return get('/api/favorites/count');
}

// ============ Trash API ============

/**
 * Get list of trashed image paths
 * 
 * @returns {Promise<{trash: string[]}>}
 */
export async function getTrash() {
    return get('/api/trash');
}

/**
 * Add image to trash
 * 
 * @param {string} path - Image path to add
 * @returns {Promise<{success: boolean, trash: string[]}>}
 */
export async function addToTrash(path) {
    return post('/api/trash', { path });
}

/**
 * Remove image from trash
 * 
 * @param {string} path - Image path to remove
 * @returns {Promise<{success: boolean, trash: string[]}>}
 */
export async function removeFromTrash(path) {
    return del('/api/trash', { path });
}

/**
 * Get trashed images as URLs
 * 
 * @param {string} sortOrder - Optional sort order ('newest', 'oldest')
 * @returns {Promise<string[]>} Array of image URLs
 */
export async function getTrashImages(sortOrder) {
    if (sortOrder) {
        return get(`/api/trash/images?sort=${sortOrder}`);
    }
    return get('/api/trash/images');
}

/**
 * Get count of trashed images
 * 
 * @returns {Promise<{count: number}>}
 */
export async function getTrashCount() {
    return get('/api/trash/count');
}

/**
 * Empty trash - permanently delete all trashed images
 * 
 * @returns {Promise<{success: boolean, deleted_count: number, errors: Array}>}
 */
export async function emptyTrash() {
    return post('/api/trash/empty', {});
}

// ============ Settings API ============

/**
 * Get user settings
 * 
 * @returns {Promise<{shuffle: boolean, optimizations: object}>}
 */
export async function getSettings() {
    return get('/api/settings');
}

/**
 * Update user settings
 * 
 * @param {object} settings - Settings to update
 * @returns {Promise<{success: boolean, settings: object}>}
 */
export async function updateSettings(settings) {
    return post('/api/settings', settings);
}

// ============ Cache API ============

/**
 * Get cache information
 *
 * @returns {Promise<{files: number, size: number, size_formatted: string}>}
 */
export async function getCacheInfo() {
    return get('/api/cache');
}

/**
 * Clear all cached files
 *
 * @returns {Promise<{success: boolean, deleted_count: number, errors: Array}>}
 */
export async function clearCache() {
    return del('/api/cache', {});
}

// ============ Seen / Unseen API ============

/**
 * Mark a batch of image paths as seen on the server.
 *
 * @param {string[]} paths - Array of image URL strings (e.g. '/image?path=...')
 * @returns {Promise<{success: boolean, total_scrolls: number, seen_count: number}>}
 */
export async function markSeenBatch(paths) {
    return post('/api/seen/batch', { paths });
}

/**
 * Get unseen images as URLs (all images not yet marked seen).
 *
 * @param {string} sortOrder - Optional sort order ('newest', 'oldest')
 * @returns {Promise<string[]>} Array of image URL strings
 */
export async function getUnseenImages(sortOrder) {
    if (sortOrder) {
        return get(`/api/unseen/images?sort=${sortOrder}`);
    }
    return get('/api/unseen/images');
}

/**
 * Get seen statistics.
 *
 * @returns {Promise<{seen_count: number, total_count: number, total_scrolls: number, percent_seen: number}>}
 */
export async function getSeenStats() {
    return get('/api/seen/stats');
}

/**
 * Reset all seen history.
 *
 * @returns {Promise<{success: boolean}>}
 */
export async function resetSeen() {
    return del('/api/seen', {});
}

// Default export with all API functions
export default {
    // Images
    getImages,
    getImagesByFolder,
    getImageCount,
    getImageMetadata,
    // Folders
    getFolders,
    getLeafFolders,
    addFolder,
    removeFolder,
    // Favorites
    getFavorites,
    addFavorite,
    removeFavorite,
    getFavoriteImages,
    getFavoriteImagesByFolder,
    getFavoritesCount,
    // Trash
    getTrash,
    addToTrash,
    removeFromTrash,
    getTrashImages,
    getTrashCount,
    emptyTrash,
    // Settings
    getSettings,
    updateSettings,
    // Cache
    getCacheInfo,
    clearCache,
    // Seen / Unseen
    markSeenBatch,
    getUnseenImages,
    getSeenStats,
    resetSeen,
};
