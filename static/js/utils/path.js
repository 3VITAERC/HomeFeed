/**
 * Path utilities for HomeFeed.
 * Handles URL parsing and path manipulation.
 */

/**
 * Extract the actual file path from an image URL
 * Handles both /thumbnail?path= and /image?path= prefixes and URL decoding
 * 
 * @param {string} imageUrl - The image URL
 * @returns {string} The decoded file path
 */
export function extractPath(imageUrl) {
    let path = imageUrl;
    // Handle both thumbnail and image URL formats
    if (path.startsWith('/thumbnail?path=')) {
        path = path.replace('/thumbnail?path=', '');
    } else if (path.startsWith('/image?path=')) {
        path = path.replace('/image?path=', '');
    }
    return decodeURIComponent(path);
}

/**
 * Extract folder path from an image URL
 * Returns the parent directory path with normalized separators
 * 
 * @param {string} imageUrl - The image URL
 * @returns {string} The parent directory path
 */
export function extractFolderPath(imageUrl) {
    const fullPath = extractPath(imageUrl);
    // Normalize path separators (handle both / and \)
    const normalizedPath = fullPath.replace(/\\/g, '/');
    const pathParts = normalizedPath.split('/');
    pathParts.pop(); // Remove filename
    return pathParts.join('/');
}

/**
 * Get just the filename from an image URL
 * 
 * @param {string} imageUrl - The image URL
 * @returns {string} The filename
 */
export function extractFilename(imageUrl) {
    const fullPath = extractPath(imageUrl);
    const normalizedPath = fullPath.replace(/\\/g, '/');
    return normalizedPath.split('/').pop();
}

/**
 * Normalize a path by converting backslashes to forward slashes
 * 
 * @param {string} path - The path to normalize
 * @returns {string} The normalized path
 */
export function normalizePath(path) {
    if (!path) return path;
    return path.replace(/\\/g, '/');
}

/**
 * Check if a URL points to a GIF file
 * 
 * @param {string} url - The URL to check
 * @returns {boolean} True if the URL points to a GIF
 */
export function isGifUrl(url) {
    try {
        // Decode the URL and check the extension
        const decodedUrl = decodeURIComponent(url);
        return decodedUrl.toLowerCase().endsWith('.gif');
    } catch {
        return false;
    }
}

/**
 * Check if a URL points to a video file
 * 
 * @param {string} url - The URL to check
 * @returns {boolean} True if the URL points to a video
 */
export function isVideoUrl(url) {
    try {
        const decodedUrl = decodeURIComponent(url);
        const lower = decodedUrl.toLowerCase();
        // Note: .webm is included because GIFs are converted to WebM
        return lower.endsWith('.m4v') || lower.endsWith('.mp4') || lower.endsWith('.webm') || lower.endsWith('.mov');
    } catch {
        return false;
    }
}

/**
 * Check if a URL is a converted GIF (WebM from /gif endpoint)
 * 
 * @param {string} url - The URL to check
 * @returns {boolean} True if the URL is a converted GIF
 */
export function isConvertedGifUrl(url) {
    return url.startsWith('/gif?path=');
}

// Default export with all utilities
export default {
    extractPath,
    extractFolderPath,
    extractFilename,
    normalizePath,
    isGifUrl,
    isVideoUrl,
    isConvertedGifUrl,
};
