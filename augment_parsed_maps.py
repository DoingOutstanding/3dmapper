from __future__ import annotations

import json
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Set

# This script augments the parsed map JSON files for the Aylor areas using
# metadata from the Database exports. It enriches rooms with terrain and
# other helpful fields while preserving the original layout coordinates.

REPO_ROOT = Path(__file__).parent
DB_DIR = REPO_ROOT / "Database"
PARSED_DIR = REPO_ROOT / "parsed_maps"

# Limit enrichment to the two Aylor areas we have been focusing on.
TARGET_AREA_UIDS = {"aylor", "academy"}


def load_json(path: Path):
    with path.open() as f:
        return json.load(f)


def normalize_name(value: Optional[str]) -> Optional[str]:
    if value is None:
        return None
    return value.strip().casefold()


def determine_area_uid(metadata: dict, areas_by_name: Dict[str, dict]) -> Optional[str]:
    """Use the parsed HTML metadata to find the database area UID."""

    area_name = normalize_name(metadata.get("area_name"))
    if area_name and area_name in areas_by_name:
        return areas_by_name[area_name]["uid"]

    return None


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


def target_parsed_files() -> Iterable[Path]:
    # Only process the Aylor and Aylorian Academy maps we are working with.
    for candidate in (PARSED_DIR / "area18.json", PARSED_DIR / "area258.json"):
        if candidate.exists():
            yield candidate



def main() -> None:
    db_rooms = load_json(DB_DIR / "rooms.json")
    db_areas_list = load_json(DB_DIR / "areas.json")
    db_areas = {area["uid"]: area for area in db_areas_list}
    areas_by_name = {
        normalize_name(area["name"]): area for area in db_areas_list if normalize_name(area.get("name"))
    }
    db_exits = load_json(DB_DIR / "exits.json")

    target_data = []
    for parsed_path in target_parsed_files():
        data = load_json(parsed_path)
        area_uid = determine_area_uid(data.get("metadata", {}), areas_by_name)
        if not area_uid:
            print(f"Skipping {parsed_path.name}: unable to determine area UID from metadata")
            continue
        if area_uid not in TARGET_AREA_UIDS:
            print(f"Skipping {parsed_path.name}: area UID {area_uid!r} not in target set")
            continue
        target_data.append((parsed_path, area_uid, data))

    target_area_uids = {area_uid for _, area_uid, _ in target_data}
    room_index = build_room_index(db_rooms, target_area_uids)
    db_neighbors = build_db_neighbors(db_rooms, target_area_uids, db_exits)

    for parsed_path, area_uid, data in target_data:
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

        output_path = PARSED_DIR / f"{area_uid}.json"
        output_path.write_text(json.dumps(data, indent=2))

        if output_path != parsed_path:
            parsed_path.unlink(missing_ok=True)
            print(f"Renamed {parsed_path.name} -> {output_path.name}")

        print(f"Updated {output_path.relative_to(REPO_ROOT)}")


if __name__ == "__main__":
    main()
