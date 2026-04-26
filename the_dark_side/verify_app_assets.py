#!/usr/bin/env python3

"""Verify published app assets against canonical inputs and pinned caches."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from .build_config import load_catalog_build_config
from .export_karura_web_catalog import load_elevation_asset, network_geojson
from .karura_common import (
    APP_MANIFEST_JSON,
    CATALOG_BUILD_JSON,
    CONTIGS_JSON,
    ELEVATION_JSON,
    JUNCTION_BINDINGS_JSON,
    JUNCTIONS_JSON,
    MAP_JSON,
    MAP_PATCHES_JSON,
    PATCHED_MAP_JSON,
    WEB_GENERATED_DIR,
)
from .karura_routing import load_junction_bindings, load_junction_catalog, load_route_graph
from .rebuild_app_assets import build_app_manifest
from .verify_editor_assets import parse_args as parse_editor_args, verify_editor_assets


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--map-json", type=Path, default=MAP_JSON)
    parser.add_argument("--patches-json", type=Path, default=MAP_PATCHES_JSON)
    parser.add_argument("--patched-map-json", type=Path, default=PATCHED_MAP_JSON)
    parser.add_argument("--contigs-json", type=Path, default=CONTIGS_JSON)
    parser.add_argument("--junctions-json", type=Path, default=JUNCTIONS_JSON)
    parser.add_argument("--junction-bindings-json", type=Path, default=JUNCTION_BINDINGS_JSON)
    parser.add_argument("--build-config-json", type=Path, default=CATALOG_BUILD_JSON)
    parser.add_argument("--elevation-json", type=Path, default=ELEVATION_JSON)
    parser.add_argument("--output-network", type=Path, default=WEB_GENERATED_DIR / "karura-network.geojson")
    parser.add_argument("--output-editor-network", type=Path, default=WEB_GENERATED_DIR / "karura-editor-network.geojson")
    parser.add_argument("--output-editor-manifest", type=Path, default=WEB_GENERATED_DIR / "editor-manifest.json")
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


def load_json(path: Path) -> dict:
    return json.loads(path.read_text())


def normalized(payload: dict) -> dict:
    clone = json.loads(json.dumps(payload))
    clone.get("meta", {}).pop("generated_at", None)
    return clone


def assert_equal(label: str, actual, expected) -> None:
    if actual != expected:
        raise SystemExit(f"{label} is stale; rebuild app assets and commit the derived output")


def verify_app_assets(args: argparse.Namespace) -> dict:
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
    editor_verification = verify_editor_assets(editor_args)

    if args.elevation_json.exists():
        elevation_payload = load_json(args.elevation_json)
        actual_contigs = load_json(args.contigs_json)
        actual_graph_asset_id = elevation_payload.get("meta", {}).get("graph_asset_id")
        expected_graph_asset_id = actual_contigs.get("meta", {}).get("asset_id")
        if actual_graph_asset_id != expected_graph_asset_id:
            raise SystemExit(
                f"{args.elevation_json} does not match current contig graph; rebuild elevation and commit the updated cache"
            )

    graph = load_route_graph(args.contigs_json)
    build_config_payload = load_catalog_build_config(args.build_config_json)
    node_elevations, elevation_matches_graph = load_elevation_asset(
        args.elevation_json,
        expected_graph_asset_id=graph.asset_id,
    )
    expected_network = network_geojson(
        graph,
        meta={
            "graph_asset_id": graph.asset_id,
            "asset_kind": graph.asset_kind,
            "source_path": "data/karura_contigs.json",
        },
        node_elevations=node_elevations if elevation_matches_graph else None,
    )
    junction_catalog = load_junction_catalog(args.junctions_json)
    junction_bindings = load_junction_bindings(args.junction_bindings_json)
    actual_network = load_json(args.output_network)
    actual_manifest = load_json(args.output_app_manifest)
    assert_equal(str(args.output_network), actual_network, expected_network)
    expected_manifest = build_app_manifest(
        args,
        editor_manifest=load_json(args.output_editor_manifest),
        graph=graph,
        junction_catalog=junction_catalog,
        junction_bindings=junction_bindings,
        build_config_payload=build_config_payload,
        elevation_matches_graph=elevation_matches_graph,
    )
    assert_equal(str(args.output_app_manifest), normalized(actual_manifest), normalized(expected_manifest))
    return {
        "verified": True,
        "graph_asset_id": actual_manifest["meta"]["graph_asset_id"],
        "editor_graph_asset_id": actual_manifest["meta"]["editor_graph_asset_id"],
        "junction_bindings_asset_id": actual_manifest["meta"]["junction_bindings_asset_id"],
        "catalog_build_digest": actual_manifest["meta"]["catalog_build_digest"],
    }


def main() -> None:
    args = parse_args()
    print(json.dumps(verify_app_assets(args), indent=2))


if __name__ == "__main__":
    main()
