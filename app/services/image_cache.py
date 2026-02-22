"""
Image list caching service for LocalFeed.
Provides cached access to the list of images from configured folders.
"""

import os
import time
import logging
from datetime import datetime
from pathlib import Path
from typing import List, Dict, Any, Optional, Tuple

logger = logging.getLogger(__name__)

from app.config import (
    CACHE_TTL,
    SUPPORTED_FORMATS,
    VIDEO_FORMATS,
    MAX_VIDEO_SIZE,
)
from app.services.path_utils import expand_path, normalize_path


# Image list cache (with TTL)
_image_cache: Dict[str, Any] = {
    'images': None,
    'timestamp': 0,
    'folder_mtimes': {},  # Track folder modification times
    'date_source': None,  # Track which date_source was used, to detect setting changes
}

# Leaf folders cache (computed from image list)
_leaf_folders_cache: List[Dict[str, Any]] = []


def get_effective_date(path: str, date_source: str) -> float:
    """Return the best available date (as a Unix timestamp) for a file.

    Hierarchy:
      1. EXIF DateTimeOriginal  (shutter time — most accurate for photos)
      2. EXIF DateTimeDigitized (digitization time — reliable for scanned photos)
      3. Filesystem fallback determined by ``date_source``:
         - ``'mtime'``: modification time first, then creation time
         - ``'ctime'``: creation time first, then modification time

    EXIF extraction requires Pillow.  If Pillow is not installed, or the file
    is a video, we silently skip to the filesystem fallback.

    Args:
        path:        Absolute path to the file.
        date_source: ``'mtime'`` or ``'ctime'`` — controls filesystem fallback order.

    Returns:
        Unix timestamp (float).  Falls back to 0 if nothing is readable.
    """
    # --- 1 & 2: try EXIF for image files ---
    suffix = Path(path).suffix.lower()
    if suffix not in VIDEO_FORMATS:
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
                                return dt.timestamp()
                            except (ValueError, OverflowError):
                                pass
        except ImportError:
            pass  # Pillow not installed — fall through to filesystem dates
        except Exception:
            pass  # Corrupt file or unreadable EXIF — fall through

    # --- 3: filesystem fallback ---
    try:
        mtime = os.path.getmtime(path)
    except OSError:
        mtime = 0
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
    if time.time() - _image_cache['timestamp'] > CACHE_TTL:
        return False

    # Import here to avoid circular imports
    from app.services.data import load_config
    config = load_config()

    # Check if folders have changed
    current_folders = config.get('folders', [])
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
    # Import here to avoid circular imports
    from app.services.data import get_optimization_settings

    settings = get_optimization_settings()
    date_source = settings.get('date_source', 'mtime')

    # Check cache validity — also bust cache when date_source setting changed
    if _is_cache_valid_with_date_source(date_source):
        return _image_cache['images']

    from app.services.data import load_config
    config = load_config()

    # Cache miss or invalid - rescan
    # Each entry is (path, effective_date) — effective_date is computed once and reused
    image_entries: List[Tuple[str, float]] = []
    folder_mtimes: Dict[str, float] = {}

    for folder_path in config.get('folders', []):
        expanded_path = expand_path(folder_path)
        if os.path.isdir(expanded_path):
            # Track folder modification time
            folder_mtimes[folder_path] = get_folder_mtime(expanded_path)

            for root, dirs, files in os.walk(expanded_path):
                for file in files:
                    if Path(file).suffix.lower() in SUPPORTED_FORMATS:
                        full_path = os.path.join(root, file)
                        # Check video size limit
                        if Path(file).suffix.lower() in VIDEO_FORMATS:
                            try:
                                if os.path.getsize(full_path) > MAX_VIDEO_SIZE:
                                    continue  # Skip videos over size limit
                            except OSError:
                                continue  # Skip if can't read file
                        # Compute effective sort date (EXIF → filesystem fallback)
                        effective_date = get_effective_date(full_path, date_source)
                        image_entries.append((full_path, effective_date))

    # Sort newest-first by effective date
    image_entries.sort(key=lambda x: x[1], reverse=True)
    images = [entry[0] for entry in image_entries]

    # Update cache — store effective dates too so get_leaf_folders can reuse them
    _image_cache['images'] = images
    _image_cache['effective_dates'] = {entry[0]: entry[1] for entry in image_entries}
    _image_cache['timestamp'] = time.time()
    _image_cache['folder_mtimes'] = folder_mtimes
    _image_cache['date_source'] = date_source

    return images


def get_images_by_folder(folder_path: str) -> List[str]:
    """Get list of images from a specific folder.
    
    Args:
        folder_path: Path to the folder to filter by
        
    Returns:
        List of image file paths in that folder
    """
    images = get_all_images()
    filtered_images = [img for img in images if os.path.dirname(img) == folder_path]
    return filtered_images


def get_leaf_folders() -> List[Dict[str, Any]]:
    """Get list of all leaf folders (folders that actually contain images).

    Uses cached image list and caches the computed folder data.
    Folder cache is invalidated when image cache is invalidated.

    The ``newest_mtime`` field is populated from the same effective date used for
    sorting (EXIF → filesystem fallback), so folder ordering in the nav is
    consistent with the main feed ordering.

    Returns:
        List of folder info dicts with path, name, count, and newest_mtime
    """
    global _leaf_folders_cache

    # Return cached folder data if available
    if _leaf_folders_cache:
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
