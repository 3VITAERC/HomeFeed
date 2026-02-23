"""
Configuration constants and settings for HomeFeed.
"""

import os
from typing import Set, Dict, Any

# Base directory for the application
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Data file paths
CONFIG_FILE = os.path.join(BASE_DIR, 'config.json')
FAVORITES_FILE = os.path.join(BASE_DIR, 'favorites.json')
TRASH_FILE = os.path.join(BASE_DIR, 'trash.json')
THUMBNAIL_DIR = os.path.join(BASE_DIR, '.thumbnails')
SEEN_FILE = os.path.join(BASE_DIR, 'seen.json')

# Profiles
PROFILES_FILE = os.path.join(BASE_DIR, 'profiles.json')
PROFILES_DIR = os.path.join(BASE_DIR, 'profiles')

# Supported file formats
SUPPORTED_FORMATS: Set[str] = {'.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic', '.m4v', '.mp4', '.mov'}
VIDEO_FORMATS: Set[str] = {'.m4v', '.mp4', '.mov', '.webm'}
GIF_FORMATS: Set[str] = {'.gif'}

# Size limits
MAX_VIDEO_SIZE = 75 * 1024 * 1024  # 75 MB limit for videos

# Thumbnail settings
THUMBNAIL_MAX_SIZE = 1920  # Max width/height for thumbnails
THUMBNAIL_QUALITY = 85  # WebP quality (0-100)

# Image list cache settings
CACHE_TTL = 30  # seconds
CACHE_TTL_HDD = 300  # seconds — used when hdd_friendly is enabled

# Default optimization settings
DEFAULT_OPTIMIZATIONS: Dict[str, Any] = {
    'thumbnail_cache': False,
    'video_poster_cache': False,
    'fill_screen': False,
    'auto_advance': False,
    'auto_advance_delay': 3,
    'preload_distance': 3,  # Number of slides to preload ahead (0-10)
    'date_source': 'mtime',  # Filesystem fallback when EXIF date absent: 'mtime' or 'ctime'
    'hdd_friendly': False,
}

# Mime types for image serving
MIME_TYPES: Dict[str, str] = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.heic': 'image/heic',
    '.m4v': 'video/mp4',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.mov': 'video/quicktime'
}
