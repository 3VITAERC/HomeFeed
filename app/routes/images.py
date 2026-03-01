"""
Image serving routes for HomeFeed.
Handles serving images, thumbnails, GIF conversions, and video posters.
"""

import os
import time
import hashlib
import logging
from pathlib import Path
from urllib.parse import unquote
from flask import Blueprint, request, jsonify, make_response, send_file

logger = logging.getLogger(__name__)

from app.config import (
    MIME_TYPES,
    VIDEO_FORMATS,
    GIF_FORMATS,
    THUMBNAIL_DIR,
)
from app.services.path_utils import (
    normalize_path,
    is_path_allowed,
    validate_and_normalize_path,
    format_image_url,
)
from app.services.image_cache import get_all_images, get_images_by_folder
from app.services.optimizations import (
    ensure_thumbnail_dir,
    get_thumbnail_path,
    create_thumbnail,
    create_video_poster,
)
from app.services.data import get_optimization_settings


images_bp = Blueprint('images', __name__)


@images_bp.route('/api/images', methods=['GET'])
def get_images():
    """Get list of all images from configured folders."""
    sort_order = request.args.get('sort', 'newest')
    images = get_all_images()
    
    # Sort images if needed
    if sort_order == 'oldest':
        # Reverse the order (oldest first)
        images = images[::-1]
    
    # Return relative URLs for the images (URL-encoded for Windows paths)
    image_urls = [format_image_url(img) for img in images]
    return jsonify(image_urls)


@images_bp.route('/api/images/folder', methods=['GET'])
def get_images_by_folder_route():
    """Get list of images from a specific folder."""
    folder_path = request.args.get('folder')
    sort_order = request.args.get('sort', 'newest')
    
    if not folder_path:
        return jsonify({'error': 'Folder parameter required'}), 400
    
    # URL-decode and normalize
    folder_path = normalize_path(unquote(folder_path))
    
    # Security: verify folder is within allowed folders
    if not is_path_allowed(folder_path):
        return jsonify({'error': 'Access denied'}), 403
    
    # Get images filtered by folder
    filtered_images = get_images_by_folder(folder_path)
    
    # Sort images if needed
    if sort_order == 'oldest':
        # Reverse the order (oldest first)
        filtered_images = filtered_images[::-1]
    
    # Return as URLs
    image_urls = [format_image_url(img) for img in filtered_images]
    return jsonify(image_urls)


@images_bp.route('/api/images/subtree', methods=['GET'])
def get_images_by_subtree_route():
    """Get images from all subfolders under a path prefix.

    Used by the folder-grouping feature: when a grouped folder node is
    clicked, the frontend asks for every image whose directory starts with
    the group prefix.

    Query params:
        prefix: Path prefix (required)
        sort:   'newest' (default) or 'oldest'
    """
    prefix = request.args.get('prefix')
    sort_order = request.args.get('sort', 'newest')

    if not prefix:
        return jsonify({'error': 'prefix parameter required'}), 400

    # URL-decode and normalize
    prefix = normalize_path(unquote(prefix))

    # Security: verify the prefix is within allowed folders
    if not is_path_allowed(prefix):
        return jsonify({'error': 'Access denied'}), 403

    # Filter all images whose path starts with prefix + os.sep (or exactly prefix)
    all_images = get_all_images()
    prefix_with_sep = prefix + os.sep
    filtered = [img for img in all_images if img.startswith(prefix_with_sep) or os.path.dirname(img) == prefix]

    if sort_order == 'oldest':
        filtered = filtered[::-1]

    image_urls = [format_image_url(img) for img in filtered]
    return jsonify(image_urls)


@images_bp.route('/api/image-count', methods=['GET'])
def get_image_count():
    """Get count of images and folders."""
    from app.services.data import load_config
    config = load_config()
    images = get_all_images()
    return jsonify({
        'imageCount': len(images),
        'folderCount': len(config.get('folders', []))
    })


@images_bp.route('/api/metadata', methods=['GET'])
def get_image_metadata():
    """Get metadata for an image including dimensions, dates, file size, etc."""
    image_path = request.args.get('path')
    
    # Validate and normalize path
    expanded_image, error = validate_and_normalize_path(image_path)
    if error:
        return jsonify(error[0]), error[1]
    
    if not os.path.exists(expanded_image):
        return jsonify({'error': 'Image not found'}), 404
    
    try:
        # Get file stats
        file_stat = os.stat(expanded_image)
        
        # Format dates
        from datetime import datetime
        created_time = datetime.fromtimestamp(file_stat.st_ctime).strftime('%Y-%m-%d %H:%M:%S')
        modified_time = datetime.fromtimestamp(file_stat.st_mtime).strftime('%Y-%m-%d %H:%M:%S')
        
        # Get file size in human-readable format
        size_bytes = file_stat.st_size
        if size_bytes < 1024:
            size_str = f"{size_bytes} B"
        elif size_bytes < 1024 * 1024:
            size_str = f"{size_bytes / 1024:.1f} KB"
        elif size_bytes < 1024 * 1024 * 1024:
            size_str = f"{size_bytes / (1024 * 1024):.1f} MB"
        else:
            size_str = f"{size_bytes / (1024 * 1024 * 1024):.2f} GB"
        
        # Get image dimensions and EXIF data using PIL
        width = None
        height = None
        exif_data = {}
        
        try:
            from PIL import Image
            from PIL.ExifTags import TAGS, GPSTAGS
            
            with Image.open(expanded_image) as img:
                width, height = img.size
                
                # Try to get EXIF data
                try:
                    exif = img._getexif()
                    if exif:
                        for tag_id, value in exif.items():
                            tag = TAGS.get(tag_id, tag_id)
                            
                            # Handle GPS data specially
                            if tag == 'GPSInfo':
                                gps_info = {}
                                for gps_id in value:
                                    gps_tag = GPSTAGS.get(gps_id, gps_id)
                                    gps_info[gps_tag] = _convert_exif_value(value[gps_id])
                                if gps_info:
                                    exif_data['GPS'] = gps_info
                            # Handle common EXIF tags we want to display
                            elif tag in ['Make', 'Model', 'DateTime', 'DateTimeOriginal', 
                                        'ExposureTime', 'FNumber', 'ISOSpeedRatings',
                                        'FocalLength', 'LensModel', 'Software',
                                        'Orientation', 'XResolution', 'YResolution']:
                                exif_data[tag] = _convert_exif_value(value)
                except (AttributeError, KeyError, TypeError):
                    pass  # No EXIF data available
                
        except ImportError:
            # PIL not installed, try without dimensions
            pass
        except Exception:
            # Could not read image dimensions
            pass
        
        # Get file extension
        ext = Path(expanded_image).suffix.lower()
        
        # Calculate aspect ratio
        aspect_ratio = None
        if width and height:
            from math import gcd
            g = gcd(width, height)
            aspect_ratio = f"{width // g}:{height // g}"
        
        metadata = {
            'path': expanded_image,
            'filename': os.path.basename(expanded_image),
            'extension': ext,
            'size_bytes': size_bytes,
            'size_formatted': size_str,
            'created': created_time,
            'modified': modified_time,
            'width': width,
            'height': height,
            'resolution': f"{width} × {height}" if width and height else None,
            'aspect_ratio': aspect_ratio,
            'exif': exif_data if exif_data else None
        }
        
        return jsonify(metadata)
    
    except Exception as e:
        return jsonify({'error': str(e)}), 500


def _convert_exif_value(value):
    """Convert EXIF value to JSON-serializable format.
    
    Handles IFDRational, bytes, tuples, and other non-serializable types.
    """
    # Handle IFDRational (has numerator and denominator)
    if hasattr(value, 'numerator') and hasattr(value, 'denominator'):
        if value.denominator != 0:
            return round(value.numerator / value.denominator, 2)
        return 0
    
    # Handle bytes
    if isinstance(value, bytes):
        try:
            return value.decode('utf-8', errors='ignore').strip('\x00')
        except:
            return str(value)
    
    # Handle tuples (common in GPS data)
    if isinstance(value, tuple):
        return tuple(_convert_exif_value(v) for v in value)
    
    # Handle lists
    if isinstance(value, list):
        return [_convert_exif_value(v) for v in value]
    
    # Handle dict
    if isinstance(value, dict):
        return {k: _convert_exif_value(v) for k, v in value.items()}
    
    return value


def _parse_range_header(range_header, file_size):
    """Parse HTTP Range header and return (start, end) tuple.
    
    Supports formats:
        bytes=0-1023        (explicit range)
        bytes=0-            (from start to end)
        bytes=-1023         (last 1023 bytes)
    
    Returns (None, None) if invalid.
    """
    try:
        # Remove 'bytes=' prefix
        if not range_header.startswith('bytes='):
            return None, None
        
        range_spec = range_header[6:].strip()
        
        # Handle multiple ranges (we only support single range)
        # Just take the first range if multiple specified
        if ',' in range_spec:
            range_spec = range_spec.split(',')[0].strip()
        
        # Parse start and end
        if range_spec.startswith('-'):
            # Suffix range: last N bytes
            suffix_length = int(range_spec[1:])
            start = max(0, file_size - suffix_length)
            end = file_size - 1
        elif range_spec.endswith('-'):
            # Open-ended range: from start to end of file
            start = int(range_spec[:-1])
            end = file_size - 1
        else:
            # Explicit range: start-end
            parts = range_spec.split('-')
            if len(parts) != 2:
                return None, None
            start = int(parts[0])
            end = int(parts[1])
        
        # Validate range
        if start < 0 or end < start or start >= file_size:
            return None, None
        
        # Clamp end to file size
        end = min(end, file_size - 1)
        
        return start, end
    except (ValueError, IndexError):
        return None, None


@images_bp.route('/image')
def serve_image():
    """Serve an image file by path.
    
    For video files, supports HTTP Range requests for streaming.
    This allows browsers to request only the bytes they need,
    enabling instant video start and efficient seeking.
    """
    image_path = request.args.get('path')
    
    if not image_path:
        return 'Path required', 400
    
    # URL-decode and normalize
    expanded_image = normalize_path(unquote(image_path))
    
    # Security: ensure path is within allowed folders
    if not is_path_allowed(expanded_image):
        return 'Access denied', 403
    
    if not os.path.exists(expanded_image):
        return 'Image not found', 404
    
    # Determine mime type
    ext = Path(expanded_image).suffix.lower()
    mime_type = MIME_TYPES.get(ext, 'application/octet-stream')
    
    # Get file stats for caching
    file_stat = os.stat(expanded_image)
    file_mtime = int(file_stat.st_mtime)
    file_size = file_stat.st_size
    
    # Generate ETag based on path, mtime, and size
    etag_hash = hashlib.md5(f"{expanded_image}:{file_mtime}:{file_size}".encode()).hexdigest()
    etag = f'"{etag_hash}"'
    
    # For video files, handle Range requests for streaming
    if ext in VIDEO_FORMATS:
        range_header = request.headers.get('Range')
        
        if range_header:
            # Parse the range request
            start, end = _parse_range_header(range_header, file_size)
            
            if start is not None:
                # Read only the requested chunk
                with open(expanded_image, 'rb') as f:
                    f.seek(start)
                    data = f.read(end - start + 1)
                
                response = make_response(data)
                response.status_code = 206  # Partial Content
                response.headers['Content-Range'] = f'bytes {start}-{end}/{file_size}'
                response.headers['Content-Length'] = len(data)
                response.headers['Content-Type'] = mime_type
                response.headers['Accept-Ranges'] = 'bytes'
                response.headers['Cache-Control'] = 'public, max-age=604800'
                response.headers['ETag'] = etag
                response.headers['Last-Modified'] = time.strftime('%a, %d %b %Y %H:%M:%S GMT', time.gmtime(file_mtime))
                return response
            else:
                # Invalid range - return 416 error
                response = make_response('Requested Range Not Satisfiable')
                response.status_code = 416
                response.headers['Content-Range'] = f'bytes */{file_size}'
                return response
        
        # No Range header for video - still advertise support
        response = make_response(send_file(expanded_image, mimetype=mime_type))
        response.headers['Accept-Ranges'] = 'bytes'
        response.headers['Cache-Control'] = 'public, max-age=604800'
        response.headers['ETag'] = etag
        response.headers['Last-Modified'] = time.strftime('%a, %d %b %Y %H:%M:%S GMT', time.gmtime(file_mtime))
        return response
    
    # Check If-None-Match header for 304 response (images only)
    if request.headers.get('If-None-Match') == etag:
        return '', 304
    
    # Check If-Modified-Since header for 304 response (images only)
    if_modified_since = request.headers.get('If-Modified-Since')
    if if_modified_since:
        try:
            from email.utils import parsedate_to_datetime
            header_time = int(parsedate_to_datetime(if_modified_since).timestamp())
            if header_time >= file_mtime:
                return '', 304
        except (ValueError, TypeError):
            pass
    
    # Create response with caching headers (images)
    response = make_response(send_file(expanded_image, mimetype=mime_type))
    
    # Set caching headers (7 days for images)
    response.headers['Cache-Control'] = 'public, max-age=604800, immutable'
    response.headers['ETag'] = etag
    response.headers['Last-Modified'] = time.strftime('%a, %d %b %Y %H:%M:%S GMT', time.gmtime(file_mtime))
    
    return response


@images_bp.route('/thumbnail')
def serve_thumbnail():
    """Serve a resized WebP thumbnail for an image.
    
    This endpoint dramatically improves performance by:
    1. Resizing images to screen-appropriate dimensions (max 1920px)
    2. Converting to WebP for better compression
    3. Caching thumbnails on disk for subsequent requests
    
    For a 20MB iPhone photo, this serves a ~300KB WebP instead.
    """
    # Check if thumbnail optimization is enabled
    optimizations = get_optimization_settings()
    if not optimizations.get('thumbnail_cache', False):
        # Optimization disabled - fall back to original image
        logger.debug("Thumbnail optimization disabled, serving original")
        return serve_image()
    
    image_path = request.args.get('path')
    
    if not image_path:
        return 'Path required', 400
    
    # URL-decode and normalize
    expanded_image = normalize_path(unquote(image_path))
    
    # Security: ensure path is within allowed folders
    if not is_path_allowed(expanded_image):
        return 'Access denied', 403
    
    if not os.path.exists(expanded_image):
        return 'Image not found', 404
    
    # Get file extension
    ext = Path(expanded_image).suffix.lower()
    
    # For GIFs and videos, fall back to original file
    # GIFs need to stay animated, videos are handled separately
    if ext in GIF_FORMATS or ext in VIDEO_FORMATS:
        # Redirect to original image endpoint
        logger.debug("Skipping %s file, serving original", ext)
        return serve_image()
    
    # Get file stats for cache key and validation
    try:
        file_stat = os.stat(expanded_image)
        file_mtime = int(file_stat.st_mtime)
        file_size = file_stat.st_size
    except OSError:
        return 'Could not read file stats', 500
    
    # Generate ETag for the thumbnail (based on original file)
    # Include cache version to match thumbnail path generation
    CACHE_VERSION = 2
    etag_hash = hashlib.md5(f"{expanded_image}:{file_mtime}:{file_size}:v{CACHE_VERSION}:thumb".encode()).hexdigest()
    etag = f'"{etag_hash}"'
    
    # Check If-None-Match header for 304 response
    if request.headers.get('If-None-Match') == etag:
        return '', 304
    
    # Ensure thumbnail directory exists
    ensure_thumbnail_dir()
    
    # Get thumbnail cache path
    thumbnail_path = get_thumbnail_path(expanded_image, file_mtime, file_size)
    
    # Check if thumbnail already exists in cache
    if not os.path.exists(thumbnail_path):
        logger.debug("Creating new thumbnail for: %s", expanded_image)
        # Create thumbnail
        if not create_thumbnail(expanded_image, thumbnail_path):
            logger.warning("Failed to create thumbnail, serving original")
            # Fall back to original if thumbnail creation fails
            return serve_image()
        logger.info("Thumbnail created: %s", thumbnail_path)
    else:
        logger.debug("Serving cached thumbnail: %s", thumbnail_path)
    
    # Serve the cached thumbnail
    try:
        thumbnail_stat = os.stat(thumbnail_path)
        thumbnail_mtime = int(thumbnail_stat.st_mtime)
    except OSError:
        return 'Could not read thumbnail stats', 500
    
    # Create response with caching headers
    response = make_response(send_file(thumbnail_path, mimetype='image/webp'))
    
    # Set caching headers (7 days for thumbnails, immutable because they're keyed by mtime)
    response.headers['Cache-Control'] = 'public, max-age=604800, immutable'
    response.headers['ETag'] = etag
    response.headers['Last-Modified'] = time.strftime('%a, %d %b %Y %H:%M:%S GMT', time.gmtime(thumbnail_mtime))
    
    return response


@images_bp.route('/video-poster')
def serve_video_poster():
    """Serve a poster frame extracted from a video for instant display.
    
    This endpoint extracts the first frame from a video file and serves it
    as a JPEG image. This allows instant visual feedback while the video
    loads in the background.
    
    The poster is cached on disk for subsequent requests.
    """
    # Check if video poster optimization is enabled
    optimizations = get_optimization_settings()
    if not optimizations.get('video_poster_cache', False):
        # Optimization disabled - return error so frontend can show fallback
        return 'Video poster optimization disabled', 403
    
    video_path = request.args.get('path')
    
    if not video_path:
        return 'Path required', 400
    
    # URL-decode and normalize
    expanded_video = normalize_path(unquote(video_path))
    
    # Security: ensure path is within allowed folders
    if not is_path_allowed(expanded_video):
        return 'Access denied', 403
    
    if not os.path.exists(expanded_video):
        return 'Video not found', 404
    
    # Verify it's a video file
    ext = Path(expanded_video).suffix.lower()
    if ext not in VIDEO_FORMATS:
        return 'Not a video file', 400
    
    # Get file stats for cache key
    try:
        file_stat = os.stat(expanded_video)
        file_mtime = int(file_stat.st_mtime)
        file_size = file_stat.st_size
    except OSError:
        return 'Could not read file stats', 500
    
    # Generate ETag for the poster (based on original video)
    etag_hash = hashlib.md5(f"{expanded_video}:{file_mtime}:{file_size}:poster".encode()).hexdigest()
    etag = f'"{etag_hash}"'
    
    # Check If-None-Match header for 304 response
    if request.headers.get('If-None-Match') == etag:
        return '', 304
    
    # Ensure thumbnail directory exists
    ensure_thumbnail_dir()
    
    # Get poster cache path
    poster_path = get_thumbnail_path(expanded_video, file_mtime, file_size).replace('.webp', '_poster.jpg')
    
    # Check if poster already exists in cache
    if not os.path.exists(poster_path):
        # Extract poster frame
        if not create_video_poster(expanded_video, poster_path):
            # Return a placeholder or error if extraction fails
            return 'Could not extract video poster', 500
    
    # Serve the cached poster
    try:
        poster_stat = os.stat(poster_path)
        poster_mtime = int(poster_stat.st_mtime)
    except OSError:
        return 'Could not read poster stats', 500
    
    # Create response with caching headers
    response = make_response(send_file(poster_path, mimetype='image/jpeg'))
    
    # Set caching headers (7 days, immutable because keyed by mtime)
    response.headers['Cache-Control'] = 'public, max-age=604800, immutable'
    response.headers['ETag'] = etag
    response.headers['Last-Modified'] = time.strftime('%a, %d %b %Y %H:%M:%S GMT', time.gmtime(poster_mtime))
    
    return response
