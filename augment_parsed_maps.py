from __future__ import annotations

import json
from pathlib import Path
from typing import Dict, List, Optional

# This script augments the parsed map JSON files for the Aylor areas using
# metadata from the Database exports. It enriches rooms with terrain and
# other helpful fields while preserving the original layout coordinates.

REPO_ROOT = Path(__file__).parent
DB_DIR = REPO_ROOT / "Database"
PARSED_DIR = REPO_ROOT / "parsed_maps"

TARGET_AREAS: Dict[int, str] = {
    18: "aylor",  # The Grand City of Aylor
    258: "academy",  # The Aylorian Academy
}


def load_json(path: Path):
    with path.open() as f:
        return json.load(f)


def build_room_index(rooms: List[dict], target_area_uids: set[str]) -> Dict[str, Dict[str, List[dict]]]:
    index: Dict[str, Dict[str, List[dict]]] = {}
    for room in rooms:
        area = room.get("area")
        if area not in target_area_uids:
            continue
        index.setdefault(area, {}).setdefault(room["name"], []).append(room)
    return index


def pick_room_match(matches: List[dict]) -> Optional[dict]:
    if not matches:
        return None
    # Prefer a room that already has coordinates if available; otherwise, first entry.
    with_coords = [r for r in matches if r.get("x") is not None and r.get("y") is not None]
    if with_coords:
        return with_coords[0]
    return matches[0]


def enrich_room(room: dict, db_match: dict) -> None:
    room["areaUid"] = db_match.get("area")
    room["uid"] = db_match.get("uid")
    room["terrain"] = db_match.get("terrain")
    room["building"] = db_match.get("building")
    room["info"] = db_match.get("info")
    room["notes"] = db_match.get("notes")
    room["noportal"] = db_match.get("noportal")
    room["norecall"] = db_match.get("norecall")
    room["ignoreExitsMismatch"] = db_match.get("ignore_exits_mismatch")



def main() -> None:
    db_rooms = load_json(DB_DIR / "rooms.json")
    db_areas = {area["uid"]: area for area in load_json(DB_DIR / "areas.json")}

    target_area_uids = set(TARGET_AREAS.values())
    room_index = build_room_index(db_rooms, target_area_uids)

    for area_num, area_uid in TARGET_AREAS.items():
        parsed_path = PARSED_DIR / f"area{area_num}.json"
        data = load_json(parsed_path)

        for room in data.get("rooms", []):
            matches = room_index.get(area_uid, {}).get(room["name"], [])
            match = pick_room_match(matches)
            if match:
                enrich_room(room, match)

        area_meta = db_areas.get(area_uid)
        if area_meta:
            data["areaMetadata"] = {
                "uid": area_uid,
                "name": area_meta.get("name"),
                "color": area_meta.get("color"),
                "flags": area_meta.get("flags"),
                "texture": area_meta.get("texture"),
            }

        parsed_path.write_text(json.dumps(data, indent=2))
        print(f"Updated {parsed_path.relative_to(REPO_ROOT)}")


if __name__ == "__main__":
    main()
