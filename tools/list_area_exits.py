#!/usr/bin/env python3
"""Generate a CSV table of area-to-area/continent exits."""
import csv
import json
import pathlib
from collections import defaultdict

ROOT = pathlib.Path(__file__).resolve().parent.parent
DATABASE = ROOT / "Database"
CONTINENT_NAMES = ["southern ocean", "uncharted ocean", "gelidus", "alagh", "abend", "mesolar"]


def normalize_continent(name: str) -> str | None:
    lowered = (name or "").lower()
    for continent in CONTINENT_NAMES:
        if continent in lowered:
            return continent
    return None


def load_json(path: pathlib.Path):
    return json.loads(path.read_text())


def build_room_index(rooms):
    return {room["uid"]: room.get("area") for room in rooms if room.get("area")}


def build_area_lookup(areas):
    names = {}
    continents = {}
    for area in areas:
        uid = area.get("uid")
        name = area.get("name", "")
        names[uid] = name
        continents[uid] = normalize_continent(name)
    return names, continents


def collect_area_connections(exits, room_index):
    connections: dict[str, set[str]] = defaultdict(set)
    for exit_ in exits:
        from_area = room_index.get(exit_.get("fromuid"))
        to_area = room_index.get(exit_.get("touid"))
        if not from_area or not to_area or from_area == to_area:
            continue
        connections[from_area].add(to_area)
    return connections


def format_exit_label(area_id: str, area_names: dict[str, str], area_continents: dict[str, str | None]):
    name = area_names.get(area_id, area_id)
    continent = area_continents.get(area_id)
    if continent:
        return f"{name} ({continent})"
    return name


def write_table(area_names, area_continents, connections):
    output = DATABASE / "area-exits.csv"
    with output.open("w", newline="", encoding="utf-8") as fp:
        writer = csv.writer(fp)
        writer.writerow(["Area Name", "Continent", "Exits"])
        for area_id, area_name in sorted(area_names.items(), key=lambda item: item[1]):
            exit_labels = [
                format_exit_label(target_id, area_names, area_continents)
                for target_id in sorted(
                    connections.get(area_id, set()), key=lambda aid: area_names.get(aid, aid)
                )
            ]
            continent_label = area_continents.get(area_id) or "-"
            if exit_labels:
                exits = "; ".join(exit_labels)
            else:
                exits = "(no exits to other areas)"
            writer.writerow([area_name, continent_label, exits])
    return output


def main():
    areas = load_json(DATABASE / "areas.json")
    rooms = load_json(DATABASE / "rooms.json")
    exits = load_json(DATABASE / "exits.json")

    area_names, area_continents = build_area_lookup(areas)
    room_index = build_room_index(rooms)
    connections = collect_area_connections(exits, room_index)
    output = write_table(area_names, area_continents, connections)
    print(f"Wrote {output.relative_to(ROOT)} with {len(area_names)} areas.")


if __name__ == "__main__":
    main()
