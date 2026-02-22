/**
 * GIF animation control utilities for HomeFeed.
 * Handles freezing and unfreezing GIFs to reduce CPU usage.
 */

import { isGifUrl } from './path.js';

// Cache for frozen GIF frames
const gifFreezeCache = new Map();

/**
 * Freeze a GIF by replacing it with a static first frame.
 * Reduces CPU usage by stopping animation when the slide is not active.
 * Also handles video elements for GIFs served as WebM by the server (pause instead of canvas capture).
 *
 * @param {HTMLImageElement|HTMLVideoElement} element - The GIF image or server-converted WebM video element
 */
export function freezeGif(element) {
    // Handle video elements (converted GIFs)
    if (element.tagName === 'VIDEO') {
        if (element.dataset.frozen === 'true') return;
        element.pause();
        element.dataset.frozen = 'true';
        return;
    }
    
    // Handle traditional GIF images
    if (element.dataset.frozen === 'true') return; // Already frozen
    if (!isGifUrl(element.src)) return; // Not a GIF
    
    const src = element.src;
    
    // Check if we have a cached frozen frame
    if (gifFreezeCache.has(src)) {
        element.src = gifFreezeCache.get(src);
        element.dataset.frozen = 'true';
        element.dataset.originalSrc = src;
        return;
    }
    
    // Create canvas to capture first frame
    const canvas = document.createElement('canvas');
    canvas.width = element.naturalWidth || element.width;
    canvas.height = element.naturalHeight || element.height;
    
    const ctx = canvas.getContext('2d');
    ctx.drawImage(element, 0, 0, canvas.width, canvas.height);
    
    try {
        const frozenSrc = canvas.toDataURL('image/png');
        gifFreezeCache.set(src, frozenSrc);
        element.dataset.originalSrc = src;
        element.src = frozenSrc;
        element.dataset.frozen = 'true';
    } catch (e) {
        // Canvas tainted or other error - can't freeze
        console.warn('Could not freeze GIF:', e);
    }
}

/**
 * Unfreeze a GIF by restoring the original animated source.
 * Also handles video elements for GIFs served as WebM by the server (resume playback instead of src swap).
 *
 * @param {HTMLImageElement|HTMLVideoElement} element - The GIF image or server-converted WebM video element
 */
export function unfreezeGif(element) {
    // Handle video elements (converted GIFs)
    if (element.tagName === 'VIDEO') {
        if (element.dataset.frozen !== 'true') return;
        element.play();
        element.dataset.frozen = 'false';
        return;
    }
    
    // Handle traditional GIF images
    if (element.dataset.frozen !== 'true') return; // Not frozen
    
    const originalSrc = element.dataset.originalSrc;
    if (originalSrc) {
        element.src = originalSrc;
        element.dataset.frozen = 'false';
    }
}

/**
 * Clear the GIF freeze cache
 */
export function clearGifCache() {
    gifFreezeCache.clear();
}

/**
 * Get the current size of the GIF freeze cache
 * 
 * @returns {number} Number of cached frozen frames
 */
export function getGifCacheSize() {
    return gifFreezeCache.size;
}

export default {
    freezeGif,
    unfreezeGif,
    clearGifCache,
    getGifCacheSize,
};
