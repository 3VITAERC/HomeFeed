/**
 * ViewportManager — unified viewport and media control for HomeFeed.
 *
 * Responsibilities:
 *   - Single IntersectionObserver for all slides
 *   - Tracks the one "active" slide (the one currently snapped to viewport)
 *   - Plays/pauses videos and freezes/unfreezes GIFs centrally
 *   - Manages audio via a persistent <audio> element (iOS-safe)
 *
 * Audio Architecture (iOS-compatible):
 *   All <video> elements ALWAYS stay muted. This guarantees autoplay works
 *   on every platform including iOS Safari, Chrome on iOS, and PWA mode.
 *
 *   Audio is routed through a single persistent <audio> element that is
 *   "blessed" (unlocked) by the user's first tap on the mute/unmute button.
 *   On iOS, a media element that has been play()-ed from a user gesture can
 *   continue to be reused with new src values without requiring new gestures.
 *
 *   When the user enables audio and scrolls to a new video:
 *     1. _audioEl.src is set to the same URL as the video
 *     2. _audioEl.currentTime is synced to the video's currentTime
 *     3. _audioEl.play() is called
 *     4. A timeupdate listener keeps audio and video in sync
 *
 *   The video element never gets unmuted, so iOS never pauses it.
 */

import { state } from './state.js';
import { isGifUrl, isVideoUrl } from './utils/path.js';
import { freezeGif, unfreezeGif } from './utils/gif.js';
import { showMuteIconFeedback, attachProgressBarToVideo, detachProgressBar } from './utils/video.js';

// ─── Internal State ───────────────────────────────────────────────────────────

let _observer = null;
let _scrollContainer = null;
let _onActiveChange = null;    // callback(newIndex) — wired in from app.js
let _audioEnabled = false;     // user's desired audio state (persists across slides)
let _activeVideo = null;       // the one <video> element currently playing
let _hasActivatedOnce = false; // true after first slide activation (handles index-0 initial load)
let _scrollGeneration = 0;     // incremented on every slide change; used to cancel stale preload chains

// ─── Persistent Audio Element ─────────────────────────────────────────────────

let _audioEl = null;           // persistent <audio> element for iOS-safe audio
let _audioBlessed = false;     // true after first user-gesture play()
let _syncHandler = null;       // bound timeupdate handler for cleanup

function _ensureAudioElement() {
    if (_audioEl) return;
    _audioEl = document.createElement('audio');
    _audioEl.preload = 'auto';
    // Keep it out of the visual DOM but in the document for iOS
    _audioEl.style.display = 'none';
    document.body.appendChild(_audioEl);
}

/**
 * Start audio playback for the given video element via the persistent <audio>.
 * Syncs the audio element's src and currentTime to the video, then plays.
 */
function _startAudioForVideo(video) {
    if (!_audioEl || !_audioBlessed) return;
    if (!video || video.paused) return;

    const videoSrc = video.src || video.currentSrc;
    if (!videoSrc) return;

    // Remove previous sync handler
    _stopAudioSync();

    // Set src if different (avoids re-fetching the same resource)
    if (_audioEl.src !== videoSrc) {
        _audioEl.src = videoSrc;
    }
    _audioEl.currentTime = video.currentTime;
    _audioEl.loop = video.loop;

    const playPromise = _audioEl.play();
    if (playPromise !== undefined) {
        playPromise.catch((err) => {
            console.log(`[Viewport] Audio play blocked: ${err.message}`);
        });
    }

    // Keep audio in sync with video via timeupdate
    _syncHandler = () => {
        if (!_audioEl || _audioEl.paused || !video || video.paused) return;
        const drift = Math.abs(_audioEl.currentTime - video.currentTime);
        if (drift > 0.3) {
            _audioEl.currentTime = video.currentTime;
        }
    };
    video.addEventListener('timeupdate', _syncHandler);

    // Sync on seek
    video.addEventListener('seeked', _syncHandler);
}

/**
 * Stop audio and remove sync listeners from the active video.
 */
function _stopAudio() {
    _stopAudioSync();
    if (_audioEl) {
        _audioEl.pause();
    }
}

/**
 * Remove timeupdate/seeked sync listeners from _activeVideo.
 */
function _stopAudioSync() {
    if (_syncHandler && _activeVideo) {
        _activeVideo.removeEventListener('timeupdate', _syncHandler);
        _activeVideo.removeEventListener('seeked', _syncHandler);
    }
    _syncHandler = null;
}

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
    _ensureAudioElement();
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
    _stopAudio();
    _activeVideo = null;
    detachProgressBar();
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
 * This is called from a user gesture (tap/click), which is critical for iOS.
 * On first enable, we "bless" the persistent <audio> element by calling play()
 * directly from this gesture context — iOS will remember this element as
 * user-gesture-authorized for future play() calls.
 */
export function toggleGlobalMute() {
    _audioEnabled = !_audioEnabled;

    _ensureAudioElement();

    if (_audioEnabled) {
        // "Bless" the audio element on first enable — must happen in user gesture
        if (!_audioBlessed) {
            // Play a tiny bit of silence to unlock the element on iOS.
            // We'll immediately set the real src when _startAudioForVideo runs.
            if (_activeVideo) {
                const videoSrc = _activeVideo.src || _activeVideo.currentSrc;
                if (videoSrc) {
                    _audioEl.src = videoSrc;
                    _audioEl.currentTime = _activeVideo.currentTime;
                }
            }
            const blessPromise = _audioEl.play();
            if (blessPromise !== undefined) {
                blessPromise.then(() => {
                    _audioBlessed = true;
                    console.log('[Viewport] Audio element blessed by user gesture');
                    // If we have an active video, start syncing
                    if (_activeVideo && !_activeVideo.paused) {
                        _startAudioForVideo(_activeVideo);
                    }
                }).catch((err) => {
                    console.log(`[Viewport] Audio bless failed: ${err.message}`);
                    // Still mark as blessed — some browsers allow subsequent plays
                    _audioBlessed = true;
                    if (_activeVideo && !_activeVideo.paused) {
                        _startAudioForVideo(_activeVideo);
                    }
                });
            } else {
                _audioBlessed = true;
            }
        } else {
            // Already blessed, just start audio for current video
            if (_activeVideo && !_activeVideo.paused) {
                _startAudioForVideo(_activeVideo);
            }
        }
    } else {
        // User disabled audio — stop the audio element
        _stopAudio();
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
 *   – Video → play (always muted), then start audio element if enabled
 *   – GIF   → unfreeze
 */
function _activateMedia(slide) {
    const src = slide.dataset.src;
    if (!src) return;

    if (isVideoUrl(src)) {
        const video = slide.querySelector('video');
        if (video) {
            // Skip re-activation if this video is already the active, playing video.
            if (video === _activeVideo && !video.paused) return;

            // Videos ALWAYS stay muted — this is the key to iOS compatibility.
            video.muted = true;

            // Restore preload to 'auto' for active video so it buffers
            video.preload = 'auto';

            // Stop audio from previous video before switching
            _stopAudio();
            _activeVideo = video;

            // Wire shared progress bar to this video, with audio callbacks
            attachProgressBarToVideo(video, {
                onPlay:  () => { if (_audioEnabled) _startAudioForVideo(video); },
                onPause: () => { _stopAudio(); },
            });

            const playPromise = video.play();
            if (playPromise !== undefined) {
                playPromise.then(() => {
                    // Video is playing (muted). Start audio element if enabled.
                    if (_audioEnabled && _activeVideo === video) {
                        _startAudioForVideo(video);
                    }
                }).catch((err) => {
                    console.log(`[Viewport] Video play blocked for slide ${slide.dataset.index}: ${err.message}`);
                    // Retry once when data is available (handles race where
                    // _activateMedia fires before video has loaded enough data)
                    video.addEventListener('canplay', () => {
                        if (_activeVideo === video && video.paused) {
                            video.play().catch(() => {});
                        }
                    }, { once: true });
                });
            }
        } else {
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
 *   – Video → pause, stop audio; abort in-flight HTTP range request if still downloading
 *   – Video poster → abort download if still loading
 *   – GIF   → freeze; abort download if still loading
 *   – Image → abort download if still loading
 */
function _deactivateMedia(slide) {
    const src = slide.dataset.src;
    if (!src) return;

    if (isVideoUrl(src)) {
        const video = slide.querySelector('video');
        const poster = slide.querySelector('.video-poster');

        const videoLoading = video && video.networkState === HTMLMediaElement.NETWORK_LOADING;
        const posterLoading = poster && !poster.complete;

        if (video) {
            video.pause();

            if (video === _activeVideo) {
                _stopAudio();
                _activeVideo = null;
                detachProgressBar();
            }

            if (videoLoading || posterLoading) {
                _clearSlideContent(slide);
            } else {
                video.preload = 'none';
            }
        } else if (posterLoading) {
            _clearSlideContent(slide);
        }
    }

    if (isGifUrl(src)) {
        const img   = slide.querySelector('img');
        const video = slide.querySelector('video[data-original-gif="true"]');
        if (img)   freezeGif(img);
        if (video) freezeGif(video);
        if (img && !img.complete) {
            _clearSlideContent(slide);
        }
    } else if (!isVideoUrl(src)) {
        const img = slide.querySelector('img');
        if (img && !img.complete) {
            _clearSlideContent(slide);
        }
    }
}

// ─── Audio preloading (no-op) ─────────────────────────────────────────────────

/**
 * (No-op) Audio is handled via the persistent <audio> element.
 *
 * @param {string} _videoSrc - unused
 */
export function preloadAudioForNextSlide(_videoSrc) {
    // No-op: audio comes from the persistent <audio> element.
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
