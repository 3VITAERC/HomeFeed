# HomeFeed Performance Review

**Reviewer:** External Third-Party
**Date:** February 2026
**Scope:** Server-side compute, client-side device performance, scalability to 10,000+ media assets
**Constraint:** Edge-device hosting (limited CPU, no GPU, minimal RAM headroom)

---

## Executive Summary

HomeFeed is a well-architected personal media viewer with surprisingly good performance fundamentals for a solo project. The caching layers, lazy loading, request cancellation, and HTTP range request support show clear thoughtfulness. However, there are **several structural bottlenecks** that will degrade the experience as libraries scale to 10,000+ items, particularly on edge-device servers and older mobile phones. The biggest issues are: (1) the `/api/images` endpoint returning the **entire image list in one payload**, (2) **EXIF scanning on every cache miss** blocking the server, (3) **JSON flat-file data storage** becoming a serialization bottleneck, and (4) **all slides being DOM-created** (even if deferred) for the full image set.

The current tech stack (Python/Flask + Vanilla JS) is **not the problem**. A rewrite to Rust, TypeScript, or Tailwind would not address the architectural issues and would introduce significant risk for marginal benefit. The correct path is targeted optimizations within the current stack.

---

## Table of Contents

1. [Critical Server-Side Issues](#1-critical-server-side-issues)
2. [Critical Client-Side Issues](#2-critical-client-side-issues)
3. [Moderate Server-Side Issues](#3-moderate-server-side-issues)
4. [Moderate Client-Side Issues](#4-moderate-client-side-issues)
5. [Minor Issues & Polish](#5-minor-issues--polish)
6. [What's Already Done Well](#6-whats-already-done-well)
7. [Technology Stack Assessment](#7-technology-stack-assessment)
8. [The Magic Wand List](#8-the-magic-wand-list)
9. [Recommended Prioritization](#9-recommended-prioritization)

---

## 1. Critical Server-Side Issues

### 1.1 Full Image List Returned on Every Load

**Files:** `app/routes/images.py:41-54`, `app/services/image_cache.py:186-257`

The `/api/images` endpoint returns the **entire image list** as a single JSON array. With 10,000 photos, this means:

- **Scanning:** `os.walk()` across all folders on every cache miss, calling `os.stat()` and potentially `PIL.Image.open()` on every file
- **Serialization:** Building a JSON array of 10,000+ URL-encoded strings (~1-2 MB of JSON)
- **Network:** Transferring that entire payload to the client before anything renders
- **Client parse:** The browser must parse and store 10,000+ strings in memory

At 10,000 images, the initial `/api/images` call will take 2-10+ seconds on an edge device (especially with EXIF scanning), and the JSON response will be 1-3 MB even with gzip.

**Recommendation:** Implement **server-side pagination**. The API should accept `?offset=0&limit=50` and return only the requested window. The client already loads slides in batches — it just needs to fetch URLs in batches too. This is the single highest-impact change possible.

### 1.2 EXIF Scanning Blocks the Server on Cache Miss

**File:** `app/services/image_cache.py:37-98`

`get_effective_date()` opens every image file with Pillow to read EXIF data. On a cache miss with 10,000 photos, this means:

- 10,000 file opens via `PIL.Image.open()`
- 10,000 EXIF parses (`img._getexif()`)
- All happening **synchronously** on the main thread, blocking all other requests

On an edge device with an HDD or SD card, this single operation could take **30-60+ seconds**. During that time, Flask cannot serve any other requests (even with gunicorn workers, you'll exhaust them quickly).

**Recommendation:**
- **Cache effective dates to a persistent file** (e.g., `date_cache.json` or a SQLite DB) keyed by `path:mtime:size`. Only scan new/changed files.
- Consider **background scanning** — return results with filesystem dates immediately and update EXIF dates asynchronously.

### 1.3 JSON Flat-File Storage Won't Scale

**File:** `app/services/data.py` (entire file)

Every favorites toggle, trash toggle, and seen-batch write requires:
1. Read entire JSON file from disk
2. Parse into Python dict
3. Modify one entry
4. Serialize entire dict back to JSON
5. Write entire file to disk (with file lock)

With 10,000 seen entries, `seen.json` becomes ~500 KB-1 MB. Every 5-second flush or 10-item batch means reading and writing that full file. With multiple gunicorn workers, the file lock creates **serialization bottlenecks** — workers queue up waiting for the lock.

**Recommendation:** Migrate to **SQLite**. It's zero-configuration, file-based (no server process), supports concurrent reads, has row-level granularity, and Python ships with `sqlite3` built-in. This alone would:
- Eliminate read-modify-write cycles for single-item operations
- Support `INSERT OR REPLACE` for seen tracking (no full-file rewrite)
- Enable efficient `SELECT ... WHERE path NOT IN (SELECT path FROM seen)` for the unseen feed
- Remove the file-lock serialization bottleneck

This is not a database server — SQLite is a file format. It has the same operational simplicity as JSON files but handles concurrency and scale dramatically better.

---

## 2. Critical Client-Side Issues

### 2.1 All Slides Created in DOM (Even Deferred)

**File:** `static/js/app.js:725-752` (scheduleDeferredSlides)

`buildSlides()` creates an immediate buffer of ~21 slides synchronously, then schedules **all remaining slides** (potentially 10,000+) via `requestIdleCallback`. Even though creation is deferred and chunked at 50/batch, you're still:

- Creating 10,000 `<div>` elements in the DOM
- Running 10,000 `querySelectorAll('.image-slide')` lookups for ordered insertion (line 663)
- Observing 10,000 elements with `IntersectionObserver`

This makes the DOM massive and the `IntersectionObserver` callback increasingly expensive as it tracks thousands of elements. On an iPhone SE or older Android device, this will cause **jank and memory pressure**.

**Recommendation:** Implement a **windowed slide pool**. Only ever have ~30-50 slide `<div>` elements in the DOM. As the user scrolls, recycle slide elements by changing their `data-index` and `data-src`. This is the client-side counterpart to server-side pagination.

Note: This is NOT the same as virtual scrolling (which you've correctly identified as incompatible with snap scrolling). A windowed pool keeps real DOM elements with `scroll-snap-align: start` — it just caps the total count and recycles them. The key difference from true virtual scrolling: you keep the scroll container's `scrollHeight` honest by using placeholder spacers above and below the pool, and the snap behavior stays intact because real elements exist at the snap points.

### 2.2 Full Image Array Stored in Client Memory

**File:** `static/js/state.js:15-19`

`state.images` holds the full URL array for all images. With 10,000 images, this is ~1-2 MB of strings. But the real issue is the **backup arrays**: when entering folder mode or favorites mode, the entire array is duplicated (`state.savedImages = [...state.images]`, `state.allImages = [...state.images]`). With mode nesting, you could have 3-4 copies of the full array in memory simultaneously.

**Recommendation:** With server-side pagination, the client would only hold the current window of URLs. Mode transitions would store just the scroll position and mode type, and re-fetch from the paginated API.

### 2.3 O(n) DOM Query in createSlide

**File:** `static/js/app.js:662-677`

Every `createSlide()` call runs `scrollContainer.querySelectorAll('.image-slide')` and iterates all existing slides to find the insertion point. During deferred creation of 10,000 slides, this is called 10,000 times, each time scanning an increasingly large node list. This is **O(n²)** total work.

**Recommendation:** Maintain a simple `Map<index, element>` for O(1) lookup, or use `document.createDocumentFragment()` for batch insertion during deferred creation.

---

## 3. Moderate Server-Side Issues

### 3.1 `get_images_by_folder()` Scans Everything Then Filters

**File:** `app/services/image_cache.py:260-271`

```python
def get_images_by_folder(folder_path):
    images = get_all_images()  # Load ALL images
    filtered_images = [img for img in images if os.path.dirname(img) == folder_path]
```

This loads the entire image list (triggering a potential full scan) just to filter by one folder. If the cache is valid this is fast, but the linear scan of 10,000+ paths for `os.path.dirname()` comparison is wasteful.

**Recommendation:** Build a folder-indexed dict during the scan: `{folder_path: [image_paths]}`. Then folder lookups become O(1).

### 3.2 `cleanup_favorites()` and `cleanup_trash()` Called on Every Read

**Files:** `app/routes/favorites.py:33-37`, `app/routes/trash.py` (similar pattern)

Every `GET /api/favorites` calls `cleanup_active_favorites()`, which:
1. Loads all favorites from disk
2. Calls `os.path.exists()` on every single path
3. Rewrites the file if any are invalid

With 500 favorites, that's 500 filesystem existence checks on every favorites read. On an HDD/SD card edge device, this is slow.

**Recommendation:** Run cleanup lazily — once per session, or on a timer — not on every read. Or better, move to SQLite and add a `last_verified` timestamp column.

### 3.3 `format_image_url()` Calls `get_optimization_settings()` Per-Image

**File:** `app/services/path_utils.py:106-122`

`format_image_url()` is called once per image in the list (10,000 times). Each call invokes `get_optimization_settings()`, which (thanks to the `flask.g` cache) only reads disk once per request — but still involves function call overhead, dict lookup, and `getattr` on `g` 10,000 times.

**Recommendation:** Hoist the settings lookup outside the loop in the caller. Pass a boolean `use_thumbnails` parameter to `format_image_url()`. Minor but it adds up at scale.

### 3.4 Video Range Request Reads into Memory

**File:** `app/routes/images.py:336-349`

```python
with open(expanded_image, 'rb') as f:
    f.seek(start)
    data = f.read(end - start + 1)
response = make_response(data)
```

The entire requested range is read into Python memory, then copied to the response. For a typical video range request (~1-2 MB), this is fine. But browsers sometimes request large ranges, and this creates full copies in memory. Flask's `send_file` with range support would be more memory-efficient.

**Recommendation:** Consider using a streaming response with a generator, or leverage a WSGI server (nginx/caddy) for static file serving with native range request support. An nginx reverse proxy in front of gunicorn would offload all static file serving entirely from Python.

### 3.5 No Background Worker for Thumbnail Generation

**File:** `app/services/optimizations.py:45-111`

Thumbnail creation (Pillow resize + WebP encode) happens **synchronously during the HTTP request**. The first time a user visits a 10,000-image library with thumbnails enabled, each image request creates a thumbnail on-the-fly. On an edge device, each Pillow resize takes 100-500ms, blocking that request.

**Recommendation:** Add a background thumbnail pre-generation command (e.g., `python server.py --generate-thumbnails`). This could run overnight on the edge device. The HTTP endpoint would then only serve pre-cached thumbnails or fall back to originals.

---

## 4. Moderate Client-Side Issues

### 4.1 GIF Freeze Cache Grows Unbounded

**File:** `static/js/utils/gif.js:9`

```javascript
const gifFreezeCache = new Map();
```

Every GIF that gets frozen generates a full PNG `toDataURL()` (line 50) stored in this Map. A single GIF's frozen frame as a data URL can be **2-10 MB** (it's an uncompressed PNG encoded as base64). With 100 GIFs in a library, this cache could consume 200 MB+ of browser memory.

**Recommendation:** Implement an LRU eviction policy (keep only the most recent ~20 frozen frames). Or better, use `canvas.toBlob()` with `URL.createObjectURL()` instead of `toDataURL()` — blob URLs don't require base64 encoding and are more memory-efficient.

### 4.2 Sequential Preload Uses Recursive setTimeout

**File:** `static/js/app.js:1225-1313`

`sequentialPreload()` chains via `setTimeout(() => sequentialPreload(...), 150)`. With a preload distance of 10, that's 10 chained 150ms timeouts = 1.5 seconds of delay before the last preloaded image even begins loading. The serial nature means images are loaded one-at-a-time rather than leveraging the browser's ability to pipeline multiple requests.

**Recommendation:** Use `Promise`-based parallel loading with concurrency control (e.g., load 2-3 images simultaneously with a semaphore). This would cut preload time dramatically.

### 4.3 `extractPath()` Called Repeatedly for Same URL

**Files:** Multiple locations in `app.js`

Functions like `updateFavoriteButton()`, `updateTrashButton()`, `updateFilePathDisplay()`, and `markCurrentImageSeen()` all call `extractPath(state.images[state.currentIndex])` independently. Each call does URL decoding and string manipulation. While individually cheap, this happens on **every single scroll** (via `updateUI()`).

**Recommendation:** Compute and cache the extracted path once in `_onSlideActivated()` and pass it to all consumers.

### 4.4 `console.log` Calls Throughout Production Code

**Files:** Widespread across `app.js`, `viewport.js`

There are dozens of `console.log()` calls in hot paths (preloading, slide loading, video events). On mobile devices, console logging has measurable overhead because the browser serializes log arguments even when DevTools is closed.

**Recommendation:** Either strip logs in a build step, or wrap them in a `DEBUG` flag: `if (DEBUG) console.log(...)`.

### 4.5 Event Listener Accumulation on Modal Re-renders

**File:** `static/js/app.js:2373-2391` (renderSettingsFolderList), `2816-2893` (renderFoldersModalList)

Every time these functions run, they set `innerHTML` and then attach new event listeners to the rendered elements. The old listeners are GC'd when the elements are removed, so there's no actual leak — but the pattern of rebuilding large HTML strings via template literals for every modal open is wasteful.

**Recommendation:** Minor concern. No action needed unless modals become complex enough to justify a template library.

---

## 5. Minor Issues & Polish

### 5.1 CSS `backdrop-filter: blur()` on Feedback Elements

**File:** `static/style.css:216-223`

`backdrop-filter: blur(10px)` on `.trash-icon-feedback` triggers a compositing layer and real-time blur computation on every frame it's visible. On older phones, this causes frame drops during animations.

**Recommendation:** Use a solid semi-transparent background instead, or limit `backdrop-filter` to devices that handle it well (via `@supports` with a performance-conscious default).

### 5.2 No `will-change` Hints for Scroll Container

**File:** `static/style.css:30-40`

The scroll container and slides don't use `will-change: transform` or `contain: layout style paint`. Adding CSS containment tells the browser each slide is an isolated rendering context, enabling optimizations.

**Recommendation:** Add `contain: layout style paint` to `.image-slide` and `will-change: scroll-position` to `.scroll-container`.

### 5.3 61 KB CSS File Loaded in Full

**File:** `static/style.css`

The CSS file is 61 KB, which includes styles for all modals, settings, profile picker, login page, etc. — most of which isn't needed for the initial feed view. On slow networks (edge device over WiFi), this blocks rendering.

**Recommendation:** Minor for a single-page app. If desired, split into critical (above-the-fold) CSS inlined in `<head>` and deferred modal/settings CSS loaded async. But this is a marginal gain.

### 5.4 `index.html` at 40 KB

**File:** `static/index.html`

The HTML file is 40 KB because it contains all modal markup, inline SVGs, and settings UI in a single file. This is all transferred on initial load.

**Recommendation:** Minor. Consider lazy-loading modal HTML on first open via `fetch()` and injection. But again, with gzip, 40 KB HTML compresses to ~8 KB — not a critical issue.

---

## 6. What's Already Done Well

Credit where due — several performance patterns in this codebase are well-implemented:

1. **HTTP ETag caching with 304 responses** (`images.py:365-387`) — eliminates redundant image transfers
2. **HTTP Range request support for video** (`images.py:326-363`) — enables efficient video streaming
3. **IntersectionObserver for lazy loading** (`viewport.js:179-226`) — correct modern approach
4. **Request cancellation for off-screen media** (`viewport.js:304-387`) — aggressively frees bandwidth
5. **Web Audio API for sound** (`viewport.js:389-464`) — eliminates duplicate HTTP requests vs. `<audio>` element
6. **Seen batch buffering with sendBeacon** (`app.js:489-556`) — smart batching with reliable unload flush
7. **Multi-layer config caching** (`data.py:28-33`, `profiles.py:30-35`) — TTL cache + per-request `flask.g` cache
8. **Gzip compression** (`__init__.py:75-77`) — correctly configured for API responses
9. **`requestIdleCallback`** for deferred slide creation — correct priority scheduling
10. **`modulepreload`** hints in `index.html` — eliminates JS module waterfall
11. **Scroll generation counter** (`viewport.js:42`) — correctly cancels stale preload chains
12. **Image decode: async** (`app.js:883`) — offloads decode to compositor thread
13. **Video play/pause first-frame trick** (`app.js:1100-1116`) — eliminates black flash on scroll

---

## 7. Technology Stack Assessment

### Should you rewrite in Rust / TypeScript / Tailwind?

**Short answer: No.**

**Longer answer:**

| Proposed Change | What It Would Help | What It Wouldn't Help | Risk |
|---|---|---|---|
| **Rust backend** | CPU-bound thumbnail generation, memory efficiency | I/O-bound image scanning, EXIF parsing (still hits disk same way), JSON file storage bottleneck | Massive rewrite, loss of Pillow ecosystem, long development cycle |
| **TypeScript frontend** | Catch type errors during development, better refactoring | DOM performance, rendering speed, network requests (all identical at runtime) | Rewrite cost, adds build step, no runtime perf benefit |
| **Tailwind CSS** | Developer ergonomics, consistent design tokens | CSS rendering performance (browser renders both approaches identically), file size (Tailwind often larger) | Learning curve, adds build step, purely cosmetic change |

The performance issues in this app are **architectural** (full-list payloads, synchronous scanning, flat-file storage, unbounded DOM), not **language-level**. Python with proper pagination and SQLite will outperform Rust with full-list scanning and JSON files.

The single exception where Rust would help: if thumbnail generation CPU load becomes a bottleneck. But that's solvable with `pillow-simd` or pre-generation, not a full rewrite.

**Verdict:** Keep Python/Flask + Vanilla JS. Add the architectural fixes below. The current stack is actually well-suited: Flask is lightweight for edge devices, Vanilla JS has zero framework overhead, and the no-build-step simplicity is a feature for self-hosted software.

---

## 8. The Magic Wand List

If I could change anything, in priority order:

### Wand #1: Server-Side Pagination for `/api/images`
Change the API to `?offset=0&limit=50`. Client fetches in windows. This eliminates the multi-second initial load, the multi-megabyte JSON payload, and the 10,000-element client array. **This one change fixes problems 1.1, 2.2, and much of 2.1.**

### Wand #2: SQLite for Data Storage
Replace `favorites.json`, `trash.json`, `seen.json`, and `config.json` with a single `homefeed.db`. This eliminates file-lock contention, read-modify-write cycles, and the `cleanup_*` existence checks. It also makes the unseen query instant (`SELECT ... WHERE path NOT IN seen`).

### Wand #3: Persistent EXIF Date Cache
Cache computed effective dates in SQLite (or a simple JSON file) keyed by `path:mtime:size`. After the first scan, subsequent cache misses only scan new/changed files. A 10,000-image rescan goes from 30s to <1s.

### Wand #4: Windowed Slide Pool on the Client
Cap the DOM at 30-50 slides. Recycle elements as user scrolls. No `requestIdleCallback` needed for 10,000 deferred creations. Memory stays flat. `IntersectionObserver` stays fast.

### Wand #5: Nginx/Caddy Reverse Proxy for Static Files
Put a lightweight reverse proxy in front of gunicorn. Let it handle image/video serving with zero-copy `sendfile()`, native range requests, and kernel-level connection handling. Python only handles API routes. This is standard deployment practice and would free significant CPU on the edge device.

---

## 9. Recommended Prioritization

### Phase 1 — Highest Impact, Lowest Risk
These can be done incrementally without breaking existing behavior:

| # | Change | Impact | Effort | Files |
|---|--------|--------|--------|-------|
| 1 | Persistent EXIF date cache | Eliminates 30s+ cache-miss scans | Low | `image_cache.py` |
| 2 | Folder-indexed image dict | O(1) folder lookups | Low | `image_cache.py` |
| 3 | Hoist `format_image_url` settings lookup | Minor per-request speedup | Low | `images.py`, `path_utils.py` |
| 4 | `console.log` debug guard | Removes mobile overhead | Low | All JS files |
| 5 | CSS `contain: layout style paint` on slides | GPU compositing hint | Low | `style.css` |

### Phase 2 — High Impact, Moderate Effort
These require coordinated frontend + backend changes:

| # | Change | Impact | Effort | Files |
|---|--------|--------|--------|-------|
| 6 | Server-side pagination (`/api/images?offset=&limit=`) | Transforms scalability | Medium | `images.py`, `image_cache.py`, `app.js`, `state.js` |
| 7 | Windowed slide pool (30-50 DOM elements) | Fixes mobile memory/jank | Medium | `app.js`, `viewport.js` |
| 8 | GIF freeze cache LRU eviction | Prevents memory bloat | Low-Med | `gif.js` |
| 9 | Background thumbnail pre-generation CLI | Eliminates on-request Pillow CPU | Medium | `optimizations.py`, `server.py` |

### Phase 3 — Foundational Improvement
These are larger investments with long-term payoff:

| # | Change | Impact | Effort | Files |
|---|--------|--------|--------|-------|
| 10 | Migrate to SQLite | Eliminates all JSON I/O bottlenecks | High | `data.py`, all route files |
| 11 | Nginx/Caddy reverse proxy | Offloads all static serving from Python | Medium | Deployment config (not code) |
| 12 | Move cleanup to background/startup task | Removes per-request existence checks | Low-Med | `favorites.py`, `trash.py`, `data.py` |

---

## Final Notes

This is a solid application. The core UX idea (TikTok-style local photo browsing) is compelling, and the implementation quality is above average for a self-hosted project. The performance issues identified here are the natural consequence of a codebase that was designed for hundreds of images now needing to serve tens of thousands — which is a sign of success, not failure.

The most important takeaway: **paginate the API and cap the DOM**. Everything else is optimization. Those two changes would let this app comfortably handle 100,000+ images on a Raspberry Pi.
