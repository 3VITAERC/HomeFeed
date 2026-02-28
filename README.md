![HomeFeed Banner](assets/2000x200.png)

# HomeFeed

**Scroll your life, not someone else's.**

A TikTok-style vertical scrolling image viewer for your local photos. Scroll through images, GIFs, m4vs, and MP4s with smooth snap scrolling. Quickly delete or like photos for easy pruning unwanted photos or reminising on old memories.


## Features

- **TikTok-style scrolling** - Full-screen images that snap into place
- **Mobile-optimized** - Designed for mobile with an option to Fill Screen for immersive viewing
- **Cross-platform** - Works on both macOS, Windows, and Linux
- **Folder management** - Easy web interface to add/remove folders
- **Shuffle mode** - Randomize photo order each session for a fresh experience
- **Jump to photo** - Quickly navigate to any photo by number
- **Favorites** - Double-tap to favorite, filter to view only favorites
- **Trash/Mark for Deletion** - Mark photos for deletion via menu, review and batch delete
- **Comments** - Annotate any photo with personal notes; Reddit-style sidecar text files also shown when present
- **New Feed (Watch History)** - Dedicated "New" tab shows only photos you haven't scrolled past yet; tracks progress in Settings
- **Performance optimized** - HTTP caching, image list caching, and video posters.
- **Auto-Advance Mode** - Auto-scroll when video ends or after a configurable delay for photos
- **Pull-to-Refresh** - Drag down on the top nav bar to refresh without losing your place (perfect for PWA/home-screen users)
- **Optional Authentication** - Password protection for exposing the app remotely
- **User Profiles** - Netflix-style profile picker so multiple people can each have their own favorites, watch history, and folder selection



## Quick Start

### 1. Install Dependencies

```bash
pip install -r requirements.txt
```

### 2. Start the Server

**For development (simple):**
```bash
python server.py
```

**Change the port (if 7123 is in use):**
```bash
# Using command line argument
python server.py --port 9000

# Or using environment variable
PORT=9000 python server.py
```

**Recommended for production:**

*macOS/Linux:*
```bash
gunicorn -w 4 -b 0.0.0.0:7123 server:app
```

*Windows:*
```bash
waitress-serve --host=0.0.0.0 --port=7123 server:app
```

You'll see output like:
```
==================================================
  HomeFeed
  TikTok-style image viewer
==================================================

  Access on this machine:    http://localhost:7123
  Access remotely:    http://192.168.1.xxx:7123

  For better performance with many images, use gunicorn:
    gunicorn -w 4 -b 0.0.0.0:7123 server:app

  Press Ctrl+C to stop the server
==================================================
```

> **Note:** Configuration files (`config.json`, `favorites.json`, `trash.json`, `seen.json`, `comments.json`) are created automatically on first launch and are gitignored.

### 3. Add Your Folders

1. Open the URL shown in your browser
2. Enter folder paths like:
   - `/Users/Pictures/July Pictures`
   - `~/Pictures/August`
   - `/Users/Desktop/Photos`
3. Click "Add" to add each folder

### 4. Start Scrolling!

Click "View Images" and scroll through your photos TikTok-style!

## User Profiles (Optional)

HomeFeed includes a Netflix-style profile system so multiple people can share one server while keeping their own favorites, watch history, and folder selection completely separate.

### Enabling Profiles

Profiles are **enabled by default** once you create at least one profile. To create profiles:

1. Open the app and go to `/profiles`
2. Click **Add Profile**, enter a name and choose an emoji
3. Optionally set a password for that profile
4. To create an **Admin** profile, select the Admin role and enter the server admin password (see below)

Once at least one profile exists the app redirects all visitors to the profile picker before letting them in.

To turn the feature off entirely, log in as an admin and go to **Settings → Profiles → Enable Profiles** toggle. This returns the app to single-user mode.

### Roles & Permissions

| Role | Capabilities |
|------|-------------|
| **Admin** | Create/edit/delete profiles, manage global folder list, assign folders to user profiles, see all folders, change app settings |
| **User** | Create their own user account (self-serve), edit their own name/emoji, add folders to their own account, manage their own favorites and watch history |

**What users CANNOT do:**
- Change their own password (admin must do this)
- Change their own role
- Edit other profiles
- Change global settings (shuffle, optimizations, profiles toggle)
- Clear the cache

### Server Admin Password (`HOMEFEED_ADMIN_PASSWORD`)

This environment variable serves two purposes:

1. **Gates admin profile creation** — anyone creating an admin-role profile must enter this password
2. **Master login key** — can unlock any admin-role profile on the picker (useful if you forget a profile password)

```bash
HOMEFEED_ADMIN_PASSWORD=secret python server.py

# Production example
HOMEFEED_ADMIN_PASSWORD=secret gunicorn -w 4 -b 0.0.0.0:7123 server:app
```

> **Note:** `HOMEFEED_ADMIN_PASSWORD` is separate from `HOMEFEED_PASSWORD` (the global app password). You can use both together: `HOMEFEED_PASSWORD` locks the whole app behind a single login; `HOMEFEED_ADMIN_PASSWORD` controls who can become an admin.

### Per-Profile Data

Each profile gets its own isolated data:

| Data | Storage |
|------|---------|
| Favorites | `profiles/<id>/favorites.json` |
| Watch history (seen) | `profiles/<id>/seen.json` |
| Folder selection | `profiles/<id>/config.json` |

Admin profiles always see the **global** folder list (the one configured in Settings). User profiles only see the folders an admin has assigned to them.

Global data (`profiles.json`, `profiles/`) is gitignored and created automatically.

### Profile API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/profiles` | GET | Profile picker page |
| `/api/profiles` | GET | List all profiles (public info) |
| `/api/profiles` | POST | Create a profile (user = self-serve; admin = requires `admin_password`) |
| `/api/profiles/<id>` | PUT | Update a profile (users: own name/emoji only; admins: everything) |
| `/api/profiles/<id>` | DELETE | Delete a profile (admin only) |
| `/api/profiles/login` | POST | Select a profile / verify password |
| `/api/profiles/logout` | POST | Return to profile picker |
| `/api/profiles/me` | GET | Info about the currently selected profile |
| `/api/profiles/<id>/folders` | GET/PUT | Get/set folders for a user profile (admin only) |

---

## Authentication (Optional)

HomeFeed supports optional password protection. This is useful when exposing the app remotely (e.g., through Cloudflare Tunnel, ngrok, etc.).

### Enable Authentication

Set the `HOMEFEED_PASSWORD` environment variable:

```bash
# One-time run
HOMEFEED_PASSWORD=yourpassword python server.py

# Or export for persistence
export HOMEFEED_PASSWORD=yourpassword
python server.py

# Production with gunicorn
HOMEFEED_PASSWORD=yourpassword gunicorn -w 4 -b 0.0.0.0:7123 server:app
```

### How It Works

- **Without password set:** No authentication required (default behavior)
- **With password set:** All routes require login
- **Session-based:** Login persists until browser closes
- **CSRF protected:** Login form includes CSRF token

### Auth Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/login` | GET | Login page |
| `/login` | POST | Submit password (JSON or form) |
| `/logout` | POST | Log out current session |
| `/api/auth/status` | GET | Check auth status |

### Example: Login via API

```bash
# Get CSRF token
curl -c cookies.txt http://localhost:7123/api/auth/csrf

# Login (use the csrf_token from previous response)
curl -b cookies.txt -c cookies.txt -X POST http://localhost:7123/login \
  -H "Content-Type: application/json" \
  -d '{"password":"yourpassword","csrf_token":"TOKEN_HERE"}'
```

> **Tip:** Use Cloudflare Access or similar for primary authentication, and HomeFeed's password as a secondary layer.

## Usage from iPhone

1. Make sure your modible device is on the same WiFi network as your server.
2. Open the browser on your phone.
3. Go to the URL shown when you started the server (e.g., `http://192.168.1.xxx:7123`)
4. Add folders and start scrolling!

## Navigation

- **Swipe up/down** - Scroll to next/previous image
- **Double-tap** - Add to favorites (TikTok-style heart animation; only adds, doesn't remove)
- **Single tap (videos)** - Mute/unmute video
- **Heart icon** - Toggle favorite for current image (can unlike)
- **Trash icon** - Toggle mark for deletion
- **Comment icon** - Open comments panel to annotate the current photo
- **Bookmark icon** - Filter to show only favorites
- **"New" tab** - Switch to the New feed showing only photos you haven't seen yet
- **Shuffle icon** - Toggle shuffle mode
- **Settings gear** - Go to folder management, trash review, and watch history stats
- **Hamburger Menu** - Sort images or jump to a specific image number
- **Search Icon** - Show all folders and search directly through them
- **Tap folder name** - Filter to show only images from that folder

## New Feed (Watch History)

The **New** feed automatically tracks which photos you've scrolled past and shows only the ones you haven't reviewed yet.

- **Automatic tracking** — Every time a photo becomes the active slide, it's marked as seen
- **Also tracks** — Favoriting or trashing a photo immediately marks it as seen
- **Persistent** — Seen history survives page reloads and browser restarts (stored in `seen.json`)
- **Stats** — Open Settings → Library tab to see: how many photos you've seen, how many are new, total scrolls, and progress percentage
- **Reset** — Tap "Reset Watch History" in Settings to clear all records and start fresh
- **Empty state** — When you've seen everything, the New feed shows a "You're All Caught Up!" screen

## Comments & Annotations

Tap the **comment icon** on any photo to open the comments panel.

- **Personal notes** — Write freeform notes on any photo. Notes are stored in `comments.json` (gitignored, never leaves your machine).
- **Multi-line input** — Press **Shift+Enter** to add newlines; **Enter** alone sends.
- **Edit & delete** — Tap the pencil or trash icon on any comment you wrote.
- **Profile attribution** — If profiles are enabled, comments are tagged with the author's name/emoji.
- **Reddit sidecar** — If a `.txt` file with the same name as the photo exists alongside it (common with reddit-saved content), its text is displayed as a read-only "source" comment. Admins can also edit the sidecar text in place.
- **Count badge** — A red badge on the comment icon shows how many personal notes exist for the current photo.
- **Swipe to close** — On mobile, swipe the panel downward from the handle to dismiss it.

## Keyboard Shortcuts

For desktop users, the following keyboard shortcuts are available:

| Key | Action |
|-----|--------|
| **H** or **Left Arrow** | Mark for deletion (toggle) |
| **J** or **Down Arrow** | Scroll down one image |
| **K** or **Up Arrow** | Scroll up one image |
| **L** or **Right Arrow** | Like image (toggle favorite) |
| **F** | Toggle favorites view |
| **D** | Toggle trash/deletion folder view |
| **M** | Mute/Unmute video |
| **I** | Toggle Info modal |
| **S** | Toggle Settings modal |
| **?** | Toggle keyboard shortcuts help |
| **Escape** | Close any open modal |

Press **?** at any time to see the keyboard shortcuts popup.

## Folder Browser

Tap the **Folders** button at the top of the screen to quickly jump between your photo folders.

**How it works:**
- The folder list is **automatically populated** from your indexed directories
- It shows all **leaf folders** (folders that actually contain images), not just the root folders you added in settings
- For example, if you added `/Users/name/Pictures` in settings, you'll see individual folders like `Summer 2024`, `Family/July`, `Vacation` etc.
- Each folder shows its image count
- Use the **search box** to quickly filter folders by name or path
- Tap any folder to filter your view to just that folder's images
- The currently active folder is highlighted in gold

This makes it easy to navigate large photo libraries without manually digging through folder structures!

## Display Options

In Settings, you can toggle:

- **Shuffle Photos** - When enabled, photos are randomized each time you load the page. Perfect for discovering forgotten photos! Each page refresh gives you a new random order.

## Supported Image & Video Formats

- **Images:** JPG / JPEG, PNG, GIF, WebP, HEIC
- **Videos:** m4v (under 75mb)

### Video Loading

Videos are optimized for smooth scrolling with several techniques:

- **First-frame rendering:** The next video in queue (+1 slide) pre-renders its first frame, eliminating black flash when scrolling
- **Audio preloading:** Audio for the next video is pre-buffered, ensuring instant sound when you scroll
- **Poster frames:** When enabled, videos show a blurred preview first, then crossfade to the playing video
- **HTTP Range requests:** Videos stream efficiently — only ~1-2MB is buffered ahead, saving bandwidth

## Cross-Platform Support

HomeFeed works on both **macOS** and **Windows**. The application handles platform-specific path separators automatically:

- **macOS/Linux:** Uses forward slashes (`/Users/name/Pictures`)
- **Windows:** Uses backslashes (`C:\Users\name\Pictures`)

Path normalization is handled internally, so you can use either format when entering folder paths in the web interface.

## Performance Features

- **HTTP Caching** - Images are cached for 7 days with ETag support. Scrolling back doesn't re-download.
- **304 Responses** - Modified images only are re-fetched when they change
- **Image List Caching** - Folder scans are cached for 30 seconds to reduce disk I/O
- **Production Server** - Use gunicorn (macOS/Linux) or waitress (Windows) for concurrent request handling

### Performance Cache (Optional)

For even faster loading, enable optional cache optimizations in **Settings → Performance Cache**:

| Feature | Description | Benefit |
|---------|-------------|--------|
| **Image Thumbnails** | Resizes images to 1920px max, converts to WebP | 50-80% smaller files |
| **Video Posters** | Extracts first frame as preview image | Instant preview while video loads |
| **Preload Distance** | Number of slides to preload ahead (0-10) | Set to 0 to minimize data usage on slow connections |

> **Requires ffmpeg** - Install separately:
> - macOS: `brew install ffmpeg`
> - Ubuntu: `sudo apt install ffmpeg`
> - Windows: Download from [ffmpeg.org](https://ffmpeg.org/download.html)

The `.thumbnails/` cache folder is automatically created when needed and stored in your project directory (gitignored).

Tested on photo libraries up to 10,000.

## Project Structure

```
HomeFeed/
├── server.py              # Entry point - creates Flask app
├── requirements.txt       # Python dependencies (flask, gunicorn)
├── config.json            # Saved folder paths (gitignored, auto-generated)
├── favorites.json         # Saved favorites (gitignored, auto-generated)
├── trash.json             # Saved trash marks (gitignored, auto-generated)
├── comments.json          # Photo comments/notes (gitignored, auto-generated)
├── profiles.json          # Profile list (gitignored, auto-generated)
├── profiles/              # Per-profile data directories (gitignored, auto-generated)
│   └── <profile-id>/      # One directory per profile
│       ├── config.json    # Profile's folder selection
│       ├── favorites.json # Profile's favorites
│       └── seen.json      # Profile's watch history
├── .flask_session/        # Session storage (gitignored, auto-generated)
├── app/                   # Backend application package
│   ├── __init__.py        # Flask app factory
│   ├── config.py          # Configuration constants
│   ├── routes/            # API route blueprints
│   │   ├── images.py      # Image serving endpoints
│   │   ├── folders.py     # Folder management
│   │   ├── favorites.py   # Favorites API
│   │   ├── trash.py       # Trash/mark-for-deletion API
│   │   ├── comments.py    # Comments & sidecar API
│   │   ├── cache.py       # Cache settings API
│   │   ├── auth.py        # Authentication endpoints
│   │   ├── profiles.py    # Profile picker + CRUD API
│   │   └── pages.py       # HTML page routes
│   └── services/          # Business logic services
│       ├── data.py        # JSON data management (incl. comments)
│       ├── path_utils.py  # Path validation utilities
│       ├── image_cache.py # Image list caching
│       ├── auth.py        # Authentication service
│       ├── profiles.py    # Profile management service
│       └── optimizations.py # Thumbnail/WebM conversion
└── static/                # Frontend assets
    ├── index.html         # Main HTML structure
    ├── login.html         # Login page
    ├── style.css          # TikTok-style CSS
    └── js/                # ES6 JavaScript modules
        ├── app.js         # Main application entry
        ├── state.js       # Centralized state management
        ├── api.js         # API client
        ├── comments.js    # Comments panel UI & logic
        └── utils/         # Utility modules
            ├── path.js    # Path utilities
            ├── gif.js     # GIF handling
            └── video.js   # Video controls
```

## Troubleshooting

### Can't access from Phone?
- Make sure both devices are on the same WiFi network
- Check if your computer's firewall is blocking port 7123
- Try the IP address shown when starting the server

### Images not loading?
- Make sure the folder path is correct
- Check that images are in supported formats
- Look at the server console for error messages

### GIFs loading slowly?
- GIFs are large files. Once loaded, they're cached for 7 days
- Use gunicorn for better concurrent handling
- Consider the first load as "warming up" the cache

### HEIC images not showing?
- HEIC is supported but may not display in all browsers (try safari)
- For best compatibility, convert HEIC to JPG first

### Windows: `ModuleNotFoundError` or import conflicts?

If you see errors like `No module named 'app'` or conflicts with other Python packages (ComfyUI, etc.), your system Python path may be polluted by other applications.

**Solution: Create an isolated virtual environment**

```powershell
# Use 'py' launcher instead of 'python' to avoid embedded Python issues
py -m venv venv

# Activate the virtual environment
.\venv\Scripts\activate

# Install dependencies fresh
pip install -r requirements.txt

# Run the server
waitress-serve --host=0.0.0.0 --port=7123 server:app
```

> **Note:** Run `.\venv\Scripts\activate` each time you open a new terminal. You'll see `(venv)` in your prompt when active.

**Why this happens:** Some applications (like ComfyUI portable) add their embedded Python to your system PATH, which can cause import conflicts. The `py` launcher uses the official Windows Python installation instead.

## License

MIT License - feel free to use and modify