"""
Authentication service for LocalFeed.

Provides password-based authentication using Flask-HTTPAuth with session persistence.
Password is set via the LOCALFEED_PASSWORD environment variable.
"""

import os
import secrets
from functools import wraps
from flask import session, request, redirect, url_for, jsonify
from flask_httpauth import HTTPBasicAuth

# Create the auth instance
auth = HTTPBasicAuth()

# Session key for logged-in state
SESSION_KEY = 'authenticated'
CSRF_TOKEN_KEY = 'csrf_token'


def is_auth_enabled():
    """Check if authentication is enabled (password is configured)."""
    return bool(os.environ.get('LOCALFEED_PASSWORD'))


def get_password():
    """Get the configured password from environment variable."""
    return os.environ.get('LOCALFEED_PASSWORD', '')


def is_authenticated():
    """Check if the current session is authenticated."""
    return session.get(SESSION_KEY, False)


def generate_csrf_token():
    """Generate a new CSRF token for the session."""
    token = secrets.token_hex(32)
    session[CSRF_TOKEN_KEY] = token
    return token


def validate_csrf_token(token):
    """Validate a CSRF token against the session token."""
    session_token = session.get(CSRF_TOKEN_KEY)
    return session_token and secrets.compare_digest(token, session_token)


@auth.verify_password
def verify_password(username, password):
    """Verify credentials for HTTP Basic Auth.
    
    Used by API endpoints that receive Authorization headers.
    """
    if not is_auth_enabled():
        return True  # Auth disabled, allow all
    
    if password == get_password():
        session[SESSION_KEY] = True
        return username
    return None


def login_required(f):
    """Decorator that requires authentication for a route.
    
    This checks session-based authentication first (for browser users),
    then falls back to HTTP Basic Auth (for API clients).
    """
    @wraps(f)
    def decorated(*args, **kwargs):
        if not is_auth_enabled():
            return f(*args, **kwargs)
        
        # Check session authentication
        if is_authenticated():
            return f(*args, **kwargs)
        
        # Check HTTP Basic Auth (for API clients)
        if auth.authenticate():
            return f(*args, **kwargs)
        
        # Not authenticated - redirect to login or return 401
        if request.accept_mimetypes.accept_html:
            return redirect(url_for('auth.login_page'))
        return jsonify({'error': 'Authentication required'}), 401
    
    return decorated


def session_login(password):
    """Attempt to log in with a password.
    
    Returns True if successful, False otherwise.
    """
    if not is_auth_enabled():
        return True  # Auth disabled, always succeed
    
    if password == get_password():
        session[SESSION_KEY] = True
        generate_csrf_token()
        return True
    return False


def session_logout():
    """Log out the current session."""
    session.pop(SESSION_KEY, None)
    session.pop(CSRF_TOKEN_KEY, None)
