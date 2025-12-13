"""Small helper to serve the 3D mapper assets from the repo root.

Run ``python serve.py`` to start a local HTTP server that exposes ``index.html``
(and the Database JSON files) at http://localhost:8000/.
"""
from __future__ import annotations

import argparse
import functools
import http.server
import pathlib
import socketserver
import sys
import webbrowser


class NoCacheRequestHandler(http.server.SimpleHTTPRequestHandler):
    """HTTP handler that serves files from a fixed directory without caching."""

    # Ensure CSV files get a sensible content-type for fetch().
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".csv": "text/csv; charset=utf-8",
    }

    def __init__(self, *args, directory: str | None = None, **kwargs):
        # Explicitly pass directory so we do not rely on global cwd changes.
        super().__init__(*args, directory=directory, **kwargs)

    def end_headers(self) -> None:
        # Disable caching so UI updates (like new menus) are always picked up.
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Serve the 3D mapper from the repo root.")
    parser.add_argument("--host", default="127.0.0.1", help="Host/interface to bind (default: 127.0.0.1)")
    parser.add_argument("--port", type=int, default=8000, help="Port to bind (default: 8000)")
    parser.add_argument("--no-browser", action="store_true", help="Do not open a browser automatically")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    root = pathlib.Path(__file__).resolve().parent
    handler = functools.partial(NoCacheRequestHandler, directory=str(root))
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
