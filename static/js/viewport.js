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
 *     1. _audioEl.src is set to /video-audio?path=... (audio-only endpoint)
 *     2. _audioEl.currentTime is synced to the video's currentTime
 *     3. _audioEl.play() is called
 *     4. A seeked listener re-syncs currentTime when the user scrubs
 *
 *   The /video-audio endpoint uses ffmpeg to extract the audio track on-the-fly
 *   (no disk storage) and serves it as audio/mp4 with full range request
 *   support and browser cache headers.  Because the audio file is small
 *   (~1-2% of the video size), it downloads fast, buffers fully, and never
 *   competes with the video element for bandwidth — eliminating the main
 *   source of audio choppiness.
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
let _seekedHandler = null;     // bound seeked handler — resyncs audio on user scrub
let _errorFallbackHandler = null; // bound error handler — detects missing ffmpeg
let _ffmpegUnavailable = false;   // set true after first 501 from /video-audio

function _ensureAudioElement() {
    if (_audioEl) return;
    _audioEl = document.createElement('audio');
    _audioEl.preload = 'auto';
    // Keep it out of the visual DOM but in the document for iOS
    _audioEl.style.display = 'none';
    document.body.appendChild(_audioEl);
}

/**
 * Derive the /video-audio URL from a video element's src.
 *
 * The video src is an absolute URL like:
 *   http://host/image?path=%2Fpath%2Fto%2Fvideo.mp4
 * This converts it to:
 *   /video-audio?path=%2Fpath%2Fto%2Fvideo.mp4
 *
 * Returns null if the src cannot be parsed (e.g. blob URLs, missing path).
 */
function _videoSrcToAudioSrc(videoSrc) {
    try {
        // Accept both absolute URLs (from video.src) and relative URLs
        // (from slide.dataset.src) by always providing an origin as base.
        const url = new URL(videoSrc, window.location.origin);
        const path = url.searchParams.get('path');
        if (!path) return null;
        return `/video-audio?path=${encodeURIComponent(path)}`;
    } catch {
        return null;
    }
}

/**
 * Start audio playback for the given video element via the persistent <audio>.
 *
 * Points the audio element at the /video-audio endpoint (audio-only file,
 * ~1-2% the size of the video) rather than the full video URL.  This means
 * the audio element buffers almost instantly and never competes with the
 * video element for bandwidth, eliminating the main cause of choppy audio.
 *
 * Drift correction via timeupdate polling has been intentionally removed.
 * Both elements play at 1× from the same local server; natural drift over
 * typical clip lengths is imperceptible.  The only re-sync that happens is
 * on user seek (seeked event), where an immediate correction is expected.
 */
function _startAudioForVideo(video) {
    if (!_audioEl || !_audioBlessed) return;
    if (!video || video.paused) return;

    const videoSrc = video.src || video.currentSrc;
    if (!videoSrc) return;

    // Remove previous seeked handler before attaching a new one
    _stopAudioSync();

    // If ffmpeg is known unavailable, skip straight to the video URL (old behavior).
    const audioSrc = _ffmpegUnavailable
        ? videoSrc
        : (_videoSrcToAudioSrc(videoSrc) ?? videoSrc);

    // _audioEl.src stores an absolute URL; resolve our relative path to the
    // same form before comparing so we don't reset a src that's already correct
    // (which would interrupt audio that is already playing, e.g. right after blessing).
    const resolvedAudioSrc = new URL(audioSrc, window.location.origin).href;

    if (_audioEl.src !== resolvedAudioSrc) {
        // Different audio source — load the new one from the beginning
        _audioEl.src = audioSrc;
        _audioEl.currentTime = video.currentTime;
    } else {
        // Same audio already loaded — just sync time in case of slight drift
        _audioEl.currentTime = video.currentTime;
    }
    _audioEl.loop = video.loop;

    // Fallback: if /video-audio returns 501 (ffmpeg not installed), switch to
    // the full video URL for audio — same behaviour as before this feature.
    // 404 (no audio track / extraction failed) is intentionally NOT caught here;
    // that's a per-file failure and we don't want to fall back to bandwidth
    // competition just because one video has no audio track.
    if (!_ffmpegUnavailable) {
        _errorFallbackHandler = async () => {
            _errorFallbackHandler = null;
            try {
                const res = await fetch(audioSrc, { method: 'HEAD' });
                if (res.status === 501) {
                    _ffmpegUnavailable = true;
                    console.log('[Viewport] ffmpeg not available — falling back to video URL for audio');
                    _audioEl.src = videoSrc;
                    _audioEl.currentTime = video.currentTime;
                    _audioEl.loop = video.loop;
                    if (_audioEl.paused) _audioEl.play().catch(() => {});
                }
            } catch { /* network error during check — ignore */ }
        };
        _audioEl.addEventListener('error', _errorFallbackHandler);
    }

    // play() is a no-op if already playing (resolved promise); safe to always call
    if (_audioEl.paused) {
        const playPromise = _audioEl.play();
        if (playPromise !== undefined) {
            playPromise.catch((err) => {
                console.log(`[Viewport] Audio play blocked: ${err.message}`);
            });
        }
    }

    // Re-sync only when the user explicitly scrubs the timeline.
    // No polling — both elements naturally stay in sync at 1× speed.
    _seekedHandler = () => {
        if (_audioEl && !_audioEl.paused) {
            _audioEl.currentTime = video.currentTime;
        }
    };
    video.addEventListener('seeked', _seekedHandler);
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
 * Remove the seeked and error-fallback listeners from the active video/audio.
 */
function _stopAudioSync() {
    if (_seekedHandler && _activeVideo) {
        _activeVideo.removeEventListener('seeked', _seekedHandler);
    }
    _seekedHandler = null;

    if (_errorFallbackHandler && _audioEl) {
        _audioEl.removeEventListener('error', _errorFallbackHandler);
    }
    _errorFallbackHandler = null;
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
            // Play the audio-only file to unlock the element on iOS.
            // We'll re-call _startAudioForVideo once the promise resolves.
            if (_activeVideo) {
                const videoSrc = _activeVideo.src || _activeVideo.currentSrc;
                if (videoSrc) {
                    _audioEl.src = _videoSrcToAudioSrc(videoSrc) ?? videoSrc;
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

            // Pre-load audio in parallel with video startup to minimise delay.
            // Setting _audioEl.src here (before video.play()) kicks off the
            // browser's audio loading pipeline — cache lookup, header parse,
            // decoder setup — concurrently with the video. By the time
            // video.play() resolves and _startAudioForVideo() is called, the
            // audio element is already buffered and play() starts instantly.
            if (_audioEnabled && _audioBlessed) {
                const videoSrc = video.src;
                if (videoSrc) {
                    const audioSrc = _ffmpegUnavailable
                        ? videoSrc
                        : (_videoSrcToAudioSrc(videoSrc) ?? videoSrc);
                    const resolvedAudioSrc = new URL(audioSrc, window.location.origin).href;
                    if (_audioEl.src !== resolvedAudioSrc) {
                        _audioEl.src = audioSrc;
                        // Don't play yet — _startAudioForVideo() will sync
                        // currentTime and call play() once video is running.
                    }
                }
            }

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
 * Warm the browser's HTTP cache for a video slide's audio track.
 *
 * Called by sequentialPreload() for each ahead video slide. Fires a
 * low-priority fetch to /video-audio so the server runs ffmpeg in the
 * background and the browser caches the result. When the user scrolls
 * to that slide and _startAudioForVideo() sets _audioEl.src, the browser
 * serves the audio instantly from cache — no ffmpeg latency at that moment.
 *
 * @param {string} slideSrc - slide.dataset.src value (relative URL)
 */
export function preloadAudioForNextSlide(slideSrc) {
    if (_ffmpegUnavailable) return;

    const audioSrc = _videoSrcToAudioSrc(slideSrc);
    if (!audioSrc) return;

    // Fire-and-forget — we only care about warming the cache, not the response.
    // 'low' priority keeps this from competing with the video preload fetch.
    fetch(audioSrc, { priority: 'low' }).catch(() => {});
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
