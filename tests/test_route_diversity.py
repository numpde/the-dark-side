from __future__ import annotations

import random
import unittest

from the_dark_side.karura_common import CONTIGS_JSON, JUNCTIONS_JSON
from the_dark_side.karura_routing import (
    PlannerConfig,
    load_junction_catalog,
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
        cls.junction_catalog = load_junction_catalog(JUNCTIONS_JSON)
        cls.start = resolve_junction_ref(cls.junction_catalog, "family_trail_west", cls.graph.asset_id)
        cls.end = resolve_junction_ref(cls.junction_catalog, "kiambu_side_exit", cls.graph.asset_id)
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


if __name__ == "__main__":
    unittest.main()
