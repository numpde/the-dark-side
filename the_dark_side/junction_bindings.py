"""Derived graph bindings for curated junctions."""

from __future__ import annotations

from math import asin, cos, radians, sin, sqrt
from pathlib import Path

from .karura_common import (
    JUNCTIONS_JSON,
    repo_rel,
    utc_now_z,
)


R = 6371000.0


def haversine_meters(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    dlat = radians(lat2 - lat1)
    dlon = radians(lon2 - lon1)
    lat1_r = radians(lat1)
    lat2_r = radians(lat2)
    value = sin(dlat / 2) ** 2 + cos(lat1_r) * cos(lat2_r) * sin(dlon / 2) ** 2
    return 2 * R * asin(sqrt(value))


def nearest_graph_node(graph, *, lat: float, lon: float) -> tuple[int, float]:
    best_node_id = -1
    best_distance = float("inf")
    for node_id, node in graph.nodes.items():
        distance = haversine_meters(lat, lon, node.lat, node.lon)
        if distance < best_distance:
            best_node_id = node_id
            best_distance = distance
    if best_node_id < 0:
        raise ValueError("graph has no nodes")
    return best_node_id, best_distance


def build_junction_bindings(
    junction_catalog: dict[str, Any],
    graph,
    *,
    junctions_path: Path = JUNCTIONS_JSON,
    graph_path: Path | None = None,
) -> dict[str, Any]:
    bindings: list[dict[str, Any]] = []
    for junction in junction_catalog["junctions"]:
        location = junction["location"]
        graph_node_id, distance_m = nearest_graph_node(
            graph,
            lat=float(location["lat"]),
            lon=float(location["lon"]),
        )
        incident_contig_ids = sorted(contig_id for contig_id, _ in graph.adjacency.get(graph_node_id, []))
        bindings.append(
            {
                "junction_id": junction["id"],
                "graph_node_id": graph_node_id,
                "incident_contig_ids": incident_contig_ids,
                "distance_m": round(distance_m, 3),
            }
        )

    return {
        "meta": {
            "generated_at": utc_now_z(),
            "asset_id": f"karura-junction-bindings-for-{graph.asset_id}",
            "asset_kind": "junction_bindings",
            "graph_asset_id": graph.asset_id,
            "junction_catalog_asset_id": junction_catalog["meta"]["asset_id"],
            "junctions_path": repo_rel(junctions_path),
            "graph_path": None if graph_path is None else repo_rel(graph_path),
        },
        "bindings": bindings,
    }
