from __future__ import annotations

import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest

from the_dark_side.export_karura_web_catalog import (
    RouteRecord,
    build_catalog_payload,
    canonicalize_route_node_ids,
    dedupe_records,
    family_id_for,
    parse_args as parse_export_args,
    plan_catalog_records,
)
from the_dark_side.karura_common import LOCAL_ROUTING_STATE_TAG, is_currently_unavailable
from the_dark_side.web_assets import load_elevation_asset


def dummy_record(*, route_id: str, route_node_ids: tuple[int, ...], quality_score: float, direction_from_family: str) -> RouteRecord:
    family_signature, _ = canonicalize_route_node_ids(route_node_ids)
    candidate = SimpleNamespace(
        complete=True,
        score=quality_score,
        unique_length_m=quality_score,
        overlap_length_m=0.0,
        total_length_m=quality_score,
        steps=[],
        repeated_contig_ids=(),
    )
    return RouteRecord(
        route_id=route_id,
        scenario_id="a__to__b",
        start_junction_id="a",
        end_junction_id="b",
        algorithm="beam",
        seed=1,
        candidate_rank=0,
        candidate=candidate,
        route_node_ids=route_node_ids,
        family_signature=family_signature,
        direction_from_family=direction_from_family,
        coordinates=[],
        bounds=[0.0, 0.0, 0.0, 0.0],
        contig_set=(),
        quality_score=quality_score,
    )


class ExportCatalogNormalizationTest(unittest.TestCase):
    def test_canonicalize_route_node_ids_is_reversal_invariant(self) -> None:
        forward = (101, 202, 303, 404)
        reverse = tuple(reversed(forward))

        canonical_forward, direction_forward = canonicalize_route_node_ids(forward)
        canonical_reverse, direction_reverse = canonicalize_route_node_ids(reverse)

        self.assertEqual(canonical_forward, canonical_reverse)
        self.assertEqual(direction_forward, "forward")
        self.assertEqual(direction_reverse, "reverse")

    def test_dedupe_records_collapses_exact_reversal_family(self) -> None:
        better = dummy_record(
            route_id="forward",
            route_node_ids=(10, 20, 30, 40),
            quality_score=120.0,
            direction_from_family="forward",
        )
        worse_reverse = dummy_record(
            route_id="reverse",
            route_node_ids=(40, 30, 20, 10),
            quality_score=100.0,
            direction_from_family="reverse",
        )

        deduped = dedupe_records([worse_reverse, better])

        self.assertEqual(len(deduped), 1)
        self.assertEqual(deduped[0].route_id, "forward")

    def test_family_id_is_same_for_forward_and_reverse(self) -> None:
        forward = canonicalize_route_node_ids((1, 5, 7, 9))[0]
        reverse = canonicalize_route_node_ids((9, 7, 5, 1))[0]

        self.assertEqual(family_id_for(forward), family_id_for(reverse))

    def test_load_elevation_asset_ignores_graph_mismatch(self) -> None:
        payload = {
            "meta": {
                "graph_asset_id": "graph-a",
            },
            "nodes": {
                "1": {"elevation_m": 10.0},
                "2": {"elevation_m": 20.0},
            },
        }
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "elevation.json"
            path.write_text(json.dumps(payload))

            elevations, matches = load_elevation_asset(path, expected_graph_asset_id="graph-b")

        self.assertEqual(elevations, {})
        self.assertFalse(matches)

    def test_debug_catalog_payload_is_flattened(self) -> None:
        args = parse_export_args(
            [
                "--algorithm", "naive",
                "--seed-start", "1",
                "--seed-end", "1",
                "--candidate-limit-per-run", "1",
                "--routes-per-scenario", "1",
                "--selection-window", "1",
            ]
        )

        payload = build_catalog_payload(args)

        self.assertNotIn("areas", payload)
        self.assertIn("junctions", payload)
        self.assertIn("route_families", payload)
        self.assertIn("scenarios", payload)
        self.assertEqual(payload["meta"]["area_id"], "karura")

    def test_selected_routes_do_not_traverse_excluded_or_unavailable_contigs(self) -> None:
        args = parse_export_args(
            [
                "--algorithm", "naive",
                "--algorithm", "beam",
                "--algorithm", "mcts",
                "--seed-start", "1",
                "--seed-end", "1",
                "--candidate-limit-per-run", "1",
                "--routes-per-scenario", "1",
                "--selection-window", "1",
            ]
        )

        planned = plan_catalog_records(args)
        graph = planned["graph"]
        selected_records_by_scenario = planned["selected_records_by_scenario"]
        blocked_contig_ids = {
            contig.id
            for contig in graph.contigs.values()
            if contig.tags.get(LOCAL_ROUTING_STATE_TAG) == "exclude"
            or is_currently_unavailable(contig.tags)
        }

        self.assertTrue(blocked_contig_ids, "expected at least one excluded or unavailable contig in the current fixture")

        for records in selected_records_by_scenario.values():
            for record in records:
                traversed = set(record.candidate.contig_id_sequence)
                self.assertTrue(
                    traversed.isdisjoint(blocked_contig_ids),
                    f"route {record.route_id} traverses blocked contigs {sorted(traversed & blocked_contig_ids)}",
                )


if __name__ == "__main__":
    unittest.main()
