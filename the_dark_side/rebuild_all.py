#!/usr/bin/env python3

"""Rebuild editor and app assets from canonical inputs."""

from __future__ import annotations

import argparse
from pathlib import Path

from .build_karura_elevation import main as rebuild_elevation_main
from .karura_common import (
    CATALOG_BUILD_JSON,
    CONTIGS_JSON,
    ELEVATION_CACHE_DIR,
    ELEVATION_JSON,
    JUNCTION_BINDINGS_JSON,
    JUNCTIONS_JSON,
    MAP_JSON,
    MAP_PATCHES_JSON,
    PATCHED_MAP_JSON,
    WEB_GENERATED_DIR,
)
from .rebuild_app_assets import main as rebuild_app_main


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--map-json", type=Path, default=MAP_JSON)
    parser.add_argument("--patches-json", type=Path, default=MAP_PATCHES_JSON)
    parser.add_argument("--patched-map-json", type=Path, default=PATCHED_MAP_JSON)
    parser.add_argument("--contigs-json", type=Path, default=CONTIGS_JSON)
    parser.add_argument("--junctions-json", type=Path, default=JUNCTIONS_JSON)
    parser.add_argument("--junction-bindings-json", type=Path, default=JUNCTION_BINDINGS_JSON)
    parser.add_argument("--build-config-json", type=Path, default=CATALOG_BUILD_JSON)
    parser.add_argument("--elevation-cache-json", type=Path, default=ELEVATION_CACHE_DIR / "graph_node_elevations.json")
    parser.add_argument("--elevation-json", type=Path, default=ELEVATION_JSON)
    parser.add_argument("--output-catalog", type=Path, default=WEB_GENERATED_DIR / "catalog.json")
    parser.add_argument("--output-network", type=Path, default=WEB_GENERATED_DIR / "karura-network.geojson")
    parser.add_argument("--output-editor-network", type=Path, default=WEB_GENERATED_DIR / "karura-editor-network.geojson")
    parser.add_argument(
        "--fill-segment-gaps",
        action=argparse.BooleanOptionalAction,
        default=True,
    )
    parser.add_argument(
        "--respect-inner-rings",
        action=argparse.BooleanOptionalAction,
        default=False,
    )
    parser.add_argument("--with-elevation", action="store_true")
    parser.add_argument("--elevation-provider", choices=("open-topo-data", "open-meteo"), default="open-topo-data")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    import sys

    argv = [
        "rebuild_app_assets",
        "--map-json", str(args.map_json),
        "--patches-json", str(args.patches_json),
        "--patched-map-json", str(args.patched_map_json),
        "--contigs-json", str(args.contigs_json),
        "--junctions-json", str(args.junctions_json),
        "--junction-bindings-json", str(args.junction_bindings_json),
        "--build-config-json", str(args.build_config_json),
        "--elevation-json", str(args.elevation_json),
        "--output-catalog", str(args.output_catalog),
        "--output-network", str(args.output_network),
        "--output-editor-network", str(args.output_editor_network),
        "--fill-segment-gaps" if args.fill_segment_gaps else "--no-fill-segment-gaps",
        "--respect-inner-rings" if args.respect_inner_rings else "--no-respect-inner-rings",
    ]
    old_argv = sys.argv
    try:
        sys.argv = argv
        rebuild_app_main()
    finally:
        sys.argv = old_argv

    if args.with_elevation:
        elevation_argv = [
            "build_karura_elevation",
            "--contigs-json", str(args.contigs_json),
            "--provider", str(args.elevation_provider),
            "--cache-json", str(args.elevation_cache_json),
            "--output", str(args.elevation_json),
        ]
        old_argv = sys.argv
        try:
            sys.argv = elevation_argv
            rebuild_elevation_main()
        finally:
            sys.argv = old_argv

        old_argv = sys.argv
        try:
            sys.argv = argv
            rebuild_app_main()
        finally:
            sys.argv = old_argv


if __name__ == "__main__":
    main()
