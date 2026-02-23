"""
Profile management service for HomeFeed.

Netflix-style user profiles with optional per-profile passwords.
Each profile has its own favorites, watch history, and folder configuration.
"""

import copy
import os
import json
import hashlib
import secrets
import time
from typing import Optional, Dict, List, Any, Tuple
from filelock import FileLock
from flask import session

from app.config import PROFILES_FILE, PROFILES_DIR


PROFILE_SESSION_KEY = 'profile_id'

# Sentinel for distinguishing "not set" from None in per-request g cache
_UNSET = object()

# ---------------------------------------------------------------------------
# In-memory profiles cache
# profiles.json is read on almost every request (before_request, is_path_allowed,
# get_current_folders, etc.).  Caching it in memory eliminates the disk I/O
# storm that occurred when serving thousands of images on page load.
# Cache is updated immediately on every save_profiles() call.
# ---------------------------------------------------------------------------

_PROFILES_CACHE_TTL = 60.0  # seconds between forced re-reads from disk
_profiles_cache: Tuple[Optional[Dict[str, Any]], float] = (None, 0.0)


# ---------------------------------------------------------------------------
# Password helpers
# ---------------------------------------------------------------------------

def _hash_password(password: str) -> str:
    """Hash a password with a random salt using PBKDF2."""
    salt = secrets.token_hex(16)
    dk = hashlib.pbkdf2_hmac('sha256', password.encode('utf-8'), salt.encode('utf-8'), 100_000)
    return f"{salt}:{dk.hex()}"


def _verify_password(password: str, stored_hash: str) -> bool:
    """Verify a password against a stored PBKDF2 hash."""
    parts = stored_hash.split(':', 1)
    if len(parts) != 2:
        return False
    salt, stored_dk = parts
    dk = hashlib.pbkdf2_hmac('sha256', password.encode('utf-8'), salt.encode('utf-8'), 100_000)
    return secrets.compare_digest(dk.hex(), stored_dk)


# ---------------------------------------------------------------------------
# Profiles file I/O
# ---------------------------------------------------------------------------

def load_profiles() -> Dict[str, Any]:
    """Load profiles data from profiles.json (with in-memory caching).

    Returns a deep copy so callers can freely modify the dict without
    corrupting the cache.
    """
    global _profiles_cache
    cached_data, cached_ts = _profiles_cache
    if cached_data is not None and (time.time() - cached_ts) < _PROFILES_CACHE_TTL:
        return copy.deepcopy(cached_data)

    # Cache miss or expired — read from disk
    if os.path.exists(PROFILES_FILE):
        try:
            with open(PROFILES_FILE, 'r') as f:
                result = json.load(f)
        except (json.JSONDecodeError, IOError):
            result = {'profiles': []}
    else:
        result = {'profiles': []}

    _profiles_cache = (result, time.time())
    return copy.deepcopy(result)


def save_profiles(data: Dict[str, Any]) -> None:
    """Save profiles data to profiles.json and update the in-memory cache."""
    global _profiles_cache
    lock = FileLock(PROFILES_FILE + '.lock')
    with lock:
        with open(PROFILES_FILE, 'w') as f:
            json.dump(data, f, indent=2)
    # Update cache so subsequent reads don't need to hit disk
    _profiles_cache = (copy.deepcopy(data), time.time())


# ---------------------------------------------------------------------------
# Profile CRUD
# ---------------------------------------------------------------------------

def profiles_exist() -> bool:
    """Return True if at least one profile has been created."""
    data = load_profiles()
    return len(data.get('profiles', [])) > 0


def get_profiles_public() -> List[Dict[str, Any]]:
    """Return profiles list safe for the picker UI (no password hashes)."""
    data = load_profiles()
    return [
        {
            'id': p['id'],
            'name': p['name'],
            'emoji': p.get('emoji', '👤'),
            'role': p.get('role', 'user'),
            'has_password': bool(p.get('password_hash')),
        }
        for p in data.get('profiles', [])
    ]


def get_profile(profile_id: str) -> Optional[Dict[str, Any]]:
    """Get a full profile record by ID (includes password hash for internal use)."""
    data = load_profiles()
    for p in data.get('profiles', []):
        if p['id'] == profile_id:
            return p
    return None


def create_profile(
    name: str,
    emoji: str = '👤',
    password: Optional[str] = None,
    role: str = 'user',
) -> Dict[str, Any]:
    """Create a new profile and its data directory."""
    profile_id = secrets.token_hex(8)
    profile = {
        'id': profile_id,
        'name': name,
        'emoji': emoji,
        'role': role,
        'password_hash': _hash_password(password) if password else None,
    }
    data = load_profiles()
    data.setdefault('profiles', []).append(profile)
    save_profiles(data)

    # Ensure the profile's data directory exists
    os.makedirs(get_profile_dir(profile_id), exist_ok=True)

    return {
        'id': profile_id,
        'name': name,
        'emoji': emoji,
        'role': role,
        'has_password': bool(password),
    }


def update_profile(
    profile_id: str,
    name: Optional[str] = None,
    emoji: Optional[str] = None,
    password: Optional[str] = None,
    clear_password: bool = False,
    role: Optional[str] = None,
) -> Optional[Dict[str, Any]]:
    """Update an existing profile. Pass clear_password=True to remove password."""
    data = load_profiles()
    for p in data.get('profiles', []):
        if p['id'] == profile_id:
            if name is not None:
                p['name'] = name
            if emoji is not None:
                p['emoji'] = emoji
            if role is not None:
                p['role'] = role
            if clear_password:
                p['password_hash'] = None
            elif password is not None:
                p['password_hash'] = _hash_password(password)
            save_profiles(data)
            return {
                'id': profile_id,
                'name': p['name'],
                'emoji': p['emoji'],
                'role': p['role'],
                'has_password': bool(p.get('password_hash')),
            }
    return None


def delete_profile(profile_id: str) -> bool:
    """Delete a profile (does not delete its data directory)."""
    data = load_profiles()
    original = len(data.get('profiles', []))
    data['profiles'] = [p for p in data.get('profiles', []) if p['id'] != profile_id]
    if len(data['profiles']) < original:
        save_profiles(data)
        return True
    return False


def delete_all_profiles(except_profile_id: str) -> int:
    """Delete all profiles except the given one, including their data directories.

    This is a destructive operation used by the admin 'Delete All Profile Data' feature.
    Unlike delete_profile(), this DOES remove the data directories from disk.

    Args:
        except_profile_id: ID of the profile to keep (must be the current admin).

    Returns:
        Number of profiles deleted.
    """
    import shutil

    data = load_profiles()
    to_delete = [p for p in data.get('profiles', []) if p['id'] != except_profile_id]

    for p in to_delete:
        profile_dir = get_profile_dir(p['id'])
        if os.path.exists(profile_dir):
            shutil.rmtree(profile_dir, ignore_errors=True)

    data['profiles'] = [p for p in data.get('profiles', []) if p['id'] == except_profile_id]
    save_profiles(data)

    return len(to_delete)


def verify_profile_password(profile_id: str, password: str) -> bool:
    """Verify a password for a profile. Returns True if no password is set.

    If HOMEFEED_ADMIN_PASSWORD is set in the environment, it acts as a master
    password that can unlock any admin-role profile.
    """
    profile = get_profile(profile_id)
    if not profile:
        return False

    # Master admin password override (env var)
    if profile.get('role') == 'admin':
        admin_pw = os.environ.get('HOMEFEED_ADMIN_PASSWORD', '')
        if admin_pw and password == admin_pw:
            return True

    stored_hash = profile.get('password_hash')
    if not stored_hash:
        return True  # No password required
    return _verify_password(password, stored_hash)


# ---------------------------------------------------------------------------
# Profile data directory helpers
# ---------------------------------------------------------------------------

def get_profile_dir(profile_id: str) -> str:
    """Return the data directory path for a profile."""
    return os.path.join(PROFILES_DIR, profile_id)


def get_profile_data_file(profile_id: str, filename: str) -> str:
    """Return the full path to a profile-specific data file, ensuring dir exists."""
    profile_dir = get_profile_dir(profile_id)
    os.makedirs(profile_dir, exist_ok=True)
    return os.path.join(profile_dir, filename)


# ---------------------------------------------------------------------------
# Session helpers
# ---------------------------------------------------------------------------

def get_current_profile_id() -> Optional[str]:
    """Get the active profile ID from the Flask session."""
    try:
        return session.get(PROFILE_SESSION_KEY)
    except RuntimeError:
        return None  # Called outside request context


def set_current_profile(profile_id: str) -> None:
    """Store the selected profile in the session."""
    session[PROFILE_SESSION_KEY] = profile_id


def clear_current_profile() -> None:
    """Remove the active profile from the session."""
    session.pop(PROFILE_SESSION_KEY, None)


def is_profile_selected() -> bool:
    """Return True if a profile is currently selected in this session."""
    return get_current_profile_id() is not None


def is_current_profile_admin() -> bool:
    """Return True if the current profile has the admin role.

    Only returns True when:
    - No profiles exist at all (first-run bootstrap), OR
    - The currently logged-in profile has role == 'admin'

    When profiles exist but no one is logged in, returns False to prevent
    unauthenticated users from performing admin operations.

    Result is cached on flask.g for the duration of the current request.
    """
    try:
        from flask import g
        cached = getattr(g, '_homefeed_is_admin', _UNSET)
        if cached is not _UNSET:
            return cached
    except RuntimeError:
        pass

    profile_id = get_current_profile_id()
    if not profile_id:
        result = not profiles_exist()
    else:
        profile = get_profile(profile_id)
        result = bool(profile and profile.get('role') == 'admin')

    try:
        from flask import g
        g._homefeed_is_admin = result
    except RuntimeError:
        pass
    return result


# ---------------------------------------------------------------------------
# Profile-aware config (folders)
# ---------------------------------------------------------------------------

# Per-profile config cache: dict keyed by profile_id → (data, timestamp)
_PROFILE_CONFIG_CACHE_TTL = 60.0
_profile_config_cache: Dict[str, Tuple[Dict[str, Any], float]] = {}


def load_profile_config(profile_id: str) -> Dict[str, Any]:
    """Load the folder/config data for a specific profile (with in-memory caching)."""
    cached = _profile_config_cache.get(profile_id)
    if cached is not None:
        data, ts = cached
        if (time.time() - ts) < _PROFILE_CONFIG_CACHE_TTL:
            return copy.deepcopy(data)

    config_file = get_profile_data_file(profile_id, 'config.json')
    if os.path.exists(config_file):
        try:
            with open(config_file, 'r') as f:
                result = json.load(f)
        except (json.JSONDecodeError, IOError):
            result = {'folders': []}
    else:
        result = {'folders': []}

    _profile_config_cache[profile_id] = (result, time.time())
    return copy.deepcopy(result)


def save_profile_config(profile_id: str, config: Dict[str, Any]) -> None:
    """Save the folder/config data for a specific profile and update cache."""
    config_file = get_profile_data_file(profile_id, 'config.json')
    lock = FileLock(config_file + '.lock')
    with lock:
        with open(config_file, 'w') as f:
            json.dump(config, f, indent=2)
    _profile_config_cache[profile_id] = (copy.deepcopy(config), time.time())


def get_current_folders() -> List[str]:
    """Return the active folder list for the current session.

    - Admin profiles always use the global config.json folder list so they
      have the same view as the vanilla (no-profiles) experience.
    - Regular profiles use their own per-profile folder list.
    - Falls back to global config when no profile is active OR when the
      profiles feature is disabled (is_profiles_active() is False).

    Result is cached on flask.g for the duration of the current request so
    multiple callers within the same request (before_request, is_path_allowed,
    cache validity checks) only compute this once.
    """
    # Per-request cache
    try:
        from flask import g
        cached = getattr(g, '_homefeed_current_folders', _UNSET)
        if cached is not _UNSET:
            return cached
    except RuntimeError:
        pass  # Outside request context (tests, background tasks)

    from app.services.data import load_config
    profile_id = get_current_profile_id()
    if profile_id and is_profiles_active():
        profile = get_profile(profile_id)
        if profile and profile.get('role') == 'admin':
            # Admins always see the full global folder list
            config = load_config()
            result = config.get('folders', [])
        else:
            config = load_profile_config(profile_id)
            result = config.get('folders', [])
    else:
        # Fallback: global config
        config = load_config()
        result = config.get('folders', [])

    try:
        from flask import g
        g._homefeed_current_folders = result
    except RuntimeError:
        pass
    return result


def get_profiles_enabled() -> bool:
    """Return True if the profiles feature is enabled in config."""
    from app.services.data import load_config
    config = load_config()
    return bool(config.get('profiles_enabled', False))


def is_profiles_enabled() -> bool:
    """Check if profiles feature is enabled (alias for get_profiles_enabled)."""
    return get_profiles_enabled()


def is_profiles_active() -> bool:
    """Return True only when profiles exist AND the feature is enabled in config.

    Use this (not profiles_exist()) when deciding whether to route data to
    per-profile files.  When the admin toggles 'Enable Profiles' off, this
    returns False so every read/write falls back to the global top-level files,
    giving the app the same behaviour as if profiles had never been created.

    Result is cached on flask.g for the duration of the current request.
    """
    try:
        from flask import g
        cached = getattr(g, '_homefeed_profiles_active', _UNSET)
        if cached is not _UNSET:
            return cached
    except RuntimeError:
        pass

    result = profiles_exist() and get_profiles_enabled()

    try:
        from flask import g
        g._homefeed_profiles_active = result
    except RuntimeError:
        pass
    return result
