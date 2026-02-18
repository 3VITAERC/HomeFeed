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
let _audioEl = null;           // single <audio> element for all video sound
let _activeVideo = null;       // current video element being synced to audio
let _syncInterval = null;      // interval for audio/video time sync
let _hasActivatedOnce = false; // true after first slide activation (handles index-0 initial load)

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

        // Lazy-load trigger
        if (entry.isIntersecting && !slide.querySelector('img, video')) {
            slide.dispatchEvent(new CustomEvent('needsLoad', { bubbles: true }));
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
 * Deactivate media on a slide:
 *   – Video → pause
 *   – GIF   → freeze
 */
function _deactivateMedia(slide) {
    const src = slide.dataset.src;
    if (!src) return;

    if (isVideoUrl(src)) {
        const video = slide.querySelector('video');
        if (video) {
            video.pause();
            // If this was the active video, stop audio sync
            if (video === _activeVideo) {
                _stopAudioSync();
                _activeVideo = null;
                // Pause audio when leaving a video slide
                if (_audioEl) _audioEl.pause();
            }
        }
    }

    if (isGifUrl(src)) {
        const img   = slide.querySelector('img');
        const video = slide.querySelector('video[data-original-gif="true"]');
        if (img)   freezeGif(img);
        if (video) freezeGif(video);
    }
}

// ─── Audio Element Management ─────────────────────────────────────────────────

/**
 * Create the single <audio> element used for all video sound.
 * Must be called from a user gesture handler.
 */
function _createAudioElement() {
    if (_audioEl) return;

    _audioEl = document.createElement('audio');
    _audioEl.preload = 'auto';
    // Don't append to DOM — just keep in memory
    // (appending causes double audio on some browsers)

    _audioEl.addEventListener('error', (e) => {
        console.warn('[Viewport] Audio element error:', e);
    });
}

/**
 * Attach the audio element to the currently active video.
 * Syncs src and currentTime, then plays.
 */
function _attachAudioToActiveVideo() {
    if (!_audioEl || !_activeVideo) return;

    const videoSrc = _activeVideo.src;
    if (!videoSrc) return;

    // Stop any existing sync
    _stopAudioSync();

    // If src changed, update it
    if (_audioEl.src !== videoSrc) {
        _audioEl.src = videoSrc;
        _audioEl.load();
    }

    // Sync time and play
    _audioEl.currentTime = _activeVideo.currentTime;
    _audioEl.play().catch((err) => {
        console.warn('[Viewport] Audio play failed:', err.message);
    });

    // Keep audio in sync with video via periodic check
    // (timeupdate fires too infrequently for smooth sync)
    _syncInterval = setInterval(() => {
        if (!_activeVideo || !_audioEl) {
            _stopAudioSync();
            return;
        }
        // Re-sync if drift exceeds 0.3 seconds
        const drift = Math.abs(_audioEl.currentTime - _activeVideo.currentTime);
        if (drift > 0.3) {
            _audioEl.currentTime = _activeVideo.currentTime;
        }
        // Pause audio if video is paused
        if (_activeVideo.paused && !_audioEl.paused) {
            _audioEl.pause();
        }
    }, 250);
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
};
