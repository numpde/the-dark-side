#!/usr/bin/env python3

"""Debug/oracle tool: plan Karura route candidates between curated junctions."""

from __future__ import annotations

import argparse
import os
from pathlib import Path
import random

from .build_config import add_planner_config_args, planner_config_kwargs_from_namespace, resolve_build_config_defaults
from .karura_common import CATALOG_BUILD_JSON, CONTIGS_JSON, JUNCTIONS_JSON, JUNCTION_BINDINGS_JSON, ROUTES_DIR, print_json_document, write_json_document
from .karura_routing import (
    PlannerConfig,
    load_graph_junction_context,
    planner_for,
    PLANNER_NAMES,
    resolve_context_junction_ref,
    route_asset_payload,
)


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    build_config_json, planner_defaults, remaining = resolve_build_config_defaults(
        argv,
        default_path=CATALOG_BUILD_JSON,
    )

    parser = argparse.ArgumentParser(
        description=__doc__,
        epilog="Offline/debug tool only. The published app composes routes in the browser.",
    )
    parser.add_argument("--build-config-json", type=Path, default=build_config_json)
    parser.add_argument("--algorithm", choices=PLANNER_NAMES, default="naive")
    parser.add_argument("--contigs-json", type=Path, default=CONTIGS_JSON)
    parser.add_argument("--junctions-json", type=Path, default=JUNCTIONS_JSON)
    parser.add_argument("--junction-bindings-json", type=Path, default=JUNCTION_BINDINGS_JSON)
    parser.add_argument("--start-junction", default="family_trail_west")
    parser.add_argument("--end-junction", default="kiambu_side_exit")
    parser.add_argument("--seed", type=int, default=7)
    add_planner_config_args(parser, planner_defaults)
    parser.add_argument("--output", type=Path)
    return parser.parse_args(remaining)


def build_config(args: argparse.Namespace) -> PlannerConfig:
    return PlannerConfig(**planner_config_kwargs_from_namespace(args))


def default_output(args: argparse.Namespace) -> Path:
    filename = (
        f"karura-route-{args.algorithm}-"
        f"{args.start_junction}-to-{args.end_junction}-seed{args.seed}.json"
    )
    return ROUTES_DIR / filename


def main() -> None:
    args = parse_args()
    config = build_config(args)
    context = load_graph_junction_context(
        contigs_json=args.contigs_json,
        junctions_json=args.junctions_json,
        junction_bindings_json=args.junction_bindings_json,
    )
    graph = context.graph
    start_ref = resolve_context_junction_ref(context, args.start_junction)
    end_ref = resolve_context_junction_ref(context, args.end_junction)
    rng = random.Random(args.seed)
    planner = planner_for(args.algorithm)
    candidates = planner(
        graph,
        start_node_id=start_ref.graph_node_id,
        end_node_id=end_ref.graph_node_id,
        config=config,
        rng=rng,
    )

    output = args.output or default_output(args)
    graph_ref_path = Path(os.path.relpath(args.contigs_json.resolve(), output.parent.resolve()))
    payload = route_asset_payload(
        graph_path=graph_ref_path,
        graph=graph,
        junction_catalog=context.junction_catalog,
        start_ref=start_ref,
        end_ref=end_ref,
        algorithm=args.algorithm,
        config=config,
        seed=args.seed,
        candidates=candidates,
    )
    write_json_document(output, payload, sort_keys=True)

    top = payload["routes"][0] if payload["routes"] else None
    summary = {
        "algorithm": args.algorithm,
        "output": str(output),
        "route_count": len(payload["routes"]),
        "top_route": {
            "complete": top["complete"],
            "unique_length_m": top["unique_length_m"],
            "overlap_length_m": top["overlap_length_m"],
            "step_count": len(top["steps"]),
        }
        if top
        else None,
    }
    print_json_document(summary)


if __name__ == "__main__":
    main()
