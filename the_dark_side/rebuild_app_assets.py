#!/usr/bin/env python3

"""Rebuild published app assets from canonical inputs."""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

from .export_karura_web_catalog import (
    load_elevation_asset,
    network_geojson,
    write_json as write_export_json,
)
from .karura_common import (
    APP_MANIFEST_JSON,
    CATALOG_BUILD_JSON,
    CONTIGS_JSON,
    EDITOR_MANIFEST_JSON,
    ELEVATION_JSON,
    FRONTEND_MANIFEST_JSON,
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
    build_frontend_manifest,
    build_editor_manifest,
    parse_args as parse_editor_args,
    rebuild_contigs,
    rebuild_editor_network,
    rebuild_junction_bindings,
    rebuild_patched_map,
)
from .build_config import catalog_build_config_digest, load_catalog_build_config
from .karura_routing import load_junction_bindings, load_junction_catalog, load_route_graph


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
    planner_config = {
        key: build_config_payload[key]
        for key in (
            "short_connector_max_length_m",
            "max_overlap_m",
            "max_steps",
            "random_top_k",
            "end_stop_unused_slack_m",
            "end_finish_unused_slack_m",
            "future_length_weight",
            "connector_length_weight",
            "overlap_penalty_per_m",
            "articulation_penalty",
            "articulation_future_threshold_m",
            "dead_end_penalty",
            "early_finish_penalty",
            "beam_width",
            "beam_branch_factor",
            "beam_rounds",
            "beam_selection_pool",
            "beam_selection_window",
            "elevation_smoothing_window",
            "elevation_min_step_m",
        )
    }
    planner_config["beam_width"] = min(int(planner_config["beam_width"]), 32)
    planner_config["beam_branch_factor"] = min(int(planner_config["beam_branch_factor"]), 3)
    planner_config["beam_rounds"] = min(int(planner_config["beam_rounds"]), 96)
    junction_defs = junction_catalog["junctions"]
    scenarios = [
        {
            "id": f"{start['id']}__to__{end['id']}",
            "start_junction_id": start["id"],
            "end_junction_id": end["id"],
            "is_loop": start["id"] == end["id"],
        }
        for start in junction_defs
        for end in junction_defs
    ]
    return {
        "meta": {
            "generated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "asset_kind": "app_manifest",
            "graph_asset_id": graph.asset_id,
            "ride_graph_asset_id": graph.asset_id,
            "editor_graph_asset_id": editor_manifest["meta"]["editor_graph_asset_id"],
            "junction_bindings_asset_id": junction_bindings["meta"]["asset_id"],
            "catalog_build_path": repo_rel(args.build_config_json),
            "catalog_build_digest": build_config_digest,
            "elevation_asset_matches_graph": elevation_matches_graph,
        },
        "planner": {
            "algorithm": "browser-beam-v1",
            "network_path": args.output_network.name,
            "network_version": graph.asset_id,
            "config": planner_config,
        },
        "areas": [
            {
                "id": "karura",
                "name": "Karura Forest",
                "bounds": [
                    round(min(node.lon for node in graph.nodes.values()), 6),
                    round(min(node.lat for node in graph.nodes.values()), 6),
                    round(max(node.lon for node in graph.nodes.values()), 6),
                    round(max(node.lat for node in graph.nodes.values()), 6),
                ],
                "junctions": [
                    {
                        **junction,
                        "graph_node_id": junction_node_id_by_id[junction["id"]],
                    }
                    for junction in junction_defs
                ],
                "scenarios": scenarios,
            }
        ],
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
    write_export_json(FRONTEND_MANIFEST_JSON, build_frontend_manifest())
    graph = load_route_graph(args.contigs_json)
    build_config_payload = load_catalog_build_config(args.build_config_json)
    node_elevations, elevation_matches_graph = load_elevation_asset(
        args.elevation_json,
        expected_graph_asset_id=graph.asset_id,
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
    write_export_json(args.output_network, route_network)
    junction_catalog = load_junction_catalog(args.junctions_json)
    junction_bindings = load_junction_bindings(args.junction_bindings_json)
    app_manifest = build_app_manifest(
        args,
        editor_manifest=editor_manifest,
        graph=graph,
        junction_catalog=junction_catalog,
        junction_bindings=junction_bindings,
        build_config_payload=build_config_payload,
        elevation_matches_graph=elevation_matches_graph,
    )
    write_export_json(args.output_app_manifest, app_manifest)
    print(
        json.dumps(
            {
                "network": str(args.output_network),
                "editor_network": str(args.output_editor_network),
                "editor_manifest": str(args.output_editor_manifest),
                "app_manifest": str(args.output_app_manifest),
                "network_feature_count": len(route_network["features"]),
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
