#!/usr/bin/env python3

"""Export a precomputed debug route catalog and shared web graph payloads."""

from __future__ import annotations

import argparse
import hashlib
import json
import random
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from .build_config import (
    catalog_build_config_digest,
    load_catalog_build_config,
    normalize_catalog_build_config,
)
from .build_karura_contigs import build_contigs
from .download_karura_map import load_map
from .elevation import summarize_elevation_series
from .karura_common import (
    CATALOG_BUILD_JSON,
    CONTIGS_JSON,
    ELEVATION_JSON,
    PATCHED_MAP_JSON,
    JUNCTIONS_JSON,
    JUNCTION_BINDINGS_JSON,
    MAP_PATCHES_JSON,
    ROUTE_CATALOG_JSON,
    repo_rel,
    WEB_SOURCE_DIR,
    WEB_GENERATED_DIR,
    include_editor_way,
    load_required_patchset,
    sync_web_source_assets,
)
from .karura_routing import (
    PlannerConfig,
    RouteCandidate,
    build_route_node_ids,
    contig_jaccard_similarity,
    load_junction_bindings,
    load_junction_catalog,
    load_route_graph,
    plan_route_naive,
    plan_route_beam,
    plan_route_mcts,
    resolve_junction_ref,
)


DEFAULT_CATALOG_JSON = ROUTE_CATALOG_JSON
DEFAULT_NETWORK_GEOJSON = WEB_GENERATED_DIR / "karura-network.geojson"
DEFAULT_EDITOR_NETWORK_GEOJSON = WEB_GENERATED_DIR / "karura-editor-network.geojson"


@dataclass(frozen=True)
class RouteRecord:
    route_id: str
    scenario_id: str
    start_junction_id: str
    end_junction_id: str
    algorithm: str
    seed: int
    candidate_rank: int
    candidate: RouteCandidate
    route_node_ids: tuple[int, ...]
    family_signature: tuple[int, ...]
    direction_from_family: str
    coordinates: list[list[float]]
    bounds: list[float]
    contig_set: tuple[int, ...]
    quality_score: float


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    pre_parser = argparse.ArgumentParser(add_help=False)
    pre_parser.add_argument("--build-config-json", type=Path, default=CATALOG_BUILD_JSON)
    pre_args, remaining = pre_parser.parse_known_args(argv)
    build_defaults = load_catalog_build_config(pre_args.build_config_json)

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--build-config-json", type=Path, default=pre_args.build_config_json)
    parser.add_argument("--contigs-json", type=Path, default=CONTIGS_JSON)
    parser.add_argument("--junctions-json", type=Path, default=JUNCTIONS_JSON)
    parser.add_argument("--junction-bindings-json", type=Path, default=JUNCTION_BINDINGS_JSON)
    parser.add_argument("--algorithm", choices=("naive", "beam", "mcts"), action="append")
    parser.add_argument("--seed-start", type=int, default=build_defaults["seed_start"])
    parser.add_argument("--seed-end", type=int, default=build_defaults["seed_end"])
    parser.add_argument("--candidate-limit-per-run", type=int, default=build_defaults["candidate_limit_per_run"])
    parser.add_argument("--routes-per-scenario", type=int, default=build_defaults["routes_per_scenario"])
    parser.add_argument("--selection-window", type=int, default=build_defaults["selection_window"])
    parser.add_argument("--short-connector-max-length-m", type=float, default=build_defaults["short_connector_max_length_m"])
    parser.add_argument("--max-overlap-m", type=float, default=build_defaults["max_overlap_m"])
    parser.add_argument("--max-steps", type=int, default=build_defaults["max_steps"])
    parser.add_argument("--random-top-k", type=int, default=build_defaults["random_top_k"])
    parser.add_argument("--end-stop-probability", type=float, default=build_defaults["end_stop_probability"])
    parser.add_argument("--end-stop-unused-slack-m", type=float, default=build_defaults["end_stop_unused_slack_m"])
    parser.add_argument("--end-finish-unused-slack-m", type=float, default=build_defaults["end_finish_unused_slack_m"])
    parser.add_argument("--future-length-weight", type=float, default=build_defaults["future_length_weight"])
    parser.add_argument("--connector-length-weight", type=float, default=build_defaults["connector_length_weight"])
    parser.add_argument("--overlap-penalty-per-m", type=float, default=build_defaults["overlap_penalty_per_m"])
    parser.add_argument("--articulation-penalty", type=float, default=build_defaults["articulation_penalty"])
    parser.add_argument(
        "--articulation-future-threshold-m",
        type=float,
        default=build_defaults["articulation_future_threshold_m"],
    )
    parser.add_argument("--dead-end-penalty", type=float, default=build_defaults["dead_end_penalty"])
    parser.add_argument("--early-finish-penalty", type=float, default=build_defaults["early_finish_penalty"])
    parser.add_argument("--rollout-trials", type=int, default=build_defaults["rollout_trials"])
    parser.add_argument("--keep-best", type=int, default=build_defaults["keep_best"])
    parser.add_argument("--beam-width", type=int, default=build_defaults["beam_width"])
    parser.add_argument("--beam-branch-factor", type=int, default=build_defaults["beam_branch_factor"])
    parser.add_argument("--beam-rounds", type=int, default=build_defaults["beam_rounds"])
    parser.add_argument("--beam-selection-pool", type=int, default=build_defaults["beam_selection_pool"])
    parser.add_argument("--beam-selection-window", type=int, default=build_defaults["beam_selection_window"])
    parser.add_argument("--mcts-iterations", type=int, default=build_defaults["mcts_iterations"])
    parser.add_argument("--mcts-exploration-weight", type=float, default=build_defaults["mcts_exploration_weight"])
    parser.add_argument("--mcts-rollout-top-k", type=int, default=build_defaults["mcts_rollout_top_k"])
    parser.add_argument("--mcts-rollout-samples", type=int, default=build_defaults["mcts_rollout_samples"])
    parser.add_argument("--mcts-prior-weight", type=float, default=build_defaults["mcts_prior_weight"])
    parser.add_argument("--mcts-loop-completion-bonus", type=float, default=build_defaults["mcts_loop_completion_bonus"])
    parser.add_argument(
        "--mcts-loop-unused-penalty-per-m",
        type=float,
        default=build_defaults["mcts_loop_unused_penalty_per_m"],
    )
    parser.add_argument("--mcts-loop-late-return-bonus", type=float, default=build_defaults["mcts_loop_late_return_bonus"])
    parser.add_argument(
        "--mcts-loop-overlap-penalty-per-m",
        type=float,
        default=build_defaults["mcts_loop_overlap_penalty_per_m"],
    )
    parser.add_argument("--elevation-json", type=Path, default=ELEVATION_JSON)
    parser.add_argument(
        "--elevation-profile-spacing-m",
        type=float,
        default=build_defaults["elevation_profile_spacing_m"],
    )
    parser.add_argument(
        "--elevation-smoothing-window",
        type=int,
        default=build_defaults["elevation_smoothing_window"],
    )
    parser.add_argument("--elevation-min-step-m", type=float, default=build_defaults["elevation_min_step_m"])
    parser.add_argument("--editor-map-json", type=Path, default=PATCHED_MAP_JSON)
    parser.add_argument("--editor-patches-json", type=Path, default=MAP_PATCHES_JSON)
    parser.add_argument("--output-catalog", type=Path, default=DEFAULT_CATALOG_JSON)
    parser.add_argument("--output-network", type=Path, default=DEFAULT_NETWORK_GEOJSON)
    parser.add_argument("--output-editor-network", type=Path, default=DEFAULT_EDITOR_NETWORK_GEOJSON)
    args = parser.parse_args(remaining)
    args.algorithm = args.algorithm or list(build_defaults["algorithms"])
    return args


def build_config(args: argparse.Namespace) -> PlannerConfig:
    return PlannerConfig(
        short_connector_max_length_m=args.short_connector_max_length_m,
        max_overlap_m=args.max_overlap_m,
        max_steps=args.max_steps,
        random_top_k=args.random_top_k,
        end_stop_probability=args.end_stop_probability,
        end_stop_unused_slack_m=args.end_stop_unused_slack_m,
        end_finish_unused_slack_m=args.end_finish_unused_slack_m,
        future_length_weight=args.future_length_weight,
        connector_length_weight=args.connector_length_weight,
        overlap_penalty_per_m=args.overlap_penalty_per_m,
        articulation_penalty=args.articulation_penalty,
        articulation_future_threshold_m=args.articulation_future_threshold_m,
        dead_end_penalty=args.dead_end_penalty,
        early_finish_penalty=args.early_finish_penalty,
        rollout_trials=args.rollout_trials,
        keep_best=args.keep_best,
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
    )


def effective_build_config(args: argparse.Namespace) -> dict:
    return normalize_catalog_build_config(
        {
            "algorithms": list(args.algorithm),
            "seed_start": args.seed_start,
            "seed_end": args.seed_end,
            "candidate_limit_per_run": args.candidate_limit_per_run,
            "routes_per_scenario": args.routes_per_scenario,
            "selection_window": args.selection_window,
            "short_connector_max_length_m": args.short_connector_max_length_m,
            "max_overlap_m": args.max_overlap_m,
            "max_steps": args.max_steps,
            "random_top_k": args.random_top_k,
            "end_stop_probability": args.end_stop_probability,
            "end_stop_unused_slack_m": args.end_stop_unused_slack_m,
            "end_finish_unused_slack_m": args.end_finish_unused_slack_m,
            "future_length_weight": args.future_length_weight,
            "connector_length_weight": args.connector_length_weight,
            "overlap_penalty_per_m": args.overlap_penalty_per_m,
            "articulation_penalty": args.articulation_penalty,
            "articulation_future_threshold_m": args.articulation_future_threshold_m,
            "dead_end_penalty": args.dead_end_penalty,
            "early_finish_penalty": args.early_finish_penalty,
            "rollout_trials": args.rollout_trials,
            "keep_best": args.keep_best,
            "beam_width": args.beam_width,
            "beam_branch_factor": args.beam_branch_factor,
            "beam_rounds": args.beam_rounds,
            "beam_selection_pool": args.beam_selection_pool,
            "beam_selection_window": args.beam_selection_window,
            "mcts_iterations": args.mcts_iterations,
            "mcts_exploration_weight": args.mcts_exploration_weight,
            "mcts_rollout_top_k": args.mcts_rollout_top_k,
            "mcts_rollout_samples": args.mcts_rollout_samples,
            "mcts_prior_weight": args.mcts_prior_weight,
            "mcts_loop_completion_bonus": args.mcts_loop_completion_bonus,
            "mcts_loop_unused_penalty_per_m": args.mcts_loop_unused_penalty_per_m,
            "mcts_loop_late_return_bonus": args.mcts_loop_late_return_bonus,
            "mcts_loop_overlap_penalty_per_m": args.mcts_loop_overlap_penalty_per_m,
            "elevation_profile_spacing_m": args.elevation_profile_spacing_m,
            "elevation_smoothing_window": args.elevation_smoothing_window,
            "elevation_min_step_m": args.elevation_min_step_m,
        }
    )


def planner_for(name: str):
    if name == "naive":
        return plan_route_naive
    if name == "beam":
        return plan_route_beam
    if name == "mcts":
        return plan_route_mcts
    raise KeyError(name)


def route_coordinates(graph, candidate: RouteCandidate) -> list[list[float]]:
    node_ids = build_route_node_ids(graph, candidate.steps)
    coords: list[list[float]] = []
    for node_id in node_ids:
        node = graph.nodes[node_id]
        coords.append([round(node.lon, 6), round(node.lat, 6)])
    return coords


def bounds_for_coordinates(coordinates: list[list[float]]) -> list[float]:
    lons = [coord[0] for coord in coordinates]
    lats = [coord[1] for coord in coordinates]
    return [
        round(min(lons), 6),
        round(min(lats), 6),
        round(max(lons), 6),
        round(max(lats), 6),
    ]


def canonicalize_route_node_ids(node_ids: tuple[int, ...]) -> tuple[tuple[int, ...], str]:
    reversed_node_ids = tuple(reversed(node_ids))
    if reversed_node_ids < node_ids:
        return reversed_node_ids, "reverse"
    return node_ids, "forward"


def route_quality_score(candidate: RouteCandidate) -> float:
    return candidate.unique_length_m - 8.0 * candidate.overlap_length_m


def scenario_id_for(start_junction_id: str, end_junction_id: str) -> str:
    return f"{start_junction_id}__to__{end_junction_id}"


def route_id_for(
    start_junction_id: str,
    end_junction_id: str,
    algorithm: str,
    seed: int,
    candidate_rank: int,
) -> str:
    return f"karura-{start_junction_id}-to-{end_junction_id}-{algorithm}-seed{seed}-r{candidate_rank + 1}"


def family_id_for(signature: tuple[int, ...]) -> str:
    digest = hashlib.sha1(",".join(str(node_id) for node_id in signature).encode("utf-8")).hexdigest()
    return f"karura-route-family-{digest[:12]}"


def dedupe_records(records: list[RouteRecord]) -> list[RouteRecord]:
    unique: dict[tuple[int, ...], RouteRecord] = {}
    for record in sorted(records, key=lambda item: item.quality_score, reverse=True):
        signature = record.family_signature
        if signature not in unique:
            unique[signature] = record
    return list(unique.values())


def select_diverse_records(
    records: list[RouteRecord],
    *,
    routes_per_scenario: int,
    selection_window: int,
) -> list[RouteRecord]:
    if not records:
        return []

    ranked = sorted(records, key=lambda item: item.quality_score, reverse=True)
    window = ranked[: max(routes_per_scenario, selection_window)]
    selected = [window[0]]
    remaining = window[1:]

    best_quality = max(record.quality_score for record in window) or 1.0
    best_unique_length = max(record.candidate.unique_length_m for record in window) or 1.0

    while remaining and len(selected) < routes_per_scenario:
        best_index = 0
        best_score = float("-inf")
        for index, record in enumerate(remaining):
            min_diversity = min(
                1.0 - contig_jaccard_similarity(record.candidate, chosen.candidate)
                for chosen in selected
            )
            quality_ratio = record.quality_score / best_quality
            length_ratio = record.candidate.unique_length_m / best_unique_length
            overlap_ratio = record.candidate.overlap_length_m / max(1.0, record.candidate.total_length_m)
            score = 2.4 * min_diversity + 1.2 * quality_ratio + 0.6 * length_ratio - 0.8 * overlap_ratio
            if score > best_score:
                best_score = score
                best_index = index
        selected.append(remaining.pop(best_index))

    return sorted(selected, key=lambda item: item.quality_score, reverse=True)


def build_route_record(
    graph,
    *,
    start_junction_id: str,
    end_junction_id: str,
    algorithm: str,
    seed: int,
    candidate_rank: int,
    candidate: RouteCandidate,
) -> RouteRecord:
    route_node_ids_list = build_route_node_ids(graph, candidate.steps)
    route_node_ids = tuple(route_node_ids_list)
    family_signature, direction_from_family = canonicalize_route_node_ids(route_node_ids)
    coordinates = route_coordinates(graph, candidate)
    return RouteRecord(
        route_id=route_id_for(start_junction_id, end_junction_id, algorithm, seed, candidate_rank),
        scenario_id=scenario_id_for(start_junction_id, end_junction_id),
        start_junction_id=start_junction_id,
        end_junction_id=end_junction_id,
        algorithm=algorithm,
        seed=seed,
        candidate_rank=candidate_rank,
        candidate=candidate,
        route_node_ids=route_node_ids,
        family_signature=family_signature,
        direction_from_family=direction_from_family,
        coordinates=coordinates,
        bounds=bounds_for_coordinates(coordinates),
        contig_set=tuple(sorted(set(candidate.contig_id_sequence))),
        quality_score=round(route_quality_score(candidate), 3),
    )


def network_geojson(graph, *, meta: dict | None = None, node_elevations: dict[int, float] | None = None) -> dict:
    features = []
    if isinstance(graph, dict):
        nodes = {
            int(node_id): {
                "lat": float(node_payload["lat"]),
                "lon": float(node_payload["lon"]),
            }
            for node_id, node_payload in graph["nodes"].items()
        }
        contigs = graph["contigs"]
        for contig in contigs:
            coordinates = [
                [round(nodes[int(node_id)]["lon"], 6), round(nodes[int(node_id)]["lat"], 6)]
                for node_id in contig["node_ids"]
            ]
            elevations = None
            if node_elevations:
                try:
                    elevations = [round(float(node_elevations[int(node_id)]), 1) for node_id in contig["node_ids"]]
                except KeyError:
                    elevations = None
            features.append(
                {
                    "type": "Feature",
                    "properties": {
                        "contig_id": contig["id"],
                        "length_m": round(float(contig["length_m"]), 3),
                        "segment_count": int(contig["segment_count"]),
                        "way_names": list(contig["way_names"]),
                        "way_ids": list(contig["way_ids"]),
                        "endpoint_node_ids": list(contig["endpoint_node_ids"]),
                        "node_ids": list(contig["node_ids"]),
                        "tags": dict(contig.get("tags", {})),
                        **({"elevations_m": elevations} if elevations is not None else {}),
                    },
                    "geometry": {
                        "type": "LineString",
                        "coordinates": coordinates,
                    },
                }
            )
        return {"type": "FeatureCollection", "meta": meta or {}, "features": features}

    for contig in graph.contigs.values():
        coordinates = [
            [round(graph.nodes[node_id].lon, 6), round(graph.nodes[node_id].lat, 6)]
            for node_id in contig.node_ids
        ]
        elevations = None
        if node_elevations:
            try:
                elevations = [round(float(node_elevations[node_id]), 1) for node_id in contig.node_ids]
            except KeyError:
                elevations = None
        features.append(
            {
                "type": "Feature",
                "properties": {
                    "contig_id": contig.id,
                    "length_m": round(contig.length_m, 3),
                    "segment_count": contig.segment_count,
                    "way_names": list(contig.way_names),
                    "way_ids": list(contig.way_ids),
                    "endpoint_node_ids": list(contig.endpoint_node_ids),
                    "node_ids": list(contig.node_ids),
                    "tags": dict(contig.tags),
                    **({"elevations_m": elevations} if elevations is not None else {}),
                },
                "geometry": {
                    "type": "LineString",
                    "coordinates": coordinates,
                },
            }
        )
    return {"type": "FeatureCollection", "meta": meta or {}, "features": features}


def load_patch_snapshot(path: Path) -> dict:
    return load_required_patchset(path, label="patchset file")


def build_editor_graph_payload_from_map(*, editor_map_payload: dict, editor_map_json: Path, editor_patches_json: Path) -> tuple[dict, dict]:
    patch_snapshot = load_patch_snapshot(editor_patches_json)
    editor_graph_payload = build_contigs(
        editor_map_payload,
        source_map=repo_rel(editor_map_json),
        patchset=patch_snapshot,
        patchset_path=repo_rel(editor_patches_json),
        include_way=include_editor_way,
        graph_mode="editor",
    )
    editor_network = network_geojson(
        editor_graph_payload,
        meta={
            "graph_asset_id": editor_graph_payload["meta"]["asset_id"],
            "graph_mode": editor_graph_payload["meta"]["graph_mode"],
            "source_map_asset_id": editor_graph_payload["meta"]["source_asset_id"],
            "patchset_id": editor_graph_payload["meta"].get("patchset_id"),
        },
    )
    return editor_graph_payload, editor_network


def build_editor_graph_payload(*, editor_map_json: Path, editor_patches_json: Path) -> tuple[dict, dict]:
    editor_map = load_map(editor_map_json)
    return build_editor_graph_payload_from_map(
        editor_map_payload=editor_map.to_dict(),
        editor_map_json=editor_map_json,
        editor_patches_json=editor_patches_json,
    )


def load_elevation_asset(path: Path | None, *, expected_graph_asset_id: str | None = None) -> tuple[dict[int, float], bool]:
    if path is None or not path.exists():
        return {}, False
    payload = json.loads(path.read_text())
    payload_graph_asset_id = payload.get("meta", {}).get("graph_asset_id")
    if expected_graph_asset_id is not None and payload_graph_asset_id != expected_graph_asset_id:
        return {}, False
    node_elevations: dict[int, float] = {}
    for node_id, node_payload in payload.get("nodes", {}).items():
        elevation = node_payload.get("elevation_m")
        if elevation is None:
            continue
        node_elevations[int(node_id)] = float(elevation)
    return node_elevations, True


def elevation_payload_for_route(
    args: argparse.Namespace,
    node_elevations: dict[int, float],
    route_node_ids: list[int],
    coordinates: list[list[float]],
) -> dict:
    if not node_elevations:
        return {}
    elevations = [node_elevations.get(node_id) for node_id in route_node_ids]
    if any(elevation is None for elevation in elevations):
        return {}
    return summarize_elevation_series(
        coordinates,
        [float(elevation) for elevation in elevations],
        profile_spacing_m=args.elevation_profile_spacing_m,
        smoothing_window=args.elevation_smoothing_window,
        min_step_m=args.elevation_min_step_m,
    )


def area_bounds(graph) -> list[float]:
    lons = [node.lon for node in graph.nodes.values()]
    lats = [node.lat for node in graph.nodes.values()]
    return [
        round(min(lons), 6),
        round(min(lats), 6),
        round(max(lons), 6),
        round(max(lats), 6),
    ]


def canonical_coordinates(record: RouteRecord) -> list[list[float]]:
    if record.direction_from_family == "forward":
        return record.coordinates
    return list(reversed(record.coordinates))


def build_route_family_payload(
    *,
    family_id: str,
    record: RouteRecord,
    args: argparse.Namespace,
    node_elevations: dict[int, float],
) -> dict:
    coordinates = canonical_coordinates(record)
    route_node_ids = list(record.family_signature)
    return {
        "id": family_id,
        "quality_score": record.quality_score,
        "complete": record.candidate.complete,
        "score": round(record.candidate.score, 3),
        "unique_length_m": round(record.candidate.unique_length_m, 3),
        "overlap_length_m": round(record.candidate.overlap_length_m, 3),
        "total_length_m": round(record.candidate.total_length_m, 3),
        "step_count": len(record.candidate.steps),
        "repeated_contig_ids": list(record.candidate.repeated_contig_ids),
        "bounds": record.bounds,
        "coordinates": coordinates,
        **elevation_payload_for_route(
            args,
            node_elevations,
            route_node_ids,
            coordinates,
        ),
    }


def write_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2) + "\n")


def plan_catalog_records(args: argparse.Namespace) -> dict[str, object]:
    algorithms = list(args.algorithm)
    build_config_payload = effective_build_config(args)
    config = build_config(args)
    graph = load_route_graph(args.contigs_json)
    node_elevations, elevation_matches_graph = load_elevation_asset(
        args.elevation_json,
        expected_graph_asset_id=graph.asset_id,
    )
    editor_graph_payload, editor_network = build_editor_graph_payload(
        editor_map_json=args.editor_map_json,
        editor_patches_json=args.editor_patches_json,
    )
    junction_catalog = load_junction_catalog(args.junctions_json)
    junction_bindings = load_junction_bindings(args.junction_bindings_json)
    junction_defs = junction_catalog["junctions"]
    junction_ids = [junction["id"] for junction in junction_defs]
    junction_refs = {
        junction_id: resolve_junction_ref(junction_catalog, junction_id, graph.asset_id, junction_bindings)
        for junction_id in junction_ids
    }

    scenario_records: dict[str, list[RouteRecord]] = defaultdict(list)

    for start_junction_id in junction_ids:
        for end_junction_id in junction_ids:
            start_ref = junction_refs[start_junction_id]
            end_ref = junction_refs[end_junction_id]
            scenario_id = scenario_id_for(start_junction_id, end_junction_id)
            for algorithm in algorithms:
                planner = planner_for(algorithm)
                for seed in range(args.seed_start, args.seed_end + 1):
                    candidates = planner(
                        graph,
                        start_node_id=start_ref.graph_node_id,
                        end_node_id=end_ref.graph_node_id,
                        config=config,
                        rng=random.Random(seed),
                    )
                    for candidate_rank, candidate in enumerate(candidates[: args.candidate_limit_per_run]):
                        if not candidate.complete:
                            continue
                        scenario_records[scenario_id].append(
                            build_route_record(
                                graph,
                                start_junction_id=start_junction_id,
                                end_junction_id=end_junction_id,
                                algorithm=algorithm,
                                seed=seed,
                                candidate_rank=candidate_rank,
                                candidate=candidate,
                            )
                        )

    selected_records_by_scenario: dict[str, list[RouteRecord]] = {}
    for start_junction_id in junction_ids:
        for end_junction_id in junction_ids:
            scenario_id = scenario_id_for(start_junction_id, end_junction_id)
            deduped = dedupe_records(scenario_records[scenario_id])
            selected = select_diverse_records(
                deduped,
                routes_per_scenario=args.routes_per_scenario,
                selection_window=args.selection_window,
            )
            selected_records_by_scenario[scenario_id] = selected

    return {
        "algorithms": algorithms,
        "build_config_payload": build_config_payload,
        "graph": graph,
        "node_elevations": node_elevations,
        "elevation_matches_graph": elevation_matches_graph,
        "editor_graph_payload": editor_graph_payload,
        "editor_network": editor_network,
        "junction_catalog": junction_catalog,
        "junction_bindings": junction_bindings,
        "junction_defs": junction_defs,
        "selected_records_by_scenario": selected_records_by_scenario,
    }


def build_export_payloads(args: argparse.Namespace) -> dict[str, dict]:
    planned = plan_catalog_records(args)
    algorithms = planned["algorithms"]
    build_config_payload = planned["build_config_payload"]
    build_config_digest = catalog_build_config_digest(build_config_payload)
    graph = planned["graph"]
    node_elevations = planned["node_elevations"]
    elevation_matches_graph = planned["elevation_matches_graph"]
    editor_network = planned["editor_network"]
    junction_catalog = planned["junction_catalog"]
    junction_bindings = planned["junction_bindings"]
    junction_defs = planned["junction_defs"]
    junction_ids = [junction["id"] for junction in junction_defs]
    selected_records_by_scenario = planned["selected_records_by_scenario"]

    representative_by_family: dict[tuple[int, ...], RouteRecord] = {}
    for records in selected_records_by_scenario.values():
        for record in records:
            existing = representative_by_family.get(record.family_signature)
            if existing is None or record.quality_score > existing.quality_score:
                representative_by_family[record.family_signature] = record

    family_id_by_signature = {
        signature: family_id_for(signature)
        for signature in representative_by_family
    }

    route_families = [
        build_route_family_payload(
            family_id=family_id_by_signature[signature],
            record=representative_by_family[signature],
            args=args,
            node_elevations=node_elevations,
        )
        for signature in sorted(representative_by_family)
    ]

    catalog_scenarios = []
    for start_junction_id in junction_ids:
        for end_junction_id in junction_ids:
            scenario_id = scenario_id_for(start_junction_id, end_junction_id)
            selected = selected_records_by_scenario[scenario_id]
            catalog_scenarios.append(
                {
                    "id": scenario_id,
                    "start_junction_id": start_junction_id,
                    "end_junction_id": end_junction_id,
                    "is_loop": start_junction_id == end_junction_id,
                    "route_count": len(selected),
                    "routes": [
                        {
                            "id": record.route_id,
                            "family_id": family_id_by_signature[record.family_signature],
                            "direction": record.direction_from_family,
                            "algorithm": record.algorithm,
                            "seed": record.seed,
                            "candidate_rank": record.candidate_rank,
                            "quality_score": record.quality_score,
                        }
                        for record in selected
                    ],
                }
            )

    catalog_payload = {
        "meta": {
            "generated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "graph_asset_id": graph.asset_id,
            "junction_catalog_asset_id": junction_catalog["meta"]["asset_id"],
            "junction_bindings_asset_id": junction_bindings["meta"]["asset_id"],
            "algorithms": algorithms,
            "seed_start": args.seed_start,
            "seed_end": args.seed_end,
            "candidate_limit_per_run": args.candidate_limit_per_run,
            "routes_per_scenario": args.routes_per_scenario,
            "route_family_count": len(route_families),
            "build_config_path": repo_rel(args.build_config_json),
            "build_config_digest": build_config_digest,
            "build_config": build_config_payload,
            "elevation_asset_path": repo_rel(args.elevation_json) if args.elevation_json and args.elevation_json.exists() else None,
            "elevation_asset_matches_graph": elevation_matches_graph,
        },
        "areas": [
            {
                "id": "karura",
                "name": "Karura Forest",
                "bounds": area_bounds(graph),
                "network_path": args.output_network.name,
                "junctions": [
                    {
                        "id": junction["id"],
                        "name": junction["name"],
                        "lat": round(float(junction["location"]["lat"]), 6),
                        "lon": round(float(junction["location"]["lon"]), 6),
                        "tags": junction.get("tags", []),
                    }
                    for junction in junction_defs
                ],
                "route_families": route_families,
                "scenarios": catalog_scenarios,
            }
        ],
    }

    route_network = network_geojson(
        graph,
        meta={
            "graph_asset_id": graph.asset_id,
            "asset_kind": graph.asset_kind,
            "source_path": repo_rel(args.contigs_json),
        },
        node_elevations=node_elevations if elevation_matches_graph else None,
    )
    return {
        "catalog": catalog_payload,
        "network": route_network,
        "editor_network": editor_network,
    }


def export_catalog(args: argparse.Namespace) -> dict[str, dict]:
    sync_web_source_assets()
    payloads = build_export_payloads(args)
    write_json(args.output_catalog, payloads["catalog"])
    write_json(args.output_network, payloads["network"])
    write_json(args.output_editor_network, payloads["editor_network"])
    return payloads


def main() -> None:
    args = parse_args()
    payloads = export_catalog(args)
    print(
        json.dumps(
            {
                "catalog": str(args.output_catalog),
                "network": str(args.output_network),
                "editor_network": str(args.output_editor_network),
                "published_sources": [str(path) for path in sorted(WEB_SOURCE_DIR.glob("*.json"))],
                "area_count": len(payloads["catalog"]["areas"]),
                "scenario_count": len(payloads["catalog"]["areas"][0]["scenarios"]),
                "route_count": sum(scenario["route_count"] for scenario in payloads["catalog"]["areas"][0]["scenarios"]),
                "route_family_count": len(payloads["catalog"]["areas"][0]["route_families"]),
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
