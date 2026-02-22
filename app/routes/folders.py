"""
Folder management routes for HomeFeed.
Handles adding, removing, and listing configured folders.
"""

import os
from urllib.parse import unquote
from flask import Blueprint, request, jsonify

from app.services.data import load_config, save_config
from app.services.path_utils import normalize_path, expand_path, is_path_allowed
from app.services.image_cache import get_leaf_folders, invalidate_cache


folders_bp = Blueprint('folders', __name__)


@folders_bp.route('/api/folders', methods=['GET'])
def get_folders():
    """Get list of configured folders."""
    config = load_config()
    return jsonify(config.get('folders', []))


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
    """Add a new folder to the configuration."""
    data = request.get_json()
    path = data.get('path', '').strip()
    
    if not path:
        return jsonify({'error': 'Path is required'}), 400
    
    # Expand ~ and validate path
    expanded_path = expand_path(path)
    
    if not os.path.isdir(expanded_path):
        return jsonify({'error': f'Folder not found: {expanded_path}'}), 400
    
    config = load_config()
    folders = config.get('folders', [])
    
    # Normalize path for storage (use expanded path)
    normalized = os.path.normpath(expanded_path)
    
    if normalized in folders:
        return jsonify({'error': 'Folder already added'}), 400
    
    folders.append(normalized)
    config['folders'] = folders
    save_config(config)
    
    # Invalidate cache since folders changed
    invalidate_cache()
    
    return jsonify({'success': True, 'folders': folders})


@folders_bp.route('/api/folders', methods=['DELETE'])
def remove_folder():
    """Remove a folder from the configuration."""
    data = request.get_json()
    path = data.get('path', '').strip()
    
    if not path:
        return jsonify({'error': 'Path is required'}), 400
    
    config = load_config()
    folders = config.get('folders', [])
    
    # Normalize the path to match stored format
    normalized = os.path.normpath(expand_path(path))
    
    if normalized in folders:
        folders.remove(normalized)
        config['folders'] = folders
        save_config(config)
        
        # Invalidate cache since folders changed
        invalidate_cache()
    
    return jsonify({'success': True, 'folders': folders})
