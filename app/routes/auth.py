"""
Authentication routes for HomeFeed.

Provides login/logout endpoints and login page UI.
"""

import os
from flask import Blueprint, send_file, request, redirect, url_for, session, jsonify
from app.services import (
    is_auth_enabled,
    is_authenticated,
    session_login,
    session_logout,
    generate_csrf_token,
    validate_csrf_token,
)

auth_bp = Blueprint('auth', __name__)

# Project root directory (where static/ folder is located)
PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


@auth_bp.route('/login', methods=['GET'])
def login_page():
    """Render the login page.
    
    If authentication is not enabled, redirect to home.
    If already authenticated, redirect to home.
    """
    if not is_auth_enabled():
        return redirect(url_for('pages.index'))
    
    if is_authenticated():
        return redirect(url_for('pages.index'))
    
    # Serve the static login.html file
    login_path = os.path.join(PROJECT_ROOT, 'static', 'login.html')
    return send_file(login_path)


@auth_bp.route('/login', methods=['POST'])
def login_submit():
    """Handle login form submission.
    
    Accepts both JSON and form data.
    """
    if not is_auth_enabled():
        return jsonify({'success': True, 'redirect': url_for('pages.index')})
    
    if is_authenticated():
        return jsonify({'success': True, 'redirect': url_for('pages.index')})
    
    # Get password from request
    if request.is_json:
        data = request.get_json()
        password = data.get('password', '')
        csrf_token = data.get('csrf_token', '')
    else:
        password = request.form.get('password', '')
        csrf_token = request.form.get('csrf_token', '')
    
    # Validate CSRF token
    if not validate_csrf_token(csrf_token):
        if request.is_json:
            return jsonify({'success': False, 'error': 'Invalid CSRF token'}), 403
        return redirect(url_for('auth.login_page'))

    # Attempt login
    if session_login(password):
        if request.is_json:
            return jsonify({'success': True, 'redirect': url_for('pages.index')})
        return redirect(url_for('pages.index'))

    # Login failed
    if request.is_json:
        return jsonify({'success': False, 'error': 'Invalid password'}), 401
    return redirect(url_for('auth.login_page'))


@auth_bp.route('/logout', methods=['POST'])
def logout():
    """Handle logout request."""
    session_logout()
    
    if request.is_json:
        return jsonify({'success': True, 'redirect': url_for('auth.login_page')})
    return redirect(url_for('auth.login_page'))


@auth_bp.route('/api/auth/status')
def auth_status():
    """Return authentication status for API clients."""
    return jsonify({
        'auth_enabled': is_auth_enabled(),
        'authenticated': is_authenticated()
    })


@auth_bp.route('/api/auth/csrf')
def get_csrf():
    """Return a CSRF token for the login form."""
    token = generate_csrf_token()
    return jsonify({'csrf_token': token})
