"""
Data management services for HomeFeed.
Handles loading and saving configuration, favorites, trash, and seen data.
"""

import copy
import os
import json
import time
from typing import Dict, Any, List, Optional, Tuple
from filelock import FileLock

from app.config import (
    CONFIG_FILE,
    FAVORITES_FILE,
    TRASH_FILE,
    SEEN_FILE,
    COMMENTS_FILE,
    DEFAULT_OPTIMIZATIONS,
)

# ---------------------------------------------------------------------------
# In-memory config cache
# Eliminates repeated disk reads for config.json across many concurrent
# requests (e.g. serving 7500+ images on first load).
# The cache is invalidated (and updated) on every save_config() call, so
# in-app changes always take immediate effect.  External edits to config.json
# are picked up after _CONFIG_CACHE_TTL seconds at most.
# ---------------------------------------------------------------------------

_CONFIG_CACHE_TTL = 60.0  # seconds between forced re-reads from disk
# Stored as a tuple (data_dict, timestamp) so replacement is one atomic
# assignment (safe under CPython's GIL without an explicit lock).
_config_cache: Tuple[Optional[Dict[str, Any]], float] = (None, 0.0)

# Sentinel for per-request g-cache "not set" checks
_UNSET = object()


def load_config() -> Dict[str, Any]:
    """Load configuration from config.json (with in-memory caching).

    Returns a deep copy so callers can freely modify the dict without
    corrupting the cache.

    Returns:
        Configuration dictionary with 'folders' and 'shuffle' keys
    """
    global _config_cache
    cached_data, cached_ts = _config_cache
    if cached_data is not None and (time.time() - cached_ts) < _CONFIG_CACHE_TTL:
        return copy.deepcopy(cached_data)

    # Cache miss or expired — read from disk
    if os.path.exists(CONFIG_FILE):
        try:
            with open(CONFIG_FILE, 'r') as f:
                result = json.load(f)
        except (json.JSONDecodeError, IOError):
            result = {'folders': [], 'shuffle': False}
    else:
        result = {'folders': [], 'shuffle': False}

    _config_cache = (result, time.time())
    return copy.deepcopy(result)


def save_config(config: Dict[str, Any]) -> None:
    """Save configuration to config.json and update the in-memory cache.

    Args:
        config: Configuration dictionary to save
    """
    global _config_cache
    lock = FileLock(CONFIG_FILE + '.lock')
    with lock:
        with open(CONFIG_FILE, 'w') as f:
            json.dump(config, f, indent=2)
    # Update module-level cache so subsequent reads don't need to hit disk
    _config_cache = (copy.deepcopy(config), time.time())
    # Invalidate the per-request g-cache so the rest of this request sees the
    # updated settings (e.g. after toggling thumbnail_cache in settings).
    try:
        from flask import g
        g._homefeed_optimization_settings = _UNSET  # force recompute
    except RuntimeError:
        pass


def get_optimization_settings() -> Dict[str, bool]:
    """Get optimization settings with defaults.

    Result is cached on flask.g so that tight loops (e.g. building 7500 image
    URLs via format_image_url) only compute the settings once per request.

    Returns:
        Dictionary of optimization settings
    """
    try:
        from flask import g
        cached = getattr(g, '_homefeed_optimization_settings', _UNSET)
        if cached is not _UNSET:
            return cached
    except RuntimeError:
        pass  # Outside request context

    config = load_config()
    optimizations = config.get('optimizations', {})
    # Apply defaults for any missing settings
    for key, value in DEFAULT_OPTIMIZATIONS.items():
        if key not in optimizations:
            optimizations[key] = value

    try:
        from flask import g
        g._homefeed_optimization_settings = optimizations
    except RuntimeError:
        pass
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


# ---------------------------------------------------------------------------
# Profile-aware helpers
# These automatically scope to the current profile's data files when profiles
# are in use, and fall back to the global files otherwise.
# ---------------------------------------------------------------------------

def _active_favorites_file() -> str:
    """Return the favorites file path for the active profile (or global)."""
    from app.services.profiles import get_current_profile_id, is_profiles_active, get_profile_data_file
    profile_id = get_current_profile_id()
    if profile_id and is_profiles_active():
        return get_profile_data_file(profile_id, 'favorites.json')
    return FAVORITES_FILE


def _active_trash_file() -> str:
    """Return the trash file path for the active profile (or global)."""
    from app.services.profiles import get_current_profile_id, is_profiles_active, get_profile_data_file
    profile_id = get_current_profile_id()
    if profile_id and is_profiles_active():
        return get_profile_data_file(profile_id, 'trash.json')
    return TRASH_FILE


def _active_seen_file() -> str:
    """Return the seen file path for the active profile (or global)."""
    from app.services.profiles import get_current_profile_id, is_profiles_active, get_profile_data_file
    profile_id = get_current_profile_id()
    if profile_id and is_profiles_active():
        return get_profile_data_file(profile_id, 'seen.json')
    return SEEN_FILE


def _load_json_file(filepath: str, default: Any) -> Any:
    """Load JSON from a file, returning default if missing or corrupt."""
    if os.path.exists(filepath):
        try:
            with open(filepath, 'r') as f:
                return json.load(f)
        except (json.JSONDecodeError, IOError):
            pass
    return default


def _save_json_file(filepath: str, data: Any) -> None:
    """Save JSON to a file with a file lock."""
    lock = FileLock(filepath + '.lock')
    with lock:
        with open(filepath, 'w') as f:
            json.dump(data, f, indent=2)


def load_active_favorites() -> List[str]:
    """Load favorites for the current profile (or global)."""
    filepath = _active_favorites_file()
    data = _load_json_file(filepath, {'favorites': []})
    return data.get('favorites', [])


def save_active_favorites(favorites: List[str]) -> None:
    """Save favorites for the current profile (or global)."""
    _save_json_file(_active_favorites_file(), {'favorites': favorites})


def cleanup_active_favorites() -> List[str]:
    """Remove active-profile favorites that no longer exist on disk."""
    favorites = load_active_favorites()
    valid = [p for p in favorites if os.path.exists(p)]
    if len(valid) != len(favorites):
        save_active_favorites(valid)
    return valid


def load_active_trash() -> List[str]:
    """Load trash for the current profile (or global)."""
    filepath = _active_trash_file()
    data = _load_json_file(filepath, {'trash': []})
    return data.get('trash', [])


def save_active_trash(trash: List[str]) -> None:
    """Save trash for the current profile (or global)."""
    _save_json_file(_active_trash_file(), {'trash': trash})


def cleanup_active_trash() -> List[str]:
    """Remove active-profile trash entries that no longer exist on disk."""
    trash = load_active_trash()
    valid = [p for p in trash if os.path.exists(p)]
    if len(valid) != len(trash):
        save_active_trash(valid)
    return valid


def load_active_seen() -> Dict[str, Any]:
    """Load seen data for the current profile (or global)."""
    filepath = _active_seen_file()
    data = _load_json_file(filepath, {'seen': {}, 'total_scrolls': 0})
    return {
        'seen': data.get('seen', {}),
        'total_scrolls': data.get('total_scrolls', 0),
    }


def save_active_seen(data: Dict[str, Any]) -> None:
    """Save seen data for the current profile (or global)."""
    _save_json_file(_active_seen_file(), data)


def mark_active_seen_batch(paths: List[str]) -> Dict[str, Any]:
    """Mark a batch of paths as seen for the current profile (or global)."""
    data = load_active_seen()
    seen_map = data['seen']
    now = time.time()
    new_count = 0

    for path in paths:
        if path in seen_map:
            seen_map[path]['seen_count'] += 1
            seen_map[path]['last_seen'] = now
        else:
            seen_map[path] = {'first_seen': now, 'seen_count': 1, 'last_seen': now}
            new_count += 1

    data['seen'] = seen_map
    data['total_scrolls'] = data.get('total_scrolls', 0) + new_count
    save_active_seen(data)
    return data


def get_active_seen_stats(total_image_count: int) -> Dict[str, Any]:
    """Get seen stats for the current profile (or global)."""
    data = load_active_seen()
    seen_count = len(data['seen'])
    total_scrolls = data.get('total_scrolls', 0)
    percent_seen = round((seen_count / total_image_count * 100), 1) if total_image_count > 0 else 0
    return {
        'seen_count': seen_count,
        'total_count': total_image_count,
        'total_scrolls': total_scrolls,
        'percent_seen': percent_seen,
    }


def reset_active_seen() -> None:
    """Reset seen history for the current profile (or global)."""
    save_active_seen({'seen': {}, 'total_scrolls': 0})


# ---------------------------------------------------------------------------
# Comments
# Comments are global (not per-profile) — they annotate the files themselves.
# When profiles are active, comments optionally record the profile name so
# multiple users can be identified. Structure:
#
# comments.json = {
#   "/abs/path/to/photo.jpg": [
#     {
#       "id": "uuid-string",
#       "text": "comment body",
#       "type": "user",          # "user" | "reddit"
#       "profile_id": null,      # profile id when profiles are on
#       "profile_name": null,    # display name / username
#       "author": null,          # for reddit type: reddit username
#       "score": null,           # for reddit type: upvote count
#       "created_at": 1234567890.0,
#       "edited_at": null
#     }
#   ]
# }
# ---------------------------------------------------------------------------

def load_comments() -> Dict[str, List[Dict[str, Any]]]:
    """Load all comments from comments.json.

    Returns:
        Dict mapping absolute image paths to lists of comment dicts.
    """
    return _load_json_file(COMMENTS_FILE, {})


def save_comments(data: Dict[str, List[Dict[str, Any]]]) -> None:
    """Save all comments to comments.json."""
    _save_json_file(COMMENTS_FILE, data)


def get_comments_for_path(image_path: str) -> List[Dict[str, Any]]:
    """Get all stored user/reddit comments for a specific image path."""
    data = load_comments()
    return data.get(image_path, [])


def add_comment(image_path: str, comment: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Add a comment to an image and persist it.

    The entire read-modify-write cycle is protected by FileLock to prevent
    concurrent requests from clobbering each other's data.

    Args:
        image_path: Absolute path to the image file.
        comment: Comment dict (caller must supply id, text, type, etc.)

    Returns:
        Updated list of comments for this image.
    """
    lock = FileLock(COMMENTS_FILE + '.lock')
    with lock:
        data = _load_json_file(COMMENTS_FILE, {})
        if image_path not in data:
            data[image_path] = []
        data[image_path].append(comment)
        with open(COMMENTS_FILE, 'w') as f:
            json.dump(data, f, indent=2)
        return data[image_path]


def update_comment(image_path: str, comment_id: str, new_text: str) -> Optional[Dict[str, Any]]:
    """Update the text of an existing user comment.

    Args:
        image_path: Absolute path to the image file.
        comment_id: UUID of the comment to update.
        new_text: New comment text.

    Returns:
        Updated comment dict, or None if not found.
    """
    lock = FileLock(COMMENTS_FILE + '.lock')
    with lock:
        data = _load_json_file(COMMENTS_FILE, {})
        comments = data.get(image_path, [])
        for comment in comments:
            if comment.get('id') == comment_id and comment.get('type') == 'user':
                comment['text'] = new_text
                comment['edited_at'] = time.time()
                with open(COMMENTS_FILE, 'w') as f:
                    json.dump(data, f, indent=2)
                return comment
    return None


def delete_comment(image_path: str, comment_id: str) -> bool:
    """Delete a comment by id.

    Args:
        image_path: Absolute path to the image file.
        comment_id: UUID of the comment to delete.

    Returns:
        True if deleted, False if not found.
    """
    lock = FileLock(COMMENTS_FILE + '.lock')
    with lock:
        data = _load_json_file(COMMENTS_FILE, {})
        comments = data.get(image_path, [])
        new_comments = [c for c in comments if c.get('id') != comment_id]
        if len(new_comments) == len(comments):
            return False
        data[image_path] = new_comments
        if not data[image_path]:
            del data[image_path]
        with open(COMMENTS_FILE, 'w') as f:
            json.dump(data, f, indent=2)
        return True


def cleanup_orphaned_comments() -> int:
    """Remove comments for image files that no longer exist on disk.

    Called at startup and after library scans to prevent unbounded growth
    of comments.json.

    Returns:
        Number of image entries removed.
    """
    lock = FileLock(COMMENTS_FILE + '.lock')
    with lock:
        data = _load_json_file(COMMENTS_FILE, {})
        before = len(data)
        data = {path: comments for path, comments in data.items() if os.path.exists(path)}
        after = len(data)
        if before != after:
            with open(COMMENTS_FILE, 'w') as f:
                json.dump(data, f, indent=2)
    return before - after
