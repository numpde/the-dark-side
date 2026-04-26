#!/usr/bin/env python3

"""Rebuild published app assets from canonical inputs."""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

from .export_karura_web_catalog import export_catalog, parse_args as parse_export_args, write_json as write_export_json
from .karura_common import (
    APP_MANIFEST_JSON,
    CATALOG_BUILD_JSON,
    CONTIGS_JSON,
    EDITOR_MANIFEST_JSON,
    ELEVATION_CACHE_DIR,
    ELEVATION_JSON,
    JUNCTION_BINDINGS_JSON,
    JUNCTIONS_JSON,
    MAP_JSON,
    MAP_PATCHES_JSON,
    PATCHED_MAP_JSON,
    WEB_GENERATED_DIR,
    repo_rel,
    sync_web_source_assets,
)
from .rebuild_editor_assets import (
    build_editor_manifest,
    parse_args as parse_editor_args,
    rebuild_contigs,
    rebuild_editor_network,
    rebuild_junction_bindings,
    rebuild_patched_map,
)
from .build_config import catalog_build_config_digest, load_catalog_build_config
from .karura_routing import load_route_graph


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
    parser.add_argument("--output-editor-manifest", type=Path, default=EDITOR_MANIFEST_JSON)
    parser.add_argument("--output-app-manifest", type=Path, default=APP_MANIFEST_JSON)
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
    return parser.parse_args()


def build_app_manifest(args: argparse.Namespace, editor_manifest: dict, export_payloads: dict[str, dict]) -> dict:
    graph = load_route_graph(args.contigs_json)
    build_config_payload = load_catalog_build_config(args.build_config_json)
    build_config_digest = catalog_build_config_digest(build_config_payload)
    catalog_meta = export_payloads["catalog"]["meta"]
    return {
        "meta": {
            "generated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "asset_kind": "app_manifest",
            "graph_asset_id": graph.asset_id,
            "ride_graph_asset_id": graph.asset_id,
            "editor_graph_asset_id": editor_manifest["meta"]["editor_graph_asset_id"],
            "junction_bindings_asset_id": catalog_meta["junction_bindings_asset_id"],
            "catalog_build_path": repo_rel(args.build_config_json),
            "catalog_build_digest": build_config_digest,
            "catalog_asset_graph_id": catalog_meta["graph_asset_id"],
            "elevation_asset_matches_graph": catalog_meta["elevation_asset_matches_graph"],
        }
    }


def main() -> None:
    args = parse_args()
    sync_web_source_assets()
    # Reuse the editor rebuild path first.
    editor_args = parse_editor_args(
        [
            "--map-json", str(args.map_json),
            "--patches-json", str(args.patches_json),
            "--patched-map-json", str(args.patched_map_json),
            "--contigs-json", str(args.contigs_json),
            "--junctions-json", str(args.junctions_json),
            "--junction-bindings-json", str(args.junction_bindings_json),
            "--output-editor-network", str(args.output_editor_network),
            "--output-editor-manifest", str(args.output_editor_manifest),
            "--fill-segment-gaps" if args.fill_segment_gaps else "--no-fill-segment-gaps",
            "--respect-inner-rings" if args.respect_inner_rings else "--no-respect-inner-rings",
        ]
    )
    patched_payload = rebuild_patched_map(editor_args)
    contig_payload = rebuild_contigs(editor_args, patched_payload)
    bindings_payload = rebuild_junction_bindings(editor_args, contig_payload)
    editor_graph_payload, _ = rebuild_editor_network(editor_args)
    editor_manifest = build_editor_manifest(editor_args, patched_payload, contig_payload, bindings_payload, editor_graph_payload)
    write_export_json(args.output_editor_manifest, editor_manifest)

    export_args = parse_export_args(
        [
            "--build-config-json", str(args.build_config_json),
            "--contigs-json", str(args.contigs_json),
            "--junctions-json", str(args.junctions_json),
            "--junction-bindings-json", str(args.junction_bindings_json),
            "--editor-map-json", str(args.patched_map_json),
            "--editor-patches-json", str(args.patches_json),
            "--elevation-json", str(args.elevation_json),
            "--output-catalog", str(args.output_catalog),
            "--output-network", str(args.output_network),
            "--output-editor-network", str(args.output_editor_network),
        ]
    )
    export_payloads = export_catalog(export_args)
    app_manifest = build_app_manifest(args, editor_manifest, export_payloads)
    write_export_json(args.output_app_manifest, app_manifest)
    print(
        json.dumps(
            {
                "catalog": str(args.output_catalog),
                "network": str(args.output_network),
                "editor_network": str(args.output_editor_network),
                "editor_manifest": str(args.output_editor_manifest),
                "app_manifest": str(args.output_app_manifest),
                "route_family_count": len(export_payloads["catalog"]["areas"][0]["route_families"]),
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
