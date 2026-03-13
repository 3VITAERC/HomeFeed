"""
Image optimization services for HomeFeed.
Handles thumbnail generation and video poster extraction.
"""

import os
import hashlib
import subprocess
import logging
from collections import OrderedDict
from typing import Optional

from app.config import (
    THUMBNAIL_DIR,
    THUMBNAIL_MAX_SIZE,
    THUMBNAIL_QUALITY,
)

logger = logging.getLogger(__name__)

# In-process LRU cache for extracted audio bytes.
# Keyed by (video_path, mtime) so the entry auto-invalidates when the file changes.
# 8 slots covers a typical scroll session without unbounded memory growth.
# _AUDIO_NO_TRACK is stored for videos that have no audio track so we don't
# re-run ffmpeg on every request for a silent video.
_audio_cache: OrderedDict = OrderedDict()
_AUDIO_CACHE_MAX = 8
_AUDIO_NO_TRACK = object()  # sentinel: ffmpeg confirmed no audio track


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


def extract_video_audio(video_path: str) -> Optional[bytes]:
    """Extract the audio track from a video file and return it as bytes.

    Uses ffmpeg to transcode the audio stream to AAC 128k in an M4A
    container with the moov atom at the front (faststart) so it is
    immediately seekable by the browser. Transcoding (rather than stream
    copy) ensures compatibility with any input audio codec.

    The result is held in memory only — no file is left on disk.
    Results are cached in an in-process LRU cache (8 slots) keyed by
    (path, mtime) so repeated requests — including iOS range probes —
    are served from memory in <1 ms without re-running ffmpeg.

    Args:
        video_path: Absolute path to the source video file.

    Returns:
        bytes of the M4A audio file, or None if extraction fails
        (e.g. no audio track, ffmpeg not installed, timeout).
    """
    import tempfile

    # Build cache key from path + mtime so we auto-invalidate on file change.
    try:
        mtime = os.path.getmtime(video_path)
    except OSError:
        mtime = 0
    cache_key = (video_path, mtime)

    if cache_key in _audio_cache:
        _audio_cache.move_to_end(cache_key)
        cached = _audio_cache[cache_key]
        return None if cached is _AUDIO_NO_TRACK else cached

    tmp_fd, tmp_path = tempfile.mkstemp(suffix='.m4a')
    os.close(tmp_fd)

    audio_bytes: Optional[bytes] = None
    try:
        cmd = [
            'ffmpeg',
            '-y',                    # overwrite temp file without prompting
            '-i', video_path,
            '-vn',                   # strip video stream
            '-acodec', 'aac',        # transcode to AAC — handles any input codec
            '-b:a', '128k',          # standard quality, ~1MB/min
            '-movflags', 'faststart', # moov atom at front for instant seek
            tmp_path,
        ]

        result = subprocess.run(
            cmd,
            capture_output=True,
            timeout=30,
        )

        if result.returncode != 0 or not os.path.exists(tmp_path):
            # Log the tail of stderr — the banner fills the first ~200 chars,
            # the actual error is always at the end.
            stderr_tail = result.stderr.decode(errors='replace')[-400:]
            logger.warning(
                "ffmpeg audio extraction failed for %s: ...%s",
                video_path,
                stderr_tail,
            )
            # Cache the "no audio" result so we don't re-run ffmpeg for this
            # file on every subsequent request (e.g. preload fetches, iOS probes).
            _audio_cache[cache_key] = _AUDIO_NO_TRACK
            _audio_cache.move_to_end(cache_key)
            if len(_audio_cache) > _AUDIO_CACHE_MAX:
                _audio_cache.popitem(last=False)
            return None

        size = os.path.getsize(tmp_path)
        if size == 0:
            logger.warning("ffmpeg produced empty audio for %s (no audio track?)", video_path)
            _audio_cache[cache_key] = _AUDIO_NO_TRACK
            _audio_cache.move_to_end(cache_key)
            if len(_audio_cache) > _AUDIO_CACHE_MAX:
                _audio_cache.popitem(last=False)
            return None

        with open(tmp_path, 'rb') as f:
            audio_bytes = f.read()

    except subprocess.TimeoutExpired:
        logger.warning("Timeout extracting audio from %s", video_path)
        return None
    except FileNotFoundError:
        logger.warning("ffmpeg not found — audio extraction requires ffmpeg")
        return None
    except Exception as e:
        logger.error("Error extracting audio from %s: %s", video_path, e)
        return None
    finally:
        if os.path.exists(tmp_path):
            os.unlink(tmp_path)

    if audio_bytes is not None:
        _audio_cache[cache_key] = audio_bytes
        _audio_cache.move_to_end(cache_key)
        if len(_audio_cache) > _AUDIO_CACHE_MAX:
            _audio_cache.popitem(last=False)  # evict least-recently-used

    return audio_bytes
