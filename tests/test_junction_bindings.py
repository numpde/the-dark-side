from __future__ import annotations

from types import SimpleNamespace
import unittest

from the_dark_side.junction_bindings import build_junction_bindings
from the_dark_side.karura_routing import resolve_junction_ref


class JunctionBindingsTest(unittest.TestCase):
    def test_build_junction_bindings_and_resolve_ref(self) -> None:
        graph = SimpleNamespace(
            asset_id="graph-1",
            nodes={
                10: SimpleNamespace(id=10, lat=-1.0, lon=36.0),
                20: SimpleNamespace(id=20, lat=-1.001, lon=36.001),
            },
            adjacency={
                10: [(7, 20)],
                20: [(7, 10), (9, 20)],
            },
        )
        catalog = {
            "meta": {"asset_id": "junction-catalog-1", "asset_kind": "junction_catalog"},
            "junctions": [
                {
                    "id": "alpha",
                    "name": "Alpha",
                    "location": {"lat": -1.00005, "lon": 36.00005},
                    "notes": "demo",
                    "tags": ["test"],
                }
            ],
        }

        bindings = build_junction_bindings(catalog, graph)
        self.assertEqual(bindings["meta"]["graph_asset_id"], "graph-1")
        self.assertEqual(bindings["bindings"][0]["graph_node_id"], 10)
        self.assertEqual(bindings["bindings"][0]["incident_contig_ids"], [7])

        ref = resolve_junction_ref(catalog, "alpha", "graph-1", bindings)
        self.assertEqual(ref.graph_node_id, 10)
        self.assertEqual(ref.incident_contig_ids, (7,))
        self.assertEqual(ref.name, "Alpha")


if __name__ == "__main__":
    unittest.main()
