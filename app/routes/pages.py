"""
Page routes for HomeFeed.
Handles serving HTML pages and static files.
"""

from flask import Blueprint, send_file, send_from_directory, current_app

import os


pages_bp = Blueprint('pages', __name__)

# Project root directory (where static/ folder is located)
PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


@pages_bp.route('/')
def index():
    """Main page - always serves index.html which has settings modal."""
    index_path = os.path.join(PROJECT_ROOT, 'static', 'index.html')
    return send_file(index_path)


@pages_bp.route('/settings')
def settings():
    """Legacy URL: serves main page for backward compatibility with old bookmarks."""
    index_path = os.path.join(PROJECT_ROOT, 'static', 'index.html')
    return send_file(index_path)


@pages_bp.route('/scroll')
def scroll_view():
    """Legacy URL: serves main page for backward compatibility with old bookmarks."""
    index_path = os.path.join(PROJECT_ROOT, 'static', 'index.html')
    return send_file(index_path)


@pages_bp.route('/static/<path:filename>')
def serve_static(filename):
    """Serve static files."""
    static_folder = os.path.join(PROJECT_ROOT, 'static')
    return send_from_directory(static_folder, filename)
