#!/usr/bin/env python3

"""Plan long low-overlap Karura routes between curated junctions."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import random

from .build_config import add_planner_config_args, load_catalog_build_config, planner_config_kwargs_from_namespace
from .karura_common import CATALOG_BUILD_JSON, CONTIGS_JSON, JUNCTIONS_JSON, JUNCTION_BINDINGS_JSON, ROUTES_DIR
from .karura_routing import (
    PlannerConfig,
    load_junction_bindings,
    load_junction_catalog,
    load_route_graph,
    plan_route_beam,
    plan_route_mcts,
    plan_route_naive,
    resolve_junction_ref,
    route_asset_payload,
    write_json,
)


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    pre_parser = argparse.ArgumentParser(add_help=False)
    pre_parser.add_argument("--build-config-json", type=Path, default=CATALOG_BUILD_JSON)
    pre_args, remaining = pre_parser.parse_known_args(argv)
    planner_defaults = load_catalog_build_config(pre_args.build_config_json)

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--build-config-json", type=Path, default=pre_args.build_config_json)
    parser.add_argument("--algorithm", choices=("naive", "beam", "mcts"), default="naive")
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
    graph = load_route_graph(args.contigs_json)
    junction_catalog = load_junction_catalog(args.junctions_json)
    junction_bindings = load_junction_bindings(args.junction_bindings_json)
    start_ref = resolve_junction_ref(junction_catalog, args.start_junction, graph.asset_id, junction_bindings)
    end_ref = resolve_junction_ref(junction_catalog, args.end_junction, graph.asset_id, junction_bindings)
    rng = random.Random(args.seed)

    if args.algorithm == "naive":
        candidates = plan_route_naive(
            graph,
            start_node_id=start_ref.graph_node_id,
            end_node_id=end_ref.graph_node_id,
            config=config,
            rng=rng,
        )
    elif args.algorithm == "beam":
        candidates = plan_route_beam(
            graph,
            start_node_id=start_ref.graph_node_id,
            end_node_id=end_ref.graph_node_id,
            config=config,
            rng=rng,
        )
    else:
        candidates = plan_route_mcts(
            graph,
            start_node_id=start_ref.graph_node_id,
            end_node_id=end_ref.graph_node_id,
            config=config,
            rng=rng,
        )

    output = args.output or default_output(args)
    graph_ref_path = Path(os.path.relpath(args.contigs_json.resolve(), output.parent.resolve()))
    junctions_ref_path = Path(os.path.relpath(args.junctions_json.resolve(), output.parent.resolve()))
    junction_bindings_ref_path = Path(os.path.relpath(args.junction_bindings_json.resolve(), output.parent.resolve()))
    payload = route_asset_payload(
        graph_path=graph_ref_path,
        junctions_path=junctions_ref_path,
        junction_bindings_path=junction_bindings_ref_path,
        graph=graph,
        junction_catalog=junction_catalog,
        start_ref=start_ref,
        end_ref=end_ref,
        algorithm=args.algorithm,
        config=config,
        seed=args.seed,
        candidates=candidates,
    )
    write_json(output, payload)

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
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
