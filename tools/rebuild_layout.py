#!/usr/bin/env python3
"""Rebuild mega-coordinates using exit directions and report continent overlaps."""
import json
import pathlib
import re
from collections import Counter, defaultdict

ROOT = pathlib.Path(__file__).resolve().parent.parent
DATABASE = ROOT / "Database"
CONTINENT_NAMES = ["southern ocean", "uncharted ocean", "gelidus", "alagh", "abend", "mesolar"]
ALLOWED_DIRS = {"n", "s", "e", "w", "u", "d"}
DIR_VECTORS = {
    "n": (0.0, 1.0, 0.0),
    "s": (0.0, -1.0, 0.0),
    "e": (1.0, 0.0, 0.0),
    "w": (-1.0, 0.0, 0.0),
    "u": (0.0, 0.0, 1.0),
    "d": (0.0, 0.0, -1.0),
}
OPPOSITE = {"n": "s", "s": "n", "e": "w", "w": "e", "u": "d", "d": "u"}
GRID_SPACING = 140.0
ITERATIONS = 900
BLEND = 0.7


def normalize_continent(name: str) -> str | None:
    lowered = (name or "").lower()
    for continent in CONTINENT_NAMES:
        if continent in lowered:
            return continent
    return None


def normalize_dir(raw: str | None) -> str | None:
    if not raw:
        return None
    text = raw.lower()
    if text in ALLOWED_DIRS:
        return text

    keyword_map = {
        "north": "n",
        "south": "s",
        "east": "e",
        "west": "w",
        "up": "u",
        "down": "d",
    }
    for keyword, direction in keyword_map.items():
        if keyword in text:
            return direction

    tokens = [token for token in re.split(r"[^a-z]+", text) if token]
    for token in tokens:
        if token in ALLOWED_DIRS:
            return token
        if len(token) == 1 and token in ALLOWED_DIRS:
            return token
    return None


def load_json(path: pathlib.Path):
    return json.loads(path.read_text())


def collect_area_sets(areas):
    continent_ids = {area["uid"] for area in areas if normalize_continent(area.get("name"))}
    selected_ids = [area["uid"] for area in areas if area["uid"] not in continent_ids]
    names = {area["uid"]: area.get("name", "") for area in areas}
    return continent_ids, selected_ids, names


def build_room_index(rooms, selected_ids):
    allowed = set(selected_ids)
    index = {}
    for room in rooms:
        if room.get("area") in allowed:
            index[room["uid"]] = room["area"]
    return index


def collect_constraints(exits, room_index, continent_ids):
    best_dirs: dict[tuple[str, str], Counter] = defaultdict(Counter)
    for exit_ in exits:
        from_area = room_index.get(exit_["fromuid"])
        to_area = room_index.get(exit_["touid"])
        if not from_area or not to_area or from_area == to_area:
            continue
        if from_area in continent_ids or to_area in continent_ids:
            continue
        direction = normalize_dir(exit_.get("dir"))
        if direction not in DIR_VECTORS:
            continue
        best_dirs[(from_area, to_area)][direction] += 1

    constraints: list[tuple[str, str, tuple[float, float, float]]] = []
    for (from_area, to_area), counts in best_dirs.items():
        direction, _ = counts.most_common(1)[0]
        vec = DIR_VECTORS[direction]
        constraints.append((from_area, to_area, vec))
        opposite = OPPOSITE[direction]
        constraints.append((to_area, from_area, DIR_VECTORS[opposite]))
    return constraints


def seed_positions(selected_ids, saved_positions):
    positions = {}
    for area_id in selected_ids:
        if area_id in saved_positions:
            positions[area_id] = list(saved_positions[area_id])
        else:
            positions[area_id] = [0.0, 0.0, 0.0]
    return positions


def relax_positions(positions, constraints):
    for _ in range(ITERATIONS):
        contributions: dict[str, list[float]] = defaultdict(lambda: [0.0, 0.0, 0.0, 0])
        for from_area, to_area, vector in constraints:
            base = positions[from_area]
            target = [base[i] + vector[i] * GRID_SPACING for i in range(3)]
            accum = contributions[to_area]
            for i in range(3):
                accum[i] += target[i]
            accum[3] += 1

        for area_id, accum in contributions.items():
            count = accum[3]
            if not count:
                continue
            current = positions[area_id]
            average = [accum[i] / count for i in range(3)]
            positions[area_id] = [current[i] * (1 - BLEND) + average[i] * BLEND for i in range(3)]

    # center on origin for readability
    xs, ys = zip(*[(pos[0], pos[1]) for pos in positions.values()])
    offset_x = sum(xs) / len(xs)
    offset_y = sum(ys) / len(ys)
    for pos in positions.values():
        pos[0] -= offset_x
        pos[1] -= offset_y
    return positions


def write_positions(positions):
    output = {area_id: {"x": pos[0], "y": pos[1], "z": pos[2]} for area_id, pos in sorted(positions.items())}
    target = DATABASE / "mega-coordinates.json"
    target.write_text(json.dumps(output, indent=2))
    return target


def collect_continent_overlaps(exits, room_index, area_names):
    area_continents: dict[str, set[str]] = defaultdict(set)
    for exit_ in exits:
        from_area = room_index.get(exit_["fromuid"])
        to_area = room_index.get(exit_["touid"])
        if not from_area or not to_area or from_area == to_area:
            continue
        continent = normalize_continent(area_names.get(to_area))
        if continent:
            area_continents[from_area].add(continent)
    overlaps = {area: sorted(list(conts)) for area, conts in area_continents.items() if len(conts) > 1}
    return overlaps


def write_overlaps(overlaps, area_names):
    lines = ["Areas linked to multiple continents:"]
    if not overlaps:
        lines.append("(none)")
    else:
        for area_id, conts in sorted(overlaps.items(), key=lambda item: area_names.get(item[0], item[0])):
            name = area_names.get(area_id, area_id)
            continent_label = ", ".join(conts)
            lines.append(f"- {name} ({area_id}): {continent_label}")
    target = DATABASE / "continent-overlaps.txt"
    target.write_text("\n".join(lines) + "\n")
    return target


def main():
    areas = load_json(DATABASE / "areas.json")
    rooms = load_json(DATABASE / "rooms.json")
    exits = load_json(DATABASE / "exits.json")
    saved_offsets = load_json(DATABASE / "mega-coordinates.json") if (DATABASE / "mega-coordinates.json").exists() else {}

    continent_ids, selected_ids, area_names = collect_area_sets(areas)
    room_index = build_room_index(rooms, selected_ids)
    constraints = collect_constraints(exits, room_index, continent_ids)
    positions = seed_positions(selected_ids, {k: (v["x"], v["y"], v["z"]) for k, v in saved_offsets.items()})
    positions = relax_positions(positions, constraints)
    position_file = write_positions(positions)

    overlaps = collect_continent_overlaps(exits, room_index, area_names)
    overlap_file = write_overlaps(overlaps, area_names)

    print(f"Updated {position_file.relative_to(ROOT)} with {len(positions)} area positions.")
    print(f"Wrote {overlap_file.relative_to(ROOT)} with {len(overlaps)} overlap entries.")


if __name__ == "__main__":
    main()
