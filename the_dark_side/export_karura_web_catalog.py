#!/usr/bin/env python3

"""Debug/oracle tool: export a precomputed route catalog."""

from __future__ import annotations

import argparse
import hashlib
import json
import random
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path

from .build_config import (
    DEBUG_CATALOG_KEYS,
    PLANNER_KEYS,
    add_debug_catalog_args,
    add_planner_config_args,
    catalog_build_config_digest,
    catalog_build_kwargs_from_namespace,
    normalize_catalog_build_config,
    planner_config_kwargs_from_namespace,
    resolve_build_config_defaults,
)
from .elevation import summarize_elevation_series
from .karura_common import (
    CATALOG_BUILD_JSON,
    CONTIGS_JSON,
    ELEVATION_JSON,
    JUNCTIONS_JSON,
    JUNCTION_BINDINGS_JSON,
    ROUTE_CATALOG_JSON,
    repo_rel,
    utc_now_z,
)
from .karura_routing import (
    PlannerConfig,
    PLANNER_NAMES,
    RouteCandidate,
    build_route_node_ids,
    contig_jaccard_similarity,
    load_junction_bindings,
    load_junction_catalog,
    load_route_graph,
    planner_for,
    resolve_junction_ref,
)
from .web_assets import (
    load_elevation_asset,
    write_json,
)


DEFAULT_CATALOG_JSON = ROUTE_CATALOG_JSON


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
    build_config_json, build_defaults, remaining = resolve_build_config_defaults(
        argv,
        default_path=CATALOG_BUILD_JSON,
    )

    parser = argparse.ArgumentParser(
        description=__doc__,
        epilog="Offline/debug tool only. The published app composes routes in the browser and does not consume this catalog.",
    )
    parser.add_argument("--build-config-json", type=Path, default=build_config_json)
    parser.add_argument("--contigs-json", type=Path, default=CONTIGS_JSON)
    parser.add_argument("--junctions-json", type=Path, default=JUNCTIONS_JSON)
    parser.add_argument("--junction-bindings-json", type=Path, default=JUNCTION_BINDINGS_JSON)
    parser.add_argument("--algorithm", choices=PLANNER_NAMES, action="append")
    add_debug_catalog_args(parser, build_defaults)
    add_planner_config_args(parser, build_defaults)
    parser.add_argument("--elevation-json", type=Path, default=ELEVATION_JSON)
    parser.add_argument(
        "--elevation-smoothing-window",
        type=int,
        default=build_defaults["elevation_smoothing_window"],
    )
    parser.add_argument("--elevation-min-step-m", type=float, default=build_defaults["elevation_min_step_m"])
    parser.add_argument("--output-catalog", type=Path, default=DEFAULT_CATALOG_JSON)
    args = parser.parse_args(remaining)
    args.algorithm = args.algorithm or list(build_defaults["algorithms"])
    return args


def build_config(args: argparse.Namespace) -> PlannerConfig:
    return PlannerConfig(**planner_config_kwargs_from_namespace(args))


def effective_build_config(args: argparse.Namespace) -> dict:
    payload = catalog_build_kwargs_from_namespace(
        args,
        keys=tuple(key for key in DEBUG_CATALOG_KEYS + PLANNER_KEYS if key != "algorithms"),
    )
    payload["algorithms"] = list(args.algorithm)
    return normalize_catalog_build_config(payload)
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


def plan_catalog_records(args: argparse.Namespace) -> dict[str, object]:
    algorithms = list(args.algorithm)
    build_config_payload = effective_build_config(args)
    config = build_config(args)
    graph = load_route_graph(args.contigs_json)
    node_elevations, elevation_matches_graph = load_elevation_asset(
        args.elevation_json,
        expected_graph_asset_id=graph.asset_id,
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
        "junction_catalog": junction_catalog,
        "junction_bindings": junction_bindings,
        "junction_defs": junction_defs,
        "selected_records_by_scenario": selected_records_by_scenario,
    }


def build_catalog_payload(args: argparse.Namespace) -> dict:
    planned = plan_catalog_records(args)
    algorithms = planned["algorithms"]
    build_config_payload = planned["build_config_payload"]
    build_config_digest = catalog_build_config_digest(build_config_payload)
    graph = planned["graph"]
    node_elevations = planned["node_elevations"]
    elevation_matches_graph = planned["elevation_matches_graph"]
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
            "generated_at": utc_now_z(),
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
            "area_id": "karura",
            "area_name": "Karura Forest",
            "bounds": area_bounds(graph),
        },
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

    return catalog_payload


def export_catalog(args: argparse.Namespace) -> dict:
    payload = build_catalog_payload(args)
    write_json(args.output_catalog, payload)
    return payload


def main() -> None:
    args = parse_args()
    payload = export_catalog(args)
    print(
        json.dumps(
            {
                "catalog": str(args.output_catalog),
                "area_count": 1,
                "scenario_count": len(payload["scenarios"]),
                "route_count": sum(scenario["route_count"] for scenario in payload["scenarios"]),
                "route_family_count": len(payload["route_families"]),
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
