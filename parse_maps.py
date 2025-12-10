from __future__ import annotations

import html
import json
import re
from pathlib import Path
from typing import Any, Dict, List, Optional

MAPS_DIR = Path("Maps")
OUTPUT_DIR = Path("parsed_maps")

LINK_CONSTANTS = {
    "LINK_ONEWAY": 0,
    "LINK_TWOWAY": 1,
    "LINK_DISCONNECTED": 2,
    "LINK_TO_ANOTHER_AREA": 3,
}

EXIT_TYPE_NAMES = {
    0: "north",
    1: "east",
    2: "south",
    3: "west",
    4: "up",
    5: "down",
    7: "other",
}

OPPOSITE_EXIT_TYPES = {
    0: 2,
    1: 3,
    2: 0,
    3: 1,
    4: 5,
    5: 4,
}

BOOLEAN_MAP = {"true": True, "false": False}


def parse_area_metadata(text: str) -> Dict[str, Any]:
    metadata: Dict[str, Any] = {}

    title_match = re.search(r"<title>(.*?)</title>", text, re.DOTALL | re.IGNORECASE)
    if title_match:
        metadata["title"] = html.unescape(title_match.group(1).strip())

    area_match = re.search(r'<div class="areaname">@\s*([^\[]+)', text)
    if area_match:
        metadata["area_name"] = html.unescape(area_match.group(1).strip())

    info_match = re.search(r'<div id="areainfo"[^>]*>(.*?)</div>', text, re.DOTALL)
    if info_match:
        info_block = info_match.group(1)
        info_pairs = re.findall(r"\[\s*<strong>([^<]+)</strong>\]\s*([^\[]+)", info_block)
        metadata["details"] = {key.strip(): html.unescape(value.strip()) for key, value in info_pairs}

    return metadata


ROOM_PATTERN = re.compile(
    r"rooms\[(\d+)\]\s*=\s*new Room\(\s*"
    r"(\d+)\s*,\s*\"([^\"]*)\"\s*,\s*(-?\d+)\s*,\s*(-?\d+)\s*,\s*"
    r"(true|false)\s*,\s*(\d+)\s*,\s*(true|false)\s*,\s*(true|false)\s*,\s*'([^']*)'\s*,\s*(null)\s*\);"
)


def parse_rooms(text: str) -> List[Dict[str, Any]]:
    rooms: List[Dict[str, Any]] = []
    for match in ROOM_PATTERN.finditer(text):
        (
            index,
            roomid,
            name,
            xpos,
            ypos,
            is_entrance,
            aggro_type,
            graffiti,
            pk,
            roomcolor,
            _,
        ) = match.groups()
        rooms.append(
            {
                "index": int(index),
                "id": int(roomid),
                "name": name,
                "x": int(xpos),
                "y": int(ypos),
                "isEntrance": BOOLEAN_MAP[is_entrance],
                "aggroType": int(aggro_type),
                "graffiti": BOOLEAN_MAP[graffiti],
                "pk": BOOLEAN_MAP[pk],
                "roomcolor": roomcolor,
            }
        )
    return rooms


EXIT_PATTERN = re.compile(
    r"new RoomExit\(rooms\[(\d+)\],\s*(rooms\[(\d+)\]|null),\s*([A-Z_0-9]+),\s*"
    r"(\d+),\s*\"([^\"]*)\",\s*(true|false),\s*(null|new RoomAreaExitInfo\([^)]*\)),\s*"
    r"new DoorInfo\(\"([^\"]*)\",\s*(\d+),\s*\"([^\"]*)\",\s*\"([^\"]*)\",\s*(null|\d+)\),\s*(true|false)\)"
)

AREA_EXIT_PATTERN = re.compile(r"new RoomAreaExitInfo\((\d+),\s*\"([^\"]*)\"\)")


def parse_area_exit(value: str) -> Optional[Dict[str, Any]]:
    if value == "null":
        return None
    area_match = AREA_EXIT_PATTERN.search(value)
    if not area_match:
        return {"raw": value}
    area_id, area_name = area_match.groups()
    return {"areaId": int(area_id), "areaName": area_name}


def parse_exit(exit_match: re.Match[str]) -> Dict[str, Any]:
    (
        room1,
        _room2_raw,
        room2_index,
        linktype,
        exittype,
        exitaction,
        random_flag,
        areaexit,
        doorname,
        doortype,
        keyname,
        keydesc,
        keyroom,
        forcebroken,
    ) = exit_match.groups()

    link_value = LINK_CONSTANTS.get(linktype, linktype)
    exit_type = int(exittype)
    keyroom_value: Optional[int]
    if keyroom == "null":
        keyroom_value = None
    else:
        keyroom_value = int(keyroom)

    room2_value: Optional[int]
    if room2_index is None:
        room2_value = None
    else:
        room2_value = int(room2_index)

    return {
        "room1": int(room1),
        "room2": room2_value,
        "linkType": link_value,
        "exitType": exit_type,
        "direction": EXIT_TYPE_NAMES.get(exit_type, f"unknown_{exit_type}"),
        "exitAction": exitaction,
        "random": BOOLEAN_MAP[random_flag],
        "areaExit": parse_area_exit(areaexit),
        "door": {
            "name": doorname,
            "type": int(doortype),
            "keyName": keyname,
            "keyDescription": keydesc,
            "keyRoom": keyroom_value,
        },
        "forceBroken": BOOLEAN_MAP[forcebroken],
    }


def parse_exits(text: str) -> List[Dict[str, Any]]:
    exits: List[Dict[str, Any]] = []
    for match in EXIT_PATTERN.finditer(text):
        exits.append(parse_exit(match))
    return exits


def build_room_connections(exits: List[Dict[str, Any]]) -> Dict[int, List[Dict[str, Any]]]:
    connections: Dict[int, List[Dict[str, Any]]] = {}

    def add_connection(from_room: int, to_room: Optional[int], exit_info: Dict[str, Any], direction_type: int) -> None:
        connection = {
            "to": to_room,
            "direction": EXIT_TYPE_NAMES.get(direction_type, f"unknown_{direction_type}"),
            "linkType": exit_info["linkType"],
            "exitType": direction_type,
            "exitAction": exit_info["exitAction"],
            "random": exit_info["random"],
            "areaExit": exit_info["areaExit"],
            "door": exit_info["door"],
            "forceBroken": exit_info["forceBroken"],
        }
        connections.setdefault(from_room, []).append(connection)

    for exit_info in exits:
        room1 = exit_info["room1"]
        room2 = exit_info["room2"] if exit_info["room2"] is not None else None
        exit_type = exit_info["exitType"]

        add_connection(room1, room2, exit_info, exit_type)

        if exit_info["linkType"] == LINK_CONSTANTS["LINK_TWOWAY"] and room2 is not None:
            reverse_exit_type = OPPOSITE_EXIT_TYPES.get(exit_type, exit_type)
            add_connection(room2, room1, exit_info, reverse_exit_type)

    return connections


LABEL_PATTERN = re.compile(
    r"labels\[(\d+)\]\s*=\s*new MapLabel\(\s*(-?\d+),\s*(-?\d+),\s*(-?\d+),\s*\"([^\"]*)\",\s*\"([^\"]*)\",\s*(\d+)\s*\);"
)


def parse_labels(text: str) -> List[Dict[str, Any]]:
    labels: List[Dict[str, Any]] = []
    for match in LABEL_PATTERN.finditer(text):
        index, xpos, ypos, width, text_value, color, label_type = match.groups()
        labels.append(
            {
                "index": int(index),
                "x": int(xpos),
                "y": int(ypos),
                "width": int(width),
                "text": text_value,
                "color": color,
                "type": int(label_type),
            }
        )
    return labels


def parse_map_file(html_path: Path) -> Dict[str, Any]:
    text = html_path.read_text(encoding="utf-8", errors="replace")
    exits = parse_exits(text)
    return {
        "sourceFile": html_path.name,
        "metadata": parse_area_metadata(text),
        "rooms": parse_rooms(text),
        "exits": exits,
        "roomConnections": build_room_connections(exits),
        "labels": parse_labels(text),
    }


def main() -> None:
    OUTPUT_DIR.mkdir(exist_ok=True)
    for html_file in MAPS_DIR.glob("*.html"):
        parsed = parse_map_file(html_file)
        output_path = OUTPUT_DIR / f"{html_file.stem}.json"
        output_path.write_text(json.dumps(parsed, indent=2, sort_keys=True), encoding="utf-8")
        print(f"Parsed {html_file.name} -> {output_path}")


if __name__ == "__main__":
    main()
