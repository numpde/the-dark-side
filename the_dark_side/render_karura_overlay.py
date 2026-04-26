#!/usr/bin/env python3

"""Render Karura overlay images from the normalized map JSON."""

import argparse
import random
from pathlib import Path

from PIL import ImageDraw

from .karura_common import (
    CONTIGS_JSON,
    DEBUG_DIR,
    MAP_PATCHES_JSON,
    SCREENSHOT,
    VIEWPORT,
    include_editor_way,
    include_ride_way,
    print_json_document,
    resolve_map_json,
)
from .render_support import (
    load_viewport,
    load_overlay_items_from_map,
    load_overlay_items_from_patchset,
    load_overlay_items_from_route_graph,
    prepare_base_image,
    project_mercator_point,
)


OUT_BY_MODE = {
    "ride": DEBUG_DIR / "karura-ride-graph-random-overlay.png",
    "all": DEBUG_DIR / "karura-all-ways-control-overlay.png",
    "contigs": DEBUG_DIR / "karura-contigs-random-overlay.png",
    "patches": DEBUG_DIR / "karura-patches-random-overlay.png",
}
def parse_args():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mode", choices=("ride", "all", "contigs", "patches"), default="ride")
    parser.add_argument("--map-json", type=Path)
    parser.add_argument("--contigs-json", type=Path, default=CONTIGS_JSON)
    parser.add_argument("--patches-json", type=Path, default=MAP_PATCHES_JSON)
    parser.add_argument("--screenshot", type=Path, default=SCREENSHOT)
    parser.add_argument("--viewport", type=Path, default=VIEWPORT)
    parser.add_argument("--output", type=Path)
    return parser.parse_args()


def include_way(way_id, tags, mode):
    if mode == "all":
        return include_editor_way(way_id, tags)
    return include_ride_way(way_id, tags)


def main():
    args = parse_args()
    viewport = load_viewport(args.viewport)
    img = prepare_base_image(args.screenshot)
    draw = ImageDraw.Draw(img, "RGBA")

    map_json = args.map_json or resolve_map_json()
    if args.mode == "contigs":
        ways = load_overlay_items_from_route_graph(args.contigs_json)
    elif args.mode == "patches":
        ways = load_overlay_items_from_patchset(args.patches_json)
    else:
        ways = load_overlay_items_from_map(
            map_json,
            include_way=lambda way_id, tags: include_way(way_id, tags, args.mode),
        )
    rng = random.Random(7)
    segment_count = 0

    for item_id, segments, _ in ways:
        contig_color = None
        if args.mode in {"contigs", "patches"}:
            contig_rng = random.Random(item_id)
            contig_color = (
                contig_rng.randint(40, 255),
                contig_rng.randint(40, 255),
                contig_rng.randint(40, 255),
                220,
            )
        for idx, (a, b) in enumerate(segments):
            p0 = project_mercator_point(a, viewport, img.size)
            p1 = project_mercator_point(b, viewport, img.size)
            if contig_color is None:
                # Deterministic but varied colors for graph inspection.
                color = (
                    rng.randint(40, 255),
                    rng.randint(40, 255),
                    rng.randint(40, 255),
                    210,
                )
                width = 4 if idx == 0 else 3
            else:
                color = contig_color
                width = 4
            draw.line((p0, p1), fill=color, width=width)
            segment_count += 1

    out = args.output or OUT_BY_MODE[args.mode]
    out.parent.mkdir(parents=True, exist_ok=True)
    img.save(out)
    print_json_document({"mode": args.mode, "ways": len(ways), "segments": segment_count, "output": str(out)})


if __name__ == "__main__":
    main()
