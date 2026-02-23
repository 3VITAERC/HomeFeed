"""
Profile management routes for HomeFeed.

Provides the profile picker page and CRUD API for user profiles.
"""

import os
from flask import Blueprint, request, jsonify, redirect, url_for, send_file, session

from app.services.profiles import (
    profiles_exist,
    get_profiles_public,
    get_profile,
    create_profile,
    update_profile,
    delete_profile,
    delete_all_profiles,
    verify_profile_password,
    set_current_profile,
    clear_current_profile,
    get_current_profile_id,
    is_current_profile_admin,
    is_profile_selected,
    load_profile_config,
    save_profile_config,
)
from app.services.data import load_config

profiles_bp = Blueprint('profiles', __name__)

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


# ---------------------------------------------------------------------------
# Profile picker page
# ---------------------------------------------------------------------------

@profiles_bp.route('/profiles')
def profile_picker():
    """Serve the profile selection page.

    Always serves profiles.html — even on first run when no profiles exist yet,
    so the user can create their first profile.
    """
    picker_path = os.path.join(PROJECT_ROOT, 'static', 'profiles.html')
    return send_file(picker_path)


# ---------------------------------------------------------------------------
# Public profile list (used by the picker UI)
# ---------------------------------------------------------------------------

@profiles_bp.route('/api/profiles', methods=['GET'])
def list_profiles():
    """Return all profiles (public info only, no password hashes)."""
    return jsonify(get_profiles_public())


# ---------------------------------------------------------------------------
# Profile login / logout
# ---------------------------------------------------------------------------

@profiles_bp.route('/api/profiles/login', methods=['POST'])
def profile_login():
    """Select a profile and verify its password (if set)."""
    data = request.get_json() or {}
    profile_id = data.get('profile_id', '').strip()
    password = data.get('password', '')

    if not profile_id:
        return jsonify({'success': False, 'error': 'profile_id is required'}), 400

    profile = get_profile(profile_id)
    if not profile:
        return jsonify({'success': False, 'error': 'Profile not found'}), 404

    if not verify_profile_password(profile_id, password):
        return jsonify({'success': False, 'error': 'Incorrect password'}), 401

    set_current_profile(profile_id)
    return jsonify({
        'success': True,
        'redirect': url_for('pages.index'),
        'profile': {
            'id': profile['id'],
            'name': profile['name'],
            'emoji': profile.get('emoji', '👤'),
            'role': profile.get('role', 'user'),
        },
    })


@profiles_bp.route('/api/profiles/logout', methods=['POST'])
def profile_logout():
    """Deselect the current profile (return to profile picker)."""
    clear_current_profile()
    return jsonify({'success': True, 'redirect': url_for('profiles.profile_picker')})


@profiles_bp.route('/api/profiles/me', methods=['GET'])
def profile_me():
    """Return info about the currently selected profile.

    Also returns ``admin_password_set`` so the frontend knows whether to show
    the admin-password field during profile creation.
    """
    admin_pw_set = bool(os.environ.get('HOMEFEED_ADMIN_PASSWORD', ''))
    profile_id = get_current_profile_id()

    if not profile_id:
        return jsonify({
            'profile': None,
            'profiles_enabled': profiles_exist(),
            'is_admin': is_current_profile_admin(),
            'admin_password_set': admin_pw_set,
        })

    profile = get_profile(profile_id)
    if not profile:
        return jsonify({
            'profile': None,
            'profiles_enabled': True,
            'is_admin': is_current_profile_admin(),
            'admin_password_set': admin_pw_set,
        })

    return jsonify({
        'profile': {
            'id': profile['id'],
            'name': profile['name'],
            'emoji': profile.get('emoji', '👤'),
            'role': profile.get('role', 'user'),
        },
        'profiles_enabled': True,
        'is_admin': is_current_profile_admin(),
        'admin_password_set': admin_pw_set,
    })


# ---------------------------------------------------------------------------
# Profile CRUD (admin-only write operations)
# ---------------------------------------------------------------------------

@profiles_bp.route('/api/profiles', methods=['POST'])
def create_profile_route():
    """Create a new profile.

    Permission model:
    - User-role profiles: anyone can self-register (self-serve).
    - Admin-role profiles:
        - If HOMEFEED_ADMIN_PASSWORD is set, the request must include
          ``admin_password`` matching that env var.
        - If HOMEFEED_ADMIN_PASSWORD is NOT set, only an existing admin
          (or first-run with no profiles) can create admin profiles.
    """
    data = request.get_json() or {}
    name = data.get('name', '').strip()
    emoji = data.get('emoji', '👤').strip()
    password = data.get('password') or None
    role = data.get('role', 'user')

    if not name:
        return jsonify({'error': 'name is required'}), 400

    if role not in ('admin', 'user'):
        return jsonify({'error': 'role must be admin or user'}), 400

    if role == 'admin':
        env_admin_pw = os.environ.get('HOMEFEED_ADMIN_PASSWORD', '')
        if env_admin_pw:
            # Admin password is configured — always require it
            provided = data.get('admin_password', '')
            if provided != env_admin_pw:
                return jsonify({'error': 'Server admin password required to create admin profiles'}), 403
        else:
            # No env admin password — fall back to role check
            if profiles_exist() and not is_current_profile_admin():
                return jsonify({'error': 'Admin role required'}), 403

    profile = create_profile(name=name, emoji=emoji, password=password, role=role)
    return jsonify({'success': True, 'profile': profile}), 201


@profiles_bp.route('/api/profiles/<profile_id>', methods=['PUT'])
def update_profile_route(profile_id):
    """Update a profile.

    Permission model:
    - Users can edit their OWN name and emoji only.
    - Users CANNOT change their own password or role (admin must do it).
    - Admins can edit any profile's name, emoji, password, and role.
    """
    current_id = get_current_profile_id()
    is_admin = is_current_profile_admin()

    if not is_admin and current_id != profile_id:
        return jsonify({'error': 'Permission denied'}), 403

    data = request.get_json() or {}
    name = data.get('name')
    emoji = data.get('emoji')

    # Password and role changes are admin-only
    password = data.get('password') if is_admin else None
    clear_password = data.get('clear_password', False) if is_admin else False
    role = data.get('role') if is_admin else None

    updated = update_profile(
        profile_id,
        name=name,
        emoji=emoji,
        password=password,
        clear_password=clear_password,
        role=role,
    )
    if not updated:
        return jsonify({'error': 'Profile not found'}), 404

    return jsonify({'success': True, 'profile': updated})


@profiles_bp.route('/api/profiles/<profile_id>/folders', methods=['GET'])
def get_profile_folders_route(profile_id):
    """Get the folders assigned to a specific profile (admin only).

    Admin profiles always use the global folder list, so this returns the
    global config folders with is_global=True for admin profiles.
    """
    if not is_current_profile_admin():
        return jsonify({'error': 'Admin role required'}), 403

    profile = get_profile(profile_id)
    if not profile:
        return jsonify({'error': 'Profile not found'}), 404

    if profile.get('role') == 'admin':
        config = load_config()
        return jsonify({'folders': config.get('folders', []), 'is_global': True})

    config = load_profile_config(profile_id)
    return jsonify({'folders': config.get('folders', []), 'is_global': False})


@profiles_bp.route('/api/profiles/<profile_id>/folders', methods=['PUT'])
def set_profile_folders_route(profile_id):
    """Set the folders assigned to a specific profile (admin only).

    Folders must be a subset of the global folder list.
    """
    if not is_current_profile_admin():
        return jsonify({'error': 'Admin role required'}), 403

    profile = get_profile(profile_id)
    if not profile:
        return jsonify({'error': 'Profile not found'}), 404

    if profile.get('role') == 'admin':
        return jsonify({'error': 'Admin profiles always use global folders'}), 400

    data = request.get_json() or {}
    folders = data.get('folders', [])
    if not isinstance(folders, list):
        return jsonify({'error': 'folders must be a list'}), 400

    # Only allow folders that exist in the global config
    global_config = load_config()
    global_folders = set(global_config.get('folders', []))
    validated = [f for f in folders if f in global_folders]

    config = load_profile_config(profile_id)
    config['folders'] = validated
    save_profile_config(profile_id, config)

    return jsonify({'success': True, 'folders': validated})


@profiles_bp.route('/api/profiles/<profile_id>', methods=['DELETE'])
def delete_profile_route(profile_id):
    """Delete a profile. Admin role required."""
    if not is_current_profile_admin():
        return jsonify({'error': 'Admin role required'}), 403

    # Cannot delete your own profile
    if get_current_profile_id() == profile_id:
        return jsonify({'error': 'Cannot delete your own profile'}), 400

    if not delete_profile(profile_id):
        return jsonify({'error': 'Profile not found'}), 404

    return jsonify({'success': True})


@profiles_bp.route('/api/profiles/all', methods=['DELETE'])
def delete_all_profiles_route():
    """Delete all profiles except the current admin, including their data directories.

    Admin role required. The currently logged-in admin profile is preserved.
    All other profiles and their data (favorites, watch history, folder config) are removed.
    """
    if not is_current_profile_admin():
        return jsonify({'error': 'Admin role required'}), 403

    current_id = get_current_profile_id()
    if not current_id:
        return jsonify({'error': 'No profile session active'}), 400

    deleted_count = delete_all_profiles(except_profile_id=current_id)
    return jsonify({'success': True, 'deleted_count': deleted_count})


@profiles_bp.route('/api/profiles/verify-admin-password', methods=['POST'])
def verify_admin_password_route():
    """Verify the HOMEFEED_ADMIN_PASSWORD environment variable.

    Used by the frontend to gate access to sensitive admin actions (e.g. Manage Profiles)
    when the server admin password is configured.  Returns success=True if no password
    is configured (open access) or if the provided password matches.
    """
    env_admin_pw = os.environ.get('HOMEFEED_ADMIN_PASSWORD', '')
    if not env_admin_pw:
        # No admin password configured — gate is open
        return jsonify({'success': True})

    data = request.get_json() or {}
    provided = data.get('password', '')

    if provided == env_admin_pw:
        return jsonify({'success': True})

    return jsonify({'success': False, 'error': 'Incorrect admin password'}), 401
