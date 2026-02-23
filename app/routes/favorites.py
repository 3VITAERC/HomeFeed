"""
Favorites management routes for HomeFeed.
Handles adding, removing, and listing favorite images.

When profiles are active, reads and writes the current profile's favorites.
Falls back to global favorites.json when profiles are not in use.
"""

import os
from urllib.parse import quote, unquote
from flask import Blueprint, request, jsonify

from app.services.data import (
    load_active_favorites,
    save_active_favorites,
    cleanup_active_favorites,
    load_active_trash,
    save_active_trash,
)
from app.services.path_utils import (
    normalize_path,
    is_path_allowed,
    format_image_url,
    extract_path_from_url,
)


favorites_bp = Blueprint('favorites', __name__)


@favorites_bp.route('/api/favorites', methods=['GET'])
def get_favorites():
    """Get list of favorited image paths (as URL paths for frontend compatibility)."""
    favorites = cleanup_active_favorites()
    # Convert to URL format for frontend (URL-encoded for Windows paths)
    favorite_urls = [f'/image?path={quote(img, safe="")}' for img in favorites]
    return jsonify({'favorites': favorite_urls})


@favorites_bp.route('/api/favorites', methods=['POST'])
def add_favorite():
    """Add image to favorites."""
    data = request.get_json()
    path = data.get('path', '').strip()

    if not path:
        return jsonify({'error': 'Path is required'}), 400

    # Extract actual file path from URL format if needed
    path = extract_path_from_url(path)

    favorites = load_active_favorites()

    if path not in favorites:
        favorites.append(path)
        save_active_favorites(favorites)

    return jsonify({'success': True, 'favorites': favorites})


@favorites_bp.route('/api/favorites', methods=['DELETE'])
def remove_favorite():
    """Remove image from favorites."""
    data = request.get_json()
    path = data.get('path', '').strip()

    if not path:
        return jsonify({'error': 'Path is required'}), 400

    # Extract actual file path from URL format if needed
    path = extract_path_from_url(path)

    favorites = load_active_favorites()

    if path in favorites:
        favorites.remove(path)
        save_active_favorites(favorites)

    return jsonify({'success': True, 'favorites': favorites})


@favorites_bp.route('/api/favorites/images', methods=['GET'])
def get_favorite_images():
    """Get favorited images as URLs (filtered to existing files only)."""
    sort_order = request.args.get('sort', 'newest')
    favorites = cleanup_active_favorites()
    # Sort by modification time
    favorites.sort(key=lambda x: os.path.getmtime(x) if os.path.exists(x) else 0, reverse=(sort_order == 'newest'))
    # URL-encode paths for Windows compatibility
    image_urls = [format_image_url(img) for img in favorites]
    return jsonify(image_urls)


@favorites_bp.route('/api/favorites/images/folder', methods=['GET'])
def get_favorite_images_by_folder():
    """Get favorited images from a specific folder."""
    folder_path = request.args.get('folder')
    sort_order = request.args.get('sort', 'newest')

    if not folder_path:
        return jsonify({'error': 'Folder parameter required'}), 400

    # URL-decode and normalize
    folder_path = normalize_path(unquote(folder_path))

    # Security check - verify folder is within allowed folders
    if not is_path_allowed(folder_path):
        return jsonify({'error': 'Access denied'}), 403

    # Get favorites and filter by folder
    favorites = cleanup_active_favorites()
    filtered = [img for img in favorites if os.path.dirname(img) == folder_path]

    # Sort by modification time
    filtered.sort(key=lambda x: os.path.getmtime(x) if os.path.exists(x) else 0, reverse=(sort_order == 'newest'))

    # Return as URLs
    image_urls = [format_image_url(img) for img in filtered]
    return jsonify(image_urls)


@favorites_bp.route('/api/favorites/count', methods=['GET'])
def get_favorites_count():
    """Get count of favorited images."""
    favorites = cleanup_active_favorites()
    return jsonify({'count': len(favorites)})
