/**
 * Main application entry point for HomeFeed.
 * Initializes all components and sets up event handlers.
 */

// Import state management
import { state, IMAGE_POOL_BUFFER, getPreloadCount, isAnyModalOpen } from './state.js';

// Import utilities
import { extractPath, isGifUrl, isVideoUrl, normalizePath } from './utils/path.js';
import { addVideoControls } from './utils/video.js';

// Import viewport manager (replaces state.observer + state.gifObserver)
import {
    initViewport,
    observeSlide,
    destroyObserver,
    recreateObserver,
    activateMediaIfCurrent,
    toggleGlobalMute,
    preloadAudioForNextSlide,
    getScrollGeneration,
} from './viewport.js';

// Import API client
import API from './api.js';

// DOM Elements - initialized after DOM is ready
let scrollContainer, noImages, noFavorites, noUnseen, jumpModal, jumpInput, jumpTotal;
let jumpCancel, jumpGo, exitFilterBtn, noTrash, exitTrashBtn, exitUnseenBtn;
let loadingOverlay;
let heartBtn, trashBtn, filterBtn, filterBadge, shuffleBtn, infoBtn, settingsBtn;
let noImagesSettingsBtn;
let trashModal, trashModalClose, trashCountInfo, viewTrashBtn, emptyTrashBtn;
let deleteConfirmModal, deleteConfirmMessage, deleteCancelBtn, deleteConfirmBtn;
let infoModal, infoModalBody, infoModalClose;
let topNavFilter, topNavDropdown, topNavTabs, topNavSearch;
let foldersModal, foldersModalClose, foldersSearchInput, foldersSortSelect, foldersList;
let settingsModal, settingsModalClose;
let shortcutsModal, shortcutsModalClose;
let filePathDisplay;

// Folders modal state
let leafFolders = [];
let currentFolderSort = 'count';
let searchDebounceTimer = null;

// Auto-advance timer
let autoAdvanceTimer = null;

// Loading overlay failsafe timeout
let loadingFailsafeTimeout = null;

// Pending confirmation action (for reusable confirm modal)
let pendingConfirmAction = null;

// ============ Initialization ============

/**
 * Called by ViewportManager whenever the active slide changes.
 * Handles everything except media control (which viewport.js owns).
 *
 * @param {number} newIndex - The newly active slide index
 */
function _onSlideActivated(newIndex) {
    updateUI();

    const preloadCount = getPreloadCount();
    // Only preload AHEAD (not behind) based on user setting
    if (preloadCount > 0) {
        const gen = getScrollGeneration();
        sequentialPreload(newIndex, 1, preloadCount, true, gen);   // ahead only
    }

    if (state.optimizations.auto_advance) {
        startAutoAdvanceTimer();
    }

    // Track the current image as seen
    const currentSrc = state.images[newIndex];
    if (currentSrc) {
        markCurrentImageSeen(currentSrc);
    }
}

/**
 * Initialize the application
 */
async function init() {
    // Get DOM elements
    initDOMElements();
    
    // Set up event listeners
    setupEventListeners();
    
    // Initialize viewport manager BEFORE loading data (so it's ready when slides are built)
    initViewport(scrollContainer, _onSlideActivated);
    
    // Wire up the needsLoad event — viewport.js dispatches this when a slide
    // enters the viewport and has no content yet
    scrollContainer.addEventListener('needsLoad', (e) => {
        const slide = e.target.closest('.image-slide');
        if (!slide) return;
        // Skip if this slide is too far from the current position.
        // The IntersectionObserver's 100px rootMargin fires for slides the user
        // scrolls past quickly — this guard prevents loading content for them.
        const slideIndex = parseInt(slide.dataset.index, 10);
        if (Math.abs(slideIndex - state.currentIndex) > IMAGE_POOL_BUFFER) return;
        loadImageForSlide(slide);
    });
    
    // Load initial data
    await loadInitialData();
    
    // Initialize top nav (delayed)
    initTopNav();
    
    // Set up seen flush on page unload
    setupSeenFlushOnUnload();
}

/**
 * Initialize DOM element references
 */
function initDOMElements() {
    scrollContainer = document.getElementById('scrollContainer');
    noImages = document.getElementById('noImages');
    noFavorites = document.getElementById('noFavorites');
    jumpModal = document.getElementById('jumpModal');
    jumpInput = document.getElementById('jumpInput');
    jumpTotal = document.getElementById('jumpTotal');
    jumpCancel = document.getElementById('jumpCancel');
    jumpGo = document.getElementById('jumpGo');
    exitFilterBtn = document.getElementById('exitFilterBtn');
    noTrash = document.getElementById('noTrash');
    exitTrashBtn = document.getElementById('exitTrashBtn');
    noUnseen = document.getElementById('noUnseen');
    exitUnseenBtn = document.getElementById('exitUnseenBtn');
    
    // Loading overlay
    loadingOverlay = document.getElementById('loadingOverlay');
    
    // Action Bar
    heartBtn = document.getElementById('heartBtn');
    trashBtn = document.getElementById('trashBtn');
    filterBtn = document.getElementById('filterBtn');
    filterBadge = document.getElementById('filterBadge');
    shuffleBtn = document.getElementById('shuffleBtn');
    infoBtn = document.getElementById('infoBtn');
    settingsBtn = document.getElementById('settingsBtn');
    noImagesSettingsBtn = document.getElementById('noImagesSettingsBtn');
    
    // File path display
    filePathDisplay = document.getElementById('filePathDisplay');
    
    // Modals
    trashModal = document.getElementById('trashModal');
    trashModalClose = document.getElementById('trashModalClose');
    trashCountInfo = document.getElementById('trashCountInfo');
    viewTrashBtn = document.getElementById('viewTrashBtn');
    emptyTrashBtn = document.getElementById('emptyTrashBtn');
    
    deleteConfirmModal = document.getElementById('deleteConfirmModal');
    deleteConfirmMessage = document.getElementById('deleteConfirmMessage');
    deleteCancelBtn = document.getElementById('deleteCancelBtn');
    deleteConfirmBtn = document.getElementById('deleteConfirmBtn');
    
    infoModal = document.getElementById('infoModal');
    infoModalBody = document.getElementById('infoModalBody');
    infoModalClose = document.getElementById('infoModalClose');
    
    settingsModal = document.getElementById('settingsModal');
    settingsModalClose = document.getElementById('settingsModalClose');
    
    shortcutsModal = document.getElementById('shortcutsModal');
    shortcutsModalClose = document.getElementById('shortcutsModalClose');
    
    // Top Nav
    topNavFilter = document.getElementById('topNavFilter');
    topNavDropdown = document.getElementById('topNavDropdown');
    topNavTabs = document.getElementById('topNavTabs');
    topNavSearch = document.getElementById('topNavSearch');
    
    // Folders Modal
    foldersModal = document.getElementById('foldersModal');
    foldersModalClose = document.getElementById('foldersModalClose');
    foldersSearchInput = document.getElementById('foldersSearchInput');
    foldersSortSelect = document.getElementById('foldersSortSelect');
    foldersList = document.getElementById('foldersList');
}

/**
 * Set up all event listeners
 */
function setupEventListeners() {
    // Keyboard shortcuts
    document.addEventListener('keydown', handleKeyboard, true);
    
    // Action bar buttons
    if (heartBtn) heartBtn.addEventListener('click', toggleFavorite);
    if (trashBtn) trashBtn.addEventListener('click', toggleTrash);
    if (filterBtn) filterBtn.addEventListener('click', toggleFavoritesMode);
    if (shuffleBtn) shuffleBtn.addEventListener('click', toggleShuffle);
    if (infoBtn) infoBtn.addEventListener('click', showInfoModal);
    if (settingsBtn) settingsBtn.addEventListener('click', showSettingsModal);
    if (noImagesSettingsBtn) noImagesSettingsBtn.addEventListener('click', showSettingsModal);
    
    // Double-tap to like
    setupDoubleTapToLike();
    
    // Jump modal
    if (jumpCancel) jumpCancel.addEventListener('click', hideJumpModal);
    if (jumpGo) jumpGo.addEventListener('click', handleJump);
    if (jumpInput) jumpInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') handleJump();
        if (e.key === 'Escape') hideJumpModal();
    });
    
    // Exit buttons
    if (exitFilterBtn) exitFilterBtn.addEventListener('click', exitFavoritesMode);
    if (exitTrashBtn) exitTrashBtn.addEventListener('click', exitTrashMode);
    if (exitUnseenBtn) exitUnseenBtn.addEventListener('click', exitUnseenMode);
    
    // Modal close buttons
    if (infoModalClose) infoModalClose.addEventListener('click', hideInfoModal);
    if (settingsModalClose) settingsModalClose.addEventListener('click', hideSettingsModal);
    if (shortcutsModalClose) shortcutsModalClose.addEventListener('click', hideShortcutsModal);
    if (foldersModalClose) foldersModalClose.addEventListener('click', hideFoldersModal);
    if (trashModalClose) trashModalClose.addEventListener('click', hideTrashModal);
    
    // Modal backdrop clicks
    [infoModal, settingsModal, shortcutsModal, foldersModal, trashModal, deleteConfirmModal].forEach(modal => {
        if (modal) {
            modal.addEventListener('click', (e) => {
                if (e.target === modal) {
                    modal.style.display = 'none';
                }
            });
        }
    });
    
    // Top nav
    if (topNavFilter) topNavFilter.addEventListener('click', toggleTopNavDropdown);
    if (topNavSearch) topNavSearch.addEventListener('click', showFoldersModal);
    
    // Top nav dropdown options
    document.querySelectorAll('.dropdown-option').forEach(option => {
        option.addEventListener('click', (e) => {
            e.stopPropagation();
            handleDropdownOption(option.dataset.sort);
        });
    });
    
    // Folders modal search and sort
    if (foldersSearchInput) {
        foldersSearchInput.addEventListener('input', (e) => {
            clearTimeout(searchDebounceTimer);
            searchDebounceTimer = setTimeout(() => {
                renderFoldersModalList(e.target.value);
            }, 150);
        });
    }
    
    if (foldersSortSelect) {
        foldersSortSelect.addEventListener('change', (e) => {
            currentFolderSort = e.target.value;
            renderFoldersModalList(foldersSearchInput?.value || '');
        });
    }
    
    // Trash modal buttons
    if (viewTrashBtn) viewTrashBtn.addEventListener('click', viewTrash);
    if (emptyTrashBtn) emptyTrashBtn.addEventListener('click', confirmEmptyTrash);
    if (deleteCancelBtn) deleteCancelBtn.addEventListener('click', hideDeleteConfirm);
    if (deleteConfirmBtn) deleteConfirmBtn.addEventListener('click', handleConfirmAction);
    
    // Cache optimization toggles - set up once during initialization
    const thumbnailToggle = document.getElementById('toggleThumbnailCache');
    const videoPosterToggle = document.getElementById('toggleVideoPoster');
    
    if (thumbnailToggle) {
        thumbnailToggle.addEventListener('change', async (e) => {
            try {
                await API.updateSettings({ optimizations: { thumbnail_cache: e.target.checked } });
                state.optimizations.thumbnail_cache = e.target.checked;
                console.log('Thumbnail cache setting saved:', e.target.checked);
                // Reload images to use new setting
                if (e.target.checked) {
                    location.reload();
                }
            } catch (error) {
                console.error('Failed to save thumbnail cache setting:', error);
            }
        });
    }
    if (videoPosterToggle) {
        videoPosterToggle.addEventListener('change', async (e) => {
            try {
                await API.updateSettings({ optimizations: { video_poster_cache: e.target.checked } });
                state.optimizations.video_poster_cache = e.target.checked;
                console.log('Video poster cache setting saved:', e.target.checked);
                // Reload images to use new setting
                if (e.target.checked) {
                    location.reload();
                }
            } catch (error) {
                console.error('Failed to save video poster cache setting:', error);
            }
        });
    }
    
    // Fill screen toggle
    const fillScreenToggle = document.getElementById('toggleFillScreen');
    if (fillScreenToggle) {
        fillScreenToggle.addEventListener('change', async (e) => {
            try {
                await API.updateSettings({ optimizations: { fill_screen: e.target.checked } });
                state.optimizations.fill_screen = e.target.checked;
                console.log('Fill screen setting saved:', e.target.checked);
                // Rebuild slides to apply new class
                buildSlides(state.currentIndex);
                prioritizeFirstImage(state.currentIndex);
            } catch (error) {
                console.error('Failed to save fill screen setting:', error);
            }
        });
    }
    
    // Auto-advance toggle
    const autoAdvanceToggle = document.getElementById('toggleAutoAdvance');
    if (autoAdvanceToggle) {
        autoAdvanceToggle.addEventListener('change', async (e) => {
            try {
                await API.updateSettings({ optimizations: { auto_advance: e.target.checked } });
                state.optimizations.auto_advance = e.target.checked;
                console.log('Auto-advance setting saved:', e.target.checked);
                
                // Update indicator visibility
                updateAutoAdvanceIndicator();
                
                // Start timer if enabled and on a photo
                if (e.target.checked) {
                    startAutoAdvanceTimer();
                } else {
                    clearAutoAdvanceTimer();
                }
                
                // Rebuild slides to update video loop behavior
                buildSlides(state.currentIndex);
                prioritizeFirstImage(state.currentIndex);
            } catch (error) {
                console.error('Failed to save auto-advance setting:', error);
            }
        });
    }
    
    // Auto-advance delay slider
    const autoAdvanceDelaySlider = document.getElementById('autoAdvanceDelaySlider');
    const autoAdvanceDelayValue = document.getElementById('autoAdvanceDelayValue');
    if (autoAdvanceDelaySlider && autoAdvanceDelayValue) {
        autoAdvanceDelaySlider.addEventListener('input', async (e) => {
            const delay = parseInt(e.target.value);
            autoAdvanceDelayValue.textContent = delay;
            state.optimizations.auto_advance_delay = delay;
            
            try {
                await API.updateSettings({ optimizations: { auto_advance_delay: delay } });
                console.log('Auto-advance delay saved:', delay);
            } catch (error) {
                console.error('Failed to save auto-advance delay:', error);
            }
        });
    }
    
    // Date source toggle (Modified Date vs Created Date filesystem fallback)
    const dateSourceToggle = document.getElementById('toggleDateSource');
    if (dateSourceToggle) {
        dateSourceToggle.addEventListener('change', async (e) => {
            const newSource = e.target.checked ? 'ctime' : 'mtime';
            try {
                await API.updateSettings({ optimizations: { date_source: newSource } });
                state.optimizations.date_source = newSource;
                // Update the label next to the toggle
                const dateSourceLabel = document.getElementById('dateSourceLabel');
                if (dateSourceLabel) {
                    dateSourceLabel.textContent = e.target.checked ? 'Created Date' : 'Modified Date';
                }
                console.log('Date source setting saved:', newSource);
                // Reload images — backend cache was busted by the settings API
                showLoadingOverlay();
                await reloadImages(state.currentSortOrder);
            } catch (error) {
                console.error('Failed to save date source setting:', error);
            }
        });
    }

    // Preload distance slider
    const preloadDistanceSlider = document.getElementById('preloadDistanceSlider');
    const preloadDistanceValue = document.getElementById('preloadDistanceValue');
    if (preloadDistanceSlider && preloadDistanceValue) {
        preloadDistanceSlider.addEventListener('input', async (e) => {
            const distance = parseInt(e.target.value);
            preloadDistanceValue.textContent = distance;
            state.optimizations.preload_distance = distance;
            
            try {
                await API.updateSettings({ optimizations: { preload_distance: distance } });
                console.log('Preload distance saved:', distance);
            } catch (error) {
                console.error('Failed to save preload distance:', error);
            }
        });
    }

    // HDD Friendly toggle
    const toggleHDDFriendly = document.getElementById('toggleHDDFriendly');
    if (toggleHDDFriendly) {
        toggleHDDFriendly.addEventListener('change', async (e) => {
            try {
                await API.updateSettings({ optimizations: { hdd_friendly: e.target.checked } });
                state.optimizations.hdd_friendly = e.target.checked;
            } catch (error) {
                console.error('Failed to save HDD friendly setting:', error);
            }
        });
    }

    // Auto-advance indicator click (toggles off)
    const autoAdvanceIndicator = document.getElementById('autoAdvanceIndicator');
    if (autoAdvanceIndicator) {
        autoAdvanceIndicator.addEventListener('click', toggleAutoAdvanceOff);
    }
    
    // Pull-to-refresh gesture on the top nav bar
    setupPullToRefresh();
}

// ============ Seen Tracking ============

/**
 * Add an image URL to the seen pending buffer.
 * Flushes automatically when buffer reaches 10 items.
 * Also sets up a periodic flush timer if not already running.
 *
 * @param {string} imageUrl - The image URL (e.g. '/image?path=...')
 */
function markCurrentImageSeen(imageUrl) {
    // Don't track seen status when browsing the Trash feed (trashed images shouldn't affect the seen feed)
    if (state.showingTrashOnly) return;

    if (!state.seenPendingBuffer.includes(imageUrl)) {
        state.seenPendingBuffer.push(imageUrl);
    }

    // Flush if buffer reaches threshold
    if (state.seenPendingBuffer.length >= 10) {
        flushSeenBuffer();
    }

    // Start periodic flush timer on first seen item (if not already running)
    if (!state.seenFlushTimer && state.seenPendingBuffer.length > 0) {
        state.seenFlushTimer = setInterval(() => {
            if (state.seenPendingBuffer.length > 0) {
                flushSeenBuffer();
            }
        }, 5000);
    }
}

/**
 * Flush the pending seen buffer to the server.
 * Safe to call even if buffer is empty.
 */
async function flushSeenBuffer() {
    if (state.seenPendingBuffer.length === 0) return;

    const toFlush = [...state.seenPendingBuffer];
    state.seenPendingBuffer = [];

    try {
        await API.markSeenBatch(toFlush);
    } catch (error) {
        // On failure, push back to buffer to retry next flush
        state.seenPendingBuffer.push(...toFlush);
        console.warn('[Seen] Failed to flush seen buffer, will retry:', error);
    }
}

/**
 * Set up beforeunload flush so seen items are saved when user navigates away.
 */
function setupSeenFlushOnUnload() {
    window.addEventListener('beforeunload', () => {
        if (state.seenPendingBuffer.length > 0) {
            // Use sendBeacon for reliability during unload
            const payload = JSON.stringify({ paths: state.seenPendingBuffer });
            navigator.sendBeacon('/api/seen/batch', new Blob([payload], { type: 'application/json' }));
        }
        // Clear the periodic timer
        if (state.seenFlushTimer) {
            clearInterval(state.seenFlushTimer);
            state.seenFlushTimer = null;
        }
    });
}

/**
 * Load initial data from API
 */
async function loadInitialData() {
    try {
        // Load settings FIRST so optimization settings are available before images
        const settings = await API.getSettings();
        
        // Store optimization settings before loading any images
        if (settings.optimizations) {
            state.optimizations = settings.optimizations;
            console.log('[Init] Optimization settings loaded:', state.optimizations);
        }
        state.shuffleEnabled = settings.shuffle;
        
        // Initialize auto-advance indicator visibility
        updateAutoAdvanceIndicator();
        
        // Now load images with current sort order
        state.images = await API.getImages(state.currentSortOrder);
        
        // Load favorites and trash
        const [favoritesData, trashData] = await Promise.all([
            API.getFavorites(),
            API.getTrash(),
        ]);
        
        state.favorites = new Set(favoritesData.favorites.map(url => extractPath(url)));
        state.trash = new Set(trashData.trash.map(url => extractPath(url)));
        
        // Apply shuffle if enabled on initial load
        if (state.shuffleEnabled && state.images.length > 0) {
            state.unshuffledImages = [...state.images];
            shuffleArray(state.images);
        }
        
        // Update UI
        updateFilterBadge();
        updateShuffleButton();
        updateUI(); // Update file path display on initial load
        
        // Build slides
        if (state.images.length > 0) {
            buildSlides(0);
            prioritizeFirstImage();
            
            // Start auto-advance timer if enabled (after initial load)
            if (state.optimizations.auto_advance) {
                // Delay slightly to allow first image to be visible
                setTimeout(() => {
                    startAutoAdvanceTimer();
                }, 500);
            }
        } else {
            hideLoadingOverlay();
            showNoImages();
        }
        
    } catch (error) {
        console.error('Failed to load initial data:', error);
        hideLoadingOverlay();
        showNoImages();
    }
}

// ============ Slide Building ============

/**
 * Cancel any pending deferred slide creation
 * Call this at the start of mode transitions
 */
function cancelDeferredCreation() {
    if (state.deferredRicId) {
        if ('cancelIdleCallback' in window) {
            cancelIdleCallback(state.deferredRicId);
        } else {
            clearTimeout(state.deferredRicId);
        }
        state.deferredRicId = null;
    }
    state.deferredQueue = [];
}

/**
 * Create a single slide element
 * @param {number} index - The image index
 * @returns {HTMLElement|null} The created slide element or null if invalid
 */
function createSlide(index) {
    const src = state.images[index];
    if (!src) return null;
    
    const slide = document.createElement('div');
    slide.className = 'image-slide';
    
    // Apply fill-screen class if enabled
    if (state.optimizations.fill_screen) {
        slide.classList.add('fill-screen');
    }
    
    slide.dataset.index = index;
    slide.dataset.src = src;
    
    // Insert at correct position to maintain DOM order
    // Find the appropriate position to insert
    const slides = scrollContainer.querySelectorAll('.image-slide');
    let insertBefore = null;
    
    for (const existingSlide of slides) {
        const existingIndex = parseInt(existingSlide.dataset.index);
        if (existingIndex > index) {
            insertBefore = existingSlide;
            break;
        }
    }
    
    if (insertBefore) {
        scrollContainer.insertBefore(slide, insertBefore);
    } else {
        scrollContainer.appendChild(slide);
    }
    
    // Register with viewport manager (single observer handles lazy-load + media control)
    observeSlide(slide);
    
    state.slidesCreated++;
    
    return slide;
}

/**
 * Process deferred slide creation queue during browser idle time
 * @param {IdleDeadline} deadline - Idle deadline from requestIdleCallback
 */
function processDeferredQueue(deadline) {
    let created = 0;
    
    while (state.deferredQueue.length > 0 && 
           created < state.chunkSize && 
           (deadline?.timeRemaining() > 0 || !deadline)) {
        
        const index = state.deferredQueue.shift();
        
        // Skip if already exists (might have been created by ensureSlideExists)
        if (!document.querySelector(`.image-slide[data-index="${index}"]`)) {
            createSlide(index);
            created++;
        }
    }
    
    // Schedule next chunk if queue not empty
    if (state.deferredQueue.length > 0) {
        if ('requestIdleCallback' in window) {
            state.deferredRicId = requestIdleCallback(processDeferredQueue);
        } else {
            state.deferredRicId = setTimeout(() => processDeferredQueue(), 50);
        }
    } else {
        state.deferredRicId = null;
    }
}

/**
 * Schedule deferred creation of slides outside immediate range
 * @param {number} immediateStart - Start of immediate range (exclusive)
 * @param {number} immediateEnd - End of immediate range (exclusive)
 */
function scheduleDeferredSlides(immediateStart, immediateEnd) {
    // Cancel any existing deferred creation
    cancelDeferredCreation();
    
    // Build queue of indices not yet created
    state.deferredQueue = [];
    
    // Add slides before immediate range (in reverse order for natural fill)
    for (let i = immediateStart - 1; i >= 0; i--) {
        state.deferredQueue.push(i);
    }
    
    // Add slides after immediate range
    for (let i = immediateEnd; i < state.images.length; i++) {
        state.deferredQueue.push(i);
    }
    
    // Start processing if there are slides to create
    if (state.deferredQueue.length > 0) {
        // Use requestIdleCallback for background processing
        if ('requestIdleCallback' in window) {
            state.deferredRicId = requestIdleCallback(processDeferredQueue);
        } else {
            // Fallback for browsers without requestIdleCallback
            state.deferredRicId = setTimeout(() => processDeferredQueue(), 0);
        }
    }
}

/**
 * Ensure a slide exists before scrolling to it
 * Creates the slide and its neighbors if they don't exist
 * @param {number} index - Target slide index
 */
function ensureSlideExists(index) {
    if (index < 0 || index >= state.images.length) return;
    
    // Check if slide already exists
    const existing = document.querySelector(`.image-slide[data-index="${index}"]`);
    if (existing) return;
    
    // Create the slide and its neighbors
    const start = Math.max(0, index - state.immediateBuffer);
    const end = Math.min(state.images.length, index + state.immediateBuffer + 1);
    
    for (let i = start; i < end; i++) {
        if (!document.querySelector(`.image-slide[data-index="${i}"]`)) {
            createSlide(i);
        }
    }
}

/**
 * Build slides for images using phased creation
 * Creates immediate slides synchronously, defers rest to idle time
 * @param {number} startIndex - Index to center immediate creation around (default: 0)
 */
function buildSlides(startIndex = 0) {
    if (!scrollContainer) return;
    
    // Cancel any pending deferred creation from previous mode
    cancelDeferredCreation();
    
    // Disconnect observer before clearing DOM (avoids stale element callbacks)
    destroyObserver();
    
    // Clear container and reset state
    scrollContainer.innerHTML = '';
    state.slidesCreated = 0;
    
    // Recreate observer so new slides can be registered
    recreateObserver();
    
    // For small libraries, create all slides immediately
    if (state.images.length <= 20) {
        for (let i = 0; i < state.images.length; i++) {
            createSlide(i);
        }
        return;
    }
    
    // Calculate immediate range around start index
    const start = Math.max(0, startIndex - state.immediateBuffer);
    const end = Math.min(state.images.length, startIndex + state.immediateBuffer + 1);
    
    // Create immediate slides synchronously
    for (let i = start; i < end; i++) {
        createSlide(i);
    }
    
    // Schedule deferred creation for remaining slides
    scheduleDeferredSlides(start, end);
}

/**
 * Show no images message
 */
function showNoImages() {
    if (noImages) noImages.style.display = 'flex';
    if (scrollContainer) scrollContainer.innerHTML = '';
}

// ============ Image Loading ============

/**
 * Load image for a slide
 * @param {HTMLElement} slide - The slide element
 * @param {boolean} isPriorityImage - If true, hide loading overlay when loaded
 * @param {boolean} isNextSlide - If true, pre-buffer video for instant playback (next slide only)
 * @param {boolean} isPreload - If true, force eager loading (not lazy) for preloaded images
 */
function loadImageForSlide(slide, isPriorityImage = false, isNextSlide = false, isPreload = false) {
    const src = slide.dataset.src;
    if (!src) return;

    // Second-line distance guard: skip if slide is too far from current position.
    // isPriorityImage bypasses this so initial page load and mode transitions always work.
    if (!isPriorityImage) {
        const slideIndex = parseInt(slide.dataset.index, 10);
        if (Math.abs(slideIndex - state.currentIndex) > IMAGE_POOL_BUFFER) return;
    }
    
    if (isVideoUrl(src)) {
        loadVideoForSlide(slide, src, false, isPriorityImage, isNextSlide);
    } else if (isGifUrl(src)) {
        loadGifForSlide(slide, src, isPriorityImage, isPreload);
    } else {
        loadStaticImageForSlide(slide, src, isPriorityImage, isPreload);
    }
}

/**
 * Load static image for a slide
 * Uses thumbnail endpoint if thumbnail_cache is enabled
 * @param {HTMLElement} slide - The slide element
 * @param {string} src - The image source URL
 * @param {boolean} isPriorityImage - If true, hide loading overlay when loaded
 * @param {boolean} isPreload - If true, force eager loading for preloaded images
 */
function loadStaticImageForSlide(slide, src, isPriorityImage = false, isPreload = false) {
    const img = document.createElement('img');
    
    // Priority images get high fetch priority and eager loading
    // Preloaded images also get eager loading to ensure they actually load
    if (isPriorityImage) {
        img.fetchPriority = 'high';
        img.loading = 'eager';
    } else if (isPreload) {
        img.loading = 'eager';  // Force eager loading for preloaded images
    } else {
        img.loading = 'lazy';
    }
    img.decoding = 'async';
    
    img.onload = function() {
        this.classList.add('loaded');
        if (isPriorityImage) {
            hideLoadingOverlay();
        }
    };
    
    img.onerror = function() {
        this.src = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><text x="12" y="12" text-anchor="middle" fill="white">Error</text></svg>';
        if (isPriorityImage) {
            hideLoadingOverlay();
        }
    };
    
    // Use thumbnail endpoint if thumbnail caching is enabled
    if (state.optimizations.thumbnail_cache) {
        // Convert /image?path= to /thumbnail?path=
        const path = extractPath(src);
        const thumbnailUrl = `/thumbnail?path=${encodeURIComponent(path)}`;
        console.log(`[Thumbnail] Loading: ${thumbnailUrl.substring(0, 100)}...`);
        img.src = thumbnailUrl;
    } else {
        img.src = src;
    }
    slide.appendChild(img);
}

/**
 * Load GIF for a slide
 * GIFs are loaded as static images (no WebM conversion)
 * @param {HTMLElement} slide - The slide element
 * @param {string} src - The image source URL
 * @param {boolean} isPriorityImage - If true, hide loading overlay when loaded
 * @param {boolean} isPreload - If true, force eager loading for preloaded images
 */
function loadGifForSlide(slide, src, isPriorityImage = false, isPreload = false) {
    // Load GIF as static image
    loadStaticImageForSlide(slide, src, isPriorityImage, isPreload);
}

/**
 * Load video for a slide
 * Uses video poster if video_poster_cache is enabled
 * 
 * Loading strategy:
 * 1. If poster enabled, start loading poster first
 * 2. Load video with appropriate preload strategy
 * 3. When poster is used, video has no opacity transition (visible immediately behind poster)
 * 4. Only the poster fades out when video is ready
 * 5. Hide loading overlay when EITHER poster or video is ready (for priority images)
 * 
 * @param {HTMLElement} slide - The slide element
 * @param {string} src - The video source URL
 * @param {boolean} isConvertedGif - True if this is a GIF converted to WebM
 * @param {boolean} isPriorityImage - If true, hide loading overlay when loaded
 * @param {boolean} isNextSlide - If true, pre-buffer for instant playback (next slide only)
 */
function loadVideoForSlide(slide, src, isConvertedGif = false, isPriorityImage = false, isNextSlide = false) {
    const video = document.createElement('video');
    video.playsInline = true;
    video.muted = true;
    video.loop = !state.optimizations.auto_advance;  // Only loop if auto-advance is disabled
    
    // Safari iOS ignores runtime changes to the preload attribute, so we must
    // set the correct value upfront.
    // - Priority (current slide): 'auto' — load everything immediately
    // - Next slide (+1): 'auto' — pre-buffer ~1-2MB for instant playback
    // - Others: 'metadata' — only fetch duration/dimensions, save bandwidth
    // 
    // With HTTP Range requests, 'auto' only streams what's needed (~1-2MB),
    // not the entire file. If user scrolls away, streaming stops automatically.
    if (isPriorityImage || isNextSlide) {
        video.preload = 'auto';
    } else {
        video.preload = 'metadata';
    }
    
    if (isConvertedGif) {
        video.dataset.originalGif = 'true';
    }
    
    // Add ended event listener for auto-advance
    if (state.optimizations.auto_advance) {
        video.addEventListener('ended', () => {
            // Only advance if this is still the current slide and not at the end
            const slideIndex = parseInt(slide.dataset.index);
            if (slideIndex === state.currentIndex && slideIndex < state.images.length - 1) {
                scrollToImage(slideIndex + 1);
            }
        });
    }
    
    let hasLoaded = false;
    let loadTimeout = null;
    
    // Determine if we're using a poster
    const usePoster = state.optimizations.video_poster_cache && !isConvertedGif;
    
    // If using poster, add 'with-poster' class to video
    // This makes the video visible immediately (no opacity transition)
    // so it renders behind the poster, and only the poster fades out
    if (usePoster) {
        video.classList.add('with-poster');
    }
    
    // Track poster state for coordinated crossfade
    let posterElement = null;
    let posterReady = false;
    let videoReady = false;
    let loadingOverlayHidden = false;
    
    // Helper: hide poster when both poster is visible AND video is ready
    const maybeHidePoster = () => {
        if (posterReady && videoReady && posterElement) {
            posterElement.classList.add('hidden');
            // Remove poster after transition completes
            setTimeout(() => {
                if (posterElement && posterElement.parentNode) {
                    posterElement.remove();
                }
            }, 300);
        }
    };
    
    // Helper: hide loading overlay (only once)
    const maybeHideLoadingOverlay = () => {
        if (isPriorityImage && !loadingOverlayHidden) {
            loadingOverlayHidden = true;
            hideLoadingOverlay();
        }
    };
    
    // Load poster image first if video poster cache is enabled
    if (usePoster) {
        const path = extractPath(src);
        const posterUrl = `/video-poster?path=${encodeURIComponent(path)}`;
        
        // Create poster image element
        posterElement = document.createElement('img');
        posterElement.className = 'video-poster';
        
        // Priority images get high fetch priority and eager loading
        if (isPriorityImage) {
            posterElement.fetchPriority = 'high';
            posterElement.loading = 'eager';
        } else {
            posterElement.loading = 'lazy';
        }
        
        posterElement.onload = function() {
            // Add loaded class to trigger fade-in
            this.classList.add('loaded');
            posterReady = true;
            
            // Hide loading overlay when poster loads (priority image only)
            maybeHideLoadingOverlay();
            
            // Check if we should hide poster (video might already be ready)
            maybeHidePoster();
            
            console.log(`[Video] Poster loaded for: ${path.substring(0, 50)}...`);
        };
        
        posterElement.onerror = function() {
            // Poster failed to load, remove it and log
            console.warn(`[Video] Poster failed to load for: ${path.substring(0, 50)}...`);
            posterElement = null;
            this.remove();
        };
        
        posterElement.src = posterUrl;
        slide.appendChild(posterElement);
    }
    
    // Set up video load timeout (30 seconds - slow networks need more time)
    loadTimeout = setTimeout(() => {
        if (!hasLoaded) {
            console.log(`[Video] Still loading after 30s: ${src.substring(0, 50)}...`);
            // Don't show error, video might still load on slow networks
        }
    }, 30000);
    
    video.onloadedmetadata = function() {
        // Metadata loaded (duration, dimensions available).
        // With HTTP Range request support, we don't need to force 'auto' preload
        // for non-priority videos. The browser will request data as needed when
        // the video plays, using Range requests to stream efficiently.
        // This prevents bandwidth contention from multiple videos downloading.
        //
        // Priority videos (current slide) get 'auto' to buffer for smooth playback.
        // Non-priority videos stay at 'metadata' and stream when activated.
        //
        // Note: Safari iOS ignores preload changes anyway, but with Range support
        // it will stream efficiently when play() is called.
    };
    
    video.onloadeddata = function() {
        hasLoaded = true;
        if (loadTimeout) clearTimeout(loadTimeout);
        
        // Only add 'loaded' class if NOT using poster
        // (with-poster videos are already visible)
        if (!usePoster) {
            this.classList.add('loaded');
        }
        videoReady = true;
        console.log(`[Video] Data loaded for: ${src.substring(0, 50)}...`);
        
        // Hide loading overlay when video loads (priority image only)
        // This handles the case where poster is disabled or failed to load
        maybeHideLoadingOverlay();
        
        // Hide poster with coordinated crossfade
        maybeHidePoster();
        
        // Play/pause trick for next-slide videos:
        // Forces the browser to decode and render the first frame,
        // eliminating the black flash when user scrolls to this video.
        // Only applies to isNextSlide (the +1 slide ahead of current).
        if (isNextSlide) {
            const v = this;
            v.play().then(() => {
                // Guard: only pause if user hasn't scrolled to this slide yet
                const idx = parseInt(slide.dataset.index, 10);
                if (idx !== state.currentIndex) {
                    v.pause();
                    v.currentTime = 0;
                }
            }).catch(() => {
                // Autoplay blocked — this is fine, video will play when scrolled to
            });
        }
        
        // Let ViewportManager decide whether to play.
        // Only plays if this slide is currently the active one — prevents
        // preloaded off-screen videos from autoplaying.
        activateMediaIfCurrent(slide);
    };
    
    video.onerror = function() {
        if (loadTimeout) clearTimeout(loadTimeout);
        
        // Hide loading overlay on error too
        maybeHideLoadingOverlay();
        
        // Get error details
        let errorMsg = 'Video unavailable';
        if (this.error) {
            switch (this.error.code) {
                case MediaError.MEDIA_ERR_ABORTED:
                    errorMsg = 'Video loading aborted';
                    break;
                case MediaError.MEDIA_ERR_NETWORK:
                    errorMsg = 'Network error loading video';
                    break;
                case MediaError.MEDIA_ERR_DECODE:
                    errorMsg = 'Video decode error';
                    break;
                case MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED:
                    errorMsg = 'Video format not supported';
                    break;
            }
        }
        
        // Only show error if video never loaded (not a playback error)
        if (!hasLoaded) {
            console.error(`[Video] ${errorMsg}: ${src.substring(0, 50)}...`);
            
            // Remove any existing error message
            const existingError = slide.querySelector('.video-error');
            if (existingError) existingError.remove();
            
            // Show error placeholder
            const errorDiv = document.createElement('div');
            errorDiv.className = 'video-error';
            errorDiv.textContent = errorMsg;
            slide.appendChild(errorDiv);
            
            // Remove poster if video failed
            if (posterElement) {
                posterElement.remove();
                posterElement = null;
            }
        }
    };
    
    video.src = src;
    slide.appendChild(video);
    
    // Add video controls
    addVideoControls(slide, video);
    
    // Note: Tap to toggle mute is handled by setupDoubleTapToLike() in the slide click handler
}

// ============ Observers ============
// NOTE: Observer setup has been moved to viewport.js (ViewportManager).
// - initViewport() is called from init() with the _onSlideActivated callback
// - observeSlide() is called from createSlide() for each new slide
// - destroyObserver() / recreateObserver() are called from buildSlides()

// ============ Priority Loading ============

/**
 * Prioritize loading the first image
 * Preloads images ahead based on user setting
 */
function prioritizeFirstImage(priorityIndex = 0) {
    const slide = document.querySelector(`.image-slide[data-index="${priorityIndex}"]`);
    if (!slide) {
        // No slide found, hide spinner
        hideLoadingOverlay();
        return;
    }
    
    // Check if content already exists
    const existingContent = slide.querySelector('img, video');
    if (existingContent) {
        // Content already loaded, hide spinner
        hideLoadingOverlay();
    } else {
        // Load the priority image immediately
        loadImageForSlide(slide, true);  // true = isPriorityImage
    }
    
    // Preload images ahead only (not behind)
    const preloadCount = getPreloadCount();
    if (preloadCount > 0) {
        const gen = getScrollGeneration();
        sequentialPreload(priorityIndex, 1, preloadCount, true, gen);  // Ahead only
    }
}

/**
 * Sequentially preload images in a given direction
 * @param centerIndex - The current image index
 * @param current - Current offset from center (starts at 1)
 * @param max - Maximum number of images to preload in each direction
 * @param ahead - True to preload ahead, false to preload behind
 */
function sequentialPreload(centerIndex, current, max, ahead = true, generation = 0) {
    // Guard: abort if user has scrolled to a new slide since this chain started
    if (generation !== getScrollGeneration()) return;

    if (current > max) return;
    
    // Re-check in case the setting changed while a setTimeout was pending
    if (current > getPreloadCount()) return;
    
    // Calculate index based on direction
    const preloadIndex = ahead ? centerIndex + current : centerIndex - current;
    
    // Skip if index is out of bounds
    if (preloadIndex < 0 || preloadIndex >= state.images.length) {
        // Continue to next iteration
        setTimeout(() => {
            sequentialPreload(centerIndex, current + 1, max, ahead, generation);
        }, 150);
        return;
    }
    
    const slide = document.querySelector(`.image-slide[data-index="${preloadIndex}"]`);
    
    // Debug logging
    if (current === 1) {
        console.log(`[Preload] Starting preload from index ${centerIndex}, max: ${max}, direction: ${ahead ? 'ahead' : 'behind'}`);
    }
    
    // If slide doesn't exist, create it on-demand
    if (!slide) {
        console.log(`[Preload] Creating slide ${preloadIndex} on-demand`);
        createSlide(preloadIndex);
    }
    
    // Re-query in case we just created it
    const targetSlide = document.querySelector(`.image-slide[data-index="${preloadIndex}"]`);
    
    if (!targetSlide) {
        console.log(`[Preload] Slide ${preloadIndex} still doesn't exist, skipping`);
    } else if (targetSlide.querySelector('img, video')) {
        console.log(`[Preload] Slide ${preloadIndex} already has content, skipping`);
    }
    
    if (targetSlide && !targetSlide.querySelector('img, video')) {
        console.log(`[Preload] Loading content for slide ${preloadIndex}`);
        // Mark the immediate next slide (+1) for video pre-buffering
        // This gives instant playback when user scrolls forward
        const isNextSlide = (ahead && current === 1);
        // Pass isPreload=true to force eager loading (not lazy)
        loadImageForSlide(targetSlide, false, isNextSlide, true);
        
        // Preload audio for next video slide (+1 position)
        if (isNextSlide) {
            const src = targetSlide.dataset.src;
            if (src && isVideoUrl(src)) {
                preloadAudioForNextSlide(src);
            }
        }
    } else if (targetSlide && ahead && current === 1) {
        // Slide already loaded — check if it's a video that needs first-frame rendering
        // This handles the case where a video was preloaded with preload='metadata'
        // and now becomes the +1 slide as user scrolls forward
        const video = targetSlide.querySelector('video');
        if (video && video.readyState >= 1) {
            // Video has at least metadata — force first frame decode/paint
            // Using play/pause trick for maximum browser compatibility
            video.play().then(() => {
                // Guard: only pause if user hasn't scrolled to this slide
                const idx = parseInt(targetSlide.dataset.index, 10);
                if (idx !== state.currentIndex) {
                    video.pause();
                    video.currentTime = 0;
                }
            }).catch(() => {
                // Autoplay blocked — video will play when scrolled to
            });
        }
        
        // Preload audio for next video slide (+1 position) even if already loaded
        const src = targetSlide.dataset.src;
        if (src && isVideoUrl(src)) {
            preloadAudioForNextSlide(src);
        }
    }
    
    setTimeout(() => {
        sequentialPreload(centerIndex, current + 1, max, ahead, generation);
    }, 150);
}

// ============ UI Updates ============

/**
 * Hide the loading overlay with fade animation
 */
function hideLoadingOverlay() {
    // Clear any pending failsafe timeout
    clearTimeout(loadingFailsafeTimeout);
    loadingFailsafeTimeout = null;
    
    if (loadingOverlay) {
        loadingOverlay.classList.add('hidden');
    }
}

/**
 * Show the loading overlay - for mode changes that reload images
 * Includes a 3-second failsafe that auto-hides if something goes wrong.
 */
function showLoadingOverlay() {
    if (loadingOverlay) {
        // Reset state: remove hidden class and ensure visibility
        loadingOverlay.classList.remove('hidden');
        loadingOverlay.style.visibility = 'visible';
        loadingOverlay.style.display = 'flex';
        // Trigger reflow for animation
        loadingOverlay.offsetHeight;
        loadingOverlay.classList.remove('hidden');
        
        // Clear any existing failsafe timeout
        clearTimeout(loadingFailsafeTimeout);
        
        // Set failsafe: auto-hide after 3 seconds if still showing
        loadingFailsafeTimeout = setTimeout(() => {
            if (loadingOverlay && !loadingOverlay.classList.contains('hidden')) {
                hideLoadingOverlay();
                console.log('[Loading] Failsafe: auto-hid spinner after 3s');
            }
        }, 3000);
    }
}

/**
 * Update UI based on current state
 */
function updateUI() {
    updateCounter();
    updateFavoriteButton();
    updateTrashButton();
    updateFilePathDisplay();
}

/**
 * Update the image counter
 */
function updateCounter() {
    const counter = document.getElementById('counter');
    if (counter) {
        counter.textContent = `${state.currentIndex + 1} / ${state.images.length}`;
    }
}

/**
 * Update favorite button state
 */
function updateFavoriteButton() {
    if (!heartBtn) return;
    
    const currentSrc = state.images[state.currentIndex];
    if (!currentSrc) return;
    
    const path = extractPath(currentSrc);
    const isFavorite = state.favorites.has(path);
    
    // Toggle CSS class for styling
    heartBtn.classList.toggle('liked', isFavorite);
}

/**
 * Update trash button state
 */
function updateTrashButton() {
    if (!trashBtn) return;
    
    const currentSrc = state.images[state.currentIndex];
    if (!currentSrc) return;
    
    const path = extractPath(currentSrc);
    const isTrashed = state.trash.has(path);
    
    // Toggle CSS class for styling
    trashBtn.classList.toggle('trashed', isTrashed);
}

/**
 * Update filter badge count
 */
function updateFilterBadge() {
    if (!filterBadge) return;
    
    const count = state.favorites.size;
    filterBadge.textContent = count;
    filterBadge.style.display = count > 0 ? 'flex' : 'none';
}

/**
 * Update shuffle button state
 */
function updateShuffleButton() {
    if (!shuffleBtn) return;
    shuffleBtn.classList.toggle('active', state.shuffleEnabled);
}

/**
 * Update file path display at bottom left
 */
function updateFilePathDisplay() {
    if (!filePathDisplay) return;
    
    const currentSrc = state.images[state.currentIndex];
    if (!currentSrc) {
        filePathDisplay.innerHTML = '';
        return;
    }
    
    const path = extractPath(currentSrc);
    const filename = path.split('/').pop().split('\\').pop();
    const folderPath = path.substring(0, path.lastIndexOf('/')) || path.substring(0, path.lastIndexOf('\\'));
    const folderName = folderPath.split('/').pop().split('\\').pop();
    
    // Update text content directly instead of rebuilding innerHTML
    let folderEl = filePathDisplay.querySelector('.file-path-folder');
    let fileEl = filePathDisplay.querySelector('.file-path-filename');
    
    if (!folderEl || !fileEl) {
        // First render — create elements once
        filePathDisplay.innerHTML = `
            <div class="file-path-folder"></div>
            <div class="file-path-filename"></div>
        `;
        folderEl = filePathDisplay.querySelector('.file-path-folder');
        fileEl = filePathDisplay.querySelector('.file-path-filename');
        // Add listener ONCE
        folderEl.addEventListener('click', () => {
            const currentFolderPath = folderEl.dataset.path;
            if (currentFolderPath) enterFolderMode(currentFolderPath);
        });
    }
    
    folderEl.textContent = folderName;
    folderEl.title = folderPath;
    folderEl.dataset.path = folderPath;  // Store path for click handler
    fileEl.textContent = filename;
}

// ============ Actions ============

/**
 * Add favorite for current image (only adds, doesn't remove)
 * Used for double-tap gesture
 */
async function addFavorite() {
    const currentSrc = state.images[state.currentIndex];
    if (!currentSrc) return;
    
    const path = extractPath(currentSrc);
    
    // Check if image is in trash - prevent favoriting
    if (state.trash.has(path)) {
        showFavoriteBlockedFeedback();
        return;
    }
    
    // Only add if not already favorited
    if (state.favorites.has(path)) return;
    
    try {
        await API.addFavorite(currentSrc);
        state.favorites.add(path);
        
        // Favoriting = seen (mark immediately without waiting for buffer)
        markCurrentImageSeen(currentSrc);
        
        updateFavoriteButton();
        updateFilterBadge();
        
        // Trigger animation
        if (heartBtn) {
            heartBtn.classList.remove('animate-press');
            void heartBtn.offsetWidth; // Force reflow
            heartBtn.classList.add('animate-press');
        }
        
    } catch (error) {
        console.error('Failed to add favorite:', error);
    }
}

/**
 * Toggle favorite for current image (used by heart button)
 */
async function toggleFavorite() {
    const currentSrc = state.images[state.currentIndex];
    if (!currentSrc) return;
    
    const path = extractPath(currentSrc);
    
    // Check if image is in trash - prevent favoriting
    if (state.trash.has(path)) {
        showFavoriteBlockedFeedback();
        return;
    }
    
    try {
        if (state.favorites.has(path)) {
            await API.removeFavorite(currentSrc);
            state.favorites.delete(path);
        } else {
            await API.addFavorite(currentSrc);
            state.favorites.add(path);
        }
        
        updateFavoriteButton();
        updateFilterBadge();
        
        // Trigger animation
        if (heartBtn) {
            heartBtn.classList.remove('animate-press');
            void heartBtn.offsetWidth; // Force reflow
            heartBtn.classList.add('animate-press');
        }
        
    } catch (error) {
        console.error('Failed to toggle favorite:', error);
    }
}

/**
 * Toggle trash for current image
 */
async function toggleTrash() {
    const currentSrc = state.images[state.currentIndex];
    if (!currentSrc) return;
    
    const path = extractPath(currentSrc);
    
    try {
        if (state.trash.has(path)) {
            await API.removeFromTrash(currentSrc);
            state.trash.delete(path);
            showTrashIconFeedback(false); // Show "unmarked" feedback
        } else {
            await API.addToTrash(currentSrc);
            state.trash.add(path);
            // Remove from favorites if present (mutual exclusion)
            state.favorites.delete(path);
            showTrashIconFeedback(true); // Show "marked for deletion" feedback
            // Trashing = seen (mark immediately)
            markCurrentImageSeen(currentSrc);
        }
        
        updateTrashButton();
        updateFavoriteButton();
        updateFilterBadge();
        
        // Trigger animation
        if (trashBtn) {
            trashBtn.classList.remove('animate-press');
            void trashBtn.offsetWidth; // Force reflow
            trashBtn.classList.add('animate-press');
        }
        
    } catch (error) {
        console.error('Failed to toggle trash:', error);
    }
}

/**
 * Show trash icon feedback in center of screen
 */
function showTrashIconFeedback(isMarked) {
    // Remove any existing feedback
    const existing = document.querySelector('.trash-icon-feedback');
    if (existing) existing.remove();
    
    // Create feedback element
    const feedback = document.createElement('div');
    feedback.className = 'trash-icon-feedback';
    feedback.innerHTML = `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/>
            ${isMarked ? '<line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>' : ''}
        </svg>
        <span>${isMarked ? 'Marked for Deletion' : 'Removed from Trash'}</span>
    `;
    
    document.body.appendChild(feedback);
    
    // Trigger animation
    requestAnimationFrame(() => {
        feedback.classList.add('visible');
    });
    
    // Remove after delay
    setTimeout(() => {
        feedback.classList.remove('visible');
        setTimeout(() => feedback.remove(), 300);
    }, 800);
}

/**
 * Show feedback when trying to favorite a trashed image
 */
function showFavoriteBlockedFeedback() {
    // Remove any existing feedback
    const existing = document.querySelector('.trash-icon-feedback');
    if (existing) existing.remove();
    
    // Create feedback element
    const feedback = document.createElement('div');
    feedback.className = 'trash-icon-feedback';
    feedback.innerHTML = `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10"/>
            <line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/>
        </svg>
        <span>Cannot favorite - marked for deletion</span>
    `;
    
    document.body.appendChild(feedback);
    
    // Trigger animation
    requestAnimationFrame(() => {
        feedback.classList.add('visible');
    });
    
    // Remove after delay
    setTimeout(() => {
        feedback.classList.remove('visible');
        setTimeout(() => feedback.remove(), 300);
    }, 1500);
}

/**
 * Toggle favorites mode
 */
async function toggleFavoritesMode() {
    // Trigger animation
    if (filterBtn) {
        filterBtn.classList.remove('animate-press');
        void filterBtn.offsetWidth; // Force reflow
        filterBtn.classList.add('animate-press');
    }
    
    if (state.showingFavoritesOnly) {
        exitFavoritesMode();
        state.currentTopNavFolder = 'all';
    } else {
        await enterFavoritesMode();
        state.currentTopNavFolder = 'likes';
    }
    
    // Update filter button active state
    if (filterBtn) {
        filterBtn.classList.toggle('active', state.showingFavoritesOnly);
    }
    
    updateTopNavActiveState();
}

/**
 * Enter favorites mode
 */
async function enterFavoritesMode() {
    state.savedIndex = state.currentIndex;
    state.allImages = [...state.images];
    state.unshuffledImages = []; // Clear shuffle backup for new context
    state.showingFavoritesOnly = true;
    
    try {
        state.images = await API.getFavoriteImages(state.currentSortOrder);
        
        // If shuffle is enabled, shuffle the favorites
        if (state.shuffleEnabled && state.images.length > 0) {
            state.unshuffledImages = [...state.images];
            shuffleArray(state.images);
        }
        
        // Reset current index for favorites view
        state.currentIndex = 0;
        
        if (state.images.length > 0) {
            showLoadingOverlay();
            buildSlides(0);
            prioritizeFirstImage();
            updateUI(); // Update UI to show correct image info
            updateTopNavActiveState(); // Update top nav to show "Likes"
            // Scroll to first image
            scrollToImage(0);
        } else {
            if (noFavorites) noFavorites.style.display = 'flex';
        }
        
    } catch (error) {
        console.error('Failed to enter favorites mode:', error);
    }
}

/**
 * Exit favorites mode
 */
async function exitFavoritesMode() {
    state.showingFavoritesOnly = false;
    state.unshuffledImages = []; // Clear shuffle backup
    state.images = [...state.allImages];
    state.allImages = [];
    
    // If shuffle is enabled, shuffle the restored images
    if (state.shuffleEnabled && state.images.length > 0) {
        state.unshuffledImages = [...state.images];
        shuffleArray(state.images);
    }
    
    // Restore to saved index
    state.currentIndex = state.savedIndex;
    
    if (noFavorites) noFavorites.style.display = 'none';
    
    showLoadingOverlay();
    buildSlides(state.savedIndex);
    prioritizeFirstImage(state.savedIndex);
    updateUI(); // Update UI to show correct image info
    scrollToImage(state.savedIndex, 'instant'); // Instant scroll - already showing loading overlay
}

/**
 * Toggle shuffle mode
 * Shuffles/unshuffles the current images in place
 */
async function toggleShuffle() {
    state.shuffleEnabled = !state.shuffleEnabled;
    
    try {
        await API.updateSettings({ shuffle: state.shuffleEnabled });
        updateShuffleButton();
        
        // Trigger animation
        if (shuffleBtn) {
            shuffleBtn.classList.remove('animate-press');
            void shuffleBtn.offsetWidth; // Force reflow
            shuffleBtn.classList.add('animate-press');
        }
        
        if (state.shuffleEnabled) {
            // Save current order before shuffling
            state.unshuffledImages = [...state.images];
            // Shuffle in place
            shuffleArray(state.images);
        } else {
            // Restore unshuffled order
            if (state.unshuffledImages.length > 0) {
                state.images = [...state.unshuffledImages];
                state.unshuffledImages = [];
            }
        }
        
        // Reset to first image and rebuild slides
        state.currentIndex = 0;
        showLoadingOverlay();
        buildSlides(0);
        prioritizeFirstImage();
        updateUI(); // Update UI to show correct image info
        
    } catch (error) {
        console.error('Failed to toggle shuffle:', error);
    }
}

/**
 * Fisher-Yates shuffle algorithm
 * Shuffles array in place
 */
function shuffleArray(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}

// ============ Folder Mode ============

/**
 * Enter folder mode
 */
async function enterFolderMode(folderPath) {
    state.savedIndex = state.currentIndex;
    state.savedImages = [...state.images];
    state.unshuffledImages = []; // Clear shuffle backup for new context
    state.showingFolderOnly = true;
    state.currentFolderFilter = folderPath;
    state.currentTopNavFolder = folderPath;
    
    try {
        state.images = await API.getImagesByFolder(folderPath, state.currentSortOrder);
        
        // If shuffle is enabled, shuffle the folder images
        if (state.shuffleEnabled && state.images.length > 0) {
            state.unshuffledImages = [...state.images];
            shuffleArray(state.images);
        }
        
        // Reset current index for new folder
        state.currentIndex = 0;
        
        showLoadingOverlay();
        buildSlides(0);
        prioritizeFirstImage();
        updateUI(); // Update UI to show correct image info
        updateTopNavActiveState(); // Update top nav to show active folder
        scrollToImage(0, 'instant'); // Always start at first image
        
    } catch (error) {
        console.error('Failed to enter folder mode:', error);
    }
}

/**
 * Exit folder mode
 */
function exitFolderMode() {
    state.showingFolderOnly = false;
    state.currentFolderFilter = null;
    state.currentTopNavFolder = 'all';
    state.unshuffledImages = []; // Clear shuffle backup
    state.images = [...state.savedImages];
    state.savedImages = [];
    
    // If shuffle is enabled, shuffle the restored images
    if (state.shuffleEnabled && state.images.length > 0) {
        state.unshuffledImages = [...state.images];
        shuffleArray(state.images);
    }
    
    // Restore to saved index
    state.currentIndex = state.savedIndex;
    
    showLoadingOverlay();
    buildSlides(state.savedIndex);
    prioritizeFirstImage(state.savedIndex);
    updateUI(); // Update UI to show correct image info
    updateTopNavActiveState(); // Update top nav to show "All"
    scrollToImage(state.savedIndex, 'instant'); // Instant scroll - already showing loading overlay
}

// ============ Trash Mode ============

/**
 * View trash
 */
async function viewTrash() {
    state.savedIndex = state.currentIndex;
    state.savedImages = [...state.images]; // Backup current images
    state.unshuffledImages = []; // Clear shuffle backup
    state.showingTrashOnly = true;
    
    // Close settings modal if open
    if (settingsModal) settingsModal.style.display = 'none';
    if (trashModal) trashModal.style.display = 'none';
    
    try {
        state.images = await API.getTrashImages(state.currentSortOrder);
        
        // If shuffle is enabled, shuffle the trash images
        if (state.shuffleEnabled && state.images.length > 0) {
            state.unshuffledImages = [...state.images];
            shuffleArray(state.images);
        }
        
        // Reset current index for trash view
        state.currentIndex = 0;
        
        if (state.images.length > 0) {
            showLoadingOverlay();
            buildSlides(0);
            prioritizeFirstImage();
            updateUI(); // Update UI to show correct image info
            updateTopNavActiveState(); // Update top nav to show "Trash"
        } else {
            // Show empty trash placeholder
            hideLoadingOverlay();
            if (scrollContainer) scrollContainer.innerHTML = '';
            if (noTrash) noTrash.style.display = 'flex';
            if (filePathDisplay) filePathDisplay.style.display = 'none'; // Hide file path display
            updateTopNavActiveState(); // Update top nav to show "Trash"
        }
        
    } catch (error) {
        console.error('Failed to view trash:', error);
    }
}

/**
 * Exit trash mode
 */
async function exitTrashMode() {
    state.showingTrashOnly = false;
    state.unshuffledImages = []; // Clear shuffle backup
    
    // Restore backed up images, or reload if backup is empty
    if (state.savedImages.length > 0) {
        state.images = [...state.savedImages];
        state.savedImages = [];
    } else {
        // Reload images from API if no backup exists
        try {
            state.images = await API.getImages(state.currentSortOrder);
        } catch (error) {
            console.error('Failed to reload images:', error);
        }
    }
    
    // If shuffle is enabled, shuffle the restored images
    if (state.shuffleEnabled && state.images.length > 0) {
        state.unshuffledImages = [...state.images];
        shuffleArray(state.images);
    }
    
    // Restore to saved index
    state.currentIndex = state.savedIndex;
    
    if (noTrash) noTrash.style.display = 'none';
    if (filePathDisplay) filePathDisplay.style.display = ''; // Show file path display again
    
    showLoadingOverlay();
    buildSlides(state.savedIndex);
    prioritizeFirstImage(state.savedIndex);
    updateUI(); // Update UI to show correct image info
    updateTopNavActiveState(); // Update top nav to show "All"
    scrollToImage(state.savedIndex, 'instant'); // Instant scroll - already showing loading overlay
}

// ============ Unseen Mode ============

/**
 * Enter unseen-only mode.
 * Shows only images the user has not yet scrolled past.
 */
async function enterUnseenMode() {
    state.savedIndex = state.currentIndex;
    state.savedImages = [...state.images]; // Backup current images
    state.unshuffledImages = []; // Clear shuffle backup
    state.showingUnseenOnly = true;
    
    try {
        state.images = await API.getUnseenImages(state.currentSortOrder);
        
        // Reset current index
        state.currentIndex = 0;
        
        if (state.images.length > 0) {
            showLoadingOverlay();
            buildSlides(0);
            prioritizeFirstImage();
            updateUI();
            updateTopNavActiveState();
            scrollToImage(0, 'instant');
        } else {
            // All images have been seen — show empty state
            hideLoadingOverlay();
            if (scrollContainer) scrollContainer.innerHTML = '';
            if (noUnseen) noUnseen.style.display = 'flex';
            if (filePathDisplay) filePathDisplay.style.display = 'none';
            updateTopNavActiveState();
        }
        
    } catch (error) {
        console.error('Failed to enter unseen mode:', error);
    }
}

/**
 * Exit unseen-only mode, restoring previous feed.
 */
async function exitUnseenMode() {
    state.showingUnseenOnly = false;
    state.unshuffledImages = []; // Clear shuffle backup
    
    // Restore backed up images, or reload if backup is empty
    if (state.savedImages.length > 0) {
        state.images = [...state.savedImages];
        state.savedImages = [];
    } else {
        try {
            state.images = await API.getImages(state.currentSortOrder);
        } catch (error) {
            console.error('Failed to reload images:', error);
        }
    }
    
    // If shuffle is enabled, shuffle the restored images
    if (state.shuffleEnabled && state.images.length > 0) {
        state.unshuffledImages = [...state.images];
        shuffleArray(state.images);
    }
    
    // Restore to saved index
    state.currentIndex = state.savedIndex;
    
    if (noUnseen) noUnseen.style.display = 'none';
    if (filePathDisplay) filePathDisplay.style.display = '';
    
    showLoadingOverlay();
    buildSlides(state.savedIndex);
    prioritizeFirstImage(state.savedIndex);
    updateUI();
    updateTopNavActiveState();
    scrollToImage(state.savedIndex, 'instant');
}

/**
 * Show a generalized confirmation modal
 * @param {Object} options - Modal options
 * @param {string} options.title - Modal title
 * @param {string} options.message - Confirmation message
 * @param {string} [options.confirmText='Confirm'] - Confirm button text
 * @param {string} [options.cancelText='Cancel'] - Cancel button text
 * @param {Function} options.onConfirm - Callback to execute on confirm
 * @param {boolean} [options.danger=true] - Whether to style confirm button as dangerous (red)
 */
function showConfirmModal(options) {
    const { title, message, confirmText = 'Confirm', cancelText = 'Cancel', onConfirm, danger = true } = options;
    
    pendingConfirmAction = onConfirm;
    
    // Update modal content
    const titleEl = deleteConfirmModal.querySelector('h3');
    if (titleEl) titleEl.textContent = title;
    deleteConfirmMessage.textContent = message;
    deleteConfirmBtn.textContent = confirmText;
    deleteCancelBtn.textContent = cancelText;
    
    // Toggle danger styling
    deleteConfirmBtn.classList.toggle('danger', danger);
    
    deleteConfirmModal.style.display = 'flex';
}

/**
 * Handle confirm button click - executes pending action
 */
async function handleConfirmAction() {
    if (pendingConfirmAction) {
        try {
            await pendingConfirmAction();
        } catch (error) {
            console.error('Confirm action failed:', error);
        }
        pendingConfirmAction = null;
    }
    hideDeleteConfirm();
}

/**
 * Confirm empty trash
 */
function confirmEmptyTrash() {
    showConfirmModal({
        title: 'Delete Photos Permanently?',
        message: `This will permanently delete ${state.trash.size} photo${state.trash.size !== 1 ? 's' : ''} from your device. This action cannot be undone.`,
        confirmText: 'Delete',
        cancelText: 'Cancel',
        danger: true,
        onConfirm: async () => {
            await API.emptyTrash();
            state.trash.clear();
            hideTrashModal();
            exitTrashMode();
        }
    });
}

// ============ Modals ============

function showInfoModal() {
    if (!infoModal || !infoModalBody) return;
    
    const currentSrc = state.images[state.currentIndex];
    if (!currentSrc) {
        infoModalBody.innerHTML = '<p>No image selected</p>';
        infoModal.style.display = 'flex';
        return;
    }
    
    const path = extractPath(currentSrc);
    const filename = path.split('/').pop().split('\\').pop();
    const folder = path.substring(0, path.lastIndexOf('/')) || path.substring(0, path.lastIndexOf('\\'));
    
    // Check if favorited or trashed
    const isFavorite = state.favorites.has(path);
    const isTrashed = state.trash.has(path);
    
    // Show loading state
    infoModalBody.innerHTML = '<div class="info-loading">Loading metadata...</div>';
    infoModal.style.display = 'flex';
    
    // Fetch EXIF data from API
    API.getImageMetadata(path).then(metadata => {
        // Extract EXIF data if available
        const exif = metadata.exif || {};
        const camera = exif.Model || exif.Make ? [exif.Make, exif.Model].filter(Boolean).join(' ') : null;
        const photoDate = exif.DateTimeOriginal || exif.DateTime || null;
        
        infoModalBody.innerHTML = `
            <div class="info-row">
                <span class="info-label">Filename</span>
                <span class="info-value">${filename}</span>
            </div>
            <div class="info-row">
                <span class="info-label">Folder</span>
                <span class="info-value">${folder}</span>
            </div>
            <div class="info-row">
                <span class="info-label">Position</span>
                <span class="info-value">${state.currentIndex + 1} of ${state.images.length}</span>
            </div>
            <div class="info-row">
                <span class="info-label">Status</span>
                <span class="info-value">
                    ${isFavorite ? '❤️ Favorited' : isTrashed ? '🗑️ Marked for deletion' : '—'}
                </span>
            </div>
            ${metadata.created ? `
            <div class="info-row">
                <span class="info-label">Date Created</span>
                <span class="info-value">${metadata.created}</span>
            </div>` : ''}
            ${metadata.modified ? `
            <div class="info-row">
                <span class="info-label">Modified</span>
                <span class="info-value">${metadata.modified}</span>
            </div>` : ''}
            ${camera ? `
            <div class="info-row">
                <span class="info-label">Camera</span>
                <span class="info-value">${camera}</span>
            </div>` : ''}
            ${photoDate ? `
            <div class="info-row">
                <span class="info-label">Photo Date</span>
                <span class="info-value">${photoDate}</span>
            </div>` : ''}
            ${metadata.size_formatted ? `
            <div class="info-row">
                <span class="info-label">File Size</span>
                <span class="info-value">${metadata.size_formatted}</span>
            </div>` : ''}
            ${metadata.resolution ? `
            <div class="info-row">
                <span class="info-label">Dimensions</span>
                <span class="info-value">${metadata.resolution}</span>
            </div>` : ''}
        `;
    }).catch(error => {
        console.error('Failed to load metadata:', error);
        infoModalBody.innerHTML = `
            <div class="info-row">
                <span class="info-label">Filename</span>
                <span class="info-value">${filename}</span>
            </div>
            <div class="info-row">
                <span class="info-label">Folder</span>
                <span class="info-value">${folder}</span>
            </div>
            <div class="info-row">
                <span class="info-label">Position</span>
                <span class="info-value">${state.currentIndex + 1} of ${state.images.length}</span>
            </div>
            <div class="info-row">
                <span class="info-label">Status</span>
                <span class="info-value">
                    ${isFavorite ? '❤️ Favorited' : isTrashed ? '🗑️ Marked for deletion' : '—'}
                </span>
            </div>
        `;
    });
}

function hideInfoModal() {
    if (infoModal) infoModal.style.display = 'none';
}

function showSettingsModal() {
    if (settingsModal) {
        settingsModal.style.display = 'flex';
        loadSettingsModalData();
        setupSettingsTabs();
    }
}

/**
 * Setup settings modal tab switching
 */
function setupSettingsTabs() {
    const tabs = document.querySelectorAll('.settings-tab');
    const tabContents = document.querySelectorAll('.settings-tab-content');
    
    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            const targetTab = tab.dataset.tab;
            
            // Update tab active states
            tabs.forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            
            // Update content visibility
            tabContents.forEach(content => {
                content.classList.remove('active');
                if (content.id === `settingsTab${targetTab.charAt(0).toUpperCase() + targetTab.slice(1)}`) {
                    content.classList.add('active');
                }
            });
        });
    });
}

/**
 * Load data into settings modal
 */
async function loadSettingsModalData() {
    try {
        // Load folders
        const folders = await API.getFolders();
        renderSettingsFolderList(folders);
        
        // Load stats
        const counts = await API.getImageCount();
        const folderCountEl = document.getElementById('settingsFolderCount');
        const imageCountEl = document.getElementById('settingsImageCount');
        if (folderCountEl) folderCountEl.textContent = folders.length;
        if (imageCountEl) imageCountEl.textContent = counts.imageCount;
        
        // Load cache info
        const cacheInfo = await API.getCacheInfo();
        const cacheSizeEl = document.getElementById('cacheSizeDisplay');
        if (cacheSizeEl) cacheSizeEl.textContent = cacheInfo.size_formatted || '0 B';
        
        // Load optimization settings and update toggle states
        const settings = await API.getSettings();
        
        // Re-sync live state from authoritative backend — handles divergence from failed saves
        if (settings.optimizations) {
            state.optimizations = { ...state.optimizations, ...settings.optimizations };
        }
        
        const thumbnailToggle = document.getElementById('toggleThumbnailCache');
        const videoPosterToggle = document.getElementById('toggleVideoPoster');
        const fillScreenToggle = document.getElementById('toggleFillScreen');
        const autoAdvanceToggle = document.getElementById('toggleAutoAdvance');
        const autoAdvanceDelaySlider = document.getElementById('autoAdvanceDelaySlider');
        const autoAdvanceDelayValue = document.getElementById('autoAdvanceDelayValue');
        const preloadDistanceSlider = document.getElementById('preloadDistanceSlider');
        const preloadDistanceValue = document.getElementById('preloadDistanceValue');
        const dateSourceToggle = document.getElementById('toggleDateSource');
        const dateSourceLabel = document.getElementById('dateSourceLabel');
        const hddFriendlyToggle = document.getElementById('toggleHDDFriendly');

        if (thumbnailToggle) thumbnailToggle.checked = settings.optimizations?.thumbnail_cache || false;
        if (videoPosterToggle) videoPosterToggle.checked = settings.optimizations?.video_poster_cache || false;
        if (fillScreenToggle) fillScreenToggle.checked = settings.optimizations?.fill_screen || false;
        if (autoAdvanceToggle) autoAdvanceToggle.checked = settings.optimizations?.auto_advance || false;
        if (autoAdvanceDelaySlider) autoAdvanceDelaySlider.value = settings.optimizations?.auto_advance_delay ?? 3;
        if (autoAdvanceDelayValue) autoAdvanceDelayValue.textContent = settings.optimizations?.auto_advance_delay ?? 3;
        if (preloadDistanceSlider) preloadDistanceSlider.value = settings.optimizations?.preload_distance ?? 3;
        if (preloadDistanceValue) preloadDistanceValue.textContent = settings.optimizations?.preload_distance ?? 3;
        if (hddFriendlyToggle) hddFriendlyToggle.checked = settings.optimizations?.hdd_friendly || false;
        // date_source: 'ctime' → checkbox on, 'mtime' (default) → checkbox off
        const useCtime = (settings.optimizations?.date_source ?? 'mtime') === 'ctime';
        if (dateSourceToggle) dateSourceToggle.checked = useCtime;
        if (dateSourceLabel) dateSourceLabel.textContent = useCtime ? 'Created Date' : 'Modified Date';
        
        // Setup add folder form
        const addFolderForm = document.getElementById('settingsAddFolderForm');
        if (addFolderForm) {
            addFolderForm.onsubmit = async (e) => {
                e.preventDefault();
                const input = document.getElementById('settingsFolderPath');
                if (input && input.value.trim()) {
                    try {
                        await API.addFolder(input.value.trim());
                        input.value = '';
                        loadSettingsModalData();
                    } catch (error) {
                        console.error('Failed to add folder:', error);
                    }
                }
            };
        }
        
        // Setup clear cache button
        const clearCacheBtn = document.getElementById('clearCacheBtn');
        if (clearCacheBtn) {
            clearCacheBtn.onclick = () => {
                showConfirmModal({
                    title: 'Clear Cache?',
                    message: 'This will delete all cached thumbnails. Images will need to be re-cached on next load.',
                    confirmText: 'Clear Cache',
                    cancelText: 'Cancel',
                    danger: false,
                    onConfirm: async () => {
                        await API.clearCache();
                        loadSettingsModalData();
                    }
                });
            };
        }
        
        // Setup trash button
        const settingsTrashBtn = document.getElementById('settingsTrashBtn');
        if (settingsTrashBtn) {
            settingsTrashBtn.onclick = showTrashModal;
        }
        
        // Update trash badge
        const trashBadge = document.getElementById('settingsTrashBadge');
        if (trashBadge) {
            trashBadge.textContent = state.trash.size;
            trashBadge.style.display = state.trash.size > 0 ? 'inline' : 'none';
        }
        
        // Load and render seen stats
        await loadAndRenderSeenStats();
        
        // Setup Reset Seen History button
        const resetSeenBtn = document.getElementById('resetSeenBtn');
        if (resetSeenBtn) {
            resetSeenBtn.onclick = () => {
                showConfirmModal({
                    title: 'Reset Watch History?',
                    message: 'This will clear all records of which photos you\'ve seen. Your New feed will reset to show all images again.',
                    confirmText: 'Reset History',
                    cancelText: 'Cancel',
                    danger: false,
                    onConfirm: async () => {
                        await API.resetSeen();
                        state.seenStats = { seen_count: 0, total_count: state.seenStats.total_count, total_scrolls: 0, percent_seen: 0 };
                        renderSeenStats();
                        // If currently in unseen mode, show the empty-state panel
                        if (state.showingUnseenOnly) {
                            if (scrollContainer) scrollContainer.innerHTML = '';
                            if (noUnseen) noUnseen.style.display = 'flex';
                            if (filePathDisplay) filePathDisplay.style.display = 'none';
                            hideLoadingOverlay();
                        }
                    }
                });
            };
        }
        
        // Setup logout button (check auth status first)
        setupLogoutButton();
        
    } catch (error) {
        console.error('Failed to load settings data:', error);
    }
}

/**
 * Render folder list in settings modal
 */
function renderSettingsFolderList(folders) {
    const listEl = document.getElementById('settingsFolderList');
    if (!listEl) return;
    
    if (!folders || folders.length === 0) {
        listEl.innerHTML = '<div class="settings-empty-state"><p>No folders added yet</p></div>';
        return;
    }
    
    listEl.innerHTML = folders.map(folder => `
        <div class="settings-folder-item">
            <span class="settings-folder-path">${folder}</span>
            <button class="settings-folder-remove" data-path="${folder}">×</button>
        </div>
    `).join('');
    
    // Add remove handlers
    listEl.querySelectorAll('.settings-folder-remove').forEach(btn => {
        btn.addEventListener('click', async () => {
            try {
                await API.removeFolder(btn.dataset.path);
                loadSettingsModalData();
            } catch (error) {
                console.error('Failed to remove folder:', error);
            }
        });
    });
}

function hideSettingsModal() {
    if (settingsModal) settingsModal.style.display = 'none';
}

/**
 * Load seen stats from API and render them in the settings modal.
 */
async function loadAndRenderSeenStats() {
    try {
        const stats = await API.getSeenStats();
        state.seenStats = stats;
        renderSeenStats();
    } catch (error) {
        console.warn('[Seen] Failed to load seen stats:', error);
    }
}

/**
 * Render seen stats into the Settings modal DOM elements.
 * Also updates the unseen count badge in the folders modal quick access.
 */
function renderSeenStats() {
    const { seen_count, total_count, total_scrolls, percent_seen } = state.seenStats;
    const unseen_count = Math.max(0, total_count - seen_count);
    
    // Settings modal stat elements
    const seenCountEl = document.getElementById('seenStatCount');
    const totalScrollsEl = document.getElementById('seenStatScrolls');
    const seenProgressEl = document.getElementById('seenStatProgress');
    const unseenCountEl = document.getElementById('seenStatUnseen');
    
    if (seenCountEl) seenCountEl.textContent = seen_count.toLocaleString();
    if (totalScrollsEl) totalScrollsEl.textContent = total_scrolls.toLocaleString();
    if (seenProgressEl) seenProgressEl.textContent = `${percent_seen}%`;
    if (unseenCountEl) unseenCountEl.textContent = unseen_count.toLocaleString();
    
    // Update unseen count badges (in top nav "New" tab and folders modal quick access)
    document.querySelectorAll('.unseen-count-badge').forEach(el => {
        el.textContent = unseen_count > 0 ? unseen_count.toLocaleString() : '';
    });
    
    // Update the "New" top nav tab label with count
    document.querySelectorAll('.top-nav-tab[data-folder="unseen"]').forEach(tab => {
        tab.textContent = unseen_count > 0 ? `New (${unseen_count.toLocaleString()})` : 'New';
    });
}

/**
 * Setup logout button - check auth status and show/hide logout button in header
 */
async function setupLogoutButton() {
    const logoutBtn = document.getElementById('settingsLogoutHeaderBtn');
    
    if (!logoutBtn) return;
    
    try {
        const response = await fetch('/api/auth/status');
        const data = await response.json();
        
        // Only show logout button if auth is enabled and user is authenticated
        if (data.auth_enabled && data.authenticated) {
            logoutBtn.style.display = 'inline-flex';
            
            logoutBtn.onclick = async () => {
                try {
                    const logoutResponse = await fetch('/logout', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json'
                        }
                    });
                    
                    if (logoutResponse.ok) {
                        // Redirect to login page
                        window.location.href = '/login';
                    }
                } catch (error) {
                    console.error('Failed to logout:', error);
                }
            };
        } else {
            logoutBtn.style.display = 'none';
        }
    } catch (error) {
        console.error('Failed to check auth status:', error);
        logoutBtn.style.display = 'none';
    }
}

function showShortcutsModal() {
    if (shortcutsModal) shortcutsModal.style.display = 'flex';
}

function hideShortcutsModal() {
    if (shortcutsModal) shortcutsModal.style.display = 'none';
}

function showTrashModal() {
    // Update trash count display
    const count = state.trash.size;
    if (trashCountInfo) {
        trashCountInfo.textContent = `${count} photo${count !== 1 ? 's' : ''} marked for deletion`;
    }
    
    // Enable/disable empty trash button based on count
    if (emptyTrashBtn) {
        emptyTrashBtn.disabled = count === 0;
    }
    
    if (trashModal) trashModal.style.display = 'flex';
}

function hideTrashModal() {
    if (trashModal) trashModal.style.display = 'none';
}

function hideDeleteConfirm() {
    if (deleteConfirmModal) deleteConfirmModal.style.display = 'none';
}

function showJumpModal() {
    if (jumpModal) {
        jumpTotal.textContent = state.images.length;
        jumpInput.value = '';
        jumpModal.style.display = 'flex';
        jumpInput.focus();
    }
}

function hideJumpModal() {
    if (jumpModal) jumpModal.style.display = 'none';
}

function handleJump() {
    const num = parseInt(jumpInput?.value);
    if (num && num >= 1 && num <= state.images.length) {
        const targetIndex = num - 1;
        const distance = Math.abs(targetIndex - state.currentIndex);
        
        // Use instant scroll for large jumps to avoid loading intermediate images
        scrollToImage(targetIndex, distance > 10 ? 'instant' : 'smooth');
        hideJumpModal();
    }
}

// ============ Folders Modal ============

async function showFoldersModal() {
    if (foldersModal) {
        foldersModal.style.display = 'flex';
        foldersSearchInput.value = '';
        foldersSortSelect.value = currentFolderSort;
        await loadFoldersModalData();
        foldersSearchInput?.focus();
    }
}

function hideFoldersModal() {
    if (foldersModal) foldersModal.style.display = 'none';
}

async function loadFoldersModalData() {
    if (!foldersList) return;
    
    foldersList.innerHTML = '<div class="info-loading">Loading folders...</div>';
    
    try {
        const folders = await API.getLeafFolders();
        
        if (!folders || folders.length === 0) {
            foldersList.innerHTML = `
                <div class="folders-modal-empty">
                    <p>No folders with images found</p>
                    <button class="folders-modal-empty-btn" id="foldersModalAddBtn">Add Folders</button>
                </div>
            `;
            document.getElementById('foldersModalAddBtn')?.addEventListener('click', () => {
                hideFoldersModal();
                showSettingsModal();
            });
            return;
        }
        
        leafFolders = folders;
        renderFoldersModalList();
        
    } catch (error) {
        console.error('Failed to load folders:', error);
        foldersList.innerHTML = '<div class="info-error">Failed to load folders</div>';
    }
}

function renderFoldersModalList(searchQuery = '') {
    if (!foldersList) return;
    
    const activeFolder = state.currentFolderFilter;
    
    // Calculate total count across all folders
    const totalCount = leafFolders.reduce((sum, f) => sum + f.count, 0);
    const likesCount = state.favorites.size;
    const trashCount = state.trash.size;
    
    let filteredFolders = leafFolders;
    if (searchQuery.trim()) {
        const query = searchQuery.toLowerCase();
        filteredFolders = leafFolders.filter(folder =>
            folder.name.toLowerCase().includes(query) ||
            folder.path.toLowerCase().includes(query)
        );
    }
    
    const sortedFolders = sortFolders(filteredFolders, currentFolderSort);
    
    // Build quick access row with All, New (Unseen), Likes, and Trash
    const isAllActive = !activeFolder && !state.showingFavoritesOnly && !state.showingTrashOnly && !state.showingUnseenOnly;
    const isUnseenActive = state.showingUnseenOnly;
    const isLikesActive = state.showingFavoritesOnly && !state.showingTrashOnly;
    const isTrashActive = state.showingTrashOnly;
    
    const quickAccessHtml = `
        <div class="folders-quick-access">
            <div class="folders-quick-access-item${isAllActive ? ' active' : ''}" data-folder-path="__all__">
                <div class="folders-quick-access-icon">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <rect x="3" y="3" width="7" height="7" rx="1"></rect>
                        <rect x="14" y="3" width="7" height="7" rx="1"></rect>
                        <rect x="14" y="14" width="7" height="7" rx="1"></rect>
                        <rect x="3" y="14" width="7" height="7" rx="1"></rect>
                    </svg>
                </div>
                <div class="folders-quick-access-label">All</div>
                <div class="folders-quick-access-count">${totalCount}</div>
            </div>
            <div class="folders-quick-access-item${isUnseenActive ? ' active' : ''}" data-folder-path="__unseen__">
                <div class="folders-quick-access-icon">
                    <svg viewBox="0 0 24 24" fill="none" stroke="${isUnseenActive ? '#34C759' : 'currentColor'}" stroke-width="2">
                        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
                        <circle cx="12" cy="12" r="3"></circle>
                        ${isUnseenActive ? '' : '<line x1="1" y1="1" x2="23" y2="23"></line>'}
                    </svg>
                </div>
                <div class="folders-quick-access-label">New</div>
                <div class="folders-quick-access-count unseen-count-badge"></div>
            </div>
            <div class="folders-quick-access-item${isLikesActive ? ' active' : ''}" data-folder-path="__likes__">
                <div class="folders-quick-access-icon">
                    <svg viewBox="0 0 24 24" fill="${isLikesActive ? '#FF2D55' : 'none'}" stroke="${isLikesActive ? '#FF2D55' : 'currentColor'}" stroke-width="2">
                        <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path>
                    </svg>
                </div>
                <div class="folders-quick-access-label">Likes</div>
                <div class="folders-quick-access-count">${likesCount}</div>
            </div>
            <div class="folders-quick-access-item${isTrashActive ? ' active' : ''}" data-folder-path="__trash__">
                <div class="folders-quick-access-icon">
                    <svg viewBox="0 0 24 24" fill="none" stroke="${isTrashActive ? '#FF3B30' : 'currentColor'}" stroke-width="2">
                        <polyline points="3 6 5 6 21 6"></polyline>
                        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                    </svg>
                </div>
                <div class="folders-quick-access-label">Trash</div>
                <div class="folders-quick-access-count">${trashCount}</div>
            </div>
        </div>
    `;
    
    if (sortedFolders.length === 0 && !searchQuery.trim()) {
        foldersList.innerHTML = `
            <div class="folders-modal-empty">
                <p>No folders found</p>
            </div>
        `;
        return;
    }
    
    // Build folder items
    const folderItemsHtml = sortedFolders.map(folder => {
        const isActive = activeFolder === folder.path;
        
        return `
            <div class="folders-modal-item${isActive ? ' active' : ''}" data-folder-path="${folder.path}">
                <div class="folders-modal-item-icon">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
                    </svg>
                </div>
                <div class="folders-modal-item-info">
                    <div class="folders-modal-item-name">${folder.name}</div>
                    <div class="folders-modal-item-path">${folder.path}</div>
                </div>
                <div class="folders-modal-item-count">${folder.count}</div>
            </div>
        `;
    }).join('');
    
    // Combine: quick access row at top, then folder items
    foldersList.innerHTML = quickAccessHtml + folderItemsHtml;
    
    // Add click handlers for quick access items
    document.querySelectorAll('.folders-quick-access-item').forEach(item => {
        item.addEventListener('click', async () => {
            const folderPath = item.dataset.folderPath;
            hideFoldersModal();
            
            if (folderPath === '__all__') {
                // Exit all filter modes
                if (state.showingFolderOnly) exitFolderMode();
                if (state.showingFavoritesOnly) exitFavoritesMode();
                if (state.showingTrashOnly) exitTrashMode();
                if (state.showingUnseenOnly) exitUnseenMode();
                state.currentTopNavFolder = 'all';
                updateTopNavActiveState();
            } else if (folderPath === '__unseen__') {
                // Enter unseen mode
                if (state.showingFolderOnly) exitFolderMode();
                if (state.showingFavoritesOnly) exitFavoritesMode();
                if (state.showingTrashOnly) exitTrashMode();
                if (!state.showingUnseenOnly) await enterUnseenMode();
                state.currentTopNavFolder = 'unseen';
                updateTopNavActiveState();
            } else if (folderPath === '__likes__') {
                // Enter favorites mode
                if (state.showingFolderOnly) exitFolderMode();
                if (state.showingTrashOnly) exitTrashMode();
                if (state.showingUnseenOnly) exitUnseenMode();
                if (!state.showingFavoritesOnly) await enterFavoritesMode();
                state.currentTopNavFolder = 'likes';
                updateTopNavActiveState();
            } else if (folderPath === '__trash__') {
                // Enter trash mode
                if (state.showingFolderOnly) exitFolderMode();
                if (state.showingFavoritesOnly) exitFavoritesMode();
                if (state.showingUnseenOnly) exitUnseenMode();
                if (!state.showingTrashOnly) await viewTrash();
                state.currentTopNavFolder = 'trash';
                updateTopNavActiveState();
            }
        });
    });
    
    // Add click handlers for folder items
    document.querySelectorAll('.folders-modal-item').forEach(item => {
        item.addEventListener('click', () => {
            const folderPath = item.dataset.folderPath;
            hideFoldersModal();
            
            // If clicking the already-active folder, scroll to first image
            if (state.currentFolderFilter === folderPath) {
                scrollToImage(0, 'instant');
            } else {
                enterFolderMode(folderPath);
            }
        });
    });
}

function sortFolders(folders, sortBy) {
    const sorted = [...folders];
    
    switch (sortBy) {
        case 'count':
            sorted.sort((a, b) => b.count - a.count);
            break;
        case 'name':
            sorted.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
            break;
        case 'newest':
            sorted.sort((a, b) => (b.newest_mtime || 0) - (a.newest_mtime || 0));
            break;
    }
    
    return sorted;
}

// ============ Top Nav ============

function initTopNav() {
    setTimeout(async () => {
        try {
            const folders = await API.getLeafFolders();
            folders.sort((a, b) => (a.newest_mtime || 0) - (b.newest_mtime || 0));
            state.topNavFolders = folders;
            state.topNavLoaded = true;
            renderTopNavTabs();
        } catch (error) {
            console.error('Failed to load folders for top nav:', error);
            renderTopNavTabs();
        }
    }, 1500);
}

function renderTopNavTabs() {
    if (!topNavTabs) return;
    
    topNavTabs.innerHTML = '';
    
    // Add Trash tab
    const trashTab = document.createElement('button');
    trashTab.className = 'top-nav-tab';
    trashTab.dataset.folder = 'trash';
    trashTab.textContent = 'Trash';
    trashTab.addEventListener('click', () => selectTopNavFolder('trash'));
    topNavTabs.appendChild(trashTab);
    
    // Add Likes tab
    const likesTab = document.createElement('button');
    likesTab.className = 'top-nav-tab';
    likesTab.dataset.folder = 'likes';
    likesTab.textContent = 'Likes';
    likesTab.addEventListener('click', () => selectTopNavFolder('likes'));
    topNavTabs.appendChild(likesTab);
    
    // Add folder tabs
    state.topNavFolders.forEach(folder => {
        const tab = document.createElement('button');
        tab.className = 'top-nav-tab';
        tab.dataset.folder = folder.path;
        const displayName = folder.name.length > 15 ? folder.name.substring(0, 15) + '…' : folder.name;
        tab.textContent = displayName;
        tab.title = folder.name;
        tab.addEventListener('click', () => selectTopNavFolder(folder.path));
        topNavTabs.appendChild(tab);
    });
    
    // Add Unseen tab
    const unseenTab = document.createElement('button');
    unseenTab.className = 'top-nav-tab';
    unseenTab.dataset.folder = 'unseen';
    unseenTab.textContent = 'New';
    unseenTab.addEventListener('click', () => selectTopNavFolder('unseen'));
    topNavTabs.appendChild(unseenTab);
    
    // Add All tab
    const allTab = document.createElement('button');
    allTab.className = 'top-nav-tab active';
    allTab.dataset.folder = 'all';
    allTab.textContent = 'All';
    allTab.addEventListener('click', () => selectTopNavFolder('all'));
    topNavTabs.appendChild(allTab);
    
    updateTopNavActiveState();
    
    topNavTabs.classList.add('animate-sweep');
    requestAnimationFrame(() => {
        topNavTabs.scrollLeft = topNavTabs.scrollWidth;
    });
}

async function selectTopNavFolder(folderPath) {
    if (folderPath === 'all') {
        if (state.showingFolderOnly) exitFolderMode();
        if (state.showingFavoritesOnly) exitFavoritesMode();
        if (state.showingTrashOnly) exitTrashMode();
        if (state.showingUnseenOnly) exitUnseenMode();
        state.currentTopNavFolder = 'all';
    } else if (folderPath === 'unseen') {
        if (state.showingFolderOnly) exitFolderMode();
        if (state.showingFavoritesOnly) exitFavoritesMode();
        if (state.showingTrashOnly) exitTrashMode();
        if (!state.showingUnseenOnly) await enterUnseenMode();
        state.currentTopNavFolder = 'unseen';
    } else if (folderPath === 'likes') {
        if (state.showingFolderOnly) exitFolderMode();
        if (state.showingTrashOnly) exitTrashMode();
        if (state.showingUnseenOnly) exitUnseenMode();
        if (!state.showingFavoritesOnly) await enterFavoritesMode();
        state.currentTopNavFolder = 'likes';
    } else if (folderPath === 'trash') {
        if (state.showingFolderOnly) exitFolderMode();
        if (state.showingFavoritesOnly) exitFavoritesMode();
        if (state.showingUnseenOnly) exitUnseenMode();
        if (!state.showingTrashOnly) await viewTrash();
        state.currentTopNavFolder = 'trash';
    } else {
        if (state.showingFavoritesOnly) exitFavoritesMode();
        if (state.showingTrashOnly) exitTrashMode();
        if (state.currentFolderFilter !== folderPath) {
            await enterFolderMode(folderPath);
        }
        state.currentTopNavFolder = folderPath;
    }
    
    updateTopNavActiveState();
}

function updateTopNavActiveState() {
    if (!topNavTabs) return;
    
    document.querySelectorAll('.top-nav-tab').forEach(tab => {
        tab.classList.remove('active');
    });
    
    let activeFolder = 'all';
    if (state.showingTrashOnly) activeFolder = 'trash';
    else if (state.showingFavoritesOnly) activeFolder = 'likes';
    else if (state.showingUnseenOnly) activeFolder = 'unseen';
    else if (state.showingFolderOnly) activeFolder = normalizePath(state.currentFolderFilter);
    
    // Find the matching tab - normalize paths for comparison
    let activeTab = null;
    document.querySelectorAll('.top-nav-tab').forEach(tab => {
        const tabFolder = tab.dataset.folder;
        if (normalizePath(tabFolder) === activeFolder) {
            activeTab = tab;
        }
    });
    
    if (activeTab) {
        activeTab.classList.add('active');
        // Scroll the active tab into view
        activeTab.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
    }
}

function toggleTopNavDropdown() {
    if (topNavDropdown) {
        topNavDropdown.classList.toggle('visible');
    }
}

/**
 * Handle dropdown option selection
 */
function handleDropdownOption(sortType) {
    // Close dropdown
    if (topNavDropdown) {
        topNavDropdown.classList.remove('visible');
    }
    
    // Update active state
    document.querySelectorAll('.dropdown-option').forEach(opt => {
        opt.classList.remove('active');
    });
    document.querySelector(`.dropdown-option[data-sort="${sortType}"]`)?.classList.add('active');
    
    switch (sortType) {
        case 'newest':
            // Already default, reload images
            reloadImages('newest');
            break;
        case 'oldest':
            reloadImages('oldest');
            break;
        case 'jump':
            showJumpModal();
            break;
    }
}

/**
 * Reload images with different sort order
 * Context-aware: reloads based on current view mode (folder, favorites, trash, or all)
 */
async function reloadImages(sortOrder) {
    try {
        // Store current sort order
        state.currentSortOrder = sortOrder;
        
        // Reload based on current view mode
        if (state.showingUnseenOnly) {
            state.images = await API.getUnseenImages(sortOrder);
        } else if (state.showingTrashOnly) {
            state.images = await API.getTrashImages(sortOrder);
        } else if (state.showingFavoritesOnly) {
            if (state.showingFolderOnly && state.currentFolderFilter) {
                state.images = await API.getFavoriteImagesByFolder(state.currentFolderFilter);
                // Sort locally since this endpoint doesn't support sort param
                if (sortOrder === 'oldest') {
                    state.images = [...state.images].reverse();
                }
            } else {
                state.images = await API.getFavoriteImages(sortOrder);
            }
        } else if (state.showingFolderOnly && state.currentFolderFilter) {
            state.images = await API.getImagesByFolder(state.currentFolderFilter, sortOrder);
        } else {
            state.images = await API.getImages(sortOrder);
        }
        
        // Clear shuffle backup when changing sort
        state.unshuffledImages = [];
        
        // Reset to first image
        state.currentIndex = 0;
        
        showLoadingOverlay();
        buildSlides(0);
        prioritizeFirstImage();
        updateUI();
        
        // Scroll to first image - use instant since we're resetting position
        scrollToImage(0, 'instant');
        
    } catch (error) {
        console.error('Failed to reload images:', error);
    }
}

/**
 * Setup double-tap to like functionality
 * Double tap = spawn heart (and add favorite - only adds, doesn't remove)
 * Subsequent taps within 0.5s = spawn more hearts
 * Single tap = mute/unmute video
 */
function setupDoubleTapToLike() {
    let lastTapTime = 0;
    let lastTapTarget = null;
    let tapCount = 0;
    let singleTapTimeout = null;
    const TAP_WINDOW = 500; // 0.5 seconds for subsequent taps
    
    scrollContainer?.addEventListener('click', (e) => {
        const now = Date.now();
        const slide = e.target.closest('.image-slide');
        
        // Only handle clicks on slides (not buttons)
        if (!slide || e.target.closest('button') || e.target.closest('.action-bar')) {
            return;
        }
        
        const src = slide.dataset.src;
        const isVideo = isVideoUrl(src);
        
        // Check if this is a tap within the window on the same slide
        if (now - lastTapTime < TAP_WINDOW && lastTapTarget === slide) {
            // Clear any pending single-tap timeout
            if (singleTapTimeout) {
                clearTimeout(singleTapTimeout);
                singleTapTimeout = null;
            }
            
            // Subsequent tap - spawn heart
            e.preventDefault();
            e.stopPropagation();
            
            // First subsequent tap adds favorite (only adds, doesn't toggle off)
            if (tapCount === 1) {
                addFavorite();
            }
            
            // Show heart animation at tap position
            showHeartAnimation(slide, e.clientX, e.clientY);
            
            tapCount++;
            lastTapTime = now;
        } else {
            // First tap - wait to see if there's a second tap
            lastTapTime = now;
            lastTapTarget = slide;
            tapCount = 1;
            
            // After the window expires, if there was only one tap, handle as single tap
            singleTapTimeout = setTimeout(() => {
                // If we're still on the same slide and only had one tap
                if (tapCount === 1 && lastTapTarget === slide && lastTapTime === now) {
                    // Single tap on video — toggle global mute (Instagram-style)
                    if (isVideo) {
                        toggleGlobalMute();
                    }
                }
                singleTapTimeout = null;
            }, TAP_WINDOW);
        }
    });
}

/**
 * Show heart animation on double-tap at tap position
 */
function showHeartAnimation(slide, x, y) {
    const heart = document.createElement('div');
    heart.className = 'double-tap-heart';
    heart.innerHTML = `
        <svg viewBox="0 0 24 24" fill="#FF2D55">
            <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path>
        </svg>
    `;
    
    // Position heart at tap location
    const slideRect = slide.getBoundingClientRect();
    heart.style.left = `${x - slideRect.left}px`;
    heart.style.top = `${y - slideRect.top}px`;
    heart.style.transform = 'translate(-50%, -50%)';
    
    slide.appendChild(heart);
    
    // Remove after animation
    setTimeout(() => {
        heart.remove();
    }, 800);
}

// ============ Keyboard Handling ============

function handleKeyboard(e) {
    // Check if modal is open
    if (isAnyModalOpen()) {
        if (e.key === 'Escape') {
            // Close all modals
            [infoModal, settingsModal, shortcutsModal, foldersModal, trashModal, jumpModal, deleteConfirmModal].forEach(modal => {
                if (modal) modal.style.display = 'none';
            });
        }
        return;
    }
    
    // Don't trigger if typing in input
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') {
        return;
    }
    
    switch (e.key) {
        case 'h':
        case 'ArrowLeft':
            toggleTrash();
            break;
        case 'j':
        case 'ArrowDown':
            scrollToImage(state.currentIndex + 1);
            break;
        case 'k':
        case 'ArrowUp':
            scrollToImage(state.currentIndex - 1);
            break;
        case 'l':
        case 'ArrowRight':
            toggleFavorite();
            break;
        case 'f':
            toggleFavoritesMode();
            break;
        case 'd':
            if (state.showingTrashOnly) {
                exitTrashMode();
            } else {
                viewTrash();
            }
            break;
        case 'm':
            // Toggle global mute (Instagram-style: affects all videos)
            toggleGlobalMute();
            break;
        case 'i':
            showInfoModal();
            break;
        case 's':
            showSettingsModal();
            break;
        case '?':
            showShortcutsModal();
            break;
        case 'Escape':
            // Exit current mode
            if (state.showingFavoritesOnly) exitFavoritesMode();
            if (state.showingFolderOnly) exitFolderMode();
            if (state.showingTrashOnly) exitTrashMode();
            break;
    }
}

// ============ Auto-Advance Functions ============

/**
 * Start the auto-advance timer for photos
 * Only starts if auto-advance is enabled and current item is a photo
 */
function startAutoAdvanceTimer() {
    // Only start if auto-advance is enabled
    if (!state.optimizations.auto_advance) return;
    
    // Don't start if at the last image
    if (state.currentIndex >= state.images.length - 1) return;
    
    // Clear any existing timer
    clearAutoAdvanceTimer();
    
    const currentSrc = state.images[state.currentIndex];
    
    // Only start timer for photos (not videos)
    if (!isVideoUrl(currentSrc)) {
        const delay = state.optimizations.auto_advance_delay * 1000;
        autoAdvanceTimer = setTimeout(() => {
            // Double-check we're still on the same image and not at the end
            if (state.currentIndex < state.images.length - 1) {
                scrollToImage(state.currentIndex + 1);
            }
        }, delay);
    }
}

/**
 * Clear the auto-advance timer
 */
function clearAutoAdvanceTimer() {
    if (autoAdvanceTimer) {
        clearTimeout(autoAdvanceTimer);
        autoAdvanceTimer = null;
    }
}

/**
 * Update the auto-advance indicator visibility
 */
function updateAutoAdvanceIndicator() {
    const indicator = document.getElementById('autoAdvanceIndicator');
    if (indicator) {
        indicator.style.display = state.optimizations.auto_advance ? 'flex' : 'none';
    }
}

/**
 * Show a toast notification
 * @param {string} message - The message to display
 */
function showToast(message) {
    const toast = document.getElementById('toastNotification');
    if (toast) {
        toast.textContent = message;
        toast.style.display = 'block';
        
        // Hide after 2 seconds
        setTimeout(() => {
            toast.style.display = 'none';
        }, 2000);
    }
}

/**
 * Toggle auto-advance off (called when indicator is clicked)
 */
function toggleAutoAdvanceOff() {
    state.optimizations.auto_advance = false;
    clearAutoAdvanceTimer();
    updateAutoAdvanceIndicator();
    
    // Update the settings toggle if it exists
    const toggle = document.getElementById('toggleAutoAdvance');
    if (toggle) {
        toggle.checked = false;
    }
    
    // Save to server
    API.updateSettings({ optimizations: { auto_advance: false } });
    
    showToast('Auto-advance turned off');
}

/**
 * Scroll to a specific image
 * @param {number} index - Target image index
 * @param {string} behavior - Scroll behavior: 'smooth', 'instant', or 'auto'
 *                            If not specified, uses 'smooth' for small distances, 'instant' for large
 */
function scrollToImage(index, behavior = null) {
    if (index < 0 || index >= state.images.length) return;
    
    // CRITICAL: Ensure target slide exists before querying DOM
    ensureSlideExists(index);
    
    const slide = document.querySelector(`.image-slide[data-index="${index}"]`);
    if (!slide) {
        console.error(`[scrollToImage] Failed to create slide ${index}`);
        return;
    }
    
    // Determine scroll behavior if not specified
    if (behavior === null) {
        const distance = Math.abs(index - state.currentIndex);
        behavior = distance > 10 ? 'instant' : 'smooth';
    }
    
    slide.scrollIntoView({ behavior });
}

// ============ Pull-to-Refresh ============

/**
 * Pull-to-refresh gesture on the top nav bar.
 * Dragging the nav down reveals a tip indicator; releasing past the
 * threshold triggers softRefreshImages().
 */
function setupPullToRefresh() {
    const navEl  = document.getElementById('topNav');
    const tipEl  = document.getElementById('pullRefreshTip');
    const textEl = document.getElementById('pullRefreshText');
    if (!navEl || !tipEl || !textEl) return;

    const THRESHOLD    = 80;   // px of real drag needed to trigger
    const MAX_DRAG     = 110;  // max visual translation of the nav
    const DAMPING      = 0.55; // rubber-band factor

    // Get safe-area-inset-top for PWA mode (returns 0 if not supported)
    const getSafeAreaTop = () => {
        const style = getComputedStyle(document.documentElement);
        const inset = style.getPropertyValue('--safe-area-inset-top') || 
                      style.getPropertyValue('padding-top') || '0px';
        return parseInt(inset, 10) || 0;
    };

    let startY        = 0;
    let startX        = 0;
    let isDragging    = false;
    let isVertical    = null;  // null = undecided, true = vertical, false = horizontal
    let thresholdMet  = false;

    function resetDrag() {
        isDragging   = false;
        isVertical   = null;
        thresholdMet = false;
    }

    function applySnapBack() {
        // Add transition class, then clear transform
        navEl.classList.add('snap-back');
        tipEl.classList.add('snap-back');

        navEl.style.transform = '';
        // Account for safe-area-inset in snap-back position
        const safeAreaTop = getSafeAreaTop();
        tipEl.style.top       = `${-52 + safeAreaTop}px`;
        tipEl.style.opacity   = '0';
        tipEl.classList.remove('threshold-met');
        textEl.textContent    = 'Pull to refresh';

        const cleanup = () => {
            navEl.classList.remove('snap-back');
            tipEl.classList.remove('snap-back');
            navEl.removeEventListener('transitionend', cleanup);
        };
        navEl.addEventListener('transitionend', cleanup, { once: true });
        // Safety timeout in case transitionend doesn't fire
        setTimeout(cleanup, 400);
    }

    navEl.addEventListener('touchstart', (e) => {
        if (e.touches.length !== 1) return;
        startY = e.touches[0].clientY;
        startX = e.touches[0].clientX;
        isDragging   = true;
        isVertical   = null;
        thresholdMet = false;
    }, { passive: true });

    navEl.addEventListener('touchmove', (e) => {
        if (!isDragging || e.touches.length !== 1) return;

        const dy = e.touches[0].clientY - startY;
        const dx = e.touches[0].clientX - startX;

        // Decide axis on first movement > 4px
        if (isVertical === null && Math.max(Math.abs(dy), Math.abs(dx)) > 4) {
            isVertical = Math.abs(dy) > Math.abs(dx);
        }

        // Only handle downward vertical pulls
        if (isVertical !== true || dy <= 0) {
            if (isVertical === false || dy <= 0) resetDrag();
            return;
        }

        // Rubber-band: drag slows as it approaches MAX_DRAG
        const progress   = dy / MAX_DRAG;
        const visualDrag = MAX_DRAG * (1 - Math.exp(-progress)) * (MAX_DRAG / dy) * dy * DAMPING;
        const clamped    = Math.min(visualDrag, MAX_DRAG);

        // Move nav downward
        navEl.style.transform = `translateY(${clamped}px)`;

        // Reveal tip from above (starts hidden, moves down with drag)
        // In PWA mode with notch, the tip's CSS sets top to (-52px + safe-area-inset-top)
        // We need to animate from that base position, so we add safe-area-inset to the calculation
        const safeAreaTop = getSafeAreaTop();
        const tipStartPos = -52 + safeAreaTop;  // Hidden position (accounting for notch)
        const tipTop = tipStartPos + clamped * 0.85;
        tipEl.style.top     = `${tipTop}px`;
        tipEl.style.opacity = Math.min(clamped / 35, 1).toString();

        // Threshold state toggle
        const newThreshold = dy >= THRESHOLD;
        if (newThreshold !== thresholdMet) {
            thresholdMet = newThreshold;
            tipEl.classList.toggle('threshold-met', thresholdMet);
            textEl.textContent = thresholdMet ? 'Release to refresh' : 'Pull to refresh';

            // Subtle haptic nudge when threshold is crossed (supported browsers/PWA)
            if (thresholdMet && navigator.vibrate) navigator.vibrate(10);
        }
    }, { passive: true });

    navEl.addEventListener('touchend', () => {
        if (!isDragging) return;
        const doRefresh = thresholdMet;
        resetDrag();
        applySnapBack();
        if (doRefresh) softRefreshImages();
    });

    navEl.addEventListener('touchcancel', () => {
        if (!isDragging) return;
        resetDrag();
        applySnapBack();
    });
}

/**
 * Soft-refresh: re-fetches image data while preserving all current state.
 * Used by pull-to-refresh. No hard page reload.
 *
 * Preserves:
 *   - Current position (finds same image URL in new list)
 *   - Active view mode (folder / favorites / trash / combined)
 *   - Sort order
 *   - Shuffle setting and order (new images appended, removed images dropped)
 */
async function softRefreshImages() {
    const savedImageSrc   = state.images[state.currentIndex] ?? null;
    const savedIndex      = state.currentIndex;

    showLoadingOverlay();

    try {
        // --- 1. Re-fetch images for the current mode ---
        let freshImages;
        if (state.showingTrashOnly) {
            freshImages = await API.getTrashImages(state.currentSortOrder);
        } else if (state.showingFavoritesOnly && state.showingFolderOnly && state.currentFolderFilter) {
            freshImages = await API.getFavoriteImagesByFolder(state.currentFolderFilter);
            if (state.currentSortOrder === 'oldest') freshImages = [...freshImages].reverse();
        } else if (state.showingFavoritesOnly) {
            freshImages = await API.getFavoriteImages(state.currentSortOrder);
        } else if (state.showingFolderOnly && state.currentFolderFilter) {
            freshImages = await API.getImagesByFolder(state.currentFolderFilter, state.currentSortOrder);
        } else {
            freshImages = await API.getImages(state.currentSortOrder);
        }

        // --- 2. Re-fetch favorites & trash (in parallel) ---
        const [favData, trashData] = await Promise.all([
            API.getFavorites(),
            API.getTrash(),
        ]);
        state.favorites = new Set(favData.favorites.map(url => extractPath(url)));
        state.trash     = new Set(trashData.trash.map(url => extractPath(url)));

        // --- 3. Merge with existing shuffle order (if shuffle is active) ---
        if (state.shuffleEnabled && state.images.length > 0) {
            const freshSet   = new Set(freshImages);
            const currentSet = new Set(state.images);

            // Keep existing order for images that are still present
            const preserved = state.images.filter(img => freshSet.has(img));

            // Append images that are new (not seen before)
            const added = freshImages.filter(img => !currentSet.has(img));
            if (added.length > 0) shuffleArray(added);

            freshImages = [...preserved, ...added];

            // Update unshuffled backup too (fetch base list again)
            // Only if we're in normal mode (not folder/favorites/trash)
            if (!state.showingFavoritesOnly && !state.showingTrashOnly && !state.showingFolderOnly) {
                API.getImages(state.currentSortOrder).then(base => {
                    state.unshuffledImages = base;
                }).catch(() => {});
            }
        }

        state.images = freshImages;

        // --- 4. Find the position to scroll back to ---
        let targetIndex = savedImageSrc ? freshImages.indexOf(savedImageSrc) : -1;
        if (targetIndex === -1) {
            // Image removed or not found — clamp to valid range
            targetIndex = Math.min(savedIndex, freshImages.length - 1);
        }
        if (targetIndex < 0) targetIndex = 0;
        state.currentIndex = targetIndex;

        // --- 5. Rebuild UI ---
        buildSlides(targetIndex);
        prioritizeFirstImage(targetIndex);
        updateFilterBadge();
        updateUI();
        scrollToImage(targetIndex, 'instant');

    } catch (error) {
        console.error('[softRefreshImages] Failed:', error);
        hideLoadingOverlay();
    }
}

// ============ Start Application ============

// Initialize when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}

// Export for debugging
window.app = { state, API };
