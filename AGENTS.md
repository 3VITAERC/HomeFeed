# AGENTS.md

> **Note:** This file provides context for AI assistants (Claude, Cursor, etc.) working on this codebase. If you're a human contributor, you can skip this file - see [CONTRIBUTING.md](CONTRIBUTING.md) instead.

AI assistant context for the LocalFeed codebase.

## Project Overview

A TikTok-style vertical scrolling image viewer for local photos. Flask backend + vanilla JS frontend. Designed for mobile (iPhone) usage on local WiFi. Supports favoriting, trash/mark-for-deletion, and folder filtering.

## Project Structure (Refactored)

```
LocalFeed/
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
│   │   └── pages.py       # /, /settings, /scroll, /static
│   └── services/
│       ├── __init__.py    # Service exports
│       ├── data.py        # Config, favorites, trash data management
│       ├── path_utils.py  # Path validation and normalization
│       ├── image_cache.py # Image list caching
│       └── optimizations.py # Thumbnail/WebM conversion
├── static/
│   ├── index.html         # Main HTML (~500 lines) - structure only
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
└── trash.json             # Saved trash marks (gitignored)
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
state.currentFolderFilter = null;  // Folder path when in folder mode
```

### View Modes

The app has 5 view modes that can combine:

| Mode | What Shows | Backup Used |
|------|------------|-------------|
| Normal | All images from configured folders | None |
| Favorites | Only favorited images | `allImages` |
| Folder | Only images from a specific folder | `savedImages` |
| Trash | Only images marked for deletion | None |
| Folder + Favorites | Favorites within a specific folder | Both |

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

### Mode Transition Functions

- `enterFavoritesMode()` / `exitFavoritesMode()` - Toggle favorites filter
- `enterFolderMode(folderPath)` / `exitFolderMode()` - Toggle folder filter
- `viewTrash()` / `exitTrashMode()` - Toggle trash view

When modifying these, check ALL mode flags in both enter AND exit functions.

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

- **`data.py`** - Loading/saving JSON files (config, favorites, trash)
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

### Lazy Loading & Image Pool

```javascript
const BATCH_SIZE = 50;           // Create slides in batches
const IMAGE_POOL_BUFFER = 5;     // Keep 5 images above/below viewport

function updateImagePool():
    // Remove images far from viewport to save memory
    // Only ~10-15 images loaded at once
```

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

function sequentialPreload(centerIndex, current, max):
    // Load adjacent images with 150ms delays between batches
    // Prevents bandwidth contention from multiple videos/GIFs
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

**Known Issues (as of implementation):**
- Setting of 0 still preloads +1 slide due to IntersectionObserver's `rootMargin: '100px'`
- Video audio preloading (`preloadAudioForNextSlide`) may still trigger even at 0
- State may not persist correctly across page refreshes or settings modal open/close

See `Plans/preload-fixes.md` for planned improvements.
