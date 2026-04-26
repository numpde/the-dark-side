#!/usr/bin/env python3

"""Apply local structural patches to the normalized Karura map asset."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any

from .download_karura_map import (
    BoundaryRecord,
    KaruraMap,
    NodeRecord,
    WayRecord,
    fill_kept_segment_gaps,
    haversine_meters,
    keep_segment_by_endpoint,
    load_map,
    point_in_ring,
    write_json,
)
from .asset_contracts import load_required_patchset
from .karura_common import MAP_JSON, MAP_PATCHES_JSON, PATCHED_MAP_JSON, repo_rel


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--map-json", type=Path, default=MAP_JSON)
    parser.add_argument("--patches-json", type=Path, default=MAP_PATCHES_JSON)
    parser.add_argument("--output", type=Path, default=PATCHED_MAP_JSON)
    parser.add_argument(
        "--fill-segment-gaps",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Fill clipped gaps between kept segments on the same way",
    )
    parser.add_argument(
        "--respect-inner-rings",
        action=argparse.BooleanOptionalAction,
        default=False,
        help="Respect inner rings as holes instead of using only the outer shell",
    )
    return parser.parse_args()


def load_patchset(path: Path) -> dict[str, Any]:
    return load_required_patchset(path, label="patchset file")


def patchset_digest(
    *,
    source_asset_id: str | None,
    patchset_id: str,
    applied_patches: list[dict[str, Any]],
    fill_segment_gaps: bool,
    respect_inner_rings: bool,
) -> str:
    payload = {
        "source_asset_id": source_asset_id,
        "patchset_id": patchset_id,
        "patches": applied_patches,
        "fill_segment_gaps": fill_segment_gaps,
        "respect_inner_rings": respect_inner_rings,
    }
    normalized = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha1(normalized).hexdigest()[:12]


def build_inside_karura(
    boundary: BoundaryRecord,
    nodes: dict[int, NodeRecord],
    *,
    respect_inner_rings: bool = False,
):
    component_coords = [
        (
            [[(nodes[node_id].lon, nodes[node_id].lat) for node_id in ring if node_id in nodes] for ring in component.outer_rings],
            [[(nodes[node_id].lon, nodes[node_id].lat) for node_id in ring if node_id in nodes] for ring in component.inner_rings],
        )
        for component in boundary.iter_components()
    ]

    def inside_karura(point: tuple[float, float]) -> bool:
        for outer_ring_coords, inner_ring_coords in component_coords:
            if not any(point_in_ring(point, ring) for ring in outer_ring_coords):
                continue
            if respect_inner_rings and any(point_in_ring(point, ring) for ring in inner_ring_coords):
                continue
            return True
        return False

    return inside_karura


def compute_way_record(
    *,
    way_id: int,
    node_ids: list[int],
    tags: dict[str, str],
    nodes: dict[int, NodeRecord],
    inside_karura,
    boundary_mode: str = "inside_endpoint",
    fill_segment_gaps: bool = True,
) -> WayRecord:
    if len(node_ids) < 2:
        raise ValueError(f"way {way_id} must have at least two node ids")
    if any(node_id not in nodes for node_id in node_ids):
        missing = [node_id for node_id in node_ids if node_id not in nodes]
        raise ValueError(f"way {way_id} references missing nodes: {missing}")

    segment_pairs: list[list[int]] = []
    total_length_m = 0.0
    inside_length_m = 0.0
    lats = [nodes[node_id].lat for node_id in node_ids]
    lons = [nodes[node_id].lon for node_id in node_ids]
    bounds = [round(min(lons), 7), round(min(lats), 7), round(max(lons), 7), round(max(lats), 7)]

    segments = list(zip(node_ids, node_ids[1:]))
    segment_lengths: list[float] = []
    keep_flags: list[bool] = []
    for first_id, second_id in segments:
        first = nodes[first_id]
        second = nodes[second_id]
        segment_length = haversine_meters(first, second)
        total_length_m += segment_length
        if boundary_mode == "inside_midpoint":
            midpoint = ((first.lon + second.lon) / 2, (first.lat + second.lat) / 2)
            is_inside = inside_karura(midpoint)
        elif boundary_mode == "all_segments":
            is_inside = False
        else:
            is_inside = keep_segment_by_endpoint(first, second, inside_karura)
        keep_flags.append(is_inside or boundary_mode == "all_segments")
        segment_lengths.append(segment_length)
        if is_inside:
            inside_length_m += segment_length

    if boundary_mode == "inside_endpoint" and fill_segment_gaps:
        keep_flags = fill_kept_segment_gaps(keep_flags)

    for (first_id, second_id), keep in zip(segments, keep_flags):
        if keep:
            segment_pairs.append([first_id, second_id])

    if not segment_pairs:
        raise ValueError(f"way {way_id} has no segments kept by the Karura boundary rule")

    return WayRecord(
        id=way_id,
        node_ids=node_ids,
        tags=tags,
        segment_pairs=segment_pairs,
        total_length_m=total_length_m,
        inside_length_m=inside_length_m,
        bounds=bounds,
    )


def register_patch_nodes(nodes: dict[int, NodeRecord], patch: dict[str, Any]) -> None:
    for node_payload in patch.get("nodes", []):
        node_id = int(node_payload["id"])
        candidate = NodeRecord(
            id=node_id,
            lat=float(node_payload["lat"]),
            lon=float(node_payload["lon"]),
        )
        existing = nodes.get(node_id)
        if existing and (existing.lat != candidate.lat or existing.lon != candidate.lon):
            raise ValueError(f"node {node_id} already exists with different coordinates")
        nodes[node_id] = candidate


def apply_add_way(
    *,
    patch: dict[str, Any],
    nodes: dict[int, NodeRecord],
    ways: dict[int, WayRecord],
    inside_karura,
    fill_segment_gaps: bool,
) -> None:
    way_id = int(patch["way_id"])
    if way_id in ways:
        raise ValueError(f"cannot add way {way_id}; it already exists")
    register_patch_nodes(nodes, patch)
    node_ids = [int(node_id) for node_id in patch["node_ids"]]
    tags = {str(key): str(value) for key, value in patch.get("tags", {}).items()}
    boundary_mode = str(patch.get("boundary_mode", "inside_endpoint"))
    ways[way_id] = compute_way_record(
        way_id=way_id,
        node_ids=node_ids,
        tags=tags,
        nodes=nodes,
        inside_karura=inside_karura,
        boundary_mode=boundary_mode,
        fill_segment_gaps=fill_segment_gaps,
    )


def apply_remove_way(*, patch: dict[str, Any], ways: dict[int, WayRecord]) -> None:
    way_id = int(patch["way_id"])
    if way_id not in ways:
        raise ValueError(f"cannot remove missing way {way_id}")
    ways.pop(way_id)


def apply_update_way_tags(*, patch: dict[str, Any], ways: dict[int, WayRecord]) -> None:
    way_id = int(patch["way_id"])
    if way_id not in ways:
        raise ValueError(f"cannot retag missing way {way_id}")
    current = ways[way_id]
    tags = dict(current.tags)
    for key in patch.get("remove", []):
        tags.pop(str(key), None)
    for key, value in patch.get("set", {}).items():
        tags[str(key)] = str(value)
    ways[way_id] = WayRecord(
        id=current.id,
        node_ids=list(current.node_ids),
        tags=tags,
        segment_pairs=[list(pair) for pair in current.segment_pairs],
        total_length_m=current.total_length_m,
        inside_length_m=current.inside_length_m,
        bounds=list(current.bounds),
    )


def apply_replace_way_geometry(
    *,
    patch: dict[str, Any],
    nodes: dict[int, NodeRecord],
    ways: dict[int, WayRecord],
    inside_karura,
    fill_segment_gaps: bool,
) -> None:
    way_id = int(patch["way_id"])
    if way_id not in ways:
        raise ValueError(f"cannot replace geometry for missing way {way_id}")
    register_patch_nodes(nodes, patch)
    current = ways[way_id]
    node_ids = [int(node_id) for node_id in patch["node_ids"]]
    boundary_mode = str(patch.get("boundary_mode", "inside_endpoint"))
    ways[way_id] = compute_way_record(
        way_id=way_id,
        node_ids=node_ids,
        tags=dict(current.tags),
        nodes=nodes,
        inside_karura=inside_karura,
        boundary_mode=boundary_mode,
        fill_segment_gaps=fill_segment_gaps,
    )


def apply_patchset(
    karura_map: KaruraMap,
    patchset: dict[str, Any],
    source_map: str,
    patchset_path: str,
    *,
    fill_segment_gaps: bool = True,
    respect_inner_rings: bool = False,
) -> KaruraMap:
    patch_ids: set[str] = set()
    nodes = {
        node_id: NodeRecord(id=node.id, lat=node.lat, lon=node.lon)
        for node_id, node in karura_map.nodes.items()
    }
    ways = {
        way_id: WayRecord(
            id=way.id,
            node_ids=list(way.node_ids),
            tags=dict(way.tags),
            segment_pairs=[list(pair) for pair in way.segment_pairs],
            total_length_m=way.total_length_m,
            inside_length_m=way.inside_length_m,
            bounds=list(way.bounds),
        )
        for way_id, way in karura_map.ways.items()
    }
    inside_karura = build_inside_karura(
        karura_map.boundary,
        nodes,
        respect_inner_rings=respect_inner_rings,
    )
    applied_patch_ids: list[str] = []
    applied_patches: list[dict[str, Any]] = []

    for patch in patchset.get("patches", []):
        patch_id = str(patch["id"])
        if patch_id in patch_ids:
            raise ValueError(f"duplicate patch id: {patch_id}")
        patch_ids.add(patch_id)
        if not patch.get("enabled", True):
            continue

        operation = patch["op"]
        if operation == "add_way":
            apply_add_way(
                patch=patch,
                nodes=nodes,
                ways=ways,
                inside_karura=inside_karura,
                fill_segment_gaps=fill_segment_gaps,
            )
        elif operation == "remove_way":
            apply_remove_way(patch=patch, ways=ways)
        elif operation == "update_way_tags":
            apply_update_way_tags(patch=patch, ways=ways)
        elif operation == "replace_way_geometry":
            apply_replace_way_geometry(
                patch=patch,
                nodes=nodes,
                ways=ways,
                inside_karura=inside_karura,
                fill_segment_gaps=fill_segment_gaps,
            )
        elif operation == "update_contig_tags":
            continue
        else:
            raise ValueError(f"unsupported patch op: {operation}")
        applied_patch_ids.append(patch_id)
        applied_patches.append(patch)

    patchset_meta = patchset.get("meta", {})
    patchset_id = str(patchset_meta.get("patchset_id", "karura-map-patches-v1"))
    patch_digest = patchset_digest(
        source_asset_id=karura_map.meta.get("asset_id"),
        patchset_id=patchset_id,
        applied_patches=applied_patches,
        fill_segment_gaps=fill_segment_gaps,
        respect_inner_rings=respect_inner_rings,
    )
    meta = {
        "asset_id": f"karura-map-patched-from-{karura_map.meta.get('asset_id', 'unknown')}-{patchset_id}-{patch_digest}",
        "asset_kind": "patched_map",
        "source_map": source_map,
        "source_asset_id": karura_map.meta.get("asset_id"),
        "patches_path": patchset_path,
        "patchset_id": patchset_id,
        "patchset_digest": patch_digest,
        "patchset_asset_kind": patchset_meta.get("asset_kind", "map_patchset"),
        "applied_patch_ids": applied_patch_ids,
        "fill_segment_gaps": fill_segment_gaps,
        "respect_inner_rings": respect_inner_rings,
        "node_count": len(nodes),
        "way_count": len(ways),
    }

    return KaruraMap(
        meta=meta,
        boundary=karura_map.boundary,
        nodes=nodes,
        ways={way_id: ways[way_id] for way_id in sorted(ways)},
    )


def main() -> None:
    args = parse_args()
    karura_map = load_map(args.map_json)
    patchset = load_patchset(args.patches_json)
    patched = apply_patchset(
        karura_map,
        patchset=patchset,
        source_map=repo_rel(args.map_json),
        patchset_path=repo_rel(args.patches_json),
        fill_segment_gaps=args.fill_segment_gaps,
        respect_inner_rings=args.respect_inner_rings,
    )
    write_json(args.output, patched.to_dict())
    print(
        json.dumps(
            {
                "output": str(args.output),
                "source_asset_id": patched.meta["source_asset_id"],
                "patchset_id": patched.meta["patchset_id"],
                "patchset_digest": patched.meta["patchset_digest"],
                "applied_patch_count": len(patched.meta["applied_patch_ids"]),
                "fill_segment_gaps": patched.meta["fill_segment_gaps"],
                "respect_inner_rings": patched.meta["respect_inner_rings"],
                "node_count": patched.meta["node_count"],
                "way_count": patched.meta["way_count"],
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
