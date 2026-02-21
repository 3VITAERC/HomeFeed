"""
Image optimization services for LocalFeed.
Handles thumbnail generation and video poster extraction.
"""

import os
import hashlib
import subprocess
import logging
from typing import Optional

from app.config import (
    THUMBNAIL_DIR,
    THUMBNAIL_MAX_SIZE,
    THUMBNAIL_QUALITY,
)

logger = logging.getLogger(__name__)


def ensure_thumbnail_dir() -> None:
    """Ensure the thumbnail cache directory exists."""
    if not os.path.exists(THUMBNAIL_DIR):
        os.makedirs(THUMBNAIL_DIR, exist_ok=True)


def get_thumbnail_path(image_path: str, file_mtime: int, file_size: int) -> str:
    """Generate a unique cache path for a thumbnail based on image path and stats.
    
    Args:
        image_path: Path to the source image
        file_mtime: Modification time of the source file
        file_size: Size of the source file in bytes
        
    Returns:
        Path where the thumbnail should be stored
    """
    # Include cache version to invalidate old caches when we fix bugs
    # Version 2: Added EXIF orientation handling
    CACHE_VERSION = 2
    cache_key = hashlib.md5(f"{image_path}:{file_mtime}:{file_size}:v{CACHE_VERSION}".encode()).hexdigest()
    return os.path.join(THUMBNAIL_DIR, f"{cache_key}.webp")


def create_thumbnail(
    source_path: str,
    target_path: str,
    max_size: int = THUMBNAIL_MAX_SIZE,
    quality: int = THUMBNAIL_QUALITY
) -> bool:
    """Create a resized WebP thumbnail from an image.
    
    Args:
        source_path: Path to the source image
        target_path: Path where the thumbnail should be saved
        max_size: Maximum width or height (maintains aspect ratio)
        quality: WebP quality (0-100)
    
    Returns:
        bool: True if thumbnail was created successfully
    """
    try:
        from PIL import Image, ImageOps
        
        with Image.open(source_path) as img:
            # Apply EXIF orientation tag (fixes rotated Samsung/iPhone photos)
            # This must be done BEFORE any other operations
            # Note: exif_transpose() returns a new image or None if no EXIF
            transposed = ImageOps.exif_transpose(img)
            if transposed is not None:
                img = transposed
            else:
                logger.debug("No EXIF orientation data for: %s", source_path)
            
            # Handle HEIC format by converting to RGB first
            if img.mode in ('RGBA', 'LA', 'P'):
                # Convert to RGB with white background for transparency
                background = Image.new('RGB', img.size, (255, 255, 255))
                if img.mode == 'P':
                    img = img.convert('RGBA')
                if img.mode in ('RGBA', 'LA'):
                    background.paste(img, mask=img.split()[-1])  # Use alpha channel as mask
                    img = background
                else:
                    img = img.convert('RGB')
            elif img.mode != 'RGB':
                img = img.convert('RGB')
            
            # Get original dimensions
            width, height = img.size
            
            # Only resize if image is larger than max_size
            if width > max_size or height > max_size:
                # Calculate new dimensions maintaining aspect ratio
                if width > height:
                    new_width = max_size
                    new_height = int(height * (max_size / width))
                else:
                    new_height = max_size
                    new_width = int(width * (max_size / height))
                
                # Use high-quality resampling
                img = img.resize((new_width, new_height), Image.Resampling.LANCZOS)
            
            # Save as WebP
            img.save(target_path, 'WebP', quality=quality)
            return True
            
    except Exception as e:
            logger.error("Error creating thumbnail for %s: %s", source_path, e)
            return False


def create_video_poster(
    video_path: str,
    target_path: str,
    max_size: int = THUMBNAIL_MAX_SIZE,
    quality: int = THUMBNAIL_QUALITY
) -> bool:
    """Extract a poster frame from a video file.
    
    Creates a JPEG image from the first frame of a video for instant display
    while the video loads in the background.
    
    Args:
        video_path: Path to the source video file
        target_path: Path where the poster image should be saved
        max_size: Maximum width or height (maintains aspect ratio)
        quality: JPEG quality (0-100)
    
    Returns:
        bool: True if poster was created successfully
    """
    try:
        # Build ffmpeg command to extract first frame
        # -ss 00:00:00.001 seeks to 1ms (avoids potential black frames at start)
        # -vframes 1 extracts only one frame
        # -vf scale ensures proper sizing
        cmd = [
            'ffmpeg',
            '-ss', '00:00:00.001',
            '-i', video_path,
            '-vframes', '1',
            '-vf', f'scale=-2:{max_size}:flags=lanczos',
            '-q:v', str(max(1, 31 - (quality * 30 // 100))),  # Convert quality to ffmpeg q:v scale
            '-y',  # Overwrite output file
            target_path
        ]
        
        # Run ffmpeg
        result = subprocess.run(
            cmd,
            capture_output=True,
            timeout=10  # 10 second timeout for frame extraction
        )
        
        if result.returncode == 0 and os.path.exists(target_path):
            return True
        else:
            logger.error("ffmpeg error extracting poster from %s: %s", video_path, result.stderr.decode()[:500])
            return False
            
    except subprocess.TimeoutExpired:
        logger.warning("Timeout extracting video poster: %s", video_path)
        return False
    except FileNotFoundError:
        logger.warning("ffmpeg not found - video poster extraction requires ffmpeg")
        return False
    except Exception as e:
        logger.error("Error extracting video poster %s: %s", video_path, e)
        return False


def get_cache_key(file_path: str, optimization_type: str) -> str:
    """Generate a cache key for an optimized file.
    
    Args:
        file_path: Path to the source file
        optimization_type: Type of optimization (e.g., 'thumb', 'webm', 'poster')
        
    Returns:
        A unique cache key string
    """
    mtime = os.path.getmtime(file_path)
    size = os.path.getsize(file_path)
    return hashlib.md5(f"{file_path}_{mtime}_{size}_{optimization_type}".encode()).hexdigest()
