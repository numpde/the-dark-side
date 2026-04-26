from __future__ import annotations

import json
from pathlib import Path
import tempfile
import unittest

from the_dark_side.asset_contracts import load_route_asset_document, validate_route_asset_document
from the_dark_side.karura_routing import (
    ContigRecord,
    JunctionRef,
    NodeRecord,
    PlannerConfig,
    RouteCandidate,
    RouteGraph,
    RouteStep,
    route_asset_payload,
)


class RouteAssetTest(unittest.TestCase):
    def build_sample_route_asset(self) -> dict:
        graph = RouteGraph(
            asset_id="graph-1",
            asset_kind="contig_graph",
            source_path=Path("data/karura_contigs.json"),
            nodes={
                1: NodeRecord(id=1, lat=-1.0, lon=36.0, degree=1),
                2: NodeRecord(id=2, lat=-1.001, lon=36.001, degree=1),
            },
            contigs={
                10: ContigRecord(
                    id=10,
                    endpoint_node_ids=(1, 2),
                    node_ids=(1, 2),
                    length_m=150.0,
                    is_cycle=False,
                    segment_count=1,
                    way_ids=(10,),
                    way_names=("Path 10",),
                    highway_types={"path": 1},
                    tags={},
                )
            },
            adjacency={
                1: [(10, 2)],
                2: [(10, 1)],
            },
            articulation_points=set(),
        )
        junction_catalog = {
            "meta": {"asset_id": "junction-catalog-1", "asset_kind": "junction_catalog"},
            "junctions": [],
        }
        start = JunctionRef(
            junction_id="alpha",
            name="Alpha",
            graph_node_id=1,
            incident_contig_ids=(10,),
            location={"lat": -1.0, "lon": 36.0},
            notes="",
            tags=(),
        )
        end = JunctionRef(
            junction_id="beta",
            name="Beta",
            graph_node_id=2,
            incident_contig_ids=(10,),
            location={"lat": -1.001, "lon": 36.001},
            notes="",
            tags=(),
        )
        candidate = RouteCandidate(
            algorithm="naive",
            complete=True,
            score=10.0,
            total_length_m=150.0,
            unique_length_m=150.0,
            overlap_length_m=0.0,
            terminal_node_id=2,
            steps=(RouteStep(contig_id=10, from_node_id=1, to_node_id=2, reused=False, length_m=150.0),),
        )
        return route_asset_payload(
            graph_path=Path("data/karura_contigs.json"),
            graph=graph,
            junction_catalog=junction_catalog,
            start_ref=start,
            end_ref=end,
            algorithm="naive",
            config=PlannerConfig(),
            seed=7,
            candidates=[candidate],
        )

    def test_validate_route_asset_document_accepts_generated_payload(self) -> None:
        payload = json.loads(json.dumps(self.build_sample_route_asset()))
        self.assertEqual(validate_route_asset_document(payload, label="route asset"), payload)

    def test_load_route_asset_rejects_malformed_document(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            route_path = Path(tmpdir) / "route.json"
            route_path.write_text(
                json.dumps(
                    {
                        "meta": {
                            "asset_id": "route-1",
                            "asset_kind": "route_candidates",
                            "algorithm": "naive",
                            "graph_asset_id": "graph-1",
                            "graph_path": "data/karura_contigs.json",
                            "junction_catalog_asset_id": "junction-catalog-1",
                            "start_junction_id": "alpha",
                            "end_junction_id": "beta",
                            "seed": 7,
                        },
                        "config": {},
                        "start": {
                            "junction_id": "alpha",
                            "name": "Alpha",
                            "graph_node_id": 1,
                            "incident_contig_ids": [],
                            "location": {"lat": -1.0, "lon": 36.0},
                            "notes": "",
                            "tags": [],
                        },
                        "end": {
                            "junction_id": "beta",
                            "name": "Beta",
                            "graph_node_id": 2,
                            "incident_contig_ids": [],
                            "location": {"lat": -1.001, "lon": 36.001},
                            "notes": "",
                            "tags": [],
                        },
                        "routes": [],
                    }
                )
            )
            with self.assertRaisesRegex(ValueError, r"route asset\.config must not be empty"):
                load_route_asset_document(route_path, label="route asset")


if __name__ == "__main__":
    unittest.main()
