#!/usr/bin/env python3

"""Collapse the Karura ride graph into contigs between crossings."""

from __future__ import annotations

import argparse
import hashlib
import json
from collections import Counter, defaultdict
from math import asin, cos, radians, sin, sqrt
from pathlib import Path
from typing import Any

from .karura_common import CONTIGS_JSON as DEFAULT_OUT_JSON, MAP_PATCHES_JSON, include_ride_way, repo_rel, resolve_map_json


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--map-json", type=Path)
    parser.add_argument("--patches-json", type=Path, default=MAP_PATCHES_JSON)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUT_JSON)
    return parser.parse_args()


def haversine_meters(a: dict[str, float], b: dict[str, float]) -> float:
    dlat = radians(b["lat"] - a["lat"])
    dlon = radians(b["lon"] - a["lon"])
    lat1 = radians(a["lat"])
    lat2 = radians(b["lat"])
    value = sin(dlat / 2) ** 2 + cos(lat1) * cos(lat2) * sin(dlon / 2) ** 2
    return 2 * 6371000.0 * asin(sqrt(value))


def edge_key(a: int, b: int) -> tuple[int, int]:
    return (a, b) if a < b else (b, a)


def edge_bounds(nodes: dict[int, dict[str, float]], node_ids: list[int]) -> list[float]:
    lats = [nodes[node_id]["lat"] for node_id in node_ids]
    lons = [nodes[node_id]["lon"] for node_id in node_ids]
    return [round(min(lons), 7), round(min(lats), 7), round(max(lons), 7), round(max(lats), 7)]


def build_edge_graph(
    payload: dict,
    *,
    include_way=include_ride_way,
) -> tuple[dict[int, dict[str, float]], dict[tuple[int, int], dict], dict[int, set[int]]]:
    nodes = {
        int(node_id): {"id": int(node["id"]), "lat": float(node["lat"]), "lon": float(node["lon"])}
        for node_id, node in payload["nodes"].items()
    }
    edges: dict[tuple[int, int], dict] = {}
    adjacency: dict[int, set[int]] = defaultdict(set)

    for way_id_text, way in payload["ways"].items():
        way_id = int(way_id_text)
        tags = dict(way["tags"])
        if not include_way(way_id, tags):
            continue

        for first_id, second_id in way["segment_pairs"]:
            if first_id not in nodes or second_id not in nodes:
                continue
            key = edge_key(first_id, second_id)
            if key not in edges:
                edges[key] = {
                    "node_ids": [key[0], key[1]],
                    "length_m": haversine_meters(nodes[key[0]], nodes[key[1]]),
                    "way_ids": set(),
                    "highway_types": Counter(),
                    "way_names": set(),
                }
            edge = edges[key]
            edge["way_ids"].add(way_id)
            if tags.get("highway"):
                edge["highway_types"][tags["highway"]] += 1
            if tags.get("name"):
                edge["way_names"].add(tags["name"])
            adjacency[first_id].add(second_id)
            adjacency[second_id].add(first_id)

    return nodes, edges, adjacency


def contig_record(
    *,
    contig_id: int,
    path_node_ids: list[int],
    segment_pairs: list[list[int]],
    nodes: dict[int, dict[str, float]],
    edge_graph: dict[tuple[int, int], dict],
    is_cycle: bool,
) -> dict:
    length_m = 0.0
    way_ids: set[int] = set()
    highway_types: Counter[str] = Counter()
    way_names: set[str] = set()

    for first_id, second_id in segment_pairs:
        edge = edge_graph[edge_key(first_id, second_id)]
        length_m += edge["length_m"]
        way_ids.update(edge["way_ids"])
        highway_types.update(edge["highway_types"])
        way_names.update(edge["way_names"])

    endpoint_node_ids = [path_node_ids[0], path_node_ids[0] if is_cycle else path_node_ids[-1]]
    return {
        "id": contig_id,
        "endpoint_node_ids": endpoint_node_ids,
        "node_ids": path_node_ids,
        "segment_pairs": segment_pairs,
        "segment_count": len(segment_pairs),
        "length_m": round(length_m, 3),
        "is_cycle": is_cycle,
        "way_ids": sorted(way_ids),
        "way_names": sorted(way_names),
        "highway_types": dict(sorted(highway_types.items())),
        "tags": {},
        "bounds": edge_bounds(nodes, path_node_ids),
    }


def load_patchset(path: Path) -> dict:
    if not path.exists():
        return {
            "meta": {
                "asset_kind": "map_patchset",
                "patchset_id": "karura-map-patches-v1",
            },
            "patches": [],
        }
    return json.loads(path.read_text())


def apply_contig_policy_patchset(contig_graph: dict, patchset: dict[str, Any]) -> tuple[list[str], str]:
    by_id = {int(contig["id"]): contig for contig in contig_graph["contigs"]}
    by_signature = {}
    for contig in contig_graph["contigs"]:
        signature = tuple(int(node_id) for node_id in contig["node_ids"])
        by_signature[signature] = contig
        by_signature[tuple(reversed(signature))] = contig
    applied_patch_ids: list[str] = []

    for patch in patchset.get("patches", []):
        if not patch.get("enabled", True):
            continue
        if patch.get("op") != "update_contig_tags":
            continue

        contig = None
        node_ids = patch.get("node_ids")
        if node_ids:
            contig = by_signature.get(tuple(int(node_id) for node_id in node_ids))
            if contig is None:
                raise ValueError(
                    f"cannot retag contig {patch['contig_id']}; node_ids signature no longer matches current graph"
                )
        else:
            contig = by_id.get(int(patch["contig_id"]))
        if contig is None:
            raise ValueError(f"cannot retag missing contig {patch['contig_id']}")

        tags = dict(contig.get("tags", {}))
        for key in patch.get("remove", []):
            tags.pop(str(key), None)
        for key, value in patch.get("set", {}).items():
            tags[str(key)] = str(value)
        contig["tags"] = tags
        applied_patch_ids.append(str(patch["id"]))

    patchset_id = str(patchset.get("meta", {}).get("patchset_id", "karura-map-patches-v1"))
    return applied_patch_ids, patchset_id


def contig_patch_digest(patchset_id: str, patchset: dict[str, Any]) -> str:
    applied = [
        patch
        for patch in patchset.get("patches", [])
        if patch.get("enabled", True) and patch.get("op") == "update_contig_tags"
    ]
    canonical = json.dumps(
        {
            "patchset_id": patchset_id,
            "patches": applied,
        },
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha1(canonical.encode("utf-8")).hexdigest()[:12]


def walk_contig(
    *,
    start: int,
    neighbor: int,
    crossings: set[int],
    adjacency: dict[int, set[int]],
    visited: set[tuple[int, int]],
) -> tuple[list[int], list[list[int]]]:
    path_node_ids = [start]
    segment_pairs: list[list[int]] = []
    previous = start
    current = neighbor

    while True:
        key = edge_key(previous, current)
        if key in visited:
            break
        visited.add(key)
        segment_pairs.append([previous, current])
        path_node_ids.append(current)

        if current in crossings:
            break

        next_nodes = [node_id for node_id in adjacency[current] if node_id != previous]
        if not next_nodes:
            break
        previous, current = current, next_nodes[0]

    return path_node_ids, segment_pairs


def walk_cycle(
    *,
    start: int,
    neighbor: int,
    adjacency: dict[int, set[int]],
    visited: set[tuple[int, int]],
) -> tuple[list[int], list[list[int]]]:
    path_node_ids = [start]
    segment_pairs: list[list[int]] = []
    previous = start
    current = neighbor

    while True:
        key = edge_key(previous, current)
        if key in visited:
            break
        visited.add(key)
        segment_pairs.append([previous, current])
        path_node_ids.append(current)
        next_nodes = [node_id for node_id in adjacency[current] if node_id != previous]
        if not next_nodes:
            break
        previous, current = current, next_nodes[0]
        if current == start:
            final_key = edge_key(previous, current)
            if final_key not in visited:
                visited.add(final_key)
                segment_pairs.append([previous, current])
                path_node_ids.append(current)
            break

    return path_node_ids, segment_pairs


def build_contigs(
    payload: dict,
    source_map: str,
    *,
    patchset: dict[str, Any] | None = None,
    patchset_path: str | None = None,
    include_way=include_ride_way,
    graph_mode: str = "ride",
) -> dict:
    nodes, edge_graph, adjacency = build_edge_graph(payload, include_way=include_way)
    crossings = {node_id for node_id, neighbors in adjacency.items() if len(neighbors) != 2}
    visited: set[tuple[int, int]] = set()
    contigs: list[dict] = []
    contig_id = 1
    source_meta = payload.get("meta", {})
    source_asset_id = source_meta.get("asset_id", "unknown-map-asset")

    for crossing in sorted(crossings):
        for neighbor in sorted(adjacency[crossing]):
            if edge_key(crossing, neighbor) in visited:
                continue
            path_node_ids, segment_pairs = walk_contig(
                start=crossing,
                neighbor=neighbor,
                crossings=crossings,
                adjacency=adjacency,
                visited=visited,
            )
            contigs.append(
                contig_record(
                    contig_id=contig_id,
                    path_node_ids=path_node_ids,
                    segment_pairs=segment_pairs,
                    nodes=nodes,
                    edge_graph=edge_graph,
                    is_cycle=False,
                )
            )
            contig_id += 1

    for key, edge in sorted(edge_graph.items()):
        if key in visited:
            continue
        start, neighbor = edge["node_ids"]
        path_node_ids, segment_pairs = walk_cycle(
            start=start,
            neighbor=neighbor,
            adjacency=adjacency,
            visited=visited,
        )
        contigs.append(
            contig_record(
                contig_id=contig_id,
                path_node_ids=path_node_ids,
                segment_pairs=segment_pairs,
                nodes=nodes,
                edge_graph=edge_graph,
                is_cycle=True,
            )
        )
        contig_id += 1

    crossing_nodes = {
        str(node_id): {
            "id": node_id,
            "lat": nodes[node_id]["lat"],
            "lon": nodes[node_id]["lon"],
            "degree": len(adjacency[node_id]),
        }
        for node_id in sorted(crossings)
    }

    contig_graph = {
        "meta": {
            "asset_id": f"karura-contigs-{graph_mode}-from-{source_asset_id}",
            "asset_kind": "contig_graph",
            "source_map": source_map,
            "source_asset_id": source_asset_id,
            "contig_count": len(contigs),
            "crossing_count": len(crossing_nodes),
            "edge_count": len(edge_graph),
            "node_count": len(nodes),
            "graph_mode": graph_mode,
        },
        "nodes": {str(node_id): node for node_id, node in sorted(nodes.items())},
        "crossings": crossing_nodes,
        "contigs": contigs,
    }

    if patchset is not None:
        applied_patch_ids, patchset_id = apply_contig_policy_patchset(contig_graph, patchset)
        contig_graph["meta"]["patchset_id"] = patchset_id
        contig_graph["meta"]["patches_path"] = patchset_path
        contig_graph["meta"]["applied_contig_patch_ids"] = applied_patch_ids
        patch_digest = contig_patch_digest(patchset_id, patchset)
        contig_graph["meta"]["contig_patchset_digest"] = patch_digest

    return contig_graph


def main() -> None:
    args = parse_args()
    map_json = args.map_json or resolve_map_json()
    payload = json.loads(map_json.read_text())
    patchset = load_patchset(args.patches_json)
    contig_graph = build_contigs(
        payload,
        source_map=repo_rel(map_json),
        patchset=patchset,
        patchset_path=repo_rel(args.patches_json),
    )
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(contig_graph, indent=2, sort_keys=True) + "\n")
    print(
        json.dumps(
            {
                "output": str(args.output),
                "contig_count": contig_graph["meta"]["contig_count"],
                "crossing_count": contig_graph["meta"]["crossing_count"],
                "edge_count": contig_graph["meta"]["edge_count"],
                "applied_contig_patch_count": len(contig_graph["meta"].get("applied_contig_patch_ids", [])),
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
