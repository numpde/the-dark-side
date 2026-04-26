from __future__ import annotations

import json
from pathlib import Path
import tempfile
import unittest

from the_dark_side.build_config import (
    DEFAULT_CATALOG_BUILD_SOURCE,
    DEFAULT_CATALOG_BUILD_CONFIG,
    catalog_build_config_digest,
    load_catalog_build_config,
)


class BuildConfigTest(unittest.TestCase):
    def test_load_catalog_build_config_merges_defaults(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "catalog_build.json"
            path.write_text(json.dumps({"debug_catalog": {"seed_end": 9, "algorithms": ["beam"]}}))
            config = load_catalog_build_config(path)

        self.assertEqual(config["seed_end"], 9)
        self.assertEqual(config["algorithms"], ["beam"])
        self.assertEqual(config["seed_start"], DEFAULT_CATALOG_BUILD_CONFIG["seed_start"])

    def test_catalog_build_config_digest_changes_with_values(self) -> None:
        base = dict(DEFAULT_CATALOG_BUILD_CONFIG)
        changed = dict(base)
        changed["routes_per_scenario"] = base["routes_per_scenario"] + 1

        self.assertNotEqual(
            catalog_build_config_digest(base),
            catalog_build_config_digest(changed),
        )

    def test_browser_runtime_keys_are_present_in_defaults(self) -> None:
        self.assertIn("browser_selection_pool", DEFAULT_CATALOG_BUILD_CONFIG)
        self.assertIn("browser_selection_window", DEFAULT_CATALOG_BUILD_CONFIG)
        self.assertIn("browser_mcts_iterations", DEFAULT_CATALOG_BUILD_CONFIG)
        self.assertIn("browser_mcts_time_budget_ms", DEFAULT_CATALOG_BUILD_CONFIG)
        self.assertIn("browser_mcts_progress_interval_iterations", DEFAULT_CATALOG_BUILD_CONFIG)
        self.assertIn("browser_runtime", DEFAULT_CATALOG_BUILD_SOURCE)
        self.assertIn("planner", DEFAULT_CATALOG_BUILD_SOURCE)
        self.assertIn("debug_catalog", DEFAULT_CATALOG_BUILD_SOURCE)

    def test_load_catalog_build_config_rejects_non_object(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "catalog_build.json"
            path.write_text(json.dumps([1, 2, 3]))
            with self.assertRaises(ValueError):
                load_catalog_build_config(path)

    def test_load_catalog_build_config_rejects_invalid_browser_runtime_settings(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "catalog_build.json"
            path.write_text(json.dumps({"browser_runtime": {"browser_mcts_time_budget_ms": 0}}))
            with self.assertRaises(ValueError):
                load_catalog_build_config(path)

    def test_load_catalog_build_config_rejects_mixed_flat_and_sectioned_keys(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "catalog_build.json"
            path.write_text(json.dumps({"debug_catalog": {}, "seed_end": 9}))
            with self.assertRaises(ValueError):
                load_catalog_build_config(path)


if __name__ == "__main__":
    unittest.main()
