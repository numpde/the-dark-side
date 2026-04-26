from __future__ import annotations

import json
from pathlib import Path
import tempfile
import unittest

from the_dark_side.karura_routing import load_route_graph, validate_route_graph_document


class RouteGraphTest(unittest.TestCase):
    def build_sample_graph_payload(self) -> dict:
        return {
            "meta": {
                "asset_id": "graph-1",
                "asset_kind": "contig_graph",
            },
            "nodes": {
                "1": {"lat": -1.0, "lon": 36.0},
                "2": {"lat": -1.001, "lon": 36.001},
            },
            "crossings": {
                "1": {"degree": 1},
                "2": {"degree": 1},
            },
            "contigs": [
                {
                    "id": 10,
                    "endpoint_node_ids": [1, 2],
                    "node_ids": [1, 2],
                    "length_m": 150.0,
                    "is_cycle": False,
                    "segment_count": 1,
                    "way_ids": [10],
                    "way_names": ["Path 10"],
                    "highway_types": {"path": 1},
                    "tags": {},
                }
            ],
        }

    def test_validate_route_graph_document_accepts_valid_payload(self) -> None:
        payload = self.build_sample_graph_payload()
        self.assertEqual(validate_route_graph_document(payload, label="route graph"), payload)

    def test_load_route_graph_rejects_missing_crossings(self) -> None:
        payload = self.build_sample_graph_payload()
        del payload["crossings"]
        with tempfile.TemporaryDirectory() as tmpdir:
            graph_path = Path(tmpdir) / "graph.json"
            graph_path.write_text(json.dumps(payload))
            with self.assertRaisesRegex(ValueError, r"route graph\.crossings must be a JSON object"):
                load_route_graph(graph_path)


if __name__ == "__main__":
    unittest.main()
