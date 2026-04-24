from __future__ import annotations

import unittest

from the_dark_side.apply_karura_patches import apply_patchset, build_inside_karura, compute_way_record
from the_dark_side.download_karura_map import BoundaryRecord, KaruraMap, NodeRecord


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


if __name__ == "__main__":
    unittest.main()
