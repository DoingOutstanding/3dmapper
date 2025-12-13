#!/usr/bin/env python3
"""Generate a CSV table of area-to-area/continent exits."""
import csv
import json
import pathlib
from collections import defaultdict, deque

ROOT = pathlib.Path(__file__).resolve().parent.parent
DATABASE = ROOT / "Database"
# Areas to exclude from the generated table (and from providing connections).
EXCLUDED_AREAS = {"immortal homes", "a bad trip"}
# Areas with known continent placement even when no graph connection exists.
CONTINENT_OVERRIDES = {
    "aardwolf winter festival 2008": "The Continent of Mesolar",
    "arboria": "The Continent of Mesolar",
    "black claw crag": "The Continent of Mesolar",
    "castle reinhold": "The Continent of Mesolar",
    "dune: the desert planet": "Alagh, the Blood Lands",
    "limbo": "The Continent of Mesolar",
    "midgaard": "The Continent of Mesolar",
    "mossflower wood": "The Continent of Mesolar",
    "nowhere": "The Continent of Mesolar",
    "old clan holding area 1": "The Continent of Mesolar",
    "old clan holding area 2": "The Continent of Mesolar",
    "old clan holding area 3": "The Continent of Mesolar",
    "old clan holding area 4": "The Continent of Mesolar",
    "raiding school": "The Continent of Mesolar",
    "ranger heaven": "Alagh, the Blood Lands",
    "sea king's dominion": "The Southern Ocean",
    "st:tng": "The Continent of Mesolar",
    "secret imm project #69": "The Continent of Mesolar",
    "stonekeep": "The Continent of Mesolar",
    "the adventurers' wayhouse": "The Continent of Mesolar",
    "the casino": "The Continent of Mesolar",
    "the dwarven kingdom": "The Continent of Mesolar",
    "the fortress of angband": "The Continent of Mesolar",
    "the island of stardock": "The Southern Ocean",
    "the laser zone": "The Continent of Mesolar",
    "the mirror realm": "The Continent of Mesolar",
    "the onslaught of chaos": "The Continent of Mesolar",
    "the port": "The Continent of Mesolar",
    "the river of despair": "The Continent of Mesolar",
    "the grand city of aylor": "The Continent of Mesolar",
    "ultima": "The Continent of Mesolar",
    "white claw cavern": "The Continent of Mesolar",
}
# Canonical continent names with matching keywords used for detection in area names.
CONTINENTS: list[tuple[str, tuple[str, ...]]] = [
    ("The Dark Continent, Abend", ("dark continent", "abend")),
    ("Alagh, the Blood Lands", ("alagh", "blood lands")),
    ("Gelidus", ("gelidus",)),
    ("The Continent of Mesolar", ("mesolar",)),
    ("The Southern Ocean", ("southern ocean",)),
    ("The Uncharted Oceans", ("uncharted ocean", "uncharted oceans")),
]


def normalize_continent(name: str) -> str | None:
    lowered = (name or "").lower()
    for canonical, keywords in CONTINENTS:
        if any(keyword in lowered for keyword in keywords):
            return canonical
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
        if name.lower() in EXCLUDED_AREAS:
            continue
        names[uid] = name
        continents[uid] = normalize_continent(name)
    return names, continents


def collect_area_connections(exits, room_index, allowed_areas: set[str]):
    connections: dict[str, set[str]] = defaultdict(set)
    adjacency: dict[str, set[str]] = defaultdict(set)
    for exit_ in exits:
        from_area = room_index.get(exit_.get("fromuid"))
        to_area = room_index.get(exit_.get("touid"))
        if (
            not from_area
            or not to_area
            or from_area == to_area
            or from_area not in allowed_areas
            or to_area not in allowed_areas
        ):
            continue
        connections[from_area].add(to_area)
        adjacency[from_area].add(to_area)
        adjacency[to_area].add(from_area)
    return connections, adjacency


def format_exit_label(area_id: str, area_names: dict[str, str], area_continents: dict[str, str | None]):
    name = area_names.get(area_id, area_id)
    continent = area_continents.get(area_id)
    if continent:
        return f"{name} ({continent})"
    return name


def write_table(area_names, area_continents, connections, adjacency):
    output = DATABASE / "area-exits.csv"
    continent_ids = {area_id for area_id, label in area_continents.items() if label}

    def reachable_continent(area_id: str, cache: dict[str, str | None]):
        if area_id in cache:
            return cache[area_id]

        visited = {area_id}
        queue = deque((target, 1) for target in adjacency.get(area_id, set()))
        shortest_depth: int | None = None
        found: set[str] = set()

        while queue:
            target, depth = queue.popleft()
            if target in visited:
                continue
            visited.add(target)

            if shortest_depth is not None and depth > shortest_depth:
                continue

            continent = area_continents.get(target)
            if continent:
                found.add(continent)
                shortest_depth = depth if shortest_depth is None else shortest_depth
                continue

            queue.extend((next_target, depth + 1) for next_target in adjacency.get(target, set()))

        prioritized = None
        if shortest_depth is not None:
            continent_priority = {name: idx for idx, (name, _) in enumerate(CONTINENTS)}
            prioritized = sorted(found, key=lambda name: continent_priority.get(name, 99))[0]

        cache[area_id] = prioritized
        return prioritized

    continent_cache: dict[str, str | None] = {}
    with output.open("w", newline="", encoding="utf-8") as fp:
        writer = csv.writer(fp)
        writer.writerow(["Area Name", "Continent", "Exits"])
        for area_id, area_name in sorted(area_names.items(), key=lambda item: item[1]):
            if area_id in continent_ids:
                continue

            sorted_targets = sorted(
                connections.get(area_id, set()), key=lambda aid: area_names.get(aid, aid)
            )
            exit_labels = [
                format_exit_label(target_id, area_names, area_continents)
                for target_id in sorted_targets
            ]

            continent_label = CONTINENT_OVERRIDES.get(area_name.lower())
            if not continent_label:
                continent_label = reachable_continent(area_id, continent_cache)
            if not continent_label:
                continent_label = "-"

            non_continent_exits = [
                label for target_id, label in zip(sorted_targets, exit_labels)
                if target_id not in continent_ids
            ]
            if non_continent_exits:
                exits = "; ".join(non_continent_exits)
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
    connections, adjacency = collect_area_connections(exits, room_index, set(area_names))
    output = write_table(area_names, area_continents, connections, adjacency)
    print(f"Wrote {output.relative_to(ROOT)} with {len(area_names)} areas.")


if __name__ == "__main__":
    main()
