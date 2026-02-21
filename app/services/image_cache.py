"""
Image list caching service for LocalFeed.
Provides cached access to the list of images from configured folders.
"""

import os
import time
from pathlib import Path
from typing import List, Dict, Any, Optional

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
    'folder_mtimes': {}  # Track folder modification times
}

# Leaf folders cache (computed from image list)
_leaf_folders_cache: List[Dict[str, Any]] = []


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


def _is_cache_valid(config: Dict[str, Any]) -> bool:
    """Check if the cached image list is still valid.
    
    Args:
        config: Current configuration dictionary
        
    Returns:
        True if cache is valid, False otherwise
    """
    if _image_cache['images'] is None:
        return False
    
    # Check TTL
    if time.time() - _image_cache['timestamp'] > CACHE_TTL:
        return False
    
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
    _leaf_folders_cache = []


def get_all_images() -> List[str]:
    """Scan all configured folders and return list of image paths (with caching).
    
    Returns:
        List of image file paths, sorted by modification time (newest first)
    """
    # Import here to avoid circular imports
    from app.services.data import load_config
    
    config = load_config()
    
    # Check cache validity
    if _is_cache_valid(config):
        return _image_cache['images']
    
    # Cache miss or invalid - rescan
    # Use (path, mtime) tuples to avoid calling getmtime twice per file
    image_entries = []  # List of (path, mtime) tuples
    folder_mtimes = {}
    
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
                        # Cache mtime during initial scan to avoid double lookup
                        try:
                            mtime = os.path.getmtime(full_path)
                        except OSError:
                            mtime = 0
                        image_entries.append((full_path, mtime))
    
    # Sort by modification time (newest first) for a more natural feel
    image_entries.sort(key=lambda x: x[1], reverse=True)
    images = [entry[0] for entry in image_entries]
    
    # Update cache
    _image_cache['images'] = images
    _image_cache['timestamp'] = time.time()
    _image_cache['folder_mtimes'] = folder_mtimes
    
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
    
    Returns:
        List of folder info dicts with path, name, count, and newest_mtime
    """
    global _leaf_folders_cache
    
    # Return cached folder data if available
    if _leaf_folders_cache:
        return _leaf_folders_cache
    
    # Compute folder data from image list
    images = get_all_images()
    
    # Count images and track newest modification time per folder
    folder_data: Dict[str, Dict[str, Any]] = {}
    for img in images:
        folder = os.path.dirname(img)
        if folder not in folder_data:
            folder_data[folder] = {'count': 0, 'newest_mtime': 0}
        folder_data[folder]['count'] += 1
        # Track the newest file modification time in this folder
        try:
            mtime = os.path.getmtime(img)
            if mtime > folder_data[folder]['newest_mtime']:
                folder_data[folder]['newest_mtime'] = mtime
        except OSError:
            pass
    
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
