# Scroll & Load Events: A Dummies Guide

How LocalFeed loads images and plays videos — what happens, in what order, and critically, how it *stops* loading things you've already scrolled past.

---

## The Big Picture

LocalFeed works like a stack of full-screen cards. You only ever see one at a time. Under the hood:

- Only the slide shells (`<div>` with `data-src`) ever exist in the DOM for all images
- Images/videos (the `<img>`/`<video>` elements inside those shells) only load when close to view
- When a slide is scrolled past, any **in-flight HTTP requests are actively aborted**
- The `viewport.js` module watches which card is on screen and controls all media + request lifecycle

---

## On Page Load

```
Browser opens page
        │
        ▼
  init() runs
        │
        ├── initDOMElements()        find all the HTML buttons/containers
        ├── setupEventListeners()    start listening for taps/clicks
        ├── initViewport()           create the IntersectionObserver
        │     └── attach "needsLoad" listener to scroll container
        └── loadInitialData()
              ├── GET /api/settings  → load thumbnail/poster/fill toggles
              ├── GET /api/images    → get list of all image/video URLs
              ├── GET /api/favorites → know which hearts are filled
              └── GET /api/trash     → know which are marked for deletion
                        │
                        ▼
               buildSlides(startIndex=0)
                        │
                        ├── Create slides 0–10 immediately (synchronously)
                        │     Each slide is just an empty <div> with data-src
                        │     No images or videos yet — just placeholders
                        │
                        └── Schedule slides 11–end during browser idle time
                              (requestIdleCallback — doesn't block scrolling)
                                        │
                                        ▼
                             prioritizeFirstImage(0)
                                        │
                                        └── loadImageForSlide(slide 0, isPriority=true)
                                              └── Video: create <video preload='auto'>
                                                  Image: create <img loading='eager'>
```

---

## The IntersectionObserver (What Watches the Screen)

There is **one** observer (in `viewport.js`). It watches every slide and fires whenever a slide enters or leaves the viewport.

```
┌─────────────────────────────────────────────────┐
│              SCROLL CONTAINER                    │
│  ┌───────────────────────────────────────────┐  │
│  │   Slide 3 — partially visible (20%)        │  │← observer fires: 20% visible
│  │   [image]                                  │  │  → dispatch 'needsLoad' if empty
│  └───────────────────────────────────────────┘  │
│  ┌───────────────────────────────────────────┐  │
│  │   Slide 4 — CURRENT SLIDE (100% visible)   │  │← observer fires: 100% visible
│  │   [image/video]                            │  │  → this is the active slide
│  └───────────────────────────────────────────┘  │
│  ┌───────────────────────────────────────────┐  │
│  │   Slide 5 — partially visible (15%)        │  │← observer fires: 15% visible
│  │   [image]                                  │  │  → dispatch 'needsLoad' if empty
│  └───────────────────────────────────────────┘  │
└─────────────────────────────────────────────────┘
           ↑ rootMargin: 100px above and below
           ↑ observer fires 100px BEFORE slides enter view
```

**Observer thresholds:** `[0, 0.5]`
- Fires at **0%** — slide just touched the edge of the visible area (entering OR leaving)
- Fires at **50%** — slide is more than halfway visible (this means it's the "current" slide)

---

## On Each Scroll (The Full Sequence)

Let's say you swipe from slide 4 to slide 5.

```
User swipes up
      │
      ▼
CSS scroll-snap kicks in
      │
      └── browser snaps to slide 5
                  │
                  ▼
    IntersectionObserver fires (batch)
                  │
       ┌──────────┴──────────┐
       │                     │
  Slide 4 leaving        Slide 5 entering
  (ratio drops to 0)     (ratio rises to 0.5+)
       │                     │
       ▼                     ▼
  _deactivateMedia()     _setActiveSlide(5)
       │                     │
  video.pause()         ┌────┴────────────────────┐
  [abort if loading]    │                         │
  (see Unloading)  state.currentIndex = 5    _activateMedia(slide 5)
                         _scrollGeneration++       │
                         │                    video.play()   ← always muted
                    _onActiveChange(5)         [if audio on: swap audio src]
                         │
                ┌────────┴──────────────┐
                │                       │
           updateUI()            sequentialPreload(5, gen)
                │                       │
           update counter          load slide 6 ahead  ← only if preloadCount > 0
           update ♥ button         (gen check kills
           update 🗑 button          stale old chains)
           update filename display
```

**Key: `_scrollGeneration` increments on every slide change.** `sequentialPreload` captures the generation at call-time and aborts each `setTimeout` step if the generation has advanced. This prevents old chains from previous slides from loading content you've already scrolled past.

---

## Lazy Loading (How Images Actually Load)

Slides are created as **empty shells** first. The actual images load separately.

```
┌──────────────────────────────────────────────────────────┐
│ SLIDE SHELL (empty)                                       │
│ <div class="image-slide" data-src="/image?path=..."      │
│              data-index="7">                             │
│   (no <img> or <video> yet)                              │
└──────────────────────────────────────────────────────────┘
                       │
                       │  IntersectionObserver fires when
                       │  this shell enters viewport
                       │  (with distance guard — see below)
                       ▼
            slide.dispatchEvent('needsLoad')
                       │
                       ▼
          scrollContainer 'needsLoad' listener
                       │
                       │  Guard: |slideIndex - state.currentIndex| > IMAGE_POOL_BUFFER?
                       │  If yes → skip (slide is too far from current position)
                       │
                       ▼
           loadImageForSlide(slide)
                       │
                       │  Guard: same distance check inside loadImageForSlide
                       │  (second line of defence; bypassed for isPriorityImage)
                       │
          ┌────────────┼────────────┐
          │            │            │
       is .gif?    is video?   is image?
          │            │            │
          ▼            ▼            ▼
      loadGif()   loadVideo()  loadImage()
      (treated     creates      creates
      as image)    <video>      <img>
                     │
              appended to slide
                     │
              onloadeddata fires
                     │
          activateMediaIfCurrent(slide)
                     │
          "is this slide currently active?"
                   /   \
                 YES    NO
                  │      │
            _activateMedia  (nothing — video stays
            video.play()     paused until scrolled to)
```

### The `needsLoad` Distance Guard

The IntersectionObserver uses `rootMargin: '100px 0px'`, which fires 100px BEFORE a slide enters the visible area. When the user fast-scrolls through multiple slides, each briefly passes through this zone and fires `needsLoad`. Without a guard, all those slides would start loading simultaneously.

The guard: if `Math.abs(slideIndex - state.currentIndex) > IMAGE_POOL_BUFFER (5)`, skip the load. This prevents loading content for slides the user has already zoomed past.

---

## Priority Loading vs Lazy Loading

Not all slides load the same way:

| When | How | `preload` attribute | Purpose |
|------|-----|---------------------|---------|
| First visible slide | `isPriority = true` | `'auto'` | Instant first frame |
| +1 slide ahead (preload) | `sequentialPreload()` with `isNextSlide=true` | `'auto'` | Pre-buffer first frame (no black flash) |
| Other preload slides | `sequentialPreload()` | `'metadata'` | Minimal data until activated |
| Observer-triggered | `needsLoad` event | `'metadata'` | Just-in-time loading |

**Why only `+1` gets `preload='auto'`:**
The play/pause trick (see below) requires `preload='auto'` to force the browser to decode the first video frame. Loading `'auto'` on every adjacent video would bombard the network. Only the immediate next slide gets this treatment.

**Important:** Even `preload='metadata'` makes an HTTP request. For MP4s without fast-start (moov atom at the start), the browser may make multiple range requests to seek to the moov atom. This is why we also abort `preload='metadata'` loads on deactivation.

---

## Request Cancellation (Unloading)

This is the mechanism that prevents bandwidth waste when scrolling quickly.

### What triggers unloading

`_deactivateMedia(slide)` is called whenever a slide leaves the viewport (IntersectionObserver fires with `intersectionRatio = 0`). It also fires from `_setActiveSlide()` for the slide that just lost focus.

### Why `preload = 'none'` is NOT enough

Setting `video.preload = 'none'` on an already-loading video is **just a hint**. It does NOT cancel an in-flight HTTP range request in Chrome or Safari. The network request continues.

To actually cancel: `video.removeAttribute('src')` then `video.load()`. The `load()` call resets the media element and forces the browser to cancel the pending connection.

### What `_deactivateMedia` now does

```
Slide leaves viewport
        │
        ▼
_deactivateMedia(slide)
        │
   [is video?]
        │
   video.pause()
   audio cleanup (if was active)
        │
   video.networkState === NETWORK_LOADING?
        │
   ┌────┴────────────────────────────────┐
   │  YES — still downloading           │  NO — already idle/loaded
   │                                     │
   ▼                                     ▼
_clearSlideContent(slide)           video.preload = 'none'
   │                                (keep element, stop future buffering)
   ├── For each child element:
   │     video → pause(); removeAttribute('src'); load()
   │     img   → src = ''
   │     then  → child.remove()
   │
   └── Slide is now an empty shell again
         ↑ needsLoad will re-trigger if user scrolls back
```

**For images:** If `!img.complete` (still downloading), `_clearSlideContent` is called → aborts the download.

**For already-loaded content:** If `networkState !== NETWORK_LOADING` (idle/complete), the element is left in place. Loaded content is preserved for smooth backward scrolling.

### Play/Pause Trick and Buffering

The `+1` slide uses a play/pause trick to pre-render the first video frame:

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

Calling `video.play()` causes Chrome to buffer aggressively beyond just metadata. When `_deactivateMedia` fires for this slide (if user scrolls backward), `networkState === NETWORK_LOADING` triggers `_clearSlideContent` which cancels this buffering.

---

## The Scroll Generation Counter (Preventing Stale Preload Chains)

`sequentialPreload` uses recursive `setTimeout(150ms)` calls to stagger preloading. When scrolling quickly (1→2→3→4 in under a second), each slide activation spawns a new preload chain — and old chains keep running.

The fix: a `_scrollGeneration` counter in `viewport.js`:

```javascript
// In viewport.js internal state:
let _scrollGeneration = 0;

// Incremented on every slide change (in _setActiveSlide):
_scrollGeneration++;

// Also incremented when slides are rebuilt (in destroyObserver):
_scrollGeneration++;  // kills any chains running during mode transitions
```

In `sequentialPreload`, the generation is captured at call time and checked at every step:

```javascript
function sequentialPreload(centerIndex, current, max, ahead = true, generation = 0) {
    // If user scrolled to a new slide since this chain started → stop
    if (generation !== getScrollGeneration()) return;
    ...
    setTimeout(() => {
        sequentialPreload(centerIndex, current + 1, max, ahead, generation);
    }, 150);
}
```

**Effect:** Scrolling 1→2→3→4 quickly leaves 4 chains. Three of them abort at their next `setTimeout` tick. Only the chain from slide 4 (matching current generation) continues.

---

## Video Streaming with HTTP Range Requests

Videos are served with **HTTP Range request support**, enabling true streaming:

```
Browser requests video
        │
        ├── Range: bytes=0-1048575     ← First 1MB only
        │
        ▼
Server responds with 206 Partial Content
        │
        ├── Content-Range: bytes 0-1048575/43698787
        ├── Content-Length: 1048576
        └── Accept-Ranges: bytes
        │
        ▼
Video starts playing immediately! 🎬
```

**Benefits:**
- **Instant playback**: Browser only needs ~1MB buffered to start
- **Efficient seeking**: Browser requests middle of file directly
- **Bandwidth savings**: On scroll-away, the `_clearSlideContent` abort cancels the range request
- **No iPhone heating**: Only one video streams at a time

**Note:** Range requests are cancelled by `video.removeAttribute('src'); video.load()` — NOT by `video.preload = 'none'`.

**Implementation in `app/routes/images.py`:**
```python
# Parse Range header
start, end = _parse_range_header(range_header, file_size)

# Read only requested chunk
with open(video_path, 'rb') as f:
    f.seek(start)
    data = f.read(end - start + 1)

# Return partial content
response.status_code = 206
response.headers['Content-Range'] = f'bytes {start}-{end}/{file_size}'
```

---

## The Audio Architecture

Videos are **always muted**. A separate `<audio>` element handles sound:

```
┌──────────────────────────────────────────────────────────┐
│ ACTIVE SLIDE (slide 5)                                    │
│                                                           │
│   <video muted=true src="/image?path=video5.mp4">        │
│   playing silently...                                    │
│                                                           │
└───────────────────────┬──────────────────────────────────┘
                        │  currentTime synced every 100ms
                        │
            ┌───────────▼──────────────┐
            │  <audio> (in memory)      │
            │  src = same video5.mp4   │
            │  playing WITH audio...   │
            │  (unlocked by user tap)  │
            └──────────────────────────┘
```

### Dual Audio Element Preloading

To eliminate audio delay when scrolling, **two** `<audio>` elements are used:

```
┌─────────────────────────────────────────────────────────────┐
│                    AUDIO PRELOADING                          │
│                                                              │
│   _audioEl ─────────────────────────────────────────────────┤
│       │                                                      │
│       ├── src: "/image?path=video3.mp4"  (CURRENT video)    │
│       └── Already buffered, plays instantly                 │
│                                                              │
│   _nextAudioEl ─────────────────────────────────────────────┤
│       │                                                      │
│       ├── src: "/image?path=video4.mp4"  (NEXT video +1)    │
│       └── Preloaded during sequentialPreload()              │
│                                                              │
│   On scroll: swap _audioEl ↔ _nextAudioEl                   │
└─────────────────────────────────────────────────────────────┘
```

**How it works:**
1. `sequentialPreload()` identifies the +1 slide
2. `preloadAudioForNextSlide()` loads audio into `_nextAudioEl`
3. Play/pause trick forces actual buffering (not just metadata)
4. On scroll, `_attachAudioToActiveVideo()` swaps elements
5. Preloaded audio plays instantly with no HTTP delay

When you scroll to slide 6:
1. `video5.pause()` — visual stops
2. **Swap `_audioEl` ↔ `_nextAudioEl`** — instant audio switch
3. `_audioEl.currentTime = video6.currentTime` — sync
4. `video6.play()` — visual starts (muted)
5. `_audioEl.play()` — audio starts (with sound, already buffered)

Audio elements are NOT in the DOM (kept in memory only). Setting `_audioEl.src` to a new URL cancels the previous audio download automatically.

---

## Memory Management

The `IMAGE_POOL_BUFFER = 5` constant defines the distance at which the `needsLoad` guard allows content to load. Slides beyond this distance from `state.currentIndex` are prevented from loading new content.

Loaded content beyond this distance is NOT actively removed by a periodic cleanup function — instead, `_deactivateMedia` + `_clearSlideContent` handles removal at the moment a slide leaves the viewport (if it's still actively downloading). Already-fully-loaded slides stay resident in DOM until `buildSlides()` is called (mode transitions), which clears all slides.

```
           [empty shell]  ← slides too far away simply never get loaded (distance guard)
           [empty shell]
           slide 3   [img loaded]  ←── still loading? cleared by _clearSlideContent on exit
           slide 4   [img loaded]
 CURRENT → slide 5   [img/video]  ←── ACTIVE
           slide 6   [img loaded]
           slide 7   [img loaded]
           slide 8   [img loaded]
           [empty shell]
           [empty shell]
```

**Important:** There is no periodic `updateImagePool()` scan. The constant `IMAGE_POOL_BUFFER` is used only for the distance guard in `needsLoad` and `loadImageForSlide`.

---

## State Variables That Control All of This

In [`state.js`](../static/js/state.js):

```javascript
state.currentIndex    // Which slide index is currently active
state.images[]        // Array of all image/video URLs in current view mode
```

In [`viewport.js`](../static/js/viewport.js) (internal, not in state):

```javascript
_activeVideo          // The <video> element currently playing
_audioEl              // Current <audio> element for sound
_nextAudioEl          // Second <audio> for +1 slide preloading
_nextAudioSrc         // Track what's loaded in _nextAudioEl
_audioEnabled         // Whether the user has enabled audio (tap to toggle)
_audioUnlocked        // Whether the audio element was created via user gesture
_hasActivatedOnce     // Guards the initial page-load activation
_scrollGeneration     // Counter: increments on every slide change; used to abort stale preload chains
```

---

## Common "Why Is This Broken?" Checklist

| Symptom | Likely cause |
|---------|-------------|
| First video doesn't play on page load | `_hasActivatedOnce` flag not working, or `prioritizeFirstImage` not firing |
| Video shows `0:00 / 0:00` and stays frozen | Video is stuck at `preload='metadata'` and never loaded data |
| Audio stops after ~5 videos | Unmuted `video.play()` was being called — autoplay policy blocked it |
| Video plays but no audio | `_audioEl` is null (audio not unlocked by user tap yet) |
| Video plays twice or audio is off-sync | Double `_activateMedia` call — check `activating` guard |
| Scrolling back shows blank slide | `_clearSlideContent` cleared the slide — normal, `needsLoad` will re-load (should be instant from cache) |
| GIF keeps animating off-screen | `gifObserver` not observing that slide, or `freezeGif` not working |
| Audio delay when scrolling to video | Audio not preloaded — check `preloadAudioForNextSlide()` is called in `sequentialPreload()` |
| Audio swap not working | URL mismatch — check `_normalizeAudioSrc()` for relative vs absolute URL comparison |
| Black flash on video scroll | First frame not rendered — play/pause trick in `onloadeddata` not firing for `isNextSlide` |
| Multiple videos downloading simultaneously | Stale `sequentialPreload` chains — check `_scrollGeneration` is incremented and passed to chains |
| Requests not cancelling on fast scroll | `_clearSlideContent` not being called — check `video.networkState === NETWORK_LOADING` condition in `_deactivateMedia` |
