# AGENTS.md

> **Note:** This file provides context for AI assistants (Claude, Cursor, etc.) working on this codebase. If you're a human contributor, you can skip this file - see [CONTRIBUTING.md](CONTRIBUTING.md) instead.

AI assistant context for the HomeFeed codebase.

## Project Overview

A TikTok-style vertical scrolling image viewer for local photos. Flask backend + vanilla JS frontend. Designed for mobile (iPhone) usage on local WiFi. Supports favoriting, trash/mark-for-deletion, and folder filtering.

## Project Structure (Refactored)

```
HomeFeed/
├── server.py              # Entry point (~50 lines) - creates Flask app
├── app/
│   ├── __init__.py        # Flask app factory
│   ├── config.py          # Configuration constants
│   ├── routes/
│   │   ├── __init__.py    # Blueprint registration
│   │   ├── images.py      # /image, /thumbnail, /gif, /video-poster, /api/images
│   │   ├── folders.py     # /api/folders, /api/folders/leaf
│   │   ├── favorites.py   # /api/favorites/*
│   │   ├── trash.py       # /api/trash/*
│   │   ├── cache.py       # /api/cache, /api/settings
│   │   ├── auth.py        # /login, /logout, /api/auth/*
│   │   └── pages.py       # /, /settings, /scroll, /static
│   └── services/
│       ├── __init__.py    # Service exports
│       ├── data.py        # Config, favorites, trash data management
│       ├── path_utils.py  # Path validation and normalization
│       ├── image_cache.py # Image list caching
│       ├── auth.py        # Authentication service
│       └── optimizations.py # Thumbnail/WebM conversion
├── static/
│   ├── index.html         # Main HTML (~500 lines) - structure only
│   ├── login.html         # Login page
│   ├── style.css          # TikTok-style CSS
│   └── js/
│       ├── app.js         # Main entry point
│       ├── state.js       # Centralized state management
│       ├── api.js         # API client
│       └── utils/
│           ├── path.js    # Path utilities
│           ├── gif.js     # GIF freeze/unfreeze
│           └── video.js   # Video controls
├── config.json            # Saved folder paths (gitignored)
├── favorites.json         # Saved favorites (gitignored)
├── trash.json             # Saved trash marks (gitignored)
└── .flask_session/        # Session storage (gitignored)
```

## Development Commands

```bash
# Development
python server.py

# Production (macOS/Linux)
gunicorn -w 4 -b 0.0.0.0:7123 server:app

# Production (Windows)
waitress-serve --port=7123 server:app
```

Server runs on port 7123 by default. To change the port:
```bash
# Command line argument
python server.py --port 9000

# Environment variable
PORT=9000 python server.py
```

## Architecture Overview

- **Backend:** Modular Flask application with blueprints for routes and services for business logic
- **Frontend:** ES6 modules with vanilla JS, no build step required
- **Data storage:** JSON files (config, favorites, trash) - no database
- **Image serving:** Direct file serving with ETag caching (7-day max-age)
- **Authentication:** Optional password protection via environment variable

---

## Authentication

HomeFeed supports optional password protection. When enabled, all routes require authentication.

### Enabling Authentication

Set the `HOMEFEED_PASSWORD` environment variable:

```bash
# One-time run
HOMEFEED_PASSWORD=yourpassword python server.py

# Or export for persistence
export HOMEFEED_PASSWORD=yourpassword
python server.py
```

### How It Works

1. **Session-based auth:** Uses Flask-Session with filesystem storage (`.flask_session/`)
2. **CSRF protection:** Login form includes CSRF token
3. **Optional:** Without `HOMEFEED_PASSWORD` set, the app has no authentication
4. **Session expiry:** Sessions expire when the browser closes (not persistent)

### Auth Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/login` | GET | Login page (HTML) |
| `/login` | POST | Submit password (JSON or form) |
| `/logout` | POST | Log out current session |
| `/api/auth/status` | GET | Check if auth is enabled and user is authenticated |
| `/api/auth/csrf` | GET | Get CSRF token for login form |

### Implementation Details

- **`app/services/auth.py`** - Core auth logic (password verification, session management)
- **`app/routes/auth.py`** - Auth endpoints (login, logout, status)
- **`static/login.html`** - Login page UI
- **`app/__init__.py`** - `before_request` hook checks auth for all routes

The `before_request` hook in `app/__init__.py` intercepts all requests and:
1. Skips auth check if `HOMEFEED_PASSWORD` is not set
2. Allows auth-related routes (`/login`, `/api/auth/*`)
3. Checks session for authenticated state
4. Redirects to login page or returns 401 for API requests

---

## Scrolling/Filtering Architecture

This is the most complex part of the frontend and trips up AI agents frequently.

### Key State Variables (in `static/js/state.js`)

```javascript
state.images = [];              // CURRENT displayed images (changes based on mode!)
state.allImages = [];           // Backup when in favorites mode
state.savedImages = [];         // Backup when in folder mode
state.currentIndex = 0;

state.showingFavoritesOnly = false;
state.showingTrashOnly = false;
state.showingFolderOnly = false;
state.showingUnseenOnly = false;   // NEW: unseen/new feed mode
state.currentFolderFilter = null;  // Folder path when in folder mode

// Seen tracking
state.seenPendingBuffer = [];  // Accumulates image URLs before flushing to /api/seen/batch
state.seenFlushTimer = null;   // setInterval handle for periodic 5s flush
state.seenStats = { seen_count, total_count, total_scrolls, percent_seen };
```

### View Modes

The app has 6 view modes (Unseen does not combine with other modes):

| Mode | What Shows | Backup Used |
|------|------------|-------------|
| Normal | All images from configured folders | None |
| Favorites | Only favorited images | `allImages` |
| Folder | Only images from a specific folder | `savedImages` |
| Trash | Only images marked for deletion | None |
| Folder + Favorites | Favorites within a specific folder | Both |
| **Unseen** | **Only images not yet marked seen** | **`savedImages`** |

### State Save/Restore Pattern

**Entering a mode:**
1. Save current `images` to backup array (`allImages` or `savedImages`)
2. Save current `currentIndex` to `savedIndex`
3. Fetch filtered images from API
4. Replace `images` with filtered set
5. Set mode flag to `true`
6. Rebuild slides

**Exiting a mode:**
1. Check if other modes are active (folder + favorites can combine)
2. If still in another mode, reload that mode's images
3. Otherwise, restore from backup array
4. Reset mode flag
5. Rebuild slides
6. Scroll back to `savedIndex`

**Important:** The `images` array is **replaced**, not filtered in-place. Each mode fetches a fresh list from the API.

### API Endpoints by Mode

| Mode | API Endpoint |
|------|--------------|
| Normal | `GET /api/images` |
| Folder | `GET /api/images/folder?folder=<path>` |
| Favorites | `GET /api/favorites/images` |
| Favorites + Folder | `GET /api/favorites/images/folder?folder=<path>` |
| Trash | `GET /api/trash/images` |
| **Unseen** | **`GET /api/unseen/images`** |

### Mode Transition Functions

- `enterFavoritesMode()` / `exitFavoritesMode()` - Toggle favorites filter
- `enterFolderMode(folderPath)` / `exitFolderMode()` - Toggle folder filter
- `viewTrash()` / `exitTrashMode()` - Toggle trash view
- **`enterUnseenMode()` / `exitUnseenMode()` - Toggle unseen/new feed**

When modifying these, check ALL mode flags in both enter AND exit functions.

---

## Seen / Watch History System

### Overview

The app tracks which images the user has scrolled past ("seen") to power the **New** feed (`showingUnseenOnly`). Seen data is persisted in `seen.json`.

### Data Format (`seen.json`)

```json
{
  "seen": {
    "/Users/john/Photos/vacation.jpg": {
      "first_seen": 1708560000,
      "seen_count": 3,
      "last_seen": 1708900000
    }
  },
  "total_scrolls": 847
}
```

### "Seen" Rule

An image is marked seen when **any** of these happen:
- It becomes the active slide (`_onSlideActivated` fires) — in **all** feeds including the New feed itself
- The user favorites it (`addFavorite` / `toggleFavorite`)
- The user trashes it (`toggleTrash`)

The **only** feed that skips seen-tracking is the **Trash** feed (browsing trashed items shouldn't affect the seen list). All other feeds — including the Unseen/New feed — track seen status normally so items disappear from the New feed as you scroll past them.

### Batching

To avoid one API call per scroll, seen paths are collected in `state.seenPendingBuffer` and flushed:
- When buffer reaches **10 items**
- Every **5 seconds** (periodic `setInterval`)
- On **`beforeunload`** via `navigator.sendBeacon`

### Seen API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/seen/batch` | Mark array of paths as seen; body: `{paths: [...]}` |
| `GET` | `/api/seen/stats` | Stats: `{seen_count, total_count, total_scrolls, percent_seen}` |
| `DELETE` | `/api/seen` | Reset all seen history |
| `GET` | `/api/unseen/images` | All images minus seen set, respects sort order |

### Empty-State Behavior

When the Unseen feed has 0 images (all seen, or after a reset), `noUnseen` is shown — a full-screen panel with a "View All Photos" button. It does NOT auto-navigate; the user must tap the button.

### Settings Integration

The Settings modal (Library tab) shows a Watch History stats panel with 4 numbers: Seen, New, Total Scrolls, Progress %. A "Reset Watch History" button triggers a confirmation modal before clearing `seen.json`.

---

## Backend Architecture

### Flask App Factory Pattern

```python
# server.py
from app import create_app
app = create_app()

# app/__init__.py
def create_app(config=None):
    app = Flask(__name__)
    # Register blueprints...
    return app
```

### Route Blueprints

Each route file defines a blueprint:

```python
# app/routes/images.py
images_bp = Blueprint('images', __name__)

@images_bp.route('/image')
def serve_image():
    ...
```

### Services Layer

Business logic is extracted into service modules:

- **`data.py`** - Loading/saving JSON files with thread-safe file locking
- **`path_utils.py`** - Path validation, normalization, security checks
- **`image_cache.py`** - Image list caching with TTL
- **`optimizations.py`** - Thumbnail generation, video poster extraction

### Image List Caching

```python
# In image_cache.py
_image_cache = {
    'images': None,
    'timestamp': 0,
    'folder_mtimes': {}  # Track folder modification times
}
CACHE_TTL = 30  # seconds
```

- Cache invalidated by TTL (30s) OR folder modification time change
- `get_all_images()` returns cached list or rescans

### Sort Date Hierarchy

Images are sorted by an *effective date* computed per-file at scan time and cached alongside the image path.  The hierarchy is:

| Priority | Source | Condition |
|----------|--------|-----------|
| 1 | EXIF `DateTimeOriginal` (tag 36867) | Shutter time — most accurate; only for image files with Pillow installed |
| 2 | EXIF `DateTimeDigitized` (tag 36868) | Digitization time — good for scanned photos |
| 3 | Filesystem fallback (user-configurable) | When no EXIF date is available, or for video files |

The **filesystem fallback order** is controlled by the `date_source` setting (Display tab in Settings):
- `'mtime'` (default) → modification time first, creation time as last resort
- `'ctime'` → creation time first, modification time as last resort

**Key implementation details:**
- `get_effective_date(path, date_source)` in `image_cache.py` returns a Unix timestamp following the hierarchy
- EXIF is skipped entirely for video files (`.m4v`, `.mp4`, `.mov`)
- If Pillow is not installed, silently falls through to filesystem dates
- When `date_source` changes, `invalidate_cache()` is called by the settings route so effective dates are recomputed on the next request
- `get_leaf_folders()` reuses the cached `effective_dates` dict (populated during `get_all_images()`) for `newest_mtime`, so folder ordering in the nav is consistent with the main feed

```python
# In image_cache.py
_image_cache['effective_dates'] = {path: effective_date, ...}  # populated during scan
_image_cache['date_source'] = date_source                       # used for cache invalidation check
```

### Image List Caching Performance

The image cache has been optimized for large photo libraries:

- **Folder mtime check:** Uses `os.scandir()` to check only the folder itself and immediate subdirectories (one level deep), not a full recursive walk
- **Single-pass effective date collection:** During folder scan, `get_effective_date()` is called once per file and stored in `(path, effective_date)` tuples, avoiding double filesystem/EXIF calls during sorting
- **Thread-safe writes:** All JSON file saves use `FileLock` to prevent corruption with multiple workers

### Path Security

All image-serving endpoints validate paths:

```python
def is_path_allowed(path_to_check):
    # Check if path is within configured allowed folders
    
def normalize_path(path_str):
    # Expand ~ and normalize for consistent comparison
```

Never serve files outside configured folders.

### Mutual Exclusion: Favorites vs Trash

When adding to trash, remove from favorites (and vice versa):

```python
# In add_trash():
favorites = load_favorites()
if path in favorites:
    favorites.remove(path)
    save_favorites(favorites)
```

---

## Frontend Architecture

### ES6 Modules

The frontend uses native ES6 modules:

```html
<script type="module" src="/static/js/app.js"></script>
```

### Module Structure

```javascript
// state.js - Centralized state
export const state = { ... };
export function getPreloadCount() { ... }

// api.js - API client
export async function getImages() { ... }
export async function addFavorite(path) { ... }

// utils/path.js - Path utilities
export function extractPath(imageUrl) { ... }
export function isGifUrl(url) { ... }

// utils/gif.js - GIF handling
export function freezeGif(element) { ... }
export function unfreezeGif(element) { ... }

// utils/video.js - Video controls
export function toggleVideoMute(video, slide) { ... }
export function addVideoControls(slide, video) { ... }

// In app.js - Favorite actions
async function addFavorite() { ... }      // Only adds (for double-tap)
async function toggleFavorite() { ... }   // Toggles (for heart button)
```

### Scroll Behavior

- CSS `scroll-snap-type: y mandatory` for TikTok-style snapping
- Each image is a full-screen `.image-slide`
- `IntersectionObserver` tracks current slide for `currentIndex`

### Tap Interaction Behavior

The app uses a unified tap handling system in `setupDoubleTapToLike()`:

| Action | Behavior |
|--------|----------|
| **Single tap (video)** | Mute/unmute video |
| **Double tap** | Add favorite + show heart animation (only adds, doesn't remove) |
| **Subsequent taps** | Spawn more hearts within 0.5s window |

**Important implementation details:**
- Double-tap only adds favorites; to unlike, use the heart button
- Videos auto-mute when scrolled out of view (handled in main observer)
- The tap window is 500ms for subsequent heart spawns

### Lazy Loading & Distance Guard

```javascript
const BATCH_SIZE = 50;           // Create slides in batches
const IMAGE_POOL_BUFFER = 5;     // Max distance from current slide that can trigger a load
```

**There is no `updateImagePool()` function.** The `IMAGE_POOL_BUFFER` constant is used only as a distance threshold in two guards:
1. The `needsLoad` event handler — skips loads if the slide is > 5 positions from `state.currentIndex`
2. At the top of `loadImageForSlide()` — same check, bypassed only for `isPriorityImage`

Content removal from far-away slides is handled by `_clearSlideContent()` in `_deactivateMedia()` (see Request Cancellation below), not by any periodic scan.

### Priority Loading (Perceived Performance)

The app prioritizes loading the first/visible image to feel instant:

```javascript
function prioritizeFirstImage(priorityIndex = 0):
    // Immediately load target image before IntersectionObserver triggers
    // Wait for it to be ready, then sequentially preload adjacent

function loadImageForSlide(slide, isPriorityImage = false, isNextSlide = false):
    // If isPriorityImage, hide loading overlay when content loads
    // If isNextSlide, pre-buffer video and render first frame
```

### Video First-Frame Rendering

To eliminate black flash when scrolling to a video, the `+1` slide uses the **play/pause trick**:

```javascript
// In loadVideoForSlide() onloadeddata handler:
if (isNextSlide) {
    video.play().then(() => {
        // Guard: only pause if user hasn't scrolled to this slide
        if (idx !== state.currentIndex) {
            video.pause();
            video.currentTime = 0;
        }
    });
}
```

This forces the browser to decode and paint the first frame, even while paused. Works on all browsers including iOS Safari.

### Audio Preloading

Videos use a **dual audio element** architecture for instant audio:

```javascript
// In viewport.js
let _audioEl = null;           // Current video's audio
let _nextAudioEl = null;       // Preloaded for +1 video
let _nextAudioSrc = null;      // Track what's loaded
let _scrollGeneration = 0;     // Incremented on every slide change; stale preload chains check this

// During sequentialPreload():
preloadAudioForNextSlide(videoSrc);  // Loads into _nextAudioEl

// On scroll:
// Swap _audioEl ↔ _nextAudioEl instead of loading fresh
```

**Key implementation details:**
- URL normalization handles relative vs absolute URLs
- Play/pause trick forces actual audio buffering
- `canplay` event handling for currentTime sync
- Sync interval: 100ms with 0.15s drift threshold

### Request Cancellation

When a slide leaves the viewport, `_deactivateMedia()` in `viewport.js` actively cancels any in-flight network request:

```javascript
// For videos still actively downloading (NETWORK_LOADING):
function _clearSlideContent(slide) {
    // For each child: abort download, then remove from DOM
    video.pause(); video.removeAttribute('src'); video.load(); // cancels HTTP range request
    img.src = '';  // cancels image download
    child.remove(); // slide becomes empty shell → needsLoad re-fires on revisit
}
```

**Rule:** `video.preload = 'none'` does NOT cancel in-flight requests. Only `removeAttribute('src') + load()` works. Always use `_clearSlideContent()` for aggressive abort.

**When content is preserved:** If `video.networkState !== NETWORK_LOADING` (already fully buffered), the element stays and `preload='none'` is set. Backward scrolling to recently-viewed content is instant.

### Loading Indicator

A centered triple-ring spinner shows during initial load and mode transitions:

**HTML Structure:**
```html
<div class="loading-overlay" id="loadingOverlay">
    <div class="loading-spinner-main">
        <div class="spinner-ring"></div>
        <div class="spinner-ring"></div>
        <div class="spinner-ring"></div>
    </div>
</div>
```

**Behavior:**
- Visible by default on page load
- Shows during mode transitions (folder change, favorites, trash, sort)
- Hidden when the priority image loads (via `isPriorityImage` flag)
- Transparent background - all UI elements remain visible

**Key Functions:**
```javascript
function showLoadingOverlay()  // Show spinner
function hideLoadingOverlay()  // Fade out spinner
```

**When Spinner Shows:**
- Initial page load
- Entering/exiting favorites mode
- Entering/exiting folder mode
- Entering/exiting trash mode
- Changing sort order
- Toggling shuffle

**When Spinner Hides:**
- Static image: `onload` or `onerror`
- Video: poster `onload` (if enabled) or video `onloadeddata`
- GIF: same as image (loaded as static image)

```javascript
// sequentialPreload signature — generation param is critical:
function sequentialPreload(centerIndex, current, max, ahead = true, generation = 0):
    // generation !== getScrollGeneration() → abort immediately (stale chain)
    // Load adjacent images with 150ms delays between batches
    // Only the +1 slide (isNextSlide=true) gets preload='auto'; others get 'metadata'
```

---

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| **H** / **Left Arrow** | Mark for deletion (toggle trash) |
| **J** / **Down Arrow** | Scroll down one image |
| **K** / **Up Arrow** | Scroll up one image |
| **L** / **Right Arrow** | Like image (toggle favorite) |
| **F** | Toggle favorites view |
| **D** | Toggle trash/deletion folder view |
| **M** | Mute/Unmute video |
| **I** | Toggle Info modal |
| **S** | Toggle Settings modal |
| **?** | Show keyboard shortcuts help modal |
| **Escape** | Close any open modal |

---

## Code Conventions

- **URL encoding:** All paths in URLs are URL-encoded (`quote(path, safe="")`)
- **Path normalization:** Use `normalize_path()` in Python, `normalizePath()` in JS
- **Mode flags:** Check all three (`showingFavoritesOnly`, `showingTrashOnly`, `showingFolderOnly`) before assuming state
- **API paths:** Frontend sends full image URLs like `/image?path=...`, backend extracts path from query param
- **ES6 modules:** Use `import`/`export` syntax, no CommonJS

---

## Cross-Platform Compatibility

This application runs on both macOS and Windows. Key considerations:

### Path Separator Handling

Windows uses backslashes (`\`) while macOS/Linux uses forward slashes (`/`). The frontend normalizes paths before comparison:

```javascript
function normalizePath(path) {
    if (!path) return path;
    return path.replace(/\\/g, '/');  // Convert backslashes to forward slashes
}
```

---

## Common Pitfalls for AI Agents

1. **Don't confuse `state.images` with `state.allImages`/`state.savedImages`**
   - `state.images` is the current view, the others are backups
   - Modifying `state.images` directly won't persist

2. **When adding new filter modes**
   - Update both enter AND exit functions
   - Check all existing mode flags
   - Decide which backup array to use

3. **Folder mode can combine with favorites mode**
   - `showingFolderOnly && showingFavoritesOnly` is valid
   - Exit logic must handle this

4. **The `images` array is replaced, not filtered in-place**
   - Each mode fetches from API, doesn't filter client-side

5. **When adding API endpoints**
   - Add path validation with `validate_and_normalize_path()`
   - Return 403 for paths outside allowed folders

6. **When modifying image serving**
   - Preserve ETag and caching headers
   - Test with both images and videos

7. **`video.preload = 'none'` does NOT cancel an in-flight HTTP range request**
   - Setting `preload` is a hint only; the network request continues
   - To actually abort: `video.removeAttribute('src'); video.load()`
   - This is handled by `_clearSlideContent()` in `_deactivateMedia()`

8. **`updateImagePool()` does not exist**
   - The `IMAGE_POOL_BUFFER` constant is only used for distance guards in `needsLoad` and `loadImageForSlide`
   - Content removal happens in `_deactivateMedia()` via `_clearSlideContent()` when `networkState === NETWORK_LOADING`
   - If you add code that references `updateImagePool()`, it will silently do nothing

9. **`sequentialPreload` must receive and pass a `generation` parameter**
   - Every call site must capture `getScrollGeneration()` and pass it
   - Every recursive `setTimeout` call must forward `generation`
   - Without this, fast scrolling creates multiple concurrent download chains

10. **When a slide is cleared by `_clearSlideContent`, that is normal and expected**
    - The slide becomes an empty shell — `needsLoad` will reload it when user scrolls back
    - Content reloads from browser disk cache (instant for local server)
    - Do NOT treat a blank slide after scrolling back as a bug; it's working correctly

---

## Performance Optimizations (Cache System)

The app includes optional performance optimizations that cache processed versions of images/videos for faster loading. These are user-controlled toggles in Settings.

### Available Optimizations

| Optimization | Description | Benefit | Requires |
|--------------|-------------|---------|----------|
| **Image Thumbnails** | Resizes images to 1920px max, converts to WebP | 50-80% smaller files | Pillow |
| **Video Posters** | Extracts first frame as preview image | Instant preview while video loads | ffmpeg |
| **Fill Screen** | Crops images to fill viewport | No black bars on mobile | None |
| **Auto-Advance** | Auto-scroll when video ends or after delay for photos | Hands-free browsing | None |
| **Preload Distance** | Number of slides to preload ahead (0-10) | Smoother scrolling | None |

> **ffmpeg** is a system binary (not pip package). Install separately.

### Backend Implementation

**Settings Storage:**
```python
# In config.json
{
    "optimizations": {
        "thumbnail_cache": false,
        "video_poster_cache": false,
        "fill_screen": false,
        "auto_advance": false,
        "auto_advance_delay": 3,
        "preload_distance": 3
    }
}
```

**Cache Endpoints:**
```python
GET  /api/settings          # Get current settings
POST /api/settings          # Update settings
GET  /api/cache             # Get cache stats (file count, size)
DELETE /api/cache           # Clear all cached files
```

### Preload Distance Implementation

The preload distance setting controls how many slides ahead of the viewport should be preloaded:

**How it works:**
1. `getPreloadCount()` in `state.js` returns the user's setting (0-10)
2. `sequentialPreload()` in `app.js` creates slides on-demand and loads their content
3. Preloaded images use `loading='eager'` to force actual loading (not lazy)
4. `sequentialPreload` carries a `generation` parameter — if `_scrollGeneration` changes (user scrolled), the chain aborts immediately

**At preload_distance = 0:**
- `sequentialPreload` is not called (guarded by `if (preloadCount > 0)`)
- Slides still load via `needsLoad` observer events when they enter the viewport's rootMargin zone
- Those observer-triggered loads are cancelled immediately when the slide exits viewport and `networkState === NETWORK_LOADING`
