/**
 * ViewportManager — unified viewport and media control for LocalFeed.
 *
 * Responsibilities:
 *   - Single IntersectionObserver for all slides (replaces state.observer + state.gifObserver)
 *   - Tracks the one "active" slide (the one currently snapped to viewport)
 *   - Plays/pauses videos and freezes/unfreezes GIFs centrally
 *   - Manages audio via a single <audio> element (TikTok-style)
 *
 * Audio Architecture:
 *   All <video> elements are ALWAYS muted=true. This is required for reliable
 *   autoplay on mobile browsers — unmuted video autoplay is blocked after a few
 *   plays regardless of user interaction history.
 *
 *   Instead, a single <audio> element handles sound:
 *   - Created on first user tap (requires user gesture to unlock audio)
 *   - src is swapped to match the active video when the slide changes
 *   - currentTime is synced to the video via timeupdate events
 *   - Pausing/resuming this element is what "mute/unmute" actually does
 *
 *   This is how TikTok, Instagram Reels, and YouTube Shorts work.
 */

import { state } from './state.js';
import { isGifUrl, isVideoUrl } from './utils/path.js';
import { freezeGif, unfreezeGif } from './utils/gif.js';
import { showMuteIconFeedback } from './utils/video.js';

// ─── Internal State ───────────────────────────────────────────────────────────

let _observer = null;
let _scrollContainer = null;
let _onActiveChange = null;    // callback(newIndex) — wired in from app.js
let _audioUnlocked = false;    // true after first user gesture unlocks audio
let _audioEnabled = false;     // user's desired audio state (persists across slides)
let _audioEl = null;           // current <audio> element for video sound
let _nextAudioEl = null;       // second <audio> for +1 slide preloading
let _nextAudioSrc = null;      // track what's loaded in _nextAudioEl
let _activeVideo = null;       // current video element being synced to audio
let _syncInterval = null;      // interval for audio/video time sync
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
    // Stop audio sync when rebuilding slides
    _stopAudioSync();
    _activeVideo = null;
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
 * On first call: creates and unlocks the <audio> element (requires user gesture).
 * Subsequent calls: toggles audio playback on/off.
 *
 * Shows mute icon feedback on the current slide.
 */
export function toggleGlobalMute() {
    if (!_audioUnlocked) {
        // First tap — create and unlock the audio element
        _createAudioElement();
        _audioUnlocked = true;
        _audioEnabled = true;
        _attachAudioToActiveVideo();
    } else {
        _audioEnabled = !_audioEnabled;
        if (_audioEnabled) {
            _attachAudioToActiveVideo();
        } else {
            _pauseAudio();
        }
    }

    // Show feedback icon on current slide
    const currentSlide = document.querySelector(
        `.image-slide[data-index="${state.currentIndex}"]`
    );
    if (currentSlide) {
        // isMuted = true when audio is disabled
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
 *   – Video → play (always muted), attach audio if enabled
 *   – GIF   → unfreeze
 */
function _activateMedia(slide) {
    const src = slide.dataset.src;
    if (!src) return;

    if (isVideoUrl(src)) {
        const video = slide.querySelector('video');
        if (video) {
            // Videos are ALWAYS muted — audio is handled by the separate _audioEl
            video.muted = true;
            
            // Restore preload to 'auto' for active video so it buffers
            // (was set to 'none' when deactivated)
            video.preload = 'auto';

            // Play the video (muted autoplay is always allowed)
            video.play().catch((err) => {
                console.log(`[Viewport] Video play blocked for slide ${slide.dataset.index}: ${err.message}`);
            });

            // Track this as the active video for audio sync
            _activeVideo = video;

            // If audio is enabled, attach audio to this video
            if (_audioEnabled && _audioEl) {
                _attachAudioToActiveVideo();
            }
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
 */
function _clearSlideContent(slide) {
    const children = Array.from(slide.children);
    for (const child of children) {
        if (child.tagName === 'VIDEO') {
            child.pause();
            child.removeAttribute('src');
            child.load(); // forces the browser to cancel any pending range request
        } else if (child.tagName === 'IMG') {
            child.src = ''; // cancels any in-flight image download
        }
        child.remove();
    }
}

/**
 * Deactivate media on a slide:
 *   – Video → pause; abort in-flight HTTP range request if still downloading
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
        if (video) {
            video.pause();

            // Audio cleanup — must happen before we potentially remove the element
            if (video === _activeVideo) {
                _stopAudioSync();
                _activeVideo = null;
                if (_audioEl) _audioEl.pause();
            }

            // NETWORK_LOADING (2) means the browser is actively fetching data.
            // Abort the request by clearing src — this frees bandwidth immediately.
            // The slide becomes an empty shell so needsLoad re-triggers on revisit.
            if (video.networkState === HTMLMediaElement.NETWORK_LOADING) {
                _clearSlideContent(slide);
            } else {
                // Already idle or fully loaded — just stop any future buffering
                video.preload = 'none';
            }
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

// ─── Audio Element Management ─────────────────────────────────────────────────

/**
 * Create the <audio> elements used for video sound.
 * Creates two elements: one for current video, one for preloading next video.
 * Must be called from a user gesture handler.
 */
function _createAudioElement() {
    if (_audioEl) return;

    // Current audio element
    _audioEl = document.createElement('audio');
    _audioEl.preload = 'auto';
    // Don't append to DOM — just keep in memory
    // (appending causes double audio on some browsers)

    _audioEl.addEventListener('error', (e) => {
        console.warn('[Viewport] Audio element error:', e);
    });
    
    // Second audio element for preloading next video's audio
    _nextAudioEl = document.createElement('audio');
    _nextAudioEl.preload = 'auto';
    
    _nextAudioEl.addEventListener('error', (e) => {
        console.warn('[Viewport] Next audio element error:', e);
    });
}

/**
 * Attach the audio element to the currently active video.
 * Syncs src and currentTime, then plays.
 * 
 * Uses a swap mechanism: if the next audio element already has this src
 * preloaded, we swap elements instead of loading fresh.
 */
function _attachAudioToActiveVideo() {
    if (!_audioEl || !_activeVideo) return;

    const videoSrc = _activeVideo.src;
    if (!videoSrc) return;

    // Stop any existing sync
    _stopAudioSync();

    // Normalize URLs for comparison (handle relative vs absolute)
    // video.src is absolute, _nextAudioSrc may be relative
    const normalizedVideoSrc = videoSrc;
    const normalizedNextSrc = _nextAudioSrc ? _normalizeAudioSrc(_nextAudioSrc) : null;
    const normalizedCurrentSrc = _audioEl.src;

    // Check if next audio element already has this src preloaded
    if (_nextAudioEl && normalizedNextSrc === normalizedVideoSrc) {
        // SWAP: next becomes current, current becomes next (for reuse)
        const tempEl = _audioEl;
        _audioEl = _nextAudioEl;
        _nextAudioEl = tempEl;
        _nextAudioSrc = null;
        console.log('[Viewport] Audio swap: using preloaded audio for', videoSrc.substring(0, 50));
    } else if (normalizedCurrentSrc !== normalizedVideoSrc) {
        // Fallback: load fresh (not preloaded)
        _audioEl.src = videoSrc;
        _audioEl.load();
        console.log('[Viewport] Audio load: loading fresh for', videoSrc.substring(0, 50));
    }

    // Sync time and play
    // Wait for audio to be ready if it was just loaded
    const startAudio = () => {
        if (_audioEl.readyState >= 2) {  // HAVE_CURRENT_DATA
            _audioEl.currentTime = _activeVideo.currentTime;
            _audioEl.play().catch((err) => {
                console.warn('[Viewport] Audio play failed:', err.message);
            });
        } else {
            // Wait for data to load
            _audioEl.addEventListener('canplay', function onCanPlay() {
                _audioEl.removeEventListener('canplay', onCanPlay);
                if (_activeVideo) {
                    _audioEl.currentTime = _activeVideo.currentTime;
                    _audioEl.play().catch((err) => {
                        console.warn('[Viewport] Audio play failed:', err.message);
                    });
                }
            }, { once: true });
        }
    };
    startAudio();

    // Keep audio in sync with video via periodic check
    // (timeupdate fires too infrequently for smooth sync)
    _syncInterval = setInterval(() => {
        if (!_activeVideo || !_audioEl) {
            _stopAudioSync();
            return;
        }
        // Re-sync if drift exceeds 0.15 seconds (tighter for smoother audio)
        const drift = Math.abs(_audioEl.currentTime - _activeVideo.currentTime);
        if (drift > 0.15) {
            _audioEl.currentTime = _activeVideo.currentTime;
        }
        // Pause audio if video is paused
        if (_activeVideo.paused && !_audioEl.paused) {
            _audioEl.pause();
        }
    }, 100);  // More frequent checks for smoother sync
}

/**
 * Normalize a URL for comparison.
 * Converts relative URLs to absolute using the current origin.
 */
function _normalizeAudioSrc(src) {
    if (!src) return null;
    // If already absolute, return as-is
    if (src.startsWith('http://') || src.startsWith('https://')) {
        return src;
    }
    // Convert relative to absolute
    return window.location.origin + (src.startsWith('/') ? '' : '/') + src;
}

/**
 * Preload audio for the next video slide (+1 position).
 * Call this when identifying the next slide during sequentialPreload.
 * 
 * @param {string} videoSrc - The video source URL to preload audio for
 */
export function preloadAudioForNextSlide(videoSrc) {
    // Don't preload if audio not unlocked yet (no user gesture)
    if (!_audioUnlocked || !_nextAudioEl || !videoSrc) return;
    
    // Normalize for comparison
    const normalizedVideoSrc = _normalizeAudioSrc(videoSrc);
    
    // Don't reload if already preloaded
    if (_nextAudioSrc && _normalizeAudioSrc(_nextAudioSrc) === normalizedVideoSrc) return;
    
    // Don't preload if this is the current video's src
    if (_audioEl && _audioEl.src === normalizedVideoSrc) return;
    
    _nextAudioEl.src = videoSrc;
    _nextAudioEl.load();
    _nextAudioSrc = videoSrc;  // Store original (relative or absolute)
    
    // Force buffering with play/pause trick (same as video first-frame)
    // This ensures audio data is actually downloaded, not just metadata
    _nextAudioEl.play().then(() => {
        _nextAudioEl.pause();
        _nextAudioEl.currentTime = 0;
        console.log('[Viewport] Audio preload: buffered for', videoSrc.substring(0, 50));
    }).catch(() => {
        // Autoplay blocked — audio will load when needed
        console.log('[Viewport] Audio preload: load() only for', videoSrc.substring(0, 50));
    });
}

/**
 * Pause the audio element without changing _audioEnabled state.
 */
function _pauseAudio() {
    _stopAudioSync();
    if (_audioEl) _audioEl.pause();
}

/**
 * Stop the audio/video sync interval.
 */
function _stopAudioSync() {
    if (_syncInterval) {
        clearInterval(_syncInterval);
        _syncInterval = null;
    }
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
