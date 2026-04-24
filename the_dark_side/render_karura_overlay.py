#!/usr/bin/env python3

"""Render Karura overlay images from the normalized map JSON."""

import argparse
import json
import random
from pathlib import Path

from PIL import Image, ImageDraw, ImageOps

from .karura_common import (
    CONTIGS_JSON,
    DEBUG_DIR,
    EXCLUDED_WAY_IDS,
    MAP_JSON,
    SCREENSHOT,
    VIEWPORT,
    include_ride_way,
    mercator,
)


OUT_BY_MODE = {
    "ride": DEBUG_DIR / "karura-ride-graph-random-overlay.png",
    "all": DEBUG_DIR / "karura-all-ways-control-overlay.png",
    "contigs": DEBUG_DIR / "karura-contigs-random-overlay.png",
}
BASE_IMAGE_ALPHA = 0.7


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mode", choices=("ride", "all", "contigs"), default="ride")
    parser.add_argument("--map-json", type=Path, default=MAP_JSON)
    parser.add_argument("--contigs-json", type=Path, default=CONTIGS_JSON)
    parser.add_argument("--screenshot", type=Path, default=SCREENSHOT)
    parser.add_argument("--viewport", type=Path, default=VIEWPORT)
    parser.add_argument("--output", type=Path)
    return parser.parse_args()


def include_way(way_id, tags, mode):
    if way_id in EXCLUDED_WAY_IDS:
        return False
    if mode == "all":
        return True
    return include_ride_way(way_id, tags)


def parse_map(path, mode):
    payload = json.loads(path.read_text())
    nodes = {
        int(node_id): mercator(node["lon"], node["lat"])
        for node_id, node in payload["nodes"].items()
    }

    filtered = []
    for way_id_text, way in payload["ways"].items():
        way_id = int(way_id_text)
        tags = way["tags"]
        if not include_way(way_id, tags, mode):
            continue
        segments = []
        for first_id, second_id in way["segment_pairs"]:
            if first_id not in nodes or second_id not in nodes:
                continue
            segments.append((nodes[first_id], nodes[second_id]))
        if segments:
            filtered.append((way_id, segments, tags))

    return filtered


def parse_contigs(path):
    payload = json.loads(path.read_text())
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


def project_point(xy, viewport, size):
    w, h = size
    return (
        (xy[0] - viewport["center_x"]) / viewport["meters_per_px"] + w / 2,
        (viewport["center_y"] - xy[1]) / viewport["meters_per_px"] + h / 2,
    )


def prepare_base_image(path):
    source = Image.open(path).convert("RGBA")
    grayscale = ImageOps.grayscale(source).convert("RGBA")
    grayscale.putalpha(int(round(255 * BASE_IMAGE_ALPHA)))
    canvas = Image.new("RGBA", source.size, (255, 255, 255, 255))
    canvas.alpha_composite(grayscale)
    return canvas


def main():
    args = parse_args()
    viewport = json.loads(args.viewport.read_text())["viewport"]
    img = prepare_base_image(args.screenshot)
    draw = ImageDraw.Draw(img, "RGBA")

    ways = parse_contigs(args.contigs_json) if args.mode == "contigs" else parse_map(args.map_json, args.mode)
    rng = random.Random(7)
    segment_count = 0

    for item_id, segments, _ in ways:
        contig_color = None
        if args.mode == "contigs":
            contig_rng = random.Random(item_id)
            contig_color = (
                contig_rng.randint(40, 255),
                contig_rng.randint(40, 255),
                contig_rng.randint(40, 255),
                220,
            )
        for idx, (a, b) in enumerate(segments):
            p0 = project_point(a, viewport, img.size)
            p1 = project_point(b, viewport, img.size)
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
