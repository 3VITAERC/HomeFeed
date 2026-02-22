"""
Seen/Unseen image tracking routes for HomeFeed.
Handles marking images as seen, retrieving stats, and serving the unseen feed.
"""

from urllib.parse import quote
from flask import Blueprint, request, jsonify

from app.services.data import (
    load_seen,
    mark_seen_batch,
    get_seen_stats,
    reset_seen,
)
from app.services.image_cache import get_all_images
from app.services.path_utils import (
    normalize_path,
    extract_path_from_url,
    format_image_url,
)


seen_bp = Blueprint('seen', __name__)


@seen_bp.route('/api/seen/batch', methods=['POST'])
def mark_seen():
    """Mark a batch of image paths as seen.
    
    Accepts a JSON body with a 'paths' array of image URL strings
    (e.g. '/image?path=...') or raw file paths. Both formats are handled.
    
    Returns:
        JSON with updated total_scrolls and seen_count.
    """
    data = request.get_json()
    raw_paths = data.get('paths', [])

    if not isinstance(raw_paths, list) or len(raw_paths) == 0:
        return jsonify({'error': 'paths array is required'}), 400

    # Normalize: accept either URL format (/image?path=...) or raw paths
    normalized = []
    for p in raw_paths:
        extracted = extract_path_from_url(p)
        norm = normalize_path(extracted)
        if norm:
            normalized.append(norm)

    updated = mark_seen_batch(normalized)
    return jsonify({
        'success': True,
        'total_scrolls': updated.get('total_scrolls', 0),
        'seen_count': len(updated.get('seen', {})),
    })


@seen_bp.route('/api/seen/stats', methods=['GET'])
def get_stats():
    """Get seen statistics.
    
    Returns:
        JSON with seen_count, total_count, total_scrolls, percent_seen.
    """
    all_images = get_all_images()
    stats = get_seen_stats(len(all_images))
    return jsonify(stats)


@seen_bp.route('/api/seen', methods=['DELETE'])
def clear_seen():
    """Reset all seen history."""
    reset_seen()
    return jsonify({'success': True})


@seen_bp.route('/api/unseen/images', methods=['GET'])
def get_unseen_images():
    """Return images that have NOT been seen yet.
    
    Excludes images present in the seen dict.
    Respects the same sort order as /api/images.
    
    Returns:
        JSON array of image URL strings (same format as /api/images).
    """
    sort_order = request.args.get('sort', 'newest')

    all_images = get_all_images()

    seen_data = load_seen()
    # Build a set of normalized seen paths for fast lookup
    seen_set = set(normalize_path(p) for p in seen_data.get('seen', {}).keys())

    # Filter: keep only images that are NOT in seen_set
    unseen = [img for img in all_images if normalize_path(img) not in seen_set]

    # Sort: all_images is already sorted newest-first from cache;
    # for oldest-first, reverse.
    if sort_order == 'oldest':
        unseen = list(reversed(unseen))

    # Convert to URL format
    image_urls = [format_image_url(img) for img in unseen]
    return jsonify(image_urls)
