"""
Upload route for HomeFeed.
Accepts multipart/form-data with a 'files[]' field (multiple files).
"""

import os
import time
from flask import Blueprint, request, jsonify
from werkzeug.utils import secure_filename

from app.config import BASE_DIR, SUPPORTED_FORMATS
from app.services.image_cache import invalidate_cache

uploads_bp = Blueprint('uploads', __name__)

UPLOADS_DIR = os.path.join(BASE_DIR, 'uploads')


def _safe_dest(filename: str) -> str:
    """Return a collision-free absolute path inside UPLOADS_DIR."""
    name = secure_filename(filename)
    if not name:
        name = f"upload_{int(time.time() * 1000)}"
    dest = os.path.join(UPLOADS_DIR, name)
    if not os.path.exists(dest):
        return dest
    stem, ext = os.path.splitext(name)
    return os.path.join(UPLOADS_DIR, f"{stem}_{int(time.time() * 1000)}{ext}")


@uploads_bp.route('/api/upload', methods=['POST'])
def upload_files():
    """Accept multipart/form-data with files[] field. Saves to uploads/."""
    files = request.files.getlist('files[]')
    if not files:
        return jsonify({'error': 'No files provided'}), 400

    os.makedirs(UPLOADS_DIR, exist_ok=True)

    uploaded = []
    errors = []

    for f in files:
        if not f or not f.filename:
            errors.append({'name': '', 'error': 'Empty file'})
            continue

        ext = os.path.splitext(f.filename)[1].lower()
        if ext not in SUPPORTED_FORMATS:
            errors.append({'name': f.filename, 'error': f'Unsupported format: {ext}'})
            continue

        try:
            dest = _safe_dest(f.filename)
            f.save(dest)
            uploaded.append(os.path.basename(dest))
        except Exception as e:
            errors.append({'name': f.filename, 'error': str(e)})

    if uploaded:
        invalidate_cache()

    return jsonify({
        'success': len(uploaded) > 0,
        'uploaded': uploaded,
        'errors': errors,
    })
