#!/usr/bin/env python3

"""Render a planned Karura route on the aligned screenshot."""

from __future__ import annotations

import argparse
import math
from pathlib import Path

from PIL import ImageDraw

from .asset_contracts import load_route_asset_document
from .karura_common import SCREENSHOT, VIEWPORT, print_json_document
from .karura_routing import load_route_asset_graph, orient_contig_node_ids
from .render_support import load_viewport, prepare_base_image, project_lon_lat


ROUTE_START_COLOR = (36, 96, 220, 235)
ROUTE_END_COLOR = (230, 40, 40, 235)
BACKGROUND_CONTIG_COLOR = (80, 80, 80, 100)
START_COLOR = (48, 160, 64, 255)
END_COLOR = (36, 96, 220, 255)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("route_json", type=Path)
    parser.add_argument("--route-index", type=int, default=0)
    parser.add_argument("--screenshot", type=Path, default=SCREENSHOT)
    parser.add_argument("--viewport", type=Path, default=VIEWPORT)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--hide-background-contigs", action="store_true")
    return parser.parse_args()


def default_output(route_json: Path, route_payload: dict, route_index: int) -> Path:
    base = route_json.stem
    algorithm = route_payload["meta"]["algorithm"]
    return route_json.parent / f"{base}-route{route_index + 1}-{algorithm}-overlay.png"


def draw_marker(draw: ImageDraw.ImageDraw, point: tuple[float, float], color: tuple[int, int, int, int]) -> None:
    x, y = point
    draw.ellipse((x - 14, y - 14, x + 14, y + 14), fill=(255, 255, 255, 235))
    draw.ellipse((x - 9, y - 9, x + 9, y + 9), fill=color)


def lerp_color(
    start: tuple[int, int, int, int],
    end: tuple[int, int, int, int],
    fraction: float,
) -> tuple[int, int, int, int]:
    clamped = max(0.0, min(1.0, fraction))
    return tuple(
        int(round(start[index] + (end[index] - start[index]) * clamped))
        for index in range(4)
    )


def segment_length(a: tuple[float, float], b: tuple[float, float]) -> float:
    return math.hypot(b[0] - a[0], b[1] - a[1])


def main() -> None:
    args = parse_args()
    route_payload = load_route_asset_document(args.route_json, label="route asset")
    graph = load_route_asset_graph(route_payload, args.route_json)
    viewport = load_viewport(args.viewport)
    image = prepare_base_image(args.screenshot)
    draw = ImageDraw.Draw(image, "RGBA")

    if args.route_index >= len(route_payload["routes"]):
        raise IndexError(
            f"Route index {args.route_index} is out of range for {len(route_payload['routes'])} planned routes"
        )
    route = route_payload["routes"][args.route_index]

    if not args.hide_background_contigs:
        for contig in graph.contigs.values():
            points = [
                project_lon_lat(graph.nodes[node_id].lon, graph.nodes[node_id].lat, viewport, image.size)
                for node_id in contig.node_ids
            ]
            draw.line(points, fill=BACKGROUND_CONTIG_COLOR, width=3)

    route_total_length = max(float(route["total_length_m"]), 1.0)
    traversed_length = 0.0
    for step in route["steps"]:
        contig = graph.contigs[int(step["contig_id"])]
        oriented = orient_contig_node_ids(
            contig,
            int(step["from_node_id"]),
            int(step["to_node_id"]),
        )
        points = [
            project_lon_lat(graph.nodes[node_id].lon, graph.nodes[node_id].lat, viewport, image.size)
            for node_id in oriented
        ]
        for first, second in zip(points, points[1:]):
            piece_length = segment_length(first, second)
            midpoint_length = traversed_length + piece_length / 2
            color = lerp_color(ROUTE_START_COLOR, ROUTE_END_COLOR, midpoint_length / route_total_length)
            if step["reused"]:
                color = (color[0], color[1], color[2], 170)
            draw.line((first, second), fill=color, width=7)
            traversed_length += piece_length

    start_node = graph.nodes[int(route_payload["start"]["graph_node_id"])]
    end_node = graph.nodes[int(route_payload["end"]["graph_node_id"])]
    draw_marker(draw, project_lon_lat(start_node.lon, start_node.lat, viewport, image.size), START_COLOR)
    draw_marker(draw, project_lon_lat(end_node.lon, end_node.lat, viewport, image.size), END_COLOR)

    output = args.output or default_output(args.route_json, route_payload, args.route_index)
    output.parent.mkdir(parents=True, exist_ok=True)
    image.save(output)
    print_json_document({"route_index": args.route_index, "output": str(output)})


if __name__ == "__main__":
    main()
