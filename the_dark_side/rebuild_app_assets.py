#!/usr/bin/env python3

"""Rebuild published app assets from canonical inputs."""

from __future__ import annotations

import argparse
import json

from .asset_contracts import load_required_junction_bindings, load_required_junction_catalog
from .asset_pipeline_cli import add_app_asset_args, editor_rebuild_argv_from_namespace
from .build_config import (
    browser_planner_config_from_build_config,
    catalog_build_config_digest,
    load_catalog_build_config,
)
from .karura_common import (
    APP_MANIFEST_JSON,
    EDITOR_MANIFEST_JSON,
    repo_rel,
    utc_now_z,
    write_json_document,
)
from .rebuild_editor_assets import (
    parse_args as parse_editor_args,
    rebuild_editor_assets as rebuild_editor_bundle,
)
from .karura_routing import load_route_graph
from .web_assets import (
    load_elevation_asset,
    network_geojson,
)

DEFAULT_AREA = {"id": "karura", "name": "Karura Forest"}


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    add_app_asset_args(parser)
    return parser.parse_args(argv)


def junction_catalog_area_defs(junction_catalog: dict) -> list[dict[str, str]]:
    area_defs = junction_catalog.get("meta", {}).get("areas")
    if not area_defs:
        return [dict(DEFAULT_AREA)]
    return [
        {
            "id": str(area["id"]),
            "name": str(area["name"]),
        }
        for area in area_defs
    ]


def junction_area_id(junction: dict, default_area_id: str) -> str:
    return str(junction.get("area_id") or default_area_id)


def scenarios_for_junctions(junction_defs: list[dict]) -> list[dict]:
    return [
        {
            "id": f"{start['id']}__to__{end['id']}",
            "start_junction_id": start["id"],
            "end_junction_id": end["id"],
            "is_loop": start["id"] == end["id"],
        }
        for start in junction_defs
        for end in junction_defs
    ]


def bounds_for_junctions(junction_defs: list[dict], graph) -> list[float]:
    if junction_defs:
        lons = [float(junction["location"]["lon"]) for junction in junction_defs]
        lats = [float(junction["location"]["lat"]) for junction in junction_defs]
    else:
        lons = [node.lon for node in graph.nodes.values()]
        lats = [node.lat for node in graph.nodes.values()]
    return [
        round(min(lons), 6),
        round(min(lats), 6),
        round(max(lons), 6),
        round(max(lats), 6),
    ]


def build_app_manifest(
    args: argparse.Namespace,
    *,
    editor_manifest: dict,
    graph,
    junction_catalog: dict,
    junction_bindings: dict,
    build_config_payload: dict,
    elevation_matches_graph: bool,
) -> dict:
    build_config_digest = catalog_build_config_digest(build_config_payload)
    junction_node_id_by_id = {
        binding["junction_id"]: int(binding["graph_node_id"])
        for binding in junction_bindings.get("bindings", [])
    }
    planner_config = browser_planner_config_from_build_config(build_config_payload)
    area_defs = junction_catalog_area_defs(junction_catalog)
    default_area_id = area_defs[0]["id"]
    junction_defs_by_area = {
        area["id"]: [
            junction
            for junction in junction_catalog["junctions"]
            if junction_area_id(junction, default_area_id) == area["id"]
        ]
        for area in area_defs
    }
    return {
        "meta": {
            "generated_at": utc_now_z(),
            "asset_kind": "app_manifest",
            "ride_graph_asset_id": graph.asset_id,
            "editor_graph_asset_id": editor_manifest["meta"]["editor_graph_asset_id"],
            "junction_bindings_asset_id": junction_bindings["meta"]["asset_id"],
            "route_policy_asset_id": editor_manifest["meta"]["route_policy_asset_id"],
            "route_policy_bindings_asset_id": graph.meta.get("route_policy_bindings_asset_id"),
            "catalog_build_path": repo_rel(args.build_config_json),
            "catalog_build_digest": build_config_digest,
            "elevation_asset_matches_graph": elevation_matches_graph,
        },
        "planner": {
            "algorithm": "browser-mcts-v1",
            "network_path": args.output_network.name,
            "network_version": graph.asset_id,
            "background_network_path": editor_manifest["editor"]["network_path"],
            "background_network_version": editor_manifest["editor"]["network_version"],
            "config": planner_config,
        },
        "areas": [
            {
                "id": area["id"],
                "name": area["name"],
                "bounds": bounds_for_junctions(junction_defs_by_area[area["id"]], graph),
                "junctions": [
                    {
                        **junction,
                        "graph_node_id": junction_node_id_by_id[junction["id"]],
                    }
                    for junction in junction_defs_by_area[area["id"]]
                ],
                "scenarios": scenarios_for_junctions(junction_defs_by_area[area["id"]]),
            }
            for area in area_defs
            if junction_defs_by_area[area["id"]]
        ],
    }


def editor_args_from_app_args(args: argparse.Namespace) -> argparse.Namespace:
    return parse_editor_args(
        editor_rebuild_argv_from_namespace(args, include_output_editor_manifest=True)
    )


def rebuild_app_assets(
    args: argparse.Namespace,
    *,
    editor_bundle: dict[str, dict] | None = None,
) -> dict[str, object]:
    if editor_bundle is None:
        editor_bundle = rebuild_editor_bundle(editor_args_from_app_args(args))

    graph = load_route_graph(args.contigs_json)
    build_config_payload = load_catalog_build_config(args.build_config_json)
    node_elevations, elevation_matches_graph = load_elevation_asset(
        args.elevation_json,
        expected_graph_asset_id=graph.asset_id,
    )
    if not elevation_matches_graph:
        if not args.elevation_json.exists():
            raise FileNotFoundError(
                f"missing elevation cache: {args.elevation_json}; rebuild elevation before publishing app assets"
            )
        raise RuntimeError(
            f"{args.elevation_json} does not match current contig graph; rebuild elevation before publishing app assets"
        )
    route_network = network_geojson(
        graph,
        meta={
            "graph_asset_id": graph.asset_id,
            "asset_kind": graph.asset_kind,
            "source_path": repo_rel(args.contigs_json),
        },
        node_elevations=node_elevations if elevation_matches_graph else None,
    )
    write_json_document(args.output_network, route_network)
    junction_catalog = load_required_junction_catalog(args.junctions_json, label="junction catalog")
    junction_bindings = load_required_junction_bindings(args.junction_bindings_json, label="junction bindings")
    app_manifest = build_app_manifest(
        args,
        editor_manifest=editor_bundle["editor_manifest"],
        graph=graph,
        junction_catalog=junction_catalog,
        junction_bindings=junction_bindings,
        build_config_payload=build_config_payload,
        elevation_matches_graph=elevation_matches_graph,
    )
    write_json_document(args.output_app_manifest, app_manifest)
    return {
        "route_network": route_network,
        "app_manifest": app_manifest,
        "editor_bundle": editor_bundle,
        "elevation_matches_graph": elevation_matches_graph,
    }


def main(argv: list[str] | None = None) -> None:
    args = parse_args(argv)
    bundle = rebuild_app_assets(args)
    print(
        json.dumps(
            {
                "network": str(args.output_network),
                "editor_network": str(args.output_editor_network),
                "editor_manifest": str(args.output_editor_manifest),
                "app_manifest": str(args.output_app_manifest),
                "network_feature_count": len(bundle["route_network"]["features"]),
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
