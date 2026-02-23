"""
Trash management routes for HomeFeed.
Handles marking, unmarking, and deleting images.

When profiles are active, reads and writes the current profile's trash list.
Falls back to global trash.json when profiles are not in use.
"""

import os
from urllib.parse import quote, unquote
from flask import Blueprint, request, jsonify

from app.services.data import (
    load_active_favorites,
    save_active_favorites,
    load_active_trash,
    save_active_trash,
    cleanup_active_trash,
    cleanup_active_favorites,
)
from app.services.path_utils import (
    normalize_path,
    is_path_allowed,
    format_image_url,
    extract_path_from_url,
)
from app.services.image_cache import invalidate_cache
from app.services.profiles import is_current_profile_admin


trash_bp = Blueprint('trash', __name__)


@trash_bp.route('/api/trash', methods=['GET'])
def get_trash():
    """Get list of trashed image paths (as URL paths for frontend compatibility)."""
    trash = cleanup_active_trash()
    # Convert to URL format for frontend (URL-encoded for Windows paths)
    trash_urls = [f'/image?path={quote(img, safe="")}' for img in trash]
    return jsonify({'trash': trash_urls})


@trash_bp.route('/api/trash', methods=['POST'])
def add_trash():
    """Add image to trash (and remove from favorites if present - mutual exclusion)."""
    data = request.get_json()
    path = data.get('path', '').strip()

    if not path:
        return jsonify({'error': 'Path is required'}), 400

    # Extract actual file path from URL format if needed
    path = extract_path_from_url(path)

    trash = load_active_trash()

    if path not in trash:
        trash.append(path)
        save_active_trash(trash)

        # Mutual exclusion: remove from favorites if present
        favorites = load_active_favorites()
        if path in favorites:
            favorites.remove(path)
            save_active_favorites(favorites)

    return jsonify({'success': True, 'trash': trash})


@trash_bp.route('/api/trash', methods=['DELETE'])
def remove_trash():
    """Remove image from trash (unmark for deletion)."""
    data = request.get_json()
    path = data.get('path', '').strip()

    if not path:
        return jsonify({'error': 'Path is required'}), 400

    # Extract actual file path from URL format if needed
    path = extract_path_from_url(path)

    trash = load_active_trash()

    if path in trash:
        trash.remove(path)
        save_active_trash(trash)

    return jsonify({'success': True, 'trash': trash})


@trash_bp.route('/api/trash/images', methods=['GET'])
def get_trash_images():
    """Get trashed images as URLs (filtered to existing files only)."""
    sort_order = request.args.get('sort', 'newest')
    trash = cleanup_active_trash()
    # Sort by modification time
    trash.sort(key=lambda x: os.path.getmtime(x) if os.path.exists(x) else 0, reverse=(sort_order == 'newest'))
    # URL-encode paths for Windows compatibility
    image_urls = [format_image_url(img) for img in trash]
    return jsonify(image_urls)


@trash_bp.route('/api/trash/count', methods=['GET'])
def get_trash_count():
    """Get count of trashed images."""
    trash = cleanup_active_trash()
    return jsonify({'count': len(trash)})


@trash_bp.route('/api/trash/empty', methods=['POST'])
def empty_trash():
    """Delete all trashed images from disk permanently.

    This is a destructive operation that requires admin role and explicit confirmation.
    Returns count of deleted files and any errors encountered.
    """
    if not is_current_profile_admin():
        return jsonify({'error': 'Admin role required to empty trash'}), 403

    trash = load_active_trash()

    deleted_count = 0
    errors = []

    for img_path in trash:
        try:
            if os.path.exists(img_path):
                os.remove(img_path)
                deleted_count += 1
        except Exception as e:
            errors.append({'path': img_path, 'error': str(e)})

    # Clear the trash list after deletion attempt
    save_active_trash([])

    # Also cleanup favorites to remove any deleted files
    cleanup_active_favorites()

    # Invalidate image cache so deleted files don't appear
    invalidate_cache()

    return jsonify({
        'success': True,
        'deleted_count': deleted_count,
        'errors': errors
    })
