from __future__ import annotations

import json
from pathlib import Path
import tempfile
import unittest

from the_dark_side.karura_common import load_required_figure_catalog


class RenderFiguresTest(unittest.TestCase):
    def test_load_figure_catalog_rejects_malformed_document(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            catalog_path = Path(tmpdir) / "figures.json"
            catalog_path.write_text(
                json.dumps(
                    {
                        "meta": {
                            "asset_id": "figures-1",
                            "asset_kind": "figure_catalog",
                        },
                        "figures": [
                            {
                                "id": "junctions_primary",
                                "kind": "junction_figure",
                                "output_path": "../assets/figures/example.png",
                                "header": {
                                    "title": "Example",
                                    "subtitle": "Demo",
                                },
                            }
                        ],
                    }
                )
            )
            with self.assertRaisesRegex(ValueError, r"figure catalog\.figures\[0\]\.items"):
                load_required_figure_catalog(catalog_path, label="figure catalog")


if __name__ == "__main__":
    unittest.main()
