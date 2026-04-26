#!/usr/bin/env python3

"""Render curated Karura figures from asset-scoped figure definitions."""

from __future__ import annotations
import argparse
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

from .asset_contracts import (
    load_required_figure_catalog,
    load_required_junction_bindings,
    load_required_junction_catalog,
)
from .karura_common import (
    CONTIGS_JSON,
    CURATED_DIR,
    DEBUG_DIR,
    JUNCTION_BINDINGS_JSON,
    JUNCTIONS_JSON,
    VIEWPORT,
    print_json_document,
)
from .karura_routing import load_route_graph, resolve_junction_ref
from .render_support import load_viewport, project_lon_lat


FIGURES_JSON = CURATED_DIR / "karura_figures.json"
OVERLAY_BY_ASSET_KIND = {
    "contig_graph": DEBUG_DIR / "karura-contigs-random-overlay.png",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--figures-json", type=Path, default=FIGURES_JSON)
    parser.add_argument("--contigs-json", type=Path, default=CONTIGS_JSON)
    parser.add_argument("--junctions-json", type=Path, default=JUNCTIONS_JSON)
    parser.add_argument("--junction-bindings-json", type=Path, default=JUNCTION_BINDINGS_JSON)
    parser.add_argument("--viewport", type=Path, default=VIEWPORT)
    parser.add_argument("--figure-id", default="junctions_primary")
    parser.add_argument("--output", type=Path)
    return parser.parse_args()


def load_font(size: int) -> ImageFont.ImageFont:
    try:
        return ImageFont.truetype("DejaVuSans.ttf", size=size)
    except OSError:
        return ImageFont.load_default()


def draw_marker(draw: ImageDraw.ImageDraw, point: tuple[float, float], color: tuple[int, int, int, int]) -> None:
    x, y = point
    draw.ellipse((x - 16, y - 16, x + 16, y + 16), fill=(255, 255, 255, 240))
    draw.ellipse((x - 11, y - 11, x + 11, y + 11), fill=color)
    draw.ellipse((x - 4, y - 4, x + 4, y + 4), fill=(20, 20, 20, 255))


def draw_label(
    draw: ImageDraw.ImageDraw,
    *,
    point: tuple[float, float],
    title: str,
    subtitle: str,
    color: tuple[int, int, int, int],
    label_dx: int,
    label_dy: int,
    title_font: ImageFont.ImageFont,
    subtitle_font: ImageFont.ImageFont,
) -> None:
    x, y = point
    box_x = x + label_dx
    box_y = y + label_dy
    padding_x = 20
    padding_y = 14
    line_gap = 8

    title_bbox = draw.textbbox((0, 0), title, font=title_font)
    subtitle_bbox = draw.textbbox((0, 0), subtitle, font=subtitle_font)
    text_width = max(title_bbox[2] - title_bbox[0], subtitle_bbox[2] - subtitle_bbox[0])
    title_height = title_bbox[3] - title_bbox[1]
    subtitle_height = subtitle_bbox[3] - subtitle_bbox[1]
    box_w = text_width + padding_x * 2
    box_h = title_height + subtitle_height + padding_y * 2 + line_gap

    box = (box_x, box_y, box_x + box_w, box_y + box_h)
    anchor = (box_x + box_w / 2, box_y + box_h / 2)
    draw.line((x, y, anchor[0], anchor[1]), fill=color, width=5)
    draw.rounded_rectangle(box, radius=18, fill=(255, 255, 255, 230), outline=color, width=4)
    draw.text((box_x + padding_x, box_y + padding_y), title, fill=(20, 20, 20, 255), font=title_font)
    draw.text(
        (box_x + padding_x, box_y + padding_y + title_height + line_gap),
        subtitle,
        fill=(70, 70, 70, 255),
        font=subtitle_font,
    )


def resolve_figure(payload: dict, figure_id: str) -> dict:
    for figure in payload["figures"]:
        if figure["id"] == figure_id:
            return figure
    raise KeyError(f"Figure '{figure_id}' not found")

def main() -> None:
    args = parse_args()
    figures_payload = load_required_figure_catalog(args.figures_json, label="figure catalog")
    figure = resolve_figure(figures_payload, args.figure_id)
    overlay_path = OVERLAY_BY_ASSET_KIND["contig_graph"]
    overlay = Image.open(overlay_path).convert("RGBA")
    viewport = load_viewport(args.viewport)
    graph = load_route_graph(args.contigs_json)

    junctions_payload = load_required_junction_catalog(args.junctions_json, label="junction catalog")
    junction_bindings = load_required_junction_bindings(args.junction_bindings_json, label="junction bindings")

    title_font = load_font(42)
    subtitle_font = load_font(24)
    header_font = load_font(54)

    draw = ImageDraw.Draw(overlay, "RGBA")
    draw.rounded_rectangle((36, 36, 720, 170), radius=24, fill=(255, 255, 255, 220), outline=(25, 25, 25, 255), width=3)
    draw.text((68, 56), figure["header"]["title"], fill=(20, 20, 20, 255), font=header_font)
    draw.text((72, 118), figure["header"]["subtitle"], fill=(60, 60, 60, 255), font=subtitle_font)

    for item in figure["items"]:
        junction_ref = resolve_junction_ref(
            junctions_payload,
            item["junction_id"],
            graph.asset_id,
            junction_bindings,
        )
        node = graph.nodes[junction_ref.graph_node_id]
        point = project_lon_lat(node.lon, node.lat, viewport, overlay.size)
        color = tuple(item["color"])
        draw_marker(draw, point, color)
        draw_label(
            draw,
            point=point,
            title=junction_ref.name,
            subtitle=item.get("subtitle_template", "{graph_node_id}").format(
                graph_node_id=junction_ref.graph_node_id,
                incident_contig_ids=list(junction_ref.incident_contig_ids),
                junction_id=junction_ref.junction_id,
                name=junction_ref.name,
                **junction_ref.location,
            ),
            color=color,
            label_dx=item["label_dx"],
            label_dy=item["label_dy"],
            title_font=title_font,
            subtitle_font=subtitle_font,
        )

    output = args.output or (args.figures_json.parent / figure["output_path"])
    output.parent.mkdir(parents=True, exist_ok=True)
    overlay.save(output)
    print_json_document({"figure_id": figure["id"], "output": str(output)})


if __name__ == "__main__":
    main()
