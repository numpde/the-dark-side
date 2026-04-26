from __future__ import annotations

import json
from pathlib import Path
import tempfile
import unittest

from the_dark_side.web_assets import network_geojson


class WebAssetsTest(unittest.TestCase):
    def test_network_geojson_rejects_partial_elevation_coverage(self) -> None:
        payload = {
            "nodes": {
                "1": {"lat": -1.24, "lon": 36.81},
                "2": {"lat": -1.241, "lon": 36.811},
            },
            "contigs": [
                {
                    "id": 10,
                    "length_m": 100.0,
                    "segment_count": 1,
                    "way_names": ["Path 10"],
                    "way_ids": [10],
                    "endpoint_node_ids": [1, 2],
                    "node_ids": [1, 2],
                    "tags": {},
                }
            ],
        }

        with self.assertRaisesRegex(ValueError, r"Missing elevation values for node ids: 2"):
            network_geojson(payload, node_elevations={1: 1800.0})

    def test_load_elevation_asset_rejects_malformed_payloads(self) -> None:
        from the_dark_side.web_assets import load_elevation_asset

        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "elevation.json"
            path.write_text(json.dumps({"meta": {"graph_asset_id": "graph-a"}, "nodes": []}))

            with self.assertRaisesRegex(ValueError, r"elevation asset\.nodes must be a JSON object"):
                load_elevation_asset(path, expected_graph_asset_id="graph-a")


if __name__ == "__main__":
    unittest.main()
