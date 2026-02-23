"""
Path utilities for HomeFeed.
Handles path validation, normalization, and security checks.
"""

import os
from typing import Optional, Tuple, Dict, Any
from urllib.parse import quote, unquote

from app.config import (
    CONFIG_FILE,
    THUMBNAIL_DIR,
    SUPPORTED_FORMATS,
    VIDEO_FORMATS,
    MAX_VIDEO_SIZE,
)


def _load_config() -> Dict[str, Any]:
    """Load configuration - imported here to avoid circular imports."""
    from app.services.data import load_config
    return load_config()


def _get_optimization_settings() -> Dict[str, bool]:
    """Get optimization settings - imported here to avoid circular imports."""
    from app.services.data import get_optimization_settings
    return get_optimization_settings()


def expand_path(path_str: str) -> str:
    """Expand ~ to home directory and normalize path.
    
    Args:
        path_str: The path string to expand
        
    Returns:
        The expanded path
    """
    return os.path.expanduser(path_str)


def normalize_path(path_str: str) -> str:
    """Expand and normalize a path for consistent comparison.
    
    Args:
        path_str: The path string to normalize
        
    Returns:
        The normalized path
    """
    return os.path.normpath(expand_path(path_str))


def is_path_allowed(path_to_check: str) -> bool:
    """Check if a path is within the allowed folders for the current session.

    When profiles are active this checks the current profile's folder list.
    Falls back to the global config when profiles are not in use.
    Also allows paths within the thumbnail cache directory.

    Args:
        path_to_check: The path to validate (should be already expanded/normalized)

    Returns:
        bool: True if path is within an allowed folder
    """
    from app.services.profiles import get_current_folders
    folders = get_current_folders()
    for folder in folders:
        folder_normalized = normalize_path(folder)
        if path_to_check.startswith(folder_normalized):
            return True
    # Always allow the thumbnail cache directory
    thumb_normalized = normalize_path(THUMBNAIL_DIR)
    if path_to_check.startswith(thumb_normalized):
        return True
    return False


def validate_and_normalize_path(request_path: Optional[str]) -> Tuple[Optional[str], Optional[Tuple[Dict[str, str], int]]]:
    """Validate, decode, and normalize a path from a request.
    
    Args:
        request_path: Raw path from request args (may be URL-encoded)
    
    Returns:
        tuple: (normalized_path, error_response)
               normalized_path is None if validation fails
               error_response is a tuple (error_dict, status_code) or None on success
    """
    if not request_path:
        return None, ({'error': 'Path parameter required'}, 400)
    
    # URL-decode and normalize
    decoded_path = unquote(request_path)
    normalized = normalize_path(decoded_path)
    
    # Security check
    if not is_path_allowed(normalized):
        return None, ({'error': 'Access denied'}, 403)
    
    return normalized, None


def format_image_url(image_path: str) -> str:
    """Format an image path as a URL-encoded URL.
    
    Uses /thumbnail endpoint for optimized display performance when enabled.
    Falls back to /image when optimization is disabled.
    
    Args:
        image_path: The full path to the image file
        
    Returns:
        A URL string for the image
    """
    optimizations = _get_optimization_settings()
    if optimizations.get('thumbnail_cache', False):
        return f'/thumbnail?path={quote(image_path, safe="")}'
    else:
        return f'/image?path={quote(image_path, safe="")}'


def extract_path_from_url(url_path: str) -> str:
    """Extract the actual file path from a URL format.
    
    Handles both /thumbnail?path= and /image?path= prefixes.
    
    Args:
        url_path: The URL path (e.g., '/image?path=/Users/...')
        
    Returns:
        The decoded file path
    """
    path = url_path
    if path.startswith('/thumbnail?path='):
        path = path.replace('/thumbnail?path=', '', 1)
    elif path.startswith('/image?path='):
        path = path.replace('/image?path=', '', 1)
    return unquote(path)
