"""
Routes module for LocalFeed.
Contains all Flask blueprints for API endpoints.
"""

from app.routes.images import images_bp
from app.routes.folders import folders_bp
from app.routes.favorites import favorites_bp
from app.routes.trash import trash_bp
from app.routes.cache import cache_bp
from app.routes.pages import pages_bp
from app.routes.auth import auth_bp
from app.routes.seen import seen_bp

__all__ = [
    'images_bp',
    'folders_bp',
    'favorites_bp',
    'trash_bp',
    'cache_bp',
    'pages_bp',
    'auth_bp',
    'seen_bp',
]
