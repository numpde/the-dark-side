from __future__ import annotations

import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest

from the_dark_side.junction_bindings import build_junction_bindings, load_junction_catalog
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

    def test_resolve_requires_bindings_instead_of_legacy_asset_refs(self) -> None:
        catalog = {
            "meta": {"asset_id": "junction-catalog-1", "asset_kind": "junction_catalog"},
            "junctions": [
                {
                    "id": "alpha",
                    "name": "Alpha",
                    "location": {"lat": -1.0, "lon": 36.0},
                    "asset_refs": [
                        {
                            "asset_id": "graph-1",
                            "graph_node_id": 10,
                            "incident_contig_ids": [7],
                        }
                    ],
                }
            ],
        }
        with self.assertRaises(TypeError):
            resolve_junction_ref(catalog, "alpha", "graph-1")

    def test_load_junction_catalog_rejects_malformed_document(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            catalog_path = Path(tmpdir) / "junctions.json"
            catalog_path.write_text(json.dumps({"meta": {"asset_id": "junction-catalog-1"}, "junctions": []}))
            with self.assertRaisesRegex(ValueError, r"junction catalog\.meta\.asset_kind"):
                load_junction_catalog(catalog_path)


if __name__ == "__main__":
    unittest.main()
