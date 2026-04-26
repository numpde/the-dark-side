"""Shared web asset helpers for graph/elevation/editor payloads."""

from __future__ import annotations

import json
from pathlib import Path

from .build_karura_contigs import build_contigs
from .download_karura_map import load_map
from .karura_common import (
    include_editor_way,
    load_required_patchset,
    repo_rel,
    require_json_object,
)


def write_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2) + "\n")


def rounded_contig_elevations(node_ids: list[int] | tuple[int, ...], node_elevations: dict[int, float] | None) -> list[float] | None:
    if not node_elevations:
        return None
    elevations = []
    missing_node_ids = []
    for node_id in node_ids:
        if int(node_id) not in node_elevations:
            missing_node_ids.append(int(node_id))
            continue
        elevations.append(round(float(node_elevations[int(node_id)]), 1))
    if missing_node_ids:
        raise ValueError(
            "Missing elevation values for node ids: "
            + ", ".join(str(node_id) for node_id in missing_node_ids)
        )
    return elevations


def network_geojson(graph, *, meta: dict | None = None, node_elevations: dict[int, float] | None = None) -> dict:
    features = []
    if isinstance(graph, dict):
        nodes = {
            int(node_id): {
                "lat": float(node_payload["lat"]),
                "lon": float(node_payload["lon"]),
            }
            for node_id, node_payload in graph["nodes"].items()
        }
        contigs = graph["contigs"]
        for contig in contigs:
            coordinates = [
                [round(nodes[int(node_id)]["lon"], 6), round(nodes[int(node_id)]["lat"], 6)]
                for node_id in contig["node_ids"]
            ]
            elevations = rounded_contig_elevations(contig["node_ids"], node_elevations)
            features.append(
                {
                    "type": "Feature",
                    "properties": {
                        "contig_id": contig["id"],
                        "length_m": round(float(contig["length_m"]), 3),
                        "segment_count": int(contig["segment_count"]),
                        "way_names": list(contig["way_names"]),
                        "way_ids": list(contig["way_ids"]),
                        "endpoint_node_ids": list(contig["endpoint_node_ids"]),
                        "node_ids": list(contig["node_ids"]),
                        "tags": dict(contig["tags"]),
                        **({"elevations_m": elevations} if elevations is not None else {}),
                    },
                    "geometry": {
                        "type": "LineString",
                        "coordinates": coordinates,
                    },
                }
            )
        return {"type": "FeatureCollection", "meta": meta or {}, "features": features}

    for contig in graph.contigs.values():
        coordinates = [
            [round(graph.nodes[node_id].lon, 6), round(graph.nodes[node_id].lat, 6)]
            for node_id in contig.node_ids
        ]
        elevations = rounded_contig_elevations(contig.node_ids, node_elevations)
        features.append(
            {
                "type": "Feature",
                "properties": {
                    "contig_id": contig.id,
                    "length_m": round(contig.length_m, 3),
                    "segment_count": contig.segment_count,
                    "way_names": list(contig.way_names),
                    "way_ids": list(contig.way_ids),
                    "endpoint_node_ids": list(contig.endpoint_node_ids),
                    "node_ids": list(contig.node_ids),
                    "tags": dict(contig.tags),
                    **({"elevations_m": elevations} if elevations is not None else {}),
                },
                "geometry": {
                    "type": "LineString",
                    "coordinates": coordinates,
                },
            }
        )
    return {"type": "FeatureCollection", "meta": meta or {}, "features": features}


def load_patch_snapshot(path: Path) -> dict:
    return load_required_patchset(path, label="patchset file")


def build_editor_graph_payload_from_map(*, editor_map_payload: dict, editor_map_json: Path, editor_patches_json: Path) -> tuple[dict, dict]:
    patch_snapshot = load_patch_snapshot(editor_patches_json)
    editor_graph_payload = build_contigs(
        editor_map_payload,
        source_map=repo_rel(editor_map_json),
        patchset=patch_snapshot,
        patchset_path=repo_rel(editor_patches_json),
        include_way=include_editor_way,
        graph_mode="editor",
    )
    editor_network = network_geojson(
        editor_graph_payload,
        meta={
            "graph_asset_id": editor_graph_payload["meta"]["asset_id"],
            "graph_mode": editor_graph_payload["meta"]["graph_mode"],
            "source_map_asset_id": editor_graph_payload["meta"]["source_asset_id"],
            "patchset_id": editor_graph_payload["meta"].get("patchset_id"),
        },
    )
    return editor_graph_payload, editor_network


def build_editor_graph_payload(*, editor_map_json: Path, editor_patches_json: Path) -> tuple[dict, dict]:
    editor_map = load_map(editor_map_json)
    return build_editor_graph_payload_from_map(
        editor_map_payload=editor_map.to_dict(),
        editor_map_json=editor_map_json,
        editor_patches_json=editor_patches_json,
    )


def load_elevation_asset(path: Path | None, *, expected_graph_asset_id: str | None = None) -> tuple[dict[int, float], bool]:
    if path is None or not path.exists():
        return {}, False
    payload = require_json_object(json.loads(path.read_text()), label="elevation asset")
    meta = require_json_object(payload.get("meta"), label="elevation asset.meta")
    payload_graph_asset_id = meta.get("graph_asset_id")
    if expected_graph_asset_id is not None and payload_graph_asset_id != expected_graph_asset_id:
        return {}, False
    nodes = require_json_object(payload.get("nodes"), label="elevation asset.nodes")
    node_elevations: dict[int, float] = {}
    for node_id, node_payload in nodes.items():
        item = require_json_object(node_payload, label=f"elevation asset.nodes[{node_id}]")
        elevation = item.get("elevation_m")
        if elevation is None:
            continue
        node_elevations[int(node_id)] = float(elevation)
    return node_elevations, True
