from __future__ import annotations

import json
from pathlib import Path
import tempfile
import unittest

from the_dark_side.build_config import (
    DEFAULT_CATALOG_BUILD_CONFIG,
    catalog_build_config_digest,
    load_catalog_build_config,
)


class BuildConfigTest(unittest.TestCase):
    def test_load_catalog_build_config_merges_defaults(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "catalog_build.json"
            path.write_text(json.dumps({"seed_end": 9, "algorithms": ["beam"]}))
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


if __name__ == "__main__":
    unittest.main()
