"""
Image list caching service for HomeFeed.
Provides cached access to the list of images from configured folders.
"""

import os
import json
import time
import logging
from datetime import datetime
from pathlib import Path
from typing import List, Dict, Any, Optional, Tuple

logger = logging.getLogger(__name__)

from app.config import (
    CACHE_TTL,
    CACHE_TTL_HDD,
    SUPPORTED_FORMATS,
    VIDEO_FORMATS,
    MAX_VIDEO_SIZE,
    EXIF_DATE_CACHE_FILE,
)
from app.services.path_utils import expand_path, normalize_path


# Image list cache (with TTL)
_image_cache: Dict[str, Any] = {
    'images': None,
    'timestamp': 0,
    'folder_mtimes': {},   # Track folder modification times
    'date_source': None,   # Track which date_source was used, to detect setting changes
    'folder_index': {},    # Dict[folder_path, List[image_path]] for O(1) folder lookups
}

# Leaf folders cache (computed from image list)
_leaf_folders_cache: List[Dict[str, Any]] = []

# ---------------------------------------------------------------------------
# Persistent EXIF date cache
#
# Maps "path:mtime:size" -> EXIF timestamp (float) or None (no EXIF found).
# Survives server restarts, so Pillow is only called for new or changed files.
# Each gunicorn worker maintains its own in-memory copy and independently
# reads/writes the shared cache file; since the cache is purely additive, any
# write race only results in a few redundant PIL calls on the next scan — never
# incorrect data.
# ---------------------------------------------------------------------------
_exif_date_cache: Dict[str, Optional[float]] = {}
_exif_date_cache_dirty: bool = False


def _load_exif_date_cache() -> None:
    """Load the persistent EXIF date cache from disk."""
    global _exif_date_cache
    try:
        if os.path.exists(EXIF_DATE_CACHE_FILE):
            with open(EXIF_DATE_CACHE_FILE, 'r') as f:
                _exif_date_cache = json.load(f)
            logger.debug("Loaded %d EXIF date cache entries from disk", len(_exif_date_cache))
    except Exception as e:
        logger.warning("Could not load EXIF date cache (will rebuild): %s", e)
        _exif_date_cache = {}


def _save_exif_date_cache() -> None:
    """Write the EXIF date cache to disk if it has new entries."""
    global _exif_date_cache_dirty
    if not _exif_date_cache_dirty:
        return
    try:
        with open(EXIF_DATE_CACHE_FILE, 'w') as f:
            json.dump(_exif_date_cache, f)
        _exif_date_cache_dirty = False
        logger.debug("Saved EXIF date cache (%d entries)", len(_exif_date_cache))
    except Exception as e:
        logger.warning("Could not save EXIF date cache: %s", e)


def get_effective_date(
    path: str,
    date_source: str,
    file_mtime: Optional[float] = None,
    file_size: Optional[int] = None,
    file_ctime: Optional[float] = None,
) -> float:
    """Return the best available date (as a Unix timestamp) for a file.

    Hierarchy:
      1. EXIF DateTimeOriginal  (shutter time — most accurate for photos)
      2. EXIF DateTimeDigitized (digitization time — reliable for scanned photos)
      3. Filesystem fallback determined by ``date_source``:
         - ``'mtime'``: modification time first, then creation time
         - ``'ctime'``: creation time first, then modification time

    EXIF extraction requires Pillow.  If Pillow is not installed, or the file
    is a video, we silently skip to the filesystem fallback.

    When ``file_mtime`` and ``file_size`` are provided (from a prior os.stat()
    call in the scan loop), this function checks the persistent EXIF date cache
    before opening the file with Pillow.  On a cache hit the file is never
    opened at all, making subsequent scans effectively free for unchanged files.

    Args:
        path:        Absolute path to the file.
        date_source: ``'mtime'`` or ``'ctime'`` — controls filesystem fallback order.
        file_mtime:  Pre-fetched st_mtime (avoids an extra syscall).
        file_size:   Pre-fetched st_size  (used as part of the cache key).
        file_ctime:  Pre-fetched st_ctime (avoids an extra syscall for the fallback).

    Returns:
        Unix timestamp (float).  Falls back to 0 if nothing is readable.
    """
    global _exif_date_cache, _exif_date_cache_dirty

    # --- 1 & 2: try EXIF for image files ---
    suffix = Path(path).suffix.lower()
    if suffix not in VIDEO_FORMATS:
        # Build a cache key when we have the file stats (both mtime and size required)
        cache_key: Optional[str] = None
        if file_mtime is not None and file_size is not None:
            cache_key = f"{path}:{int(file_mtime)}:{file_size}"

        # Check persistent EXIF cache before touching the file with Pillow
        if cache_key is not None and cache_key in _exif_date_cache:
            cached_exif = _exif_date_cache[cache_key]
            if cached_exif is not None:
                return cached_exif
            # cached_exif is None  →  we previously confirmed this file has no EXIF date;
            # skip Pillow and fall straight through to the filesystem fallback.
        else:
            # Cache miss — open the file and extract EXIF
            exif_ts: Optional[float] = None
            try:
                from PIL import Image

                with Image.open(path) as img:
                    exif = None
                    try:
                        exif = img._getexif()
                    except (AttributeError, Exception):
                        pass

                    if exif:
                        # Prefer DateTimeOriginal (tag 36867) then DateTimeDigitized (36868)
                        for tag_id in (36867, 36868):
                            raw = exif.get(tag_id)
                            if raw:
                                try:
                                    dt = datetime.strptime(str(raw).strip(), '%Y:%m:%d %H:%M:%S')
                                    exif_ts = dt.timestamp()
                                    break
                                except (ValueError, OverflowError):
                                    pass
            except ImportError:
                pass  # Pillow not installed — fall through to filesystem dates
            except Exception:
                pass  # Corrupt file or unreadable EXIF — fall through

            # Store result in cache (None = "no EXIF date" so we don't retry PIL next scan)
            if cache_key is not None:
                _exif_date_cache[cache_key] = exif_ts
                _exif_date_cache_dirty = True

            if exif_ts is not None:
                return exif_ts

    # --- 3: filesystem fallback ---
    # Use pre-fetched stats when available (avoids extra syscalls)
    if file_mtime is not None:
        mtime = file_mtime
    else:
        try:
            mtime = os.path.getmtime(path)
        except OSError:
            mtime = 0

    if file_ctime is not None:
        ctime = file_ctime
    else:
        try:
            ctime = os.path.getctime(path)
        except OSError:
            ctime = 0

    if date_source == 'ctime':
        return ctime if ctime else mtime
    # Default: prefer mtime
    return mtime if mtime else ctime


def get_folder_mtime(folder_path: str) -> float:
    """Get the max mtime of folder and its direct subdirectories.
    
    This checks only one level deep (folder + immediate subdirectories),
    which catches changes in nested subfolders without walking the entire tree.
    For a folder with 10,000+ photos, this is significantly faster than
    a full os.walk() which was causing performance issues.
    
    Args:
        folder_path: Path to the folder
        
    Returns:
        Most recent modification time as timestamp, or 0 if folder doesn't exist
    """
    if not os.path.isdir(folder_path):
        return 0
    try:
        max_mtime = os.path.getmtime(folder_path)
        for entry in os.scandir(folder_path):
            if entry.is_dir(follow_symlinks=False):
                try:
                    max_mtime = max(max_mtime, entry.stat().st_mtime)
                except OSError:
                    pass
        return max_mtime
    except OSError:
        return 0


def _is_cache_valid_with_date_source(date_source: str) -> bool:
    """Check if the cached image list is still valid for the given date_source setting.

    Extends the standard TTL/mtime check with an additional check: if the
    ``date_source`` setting has changed since the cache was built, the cache
    is considered stale (because sort order may differ).

    Args:
        date_source: The currently active date_source setting value.

    Returns:
        True if cache is valid, False if a rescan is needed.
    """
    if _image_cache['images'] is None:
        return False

    # If date_source changed, we must re-sort
    if _image_cache.get('date_source') != date_source:
        return False

    # Check TTL
    from app.services.data import get_optimization_settings
    settings = get_optimization_settings()
    effective_ttl = CACHE_TTL_HDD if settings.get('hdd_friendly', False) else CACHE_TTL
    if time.time() - _image_cache['timestamp'] > effective_ttl:
        return False

    # Get the current active folders (profile-aware)
    from app.services.profiles import get_current_folders
    current_folders = get_current_folders()
    cached_mtimes = _image_cache.get('folder_mtimes', {})

    if set(current_folders) != set(cached_mtimes.keys()):
        return False

    # Check if any folder has been modified
    for folder in current_folders:
        expanded_path = expand_path(folder)
        current_mtime = get_folder_mtime(expanded_path)
        if current_mtime > cached_mtimes.get(folder, 0):
            return False

    return True


def invalidate_cache() -> None:
    """Invalidate the image list cache and leaf folders cache."""
    global _leaf_folders_cache
    _image_cache['images'] = None
    _image_cache['timestamp'] = 0
    _image_cache['folder_mtimes'] = {}
    _image_cache['effective_dates'] = {}
    _image_cache['date_source'] = None
    _image_cache['folder_index'] = {}
    _leaf_folders_cache = []


def get_all_images() -> List[str]:
    """Scan all configured folders and return list of image paths (with caching).

    Images are sorted using a date hierarchy:
      1. EXIF DateTimeOriginal (shutter time — most accurate)
      2. EXIF DateTimeDigitized (digitization time)
      3. Filesystem date determined by the ``date_source`` setting
         (``'mtime'`` → modification time first; ``'ctime'`` → creation time first)

    Returns:
        List of image file paths, sorted newest-first by effective date.
    """
    global _leaf_folders_cache

    # Import here to avoid circular imports
    from app.services.data import get_optimization_settings

    settings = get_optimization_settings()
    date_source = settings.get('date_source', 'mtime')

    # Check cache validity — also bust cache when date_source setting changed
    if _is_cache_valid_with_date_source(date_source):
        return _image_cache['images']

    # Cache is invalid — clear leaf folders cache too so it is rebuilt from the
    # fresh image list for the current profile.  Without this, a stale
    # _leaf_folders_cache built for a different profile could be served to users
    # who happen to match the cached folder_mtimes keys.
    _leaf_folders_cache = []

    # Get active folders (profile-aware fallback to global config)
    from app.services.profiles import get_current_folders
    active_folders = get_current_folders()

    # Cache miss or invalid - rescan
    # Each entry is (path, effective_date) — effective_date is computed once and reused
    image_entries: List[Tuple[str, float]] = []
    folder_mtimes: Dict[str, float] = {}

    for folder_path in active_folders:
        expanded_path = expand_path(folder_path)
        if os.path.isdir(expanded_path):
            # Track folder modification time
            folder_mtimes[folder_path] = get_folder_mtime(expanded_path)

            for root, dirs, files in os.walk(expanded_path):
                for file in files:
                    suffix = Path(file).suffix.lower()
                    if suffix in SUPPORTED_FORMATS:
                        full_path = os.path.join(root, file)

                        # Single os.stat() call — used for the size check, EXIF cache
                        # key, and filesystem date fallback. Avoids the separate
                        # os.path.getsize() / os.path.getmtime() / os.path.getctime()
                        # calls that were previously scattered across this loop.
                        try:
                            file_stat = os.stat(full_path)
                            file_size = file_stat.st_size
                            file_mtime = file_stat.st_mtime
                            file_ctime = file_stat.st_ctime
                        except OSError:
                            continue  # Skip unreadable files

                        # Check video size limit
                        if suffix in VIDEO_FORMATS:
                            if file_size > MAX_VIDEO_SIZE:
                                continue  # Skip videos over size limit

                        # Compute effective sort date.
                        # Passing file stats lets get_effective_date() consult the
                        # persistent EXIF cache and skip PIL for unchanged files.
                        effective_date = get_effective_date(
                            full_path, date_source, file_mtime, file_size, file_ctime
                        )
                        image_entries.append((full_path, effective_date))

    # Sort newest-first by effective date
    image_entries.sort(key=lambda x: x[1], reverse=True)
    images = [entry[0] for entry in image_entries]

    # Build folder index for O(1) lookups in get_images_by_folder()
    folder_index: Dict[str, List[str]] = {}
    for img_path in images:
        folder = os.path.dirname(img_path)
        if folder not in folder_index:
            folder_index[folder] = []
        folder_index[folder].append(img_path)

    # Update cache — store effective dates too so get_leaf_folders can reuse them
    _image_cache['images'] = images
    _image_cache['effective_dates'] = {entry[0]: entry[1] for entry in image_entries}
    _image_cache['timestamp'] = time.time()
    _image_cache['folder_mtimes'] = folder_mtimes
    _image_cache['date_source'] = date_source
    _image_cache['folder_index'] = folder_index

    # Persist any newly discovered EXIF dates to disk so the next server restart
    # (or cache TTL expiry) doesn't have to re-open unchanged files with Pillow.
    _save_exif_date_cache()

    return images


def get_images_by_folder(folder_path: str) -> List[str]:
    """Get images from a specific folder using the pre-built folder index.

    The folder index is constructed during get_all_images() and maps each
    directory path to its images in the same sorted order as the main feed.
    This replaces a linear O(n) scan of all images with an O(1) dict lookup.

    Args:
        folder_path: Absolute path to the folder to filter by.

    Returns:
        List of image file paths in that folder, sorted newest-first.
    """
    # Ensure the cache (and folder index) is populated
    get_all_images()
    folder_index: Dict[str, List[str]] = _image_cache.get('folder_index', {})
    return list(folder_index.get(folder_path, []))


def get_leaf_folders() -> List[Dict[str, Any]]:
    """Get list of all leaf folders (folders that actually contain images).

    Uses cached image list and caches the computed folder data.
    Folder cache is invalidated when image cache is invalidated or when
    the current profile's folder list changes.

    The ``newest_mtime`` field is populated from the same effective date used for
    sorting (EXIF → filesystem fallback), so folder ordering in the nav is
    consistent with the main feed ordering.

    Returns:
        List of folder info dicts with path, name, count, and newest_mtime
    """
    global _leaf_folders_cache

    # Check if cache is still valid
    # The image cache is profile-aware, so if the profile's folders change,
    # get_all_images() will invalidate the image cache, which we should respect
    if _leaf_folders_cache:
        # Verify cache is actually based on the current folders
        from app.services.profiles import get_current_folders
        current_folders = set(get_current_folders())
        # Get the folders that were used to build the cache (stored in image cache)
        cached_mtimes = _image_cache.get('folder_mtimes', {})
        if current_folders == set(cached_mtimes.keys()):
            # Cache is valid for this profile
            return _leaf_folders_cache

    # Compute folder data from image list
    images = get_all_images()

    # Reuse the effective dates already computed during get_all_images()
    effective_dates: Dict[str, float] = _image_cache.get('effective_dates', {})

    # Count images and track newest effective date per folder
    folder_data: Dict[str, Dict[str, Any]] = {}
    for img in images:
        folder = os.path.dirname(img)
        if folder not in folder_data:
            folder_data[folder] = {'count': 0, 'newest_mtime': 0}
        folder_data[folder]['count'] += 1
        # Use cached effective date; fall back to filesystem mtime if unavailable
        eff = effective_dates.get(img)
        if eff is None:
            try:
                eff = os.path.getmtime(img)
            except OSError:
                eff = 0
        if eff > folder_data[folder]['newest_mtime']:
            folder_data[folder]['newest_mtime'] = eff

    # Convert to list of folder info objects
    folders = []
    for folder_path, data in folder_data.items():
        # Extract folder name (last component of path)
        parts = folder_path.replace('\\', '/').split('/')
        folder_name = parts[-1] if parts else folder_path

        folders.append({
            'path': folder_path,
            'name': folder_name,
            'count': data['count'],
            'newest_mtime': data['newest_mtime']
        })

    # Cache the result
    _leaf_folders_cache = folders

    return folders


# ---------------------------------------------------------------------------
# Module initialisation — load persistent EXIF cache from disk so it is
# available immediately on the first scan after a server restart.
# ---------------------------------------------------------------------------
_load_exif_date_cache()
