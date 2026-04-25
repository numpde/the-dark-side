#!/usr/bin/env python3

"""Verify that derived assets match the current canonical inputs."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from .apply_karura_patches import apply_patchset, load_patchset
from .build_karura_contigs import build_contigs
from .download_karura_map import load_map
from .export_karura_web_catalog import build_export_payloads, parse_args as parse_export_args
from .karura_common import (
    CATALOG_BUILD_JSON,
    CONTIGS_JSON,
    ELEVATION_JSON,
    MAP_JSON,
    MAP_PATCHES_JSON,
    PATCHED_MAP_JSON,
    SOURCE_ASSET_PATHS,
    WEB_GENERATED_DIR,
    WEB_SOURCE_DIR,
    repo_rel,
)
from .karura_common import include_ride_way


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--map-json", type=Path, default=MAP_JSON)
    parser.add_argument("--patches-json", type=Path, default=MAP_PATCHES_JSON)
    parser.add_argument("--patched-map-json", type=Path, default=PATCHED_MAP_JSON)
    parser.add_argument("--contigs-json", type=Path, default=CONTIGS_JSON)
    parser.add_argument("--build-config-json", type=Path, default=CATALOG_BUILD_JSON)
    parser.add_argument("--elevation-json", type=Path, default=ELEVATION_JSON)
    parser.add_argument(
        "--fill-segment-gaps",
        action=argparse.BooleanOptionalAction,
        default=True,
    )
    return parser.parse_args()


def load_json(path: Path) -> dict:
    return json.loads(path.read_text())


def normalized_catalog(payload: dict) -> dict:
    clone = json.loads(json.dumps(payload))
    clone.get("meta", {}).pop("generated_at", None)
    return clone


def assert_equal(label: str, actual, expected) -> None:
    if actual != expected:
        raise SystemExit(f"{label} is stale; rebuild and commit the derived asset")


def main() -> None:
    args = parse_args()
    for canonical_path in SOURCE_ASSET_PATHS:
        expected_path = WEB_SOURCE_DIR / canonical_path.name
        if not expected_path.exists():
            raise SystemExit(f"missing published source asset: {expected_path}; run rebuild_all and commit the updated site sources")
        assert_equal(
            f"{expected_path}",
            expected_path.read_text(),
            canonical_path.read_text(),
        )

    baseline_map = load_map(args.map_json)
    patchset = load_patchset(args.patches_json)
    expected_patched_map = apply_patchset(
        baseline_map,
        patchset=patchset,
        source_map=repo_rel(args.map_json),
        patchset_path=repo_rel(args.patches_json),
        fill_segment_gaps=args.fill_segment_gaps,
    ).to_dict()
    actual_patched_map = load_json(args.patched_map_json)
    assert_equal(str(args.patched_map_json), actual_patched_map, expected_patched_map)

    expected_contigs = build_contigs(
        expected_patched_map,
        source_map=repo_rel(args.patched_map_json),
        patchset=patchset,
        patchset_path=repo_rel(args.patches_json),
        include_way=include_ride_way,
        graph_mode="ride",
    )
    actual_contigs = load_json(args.contigs_json)
    assert_equal(str(args.contigs_json), actual_contigs, expected_contigs)

    if args.elevation_json.exists():
        elevation_payload = load_json(args.elevation_json)
        actual_graph_asset_id = elevation_payload.get("meta", {}).get("graph_asset_id")
        expected_graph_asset_id = actual_contigs.get("meta", {}).get("asset_id")
        if actual_graph_asset_id != expected_graph_asset_id:
            raise SystemExit(
                f"{args.elevation_json} does not match current contig graph; rebuild elevation and commit the updated cache"
            )

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
    expected_export = build_export_payloads(export_args)
    actual_catalog = load_json(WEB_GENERATED_DIR / "catalog.json")
    actual_network = load_json(WEB_GENERATED_DIR / "karura-network.geojson")
    actual_editor_network = load_json(WEB_GENERATED_DIR / "karura-editor-network.geojson")

    assert_equal("web/generated/catalog.json", normalized_catalog(actual_catalog), normalized_catalog(expected_export["catalog"]))
    assert_equal("web/generated/karura-network.geojson", actual_network, expected_export["network"])
    assert_equal("web/generated/karura-editor-network.geojson", actual_editor_network, expected_export["editor_network"])

    print(
        json.dumps(
            {
                "verified": True,
                "patch_source": str(args.patches_json),
                "published_source_dir": str(WEB_SOURCE_DIR),
                "graph_asset_id": actual_contigs["meta"]["asset_id"],
                "catalog_build_digest": actual_catalog["meta"]["build_config_digest"],
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
