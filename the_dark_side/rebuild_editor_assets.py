#!/usr/bin/env python3

"""Rebuild deterministic editor-facing assets from canonical inputs."""

from __future__ import annotations

import argparse
import json

from .asset_contracts import load_required_junction_catalog, load_required_patchset, load_required_route_policy
from .apply_karura_patches import apply_patchset
from .asset_pipeline_cli import add_editor_asset_args
from .build_karura_contigs import build_contigs
from .download_karura_map import load_map
from .junction_bindings import build_junction_bindings
from .karura_common import (
    CONTIGS_JSON,
    EDITOR_MANIFEST_JSON,
    include_baseline_way,
    repo_rel,
    sync_web_source_assets,
    utc_now_z,
    write_json_document,
)
from .route_policy import apply_route_policy_bindings, build_route_policy_bindings, route_policy_digest
from .web_assets import build_editor_graph_payload


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    add_editor_asset_args(parser, include_output_editor_manifest=True)
    return parser.parse_args(argv)


def rebuild_patched_map(args: argparse.Namespace) -> dict:
    baseline_map = load_map(args.map_json)
    patchset = load_required_patchset(args.map_patches_json, label="map patchset file")
    patched = apply_patchset(
        baseline_map,
        patchset=patchset,
        source_map=repo_rel(args.map_json),
        patchset_path=repo_rel(args.map_patches_json),
        boundary_buffer_m=args.boundary_buffer_m,
        fill_segment_gaps=args.fill_segment_gaps,
        respect_inner_rings=args.respect_inner_rings,
    )
    write_json_document(args.patched_map_json, patched.to_dict(), sort_keys=True)
    return patched.to_dict()


def rebuild_contigs(args: argparse.Namespace, patched_payload: dict, route_policy: dict) -> dict:
    contig_graph = build_contigs(
        patched_payload,
        source_map=repo_rel(args.patched_map_json),
        include_way=include_baseline_way,
        route_policy=route_policy,
        graph_mode="ride",
    )
    bindings = build_route_policy_bindings(route_policy, contig_graph)
    applied_graph = apply_route_policy_bindings(
        contig_graph,
        bindings,
        route_policy_path=repo_rel(args.route_policy_json),
    )
    write_json_document(args.route_policy_bindings_json, bindings, sort_keys=True)
    write_json_document(args.contigs_json, applied_graph, sort_keys=True)
    return applied_graph


def rebuild_junction_bindings(args: argparse.Namespace, contig_payload: dict) -> dict:
    from .karura_routing import load_route_graph

    graph = load_route_graph(args.contigs_json)
    junction_catalog = load_required_junction_catalog(args.junctions_json, label="junction catalog")
    payload = build_junction_bindings(
        junction_catalog,
        graph,
        junctions_path=args.junctions_json,
        graph_path=args.contigs_json,
    )
    write_json_document(args.junction_bindings_json, payload)
    return payload


def rebuild_editor_network(args: argparse.Namespace, route_policy: dict) -> tuple[dict, dict]:
    editor_graph_payload, editor_network = build_editor_graph_payload(
        editor_map_json=args.patched_map_json,
        route_policy=route_policy,
    )
    write_json_document(args.output_editor_network, editor_network)
    return editor_graph_payload, editor_network


def build_editor_manifest(args: argparse.Namespace, patched_payload: dict, contig_payload: dict, bindings_payload: dict, editor_graph_payload: dict) -> dict:
    route_policy = load_required_route_policy(args.route_policy_json, label="route policy file")
    return {
        "meta": {
            "generated_at": utc_now_z(),
            "asset_kind": "editor_manifest",
            "ride_graph_asset_id": contig_payload["meta"]["asset_id"],
            "editor_graph_asset_id": editor_graph_payload["meta"]["asset_id"],
            "patched_map_asset_id": patched_payload["meta"]["asset_id"],
            "junction_bindings_asset_id": bindings_payload["meta"]["asset_id"],
            "route_policy_asset_id": route_policy["meta"]["asset_id"],
            "route_policy_digest": route_policy_digest(route_policy),
            "route_policy_path": repo_rel(args.route_policy_json),
            "route_policy_bindings_asset_id": contig_payload["meta"]["route_policy_bindings_asset_id"],
            "respect_inner_rings": patched_payload["meta"]["respect_inner_rings"],
            "fill_segment_gaps": patched_payload["meta"]["fill_segment_gaps"],
            "boundary_buffer_m": patched_payload["meta"]["boundary_buffer_m"],
        },
        "editor": {
            "network_path": args.output_editor_network.name,
            "network_version": editor_graph_payload["meta"]["asset_id"],
        },
    }

def rebuild_editor_assets(args: argparse.Namespace) -> dict[str, dict]:
    sync_web_source_assets()
    patched_payload = rebuild_patched_map(args)
    route_policy = load_required_route_policy(args.route_policy_json, label="route policy file")
    contig_payload = rebuild_contigs(args, patched_payload, route_policy)
    bindings_payload = rebuild_junction_bindings(args, contig_payload)
    editor_graph_payload, editor_network = rebuild_editor_network(args, route_policy)
    manifest = build_editor_manifest(
        args,
        patched_payload,
        contig_payload,
        bindings_payload,
        editor_graph_payload,
    )
    write_json_document(args.output_editor_manifest, manifest)
    return {
        "patched_payload": patched_payload,
        "contig_payload": contig_payload,
        "bindings_payload": bindings_payload,
        "editor_graph_payload": editor_graph_payload,
        "editor_network": editor_network,
        "editor_manifest": manifest,
    }


def main(argv: list[str] | None = None) -> None:
    args = parse_args(argv)
    bundle = rebuild_editor_assets(args)
    print(
        json.dumps(
            {
                "patched_map": str(args.patched_map_json),
                "contigs": str(args.contigs_json),
                "junction_bindings": str(args.junction_bindings_json),
                "editor_network": str(args.output_editor_network),
                "editor_manifest": str(args.output_editor_manifest),
                "contig_count": bundle["contig_payload"]["meta"]["contig_count"],
                "editor_contig_count": bundle["editor_graph_payload"]["meta"]["contig_count"],
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
