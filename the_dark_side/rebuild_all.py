#!/usr/bin/env python3

"""Rebuild editor and app assets from canonical inputs."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from .asset_pipeline_cli import add_app_asset_args, editor_rebuild_argv_from_namespace, app_rebuild_argv_from_namespace
from .build_karura_elevation import main as rebuild_elevation_main
from .karura_common import (
    ELEVATION_CACHE_DIR,
)
from .rebuild_app_assets import parse_args as parse_app_args, rebuild_app_assets
from .rebuild_editor_assets import parse_args as parse_editor_args, rebuild_editor_assets


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    add_app_asset_args(parser)
    parser.add_argument("--elevation-cache-json", type=Path, default=ELEVATION_CACHE_DIR / "graph_node_elevations.json")
    parser.add_argument("--with-elevation", action="store_true")
    parser.add_argument("--elevation-provider", choices=("open-topo-data", "open-meteo"), default="open-topo-data")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> None:
    args = parse_args(argv)
    editor_bundle = None
    if args.with_elevation:
        editor_bundle = rebuild_editor_assets(
            parse_editor_args(
                editor_rebuild_argv_from_namespace(args, include_output_editor_manifest=False)
            )
        )
        elevation_argv = [
            "--contigs-json", str(args.contigs_json),
            "--provider", str(args.elevation_provider),
            "--cache-json", str(args.elevation_cache_json),
            "--output", str(args.elevation_json),
        ]
        rebuild_elevation_main(elevation_argv)
    app_args = parse_app_args(app_rebuild_argv_from_namespace(args))
    app_bundle = rebuild_app_assets(app_args, editor_bundle=editor_bundle)
    print(
        json.dumps(
            {
                "network": str(app_args.output_network),
                "editor_network": str(app_args.output_editor_network),
                "editor_manifest": str(app_args.output_editor_manifest),
                "app_manifest": str(app_args.output_app_manifest),
                "network_feature_count": len(app_bundle["route_network"]["features"]),
                "area_network_feature_counts": {
                    area_id: len(network["features"])
                    for area_id, network in app_bundle["area_networks"].items()
                },
                "elevation_refreshed": args.with_elevation,
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
