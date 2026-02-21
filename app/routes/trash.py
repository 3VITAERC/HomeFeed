"""
Trash management routes for LocalFeed.
Handles marking, unmarking, and deleting images.
"""

import os
from urllib.parse import quote, unquote
from flask import Blueprint, request, jsonify

from app.services.data import (
    load_favorites,
    save_favorites,
    load_trash,
    save_trash,
    cleanup_trash,
    cleanup_favorites,
)
from app.services.path_utils import (
    normalize_path,
    is_path_allowed,
    format_image_url,
    extract_path_from_url,
)
from app.services.image_cache import invalidate_cache


trash_bp = Blueprint('trash', __name__)


@trash_bp.route('/api/trash', methods=['GET'])
def get_trash():
    """Get list of trashed image paths (as URL paths for frontend compatibility)."""
    trash = cleanup_trash()
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
    
    trash = load_trash()
    
    if path not in trash:
        trash.append(path)
        save_trash(trash)
        
        # Mutual exclusion: remove from favorites if present
        favorites = load_favorites()
        if path in favorites:
            favorites.remove(path)
            save_favorites(favorites)
    
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
    
    trash = load_trash()
    
    if path in trash:
        trash.remove(path)
        save_trash(trash)
    
    return jsonify({'success': True, 'trash': trash})


@trash_bp.route('/api/trash/images', methods=['GET'])
def get_trash_images():
    """Get trashed images as URLs (filtered to existing files only)."""
    sort_order = request.args.get('sort', 'newest')
    trash = cleanup_trash()
    # Sort by modification time
    trash.sort(key=lambda x: os.path.getmtime(x) if os.path.exists(x) else 0, reverse=(sort_order == 'newest'))
    # URL-encode paths for Windows compatibility
    image_urls = [format_image_url(img) for img in trash]
    return jsonify(image_urls)


@trash_bp.route('/api/trash/count', methods=['GET'])
def get_trash_count():
    """Get count of trashed images."""
    trash = cleanup_trash()
    return jsonify({'count': len(trash)})


@trash_bp.route('/api/trash/empty', methods=['POST'])
def empty_trash():
    """Delete all trashed images from disk permanently.
    
    This is a destructive operation that requires explicit confirmation.
    Returns count of deleted files and any errors encountered.
    """
    trash = load_trash()
    
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
    save_trash([])
    
    # Also cleanup favorites to remove any deleted files
    cleanup_favorites()
    
    # Invalidate image cache so deleted files don't appear
    invalidate_cache()
    
    return jsonify({
        'success': True,
        'deleted_count': deleted_count,
        'errors': errors
    })
