#!/usr/bin/env python3

"""Verify published app assets against canonical inputs and pinned caches."""

from __future__ import annotations

import argparse
import json

from .asset_contracts import load_required_elevation_asset
from .asset_contracts import load_required_junction_bindings, load_required_junction_catalog
from .asset_pipeline_cli import add_app_asset_args
from .build_config import (
    BROWSER_PLANNER_REQUIRED_NUMERIC_FIELDS,
    load_catalog_build_config,
)
from .karura_routing import load_route_graph
from .rebuild_app_assets import build_app_manifest, editor_args_from_app_args
from .verify_helpers import assert_equal, load_json, normalized
from .verify_editor_assets import verify_editor_assets
from .web_assets import load_elevation_asset, network_geojson


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    add_app_asset_args(parser)
    return parser.parse_args(argv)


def validate_manifest_schema(manifest: dict) -> None:
    planner = manifest.get("planner")
    if not isinstance(planner, dict):
        raise SystemExit("app manifest is stale; missing planner object")
    network_path = planner.get("network_path")
    network_version = planner.get("network_version")
    config = planner.get("config")
    if not isinstance(network_path, str) or not network_path:
        raise SystemExit("app manifest is stale; missing planner.network_path")
    if not isinstance(network_version, str) or not network_version:
        raise SystemExit("app manifest is stale; missing planner.network_version")
    if not isinstance(config, dict):
        raise SystemExit("app manifest is stale; missing planner.config object")
    for field_name in BROWSER_PLANNER_REQUIRED_NUMERIC_FIELDS:
        if not isinstance(config.get(field_name), (int, float)):
            raise SystemExit(f"app manifest is stale; missing numeric planner.config.{field_name}")
    areas = manifest.get("areas")
    if not isinstance(areas, list) or not areas:
        raise SystemExit("app manifest is stale; missing non-empty areas list")
    for area in areas:
        if not isinstance(area, dict):
            raise SystemExit("app manifest is stale; area entries must be objects")
        junctions = area.get("junctions")
        if not isinstance(junctions, list) or not junctions:
            raise SystemExit("app manifest is stale; area is missing non-empty junctions list")
        junction_ids = set()
        for junction in junctions:
            if not isinstance(junction, dict):
                raise SystemExit("app manifest is stale; junction entries must be objects")
            if "lat" in junction or "lon" in junction:
                raise SystemExit("app manifest is stale; junctions must use location.lat/lon, not top-level lat/lon")
            location = junction.get("location")
            if not isinstance(location, dict):
                raise SystemExit("app manifest is stale; junction is missing location object")
            if not isinstance(location.get("lat"), (int, float)) or not isinstance(location.get("lon"), (int, float)):
                raise SystemExit("app manifest is stale; junction location must contain numeric lat/lon")
            if not isinstance(junction.get("graph_node_id"), int):
                raise SystemExit("app manifest is stale; junction is missing integer graph_node_id")
            junction_id = junction.get("id")
            if not isinstance(junction_id, str) or not junction_id:
                raise SystemExit("app manifest is stale; junction is missing string id")
            junction_ids.add(junction_id)
        scenarios = area.get("scenarios")
        if not isinstance(scenarios, list) or not scenarios:
            raise SystemExit("app manifest is stale; area is missing non-empty scenarios list")
        for scenario in scenarios:
            if not isinstance(scenario, dict):
                raise SystemExit("app manifest is stale; scenario entries must be objects")
            start_junction_id = scenario.get("start_junction_id")
            end_junction_id = scenario.get("end_junction_id")
            if start_junction_id not in junction_ids or end_junction_id not in junction_ids:
                raise SystemExit("app manifest is stale; scenario references unknown junction ids")
            if not isinstance(scenario.get("is_loop"), bool):
                raise SystemExit("app manifest is stale; scenario is missing boolean is_loop")


def verify_app_assets(args: argparse.Namespace) -> dict:
    editor_args = editor_args_from_app_args(args)
    editor_verification = verify_editor_assets(editor_args)
    graph = load_route_graph(args.contigs_json)

    if args.elevation_json.exists():
        elevation_payload = load_required_elevation_asset(args.elevation_json, label="elevation cache")
        actual_graph_asset_id = elevation_payload["meta"]["graph_asset_id"]
        expected_graph_asset_id = graph.asset_id
        if actual_graph_asset_id != expected_graph_asset_id:
            raise SystemExit(
                f"{args.elevation_json} does not match current contig graph; rebuild elevation and commit the updated cache"
            )
    else:
        raise SystemExit(
            f"missing elevation cache: {args.elevation_json}; rebuild elevation and commit the updated cache"
        )

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
    junction_catalog = load_required_junction_catalog(args.junctions_json, label="junction catalog")
    junction_bindings = load_required_junction_bindings(args.junction_bindings_json, label="junction bindings")
    actual_network = load_json(args.output_network)
    actual_manifest = load_json(args.output_app_manifest)
    validate_manifest_schema(actual_manifest)
    if actual_manifest["meta"].get("elevation_asset_matches_graph") is not True:
        raise SystemExit("app manifest is stale; elevation_asset_matches_graph must be true for published app assets")
    rebuild_hint = "rebuild app assets and commit the derived output"
    assert_equal(str(args.output_network), actual_network, expected_network, rebuild_hint=rebuild_hint)
    expected_manifest = build_app_manifest(
        args,
        editor_manifest=load_json(args.output_editor_manifest),
        graph=graph,
        junction_catalog=junction_catalog,
        junction_bindings=junction_bindings,
        build_config_payload=build_config_payload,
        elevation_matches_graph=elevation_matches_graph,
    )
    assert_equal(
        str(args.output_app_manifest),
        normalized(actual_manifest),
        normalized(expected_manifest),
        rebuild_hint=rebuild_hint,
    )
    return {
        "verified": True,
        "ride_graph_asset_id": actual_manifest["meta"]["ride_graph_asset_id"],
        "editor_graph_asset_id": actual_manifest["meta"]["editor_graph_asset_id"],
        "junction_bindings_asset_id": actual_manifest["meta"]["junction_bindings_asset_id"],
        "catalog_build_digest": actual_manifest["meta"]["catalog_build_digest"],
    }


def main() -> None:
    args = parse_args()
    print(json.dumps(verify_app_assets(args), indent=2))


if __name__ == "__main__":
    main()
