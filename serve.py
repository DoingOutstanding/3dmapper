"""Small helper to serve the 3D mapper assets from the repo root.

Run ``python serve.py`` to start a local HTTP server that exposes ``index.html``
(and the Database JSON files) at http://localhost:8000/.
"""
from __future__ import annotations

import argparse
import http.server
import os
import pathlib
import socketserver
import sys
import webbrowser


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Serve the 3D mapper from the repo root.")
    parser.add_argument("--host", default="127.0.0.1", help="Host/interface to bind (default: 127.0.0.1)")
    parser.add_argument("--port", type=int, default=8000, help="Port to bind (default: 8000)")
    parser.add_argument("--no-browser", action="store_true", help="Do not open a browser automatically")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    root = pathlib.Path(__file__).resolve().parent
    os.chdir(root)

    handler = http.server.SimpleHTTPRequestHandler
    with socketserver.TCPServer((args.host, args.port), handler) as httpd:
        url = f"http://{args.host}:{args.port}/"
        print(f"Serving {root} at {url}")
        if not args.no_browser:
            webbrowser.open(url)
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nStopping server.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
