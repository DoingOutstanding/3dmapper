from __future__ import annotations

import json
from pathlib import Path
from typing import Dict, List, Optional, Set

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


def build_parsed_neighbors(data: dict) -> Dict[int, Set[str]]:
    name_by_id = {room["id"]: room["name"] for room in data.get("rooms", [])}
    neighbors: Dict[int, Set[str]] = {room_id: set() for room_id in name_by_id}

    for exit_ in data.get("exits", []):
        room1 = exit_.get("room1")
        room2 = exit_.get("room2")
        if room1 in name_by_id and room2 in name_by_id:
            neighbors[room1].add(name_by_id[room2])
            neighbors[room2].add(name_by_id[room1])

    return neighbors


def build_db_neighbors(db_rooms: List[dict], target_area_uids: set[str], db_exits: List[dict]) -> Dict[str, Set[str]]:
    rooms_by_uid = {
        room["uid"]: room for room in db_rooms if room.get("area") in target_area_uids
    }
    neighbors: Dict[str, Set[str]] = {uid: set() for uid in rooms_by_uid}

    for exit_ in db_exits:
        from_uid = exit_.get("fromuid")
        to_uid = exit_.get("touid")

        if from_uid in rooms_by_uid and to_uid in rooms_by_uid:
            neighbors[from_uid].add(rooms_by_uid[to_uid]["name"])
            neighbors[to_uid].add(rooms_by_uid[from_uid]["name"])

    return neighbors


def score_exit_overlap(parsed_neighbors: Set[str], db_neighbors: Set[str]) -> int:
    if not parsed_neighbors or not db_neighbors:
        return 0
    return len(parsed_neighbors.intersection(db_neighbors))


def pick_room_match_with_exits(
    room: dict,
    matches: List[dict],
    parsed_neighbor_map: Dict[int, Set[str]],
    db_neighbor_map: Dict[str, Set[str]],
) -> Optional[dict]:
    if not matches:
        return None

    parsed_neighbor_names = parsed_neighbor_map.get(room["id"], set())

    best_match = None
    best_score = -1
    for candidate in matches:
        score = score_exit_overlap(parsed_neighbor_names, db_neighbor_map.get(candidate["uid"], set()))
        if score > best_score:
            best_score = score
            best_match = candidate
        elif score == best_score and best_match is not None:
            # Tie-breaker: prefer the candidate with coordinates
            current_has_coords = candidate.get("x") is not None and candidate.get("y") is not None
            best_has_coords = best_match.get("x") is not None and best_match.get("y") is not None
            if current_has_coords and not best_has_coords:
                best_match = candidate

    return best_match



def main() -> None:
    db_rooms = load_json(DB_DIR / "rooms.json")
    db_areas = {area["uid"]: area for area in load_json(DB_DIR / "areas.json")}
    db_exits = load_json(DB_DIR / "exits.json")

    target_area_uids = set(TARGET_AREAS.values())
    room_index = build_room_index(db_rooms, target_area_uids)
    db_neighbors = build_db_neighbors(db_rooms, target_area_uids, db_exits)

    for area_num, area_uid in TARGET_AREAS.items():
        parsed_path = PARSED_DIR / f"area{area_num}.json"
        data = load_json(parsed_path)
        parsed_neighbors = build_parsed_neighbors(data)

        for room in data.get("rooms", []):
            matches = room_index.get(area_uid, {}).get(room["name"], [])
            match = pick_room_match_with_exits(room, matches, parsed_neighbors, db_neighbors)
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
