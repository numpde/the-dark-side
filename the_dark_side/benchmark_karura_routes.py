#!/usr/bin/env python3

"""Benchmark Karura route planners across scenarios and seeds."""

from __future__ import annotations

import argparse
import json
import statistics
import time
from dataclasses import asdict
from pathlib import Path
import random

from .build_config import add_planner_config_args, load_catalog_build_config, planner_config_kwargs_from_namespace
from .karura_common import BENCHMARKS_DIR, CATALOG_BUILD_JSON, CONTIGS_JSON, JUNCTION_BINDINGS_JSON, JUNCTIONS_JSON
from .karura_routing import (
    PlannerConfig,
    RouteCandidate,
    load_junction_bindings,
    load_junction_catalog,
    load_route_graph,
    plan_route_beam,
    plan_route_mcts,
    plan_route_naive,
    resolve_junction_ref,
    write_json,
)


SCENARIOS = {
    "open": ("family_trail_west", "kiambu_side_exit"),
    "loop_family": ("family_trail_west", "family_trail_west"),
    "loop_kiambu": ("kiambu_side_exit", "kiambu_side_exit"),
}
ALGORITHMS = ("naive", "beam", "mcts")


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    pre_parser = argparse.ArgumentParser(add_help=False)
    pre_parser.add_argument("--build-config-json", type=Path, default=CATALOG_BUILD_JSON)
    pre_args, remaining = pre_parser.parse_known_args(argv)
    planner_defaults = load_catalog_build_config(pre_args.build_config_json)

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--build-config-json", type=Path, default=pre_args.build_config_json)
    parser.add_argument("--contigs-json", type=Path, default=CONTIGS_JSON)
    parser.add_argument("--junctions-json", type=Path, default=JUNCTIONS_JSON)
    parser.add_argument("--junction-bindings-json", type=Path, default=JUNCTION_BINDINGS_JSON)
    parser.add_argument("--scenario", choices=tuple(SCENARIOS), action="append")
    parser.add_argument("--algorithm", choices=ALGORITHMS, action="append")
    parser.add_argument("--seed-start", type=int, default=1)
    parser.add_argument("--seed-end", type=int, default=10)
    add_planner_config_args(parser, planner_defaults)
    parser.add_argument("--output-json", type=Path)
    parser.add_argument("--output-md", type=Path)
    return parser.parse_args(remaining)


def build_config(args: argparse.Namespace) -> PlannerConfig:
    return PlannerConfig(**planner_config_kwargs_from_namespace(args))


def planner_for(name: str):
    if name == "naive":
        return plan_route_naive
    if name == "beam":
        return plan_route_beam
    if name == "mcts":
        return plan_route_mcts
    raise KeyError(name)


def median(values: list[float]) -> float:
    return float(statistics.median(values)) if values else 0.0


def mean(values: list[float]) -> float:
    return float(statistics.fmean(values)) if values else 0.0


def jaccard(a: set[int], b: set[int]) -> float:
    union = a | b
    if not union:
        return 1.0
    return len(a & b) / len(union)


def summarize_pairwise_jaccard(contig_sets: list[set[int]]) -> dict[str, float | int]:
    values: list[float] = []
    for index, first in enumerate(contig_sets):
        for second in contig_sets[index + 1 :]:
            values.append(jaccard(first, second))
    if not values:
        return {"count": 0, "min": 0.0, "median": 0.0, "max": 0.0, "mean": 0.0}
    return {
        "count": len(values),
        "min": round(min(values), 3),
        "median": round(median(values), 3),
        "max": round(max(values), 3),
        "mean": round(mean(values), 3),
    }


def route_row(seed: int, elapsed_s: float, candidate: RouteCandidate) -> dict:
    total_length_m = candidate.total_length_m or 1.0
    sequence = list(candidate.contig_id_sequence)
    return {
        "seed": seed,
        "runtime_s": round(elapsed_s, 6),
        "complete": candidate.complete,
        "unique_length_m": round(candidate.unique_length_m, 3),
        "overlap_length_m": round(candidate.overlap_length_m, 3),
        "overlap_ratio": round(candidate.overlap_length_m / total_length_m, 6),
        "total_length_m": round(candidate.total_length_m, 3),
        "step_count": len(candidate.steps),
        "repeated_contig_count": len(candidate.repeated_contig_ids),
        "coverage_score": round(candidate.unique_length_m - 10.0 * candidate.overlap_length_m, 3),
        "contig_sequence": sequence,
        "contig_set": sorted(set(sequence)),
    }


def summarize_rows(rows: list[dict]) -> dict:
    unique_lengths = [row["unique_length_m"] for row in rows]
    overlaps = [row["overlap_length_m"] for row in rows]
    overlap_ratios = [row["overlap_ratio"] for row in rows]
    runtimes = [row["runtime_s"] for row in rows]
    coverage_scores = [row["coverage_score"] for row in rows]
    complete_count = sum(1 for row in rows if row["complete"])
    exact_routes = {tuple(row["contig_sequence"]) for row in rows}
    contig_sets = {tuple(row["contig_set"]) for row in rows}
    pairwise = summarize_pairwise_jaccard([set(row["contig_set"]) for row in rows])
    return {
        "seed_count": len(rows),
        "complete_count": complete_count,
        "completion_rate": round(complete_count / len(rows), 3) if rows else 0.0,
        "best_unique_length_m": round(max(unique_lengths), 3) if rows else 0.0,
        "mean_unique_length_m": round(mean(unique_lengths), 3),
        "median_unique_length_m": round(median(unique_lengths), 3),
        "mean_overlap_length_m": round(mean(overlaps), 3),
        "median_overlap_length_m": round(median(overlaps), 3),
        "median_overlap_ratio": round(median(overlap_ratios), 6),
        "best_coverage_score": round(max(coverage_scores), 3) if rows else 0.0,
        "median_coverage_score": round(median(coverage_scores), 3),
        "distinct_top_route_count": len(exact_routes),
        "distinct_contig_set_count": len(contig_sets),
        "pairwise_jaccard": pairwise,
        "runtime_s": {
            "total": round(sum(runtimes), 6),
            "mean": round(mean(runtimes), 6),
            "median": round(median(runtimes), 6),
            "max": round(max(runtimes), 6) if rows else 0.0,
        },
    }


def markdown_report(payload: dict) -> str:
    lines = [
        "# Karura Route Benchmark",
        "",
        f"- Graph asset: `{payload['meta']['graph_asset_id']}`",
        f"- Junction catalog asset: `{payload['meta']['junction_catalog_asset_id']}`",
        f"- Seeds: `{payload['meta']['seed_start']}..{payload['meta']['seed_end']}`",
        "",
    ]
    for scenario_name, scenario_payload in payload["results"].items():
        lines.extend(
            [
                f"## {scenario_name}",
                "",
                "| algorithm | best unique km | median unique km | median overlap m | completion | distinct routes | median jaccard | mean runtime s |",
                "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
            ]
        )
        for algorithm_name, result in scenario_payload["algorithms"].items():
            summary = result["summary"]
            lines.append(
                "| "
                + " | ".join(
                    [
                        algorithm_name,
                        f"{summary['best_unique_length_m'] / 1000:.2f}",
                        f"{summary['median_unique_length_m'] / 1000:.2f}",
                        f"{summary['median_overlap_length_m']:.1f}",
                        f"{summary['completion_rate']:.2f}",
                        str(summary["distinct_top_route_count"]),
                        f"{summary['pairwise_jaccard']['median']:.3f}",
                        f"{summary['runtime_s']['mean']:.3f}",
                    ]
                )
                + " |"
            )
        lines.append("")
    return "\n".join(lines) + "\n"


def default_outputs() -> tuple[Path, Path]:
    return (
        BENCHMARKS_DIR / "karura-route-benchmark.json",
        BENCHMARKS_DIR / "karura-route-benchmark.md",
    )


def main() -> None:
    args = parse_args()
    config = build_config(args)
    scenarios = args.scenario or list(SCENARIOS)
    algorithms = args.algorithm or list(ALGORITHMS)
    seeds = list(range(args.seed_start, args.seed_end + 1))
    graph = load_route_graph(args.contigs_json)
    junction_catalog = load_junction_catalog(args.junctions_json)
    junction_bindings = load_junction_bindings(args.junction_bindings_json)

    results: dict[str, dict] = {}
    for scenario_name in scenarios:
        start_junction, end_junction = SCENARIOS[scenario_name]
        start_ref = resolve_junction_ref(junction_catalog, start_junction, graph.asset_id, junction_bindings)
        end_ref = resolve_junction_ref(junction_catalog, end_junction, graph.asset_id, junction_bindings)
        scenario_result = {
            "start_junction_id": start_junction,
            "end_junction_id": end_junction,
            "algorithms": {},
        }
        for algorithm_name in algorithms:
            planner = planner_for(algorithm_name)
            rows: list[dict] = []
            for seed in seeds:
                rng = random.Random(seed)
                started = time.perf_counter()
                candidates = planner(
                    graph,
                    start_node_id=start_ref.graph_node_id,
                    end_node_id=end_ref.graph_node_id,
                    config=config,
                    rng=rng,
                )
                elapsed = time.perf_counter() - started
                if not candidates:
                    raise RuntimeError(f"{algorithm_name} returned no route candidates for {scenario_name} seed {seed}")
                rows.append(route_row(seed, elapsed, candidates[0]))
            scenario_result["algorithms"][algorithm_name] = {
                "summary": summarize_rows(rows),
                "rows": rows,
            }
        results[scenario_name] = scenario_result

    json_output, md_output = default_outputs()
    if args.output_json:
        json_output = args.output_json
    if args.output_md:
        md_output = args.output_md

    payload = {
        "meta": {
            "graph_asset_id": graph.asset_id,
            "junction_catalog_asset_id": junction_catalog["meta"]["asset_id"],
            "seed_start": args.seed_start,
            "seed_end": args.seed_end,
            "algorithms": algorithms,
            "scenarios": scenarios,
        },
        "config": asdict(config),
        "results": results,
    }
    write_json(json_output, payload)
    md_output.parent.mkdir(parents=True, exist_ok=True)
    md_output.write_text(markdown_report(payload))

    print(
        json.dumps(
            {
                "output_json": str(json_output),
                "output_md": str(md_output),
                "algorithms": algorithms,
                "scenarios": scenarios,
                "seed_count": len(seeds),
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
