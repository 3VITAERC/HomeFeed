![HomeFeed Banner](assets/2000x200.png)

# HomeFeed

**Scroll your life, not someone else's.**

A TikTok-style vertical scrolling image viewer for your local photos. Full-screen snap scrolling for images, GIFs, and videos — built for mobile, runs anywhere.

---

## Quick Links

- [Features](#features)
- [Quick Start](#quick-start)
- [iPhone + iCloud Setup](#iphone--icloud-setup-mac)
- [Folder Organization](#folder-organization)
- [Navigation](#navigation)
- [Keyboard Shortcuts](#keyboard-shortcuts)
- [Performance Cache](#performance-cache)
- [User Profiles](#user-profiles)
- [Authentication](#authentication)
- [Troubleshooting](#troubleshooting)

---

## Features

- **TikTok-style scrolling** — Full-screen images that snap into place in an endless scroll
- **Mobile-optimized** — Designed for iPhone with an option to fill the screen for immersive viewing
- **Favorites** — Double-tap to favorite, filter to view only favorites
- **Trash / Mark for Deletion** — Mark photos for deletion while browsing, then review and batch delete from disk in Settings
- **New Feed** — Dedicated tab showing only photos you haven't scrolled past yet
- **Comments** — Annotate any photo with personal notes; Sidecar `.txt` files shown automatically. Shift+Enter for newlines, swipe down to close on mobile.
- **Folder Browser** — Jump between folders; shows leaf folders with image counts and live search
- **Folder Organization** — Customize how folders are displayed with nicknames and optional grouping/collapsing
- **Shuffle Mode** — Randomize photo order each session
- **Auto-Advance** — Auto-scroll when a video ends or after a configurable delay
- **Pull-to-Refresh** — Drag the top nav to refresh without losing your place
- **User Profiles** — Netflix-style profile picker; each person gets their own favorites, history, and folders
- **Optional Auth** — Password-protect the app when exposing it remotely
- **Performance optimized** — HTTP caching, WebP thumbnails, video poster frames, HTTP range streaming

---

## Quick Start

**1. Install dependencies**
```bash
pip install -r requirements.txt
```

**2. Start the server**
```bash
python server.py
```

For production, you can use gunicorn (macOS/Linux) or waitress (Windows):
```bash
# macOS/Linux
gunicorn -w 4 -b 0.0.0.0:7123 server:app

# Windows
waitress-serve --host=0.0.0.0 --port=7123 server:app
```

To change the port: `python server.py --port 9000` or `PORT=9000 python server.py`

**3. Add your folders**

Open the URL in your browser, go to Settings, and add folder paths like `/Users/name/Pictures` or `C:\Users\name\Photos`. Then hit **View Images** and start scrolling.

> Both `/` and `\` path formats are accepted on all platforms.

> Config files (`config.json`, `favorites.json`, `trash.json`, `seen.json`, `comments.json`) are created automatically and gitignored.

---

## Folder Organization

Customize how folders appear in the Folder Browser, top navigation, and folder modal.

**Open Folder Options:** Go to **Settings → Folders**, then click the **pencil icon** next to any folder.

| Setting | Effect |
|---------|--------|
| **Nickname** | Display custom name instead of the folder path. Shows in the Folder Browser modal and top nav tabs. Limited to 30 characters. |
| **Folder Grouping** | Enable to collapse subfolders into groups. Useful for large photo libraries. |
| **Group Depth** | When grouping is on, sets how many subfolder levels to show before collapsing. `0` = show only the root folder (all subfolders collapsed into one). `1+` = show that many levels of subfolders. Range: 0–8. Default: off. |

**Examples:**

- **iPhone iCloud originals:** Add `/Users/name/Pictures/Photos Library.photoslibrary/originals`, set nickname to "iPhone", enable grouping with depth 2 (shows Year → Month). Jump to a specific month instantly.
- **Photo archive:** Add `/mnt/archive/photos`, set nickname to "Archive", grouping depth 0 (hide all subfolders, show only the archive root).
- **Family shared folder:** Add `/Volumes/Photos`, set nickname to "Family Photos", no grouping (browse each folder individually).

> **Note:** Folder settings (nickname, grouping) apply globally, not per profile. Grouping describes physical folder structure, not access control.

---

## iPhone + iCloud Setup (Mac)

If the server hosting HomeFeed is a Mac, HomeFeed can scroll your entire iPhone camera roll with no extra software or API.

**1. Enable "Download Originals" on your Mac**

Open **Photos** → **Settings** → **iCloud** → select **"Download Originals to this Mac"**.

This syncs full-resolution copies to disk. The initial sync can take a while depending on library size — watch progress at the bottom of the Photos sidebar.

**2. Add the folder to HomeFeed**

```
/Users/YOUR_NAME/Pictures/Photos Library.photoslibrary/originals
```

HomeFeed picks up all subfolders automatically. New iPhone photos appear after iCloud syncs them (usually within a minute on the same WiFi).

**Tips:**
- **Browse by date** — iCloud organizes originals into year/month/day subfolders, making it easy to jump to a specific trip
- **HEIC photos** — supported natively in Safari and Chrome 117+; enable Thumbnails in Settings to auto-convert to WebP for broader compatibility
- **Don't use "Optimize Mac Storage"** — that keeps only low-res previews on disk; you need "Download Originals"
- **Trash carefully** — HomeFeed's trash deletes files from disk. Use it as a hit-list, then do the actual deletion from the Photos app to avoid confusing iCloud

---

## Navigation

| Action | Control |
|--------|---------|
| Next / previous photo | Swipe up / down |
| Favorite (add only) | Double-tap |
| Toggle favorite | Heart icon |
| Mark for deletion | Trash icon |
| Mute / unmute video | Single tap |
| Open comments | Comment icon |
| Filter to favorites | Bookmark icon |
| Switch to New feed | "New" tab |
| Toggle shuffle | Shuffle icon |
| Browse folders | Search icon |
| Filter to one folder | Tap folder name |
| Settings | Gear icon |
| Jump to photo / sort | Hamburger menu |

---

## Keyboard Shortcuts

Press **?** at any time to see the shortcuts popup.

| Key | Action |
|-----|--------|
| `J` / `↓` | Next image |
| `K` / `↑` | Previous image |
| `L` / `→` | Toggle favorite |
| `H` / `←` | Mark for deletion |
| `F` | Toggle favorites view |
| `D` | Toggle trash view |
| `M` | Mute / unmute |
| `I` | Image info |
| `S` | Settings |
| `?` | Keyboard shortcuts |
| `Esc` | Close modal |

---

## Performance Cache

Enable optional optimizations in **Settings → Performance Cache** for faster loading, especially over WiFi on large libraries.

| Feature | What it does | Benefit |
|---------|-------------|---------|
| **Image Thumbnails** | Resizes to 1920px max, converts to WebP | 50–80% smaller files |
| **Video Posters** | Extracts first frame as preview | Instant preview while video loads |
| **Preload Distance** | Slides to preload ahead (0–10) | Set to 0 on slow connections |

**Video Posters require ffmpeg** (thumbnails use Pillow — no ffmpeg needed):
```bash
brew install ffmpeg        # macOS
sudo apt install ffmpeg    # Ubuntu
```
Windows: download from [ffmpeg.org](https://ffmpeg.org/download.html)

**Supported formats:** JPG, PNG, GIF, WebP, HEIC — Videos: MOV, M4V, MP4, WebM (under 75MB)

---

## User Profiles

Netflix-style profile picker so multiple people can share one server with separate favorites, watch history, and folder selections.

Profiles activate automatically once you create at least one. Go to `/profiles` to get started.

| Role | Can do |
|------|--------|
| **Admin** | Manage all profiles, global folders, app settings |
| **User** | Self-serve signup, edit own name/emoji, manage own favorites and history |

**`HOMEFEED_ADMIN_PASSWORD`** — required to create an admin profile; also works as a master key to unlock any admin profile.

```bash
HOMEFEED_ADMIN_PASSWORD=secret python server.py
```

> This is separate from `HOMEFEED_PASSWORD` (the global app password). Both can be used together.

To disable profiles entirely: **Settings → Profiles → Enable Profiles** toggle (admin only).

---

## Authentication

Set `HOMEFEED_PASSWORD` to password-protect the entire app — useful when exposing via Cloudflare Tunnel, ngrok, etc.

```bash
HOMEFEED_PASSWORD=yourpassword python server.py
```

- Sessions persist until the browser closes
- CSRF protected
- Without the env var set, no auth is required

> **Tip:** Use Cloudflare Access for primary auth and HomeFeed's password as a secondary layer.

---

## Troubleshooting

**Can't access from phone?**
- Confirm both devices are on the same WiFi
- Check that your firewall isn't blocking port 7123
- Use the IP address printed when the server starts

**Images not loading?**
- Double-check the folder path in Settings
- Confirm the files are in a supported format
- Check the server console for errors

**HEIC images not showing?**
- Works best in Safari; Chrome 117+ also supports it
- Enable Thumbnails in Settings to convert to WebP automatically

**GIFs loading slowly?**
- Expected on first load — they're cached for 7 days after that
- Switch to gunicorn for better concurrent handling

**Windows: `ModuleNotFoundError` or import conflicts?**

Your system Python may be polluted by another app (e.g. ComfyUI). Fix with a virtual environment:

```powershell
py -m venv venv
.\venv\Scripts\activate
pip install -r requirements.txt
waitress-serve --host=0.0.0.0 --port=7123 server:app
```

Run `.\venv\Scripts\activate` each time you open a new terminal.

---

## License

MIT — feel free to use and modify.
