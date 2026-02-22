"""
Services module for HomeFeed.
Contains business logic for path handling, caching, optimizations, and auth.
"""

from app.services.path_utils import (
    expand_path,
    normalize_path,
    is_path_allowed,
    validate_and_normalize_path,
    format_image_url,
    extract_path_from_url,
)
from app.services.image_cache import (
    get_all_images,
    get_folder_mtime,
    invalidate_cache,
    get_images_by_folder,
    get_leaf_folders,
)
from app.services.optimizations import (
    ensure_thumbnail_dir,
    get_thumbnail_path,
    create_thumbnail,
    create_video_poster,
)
from app.services.data import (
    load_config,
    save_config,
    get_optimization_settings,
    save_optimization_settings,
    load_favorites,
    save_favorites,
    cleanup_favorites,
    load_trash,
    save_trash,
    cleanup_trash,
)
from app.services.auth import (
    auth,
    is_auth_enabled,
    is_authenticated,
    login_required,
    session_login,
    session_logout,
    generate_csrf_token,
    validate_csrf_token,
)

__all__ = [
    # Path utilities
    'expand_path',
    'normalize_path',
    'is_path_allowed',
    'validate_and_normalize_path',
    'format_image_url',
    'extract_path_from_url',
    # Image cache
    'get_all_images',
    'get_folder_mtime',
    'invalidate_cache',
    'get_images_by_folder',
    'get_leaf_folders',
    # Optimizations
    'ensure_thumbnail_dir',
    'get_thumbnail_path',
    'create_thumbnail',
    'create_video_poster',
    # Data management
    'load_config',
    'save_config',
    'get_optimization_settings',
    'save_optimization_settings',
    'load_favorites',
    'save_favorites',
    'cleanup_favorites',
    'load_trash',
    'save_trash',
    'cleanup_trash',
    # Authentication
    'auth',
    'is_auth_enabled',
    'is_authenticated',
    'login_required',
    'session_login',
    'session_logout',
    'generate_csrf_token',
    'validate_csrf_token',
]
