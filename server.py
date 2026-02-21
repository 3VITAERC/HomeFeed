#!/usr/bin/env python3
"""
LocalFeed - TikTok-style image viewer
Entry point for the Flask server.
"""

import os
import sys
import socket
import argparse
import logging


# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(name)s] %(levelname)s: %(message)s'
)

logger = logging.getLogger(__name__)


# Default port - chosen to avoid common conflicts with 8080, 3000, 5000, etc.
DEFAULT_PORT = 7123


def get_local_ip():
    """Get the local IP address for network access."""
    hostname = socket.gethostname()
    try:
        return socket.gethostbyname(hostname)
    except:
        return "localhost"


def get_port():
    """Get the port from command line argument, environment variable, or default.
    
    Priority:
    1. Command line argument: --port 9000
    2. Environment variable: PORT=9000
    3. Default: 7123
    """
    parser = argparse.ArgumentParser(description='LocalFeed - TikTok-style image viewer')
    parser.add_argument('--port', '-p', type=int, help='Port to run the server on (default: 7123)')
    parser.add_argument('--debug', '-d', action='store_true', help='Enable debug mode')
    args = parser.parse_args()
    
    if args.port:
        return args.port, args.debug
    
    # Check environment variable
    env_port = os.environ.get('PORT')
    if env_port:
        try:
            return int(env_port), args.debug
        except ValueError:
            logger.warning("Invalid PORT environment variable '%s', using default", env_port)
    
    return DEFAULT_PORT, args.debug


def print_startup_info(port):
    """Print startup information and access URLs."""
    local_ip = get_local_ip()
    
    print("=" * 50)
    print("  LocalFeed")
    print("  TikTok-style image viewer")
    print("=" * 50)
    print()
    print(f"  Access on this machine:    http://localhost:{port}")
    print(f"  Access remotely:    http://{local_ip}:{port}")
    print()
    
    # Show platform-specific production server instructions
    if sys.platform == 'win32':
        print("  For better performance with many images, use waitress:")
        print(f"    waitress-serve --port={port} server:app")
    else:
        print("  For better performance with many images, use gunicorn:")
        print(f"    gunicorn -w 4 -b 0.0.0.0:{port} server:app")
    print()
    print("  Press Ctrl+C to stop the server")
    print("=" * 50)


# Create the application instance for WSGI servers (gunicorn/waitress)
from app import create_app
app = create_app()


if __name__ == '__main__':
    port, debug = get_port()
    print_startup_info(port)
    app.run(host='0.0.0.0', port=port, debug=debug or os.environ.get('FLASK_DEBUG', '').lower() == 'true')
