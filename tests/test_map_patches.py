from __future__ import annotations

import unittest

from the_dark_side.apply_karura_patches import apply_patchset, build_inside_karura, compute_way_record
from the_dark_side.karura_common import include_ride_way
from the_dark_side.download_karura_map import BoundaryComponent, BoundaryRecord, KaruraMap, NodeRecord


class MapPatchPipelineTest(unittest.TestCase):
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
            patchset_path="curated/karura_map_patches.json",
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
            patchset_path="curated/karura_map_patches.json",
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
            patchset_path="curated/karura_map_patches.json",
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
            patchset_path="curated/karura_map_patches.json",
        )

        self.assertNotEqual(first.meta["patchset_digest"], second.meta["patchset_digest"])
        self.assertNotEqual(first.meta["asset_id"], second.meta["asset_id"])

    def test_asset_id_changes_when_gap_fill_switch_changes(self) -> None:
        base_map = self.build_map()
        first = apply_patchset(
            base_map,
            patchset={"meta": {"patchset_id": "ops"}, "patches": []},
            source_map="data/karura_map.json",
            patchset_path="curated/karura_map_patches.json",
            fill_segment_gaps=True,
        )
        second = apply_patchset(
            base_map,
            patchset={"meta": {"patchset_id": "ops"}, "patches": []},
            source_map="data/karura_map.json",
            patchset_path="curated/karura_map_patches.json",
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
            patchset_path="curated/karura_map_patches.json",
        )

        self.assertIn(30, patched.ways)
        self.assertEqual(patched.ways[30].segment_pairs, [[101, 102]])
        self.assertEqual(patched.ways[30].inside_length_m, 0.0)

    def test_context_only_tag_stays_out_of_ride_graph(self) -> None:
        self.assertFalse(
            include_ride_way(
                999,
                {"highway": "path", "local:context_only": "yes"},
            )
        )

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
        self.assertFalse(inside_karura((0.3, 0.3)))
        self.assertTrue(inside_karura((0.8, 0.8)))
        self.assertTrue(inside_karura((2.4, 2.4)))


if __name__ == "__main__":
    unittest.main()
