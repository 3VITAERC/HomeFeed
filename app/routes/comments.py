"""
Comments routes for HomeFeed.

Comments are global (not per-profile) — they annotate the files themselves.
Supports three comment types:
  - "user": typed by a user in the app
  - "sidecar": content of a .txt file living alongside the photo (e.g. photo-1.txt)
  - "reddit": gallery-dl–downloaded Reddit comment data (read-only from JSON sidecar)

Endpoints:
  GET  /api/comments?path=...           Get all comments for an image
  POST /api/comments                    Add a user comment
  PUT  /api/comments/<comment_id>       Edit a user comment's text
  DELETE /api/comments/<comment_id>     Delete a user comment
  PUT  /api/comments/sidecar            Write to the .txt sidecar file
"""

import os
import uuid
import time
import json
from urllib.parse import unquote
from flask import Blueprint, request, jsonify

from app.services.data import (
    get_comments_for_path,
    add_comment,
    update_comment,
    delete_comment,
)
from app.services.path_utils import (
    normalize_path,
    is_path_allowed,
    validate_and_normalize_path,
)
from app.services.profiles import get_current_profile_id
from app.services.profiles import is_profiles_active


comments_bp = Blueprint('comments', __name__)


def _sidecar_path(image_path: str) -> str:
    """Return the .txt sidecar path for an image, e.g. photo.jpg -> photo.txt."""
    base, _ = os.path.splitext(image_path)
    return base + '.txt'


def _read_sidecar(image_path: str):
    """Read .txt sidecar file content if it exists, else return None."""
    sidecar = _sidecar_path(image_path)
    if os.path.exists(sidecar):
        try:
            with open(sidecar, 'r', encoding='utf-8', errors='replace') as f:
                return f.read()
        except IOError:
            pass
    return None


def _read_reddit_sidecar(image_path: str):
    """Read a gallery-dl Reddit JSON sidecar if present.

    gallery-dl can download a .json file alongside the image containing post/comment
    data. We look for <basename>.json and try to extract comments from it.

    Returns a list of comment dicts or None if no sidecar found.
    """
    base, _ = os.path.splitext(image_path)
    json_path = base + '.json'
    if not os.path.exists(json_path):
        return None
    try:
        with open(json_path, 'r', encoding='utf-8', errors='replace') as f:
            data = json.load(f)
    except (IOError, json.JSONDecodeError):
        return None

    comments = []

    # gallery-dl Reddit format: top-level keys may include 'comments' list or
    # the post body itself can act as a comment.
    # We also surface the post title + body (selftext) as the first "comment".
    post_title = data.get('title', '')
    post_body = data.get('selftext', '') or data.get('body', '')
    post_author = data.get('author', '')
    post_score = data.get('score')
    post_date = data.get('date') or data.get('created_utc')

    if post_title or post_body:
        comments.append({
            'id': f'reddit_post_{base}',
            'text': (f"**{post_title}**\n\n{post_body}").strip() if post_title else post_body,
            'type': 'reddit',
            'author': post_author or 'OP',
            'score': post_score,
            'created_at': post_date,
            'edited_at': None,
        })

    # Parse nested comments array if present
    raw_comments = data.get('comments', [])
    if isinstance(raw_comments, list):
        for i, rc in enumerate(raw_comments):
            if not isinstance(rc, dict):
                continue
            body = rc.get('body', '') or rc.get('text', '')
            if not body:
                continue
            comments.append({
                'id': rc.get('id') or f'reddit_c_{i}',
                'text': body,
                'type': 'reddit',
                'author': rc.get('author', ''),
                'score': rc.get('score'),
                'created_at': rc.get('created_utc') or rc.get('date'),
                'edited_at': None,
            })

    return comments if comments else None


@comments_bp.route('/api/comments', methods=['GET'])
def get_comments():
    """Get all comments for an image, including sidecar and reddit data.

    Query params:
      path: URL-encoded image URL (e.g. /image?path=...) or raw file path

    Returns JSON:
      {
        "comments": [...],        # user + reddit comments from comments.json
        "sidecar": "text" | null, # .txt sidecar content (if exists)
        "sidecar_path": "..." | null,
        "has_sidecar": bool
      }
    """
    raw_path = request.args.get('path', '')
    if not raw_path:
        return jsonify({'error': 'path parameter required'}), 400

    # Accept /image?path=... or /thumbnail?path=... or raw paths
    from app.services.path_utils import extract_path_from_url
    extracted = extract_path_from_url(raw_path)
    image_path = normalize_path(extracted)

    if not is_path_allowed(image_path):
        return jsonify({'error': 'Access denied'}), 403

    # User comments stored in comments.json
    user_comments = get_comments_for_path(image_path)

    # Reddit sidecar
    reddit_comments = _read_reddit_sidecar(image_path)
    if reddit_comments:
        # Merge: reddit comments go first (they're source material), user comments after
        all_comments = reddit_comments + [c for c in user_comments if c.get('type') != 'reddit']
    else:
        all_comments = user_comments

    # Sidecar .txt
    sidecar_text = _read_sidecar(image_path)

    return jsonify({
        'comments': all_comments,
        'sidecar': sidecar_text,
        'sidecar_path': _sidecar_path(image_path) if sidecar_text is not None else None,
        'has_sidecar': sidecar_text is not None,
    })


@comments_bp.route('/api/comments', methods=['POST'])
def post_comment():
    """Add a user comment for an image.

    Body JSON:
      { "path": "/image?path=...", "text": "comment text" }

    Returns:
      { "success": true, "comment": {...} }
    """
    data = request.get_json() or {}
    raw_path = data.get('path', '')
    text = (data.get('text') or '').strip()

    if not raw_path:
        return jsonify({'error': 'path is required'}), 400
    if not text:
        return jsonify({'error': 'text is required'}), 400

    from app.services.path_utils import extract_path_from_url
    extracted = extract_path_from_url(raw_path)
    image_path = normalize_path(extracted)

    if not is_path_allowed(image_path):
        return jsonify({'error': 'Access denied'}), 403

    # Resolve optional profile context
    profile_id = None
    profile_name = None
    try:
        if is_profiles_active():
            profile_id = get_current_profile_id()
            if profile_id:
                from app.services.profiles import load_profiles
                profiles = load_profiles()
                profile = next((p for p in profiles if p.get('id') == profile_id), None)
                if profile:
                    profile_name = profile.get('name') or profile.get('emoji') or None
    except Exception:
        pass

    comment = {
        'id': str(uuid.uuid4()),
        'text': text,
        'type': 'user',
        'profile_id': profile_id,
        'profile_name': profile_name,
        'author': profile_name,
        'score': None,
        'created_at': time.time(),
        'edited_at': None,
    }

    add_comment(image_path, comment)
    return jsonify({'success': True, 'comment': comment})


@comments_bp.route('/api/comments/<comment_id>', methods=['PUT'])
def edit_comment(comment_id):
    """Edit a user comment's text.

    Body JSON:
      { "path": "/image?path=...", "text": "new text" }
    """
    data = request.get_json() or {}
    raw_path = data.get('path', '')
    text = (data.get('text') or '').strip()

    if not raw_path or not text:
        return jsonify({'error': 'path and text are required'}), 400

    from app.services.path_utils import extract_path_from_url
    extracted = extract_path_from_url(raw_path)
    image_path = normalize_path(extracted)

    if not is_path_allowed(image_path):
        return jsonify({'error': 'Access denied'}), 403

    updated = update_comment(image_path, comment_id, text)
    if updated is None:
        return jsonify({'error': 'Comment not found or not editable'}), 404

    return jsonify({'success': True, 'comment': updated})


@comments_bp.route('/api/comments/<comment_id>', methods=['DELETE'])
def remove_comment(comment_id):
    """Delete a user comment.

    Body JSON:
      { "path": "/image?path=..." }
    """
    data = request.get_json() or {}
    raw_path = data.get('path', '')

    if not raw_path:
        return jsonify({'error': 'path is required'}), 400

    from app.services.path_utils import extract_path_from_url
    extracted = extract_path_from_url(raw_path)
    image_path = normalize_path(extracted)

    if not is_path_allowed(image_path):
        return jsonify({'error': 'Access denied'}), 403

    deleted = delete_comment(image_path, comment_id)
    if not deleted:
        return jsonify({'error': 'Comment not found'}), 404

    return jsonify({'success': True})


@comments_bp.route('/api/comments/sidecar', methods=['PUT'])
def update_sidecar():
    """Write to the .txt sidecar file alongside an image.

    Body JSON:
      { "path": "/image?path=...", "text": "new sidecar text" }

    The sidecar file must already exist OR the image must exist and be in an
    allowed folder. This allows correcting/updating caption text files.
    """
    data = request.get_json() or {}
    raw_path = data.get('path', '')
    text = data.get('text', '')

    if not raw_path:
        return jsonify({'error': 'path is required'}), 400

    from app.services.path_utils import extract_path_from_url
    extracted = extract_path_from_url(raw_path)
    image_path = normalize_path(extracted)

    if not is_path_allowed(image_path):
        return jsonify({'error': 'Access denied'}), 403

    sidecar = _sidecar_path(image_path)

    try:
        with open(sidecar, 'w', encoding='utf-8') as f:
            f.write(text)
    except IOError as e:
        return jsonify({'error': f'Could not write sidecar: {e}'}), 500

    return jsonify({'success': True, 'sidecar_path': sidecar})
