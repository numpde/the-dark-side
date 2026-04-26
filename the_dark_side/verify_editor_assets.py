#!/usr/bin/env python3

"""Verify editor-facing derived assets against canonical inputs."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from types import SimpleNamespace

from .apply_karura_patches import apply_patchset, load_patchset
from .build_karura_contigs import build_contigs
from .download_karura_map import load_map
from .export_karura_web_catalog import build_editor_graph_payload_from_map
from .junction_bindings import build_junction_bindings, load_junction_catalog
from .karura_common import (
    CONTIGS_JSON,
    EDITOR_MANIFEST_JSON,
    FRONTEND_MANIFEST_JSON,
    JUNCTION_BINDINGS_JSON,
    JUNCTIONS_JSON,
    MAP_JSON,
    MAP_PATCHES_JSON,
    PATCHED_MAP_JSON,
    SOURCE_ASSET_PATHS,
    WEB_GENERATED_DIR,
    WEB_SOURCE_DIR,
    repo_rel,
)
from .karura_common import include_ride_way
from .rebuild_editor_assets import build_editor_manifest, build_frontend_manifest


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--map-json", type=Path, default=MAP_JSON)
    parser.add_argument("--patches-json", type=Path, default=MAP_PATCHES_JSON)
    parser.add_argument("--patched-map-json", type=Path, default=PATCHED_MAP_JSON)
    parser.add_argument("--contigs-json", type=Path, default=CONTIGS_JSON)
    parser.add_argument("--junctions-json", type=Path, default=JUNCTIONS_JSON)
    parser.add_argument("--junction-bindings-json", type=Path, default=JUNCTION_BINDINGS_JSON)
    parser.add_argument("--output-editor-network", type=Path, default=WEB_GENERATED_DIR / "karura-editor-network.geojson")
    parser.add_argument("--output-editor-manifest", type=Path, default=EDITOR_MANIFEST_JSON)
    parser.add_argument("--output-frontend-manifest", type=Path, default=FRONTEND_MANIFEST_JSON)
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
    return parser.parse_args(argv)


def load_json(path: Path) -> dict:
    return json.loads(path.read_text())


def normalized(payload: dict) -> dict:
    clone = json.loads(json.dumps(payload))
    clone.get("meta", {}).pop("generated_at", None)
    return clone


def assert_equal(label: str, actual, expected) -> None:
    if actual != expected:
        raise SystemExit(f"{label} is stale; rebuild editor assets and commit the derived output")


def verify_sources_synced() -> None:
    for canonical_path in SOURCE_ASSET_PATHS:
        expected_path = WEB_SOURCE_DIR / canonical_path.name
        if not expected_path.exists():
            raise SystemExit(f"missing published source asset: {expected_path}; run rebuild_editor_assets and commit")
        assert_equal(str(expected_path), expected_path.read_text(), canonical_path.read_text())


def build_expected(args: argparse.Namespace) -> tuple[dict, dict, dict, dict, dict, dict]:
    baseline_map = load_map(args.map_json)
    patchset = load_patchset(args.patches_json)
    expected_patched_map = apply_patchset(
        baseline_map,
        patchset=patchset,
        source_map=repo_rel(args.map_json),
        patchset_path=repo_rel(args.patches_json),
        fill_segment_gaps=args.fill_segment_gaps,
        respect_inner_rings=args.respect_inner_rings,
    ).to_dict()
    expected_contigs = build_contigs(
        expected_patched_map,
        source_map=repo_rel(args.patched_map_json),
        patchset=patchset,
        patchset_path=repo_rel(args.patches_json),
        include_way=include_ride_way,
        graph_mode="ride",
    )
    graph = SimpleNamespace(
        asset_id=expected_contigs["meta"]["asset_id"],
        nodes={
            int(node_id): SimpleNamespace(
                id=int(node_id),
                lat=float(node_payload["lat"]),
                lon=float(node_payload["lon"]),
            )
            for node_id, node_payload in expected_contigs["nodes"].items()
        },
        adjacency={},
    )
    for contig in expected_contigs["contigs"]:
        first, second = [int(node_id) for node_id in contig["endpoint_node_ids"]]
        graph.adjacency.setdefault(first, []).append((int(contig["id"]), second))
        if first != second:
            graph.adjacency.setdefault(second, []).append((int(contig["id"]), first))
    junction_catalog = load_junction_catalog(args.junctions_json)
    expected_bindings = build_junction_bindings(
        junction_catalog,
        graph,
        junctions_path=args.junctions_json,
        graph_path=args.contigs_json,
    )
    expected_editor_graph, expected_editor_network = build_editor_graph_payload_from_map(
        editor_map_payload=expected_patched_map,
        editor_map_json=args.patched_map_json,
        editor_patches_json=args.patches_json,
    )
    expected_manifest = build_editor_manifest(args, expected_patched_map, expected_contigs, expected_bindings, expected_editor_graph)
    expected_frontend_manifest = build_frontend_manifest()
    return expected_patched_map, expected_contigs, expected_bindings, expected_editor_network, expected_manifest, expected_frontend_manifest


def verify_editor_assets(args: argparse.Namespace) -> dict:
    verify_sources_synced()
    (
        expected_patched_map,
        expected_contigs,
        expected_bindings,
        expected_editor_network,
        expected_manifest,
        expected_frontend_manifest,
    ) = build_expected(args)
    actual_patched_map = load_json(args.patched_map_json)
    actual_contigs = load_json(args.contigs_json)
    actual_bindings = load_json(args.junction_bindings_json)
    actual_editor_network = load_json(args.output_editor_network)
    actual_manifest = load_json(args.output_editor_manifest)
    actual_frontend_manifest = load_json(args.output_frontend_manifest)
    assert_equal(str(args.patched_map_json), actual_patched_map, expected_patched_map)
    assert_equal(str(args.contigs_json), actual_contigs, expected_contigs)
    assert_equal(str(args.junction_bindings_json), normalized(actual_bindings), normalized(expected_bindings))
    assert_equal(str(args.output_editor_network), actual_editor_network, expected_editor_network)
    assert_equal(str(args.output_editor_manifest), normalized(actual_manifest), normalized(expected_manifest))
    assert_equal(str(args.output_frontend_manifest), normalized(actual_frontend_manifest), normalized(expected_frontend_manifest))
    return {
        "verified": True,
        "graph_asset_id": actual_contigs["meta"]["asset_id"],
        "editor_graph_asset_id": actual_manifest["meta"]["editor_graph_asset_id"],
        "junction_bindings_asset_id": actual_bindings["meta"]["asset_id"],
        "editor_manifest": str(args.output_editor_manifest),
    }


def main() -> None:
    args = parse_args()
    print(json.dumps(verify_editor_assets(args), indent=2))


if __name__ == "__main__":
    main()
