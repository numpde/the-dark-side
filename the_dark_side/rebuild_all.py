#!/usr/bin/env python3

"""Rebuild deterministic derived assets from canonical inputs."""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

from .apply_karura_patches import apply_patchset, load_patchset
from .build_karura_contigs import build_contigs
from .build_karura_elevation import provider_for
from .download_karura_map import load_map, write_json
from .export_karura_web_catalog import export_catalog, parse_args as parse_export_args
from .karura_common import (
    CATALOG_BUILD_JSON,
    CONTIGS_JSON,
    ELEVATION_CACHE_DIR,
    ELEVATION_JSON,
    MAP_JSON,
    MAP_PATCHES_JSON,
    PATCHED_MAP_JSON,
    WEB_GENERATED_DIR,
    repo_rel,
    sync_web_source_assets,
)
from .karura_common import include_ride_way
from .karura_routing import load_route_graph


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--map-json", type=Path, default=MAP_JSON)
    parser.add_argument("--patches-json", type=Path, default=MAP_PATCHES_JSON)
    parser.add_argument("--patched-map-json", type=Path, default=PATCHED_MAP_JSON)
    parser.add_argument("--contigs-json", type=Path, default=CONTIGS_JSON)
    parser.add_argument("--build-config-json", type=Path, default=CATALOG_BUILD_JSON)
    parser.add_argument("--with-elevation", action="store_true")
    parser.add_argument("--elevation-provider", choices=("open-topo-data", "open-meteo"), default="open-topo-data")
    parser.add_argument("--elevation-cache-json", type=Path, default=ELEVATION_CACHE_DIR / "graph_node_elevations.json")
    parser.add_argument("--elevation-json", type=Path, default=ELEVATION_JSON)
    parser.add_argument(
        "--fill-segment-gaps",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Fill clipped gaps between kept segments on the same way",
    )
    return parser.parse_args()


def rebuild_patched_map(args: argparse.Namespace) -> dict:
    karura_map = load_map(args.map_json)
    patchset = load_patchset(args.patches_json)
    patched = apply_patchset(
        karura_map,
        patchset=patchset,
        source_map=repo_rel(args.map_json),
        patchset_path=repo_rel(args.patches_json),
        fill_segment_gaps=args.fill_segment_gaps,
    )
    write_json(args.patched_map_json, patched.to_dict())
    return patched.to_dict()


def rebuild_contigs(args: argparse.Namespace, patched_payload: dict) -> dict:
    patchset = load_patchset(args.patches_json)
    contig_graph = build_contigs(
        patched_payload,
        source_map=repo_rel(args.patched_map_json),
        patchset=patchset,
        patchset_path=repo_rel(args.patches_json),
        include_way=include_ride_way,
        graph_mode="ride",
    )
    args.contigs_json.write_text(json.dumps(contig_graph, indent=2, sort_keys=True) + "\n")
    return contig_graph


def rebuild_elevation(args: argparse.Namespace) -> dict | None:
    if not args.with_elevation:
        return None
    graph = load_route_graph(args.contigs_json)
    provider = provider_for(
        argparse.Namespace(
            provider=args.elevation_provider,
            cache_json=args.elevation_cache_json,
        )
    )
    sorted_nodes = [graph.nodes[node_id] for node_id in sorted(graph.nodes)]
    node_points = [[node.lon, node.lat] for node in sorted_nodes]
    node_elevations = provider.get_elevations(node_points)
    payload = {
        "meta": {
            "generated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "asset_id": f"karura-elevation-{args.elevation_provider}-{graph.asset_id}",
            "asset_kind": "graph_elevation",
            "provider": args.elevation_provider,
            "graph_asset_id": graph.asset_id,
            "node_count": len(sorted_nodes),
        },
        "nodes": {
            str(node.id): {
                "lat": round(node.lat, 6),
                "lon": round(node.lon, 6),
                "elevation_m": None if elevation is None else round(float(elevation), 1),
            }
            for node, elevation in zip(sorted_nodes, node_elevations)
        },
    }
    write_json(args.elevation_json, payload)
    return payload


def rebuild_catalog(args: argparse.Namespace) -> dict[str, dict]:
    export_args = parse_export_args(
        [
            "--build-config-json",
            str(args.build_config_json),
            "--contigs-json",
            str(args.contigs_json),
            "--editor-map-json",
            str(args.map_json),
            "--editor-patches-json",
            str(args.patches_json),
            "--elevation-json",
            str(args.elevation_json),
        ]
    )
    return export_catalog(export_args)


def main() -> None:
    args = parse_args()
    sync_web_source_assets()
    patched_payload = rebuild_patched_map(args)
    contig_payload = rebuild_contigs(args, patched_payload)
    elevation_payload = rebuild_elevation(args)
    export_payloads = rebuild_catalog(args)
    print(
        json.dumps(
            {
                "patched_map": str(args.patched_map_json),
                "contigs": str(args.contigs_json),
                "elevation": None if elevation_payload is None else str(args.elevation_json),
                "catalog": str(WEB_GENERATED_DIR / "catalog.json"),
                "contig_count": contig_payload["meta"]["contig_count"],
                "route_family_count": len(export_payloads["catalog"]["areas"][0]["route_families"]),
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
