from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
import unittest

from the_dark_side.build_config import DEFAULT_CATALOG_BUILD_CONFIG
from the_dark_side.rebuild_app_assets import build_app_manifest


def manifest_args() -> SimpleNamespace:
    return SimpleNamespace(
        build_config_json=Path("source/catalog_build.json"),
        output_network=Path("karura-network.geojson"),
    )


def editor_manifest() -> dict:
    return {
        "meta": {
            "editor_graph_asset_id": "editor-graph-1",
            "route_policy_asset_id": "policy-1",
        },
        "editor": {
            "network_path": "karura-editor-network.geojson",
            "network_version": "editor-graph-1",
        },
    }


class RebuildAppAssetsTest(unittest.TestCase):
    def test_build_app_manifest_groups_junctions_by_area(self) -> None:
        graph = SimpleNamespace(
            asset_id="ride-graph-1",
            meta={},
            nodes={
                1: SimpleNamespace(lat=-1.25, lon=36.81),
                2: SimpleNamespace(lat=-1.24, lon=36.84),
            },
        )
        area_catalog = {
            "meta": {
                "asset_id": "areas-1",
            },
            "areas": [
                {
                    "id": "karura",
                    "name": "Karura Forest",
                    "boundary_components": [{"type": "relation", "id": 13626194}],
                },
                {
                    "id": "sigiria",
                    "name": "Sigiria Forest",
                    "boundary_components": [{"type": "way", "id": 24040003}],
                },
            ],
        }
        junction_catalog = {
            "meta": {
                "asset_id": "junctions-1",
            },
            "junctions": [
                {
                    "area_id": "karura",
                    "id": "karura_a",
                    "name": "Karura A",
                    "location": {"lat": -1.25, "lon": 36.81},
                },
                {
                    "area_id": "sigiria",
                    "id": "sigiria_gate_e",
                    "name": "Gate E / Limuru Road",
                    "location": {"lat": -1.2465946, "lon": 36.8151386},
                },
                {
                    "area_id": "sigiria",
                    "id": "sigiria_gate_f",
                    "name": "Gate F / Thigiri Lane",
                    "location": {"lat": -1.2406117, "lon": 36.7950299},
                },
            ],
        }
        junction_bindings = {
            "meta": {"asset_id": "bindings-1"},
            "bindings": [
                {"junction_id": "karura_a", "graph_node_id": 1},
                {"junction_id": "sigiria_gate_e", "graph_node_id": 2},
                {"junction_id": "sigiria_gate_f", "graph_node_id": 3},
            ],
        }

        manifest = build_app_manifest(
            manifest_args(),
            editor_manifest=editor_manifest(),
            graph=graph,
            area_catalog=area_catalog,
            junction_catalog=junction_catalog,
            junction_bindings=junction_bindings,
            build_config_payload=DEFAULT_CATALOG_BUILD_CONFIG,
            elevation_matches_graph=True,
        )

        self.assertEqual([area["id"] for area in manifest["areas"]], ["karura", "sigiria"])
        sigiria = manifest["areas"][1]
        self.assertEqual(sigiria["name"], "Sigiria Forest")
        self.assertEqual(sigiria["boundary_refs"], ["w24040003"])
        self.assertEqual(sigiria["network_path"], "karura-network-sigiria.geojson")
        self.assertEqual(sigiria["background_network_path"], "karura-editor-network.geojson")
        self.assertEqual(
            [junction["name"] for junction in sigiria["junctions"]],
            ["Gate E / Limuru Road", "Gate F / Thigiri Lane"],
        )
        self.assertEqual(
            [scenario["id"] for scenario in sigiria["scenarios"]],
            [
                "sigiria_gate_e__to__sigiria_gate_e",
                "sigiria_gate_e__to__sigiria_gate_f",
                "sigiria_gate_f__to__sigiria_gate_e",
                "sigiria_gate_f__to__sigiria_gate_f",
            ],
        )

    def test_build_app_manifest_rejects_unknown_junction_area(self) -> None:
        graph = SimpleNamespace(asset_id="ride-graph-1", meta={}, nodes={1: SimpleNamespace(lat=-1.25, lon=36.81)})
        area_catalog = {
            "meta": {"asset_id": "areas-1", "asset_kind": "area_catalog"},
            "areas": [
                {
                    "id": "karura",
                    "name": "Karura Forest",
                    "boundary_components": [{"type": "relation", "id": 13626194}],
                }
            ],
        }
        junction_catalog = {
            "meta": {"asset_id": "junctions-1", "asset_kind": "junction_catalog"},
            "junctions": [
                {
                    "area_id": "sigiria",
                    "id": "sigiria_gate_e",
                    "name": "Gate E / Limuru Road",
                    "location": {"lat": -1.2465946, "lon": 36.8151386},
                }
            ],
        }
        junction_bindings = {"meta": {"asset_id": "bindings-1"}, "bindings": [{"junction_id": "sigiria_gate_e", "graph_node_id": 1}]}

        with self.assertRaisesRegex(ValueError, r"unknown area ids: sigiria"):
            build_app_manifest(
                manifest_args(),
                editor_manifest=editor_manifest(),
                graph=graph,
                area_catalog=area_catalog,
                junction_catalog=junction_catalog,
                junction_bindings=junction_bindings,
                build_config_payload=DEFAULT_CATALOG_BUILD_CONFIG,
                elevation_matches_graph=True,
            )


if __name__ == "__main__":
    unittest.main()
