/**
 * Video control utilities for HomeFeed.
 * Handles video playback, mute toggle, and progress bar.
 */

/**
 * Format time in MM:SS format
 *
 * @param {number} seconds - Time in seconds
 * @returns {string} Formatted time string
 */
export function formatVideoTime(seconds) {
    if (isNaN(seconds) || !isFinite(seconds)) return '0:00';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
}

/**
 * Toggle video mute/unmute with visual feedback
 * Instagram-style: tap to toggle audio, show icon briefly in center
 *
 * @param {HTMLVideoElement} video - The video element
 * @param {HTMLElement} slide - The slide container element
 */
export function toggleVideoMute(video, slide) {
    video.muted = !video.muted;
    showMuteIconFeedback(slide, video.muted);
}

/**
 * Show mute/unmute icon in center of screen briefly (Instagram-style)
 * Icon fades out after ~600ms
 *
 * @param {HTMLElement} slide - The slide container element
 * @param {boolean} isMuted - Whether the video is muted
 */
export function showMuteIconFeedback(slide, isMuted) {
    const muteIcon = slide.querySelector('.video-mute-icon');
    if (!muteIcon) return;

    // Update which icon to show
    const mutedSvg = muteIcon.querySelector('.muted-icon');
    const unmutedSvg = muteIcon.querySelector('.unmuted-icon');

    if (isMuted) {
        if (mutedSvg) mutedSvg.style.display = 'block';
        if (unmutedSvg) unmutedSvg.style.display = 'none';
    } else {
        if (mutedSvg) mutedSvg.style.display = 'none';
        if (unmutedSvg) unmutedSvg.style.display = 'block';
    }

    // Show icon
    muteIcon.classList.add('visible');

    // Hide after 600ms
    setTimeout(() => {
        muteIcon.classList.remove('visible');
    }, 600);
}

// ─── Shared progress bar state ────────────────────────────────────────────────

let _pbVideo = null;     // video currently wired to the shared bar
let _pbHandlers = {};    // event handler refs for cleanup

/**
 * Detach the shared progress bar from any current video and hide it.
 */
export function detachProgressBar() {
    const container = document.getElementById('videoProgressBar');
    if (container) container.style.display = 'none';

    if (_pbVideo) {
        ['timeupdate', 'progress', 'loadedmetadata', 'play', 'playing', 'pause', 'ended'].forEach(evt => {
            if (_pbHandlers[evt]) _pbVideo.removeEventListener(evt, _pbHandlers[evt]);
        });

        if (container) {
            const progressBar = container.querySelector('.video-progress-bar');
            if (progressBar) {
                if (_pbHandlers.barClick)      progressBar.removeEventListener('click',      _pbHandlers.barClick);
                if (_pbHandlers.barTouchstart) progressBar.removeEventListener('touchstart', _pbHandlers.barTouchstart);
                if (_pbHandlers.barTouchmove)  progressBar.removeEventListener('touchmove',  _pbHandlers.barTouchmove);
                if (_pbHandlers.barTouchend)   progressBar.removeEventListener('touchend',   _pbHandlers.barTouchend);
            }
        }
    }

    _pbVideo = null;
    _pbHandlers = {};
}

/**
 * Wire the shared progress bar to a video element and show it.
 * Call this whenever a video slide becomes active.
 *
 * @param {HTMLVideoElement} video
 */
export function attachProgressBarToVideo(video) {
    const container = document.getElementById('videoProgressBar');
    if (!container) return;

    detachProgressBar(); // clean up previous video's listeners

    const progressBar     = container.querySelector('.video-progress-bar');
    const progressFilled  = container.querySelector('.video-progress-filled');
    const progressBuffered = container.querySelector('.video-progress-buffered');
    const timeDisplay     = container.querySelector('.video-time-display');
    const btn             = container.querySelector('.video-play-pause-btn');
    const playIcon        = btn?.querySelector('.play-icon');
    const pauseIcon       = btn?.querySelector('.pause-icon');

    if (!progressBar || !progressFilled) return;

    _pbVideo = video;

    // ── Progress / time ──────────────────────────────────────────────────────

    const updateProgress = () => {
        if (video.duration && isFinite(video.duration)) {
            progressFilled.style.width = `${(video.currentTime / video.duration) * 100}%`;
            if (timeDisplay) {
                timeDisplay.textContent = `${formatVideoTime(video.currentTime)} / ${formatVideoTime(video.duration)}`;
            }
        }
    };
    updateProgress(); // initialize immediately with current position

    _pbHandlers.timeupdate = updateProgress;
    video.addEventListener('timeupdate', _pbHandlers.timeupdate);

    _pbHandlers.progress = () => {
        if (!progressBuffered || !video.duration || !isFinite(video.duration)) return;
        if (video.buffered.length > 0) {
            progressBuffered.style.width = `${(video.buffered.end(video.buffered.length - 1) / video.duration) * 100}%`;
        }
    };
    video.addEventListener('progress', _pbHandlers.progress);

    _pbHandlers.loadedmetadata = () => {
        progressFilled.style.width = '0%';
        if (progressBuffered) progressBuffered.style.width = '0%';
        if (timeDisplay) timeDisplay.textContent = '0:00 / 0:00';
    };
    video.addEventListener('loadedmetadata', _pbHandlers.loadedmetadata);

    // ── Play/pause button icon ────────────────────────────────────────────────

    const showPlay  = () => { if (playIcon) playIcon.style.display = 'block'; if (pauseIcon) pauseIcon.style.display = 'none'; };
    const showPause = () => { if (playIcon) playIcon.style.display = 'none';  if (pauseIcon) pauseIcon.style.display = 'block'; };

    if (video.paused) showPlay(); else showPause();

    _pbHandlers.play    = showPause;
    _pbHandlers.playing = showPause;
    _pbHandlers.pause   = showPlay;
    _pbHandlers.ended   = showPlay;
    video.addEventListener('play',    _pbHandlers.play);
    video.addEventListener('playing', _pbHandlers.playing);
    video.addEventListener('pause',   _pbHandlers.pause);
    video.addEventListener('ended',   _pbHandlers.ended);

    // ── Seek by click / touch ─────────────────────────────────────────────────

    _pbHandlers.barClick = (e) => {
        e.stopPropagation();
        if (video.duration && isFinite(video.duration)) {
            const rect = progressBar.getBoundingClientRect();
            const percent = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
            video.currentTime = percent * video.duration;
        }
    };
    progressBar.addEventListener('click', _pbHandlers.barClick);

    let isDragging = false;
    _pbHandlers.barTouchstart = (e) => { e.stopPropagation(); isDragging = true; };
    _pbHandlers.barTouchmove  = (e) => {
        if (!isDragging) return;
        e.stopPropagation();
        if (video.duration && isFinite(video.duration)) {
            const touch = e.touches[0];
            const rect = progressBar.getBoundingClientRect();
            const percent = Math.max(0, Math.min(1, (touch.clientX - rect.left) / rect.width));
            video.currentTime = percent * video.duration;
        }
    };
    _pbHandlers.barTouchend = () => { isDragging = false; };
    progressBar.addEventListener('touchstart', _pbHandlers.barTouchstart, { passive: true });
    progressBar.addEventListener('touchmove',  _pbHandlers.barTouchmove,  { passive: true });
    progressBar.addEventListener('touchend',   _pbHandlers.barTouchend,   { passive: true });

    // ── Play/pause button click ───────────────────────────────────────────────
    // Bound once via a persistent wrapper that reads _pbVideo at call time.

    if (btn && !btn._pbClickBound) {
        btn._pbClickBound = true;
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (!_pbVideo) return;
            if (_pbVideo.paused || _pbVideo.ended) {
                _pbVideo.play().catch(() => {});
            } else {
                _pbVideo.pause();
            }
        });
        btn.addEventListener('touchend', (e) => { e.stopPropagation(); }, { passive: true });
    }

    container.style.display = 'flex';
}

/**
 * Add video controls (mute icon only) to a slide.
 * The progress bar is a single shared element (#videoProgressBar) managed
 * by attachProgressBarToVideo() / detachProgressBar().
 *
 * @param {HTMLElement} slide - The slide container element
 * @param {HTMLVideoElement} video - The video element
 */
export function addVideoControls(slide, video) {  // eslint-disable-line no-unused-vars
    // Create mute icon (per-slide: shows when toggling audio on this slide)
    const muteIcon = document.createElement('div');
    muteIcon.className = 'video-mute-icon';
    muteIcon.innerHTML = `
        <svg class="muted-icon" viewBox="0 0 24 24" fill="white">
            <path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/>
        </svg>
        <svg class="unmuted-icon" viewBox="0 0 24 24" fill="white" style="display: none;">
            <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/>
        </svg>
    `;
    slide.appendChild(muteIcon);
}

export default {
    formatVideoTime,
    toggleVideoMute,
    showMuteIconFeedback,
    attachProgressBarToVideo,
    detachProgressBar,
    addVideoControls,
};
