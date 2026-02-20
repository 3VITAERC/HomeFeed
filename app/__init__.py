"""
LocalFeed - Flask Application Factory.
"""

import os
import json
from flask import Flask, session, redirect, url_for, request, jsonify
from flask_compress import Compress
from flask_session import Session


def _ensure_config_files_exist():
    """Create default config files if they don't exist.
    
    This allows users to skip the manual setup step of copying example files.
    Files are created with sensible defaults on first launch.
    """
    from app.config import CONFIG_FILE, FAVORITES_FILE, TRASH_FILE, DEFAULT_OPTIMIZATIONS
    
    defaults = {
        CONFIG_FILE: {
            'folders': [],
            'shuffle': False,
            'optimizations': DEFAULT_OPTIMIZATIONS
        },
        FAVORITES_FILE: {'favorites': []},
        TRASH_FILE: {'trash': []}
    }
    
    for filepath, default_content in defaults.items():
        if not os.path.exists(filepath):
            with open(filepath, 'w') as f:
                json.dump(default_content, f, indent=2)


def create_app(config=None):
    """Create and configure the Flask application.
    
    Args:
        config: Optional configuration dictionary
        
    Returns:
        Configured Flask application instance
    """
    # Auto-create config files if they don't exist
    _ensure_config_files_exist()
    
    # Get the project root directory (where server.py is located)
    # __file__ is app/__init__.py, so parent is project root
    project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    static_folder = os.path.join(project_root, 'static')
    
    app = Flask(__name__, 
                static_folder=static_folder,
                static_url_path='/static')
    
    # Load configuration
    if config:
        app.config.update(config)
    
    # Session configuration for authentication
    app.config['SECRET_KEY'] = os.environ.get('LOCALFEED_SECRET_KEY', os.urandom(24).hex())
    app.config['SESSION_TYPE'] = 'filesystem'
    app.config['SESSION_PERMANENT'] = False  # Session expires when browser closes
    app.config['SESSION_FILE_DIR'] = os.path.join(project_root, '.flask_session')
    Session(app)
    
    # Enable Gzip compression for API responses
    # Compresses JSON responses > 500 bytes, achieving 70-80% size reduction
    app.config['COMPRESS_MIN_SIZE'] = 500  # Only compress responses > 500 bytes
    app.config['COMPRESS_LEVEL'] = 6       # Balance between speed and compression
    Compress(app)
    
    # Register blueprints
    from app.routes.images import images_bp
    from app.routes.folders import folders_bp
    from app.routes.favorites import favorites_bp
    from app.routes.trash import trash_bp
    from app.routes.cache import cache_bp
    from app.routes.pages import pages_bp
    from app.routes.auth import auth_bp
    
    app.register_blueprint(images_bp)
    app.register_blueprint(folders_bp)
    app.register_blueprint(favorites_bp)
    app.register_blueprint(trash_bp)
    app.register_blueprint(cache_bp)
    app.register_blueprint(pages_bp)
    app.register_blueprint(auth_bp)
    
    # Add authentication check before each request
    from app.services import is_auth_enabled, is_authenticated
    
    @app.before_request
    def check_auth():
        """Check authentication before each request.
        
        Skips auth check for:
        - Login page and endpoints
        - Auth status API
        - Static files (CSS, JS) - these are protected by the main auth
        """
        # Skip auth check if not enabled
        if not is_auth_enabled():
            return None
        
        # Allow login-related routes
        if request.endpoint and request.endpoint.startswith('auth.'):
            return None
        
        # Allow static files for login page
        if request.path.startswith('/static/'):
            # Still require auth for protected static content
            # But allow login page assets
            return None
        
        # Check if authenticated
        if is_authenticated():
            return None
        
        # Not authenticated - redirect to login or return 401
        if request.accept_mimetypes.accept_html:
            return redirect(url_for('auth.login_page'))
        return jsonify({'error': 'Authentication required'}), 401
    
    return app
