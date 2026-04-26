#!/usr/bin/env python3

"""Verify published app assets against canonical inputs and pinned caches."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from .build_config import catalog_build_config_digest, load_catalog_build_config
from .export_karura_web_catalog import build_export_payloads, parse_args as parse_export_args
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
    repo_rel,
)
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
    parser.add_argument("--output-catalog", type=Path, default=WEB_GENERATED_DIR / "catalog.json")
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


def build_expected_app_manifest(args: argparse.Namespace, export_payloads: dict[str, dict], editor_verification: dict) -> dict:
    config = load_catalog_build_config(args.build_config_json)
    config_digest = catalog_build_config_digest(config)
    catalog_meta = export_payloads["catalog"]["meta"]
    return {
        "meta": {
            "asset_kind": "app_manifest",
            "graph_asset_id": catalog_meta["graph_asset_id"],
            "ride_graph_asset_id": catalog_meta["graph_asset_id"],
            "editor_graph_asset_id": editor_verification["editor_graph_asset_id"],
            "junction_bindings_asset_id": catalog_meta["junction_bindings_asset_id"],
            "catalog_build_path": repo_rel(args.build_config_json),
            "catalog_build_digest": config_digest,
            "catalog_asset_graph_id": catalog_meta["graph_asset_id"],
            "elevation_asset_matches_graph": catalog_meta["elevation_asset_matches_graph"],
        }
    }


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
    expected_export = build_export_payloads(export_args)
    actual_catalog = load_json(args.output_catalog)
    actual_network = load_json(args.output_network)
    actual_manifest = load_json(args.output_app_manifest)
    assert_equal(str(args.output_catalog), normalized(actual_catalog), normalized(expected_export["catalog"]))
    assert_equal(str(args.output_network), actual_network, expected_export["network"])
    expected_manifest = build_expected_app_manifest(args, expected_export, editor_verification)
    assert_equal(str(args.output_app_manifest), normalized(actual_manifest), normalized(expected_manifest))
    return {
        "verified": True,
        "graph_asset_id": actual_catalog["meta"]["graph_asset_id"],
        "junction_bindings_asset_id": actual_catalog["meta"]["junction_bindings_asset_id"],
        "catalog_build_digest": actual_catalog["meta"]["build_config_digest"],
    }


def main() -> None:
    args = parse_args()
    print(json.dumps(verify_app_assets(args), indent=2))


if __name__ == "__main__":
    main()
