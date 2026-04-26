#!/usr/bin/env python3

"""Annotate the Karura contig graph with per-node elevation values."""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

from .elevation import OpenMeteoElevationClient, OpenTopoDataElevationClient
from .karura_common import CONTIGS_JSON, ELEVATION_CACHE_DIR, ELEVATION_JSON
from .karura_routing import load_route_graph


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--contigs-json", type=Path, default=CONTIGS_JSON)
    parser.add_argument("--provider", choices=("open-topo-data", "open-meteo"), default="open-topo-data")
    parser.add_argument(
        "--cache-json",
        type=Path,
        default=ELEVATION_CACHE_DIR / "graph_node_elevations.json",
    )
    parser.add_argument("--output", type=Path, default=ELEVATION_JSON)
    return parser.parse_args(argv)


def provider_for(args: argparse.Namespace):
    if args.provider == "open-topo-data":
        return OpenTopoDataElevationClient(cache_path=args.cache_json)
    if args.provider == "open-meteo":
        return OpenMeteoElevationClient(cache_path=args.cache_json)
    raise KeyError(args.provider)


def write_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2) + "\n")


def main(argv: list[str] | None = None) -> None:
    args = parse_args(argv)
    graph = load_route_graph(args.contigs_json)
    provider = provider_for(args)

    sorted_nodes = [graph.nodes[node_id] for node_id in sorted(graph.nodes)]
    node_points = [[node.lon, node.lat] for node in sorted_nodes]
    node_elevations = provider.get_elevations(node_points)

    payload = {
        "meta": {
            "generated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "asset_id": f"karura-elevation-{args.provider}-{graph.asset_id}",
            "asset_kind": "graph_elevation",
            "provider": args.provider,
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
    write_json(args.output, payload)
    print(
        json.dumps(
            {
                "output": str(args.output),
                "provider": args.provider,
                "node_count": len(sorted_nodes),
                "graph_asset_id": graph.asset_id,
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
