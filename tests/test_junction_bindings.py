from __future__ import annotations

import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest

from the_dark_side.asset_contracts import load_required_junction_bindings, load_required_junction_catalog
from the_dark_side.junction_bindings import build_junction_bindings
from the_dark_side.karura_routing import (
    load_graph_junction_context,
    resolve_context_junction_ref,
    resolve_junction_ref,
)


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
                load_required_junction_catalog(catalog_path, label="junction catalog")

    def test_load_junction_bindings_rejects_malformed_document(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            bindings_path = Path(tmpdir) / "junction-bindings.json"
            bindings_path.write_text(
                json.dumps(
                    {
                        "meta": {
                            "asset_id": "junction-bindings-1",
                            "asset_kind": "junction_bindings",
                            "graph_asset_id": "graph-1",
                        },
                        "bindings": [],
                    }
                )
            )
            with self.assertRaisesRegex(ValueError, r"junction bindings\.meta\.junction_catalog_asset_id"):
                load_required_junction_bindings(bindings_path, label="junction bindings")

    def test_load_graph_junction_context_and_resolve_context_ref(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            tmpdir = Path(tmpdir)
            graph_path = tmpdir / "graph.json"
            catalog_path = tmpdir / "junctions.json"
            bindings_path = tmpdir / "junction-bindings.json"

            graph_path.write_text(
                json.dumps(
                    {
                        "meta": {"asset_id": "graph-1", "asset_kind": "contig_graph"},
                        "nodes": {
                            "10": {"lat": -1.0, "lon": 36.0},
                            "20": {"lat": -1.001, "lon": 36.001},
                        },
                        "crossings": {
                            "10": {"degree": 1},
                            "20": {"degree": 1},
                        },
                        "contigs": [
                            {
                                "id": 7,
                                "endpoint_node_ids": [10, 20],
                                "node_ids": [10, 20],
                                "length_m": 100.0,
                                "is_cycle": False,
                                "segment_count": 1,
                                "way_ids": [101],
                                "way_names": [],
                                "highway_types": {"track": 1},
                                "tags": {},
                            }
                        ],
                    }
                )
            )
            catalog_path.write_text(
                json.dumps(
                    {
                        "meta": {"asset_id": "junction-catalog-1", "asset_kind": "junction_catalog"},
                        "junctions": [
                            {
                                "id": "alpha",
                                "name": "Alpha",
                                "location": {"lat": -1.0, "lon": 36.0},
                                "notes": "",
                                "tags": [],
                            }
                        ],
                    }
                )
            )
            bindings_path.write_text(
                json.dumps(
                    {
                        "meta": {
                            "asset_id": "junction-bindings-1",
                            "asset_kind": "junction_bindings",
                            "graph_asset_id": "graph-1",
                            "junction_catalog_asset_id": "junction-catalog-1",
                        },
                        "bindings": [
                            {
                                "junction_id": "alpha",
                                "graph_node_id": 10,
                                "incident_contig_ids": [7],
                                "distance_m": 0.0,
                            }
                        ],
                    }
                )
            )

            context = load_graph_junction_context(
                contigs_json=graph_path,
                junctions_json=catalog_path,
                junction_bindings_json=bindings_path,
            )
            ref = resolve_context_junction_ref(context, "alpha")
            self.assertEqual(context.graph.asset_id, "graph-1")
            self.assertEqual(ref.graph_node_id, 10)

    def test_load_graph_junction_context_rejects_graph_binding_mismatch(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            tmpdir = Path(tmpdir)
            graph_path = tmpdir / "graph.json"
            catalog_path = tmpdir / "junctions.json"
            bindings_path = tmpdir / "junction-bindings.json"

            graph_path.write_text(
                json.dumps(
                    {
                        "meta": {"asset_id": "graph-1", "asset_kind": "contig_graph"},
                        "nodes": {
                            "10": {"lat": -1.0, "lon": 36.0},
                            "20": {"lat": -1.001, "lon": 36.001},
                        },
                        "crossings": {
                            "10": {"degree": 1},
                            "20": {"degree": 1},
                        },
                        "contigs": [
                            {
                                "id": 7,
                                "endpoint_node_ids": [10, 20],
                                "node_ids": [10, 20],
                                "length_m": 100.0,
                                "is_cycle": False,
                                "segment_count": 1,
                                "way_ids": [101],
                                "way_names": [],
                                "highway_types": {"track": 1},
                                "tags": {},
                            }
                        ],
                    }
                )
            )
            catalog_path.write_text(
                json.dumps(
                    {
                        "meta": {"asset_id": "junction-catalog-1", "asset_kind": "junction_catalog"},
                        "junctions": [
                            {
                                "id": "alpha",
                                "name": "Alpha",
                                "location": {"lat": -1.0, "lon": 36.0},
                                "notes": "",
                                "tags": [],
                            }
                        ],
                    }
                )
            )
            bindings_path.write_text(
                json.dumps(
                    {
                        "meta": {
                            "asset_id": "junction-bindings-1",
                            "asset_kind": "junction_bindings",
                            "graph_asset_id": "graph-2",
                            "junction_catalog_asset_id": "junction-catalog-1",
                        },
                        "bindings": [
                            {
                                "junction_id": "alpha",
                                "graph_node_id": 10,
                                "incident_contig_ids": [7],
                                "distance_m": 0.0,
                            }
                        ],
                    }
                )
            )

            with self.assertRaisesRegex(KeyError, "expected 'graph-1'"):
                load_graph_junction_context(
                    contigs_json=graph_path,
                    junctions_json=catalog_path,
                    junction_bindings_json=bindings_path,
                )


if __name__ == "__main__":
    unittest.main()
