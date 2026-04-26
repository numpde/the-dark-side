"""Shared helpers for screenshot-aligned debug renderers."""

from __future__ import annotations

import json
import math
from collections.abc import Iterable
from pathlib import Path

from PIL import Image, ImageOps

from .asset_contracts import load_required_json, load_required_patchset
from .download_karura_map import load_map
from .karura_common import mercator
from .karura_routing import load_route_graph


BASE_IMAGE_ALPHA = 0.7


def load_viewport(path: Path) -> dict:
    payload = load_required_json(path, label="viewport document")
    viewport = payload.get("viewport")
    if not isinstance(viewport, dict):
        raise ValueError("viewport document.viewport must be an object")
    normalized = dict(viewport)
    for key in ("center_x", "center_y", "meters_per_px"):
        value = normalized.get(key)
        if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(float(value)):
            raise ValueError(f"viewport document.viewport.{key} must be a finite number")
        normalized[key] = float(value)
    return normalized


def prepare_base_image(path: Path, *, alpha: float = BASE_IMAGE_ALPHA) -> Image.Image:
    source = Image.open(path).convert("RGBA")
    grayscale = ImageOps.grayscale(source).convert("RGBA")
    grayscale.putalpha(int(round(255 * alpha)))
    canvas = Image.new("RGBA", source.size, (255, 255, 255, 255))
    canvas.alpha_composite(grayscale)
    return canvas


def project_mercator_point(xy: tuple[float, float], viewport: dict, size: tuple[int, int]) -> tuple[float, float]:
    width, height = size
    return (
        (xy[0] - viewport["center_x"]) / viewport["meters_per_px"] + width / 2,
        (viewport["center_y"] - xy[1]) / viewport["meters_per_px"] + height / 2,
    )


def project_lon_lat(lon: float, lat: float, viewport: dict, size: tuple[int, int]) -> tuple[float, float]:
    return project_mercator_point(mercator(lon, lat), viewport, size)


def mercator_lookup_from_map(karura_map) -> dict[int, tuple[float, float]]:
    return {
        int(node_id): mercator(node.lon, node.lat)
        for node_id, node in karura_map.nodes.items()
    }


def mercator_lookup_from_graph_document(payload: dict) -> dict[int, tuple[float, float]]:
    return {
        int(node_id): mercator(node["lon"], node["lat"])
        for node_id, node in payload["nodes"].items()
    }


def mercator_lookup_from_route_graph(graph) -> dict[int, tuple[float, float]]:
    return {
        int(node_id): mercator(node.lon, node.lat)
        for node_id, node in graph.nodes.items()
    }


def segments_from_node_pairs(
    node_pairs: Iterable[tuple[int, int]],
    *,
    node_lookup: dict[int, tuple[float, float]],
) -> list[tuple[tuple[float, float], tuple[float, float]]]:
    segments: list[tuple[tuple[float, float], tuple[float, float]]] = []
    for first_id, second_id in node_pairs:
        if first_id not in node_lookup or second_id not in node_lookup:
            continue
        segments.append((node_lookup[first_id], node_lookup[second_id]))
    return segments


def load_overlay_items_from_map(path: Path, *, include_way) -> list[tuple[int, list[tuple[tuple[float, float], tuple[float, float]]], dict]]:
    karura_map = load_map(path)
    nodes = mercator_lookup_from_map(karura_map)
    items = []
    for way_id, way in karura_map.ways.items():
        tags = way.tags
        if not include_way(way_id, tags):
            continue
        segments = segments_from_node_pairs(way.segment_pairs, node_lookup=nodes)
        if segments:
            items.append((way_id, segments, tags))
    return items


def load_overlay_items_from_route_graph(path: Path) -> list[tuple[int, list[tuple[tuple[float, float], tuple[float, float]]], object]]:
    graph = load_route_graph(path)
    nodes = mercator_lookup_from_route_graph(graph)
    items = []
    for contig in graph.contigs.values():
        segments = segments_from_node_pairs(
            zip(contig.node_ids, contig.node_ids[1:]),
            node_lookup=nodes,
        )
        if segments:
            items.append((contig.id, segments, contig))
    return items


def load_overlay_items_from_patchset(path: Path) -> list[tuple[str, list[tuple[tuple[float, float], tuple[float, float]]], dict]]:
    payload = load_required_patchset(path, label="patchset file")
    items = []
    for patch in payload["patches"]:
        if not patch.get("enabled", True):
            continue
        if patch.get("op") != "add_way":
            continue
        node_lookup = {
            int(node["id"]): mercator(float(node["lon"]), float(node["lat"]))
            for node in patch.get("nodes", [])
        }
        node_ids = [int(node_id) for node_id in patch.get("node_ids", [])]
        segments = segments_from_node_pairs(zip(node_ids, node_ids[1:]), node_lookup=node_lookup)
        if segments:
            items.append((str(patch["id"]), segments, patch))
    return items
