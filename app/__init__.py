"""
HomeFeed - Flask Application Factory.
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
    from app.config import CONFIG_FILE, FAVORITES_FILE, TRASH_FILE, SEEN_FILE, COMMENTS_FILE, DEFAULT_OPTIMIZATIONS, PROFILES_DIR, PROFILES_FILE

    defaults = {
        CONFIG_FILE: {
            'folders': [],
            'shuffle': False,
            'optimizations': DEFAULT_OPTIMIZATIONS
        },
        FAVORITES_FILE: {'favorites': []},
        TRASH_FILE: {'trash': []},
        SEEN_FILE: {'seen': {}, 'total_scrolls': 0},
        PROFILES_FILE: {'profiles': []},
        COMMENTS_FILE: {},
    }

    for filepath, default_content in defaults.items():
        if not os.path.exists(filepath):
            with open(filepath, 'w') as f:
                json.dump(default_content, f, indent=2)

    # Ensure profiles directory exists
    os.makedirs(PROFILES_DIR, exist_ok=True)


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
    app.config['SECRET_KEY'] = os.environ.get('HOMEFEED_SECRET_KEY', os.urandom(24).hex())
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
    from app.routes.seen import seen_bp
    from app.routes.profiles import profiles_bp
    from app.routes.comments import comments_bp

    app.register_blueprint(images_bp)
    app.register_blueprint(folders_bp)
    app.register_blueprint(favorites_bp)
    app.register_blueprint(trash_bp)
    app.register_blueprint(cache_bp)
    app.register_blueprint(pages_bp)
    app.register_blueprint(auth_bp)
    app.register_blueprint(seen_bp)
    app.register_blueprint(profiles_bp)
    app.register_blueprint(comments_bp)

    # Add authentication and profile checks before each request
    from app.services import is_auth_enabled, is_authenticated
    from app.services.profiles import is_profiles_active, is_profile_selected

    @app.before_request
    def check_auth():
        """Check authentication and profile selection before each request.

        Order:
        1. If global password auth is enabled, require it first.
        2. If profiles are enabled and configured, require a profile to be selected.

        Skipped for:
        - Auth-related routes (/login, /api/auth/*)
        - Profile-related routes (/profiles, /api/profiles/*)
        - Static files
        """
        # Always allow static files
        if request.path.startswith('/static/'):
            return None

        # ---- Step 1: Global password auth ----
        if is_auth_enabled():
            # Allow auth routes
            if request.endpoint and request.endpoint.startswith('auth.'):
                return None

            if not is_authenticated():
                if request.accept_mimetypes.accept_html:
                    return redirect(url_for('auth.login_page'))
                return jsonify({'error': 'Authentication required'}), 401

        # ---- Step 2: Profile selection ----
        # is_profiles_active() = profiles_enabled AND profiles_exist().
        # Both underlying reads are served from in-memory cache and the result
        # is also cached on flask.g for the rest of this request.
        if not is_profiles_active():
            return None

        # Allow profile routes (picker, login, etc.)
        if request.endpoint and request.endpoint.startswith('profiles.'):
            return None

        # Allow settings routes so the app can read config (GET is public; POST is admin-gated)
        if request.endpoint and request.endpoint.startswith('cache.'):
            return None

        # profiles_exist() is already confirmed true by is_profiles_active() above
        if not is_profile_selected():
            if request.accept_mimetypes.accept_html:
                return redirect(url_for('profiles.profile_picker'))
            return jsonify({'error': 'Profile selection required'}), 401

        return None

    return app
