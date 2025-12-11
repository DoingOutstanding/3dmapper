# 3D Mapper Help

This viewer renders the Aylor and Academy areas from the Aardwolf database JSON files with Three.js.

## Getting started
- Quick start (opens your browser automatically):
  ```bash
  python serve.py
  ```
- Manual start from the project root (useful for custom host/port):
  ```bash
  python -m http.server 8000
  # then open http://localhost:8000/
  ```
- If you see a 404 page, ensure you are running the server from this repository's root so the `Database/` folder is available.

## Navigation controls
- **Rotate:** Click and drag the left mouse button.
- **Pan:** Click and drag the right mouse button or hold `Shift` while dragging.
- **Zoom:** Scroll the mouse wheel or pinch on a trackpad.
- **Reset view:** Refresh the page to re-center the camera on the areas.

## Data assumptions
- Rooms and exits load directly from `Database/rooms.json` and `Database/exits.json`.
- Only the `aylor` and `academy` area IDs are rendered by default.
- Rooms with known coordinates anchor the layout; the rest are inferred from exits. If a room cannot be placed, it appears near the origin so it stays visible.

## Troubleshooting
- If you see a red error banner, check the browser console for the full message (e.g., missing JSON files or a blocked fetch due to running without a web server).
- Ensure all JSON files remain in the `Database/` folder relative to `index.html`.
- Use `python serve.py --host 0.0.0.0 --port 8000 --no-browser` if another device needs to reach your machine.
