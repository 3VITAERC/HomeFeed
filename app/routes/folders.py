"""
Folder management routes for HomeFeed.
Handles adding, removing, and listing configured folders.

When profiles are active, reads and writes the current profile's folder list.
Falls back to global config when profiles are not in use.
"""

import os
from flask import Blueprint, request, jsonify

from app.services.path_utils import normalize_path, expand_path, is_path_allowed
from app.services.image_cache import get_leaf_folders, invalidate_cache
from app.services.profiles import (
    get_current_profile_id,
    is_profiles_active,
    load_profile_config,
    save_profile_config,
    get_current_folders,
    is_current_profile_admin,
)
from app.services.data import load_config, save_config


folders_bp = Blueprint('folders', __name__)


def _get_active_folders():
    """Return (folders_list, save_fn) for the active profile or global config.

    Admin profiles write to the global config (same as the vanilla experience).
    Regular profiles write to their own per-profile config.
    """
    profile_id = get_current_profile_id()
    if profile_id and is_profiles_active():
        if is_current_profile_admin():
            # Admins manage the global folder list
            config = load_config()
            folders = config.get('folders', [])

            def save_fn(updated_folders):
                config['folders'] = updated_folders
                save_config(config)

            return folders, save_fn

        config = load_profile_config(profile_id)
        folders = config.get('folders', [])

        def save_fn(updated_folders):
            config['folders'] = updated_folders
            save_profile_config(profile_id, config)

        return folders, save_fn
    else:
        config = load_config()
        folders = config.get('folders', [])

        def save_fn(updated_folders):
            config['folders'] = updated_folders
            save_config(config)

        return folders, save_fn


@folders_bp.route('/api/folders', methods=['GET'])
def get_folders():
    """Get list of configured folders for the current profile (or global)."""
    folders, _ = _get_active_folders()
    return jsonify(folders)


@folders_bp.route('/api/folders/leaf', methods=['GET'])
def get_leaf_folders_route():
    """Get list of all leaf folders (folders that actually contain images).

    Returns folders with image counts and modification times.
    Uses cached folder data for fast response.
    Sorting is handled by the frontend.
    """
    folders = get_leaf_folders()
    return jsonify(folders)


@folders_bp.route('/api/folders', methods=['POST'])
def add_folder():
    """Add a new folder to the current profile (or global config)."""
    data = request.get_json()
    path = data.get('path', '').strip()

    if not path:
        return jsonify({'error': 'Path is required'}), 400

    # Expand ~ and validate path
    expanded_path = expand_path(path)

    if not os.path.isdir(expanded_path):
        return jsonify({'error': f'Folder not found: {expanded_path}'}), 400

    folders, save_fn = _get_active_folders()

    # Normalize path for storage (use expanded path)
    normalized = os.path.normpath(expanded_path)

    if normalized in folders:
        return jsonify({'error': 'Folder already added'}), 400

    folders.append(normalized)
    save_fn(folders)

    # Invalidate cache since folders changed
    invalidate_cache()

    return jsonify({'success': True, 'folders': folders})


@folders_bp.route('/api/folders', methods=['DELETE'])
def remove_folder():
    """Remove a folder from the current profile (or global config)."""
    data = request.get_json()
    path = data.get('path', '').strip()

    if not path:
        return jsonify({'error': 'Path is required'}), 400

    folders, save_fn = _get_active_folders()

    # Normalize the path to match stored format
    normalized = os.path.normpath(expand_path(path))

    if normalized in folders:
        folders.remove(normalized)
        save_fn(folders)

        # Invalidate cache since folders changed
        invalidate_cache()

    return jsonify({'success': True, 'folders': folders})
