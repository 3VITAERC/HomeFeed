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

/**
 * Setup video progress bar and time display
 * 
 * @param {HTMLVideoElement} video - The video element
 * @param {HTMLElement} slide - The slide container element
 */
export function setupVideoProgress(video, slide) {
    const progressContainer = slide.querySelector('.video-progress-container');
    const progressBar = slide.querySelector('.video-progress-bar');
    const progressFilled = slide.querySelector('.video-progress-filled');
    const progressBuffered = slide.querySelector('.video-progress-buffered');
    const timeDisplay = slide.querySelector('.video-time-display');
    
    if (!progressContainer || !progressFilled || !progressBar) return;
    
    // Update progress bar as video plays
    video.addEventListener('timeupdate', () => {
        if (video.duration && isFinite(video.duration)) {
            const progress = (video.currentTime / video.duration) * 100;
            progressFilled.style.width = `${progress}%`;
            
            // Update time display
            if (timeDisplay) {
                const current = formatVideoTime(video.currentTime);
                const total = formatVideoTime(video.duration);
                timeDisplay.textContent = `${current} / ${total}`;
            }
        }
    });
    
    // Update buffer indicator as video loads
    video.addEventListener('progress', () => {
        if (!progressBuffered || !video.duration || !isFinite(video.duration)) return;
        
        // Get the last buffered range (most recent)
        if (video.buffered.length > 0) {
            const bufferedEnd = video.buffered.end(video.buffered.length - 1);
            const bufferedPercent = (bufferedEnd / video.duration) * 100;
            progressBuffered.style.width = `${bufferedPercent}%`;
        }
    });
    
    // Reset progress bar when video loops
    video.addEventListener('loadedmetadata', () => {
        progressFilled.style.width = '0%';
        if (progressBuffered) progressBuffered.style.width = '0%';
    });
    
    // Handle seeking by tapping/clicking on progress bar
    // Use progressBar for click target to avoid time display
    progressBar.addEventListener('click', (e) => {
        e.stopPropagation(); // Don't trigger mute toggle
        
        if (video.duration && isFinite(video.duration)) {
            const rect = progressBar.getBoundingClientRect();
            const percent = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
            video.currentTime = percent * video.duration;
        }
    });
    
    // Handle dragging on progress bar
    let isDragging = false;
    
    progressBar.addEventListener('touchstart', (e) => {
        e.stopPropagation();
        isDragging = true;
    }, { passive: true });
    
    progressBar.addEventListener('touchmove', (e) => {
        if (!isDragging) return;
        e.stopPropagation();
        
        if (video.duration && isFinite(video.duration)) {
            const touch = e.touches[0];
            const rect = progressBar.getBoundingClientRect();
            const percent = Math.max(0, Math.min(1, (touch.clientX - rect.left) / rect.width));
            video.currentTime = percent * video.duration;
        }
    }, { passive: true });
    
    progressBar.addEventListener('touchend', () => {
        isDragging = false;
    }, { passive: true });
}

/**
 * Add video controls (mute icon and progress bar) to a slide
 * 
 * @param {HTMLElement} slide - The slide container element
 * @param {HTMLVideoElement} video - The video element
 */
export function addVideoControls(slide, video) {
    // Create mute icon
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
    
    // Create progress bar with buffer indicator and inline time display
    const progressContainer = document.createElement('div');
    progressContainer.className = 'video-progress-container';
    progressContainer.innerHTML = `
        <div class="video-progress-bar">
            <div class="video-progress-buffered"></div>
            <div class="video-progress-filled">
                <div class="video-progress-handle"></div>
            </div>
        </div>
        <div class="video-time-display">0:00 / 0:00</div>
    `;
    slide.appendChild(progressContainer);
    
    // Setup progress bar functionality
    setupVideoProgress(video, slide);
}

export default {
    formatVideoTime,
    toggleVideoMute,
    showMuteIconFeedback,
    setupVideoProgress,
    addVideoControls,
};
