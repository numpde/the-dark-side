from __future__ import annotations

from types import SimpleNamespace
import unittest

from the_dark_side.export_karura_web_catalog import (
    RouteRecord,
    canonicalize_route_node_ids,
    dedupe_records,
    family_id_for,
)


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


if __name__ == "__main__":
    unittest.main()
