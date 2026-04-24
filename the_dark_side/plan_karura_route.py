#!/usr/bin/env python3

"""Plan long low-overlap Karura routes between curated junctions."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import random

from .karura_common import CONTIGS_JSON, JUNCTIONS_JSON, ROUTES_DIR
from .karura_routing import (
    PlannerConfig,
    load_junction_catalog,
    load_route_graph,
    plan_route_beam,
    plan_route_mcts,
    plan_route_naive,
    resolve_junction_ref,
    route_asset_payload,
    write_json,
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--algorithm", choices=("naive", "beam", "mcts"), default="naive")
    parser.add_argument("--contigs-json", type=Path, default=CONTIGS_JSON)
    parser.add_argument("--junctions-json", type=Path, default=JUNCTIONS_JSON)
    parser.add_argument("--start-junction", default="family_trail_west")
    parser.add_argument("--end-junction", default="kiambu_side_exit")
    parser.add_argument("--seed", type=int, default=7)
    parser.add_argument("--short-connector-max-length-m", type=float, default=35.0)
    parser.add_argument("--max-overlap-m", type=float, default=70.0)
    parser.add_argument("--max-steps", type=int, default=256)
    parser.add_argument("--random-top-k", type=int, default=4)
    parser.add_argument("--end-stop-probability", type=float, default=0.7)
    parser.add_argument("--end-stop-unused-slack-m", type=float, default=400.0)
    parser.add_argument("--rollout-trials", type=int, default=250)
    parser.add_argument("--beam-width", type=int, default=80)
    parser.add_argument("--beam-branch-factor", type=int, default=5)
    parser.add_argument("--beam-rounds", type=int, default=200)
    parser.add_argument("--beam-selection-pool", type=int, default=5)
    parser.add_argument("--beam-selection-window", type=int, default=12)
    parser.add_argument("--mcts-iterations", type=int, default=640)
    parser.add_argument("--mcts-exploration-weight", type=float, default=1.0)
    parser.add_argument("--mcts-rollout-top-k", type=int, default=3)
    parser.add_argument("--mcts-rollout-samples", type=int, default=3)
    parser.add_argument("--mcts-prior-weight", type=float, default=0.5)
    parser.add_argument("--mcts-loop-completion-bonus", type=float, default=220.0)
    parser.add_argument("--mcts-loop-unused-penalty-per-m", type=float, default=0.045)
    parser.add_argument("--mcts-loop-late-return-bonus", type=float, default=180.0)
    parser.add_argument("--mcts-loop-overlap-penalty-per-m", type=float, default=4.0)
    parser.add_argument("--keep-best", type=int, default=5)
    parser.add_argument("--output", type=Path)
    return parser.parse_args()


def build_config(args: argparse.Namespace) -> PlannerConfig:
    return PlannerConfig(
        short_connector_max_length_m=args.short_connector_max_length_m,
        max_overlap_m=args.max_overlap_m,
        max_steps=args.max_steps,
        random_top_k=args.random_top_k,
        end_stop_probability=args.end_stop_probability,
        end_stop_unused_slack_m=args.end_stop_unused_slack_m,
        rollout_trials=args.rollout_trials,
        beam_width=args.beam_width,
        beam_branch_factor=args.beam_branch_factor,
        beam_rounds=args.beam_rounds,
        beam_selection_pool=args.beam_selection_pool,
        beam_selection_window=args.beam_selection_window,
        mcts_iterations=args.mcts_iterations,
        mcts_exploration_weight=args.mcts_exploration_weight,
        mcts_rollout_top_k=args.mcts_rollout_top_k,
        mcts_rollout_samples=args.mcts_rollout_samples,
        mcts_prior_weight=args.mcts_prior_weight,
        mcts_loop_completion_bonus=args.mcts_loop_completion_bonus,
        mcts_loop_unused_penalty_per_m=args.mcts_loop_unused_penalty_per_m,
        mcts_loop_late_return_bonus=args.mcts_loop_late_return_bonus,
        mcts_loop_overlap_penalty_per_m=args.mcts_loop_overlap_penalty_per_m,
        keep_best=args.keep_best,
    )


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
    start_ref = resolve_junction_ref(junction_catalog, args.start_junction, graph.asset_id)
    end_ref = resolve_junction_ref(junction_catalog, args.end_junction, graph.asset_id)
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
    payload = route_asset_payload(
        graph_path=graph_ref_path,
        junctions_path=junctions_ref_path,
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
