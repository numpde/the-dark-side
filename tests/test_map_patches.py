from __future__ import annotations

from datetime import date
import json
from pathlib import Path
import tempfile
import unittest

from the_dark_side.asset_contracts import load_required_json, load_required_patchset
from the_dark_side.apply_karura_patches import apply_patchset, build_inside_karura, compute_way_record
from the_dark_side.build_karura_contigs import build_contigs
from the_dark_side.karura_common import (
    LOCAL_BOUNDARY_ZONE_TAG,
    include_baseline_way,
    include_editor_way,
    include_ride_way,
    is_currently_unavailable,
)
from the_dark_side.download_karura_map import (
    BoundaryComponent,
    BoundaryRecord,
    KaruraMap,
    NodeRecord,
    build_boundary_zone_classifier,
)
from the_dark_side.route_policy import apply_route_policy_bindings, build_route_policy_bindings


class MapPatchPipelineTest(unittest.TestCase):
    def test_missing_canonical_json_raises_instead_of_falling_back(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            missing_path = Path(tmpdir) / "missing.json"
            with self.assertRaises(FileNotFoundError):
                load_required_json(missing_path, label="patchset file")

    def test_malformed_patchset_file_raises_instead_of_loading(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            patchset_path = Path(tmpdir) / "patches.json"
            patchset_path.write_text(json.dumps({"meta": {"patchset_id": "oops"}, "patches": []}))
            with self.assertRaisesRegex(ValueError, r"patchset file\.meta\.asset_kind"):
                load_required_patchset(patchset_path, label="patchset file")

    def build_map(self) -> KaruraMap:
        nodes = {
            1: NodeRecord(id=1, lat=0.0, lon=0.0),
            2: NodeRecord(id=2, lat=0.0, lon=1.0),
            3: NodeRecord(id=3, lat=1.0, lon=1.0),
            4: NodeRecord(id=4, lat=1.0, lon=0.0),
            11: NodeRecord(id=11, lat=0.20, lon=0.20),
            12: NodeRecord(id=12, lat=0.35, lon=0.35),
            13: NodeRecord(id=13, lat=0.50, lon=0.50),
        }
        boundary = BoundaryRecord(
            relation_id=13626194,
            relation_tags={"name": "Karura"},
            outer_rings=[[1, 2, 3, 4, 1]],
            inner_rings=[],
        )
        inside_karura = build_inside_karura(boundary, nodes)
        ways = {
            10: compute_way_record(
                way_id=10,
                node_ids=[11, 12],
                tags={"highway": "path", "name": "Original"},
                nodes=nodes,
                inside_karura=inside_karura,
            ),
            20: compute_way_record(
                way_id=20,
                node_ids=[12, 13],
                tags={"highway": "track"},
                nodes=nodes,
                inside_karura=inside_karura,
            ),
        }
        return KaruraMap(
            meta={"asset_id": "karura-map-source", "asset_kind": "map"},
            boundary=boundary,
            nodes=nodes,
            ways=ways,
        )

    def test_noop_patchset_produces_derived_map(self) -> None:
        patched = apply_patchset(
            self.build_map(),
            patchset={"meta": {"patchset_id": "noop"}, "patches": []},
            source_map="data/karura_map.json",
            patchset_path="source/karura-map-patches.json",
        )
        self.assertEqual(len(patched.ways), 2)
        self.assertEqual(patched.meta["patchset_id"], "noop")
        self.assertEqual(patched.meta["applied_patch_ids"], [])
        self.assertEqual(len(patched.meta["patchset_digest"]), 12)
        self.assertTrue(
            patched.meta["asset_id"].startswith("karura-map-patched-from-karura-map-source-noop-")
        )

    def test_add_update_replace_and_remove_way(self) -> None:
        patched = apply_patchset(
            self.build_map(),
            patchset={
                "meta": {"patchset_id": "ops"},
                "patches": [
                    {
                        "id": "retag-original",
                        "op": "update_way_tags",
                        "way_id": 10,
                        "set": {"surface": "gravel"},
                        "remove": ["name"],
                    },
                    {
                        "id": "replace-original-geometry",
                        "op": "replace_way_geometry",
                        "way_id": 10,
                        "node_ids": [11, 14],
                        "nodes": [{"id": 14, "lat": 0.28, "lon": 0.58}],
                    },
                    {
                        "id": "drop-secondary",
                        "op": "remove_way",
                        "way_id": 20,
                    },
                    {
                        "id": "add-local-connector",
                        "op": "add_way",
                        "way_id": -100,
                        "node_ids": [14, -1],
                        "nodes": [{"id": -1, "lat": 0.44, "lon": 0.76}],
                        "tags": {"highway": "path", "name": "Local connector"},
                    },
                ],
            },
            source_map="data/karura_map.json",
            patchset_path="source/karura-map-patches.json",
        )

        self.assertEqual(sorted(patched.ways), [-100, 10])
        self.assertEqual(patched.meta["applied_patch_ids"], [
            "retag-original",
            "replace-original-geometry",
            "drop-secondary",
            "add-local-connector",
        ])
        self.assertEqual(patched.ways[10].node_ids, [11, 14])
        self.assertEqual(patched.ways[10].tags["surface"], "gravel")
        self.assertNotIn("name", patched.ways[10].tags)
        self.assertEqual(patched.ways[-100].tags["name"], "Local connector")
        self.assertIn(-1, patched.nodes)
        self.assertIn(14, patched.nodes)

    def test_asset_id_changes_when_patch_content_changes_without_patchset_rename(self) -> None:
        base_map = self.build_map()
        first = apply_patchset(
            base_map,
            patchset={
                "meta": {"patchset_id": "ops"},
                "patches": [
                    {
                        "id": "retag-original",
                        "op": "update_way_tags",
                        "way_id": 10,
                        "set": {"surface": "gravel"},
                    }
                ],
            },
            source_map="data/karura_map.json",
            patchset_path="source/karura-map-patches.json",
        )
        second = apply_patchset(
            base_map,
            patchset={
                "meta": {"patchset_id": "ops"},
                "patches": [
                    {
                        "id": "retag-original",
                        "op": "update_way_tags",
                        "way_id": 10,
                        "set": {"surface": "dirt"},
                    }
                ],
            },
            source_map="data/karura_map.json",
            patchset_path="source/karura-map-patches.json",
        )

        self.assertNotEqual(first.meta["patchset_digest"], second.meta["patchset_digest"])
        self.assertNotEqual(first.meta["asset_id"], second.meta["asset_id"])

    def test_asset_id_changes_when_gap_fill_switch_changes(self) -> None:
        base_map = self.build_map()
        first = apply_patchset(
            base_map,
            patchset={"meta": {"patchset_id": "ops"}, "patches": []},
            source_map="data/karura_map.json",
            patchset_path="source/karura-map-patches.json",
            fill_segment_gaps=True,
        )
        second = apply_patchset(
            base_map,
            patchset={"meta": {"patchset_id": "ops"}, "patches": []},
            source_map="data/karura_map.json",
            patchset_path="source/karura-map-patches.json",
            fill_segment_gaps=False,
        )

        self.assertNotEqual(first.meta["patchset_digest"], second.meta["patchset_digest"])
        self.assertNotEqual(first.meta["asset_id"], second.meta["asset_id"])

    def test_add_way_can_force_include_outside_boundary_segments(self) -> None:
        base_map = self.build_map()
        patched = apply_patchset(
            base_map,
            patchset={
                "meta": {"patchset_id": "outside"},
                "patches": [
                    {
                        "id": "add-outside-way",
                        "op": "add_way",
                        "way_id": 30,
                        "boundary_mode": "all_segments",
                        "node_ids": [101, 102],
                        "nodes": [
                            {"id": 101, "lat": 1.5, "lon": 1.5},
                            {"id": 102, "lat": 1.8, "lon": 1.8},
                        ],
                        "tags": {"highway": "service"},
                    }
                ],
            },
            source_map="data/karura_map.json",
            patchset_path="source/karura-map-patches.json",
        )

        self.assertIn(30, patched.ways)
        self.assertEqual(patched.ways[30].segment_pairs, [[101, 102]])
        self.assertEqual(patched.ways[30].inside_length_m, 0.0)

    def test_update_contig_tags_is_ignored_by_map_patch_pipeline(self) -> None:
        patched = apply_patchset(
            self.build_map(),
            patchset={
                "meta": {"patchset_id": "contig-only"},
                "patches": [
                    {
                        "id": "editor-policy-contig-1",
                        "op": "update_contig_tags",
                        "contig_id": 1,
                        "set": {"local:unavailable_until": "2099-12-31"},
                    }
                ],
            },
            source_map="data/karura_map.json",
            patchset_path="source/karura-map-patches.json",
        )

        self.assertEqual(sorted(patched.ways), [10, 20])
        self.assertEqual(patched.meta["applied_patch_ids"], [])

    def test_context_only_tag_stays_out_of_ride_graph(self) -> None:
        self.assertFalse(
            include_ride_way(
                999,
                {"highway": "path", "local:context_only": "yes"},
            )
        )

    def test_highway_is_included_by_default_in_ride_graph(self) -> None:
        self.assertTrue(
            include_ride_way(
                643633767,
                {
                    "highway": "trunk",
                },
            )
        )

    def test_parking_aisle_is_included_by_default_in_ride_graph(self) -> None:
        self.assertTrue(
            include_ride_way(
                723312824,
                {
                    "highway": "service",
                    "service": "parking_aisle",
                },
            )
        )

    def test_parking_area_is_included_by_default_in_ride_graph(self) -> None:
        self.assertTrue(
            include_ride_way(
                487923440,
                {
                    "amenity": "parking",
                    "parking": "surface",
                },
            )
        )

    def test_parking_area_is_included_in_editor_baseline(self) -> None:
        self.assertTrue(
            include_editor_way(
                487923440,
                {
                    "amenity": "parking",
                    "parking": "surface",
                },
            )
        )

    def test_local_exclude_keeps_way_out_of_ride_graph(self) -> None:
        self.assertFalse(
            include_ride_way(
                123,
                {
                    "highway": "path",
                    "local:routing_state": "exclude",
                },
            )
        )

    def test_future_unavailable_until_keeps_way_out_of_ride_graph(self) -> None:
        self.assertFalse(
            include_ride_way(
                124,
                {
                    "highway": "path",
                    "local:unavailable_until": "2099-12-31",
                },
            )
        )

    def test_past_unavailable_until_allows_way_back_into_ride_graph(self) -> None:
        self.assertTrue(
            include_ride_way(
                124,
                {
                    "highway": "path",
                    "local:unavailable_until": "2000-01-01",
                },
            )
        )

    def test_legacy_temporary_unavailability_still_keeps_way_out_of_ride_graph(self) -> None:
        self.assertFalse(
            include_ride_way(
                124,
                {
                    "highway": "path",
                    "local:availability": "temporarily_unavailable",
                },
            )
        )

    def test_is_currently_unavailable_uses_inclusive_until_date(self) -> None:
        tags = {"local:unavailable_until": "2026-05-01"}
        self.assertTrue(is_currently_unavailable(tags, on_date=date(2026, 5, 1)))
        self.assertFalse(is_currently_unavailable(tags, on_date=date(2026, 5, 2)))

    def test_build_contigs_applies_contig_policy_tags(self) -> None:
        payload = self.build_map().to_dict()
        contig_graph = build_contigs(
            payload,
            source_map="data/karura_map.json",
        )
        route_policy = {
            "meta": {"asset_kind": "route_policy", "asset_id": "contig-tags"},
            "rules": [
                {
                    "id": "editor-policy-contig-1",
                    "selector": {"way_ids": [10, 20], "node_ids": [11, 12, 13]},
                    "policy": {
                        "unavailable_until": "2099-12-31",
                        "bicycle_direction": "forward",
                    },
                }
            ],
        }
        bindings = build_route_policy_bindings(route_policy, contig_graph)
        contig_graph = apply_route_policy_bindings(
            contig_graph,
            bindings,
            route_policy_path="source/karura-route-policy.json",
        )

        first = contig_graph["contigs"][0]
        self.assertEqual(first["node_ids"], [11, 12, 13])
        self.assertEqual(first["tags"]["local:unavailable_until"], "2099-12-31")
        self.assertEqual(first["tags"]["local:bicycle_direction"], "forward")

    def test_build_contigs_rejects_invalid_contig_policy_values(self) -> None:
        payload = self.build_map().to_dict()
        contig_graph = build_contigs(payload, source_map="data/karura_map.json")
        with self.assertRaisesRegex(ValueError, "routing_state must be include or exclude"):
            build_route_policy_bindings(
                {
                    "meta": {"asset_kind": "route_policy", "asset_id": "contig-tags"},
                    "rules": [
                        {
                            "id": "editor-policy-contig-1",
                            "selector": {"way_ids": [10, 20], "node_ids": [11, 12, 13]},
                            "policy": {"routing_state": "sideways"},
                        }
                    ],
                },
                contig_graph,
            )

    def test_build_contigs_rejects_stale_contig_signature(self) -> None:
        payload = self.build_map().to_dict()
        contig_graph = build_contigs(payload, source_map="data/karura_map.json")
        with self.assertRaises(ValueError):
            build_route_policy_bindings(
                {
                    "meta": {"asset_kind": "route_policy", "asset_id": "contig-tags"},
                    "rules": [
                        {
                            "id": "editor-policy-contig-1",
                            "selector": {"way_ids": [10, 20], "node_ids": [11, 12]},
                            "policy": {"unavailable_until": "2099-12-31"},
                        }
                    ],
                },
                contig_graph,
            )

    def test_build_contigs_rejects_ambiguous_route_policy_selector(self) -> None:
        contig_graph = {
            "meta": {"asset_id": "graph"},
            "contigs": [
                {"id": 1, "way_ids": [10], "node_ids": [11, 12, 13], "tags": {}},
                {"id": 2, "way_ids": [10], "node_ids": [13, 12, 11], "tags": {}},
            ],
        }
        with self.assertRaisesRegex(ValueError, "selector is ambiguous on the current graph"):
            build_route_policy_bindings(
                {
                    "meta": {"asset_kind": "route_policy", "asset_id": "contig-tags"},
                    "rules": [
                        {
                            "id": "editor-policy-contig-1",
                            "selector": {"way_ids": [10], "node_ids": [11, 12, 13]},
                            "policy": {"routing_state": "exclude"},
                        }
                    ],
                },
                contig_graph,
            )

    def test_build_contigs_asset_id_includes_graph_mode(self) -> None:
        payload = self.build_map().to_dict()
        ride_graph = build_contigs(
            payload,
            source_map="data/karura_map.json",
            graph_mode="ride",
        )
        editor_graph = build_contigs(
            payload,
            source_map="data/karura_map.json",
            graph_mode="editor",
        )
        self.assertNotEqual(ride_graph["meta"]["asset_id"], editor_graph["meta"]["asset_id"])
        self.assertIn("karura-contigs-ride-from-", ride_graph["meta"]["asset_id"])
        self.assertIn("karura-contigs-editor-from-", editor_graph["meta"]["asset_id"])

    def test_build_contigs_splits_at_route_policy_boundaries(self) -> None:
        payload = self.build_map().to_dict()
        route_policy = {
            "meta": {"asset_kind": "route_policy", "asset_id": "policy-split"},
            "rules": [
                {
                    "id": "rule-1",
                    "selector": {"way_ids": [10], "node_ids": [11, 12]},
                    "policy": {"routing_state": "exclude"},
                }
            ],
        }
        contig_graph = build_contigs(
            payload,
            source_map="data/karura_map.json",
            include_way=include_baseline_way,
            route_policy=route_policy,
            graph_mode="ride",
        )
        self.assertEqual([contig["node_ids"] for contig in contig_graph["contigs"]], [[11, 12], [12, 13]])
        self.assertEqual(contig_graph["contigs"][0]["tags"]["local:routing_state"], "exclude")
        self.assertEqual(contig_graph["contigs"][1]["tags"], {LOCAL_BOUNDARY_ZONE_TAG: "core"})

    def test_build_contigs_can_include_policy_selected_nonbaseline_way(self) -> None:
        payload = self.build_map().to_dict()
        payload["ways"]["20"]["tags"] = {"name": "Nonbaseline shortcut"}
        route_policy = {
            "meta": {"asset_kind": "route_policy", "asset_id": "policy-include"},
            "rules": [
                {
                    "id": "rule-include",
                    "selector": {"way_ids": [20], "node_ids": [12, 13]},
                    "policy": {"routing_state": "include"},
                }
            ],
        }
        contig_graph = build_contigs(
            payload,
            source_map="data/karura_map.json",
            include_way=include_baseline_way,
            route_policy=route_policy,
            graph_mode="ride",
        )
        self.assertEqual([contig["node_ids"] for contig in contig_graph["contigs"]], [[11, 12], [12, 13]])
        self.assertEqual(contig_graph["contigs"][1]["tags"]["local:routing_state"], "include")

    def test_build_contigs_only_includes_policy_selected_way_for_overlapping_segment(self) -> None:
        payload = self.build_map().to_dict()
        payload["ways"]["20"]["tags"] = {"name": "Unselected overlapping segment"}
        payload["ways"]["30"] = {
            "id": 30,
            "node_ids": [12, 13],
            "tags": {"name": "Selected overlapping segment"},
            "segment_pairs": [[12, 13]],
            "segment_zones": ["core"],
            "total_length_m": payload["ways"]["20"]["total_length_m"],
            "inside_length_m": payload["ways"]["20"]["inside_length_m"],
            "buffer_length_m": 0.0,
            "bounds": payload["ways"]["20"]["bounds"],
        }
        route_policy = {
            "meta": {"asset_kind": "route_policy", "asset_id": "policy-overlap"},
            "rules": [
                {
                    "id": "rule-include-overlap",
                    "selector": {"way_ids": [30], "node_ids": [12, 13]},
                    "policy": {"routing_state": "include"},
                }
            ],
        }
        contig_graph = build_contigs(
            payload,
            source_map="data/karura_map.json",
            include_way=include_baseline_way,
            route_policy=route_policy,
            graph_mode="ride",
        )
        self.assertEqual([contig["node_ids"] for contig in contig_graph["contigs"]], [[11, 12], [12, 13]])
        self.assertEqual(contig_graph["contigs"][1]["way_ids"], [30])
        self.assertEqual(contig_graph["contigs"][1]["tags"]["local:routing_state"], "include")

    def test_compute_way_record_keeps_segment_if_either_endpoint_is_inside(self) -> None:
        nodes = {
            1: NodeRecord(id=1, lat=0.0, lon=0.0),
            2: NodeRecord(id=2, lat=0.0, lon=1.0),
            3: NodeRecord(id=3, lat=1.0, lon=1.0),
            4: NodeRecord(id=4, lat=1.0, lon=0.0),
            10: NodeRecord(id=10, lat=0.9, lon=0.9),
            11: NodeRecord(id=11, lat=0.9, lon=2.0),
        }
        boundary = BoundaryRecord(
            relation_id=13626194,
            relation_tags={"name": "Karura"},
            outer_rings=[[1, 2, 3, 4, 1]],
            inner_rings=[],
        )
        inside_karura = build_inside_karura(boundary, nodes)
        record = compute_way_record(
            way_id=77,
            node_ids=[10, 11],
            tags={"highway": "path"},
            nodes=nodes,
            inside_karura=inside_karura,
        )
        self.assertEqual(record.segment_pairs, [[10, 11]])
        self.assertGreater(record.inside_length_m, 0.0)

    def test_compute_way_record_marks_buffer_segments_and_keeps_them(self) -> None:
        nodes = {
            1: NodeRecord(id=1, lat=0.0, lon=0.0),
            2: NodeRecord(id=2, lat=0.0, lon=1.0),
            3: NodeRecord(id=3, lat=1.0, lon=1.0),
            4: NodeRecord(id=4, lat=1.0, lon=0.0),
            10: NodeRecord(id=10, lat=0.9, lon=1.00015),
            11: NodeRecord(id=11, lat=0.9, lon=1.00035),
        }
        boundary = BoundaryRecord(
            relation_id=13626194,
            relation_tags={"name": "Karura"},
            outer_rings=[[1, 2, 3, 4, 1]],
            inner_rings=[],
        )
        inside_karura = build_inside_karura(boundary, nodes)
        boundary_zone = build_boundary_zone_classifier(boundary, nodes, boundary_buffer_m=60.0)
        record = compute_way_record(
            way_id=80,
            node_ids=[10, 11],
            tags={"highway": "path"},
            nodes=nodes,
            inside_karura=inside_karura,
            boundary_zone_for_point=boundary_zone,
        )
        self.assertEqual(record.segment_pairs, [[10, 11]])
        self.assertEqual(record.segment_zones, ["buffer"])
        self.assertEqual(record.inside_length_m, 0.0)
        self.assertGreater(record.buffer_length_m, 0.0)

    def test_compute_way_record_fills_gap_between_kept_segments(self) -> None:
        nodes = {
            1: NodeRecord(id=1, lat=0.0, lon=0.0),
            2: NodeRecord(id=2, lat=0.0, lon=1.0),
            3: NodeRecord(id=3, lat=1.0, lon=1.0),
            4: NodeRecord(id=4, lat=1.0, lon=0.0),
            10: NodeRecord(id=10, lat=0.9, lon=0.9),
            11: NodeRecord(id=11, lat=0.9, lon=1.2),
            12: NodeRecord(id=12, lat=0.9, lon=1.3),
            13: NodeRecord(id=13, lat=0.8, lon=0.8),
        }
        boundary = BoundaryRecord(
            relation_id=13626194,
            relation_tags={"name": "Karura"},
            outer_rings=[[1, 2, 3, 4, 1]],
            inner_rings=[],
        )
        inside_karura = build_inside_karura(boundary, nodes)
        record = compute_way_record(
            way_id=78,
            node_ids=[10, 11, 12, 13],
            tags={"highway": "path"},
            nodes=nodes,
            inside_karura=inside_karura,
        )
        self.assertEqual(record.segment_pairs, [[10, 11], [11, 12], [12, 13]])

    def test_compute_way_record_can_disable_gap_fill(self) -> None:
        nodes = {
            1: NodeRecord(id=1, lat=0.0, lon=0.0),
            2: NodeRecord(id=2, lat=0.0, lon=1.0),
            3: NodeRecord(id=3, lat=1.0, lon=1.0),
            4: NodeRecord(id=4, lat=1.0, lon=0.0),
            10: NodeRecord(id=10, lat=0.9, lon=0.9),
            11: NodeRecord(id=11, lat=0.9, lon=1.2),
            12: NodeRecord(id=12, lat=0.9, lon=1.3),
            13: NodeRecord(id=13, lat=0.8, lon=0.8),
        }
        boundary = BoundaryRecord(
            relation_id=13626194,
            relation_tags={"name": "Karura"},
            outer_rings=[[1, 2, 3, 4, 1]],
            inner_rings=[],
        )
        inside_karura = build_inside_karura(boundary, nodes)
        record = compute_way_record(
            way_id=79,
            node_ids=[10, 11, 12, 13],
            tags={"highway": "path"},
            nodes=nodes,
            inside_karura=inside_karura,
            fill_segment_gaps=False,
        )
        self.assertEqual(record.segment_pairs, [[10, 11], [12, 13]])

    def test_boundary_union_uses_components(self) -> None:
        nodes = {
            1: NodeRecord(id=1, lat=0.0, lon=0.0),
            2: NodeRecord(id=2, lat=0.0, lon=1.0),
            3: NodeRecord(id=3, lat=1.0, lon=1.0),
            4: NodeRecord(id=4, lat=1.0, lon=0.0),
            5: NodeRecord(id=5, lat=2.0, lon=2.0),
            6: NodeRecord(id=6, lat=2.0, lon=3.0),
            7: NodeRecord(id=7, lat=3.0, lon=3.0),
            8: NodeRecord(id=8, lat=3.0, lon=2.0),
            9: NodeRecord(id=9, lat=0.2, lon=0.2),
            10: NodeRecord(id=10, lat=0.2, lon=0.4),
            11: NodeRecord(id=11, lat=0.4, lon=0.4),
            12: NodeRecord(id=12, lat=0.4, lon=0.2),
        }
        boundary = BoundaryRecord(
            relation_id=13626194,
            relation_tags={"name": "Union"},
            outer_rings=[[1, 2, 3, 4, 1], [5, 6, 7, 8, 5]],
            inner_rings=[[9, 10, 11, 12, 9]],
            components=[
                BoundaryComponent(
                    relation_id=13626194,
                    relation_tags={"name": "Forest"},
                    outer_rings=[[1, 2, 3, 4, 1]],
                    inner_rings=[[9, 10, 11, 12, 9]],
                ),
                BoundaryComponent(
                    relation_id=15417497,
                    relation_tags={"name": "Playground"},
                    outer_rings=[[5, 6, 7, 8, 5]],
                    inner_rings=[],
                ),
            ],
        )
        inside_karura = build_inside_karura(boundary, nodes)
        self.assertTrue(inside_karura((0.3, 0.3)))
        self.assertTrue(inside_karura((0.8, 0.8)))
        self.assertTrue(inside_karura((2.4, 2.4)))

    def test_boundary_can_respect_inner_rings_when_requested(self) -> None:
        nodes = {
            1: NodeRecord(id=1, lat=0.0, lon=0.0),
            2: NodeRecord(id=2, lat=0.0, lon=1.0),
            3: NodeRecord(id=3, lat=1.0, lon=1.0),
            4: NodeRecord(id=4, lat=1.0, lon=0.0),
            9: NodeRecord(id=9, lat=0.2, lon=0.2),
            10: NodeRecord(id=10, lat=0.2, lon=0.4),
            11: NodeRecord(id=11, lat=0.4, lon=0.4),
            12: NodeRecord(id=12, lat=0.4, lon=0.2),
        }
        boundary = BoundaryRecord(
            relation_id=13626194,
            relation_tags={"name": "Union"},
            outer_rings=[[1, 2, 3, 4, 1]],
            inner_rings=[[9, 10, 11, 12, 9]],
        )
        inside_karura = build_inside_karura(boundary, nodes, respect_inner_rings=True)
        self.assertFalse(inside_karura((0.3, 0.3)))
        self.assertTrue(inside_karura((0.8, 0.8)))

    def test_buffer_zone_is_default_excluded_from_ride_graph(self) -> None:
        payload = {
            "meta": {"asset_id": "buffer-map", "asset_kind": "patched_map"},
            "boundary": {"relation_id": 1, "relation_tags": {}, "outer_rings": [], "inner_rings": []},
            "nodes": {
                "1": {"id": 1, "lat": 0.0, "lon": 0.0},
                "2": {"id": 2, "lat": 0.0, "lon": 1.0},
                "3": {"id": 3, "lat": 0.0, "lon": 2.0},
            },
            "ways": {
                "10": {
                    "id": 10,
                    "node_ids": [1, 2],
                    "tags": {"highway": "path"},
                    "segment_pairs": [[1, 2]],
                    "segment_zones": ["core"],
                    "total_length_m": 100.0,
                    "inside_length_m": 100.0,
                    "buffer_length_m": 0.0,
                    "bounds": [0.0, 0.0, 1.0, 0.0],
                },
                "20": {
                    "id": 20,
                    "node_ids": [2, 3],
                    "tags": {"highway": "path"},
                    "segment_pairs": [[2, 3]],
                    "segment_zones": ["buffer"],
                    "total_length_m": 100.0,
                    "inside_length_m": 0.0,
                    "buffer_length_m": 100.0,
                    "bounds": [1.0, 0.0, 2.0, 0.0],
                },
            },
        }
        contig_graph = build_contigs(payload, source_map="data/karura_map_patched.json")
        self.assertEqual([contig["node_ids"] for contig in contig_graph["contigs"]], [[1, 2]])
        self.assertEqual(contig_graph["contigs"][0]["tags"][LOCAL_BOUNDARY_ZONE_TAG], "core")

    def test_explicit_route_policy_include_can_reenable_buffer_segment(self) -> None:
        payload = {
            "meta": {"asset_id": "buffer-map", "asset_kind": "patched_map"},
            "boundary": {"relation_id": 1, "relation_tags": {}, "outer_rings": [], "inner_rings": []},
            "nodes": {
                "1": {"id": 1, "lat": 0.0, "lon": 0.0},
                "2": {"id": 2, "lat": 0.0, "lon": 1.0},
                "3": {"id": 3, "lat": 0.0, "lon": 2.0},
            },
            "ways": {
                "10": {
                    "id": 10,
                    "node_ids": [1, 2],
                    "tags": {"highway": "path"},
                    "segment_pairs": [[1, 2]],
                    "segment_zones": ["core"],
                    "total_length_m": 100.0,
                    "inside_length_m": 100.0,
                    "buffer_length_m": 0.0,
                    "bounds": [0.0, 0.0, 1.0, 0.0],
                },
                "20": {
                    "id": 20,
                    "node_ids": [2, 3],
                    "tags": {"highway": "path"},
                    "segment_pairs": [[2, 3]],
                    "segment_zones": ["buffer"],
                    "total_length_m": 100.0,
                    "inside_length_m": 0.0,
                    "buffer_length_m": 100.0,
                    "bounds": [1.0, 0.0, 2.0, 0.0],
                },
            },
        }
        route_policy = {
            "meta": {"asset_kind": "route_policy", "asset_id": "buffer-include"},
            "rules": [
                {
                    "id": "rule-buffer-include",
                    "selector": {"way_ids": [20], "node_ids": [2, 3]},
                    "policy": {"routing_state": "include"},
                }
            ],
        }
        contig_graph = build_contigs(
            payload,
            source_map="data/karura_map_patched.json",
            include_way=include_baseline_way,
            route_policy=route_policy,
            graph_mode="ride",
        )
        self.assertEqual([contig["node_ids"] for contig in contig_graph["contigs"]], [[1, 2], [2, 3]])
        self.assertEqual(contig_graph["contigs"][1]["tags"][LOCAL_BOUNDARY_ZONE_TAG], "buffer")
        self.assertEqual(contig_graph["contigs"][1]["tags"]["local:routing_state"], "include")


if __name__ == "__main__":
    unittest.main()
