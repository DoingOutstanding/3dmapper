# 3D Mapper Help

This viewer renders the Aylor and Academy areas from the Aardwolf database JSON files with Three.js.

## Getting started
1. From the project root, start a simple web server so the browser can fetch the JSON assets:
   ```bash
   python -m http.server 8000
   ```
2. Open the viewer in your browser at `http://localhost:8000/`.
3. The legend at the top lists the visible areas and their colors.

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
