/**
 * ViewportManager — unified viewport and media control for HomeFeed.
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
let _audioContext = null;      // Web Audio API context (created on first user gesture)
let _gainNode = null;          // GainNode — controls mute/unmute without a second download
let _activeSourceNode = null;  // MediaElementAudioSourceNode for the current video
let _videoSourceNodes = null;  // WeakMap<HTMLVideoElement, MediaElementAudioSourceNode>
let _activeVideo = null;       // current video element being used for audio
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
    // Disconnect audio source when rebuilding slides
    if (_activeSourceNode) {
        try { _activeSourceNode.disconnect(_gainNode); } catch (e) {}
        _activeSourceNode = null;
    }
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
            if (_gainNode) _gainNode.gain.value = 1.0;  // Restore volume (was set to 0 by _pauseAudio)
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
            // Videos start muted for autoplay policy compliance.
            // Web Audio API will unmute for audio output when needed (see _attachAudioToActiveVideo).
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
            if (_audioEnabled && _audioContext) {
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
 *   – Video → pause; abort in-flight HTTP range request if still downloading
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

            // Audio cleanup — disconnect source node before potentially removing element
            if (video === _activeVideo) {
                if (_activeSourceNode) {
                    try { _activeSourceNode.disconnect(_gainNode); } catch (e) {}
                    _activeSourceNode = null;
                }
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

// ─── Audio (Web Audio API) ─────────────────────────────────────────────────────
//
// Architecture: instead of a separate <audio src="same-video-url">, we use
// MediaElementAudioSourceNode to tap directly into the already-downloading
// <video> element. This eliminates the duplicate HTTP range request that the
// old <audio> approach caused (video element + audio element = 2x bandwidth).
//
// The video element stays muted=true for autoplay policy compliance.
// The Web Audio gain node controls whether the user hears anything.

/**
 * Initialise Web Audio API on first user gesture.
 * Must be called from a user-gesture handler (required for AudioContext unlock).
 */
function _createAudioElement() {
    if (_audioContext) return;

    _audioContext = new AudioContext();
    _gainNode = _audioContext.createGain();
    _gainNode.gain.value = 1.0;
    _gainNode.connect(_audioContext.destination);

    // WeakMap so entries are garbage-collected when video elements are removed
    _videoSourceNodes = new WeakMap();
}

/**
 * Route the active video's audio through the Web Audio graph.
 * Uses MediaElementAudioSourceNode — no second HTTP request.
 *
 * createMediaElementSource() can only be called once per element, so we cache
 * the resulting node in _videoSourceNodes and reuse it on revisit.
 */
function _attachAudioToActiveVideo() {
    if (!_audioContext || !_activeVideo) return;

    // Resume context if the browser auto-suspended it
    if (_audioContext.state === 'suspended') {
        _audioContext.resume().catch((e) => {
            console.warn('[Viewport] AudioContext resume failed:', e.message);
        });
    }

    // Disconnect the previous source connection (not the node itself)
    if (_activeSourceNode) {
        try { _activeSourceNode.disconnect(_gainNode); } catch (e) {}
        _activeSourceNode = null;
    }

    // Chrome requires video.muted = false for audio to flow to the Web Audio graph.
    // Safari/Firefox ignore the muted attribute for Web Audio capture, but Chrome
    // silences the audio pipeline at the source when muted=true.
    // Safe to unmute here: after createMediaElementSource(), the browser suppresses
    // the video's direct speaker output regardless of the muted attribute, so there
    // is no double-audio. We also unmute on reconnection because _activateMedia()
    // re-sets muted=true each time a slide becomes active.
    _activeVideo.muted = false;

    // Get or create a MediaElementAudioSourceNode for this video element
    let sourceNode = _videoSourceNodes.get(_activeVideo);
    if (!sourceNode) {
        try {
            sourceNode = _audioContext.createMediaElementSource(_activeVideo);
            _videoSourceNodes.set(_activeVideo, sourceNode);
        } catch (e) {
            console.warn('[Viewport] createMediaElementSource failed:', e.message);
            _activeVideo.muted = true;  // Restore on failure so autoplay still works
            return;
        }
    }

    // Wire: video audio → gain node → speakers
    sourceNode.connect(_gainNode);
    _activeSourceNode = sourceNode;
    console.log('[Viewport] Audio: routed via Web Audio API (no duplicate request)');
}

/**
 * Silence audio output without changing _audioEnabled state.
 * Sets gain to 0 — the source node stays connected for instant un-mute.
 */
function _pauseAudio() {
    if (_gainNode) _gainNode.gain.value = 0.0;
}

/**
 * (No-op) Previously preloaded audio for the next slide via a second <audio>
 * element. Web Audio API routes audio directly from the video element, so no
 * separate preloading is needed or possible without a duplicate download.
 *
 * @param {string} videoSrc - unused
 */
export function preloadAudioForNextSlide(_videoSrc) {
    // No-op: Web Audio API approach has no duplicate-download audio preloading.
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
