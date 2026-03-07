/**
 * ViewportManager — unified viewport and media control for HomeFeed.
 *
 * Responsibilities:
 *   - Single IntersectionObserver for all slides (replaces state.observer + state.gifObserver)
 *   - Tracks the one "active" slide (the one currently snapped to viewport)
 *   - Plays/pauses videos and freezes/unfreezes GIFs centrally
 *   - Manages audio by toggling video.muted on the active element
 *
 * Audio Architecture:
 *   All <video> elements start with muted=true for reliable autoplay (browsers
 *   always allow muted autoplay).  When the user enables audio, we simply flip
 *   video.muted to false AFTER play() has resolved — at that point the video is
 *   already playing and Chrome does not re-check autoplay policy.
 *
 *   On deactivation the video is re-muted so only the active slide ever produces
 *   sound.  No Web Audio API, no AudioContext, no createMediaElementSource() —
 *   just a direct muted toggle on the one active <video> element.
 */

import { state } from './state.js';
import { isGifUrl, isVideoUrl } from './utils/path.js';
import { freezeGif, unfreezeGif } from './utils/gif.js';
import { showMuteIconFeedback } from './utils/video.js';

// ─── Internal State ───────────────────────────────────────────────────────────

let _observer = null;
let _scrollContainer = null;
let _onActiveChange = null;    // callback(newIndex) — wired in from app.js
let _audioEnabled = false;     // user's desired audio state (persists across slides)
let _activeVideo = null;       // the one <video> element currently playing
let _hasActivatedOnce = false; // true after first slide activation (handles index-0 initial load)
let _scrollGeneration = 0;     // incremented on every slide change; used to cancel stale preload chains

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Initialise the viewport manager.
 * Call once during app init, before any slides are created.
 *
 * @param {HTMLElement} scrollContainer  - The scroll container element
 * @param {Function}    onActiveChange   - Called with newIndex whenever the
 *                                         active slide changes.
 */
export function initViewport(scrollContainer, onActiveChange) {
    _scrollContainer = scrollContainer;
    _onActiveChange  = onActiveChange;
    _createObserver();
}

/**
 * Start observing a slide element.
 * Call this every time a new slide is created (in createSlide()).
 *
 * @param {HTMLElement} slide
 */
export function observeSlide(slide) {
    _observer?.observe(slide);
}

/**
 * Stop observing all slides and destroy the observer.
 * Call this at the start of buildSlides() before clearing the DOM.
 */
export function destroyObserver() {
    _observer?.disconnect();
    _observer = null;
    _hasActivatedOnce = false;
    _scrollGeneration++; // invalidate any in-flight preload chains during mode rebuild
    if (_activeVideo) {
        _activeVideo.muted = true;
        _activeVideo = null;
    }
}

/**
 * Recreate the observer after it was destroyed.
 * Call this after destroyObserver(), before re-observing slides.
 */
export function recreateObserver() {
    if (_observer) return;
    _createObserver();
}

/**
 * Returns the current scroll generation counter.
 * Increments every time the active slide changes or slides are rebuilt.
 * Used by sequentialPreload() to detect and abort stale preload chains.
 *
 * @returns {number}
 */
export function getScrollGeneration() {
    return _scrollGeneration;
}

/**
 * Notify the viewport manager that media content has just finished loading
 * on a slide. Only activates playback if the slide is currently active.
 *
 * Call this from loadVideoForSlide() after content is ready.
 *
 * @param {HTMLElement} slide
 */
export function activateMediaIfCurrent(slide) {
    const index = parseInt(slide.dataset.index, 10);
    if (index !== state.currentIndex) return;
    _activateMedia(slide);
}

/**
 * Toggle audio on/off (the user's "mute/unmute" action).
 *
 * Simply flips the muted attribute on the active video element.
 * Shows mute icon feedback on the current slide.
 */
export function toggleGlobalMute() {
    _audioEnabled = !_audioEnabled;

    // Apply to the currently-playing video immediately
    if (_activeVideo) {
        _activeVideo.muted = !_audioEnabled;
    }

    // Show feedback icon on current slide
    const currentSlide = document.querySelector(
        `.image-slide[data-index="${state.currentIndex}"]`
    );
    if (currentSlide) {
        showMuteIconFeedback(currentSlide, !_audioEnabled);
    }

    console.log(`[Viewport] Audio enabled: ${_audioEnabled}`);
}

/**
 * Read whether audio is currently enabled.
 *
 * @returns {boolean}
 */
export function isAudioEnabled() {
    return _audioEnabled;
}

/**
 * Manually force-activate a slide by index.
 * Use this after programmatic scrolls (scrollToImage, jump modal).
 *
 * @param {number} index
 */
export function activateSlideByIndex(index) {
    _setActiveSlide(index);
}

// ─── Internal ─────────────────────────────────────────────────────────────────

function _createObserver() {
    const options = {
        root:       _scrollContainer,
        rootMargin: '100px 0px',
        threshold:  [0, 0.5]
    };
    _observer = new IntersectionObserver(_handleIntersection, options);
}

function _handleIntersection(entries) {
    let mostVisibleRatio = 0;
    let mostVisibleEntry = null;

    entries.forEach(entry => {
        const slide = entry.target;

        // Lazy-load trigger with preload_distance awareness
        // At preload=0, only fire needsLoad when the slide is actually entering
        // the real viewport (not just within the 100px rootMargin buffer).
        // At preload>0, preserve normal rootMargin pre-triggering behavior.
        if (entry.isIntersecting && !slide.querySelector('img, video')) {
            const preloadDist = state.optimizations?.preload_distance ?? 3;
            const rect = entry.boundingClientRect;
            // rect.top < innerHeight means the slide's top edge has crossed into viewport
            // rect.bottom > 0 means the slide's bottom edge is still below the top
            const isEnteringViewport = rect.top < window.innerHeight && rect.bottom > 0;
            if (preloadDist > 0 || isEnteringViewport) {
                slide.dispatchEvent(new CustomEvent('needsLoad', { bubbles: true }));
            }
        }

        if (entry.intersectionRatio > mostVisibleRatio) {
            mostVisibleRatio = entry.intersectionRatio;
            mostVisibleEntry = entry;
        }

        // Deactivate slides that left the viewport
        if (!entry.isIntersecting) {
            _deactivateMedia(slide);
        }
    });

    // Activate the slide that is >= 50% visible (snapped-to threshold)
    if (mostVisibleEntry && mostVisibleEntry.intersectionRatio >= 0.5) {
        const newIndex = parseInt(mostVisibleEntry.target.dataset.index, 10);
        _setActiveSlide(newIndex);
    }
}

function _setActiveSlide(newIndex) {
    const prevIndex = state.currentIndex;
    const isIndexChange = prevIndex !== newIndex;
    const isFirstActivation = !_hasActivatedOnce;

    _hasActivatedOnce = true;

    if (isIndexChange) {
        const prevSlide = document.querySelector(
            `.image-slide[data-index="${prevIndex}"]`
        );
        if (prevSlide) _deactivateMedia(prevSlide);
        state.currentIndex = newIndex;
        _scrollGeneration++; // invalidate stale sequentialPreload chains
    }

    const newSlide = document.querySelector(
        `.image-slide[data-index="${newIndex}"]`
    );
    if (newSlide) _activateMedia(newSlide);

    if (isIndexChange || isFirstActivation) {
        _onActiveChange?.(newIndex);
    }
}

/**
 * Activate media on a slide:
 *   – Video → play (muted), then unmute if audio enabled
 *   – GIF   → unfreeze
 */
function _activateMedia(slide) {
    const src = slide.dataset.src;
    if (!src) return;

    if (isVideoUrl(src)) {
        const video = slide.querySelector('video');
        if (video) {
            // Skip re-activation if this video is already the active, playing video.
            // IntersectionObserver fires multiple callbacks as scroll-snap settles;
            // without this guard each callback would mute→play→unmute the video.
            if (video === _activeVideo && !video.paused) return;

            // Always start muted — muted autoplay is universally allowed.
            video.muted = true;

            // Restore preload to 'auto' for active video so it buffers
            // (was set to 'none' when deactivated)
            video.preload = 'auto';

            _activeVideo = video;

            const playPromise = video.play();
            if (playPromise !== undefined) {
                playPromise.then(() => {
                    // Video is now playing.  If the user wants audio, unmute.
                    // Changing muted on an already-playing video does NOT trigger
                    // a new autoplay policy check — Chrome only checks at play() time.
                    if (_audioEnabled && _activeVideo === video) {
                        video.muted = false;
                    }
                }).catch((err) => {
                    console.log(`[Viewport] Video play blocked for slide ${slide.dataset.index}: ${err.message}`);
                });
            }
        } else {
            // Slide was cleared mid-download (_clearSlideContent). The intersection
            // observer won't re-fire since the slide's DOM position is unchanged, so
            // needsLoad will never dispatch on its own — trigger it manually here.
            slide.dispatchEvent(new CustomEvent('needsLoad', { bubbles: true }));
        }
    }

    if (isGifUrl(src)) {
        const img   = slide.querySelector('img');
        const video = slide.querySelector('video[data-original-gif="true"]');
        if (img)   unfreezeGif(img);
        if (video) unfreezeGif(video);
    }
}

/**
 * Remove all child elements from a slide, aborting any in-progress network loads first.
 * After clearing, the slide returns to an empty shell so needsLoad can re-trigger
 * the next time the user scrolls to it.
 *
 * Handles: VIDEO, IMG (including video-poster class), and any other children.
 */
function _clearSlideContent(slide) {
    const children = Array.from(slide.children);
    for (const child of children) {
        if (child.tagName === 'VIDEO') {
            child.pause();
            child.removeAttribute('src');
            child.load(); // forces the browser to cancel any pending range request
        } else if (child.tagName === 'IMG') {
            // Handles both regular images and video-poster elements
            child.src = ''; // cancels any in-flight image download
        }
        child.remove();
    }
}

/**
 * Deactivate media on a slide:
 *   – Video → pause, re-mute; abort in-flight HTTP range request if still downloading
 *   – Video poster → abort download if still loading
 *   – GIF   → freeze; abort download if still loading
 *   – Image → abort download if still loading
 *
 * NOTE: video.preload = 'none' does NOT cancel an in-flight HTTP range request
 * in Chrome/Safari. Only removeAttribute('src') + load() actually kills the request.
 * We call _clearSlideContent() for slides that are still actively downloading so
 * the browser connection is freed immediately and the slide becomes an empty shell,
 * allowing needsLoad to re-trigger if the user scrolls back.
 */
function _deactivateMedia(slide) {
    const src = slide.dataset.src;
    if (!src) return;

    if (isVideoUrl(src)) {
        const video = slide.querySelector('video');
        const poster = slide.querySelector('.video-poster');

        // Check if video or poster is still loading
        const videoLoading = video && video.networkState === HTMLMediaElement.NETWORK_LOADING;
        const posterLoading = poster && !poster.complete;

        if (video) {
            video.pause();
            video.muted = true;

            if (video === _activeVideo) {
                _activeVideo = null;
            }

            // NETWORK_LOADING (2) means the browser is actively fetching data.
            // Abort the request by clearing src — this frees bandwidth immediately.
            // The slide becomes an empty shell so needsLoad re-triggers on revisit.
            if (videoLoading || posterLoading) {
                _clearSlideContent(slide);
            } else {
                // Already idle or fully loaded — just stop any future buffering
                video.preload = 'none';
            }
        } else if (posterLoading) {
            // Video not created yet but poster is loading
            _clearSlideContent(slide);
        }
    }

    if (isGifUrl(src)) {
        const img   = slide.querySelector('img');
        const video = slide.querySelector('video[data-original-gif="true"]');
        if (img)   freezeGif(img);
        if (video) freezeGif(video);
        // Abort if the GIF image is still downloading
        if (img && !img.complete) {
            _clearSlideContent(slide);
        }
    } else if (!isVideoUrl(src)) {
        // Static image: abort if still downloading
        const img = slide.querySelector('img');
        if (img && !img.complete) {
            _clearSlideContent(slide);
        }
    }
}

// ─── Audio preloading (no-op) ─────────────────────────────────────────────────

/**
 * (No-op) Audio is handled by toggling video.muted on the active element.
 * No separate preloading is needed.
 *
 * @param {string} _videoSrc - unused
 */
export function preloadAudioForNextSlide(_videoSrc) {
    // No-op: audio comes directly from the video element.
}

export default {
    initViewport,
    observeSlide,
    destroyObserver,
    recreateObserver,
    activateMediaIfCurrent,
    activateSlideByIndex,
    toggleGlobalMute,
    isAudioEnabled,
    preloadAudioForNextSlide,
};
