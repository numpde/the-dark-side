"""Shared loaders and route planners for the Karura contig graph."""

from __future__ import annotations

import json
import math
import random
from collections import defaultdict, deque
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from heapq import heappop, heappush
from pathlib import Path
from typing import Iterable


@dataclass(frozen=True)
class NodeRecord:
    id: int
    lat: float
    lon: float
    degree: int


@dataclass(frozen=True)
class ContigRecord:
    id: int
    endpoint_node_ids: tuple[int, int]
    node_ids: tuple[int, ...]
    length_m: float
    is_cycle: bool
    segment_count: int
    way_ids: tuple[int, ...]
    way_names: tuple[str, ...]
    highway_types: dict[str, int]


@dataclass(frozen=True)
class JunctionRef:
    junction_id: str
    name: str
    graph_node_id: int
    incident_contig_ids: tuple[int, ...]
    location: dict[str, float]
    notes: str
    tags: tuple[str, ...]


@dataclass(frozen=True)
class RouteStep:
    contig_id: int
    from_node_id: int
    to_node_id: int
    reused: bool
    length_m: float


@dataclass
class RouteCandidate:
    algorithm: str
    complete: bool
    score: float
    total_length_m: float
    unique_length_m: float
    overlap_length_m: float
    terminal_node_id: int
    steps: tuple[RouteStep, ...]

    @property
    def contig_id_sequence(self) -> tuple[int, ...]:
        return tuple(step.contig_id for step in self.steps)

    @property
    def repeated_contig_ids(self) -> tuple[int, ...]:
        seen: set[int] = set()
        repeated: list[int] = []
        for contig_id in self.contig_id_sequence:
            if contig_id in seen and contig_id not in repeated:
                repeated.append(contig_id)
            seen.add(contig_id)
        return tuple(repeated)


@dataclass
class RouteGraph:
    asset_id: str
    asset_kind: str
    source_path: Path
    nodes: dict[int, NodeRecord]
    contigs: dict[int, ContigRecord]
    adjacency: dict[int, list[tuple[int, int]]]
    articulation_points: set[int]


@dataclass(frozen=True)
class PlannerConfig:
    short_connector_max_length_m: float = 35.0
    max_overlap_m: float = 70.0
    max_steps: int = 256
    random_top_k: int = 4
    end_stop_probability: float = 0.7
    end_stop_unused_slack_m: float = 400.0
    end_finish_unused_slack_m: float = 250.0
    future_length_weight: float = 0.08
    connector_length_weight: float = 0.02
    overlap_penalty_per_m: float = 12.0
    articulation_penalty: float = 45.0
    articulation_future_threshold_m: float = 400.0
    dead_end_penalty: float = 180.0
    early_finish_penalty: float = 320.0
    rollout_trials: int = 250
    keep_best: int = 5
    beam_width: int = 80
    beam_branch_factor: int = 5
    beam_rounds: int = 200
    beam_selection_pool: int = 5
    beam_selection_window: int = 12
    mcts_iterations: int = 640
    mcts_exploration_weight: float = 1.0
    mcts_rollout_top_k: int = 3
    mcts_rollout_samples: int = 3
    mcts_prior_weight: float = 0.5
    mcts_loop_completion_bonus: float = 220.0
    mcts_loop_unused_penalty_per_m: float = 0.045
    mcts_loop_late_return_bonus: float = 180.0
    mcts_loop_overlap_penalty_per_m: float = 4.0


@dataclass
class RouteState:
    current_node_id: int
    steps: tuple[RouteStep, ...]
    contig_visits: dict[int, int]
    total_length_m: float
    unique_length_m: float
    overlap_length_m: float

    @property
    def last_contig_id(self) -> int | None:
        return self.steps[-1].contig_id if self.steps else None


@dataclass(frozen=True)
class ConnectorPlan:
    reachable: bool
    overlap_length_m: float
    total_length_m: float
    steps: tuple[RouteStep, ...]


@dataclass(frozen=True)
class MoveCandidate:
    step: RouteStep
    score: float
    future_unused_length_m: float
    connector_plan: ConnectorPlan


@dataclass
class MctsTreeNode:
    state: RouteState
    parent: "MctsTreeNode | None" = None
    move: MoveCandidate | None = None
    visits: int = 0
    reward_sum: float = 0.0
    children: list["MctsTreeNode"] = field(default_factory=list)
    unexpanded_moves: list[MoveCandidate] | None = None


def load_payload(path: Path) -> dict:
    return json.loads(path.read_text())


def asset_index(payload: dict) -> dict[str, dict]:
    return {asset["id"]: asset for asset in payload.get("assets", [])}


def load_route_graph(path: Path) -> RouteGraph:
    payload = load_payload(path)
    crossings = {int(node_id): node for node_id, node in payload.get("crossings", {}).items()}
    nodes: dict[int, NodeRecord] = {}
    for node_id_text, node_payload in payload["nodes"].items():
        node_id = int(node_id_text)
        crossing = crossings.get(node_id)
        nodes[node_id] = NodeRecord(
            id=node_id,
            lat=float(node_payload["lat"]),
            lon=float(node_payload["lon"]),
            degree=int(crossing["degree"]) if crossing else 0,
        )

    contigs: dict[int, ContigRecord] = {}
    adjacency: dict[int, list[tuple[int, int]]] = defaultdict(list)
    for contig_payload in payload["contigs"]:
        contig = ContigRecord(
            id=int(contig_payload["id"]),
            endpoint_node_ids=tuple(int(node_id) for node_id in contig_payload["endpoint_node_ids"]),
            node_ids=tuple(int(node_id) for node_id in contig_payload["node_ids"]),
            length_m=float(contig_payload["length_m"]),
            is_cycle=bool(contig_payload["is_cycle"]),
            segment_count=int(contig_payload["segment_count"]),
            way_ids=tuple(int(way_id) for way_id in contig_payload["way_ids"]),
            way_names=tuple(contig_payload["way_names"]),
            highway_types={str(key): int(value) for key, value in contig_payload["highway_types"].items()},
        )
        contigs[contig.id] = contig

        first_node, second_node = contig.endpoint_node_ids
        adjacency[first_node].append((contig.id, second_node))
        if first_node != second_node:
            adjacency[second_node].append((contig.id, first_node))

    update_node_degrees(nodes, adjacency)
    articulation_points = find_articulation_points(adjacency)
    return RouteGraph(
        asset_id=payload["meta"]["asset_id"],
        asset_kind=payload["meta"]["asset_kind"],
        source_path=path,
        nodes=nodes,
        contigs=contigs,
        adjacency=dict(adjacency),
        articulation_points=articulation_points,
    )


def load_junction_catalog(path: Path) -> dict:
    return load_payload(path)


def resolve_junction_ref(payload: dict, junction_id: str, graph_asset_id: str) -> JunctionRef:
    for junction in payload.get("junctions", []):
        if junction["id"] != junction_id:
            continue
        for ref in junction.get("asset_refs", []):
            if ref.get("asset_id") == graph_asset_id:
                return JunctionRef(
                    junction_id=junction["id"],
                    name=junction["name"],
                    graph_node_id=int(ref["graph_node_id"]),
                    incident_contig_ids=tuple(int(contig_id) for contig_id in ref["incident_contig_ids"]),
                    location={
                        "lat": float(junction["location"]["lat"]),
                        "lon": float(junction["location"]["lon"]),
                    },
                    notes=junction.get("notes", ""),
                    tags=tuple(junction.get("tags", [])),
                )
        raise KeyError(f"Junction '{junction_id}' has no ref for asset '{graph_asset_id}'")
    raise KeyError(f"Junction '{junction_id}' not found")


def update_node_degrees(nodes: dict[int, NodeRecord], adjacency: dict[int, list[tuple[int, int]]]) -> None:
    for node_id, node in list(nodes.items()):
        degree = len(adjacency.get(node_id, []))
        if degree != node.degree:
            nodes[node_id] = NodeRecord(id=node.id, lat=node.lat, lon=node.lon, degree=degree)


def find_articulation_points(adjacency: dict[int, list[tuple[int, int]]]) -> set[int]:
    graph = {node_id: {neighbor for _, neighbor in edges if neighbor != node_id} for node_id, edges in adjacency.items()}
    discovery: dict[int, int] = {}
    low: dict[int, int] = {}
    parent: dict[int, int | None] = {}
    articulation: set[int] = set()
    time = 0

    def visit(node_id: int) -> None:
        nonlocal time
        time += 1
        discovery[node_id] = time
        low[node_id] = time
        child_count = 0
        for neighbor in sorted(graph.get(node_id, set())):
            if neighbor not in discovery:
                parent[neighbor] = node_id
                child_count += 1
                visit(neighbor)
                low[node_id] = min(low[node_id], low[neighbor])
                if parent.get(node_id) is None and child_count > 1:
                    articulation.add(node_id)
                if parent.get(node_id) is not None and low[neighbor] >= discovery[node_id]:
                    articulation.add(node_id)
            elif neighbor != parent.get(node_id):
                low[node_id] = min(low[node_id], discovery[neighbor])

    for node_id in sorted(graph):
        if node_id in discovery:
            continue
        parent[node_id] = None
        visit(node_id)
    return articulation


def is_short_connector(contig: ContigRecord, config: PlannerConfig) -> bool:
    return contig.length_m <= config.short_connector_max_length_m


def can_traverse_contig(
    contig: ContigRecord,
    visit_count: int,
    overlap_length_m: float,
    config: PlannerConfig,
) -> tuple[bool, bool]:
    if visit_count == 0:
        return True, False
    if visit_count == 1 and is_short_connector(contig, config) and overlap_length_m + contig.length_m <= config.max_overlap_m:
        return True, True
    return False, False


def orient_contig_node_ids(contig: ContigRecord, from_node_id: int, to_node_id: int) -> list[int]:
    node_ids = list(contig.node_ids)
    if contig.is_cycle:
        return node_ids
    if node_ids[0] == from_node_id and node_ids[-1] == to_node_id:
        return node_ids
    if node_ids[0] == to_node_id and node_ids[-1] == from_node_id:
        return list(reversed(node_ids))
    raise ValueError(
        f"Contig {contig.id} endpoints {contig.endpoint_node_ids} do not match "
        f"requested traversal {from_node_id}->{to_node_id}"
    )


def build_route_node_ids(graph: RouteGraph, steps: Iterable[RouteStep]) -> list[int]:
    route_node_ids: list[int] = []
    for step in steps:
        contig = graph.contigs[step.contig_id]
        oriented = orient_contig_node_ids(contig, step.from_node_id, step.to_node_id)
        if not route_node_ids:
            route_node_ids.extend(oriented)
            continue
        route_node_ids.extend(oriented[1:])
    return route_node_ids


def best_connector_plan(
    graph: RouteGraph,
    *,
    visit_counts: dict[int, int],
    start_node_id: int,
    end_node_id: int,
    overlap_length_m: float,
    config: PlannerConfig,
) -> ConnectorPlan:
    if start_node_id == end_node_id:
        return ConnectorPlan(reachable=True, overlap_length_m=0.0, total_length_m=0.0, steps=())

    overlap_remaining = config.max_overlap_m - overlap_length_m
    queue: list[tuple[float, float, int]] = [(0.0, 0.0, start_node_id)]
    best_cost: dict[int, tuple[float, float]] = {start_node_id: (0.0, 0.0)}
    parents: dict[int, tuple[int, int, bool]] = {}

    while queue:
        overlap_cost, total_cost, node_id = heappop(queue)
        if (overlap_cost, total_cost) != best_cost.get(node_id):
            continue
        if node_id == end_node_id:
            break

        for contig_id, next_node_id in graph.adjacency.get(node_id, []):
            contig = graph.contigs[contig_id]
            visit_count = visit_counts.get(contig_id, 0)
            reusable = visit_count == 1 and is_short_connector(contig, config)
            if visit_count > 1 or (visit_count == 1 and not reusable):
                continue

            step_overlap = contig.length_m if reusable else 0.0
            new_overlap = overlap_cost + step_overlap
            if new_overlap > overlap_remaining:
                continue

            new_total = total_cost + contig.length_m
            candidate_cost = (new_overlap, new_total)
            if candidate_cost >= best_cost.get(next_node_id, (float("inf"), float("inf"))):
                continue

            best_cost[next_node_id] = candidate_cost
            parents[next_node_id] = (node_id, contig_id, reusable)
            heappush(queue, (new_overlap, new_total, next_node_id))

    if end_node_id not in best_cost:
        return ConnectorPlan(reachable=False, overlap_length_m=float("inf"), total_length_m=float("inf"), steps=())

    steps: list[RouteStep] = []
    cursor = end_node_id
    while cursor != start_node_id:
        previous_node_id, contig_id, reused = parents[cursor]
        contig = graph.contigs[contig_id]
        steps.append(
            RouteStep(
                contig_id=contig_id,
                from_node_id=previous_node_id,
                to_node_id=cursor,
                reused=reused,
                length_m=contig.length_m,
            )
        )
        cursor = previous_node_id
    steps.reverse()
    overlap_delta, total_length_m = best_cost[end_node_id]
    return ConnectorPlan(
        reachable=True,
        overlap_length_m=overlap_delta,
        total_length_m=total_length_m,
        steps=tuple(steps),
    )


def estimate_reachable_unused_length(
    graph: RouteGraph,
    *,
    visit_counts: dict[int, int],
    start_node_id: int,
    overlap_length_m: float,
    config: PlannerConfig,
) -> float:
    overlap_remaining = config.max_overlap_m - overlap_length_m
    seen_nodes = {start_node_id}
    queue = deque([start_node_id])
    seen_contigs: set[int] = set()
    unused_length_m = 0.0

    while queue:
        node_id = queue.popleft()
        for contig_id, next_node_id in graph.adjacency.get(node_id, []):
            contig = graph.contigs[contig_id]
            visit_count = visit_counts.get(contig_id, 0)
            reusable = visit_count == 1 and is_short_connector(contig, config)
            if visit_count > 1 or (visit_count == 1 and not reusable):
                continue
            if reusable and contig.length_m > overlap_remaining:
                continue
            if visit_count == 0 and contig_id not in seen_contigs:
                unused_length_m += contig.length_m
                seen_contigs.add(contig_id)
            if next_node_id not in seen_nodes:
                seen_nodes.add(next_node_id)
                queue.append(next_node_id)

    return unused_length_m


def choose_weighted_candidates(
    candidates: list[MoveCandidate],
    *,
    rng: random.Random,
    top_k: int,
    count: int,
) -> list[MoveCandidate]:
    ranked = sorted(candidates, key=lambda item: item.score, reverse=True)[: max(1, top_k)]
    selected: list[MoveCandidate] = []
    pool = ranked[:]
    while pool and len(selected) < count:
        weights = [max(1.0, float(len(pool) - index)) for index, _ in enumerate(pool)]
        choice = rng.choices(pool, weights=weights, k=1)[0]
        selected.append(choice)
        pool.remove(choice)
    return selected


def extend_state(state: RouteState, step: RouteStep) -> RouteState:
    next_visits = dict(state.contig_visits)
    next_visits[step.contig_id] = next_visits.get(step.contig_id, 0) + 1
    overlap_delta = step.length_m if step.reused else 0.0
    unique_delta = 0.0 if step.reused else step.length_m
    return RouteState(
        current_node_id=step.to_node_id,
        steps=state.steps + (step,),
        contig_visits=next_visits,
        total_length_m=state.total_length_m + step.length_m,
        unique_length_m=state.unique_length_m + unique_delta,
        overlap_length_m=state.overlap_length_m + overlap_delta,
    )


def move_candidates(
    graph: RouteGraph,
    *,
    state: RouteState,
    end_node_id: int,
    config: PlannerConfig,
) -> list[MoveCandidate]:
    candidates: list[MoveCandidate] = []
    for contig_id, next_node_id in graph.adjacency.get(state.current_node_id, []):
        contig = graph.contigs[contig_id]
        if state.last_contig_id == contig_id and not contig.is_cycle:
            continue
        allowed, reused = can_traverse_contig(
            contig,
            state.contig_visits.get(contig_id, 0),
            state.overlap_length_m,
            config,
        )
        if not allowed:
            continue

        step = RouteStep(
            contig_id=contig_id,
            from_node_id=state.current_node_id,
            to_node_id=next_node_id,
            reused=reused,
            length_m=contig.length_m,
        )
        next_state = extend_state(state, step)
        connector_plan = best_connector_plan(
            graph,
            visit_counts=next_state.contig_visits,
            start_node_id=next_state.current_node_id,
            end_node_id=end_node_id,
            overlap_length_m=next_state.overlap_length_m,
            config=config,
        )
        if not connector_plan.reachable:
            continue

        future_unused_length_m = estimate_reachable_unused_length(
            graph,
            visit_counts=next_state.contig_visits,
            start_node_id=next_state.current_node_id,
            overlap_length_m=next_state.overlap_length_m,
            config=config,
        )
        score = score_move(
            graph,
            step=step,
            end_node_id=end_node_id,
            future_unused_length_m=future_unused_length_m,
            connector_plan=connector_plan,
            config=config,
        )
        candidates.append(
            MoveCandidate(
                step=step,
                score=score,
                future_unused_length_m=future_unused_length_m,
                connector_plan=connector_plan,
            )
        )

    non_end_candidates = [candidate for candidate in candidates if candidate.step.to_node_id != end_node_id]
    if non_end_candidates:
        return non_end_candidates
    return candidates


def score_move(
    graph: RouteGraph,
    *,
    step: RouteStep,
    end_node_id: int,
    future_unused_length_m: float,
    connector_plan: ConnectorPlan,
    config: PlannerConfig,
) -> float:
    score = step.length_m
    score += config.future_length_weight * future_unused_length_m
    score -= config.connector_length_weight * connector_plan.total_length_m
    if step.reused:
        score -= config.overlap_penalty_per_m * step.length_m
    if step.to_node_id == end_node_id and future_unused_length_m > config.end_finish_unused_slack_m:
        score -= config.early_finish_penalty
    if step.to_node_id in graph.articulation_points and future_unused_length_m > config.articulation_future_threshold_m:
        score -= config.articulation_penalty
    if graph.nodes[step.to_node_id].degree <= 1 and step.to_node_id != end_node_id:
        score -= config.dead_end_penalty
    return score


def finalize_candidate(
    graph: RouteGraph,
    state: RouteState,
    algorithm: str,
    end_node_id: int,
    config: PlannerConfig,
) -> RouteCandidate:
    connector_plan = best_connector_plan(
        graph,
        visit_counts=state.contig_visits,
        start_node_id=state.current_node_id,
        end_node_id=end_node_id,
        overlap_length_m=state.overlap_length_m,
        config=config,
    )
    future_unused_length_m = estimate_reachable_unused_length(
        graph,
        visit_counts=state.contig_visits,
        start_node_id=state.current_node_id,
        overlap_length_m=state.overlap_length_m,
        config=config,
    )
    score = state.unique_length_m - 10.0 * state.overlap_length_m + 0.01 * future_unused_length_m
    if state.current_node_id == end_node_id:
        score += 250.0
    elif connector_plan.reachable:
        score -= 0.05 * connector_plan.total_length_m
    else:
        score -= 500.0
    return RouteCandidate(
        algorithm=algorithm,
        complete=state.current_node_id == end_node_id,
        score=score,
        total_length_m=state.total_length_m,
        unique_length_m=state.unique_length_m,
        overlap_length_m=state.overlap_length_m,
        terminal_node_id=state.current_node_id,
        steps=state.steps,
    )


def rank_candidates(candidates: Iterable[RouteCandidate]) -> list[RouteCandidate]:
    return sorted(
        candidates,
        key=lambda candidate: (
            candidate.complete,
            candidate.unique_length_m,
            -candidate.overlap_length_m,
            candidate.score,
            -len(candidate.steps),
        ),
        reverse=True,
    )


def unique_ranked_candidates(candidates: Iterable[RouteCandidate]) -> list[RouteCandidate]:
    unique: dict[tuple[int, ...], RouteCandidate] = {}
    for candidate in rank_candidates(candidates):
        signature = candidate.contig_id_sequence
        if signature in unique:
            continue
        unique[signature] = candidate
    return list(unique.values())


def unique_top_candidates(candidates: Iterable[RouteCandidate], keep_best: int) -> list[RouteCandidate]:
    return unique_ranked_candidates(candidates)[:keep_best]


def contig_jaccard_similarity(candidate_a: RouteCandidate, candidate_b: RouteCandidate) -> float:
    contigs_a = set(candidate_a.contig_id_sequence)
    contigs_b = set(candidate_b.contig_id_sequence)
    union = contigs_a | contigs_b
    if not union:
        return 1.0
    return len(contigs_a & contigs_b) / len(union)


def build_diverse_candidate_pool(
    ranked_candidates: list[RouteCandidate],
    *,
    pool_size: int,
    selection_window: int,
) -> list[RouteCandidate]:
    if not ranked_candidates:
        return []

    window = ranked_candidates[: max(pool_size, selection_window)]
    pool = [window[0]]
    remaining = window[1:]
    while remaining and len(pool) < pool_size:
        best_index = 0
        best_score = (-1.0, float("-inf"))
        for index, candidate in enumerate(remaining):
            diversity = min(1.0 - contig_jaccard_similarity(candidate, selected) for selected in pool)
            score = (diversity, candidate.score)
            if score > best_score:
                best_score = score
                best_index = index
        pool.append(remaining.pop(best_index))
    return pool


def pick_seeded_primary_candidate(
    ranked_candidates: list[RouteCandidate],
    *,
    rng: random.Random,
    config: PlannerConfig,
) -> RouteCandidate | None:
    pool = build_diverse_candidate_pool(
        ranked_candidates,
        pool_size=min(config.beam_selection_pool, len(ranked_candidates)),
        selection_window=min(config.beam_selection_window, len(ranked_candidates)),
    )
    if not pool:
        return None
    rank_index = {candidate.contig_id_sequence: index for index, candidate in enumerate(ranked_candidates)}
    weights = [max(1.0, float(len(pool) - rank_index[candidate.contig_id_sequence])) for candidate in pool]
    return rng.choices(pool, weights=weights, k=1)[0]


def reorder_seeded_candidates(
    candidates: Iterable[RouteCandidate],
    *,
    rng: random.Random,
    config: PlannerConfig,
) -> list[RouteCandidate]:
    ranked_unique = unique_ranked_candidates(candidates)
    if not ranked_unique:
        return []
    primary = pick_seeded_primary_candidate(ranked_unique, rng=rng, config=config)
    if primary is None:
        return ranked_unique[: config.keep_best]
    ordered = [primary]
    ordered.extend(
        candidate for candidate in ranked_unique if candidate.contig_id_sequence != primary.contig_id_sequence
    )
    return ordered[: config.keep_best]


def connect_to_end_if_possible(
    graph: RouteGraph,
    *,
    state: RouteState,
    end_node_id: int,
    config: PlannerConfig,
) -> RouteState:
    connector = best_connector_plan(
        graph,
        visit_counts=state.contig_visits,
        start_node_id=state.current_node_id,
        end_node_id=end_node_id,
        overlap_length_m=state.overlap_length_m,
        config=config,
    )
    if not connector.reachable:
        return state
    current_state = state
    for step in connector.steps:
        current_state = extend_state(current_state, step)
    return current_state


def should_stop_at_end(
    graph: RouteGraph,
    *,
    state: RouteState,
    end_node_id: int,
    choices: list[MoveCandidate],
    config: PlannerConfig,
    rng: random.Random,
) -> bool:
    if state.current_node_id != end_node_id or not state.steps:
        return False
    if not choices:
        return True

    future_unused_length_m = estimate_reachable_unused_length(
        graph,
        visit_counts=state.contig_visits,
        start_node_id=state.current_node_id,
        overlap_length_m=state.overlap_length_m,
        config=config,
    )
    if future_unused_length_m > config.end_stop_unused_slack_m:
        return False
    return rng.random() < config.end_stop_probability


def rollout_route(
    graph: RouteGraph,
    *,
    initial_state: RouteState,
    end_node_id: int,
    config: PlannerConfig,
    rng: random.Random,
    algorithm: str,
    top_k: int,
) -> RouteCandidate:
    state = initial_state
    for _ in range(max(0, config.max_steps - len(state.steps))):
        choices = move_candidates(graph, state=state, end_node_id=end_node_id, config=config)
        if should_stop_at_end(
            graph,
            state=state,
            end_node_id=end_node_id,
            choices=choices,
            config=config,
            rng=rng,
        ):
            break
        if not choices:
            break
        chosen = choose_weighted_candidates(
            choices,
            rng=rng,
            top_k=top_k,
            count=1,
        )[0]
        state = extend_state(state, chosen.step)

    state = connect_to_end_if_possible(graph, state=state, end_node_id=end_node_id, config=config)
    return finalize_candidate(graph, state, algorithm, end_node_id, config)


def plan_route_naive(
    graph: RouteGraph,
    *,
    start_node_id: int,
    end_node_id: int,
    config: PlannerConfig,
    rng: random.Random,
) -> list[RouteCandidate]:
    candidates: list[RouteCandidate] = []
    for _ in range(config.rollout_trials):
        initial_state = RouteState(
            current_node_id=start_node_id,
            steps=(),
            contig_visits={},
            total_length_m=0.0,
            unique_length_m=0.0,
            overlap_length_m=0.0,
        )
        candidates.append(
            rollout_route(
                graph,
                initial_state=initial_state,
                end_node_id=end_node_id,
                config=config,
                rng=rng,
                algorithm="naive",
                top_k=config.random_top_k,
            )
        )

    return unique_top_candidates(candidates, config.keep_best)


def beam_state_priority(
    graph: RouteGraph,
    *,
    state: RouteState,
    end_node_id: int,
    config: PlannerConfig,
) -> float:
    connector = best_connector_plan(
        graph,
        visit_counts=state.contig_visits,
        start_node_id=state.current_node_id,
        end_node_id=end_node_id,
        overlap_length_m=state.overlap_length_m,
        config=config,
    )
    future_unused_length_m = estimate_reachable_unused_length(
        graph,
        visit_counts=state.contig_visits,
        start_node_id=state.current_node_id,
        overlap_length_m=state.overlap_length_m,
        config=config,
    )
    score = state.unique_length_m
    score -= 10.0 * state.overlap_length_m
    score += 0.04 * future_unused_length_m
    if connector.reachable:
        score -= 0.02 * connector.total_length_m
    else:
        score -= 600.0
    if state.current_node_id == end_node_id:
        score += 200.0
    if state.current_node_id in graph.articulation_points and future_unused_length_m > config.articulation_future_threshold_m:
        score -= 20.0
    return score


def beam_signature(state: RouteState) -> tuple[int, tuple[int, ...]]:
    return state.current_node_id, tuple(step.contig_id for step in state.steps)


def plan_route_beam(
    graph: RouteGraph,
    *,
    start_node_id: int,
    end_node_id: int,
    config: PlannerConfig,
    rng: random.Random,
) -> list[RouteCandidate]:
    initial_state = RouteState(
        current_node_id=start_node_id,
        steps=(),
        contig_visits={},
        total_length_m=0.0,
        unique_length_m=0.0,
        overlap_length_m=0.0,
    )
    beams = [initial_state]
    complete: list[RouteCandidate] = []

    for _ in range(config.beam_rounds):
        expansions: list[tuple[float, RouteState]] = []
        for state in beams:
            if state.current_node_id == end_node_id and state.steps:
                complete.append(finalize_candidate(graph, state, "beam", end_node_id, config))

            choices = move_candidates(graph, state=state, end_node_id=end_node_id, config=config)
            if state.current_node_id == end_node_id and state.steps:
                choices = [candidate for candidate in choices if candidate.step.to_node_id != end_node_id]
            if not choices:
                if state.current_node_id != end_node_id:
                    terminal_state = connect_to_end_if_possible(graph, state=state, end_node_id=end_node_id, config=config)
                    complete.append(finalize_candidate(graph, terminal_state, "beam", end_node_id, config))
                continue

            for candidate in choose_weighted_candidates(
                choices,
                rng=rng,
                top_k=max(config.random_top_k, config.beam_branch_factor + 1),
                count=config.beam_branch_factor,
            ):
                next_state = extend_state(state, candidate.step)
                expansions.append(
                    (
                        beam_state_priority(graph, state=next_state, end_node_id=end_node_id, config=config),
                        next_state,
                    )
                )

        if not expansions:
            break

        deduped: dict[tuple[int, tuple[int, ...]], tuple[float, RouteState]] = {}
        for priority, state in sorted(expansions, key=lambda item: item[0], reverse=True):
            signature = beam_signature(state)
            if signature in deduped:
                continue
            deduped[signature] = (priority, state)
            if len(deduped) >= config.beam_width:
                break

        beams = [state for _, state in deduped.values()]
        if not beams:
            break

    for state in beams:
        terminal_state = connect_to_end_if_possible(graph, state=state, end_node_id=end_node_id, config=config)
        complete.append(finalize_candidate(graph, terminal_state, "beam", end_node_id, config))

    return reorder_seeded_candidates(complete, rng=rng, config=config)


def candidate_visit_counts(candidate: RouteCandidate) -> dict[int, int]:
    visit_counts: dict[int, int] = {}
    for step in candidate.steps:
        visit_counts[step.contig_id] = visit_counts.get(step.contig_id, 0) + 1
    return visit_counts


def candidate_future_unused_length(
    graph: RouteGraph,
    *,
    candidate: RouteCandidate,
    config: PlannerConfig,
) -> float:
    return estimate_reachable_unused_length(
        graph,
        visit_counts=candidate_visit_counts(candidate),
        start_node_id=candidate.terminal_node_id,
        overlap_length_m=candidate.overlap_length_m,
        config=config,
    )


def route_reward(
    graph: RouteGraph,
    *,
    candidate: RouteCandidate,
    end_node_id: int,
    config: PlannerConfig,
    loop_mode: bool,
) -> float:
    reward = candidate.score
    future_unused_length_m = candidate_future_unused_length(graph, candidate=candidate, config=config)
    if candidate.complete and loop_mode and candidate.terminal_node_id == end_node_id:
        coverage_ratio = candidate.unique_length_m / max(
            1.0,
            candidate.unique_length_m + future_unused_length_m,
        )
        reward += config.mcts_loop_completion_bonus
        reward += config.mcts_loop_late_return_bonus * coverage_ratio
        reward -= config.mcts_loop_unused_penalty_per_m * future_unused_length_m
        reward -= config.mcts_loop_overlap_penalty_per_m * candidate.overlap_length_m
    return reward / 1000.0


def mcts_node_value(node: MctsTreeNode, config: PlannerConfig) -> float:
    if node.visits == 0:
        return float("inf")
    assert node.parent is not None
    exploit = node.reward_sum / node.visits
    explore = config.mcts_exploration_weight * math.sqrt(math.log(max(1, node.parent.visits)) / node.visits)
    prior = 0.0 if node.move is None else config.mcts_prior_weight * (node.move.score / 1000.0)
    return exploit + explore + prior


def select_mcts_child(node: MctsTreeNode, rng: random.Random, config: PlannerConfig) -> MctsTreeNode:
    scored = [(mcts_node_value(child, config), child) for child in node.children]
    best_value = max(value for value, _ in scored)
    tied = [child for value, child in scored if abs(value - best_value) < 1e-12]
    return rng.choice(tied)


def expand_mcts_node(
    graph: RouteGraph,
    *,
    node: MctsTreeNode,
    end_node_id: int,
    config: PlannerConfig,
    rng: random.Random,
) -> MctsTreeNode:
    if node.unexpanded_moves is None:
        node.unexpanded_moves = move_candidates(graph, state=node.state, end_node_id=end_node_id, config=config)
    if not node.unexpanded_moves:
        return node

    chosen = choose_weighted_candidates(
        node.unexpanded_moves,
        rng=rng,
        top_k=config.mcts_rollout_top_k,
        count=1,
    )[0]
    node.unexpanded_moves.remove(chosen)
    child = MctsTreeNode(
        state=extend_state(node.state, chosen.step),
        parent=node,
        move=chosen,
    )
    node.children.append(child)
    return child


def plan_route_mcts(
    graph: RouteGraph,
    *,
    start_node_id: int,
    end_node_id: int,
    config: PlannerConfig,
    rng: random.Random,
) -> list[RouteCandidate]:
    loop_mode = start_node_id == end_node_id
    root = MctsTreeNode(
        state=RouteState(
            current_node_id=start_node_id,
            steps=(),
            contig_visits={},
            total_length_m=0.0,
            unique_length_m=0.0,
            overlap_length_m=0.0,
        )
    )
    candidates: list[RouteCandidate] = []

    for _ in range(config.mcts_iterations):
        node = root
        path = [node]

        while True:
            if len(node.state.steps) >= config.max_steps:
                break
            if node.unexpanded_moves is None:
                node.unexpanded_moves = move_candidates(graph, state=node.state, end_node_id=end_node_id, config=config)
            if node.unexpanded_moves:
                node = expand_mcts_node(
                    graph,
                    node=node,
                    end_node_id=end_node_id,
                    config=config,
                    rng=rng,
                )
                path.append(node)
                break
            if not node.children:
                break
            node = select_mcts_child(node, rng, config)
            path.append(node)

        rollout_candidates = [
            rollout_route(
                graph,
                initial_state=node.state,
                end_node_id=end_node_id,
                config=config,
                rng=rng,
                algorithm="mcts",
                top_k=config.mcts_rollout_top_k,
            )
            for _ in range(max(1, config.mcts_rollout_samples))
        ]
        candidates.extend(rollout_candidates)
        candidate = rank_candidates(rollout_candidates)[0]
        reward = route_reward(
            graph,
            candidate=candidate,
            end_node_id=end_node_id,
            config=config,
            loop_mode=loop_mode,
        )
        for visited in path:
            visited.visits += 1
            visited.reward_sum += reward

    return reorder_seeded_candidates(candidates, rng=rng, config=config)


def route_candidate_to_dict(graph: RouteGraph, candidate: RouteCandidate) -> dict:
    steps = [asdict(step) for step in candidate.steps]
    route_node_ids = build_route_node_ids(graph, candidate.steps)
    return {
        "algorithm": candidate.algorithm,
        "complete": candidate.complete,
        "score": round(candidate.score, 3),
        "total_length_m": round(candidate.total_length_m, 3),
        "unique_length_m": round(candidate.unique_length_m, 3),
        "overlap_length_m": round(candidate.overlap_length_m, 3),
        "terminal_node_id": candidate.terminal_node_id,
        "contig_id_sequence": list(candidate.contig_id_sequence),
        "repeated_contig_ids": list(candidate.repeated_contig_ids),
        "route_node_ids": route_node_ids,
        "steps": steps,
    }


def route_asset_payload(
    *,
    graph_path: Path,
    junctions_path: Path,
    graph: RouteGraph,
    junction_catalog: dict,
    start_ref: JunctionRef,
    end_ref: JunctionRef,
    algorithm: str,
    config: PlannerConfig,
    seed: int,
    candidates: list[RouteCandidate],
) -> dict:
    generated_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    junction_catalog_meta = junction_catalog["meta"]
    asset_id = (
        f"karura-route-{algorithm}-from-{graph.asset_id}-"
        f"{start_ref.junction_id}-to-{end_ref.junction_id}-seed{seed}"
    )
    return {
        "assets": [
            {
                "id": graph.asset_id,
                "kind": graph.asset_kind,
                "path": str(graph_path),
            },
            {
                "id": junction_catalog_meta["asset_id"],
                "kind": junction_catalog_meta["asset_kind"],
                "path": str(junctions_path),
            },
        ],
        "meta": {
            "asset_id": asset_id,
            "asset_kind": "route_candidates",
            "generated_at": generated_at,
            "algorithm": algorithm,
            "seed": seed,
            "graph_asset_id": graph.asset_id,
            "junction_catalog_asset_id": junction_catalog_meta["asset_id"],
            "start_junction_id": start_ref.junction_id,
            "end_junction_id": end_ref.junction_id,
        },
        "config": asdict(config),
        "start": asdict(start_ref),
        "end": asdict(end_ref),
        "routes": [route_candidate_to_dict(graph, candidate) for candidate in candidates],
    }


def write_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n")
