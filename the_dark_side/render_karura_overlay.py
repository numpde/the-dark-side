#!/usr/bin/env python3

"""Render Karura overlay images from the normalized map JSON."""

import argparse
import json
import random
from pathlib import Path

from PIL import ImageDraw

from .asset_contracts import load_required_patchset, load_route_graph_document
from .download_karura_map import load_map
from .karura_common import (
    CONTIGS_JSON,
    DEBUG_DIR,
    MAP_PATCHES_JSON,
    SCREENSHOT,
    VIEWPORT,
    include_editor_way,
    include_ride_way,
    mercator,
    resolve_map_json,
)
from .render_support import load_viewport, prepare_base_image, project_mercator_point


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


def parse_map(path, mode):
    karura_map = load_map(path)
    nodes = {
        int(node_id): mercator(node.lon, node.lat)
        for node_id, node in karura_map.nodes.items()
    }

    filtered = []
    for way_id, way in karura_map.ways.items():
        tags = way.tags
        if not include_way(way_id, tags, mode):
            continue
        segments = []
        for first_id, second_id in way.segment_pairs:
            if first_id not in nodes or second_id not in nodes:
                continue
            segments.append((nodes[first_id], nodes[second_id]))
        if segments:
            filtered.append((way_id, segments, tags))

    return filtered


def parse_contigs(path):
    payload = load_route_graph_document(path, label="route graph")
    nodes = {
        int(node_id): mercator(node["lon"], node["lat"])
        for node_id, node in payload["nodes"].items()
    }

    contigs = []
    for contig in payload["contigs"]:
        segments = []
        for first_id, second_id in contig["segment_pairs"]:
            if first_id not in nodes or second_id not in nodes:
                continue
            segments.append((nodes[first_id], nodes[second_id]))
        if segments:
            contigs.append((int(contig["id"]), segments, contig))

    return contigs


def parse_patches(path):
    payload = load_required_patchset(path, label="patchset file")
    patch_items = []
    for patch in payload["patches"]:
        if not patch.get("enabled", True):
            continue
        if patch.get("op") != "add_way":
            continue
        node_lookup = {
            int(node["id"]): mercator(float(node["lon"]), float(node["lat"]))
            for node in patch.get("nodes", [])
        }
        segments = []
        node_ids = [int(node_id) for node_id in patch.get("node_ids", [])]
        for first_id, second_id in zip(node_ids, node_ids[1:]):
            if first_id not in node_lookup or second_id not in node_lookup:
                continue
            segments.append((node_lookup[first_id], node_lookup[second_id]))
        if segments:
            patch_items.append((str(patch["id"]), segments, patch))
    return patch_items


def main():
    args = parse_args()
    viewport = load_viewport(args.viewport)
    img = prepare_base_image(args.screenshot)
    draw = ImageDraw.Draw(img, "RGBA")

    map_json = args.map_json or resolve_map_json()
    if args.mode == "contigs":
        ways = parse_contigs(args.contigs_json)
    elif args.mode == "patches":
        ways = parse_patches(args.patches_json)
    else:
        ways = parse_map(map_json, args.mode)
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
    print(
        json.dumps(
            {"mode": args.mode, "ways": len(ways), "segments": segment_count, "output": str(out)},
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
