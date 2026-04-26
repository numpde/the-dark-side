from __future__ import annotations

import random
import unittest
from pathlib import Path

from the_dark_side.asset_contracts import load_required_junction_bindings, load_required_junction_catalog
from the_dark_side.karura_common import CONTIGS_JSON, JUNCTION_BINDINGS_JSON, JUNCTIONS_JSON
from the_dark_side.karura_routing import (
    ContigRecord,
    NodeRecord,
    PlannerConfig,
    RouteGraph,
    load_route_graph,
    plan_route_beam,
    plan_route_mcts,
    plan_route_naive,
    resolve_junction_ref,
)


SEEDS = (1, 2, 3, 4)
BEAM_SEEDS = (1, 2, 3, 4, 5, 6, 7, 8)


class RouteDiversityAuditTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.graph = load_route_graph(CONTIGS_JSON)
        cls.junction_catalog = load_required_junction_catalog(JUNCTIONS_JSON, label="junction catalog")
        cls.junction_bindings = load_required_junction_bindings(JUNCTION_BINDINGS_JSON, label="junction bindings")
        cls.start = resolve_junction_ref(cls.junction_catalog, "family_trail_west", cls.graph.asset_id, cls.junction_bindings)
        cls.end = resolve_junction_ref(cls.junction_catalog, "kiambu_side_exit", cls.graph.asset_id, cls.junction_bindings)
        cls.config = PlannerConfig(
            rollout_trials=120,
            beam_rounds=160,
            beam_width=64,
            beam_branch_factor=5,
            beam_selection_pool=5,
            beam_selection_window=10,
            mcts_iterations=180,
            mcts_rollout_top_k=4,
            keep_best=4,
        )

    def run_planner(self, algorithm: str, seed: int):
        rng = random.Random(seed)
        if algorithm == "naive":
            candidates = plan_route_naive(
                self.graph,
                start_node_id=self.start.graph_node_id,
                end_node_id=self.end.graph_node_id,
                config=self.config,
                rng=rng,
            )
        elif algorithm == "beam":
            candidates = plan_route_beam(
                self.graph,
                start_node_id=self.start.graph_node_id,
                end_node_id=self.end.graph_node_id,
                config=self.config,
                rng=rng,
            )
        elif algorithm == "mcts":
            candidates = plan_route_mcts(
                self.graph,
                start_node_id=self.start.graph_node_id,
                end_node_id=self.end.graph_node_id,
                config=self.config,
                rng=rng,
            )
        else:
            raise ValueError(algorithm)

        self.assertTrue(candidates, f"{algorithm} returned no route candidates")
        self.assertTrue(candidates[0].complete, f"{algorithm} top route was not complete for seed {seed}")
        return candidates[0]

    def test_same_seed_is_reproducible(self) -> None:
        for algorithm in ("naive", "beam", "mcts"):
            with self.subTest(algorithm=algorithm):
                first = self.run_planner(algorithm, seed=7)
                second = self.run_planner(algorithm, seed=7)
                self.assertEqual(first.contig_id_sequence, second.contig_id_sequence)
                self.assertEqual(first.unique_length_m, second.unique_length_m)
                self.assertEqual(first.overlap_length_m, second.overlap_length_m)

    def test_naive_primary_route_changes_with_seed(self) -> None:
        signatures = {self.run_planner("naive", seed).contig_id_sequence for seed in SEEDS}
        self.assertGreater(
            len(signatures),
            1,
            "naive planner should produce more than one distinct top route across the audit seeds",
        )

    def test_beam_primary_route_changes_with_seed(self) -> None:
        signatures = {self.run_planner("beam", seed).contig_id_sequence for seed in BEAM_SEEDS}
        self.assertGreater(
            len(signatures),
            1,
            "beam planner should produce more than one distinct top route across the audit seeds",
        )

    def test_mcts_primary_route_changes_with_seed(self) -> None:
        signatures = {self.run_planner("mcts", seed).contig_id_sequence for seed in SEEDS}
        self.assertGreater(
            len(signatures),
            1,
            "mcts planner should produce more than one distinct top route across the audit seeds",
        )

    def test_planners_avoid_unavailable_contigs(self) -> None:
        graph = RouteGraph(
            asset_id="synthetic-policy-graph",
            asset_kind="contig_graph",
            source_path=Path("<synthetic>"),
            nodes={
                1: NodeRecord(id=1, lat=0.0, lon=0.0, degree=2),
                2: NodeRecord(id=2, lat=0.0, lon=1.0, degree=2),
                3: NodeRecord(id=3, lat=1.0, lon=0.0, degree=2),
                4: NodeRecord(id=4, lat=1.0, lon=1.0, degree=2),
            },
            contigs={
                10: ContigRecord(
                    id=10,
                    endpoint_node_ids=(1, 2),
                    node_ids=(1, 2),
                    length_m=100.0,
                    is_cycle=False,
                    segment_count=1,
                    way_ids=(10,),
                    way_names=(),
                    highway_types={"path": 1},
                    tags={},
                ),
                20: ContigRecord(
                    id=20,
                    endpoint_node_ids=(2, 4),
                    node_ids=(2, 4),
                    length_m=100.0,
                    is_cycle=False,
                    segment_count=1,
                    way_ids=(20,),
                    way_names=(),
                    highway_types={"path": 1},
                    tags={"local:unavailable_until": "2099-12-31"},
                ),
                30: ContigRecord(
                    id=30,
                    endpoint_node_ids=(1, 3),
                    node_ids=(1, 3),
                    length_m=100.0,
                    is_cycle=False,
                    segment_count=1,
                    way_ids=(30,),
                    way_names=(),
                    highway_types={"path": 1},
                    tags={},
                ),
                40: ContigRecord(
                    id=40,
                    endpoint_node_ids=(3, 4),
                    node_ids=(3, 4),
                    length_m=100.0,
                    is_cycle=False,
                    segment_count=1,
                    way_ids=(40,),
                    way_names=(),
                    highway_types={"path": 1},
                    tags={},
                ),
            },
            adjacency={
                1: [(10, 2), (30, 3)],
                2: [(10, 1), (20, 4)],
                3: [(30, 1), (40, 4)],
                4: [(20, 2), (40, 3)],
            },
            articulation_points=set(),
        )
        config = PlannerConfig(
            rollout_trials=24,
            beam_rounds=40,
            beam_width=24,
            beam_branch_factor=3,
            beam_selection_pool=3,
            beam_selection_window=6,
            mcts_iterations=60,
            mcts_rollout_samples=2,
            keep_best=3,
            max_steps=8,
        )
        expected_sequence = (30, 40)

        for algorithm in ("naive", "beam", "mcts"):
            with self.subTest(algorithm=algorithm):
                rng = random.Random(7)
                if algorithm == "naive":
                    candidates = plan_route_naive(graph, start_node_id=1, end_node_id=4, config=config, rng=rng)
                elif algorithm == "beam":
                    candidates = plan_route_beam(graph, start_node_id=1, end_node_id=4, config=config, rng=rng)
                else:
                    candidates = plan_route_mcts(graph, start_node_id=1, end_node_id=4, config=config, rng=rng)

                self.assertTrue(candidates, f"{algorithm} returned no candidates on synthetic graph")
                self.assertTrue(all(candidate.complete for candidate in candidates), f"{algorithm} returned incomplete candidates")
                self.assertTrue(
                    all(20 not in candidate.contig_id_sequence for candidate in candidates),
                    f"{algorithm} returned a route through an unavailable contig",
                )
                self.assertEqual(candidates[0].contig_id_sequence, expected_sequence)


if __name__ == "__main__":
    unittest.main()
