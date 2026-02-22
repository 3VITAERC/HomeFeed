"""
Cache and settings routes for LocalFeed.
Handles cache management and application settings.
"""

import os
from flask import Blueprint, request, jsonify

from app.config import (
    THUMBNAIL_DIR,
    DEFAULT_OPTIMIZATIONS,
)
from app.services.data import (
    load_config,
    save_config,
    get_optimization_settings,
    save_optimization_settings,
)
from app.services.image_cache import invalidate_cache


cache_bp = Blueprint('cache', __name__)


@cache_bp.route('/api/settings', methods=['GET'])
def get_settings():
    """Get user settings."""
    config = load_config()
    return jsonify({
        'shuffle': config.get('shuffle', False),
        'optimizations': get_optimization_settings()
    })


@cache_bp.route('/api/settings', methods=['POST'])
def update_settings():
    """Update user settings."""
    data = request.get_json()
    config = load_config()

    if 'shuffle' in data:
        config['shuffle'] = bool(data['shuffle'])

    if 'optimizations' in data:
        # Update only provided optimization settings
        current_optimizations = get_optimization_settings()
        date_source_changed = False

        for key, value in data['optimizations'].items():
            if key in DEFAULT_OPTIMIZATIONS:
                if key == 'date_source':
                    # Validate: only 'mtime' or 'ctime' are accepted
                    if value in ('mtime', 'ctime'):
                        if current_optimizations.get('date_source') != value:
                            date_source_changed = True
                        current_optimizations['date_source'] = value
                elif key in ('auto_advance_delay', 'preload_distance'):
                    current_optimizations[key] = int(value)
                else:
                    current_optimizations[key] = bool(value)

        config['optimizations'] = current_optimizations

        # Bust image cache when date_source changes — effective dates must be recomputed
        if date_source_changed:
            invalidate_cache()

    save_config(config)
    return jsonify({
        'success': True,
        'settings': {
            'shuffle': config.get('shuffle', False),
            'optimizations': get_optimization_settings()
        }
    })


@cache_bp.route('/api/cache', methods=['GET'])
def get_cache_info():
    """Get information about the cache."""
    cache_size = 0
    cache_files = 0
    
    if os.path.exists(THUMBNAIL_DIR):
        for root, dirs, files in os.walk(THUMBNAIL_DIR):
            for f in files:
                try:
                    cache_files += 1
                    cache_size += os.path.getsize(os.path.join(root, f))
                except OSError:
                    pass
    
    # Format size
    if cache_size < 1024:
        size_str = f"{cache_size} B"
    elif cache_size < 1024 * 1024:
        size_str = f"{cache_size / 1024:.1f} KB"
    else:
        size_str = f"{cache_size / (1024 * 1024):.1f} MB"
    
    return jsonify({
        'files': cache_files,
        'size': cache_size,
        'size_formatted': size_str
    })


@cache_bp.route('/api/cache', methods=['DELETE'])
def clear_cache():
    """Clear all cached files (thumbnails, WebM conversions, video posters)."""
    deleted_count = 0
    errors = []
    
    if os.path.exists(THUMBNAIL_DIR):
        for root, dirs, files in os.walk(THUMBNAIL_DIR):
            for f in files:
                try:
                    os.remove(os.path.join(root, f))
                    deleted_count += 1
                except Exception as e:
                    errors.append({'file': f, 'error': str(e)})
    
    return jsonify({
        'success': True,
        'deleted_count': deleted_count,
        'errors': errors
    })
