"""
Data management services for LocalFeed.
Handles loading and saving configuration, favorites, and trash data.
"""

import os
import json
from typing import Dict, Any, List
from filelock import FileLock

from app.config import (
    CONFIG_FILE,
    FAVORITES_FILE,
    TRASH_FILE,
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
