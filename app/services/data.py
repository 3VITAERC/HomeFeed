"""
Data management services for LocalFeed.
Handles loading and saving configuration, favorites, trash, and seen data.
"""

import os
import json
import time
from typing import Dict, Any, List
from filelock import FileLock

from app.config import (
    CONFIG_FILE,
    FAVORITES_FILE,
    TRASH_FILE,
    SEEN_FILE,
    DEFAULT_OPTIMIZATIONS,
)


def load_config() -> Dict[str, Any]:
    """Load configuration from config.json.
    
    Returns:
        Configuration dictionary with 'folders' and 'shuffle' keys
    """
    if os.path.exists(CONFIG_FILE):
        try:
            with open(CONFIG_FILE, 'r') as f:
                return json.load(f)
        except (json.JSONDecodeError, IOError):
            return {'folders': [], 'shuffle': False}
    return {'folders': [], 'shuffle': False}


def save_config(config: Dict[str, Any]) -> None:
    """Save configuration to config.json.
    
    Args:
        config: Configuration dictionary to save
    """
    lock = FileLock(CONFIG_FILE + '.lock')
    with lock:
        with open(CONFIG_FILE, 'w') as f:
            json.dump(config, f, indent=2)


def get_optimization_settings() -> Dict[str, bool]:
    """Get optimization settings with defaults.
    
    Returns:
        Dictionary of optimization settings
    """
    config = load_config()
    optimizations = config.get('optimizations', {})
    # Apply defaults for any missing settings
    for key, value in DEFAULT_OPTIMIZATIONS.items():
        if key not in optimizations:
            optimizations[key] = value
    return optimizations


def save_optimization_settings(settings: Dict[str, bool]) -> None:
    """Save optimization settings to config.
    
    Args:
        settings: Dictionary of optimization settings to save
    """
    config = load_config()
    config['optimizations'] = settings
    save_config(config)


def load_favorites() -> List[str]:
    """Load favorites from favorites.json.
    
    Returns:
        List of favorited image paths
    """
    if os.path.exists(FAVORITES_FILE):
        try:
            with open(FAVORITES_FILE, 'r') as f:
                data = json.load(f)
                return data.get('favorites', [])
        except (json.JSONDecodeError, IOError):
            return []
    return []


def save_favorites(favorites: List[str]) -> None:
    """Save favorites to favorites.json.
    
    Args:
        favorites: List of favorited image paths
    """
    lock = FileLock(FAVORITES_FILE + '.lock')
    with lock:
        with open(FAVORITES_FILE, 'w') as f:
            json.dump({'favorites': favorites}, f, indent=2)


def cleanup_favorites() -> List[str]:
    """Remove favorites that no longer exist on disk.
    
    Note: We intentionally do NOT remove favorites just because their folder
    was removed from settings. This preserves favorites in case the user
    accidentally removed the folder or wants to add it back later.
    
    Returns:
        List of valid favorites
    """
    favorites = load_favorites()
    
    valid_favorites = []
    for img_path in favorites:
        if os.path.exists(img_path):
            valid_favorites.append(img_path)
    
    if len(valid_favorites) != len(favorites):
        save_favorites(valid_favorites)
    
    return valid_favorites


def load_trash() -> List[str]:
    """Load trash from trash.json.
    
    Returns:
        List of trashed image paths
    """
    if os.path.exists(TRASH_FILE):
        try:
            with open(TRASH_FILE, 'r') as f:
                data = json.load(f)
                return data.get('trash', [])
        except (json.JSONDecodeError, IOError):
            return []
    return []


def save_trash(trash: List[str]) -> None:
    """Save trash to trash.json.
    
    Args:
        trash: List of trashed image paths
    """
    lock = FileLock(TRASH_FILE + '.lock')
    with lock:
        with open(TRASH_FILE, 'w') as f:
            json.dump({'trash': trash}, f, indent=2)


def cleanup_trash() -> List[str]:
    """Remove trash entries that no longer exist on disk.
    
    Returns:
        List of valid trash entries
    """
    trash = load_trash()
    
    valid_trash = []
    for img_path in trash:
        if os.path.exists(img_path):
            valid_trash.append(img_path)
    
    if len(valid_trash) != len(trash):
        save_trash(valid_trash)
    
    return valid_trash


def load_seen() -> Dict[str, Any]:
    """Load seen data from seen.json.
    
    Returns:
        Dict with 'seen' (dict of path -> metadata) and 'total_scrolls' (int)
    """
    if os.path.exists(SEEN_FILE):
        try:
            with open(SEEN_FILE, 'r') as f:
                data = json.load(f)
                return {
                    'seen': data.get('seen', {}),
                    'total_scrolls': data.get('total_scrolls', 0),
                }
        except (json.JSONDecodeError, IOError):
            return {'seen': {}, 'total_scrolls': 0}
    return {'seen': {}, 'total_scrolls': 0}


def save_seen(data: Dict[str, Any]) -> None:
    """Save seen data to seen.json.
    
    Args:
        data: Dict with 'seen' dict and 'total_scrolls' int
    """
    lock = FileLock(SEEN_FILE + '.lock')
    with lock:
        with open(SEEN_FILE, 'w') as f:
            json.dump(data, f, indent=2)


def mark_seen_batch(paths: List[str]) -> Dict[str, Any]:
    """Mark a batch of image paths as seen, incrementing total_scrolls.
    
    Each path records first_seen, seen_count, and last_seen timestamps.
    total_scrolls is incremented by the number of NEW paths in this batch
    (paths already seen do not increment total_scrolls again).
    
    Args:
        paths: List of absolute file paths to mark as seen
        
    Returns:
        Updated seen data dict
    """
    data = load_seen()
    seen_map = data['seen']
    now = time.time()
    new_count = 0

    for path in paths:
        if path in seen_map:
            seen_map[path]['seen_count'] += 1
            seen_map[path]['last_seen'] = now
        else:
            seen_map[path] = {
                'first_seen': now,
                'seen_count': 1,
                'last_seen': now,
            }
            new_count += 1

    data['seen'] = seen_map
    data['total_scrolls'] = data.get('total_scrolls', 0) + new_count
    save_seen(data)
    return data


def get_seen_stats(total_image_count: int) -> Dict[str, Any]:
    """Get statistics about seen images.
    
    Args:
        total_image_count: Total number of images in the library (for percent calc)
        
    Returns:
        Dict with seen_count, total_count, total_scrolls, percent_seen
    """
    data = load_seen()
    seen_count = len(data['seen'])
    total_scrolls = data.get('total_scrolls', 0)
    percent_seen = round((seen_count / total_image_count * 100), 1) if total_image_count > 0 else 0
    return {
        'seen_count': seen_count,
        'total_count': total_image_count,
        'total_scrolls': total_scrolls,
        'percent_seen': percent_seen,
    }


def reset_seen() -> None:
    """Reset all seen history (clears seen.json)."""
    save_seen({'seen': {}, 'total_scrolls': 0})
