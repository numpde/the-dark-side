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
from the_dark_side.benchmark_karura_routes import parse_args as parse_benchmark_args
from the_dark_side.export_karura_web_catalog import parse_args as parse_export_args
from the_dark_side.plan_karura_route import parse_args as parse_plan_args


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

    def test_plan_cli_reads_defaults_from_canonical_build_config(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "catalog_build.json"
            path.write_text(
                json.dumps(
                    {
                        "planner": {
                            "beam_width": 99,
                            "end_finish_unused_slack_m": 333.0,
                        }
                    }
                )
            )
            args = parse_plan_args(["--build-config-json", str(path)])

        self.assertEqual(args.beam_width, 99)
        self.assertEqual(args.end_finish_unused_slack_m, 333.0)

    def test_benchmark_cli_reads_defaults_from_canonical_build_config(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "catalog_build.json"
            path.write_text(
                json.dumps(
                    {
                        "planner": {
                            "mcts_iterations": 777,
                            "keep_best": 9,
                        }
                    }
                )
            )
            args = parse_benchmark_args(["--build-config-json", str(path)])

        self.assertEqual(args.mcts_iterations, 777)
        self.assertEqual(args.keep_best, 9)

    def test_export_cli_reads_defaults_from_canonical_build_config(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "catalog_build.json"
            path.write_text(
                json.dumps(
                    {
                        "debug_catalog": {
                            "routes_per_scenario": 4,
                            "selection_window": 11,
                        },
                        "planner": {
                            "beam_width": 71,
                        },
                    }
                )
            )
            args = parse_export_args(["--build-config-json", str(path)])

        self.assertEqual(args.routes_per_scenario, 4)
        self.assertEqual(args.selection_window, 11)
        self.assertEqual(args.beam_width, 71)


if __name__ == "__main__":
    unittest.main()
