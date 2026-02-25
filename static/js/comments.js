/**
 * Comments panel for HomeFeed.
 *
 * TikTok-style bottom sheet that shows:
 *   - A .txt sidecar caption (if the photo has one), editable
 *   - Reddit comments (if gallery-dl JSON sidecar exists) — read-only
 *   - User notes typed in the app, editable/deletable
 *
 * Usage:
 *   import { initComments, openComments, closeComments } from './comments.js';
 *   initComments();                            // call once on app startup
 *   openComments('/image?path=...');          // open panel for current image
 */

import API from './api.js';

// ─── DOM refs ────────────────────────────────────────────────────────────────
let panel, overlay, closeBtn, list, empty;
let sidecarSection, sidecarText, sidecarEditBtn, sidecarEditArea, sidecarTextarea;
let sidecarCancelBtn, sidecarSaveBtn;
let input, sendBtn, countEl;
let commentsBadge;

// ─── State ───────────────────────────────────────────────────────────────────
let currentImagePath = null;   // The image URL the panel is open for
let currentSidecarText = null; // Current .txt file content (null = no file)
let isOpen = false;

// ─── Init ────────────────────────────────────────────────────────────────────

export function initComments() {
    panel    = document.getElementById('commentsPanel');
    overlay  = document.getElementById('commentsOverlay');
    closeBtn = document.getElementById('commentsPanelClose');
    list     = document.getElementById('commentsList');
    empty    = document.getElementById('commentsEmpty');
    countEl  = document.getElementById('commentsPanelCount');

    sidecarSection  = document.getElementById('commentsSidecar');
    sidecarText     = document.getElementById('sidecarText');
    sidecarEditBtn  = document.getElementById('sidecarEditBtn');
    sidecarEditArea = document.getElementById('sidecarEditArea');
    sidecarTextarea = document.getElementById('sidecarTextarea');
    sidecarCancelBtn = document.getElementById('sidecarCancelBtn');
    sidecarSaveBtn   = document.getElementById('sidecarSaveBtn');

    input   = document.getElementById('commentsInput');
    sendBtn = document.getElementById('commentsSendBtn');

    commentsBadge = document.getElementById('commentsBadge');

    if (!panel) return;

    // Close handlers
    closeBtn.addEventListener('click', closeComments);
    overlay.addEventListener('click', closeComments);

    // Input auto-resize + send button enable
    input.addEventListener('input', () => {
        input.style.height = 'auto';
        input.style.height = Math.min(input.scrollHeight, 120) + 'px';
        sendBtn.disabled = !input.value.trim();
    });

    // Send comment
    sendBtn.addEventListener('click', handleSendComment);
    input.addEventListener('keydown', (e) => {
        // Ctrl/Cmd+Enter submits; plain Enter adds a newline (normal textarea)
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            handleSendComment();
        }
    });

    // Sidecar edit
    sidecarEditBtn.addEventListener('click', enterSidecarEdit);
    sidecarCancelBtn.addEventListener('click', exitSidecarEdit);
    sidecarSaveBtn.addEventListener('click', handleSidecarSave);

    // Keyboard: Escape closes panel
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && isOpen) closeComments();
    });
}

// ─── Open / Close ────────────────────────────────────────────────────────────

/**
 * Open the comments panel for a given image URL.
 * @param {string} imagePath - e.g. '/image?path=...'
 */
export async function openComments(imagePath) {
    if (!panel) return;
    currentImagePath = imagePath;
    isOpen = true;

    // Show overlay + panel (slide up animation handled by CSS class)
    overlay.style.display = 'block';
    panel.classList.add('open');
    document.body.style.overflow = 'hidden';

    // Clear and show loading state
    list.innerHTML = '<div class="comments-loading"><div class="comments-spinner"></div></div>';
    empty.style.display = 'none';
    sidecarSection.style.display = 'none';
    countEl.textContent = '';

    // Fetch comments
    try {
        const data = await API.getComments(imagePath);
        renderComments(data);
    } catch (err) {
        list.innerHTML = '<div class="comments-error">Could not load comments.</div>';
        console.error('Failed to load comments:', err);
    }

    // Focus input after animation
    setTimeout(() => input && input.focus(), 350);
}

export function closeComments() {
    if (!panel) return;
    isOpen = false;
    panel.classList.remove('open');
    overlay.style.display = 'none';
    document.body.style.overflow = '';
    exitSidecarEdit(true);
    currentImagePath = null;
}

export function isCommentsOpen() {
    return isOpen;
}

// ─── Rendering ───────────────────────────────────────────────────────────────

function renderComments(data) {
    const comments = data.comments || [];
    currentSidecarText = data.sidecar ?? null;

    // Sidecar caption section
    if (data.has_sidecar) {
        sidecarSection.style.display = 'block';
        sidecarText.textContent = currentSidecarText || '';
        exitSidecarEdit(true);
    } else {
        sidecarSection.style.display = 'none';
    }

    // Comments list
    list.innerHTML = '';

    const userComments = comments.filter(c => c.type === 'user');
    const redditComments = comments.filter(c => c.type === 'reddit');

    // Reddit comments first (they're original source material)
    redditComments.forEach(c => list.appendChild(buildRedditComment(c)));
    // User notes after
    userComments.forEach(c => list.appendChild(buildUserComment(c)));

    // Empty state (only if no user comments AND no reddit; sidecar is shown separately)
    const hasContent = comments.length > 0;
    empty.style.display = hasContent ? 'none' : 'flex';

    // Count label: only count user comments + reddit, not sidecar
    const total = comments.length;
    countEl.textContent = total > 0 ? `${total}` : '';

    // Update action bar badge
    updateBadge(userComments.length);
}

function buildUserComment(comment) {
    const el = document.createElement('div');
    el.className = 'comment-item comment-user';
    el.dataset.id = comment.id;

    const meta = document.createElement('div');
    meta.className = 'comment-meta';

    if (comment.profile_name) {
        const author = document.createElement('span');
        author.className = 'comment-author';
        author.textContent = comment.profile_name;
        meta.appendChild(author);
    }

    const time = document.createElement('span');
    time.className = 'comment-time';
    time.textContent = formatRelativeTime(comment.created_at);
    if (comment.edited_at) {
        time.textContent += ' (edited)';
    }
    meta.appendChild(time);

    const actions = document.createElement('div');
    actions.className = 'comment-actions';

    const editBtn = document.createElement('button');
    editBtn.className = 'comment-action-btn';
    editBtn.title = 'Edit';
    editBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>`;
    editBtn.addEventListener('click', () => enterCommentEdit(el, comment));

    const delBtn = document.createElement('button');
    delBtn.className = 'comment-action-btn comment-delete-btn';
    delBtn.title = 'Delete';
    delBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>`;
    delBtn.addEventListener('click', () => handleDeleteComment(comment.id, el));

    actions.appendChild(editBtn);
    actions.appendChild(delBtn);

    const body = document.createElement('div');
    body.className = 'comment-body';

    const textEl = document.createElement('p');
    textEl.className = 'comment-text';
    textEl.textContent = comment.text;

    body.appendChild(meta);
    body.appendChild(actions);
    el.appendChild(body);
    el.appendChild(textEl);

    return el;
}

function buildRedditComment(comment) {
    const el = document.createElement('div');
    el.className = 'comment-item comment-reddit';

    const header = document.createElement('div');
    header.className = 'comment-meta';

    const author = document.createElement('span');
    author.className = 'comment-author comment-reddit-author';
    author.textContent = comment.author ? `u/${comment.author}` : 'Reddit';
    header.appendChild(author);

    if (comment.score !== null && comment.score !== undefined) {
        const score = document.createElement('span');
        score.className = 'comment-reddit-score';
        score.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor" width="10" height="10"><path d="M12 4l2.5 5.5 6 .75-4.25 4.25 1 5.5L12 17.25l-5.25 2.75 1-5.5L3.5 10.25l6-.75z"/></svg> ${formatScore(comment.score)}`;
        header.appendChild(score);
    }

    if (comment.created_at) {
        const time = document.createElement('span');
        time.className = 'comment-time';
        time.textContent = formatRelativeTime(comment.created_at);
        header.appendChild(time);
    }

    const textEl = document.createElement('p');
    textEl.className = 'comment-text';
    // Support basic markdown bold (**text**) from Reddit selftext
    textEl.innerHTML = escapeAndMarkdown(comment.text);

    el.appendChild(header);
    el.appendChild(textEl);
    return el;
}

// ─── Comment CRUD ─────────────────────────────────────────────────────────────

async function handleSendComment() {
    const text = input.value.trim();
    if (!text || !currentImagePath) return;

    sendBtn.disabled = true;
    try {
        const result = await API.postComment(currentImagePath, text);
        input.value = '';
        input.style.height = 'auto';
        sendBtn.disabled = true;

        // Append new comment to list without re-fetching
        const newEl = buildUserComment(result.comment);
        list.appendChild(newEl);
        newEl.scrollIntoView({ behavior: 'smooth', block: 'end' });
        empty.style.display = 'none';

        // Update count
        const current = parseInt(countEl.textContent) || 0;
        countEl.textContent = String(current + 1);
        updateBadge(current + 1);
    } catch (err) {
        console.error('Failed to post comment:', err);
        sendBtn.disabled = false;
    }
}

function enterCommentEdit(el, comment) {
    const textEl = el.querySelector('.comment-text');
    if (!textEl) return;

    // Replace text with an inline textarea
    const origText = comment.text;
    const editWrap = document.createElement('div');
    editWrap.className = 'comment-inline-edit';

    const ta = document.createElement('textarea');
    ta.className = 'comment-edit-textarea';
    ta.value = origText;
    ta.rows = Math.max(2, origText.split('\n').length);

    const btnRow = document.createElement('div');
    btnRow.className = 'comment-edit-btns';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'sidecar-btn cancel';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', () => {
        editWrap.replaceWith(textEl);
    });

    const saveBtn = document.createElement('button');
    saveBtn.className = 'sidecar-btn save';
    saveBtn.textContent = 'Save';
    saveBtn.addEventListener('click', async () => {
        const newText = ta.value.trim();
        if (!newText || !currentImagePath) return;
        try {
            const result = await API.editComment(currentImagePath, comment.id, newText);
            textEl.textContent = result.comment.text;
            editWrap.replaceWith(textEl);
            // Update time in meta
            const timeEl = el.querySelector('.comment-time');
            if (timeEl) timeEl.textContent = formatRelativeTime(result.comment.edited_at || result.comment.created_at) + ' (edited)';
        } catch (err) {
            console.error('Failed to edit comment:', err);
        }
    });

    btnRow.appendChild(cancelBtn);
    btnRow.appendChild(saveBtn);
    editWrap.appendChild(ta);
    editWrap.appendChild(btnRow);
    textEl.replaceWith(editWrap);
    ta.focus();
    ta.select();
}

async function handleDeleteComment(commentId, el) {
    if (!currentImagePath) return;
    try {
        await API.deleteComment(currentImagePath, commentId);
        el.remove();

        const remaining = list.querySelectorAll('.comment-user').length;
        const redditCount = list.querySelectorAll('.comment-reddit').length;
        if (remaining + redditCount === 0) {
            empty.style.display = 'flex';
        }
        const total = remaining + redditCount;
        countEl.textContent = total > 0 ? String(total) : '';
        updateBadge(remaining);
    } catch (err) {
        console.error('Failed to delete comment:', err);
    }
}

// ─── Sidecar Edit ─────────────────────────────────────────────────────────────

function enterSidecarEdit() {
    if (!sidecarEditArea) return;
    sidecarTextarea.value = currentSidecarText || '';
    sidecarText.style.display = 'none';
    sidecarEditBtn.style.display = 'none';
    sidecarEditArea.style.display = 'block';
    sidecarTextarea.focus();
}

function exitSidecarEdit(silent = false) {
    if (!sidecarEditArea) return;
    sidecarEditArea.style.display = 'none';
    sidecarText.style.display = 'block';
    sidecarEditBtn.style.display = '';
}

async function handleSidecarSave() {
    const newText = sidecarTextarea.value;
    if (!currentImagePath) return;
    try {
        await API.updateSidecar(currentImagePath, newText);
        currentSidecarText = newText;
        sidecarText.textContent = newText;
        exitSidecarEdit();
    } catch (err) {
        console.error('Failed to save sidecar:', err);
    }
}

// ─── Badge ───────────────────────────────────────────────────────────────────

function updateBadge(count) {
    if (!commentsBadge) return;
    if (count > 0) {
        commentsBadge.style.display = 'block';
        commentsBadge.textContent = count > 99 ? '99+' : String(count);
    } else {
        commentsBadge.style.display = 'none';
    }
}

/**
 * Refresh the badge count for a given image path without opening the panel.
 * Called when navigating to a new slide.
 * @param {string} imagePath
 */
export async function refreshCommentBadge(imagePath) {
    if (!commentsBadge) return;
    try {
        const data = await API.getComments(imagePath);
        const userCount = (data.comments || []).filter(c => c.type === 'user').length;
        updateBadge(userCount);
    } catch (_) {
        updateBadge(0);
    }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatRelativeTime(timestamp) {
    if (!timestamp) return '';
    const now = Date.now() / 1000;
    const ts = typeof timestamp === 'number' ? timestamp : Date.parse(timestamp) / 1000;
    const diff = now - ts;
    if (diff < 60) return 'just now';
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    if (diff < 2592000) return `${Math.floor(diff / 86400)}d ago`;
    const date = new Date(ts * 1000);
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatScore(score) {
    if (score >= 1000) return (score / 1000).toFixed(1) + 'k';
    return String(score);
}

function escapeAndMarkdown(text) {
    if (!text) return '';
    // Basic XSS escape
    const escaped = text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    // Very minimal markdown: **bold** and newlines
    return escaped
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/\n/g, '<br>');
}
