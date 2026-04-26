from __future__ import annotations

import json
from pathlib import Path
import tempfile
import unittest

from the_dark_side.render_support import load_viewport


class RenderSupportTest(unittest.TestCase):
    def test_load_viewport_rejects_missing_viewport_object(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            viewport_path = Path(tmpdir) / "viewport.json"
            viewport_path.write_text(json.dumps({"score": 1}))
            with self.assertRaisesRegex(ValueError, r"viewport document\.viewport must be an object"):
                load_viewport(viewport_path)

    def test_load_viewport_rejects_non_numeric_center(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            viewport_path = Path(tmpdir) / "viewport.json"
            viewport_path.write_text(
                json.dumps(
                    {
                        "viewport": {
                            "center_x": "bad",
                            "center_y": 1.0,
                            "meters_per_px": 2.0,
                        }
                    }
                )
            )
            with self.assertRaisesRegex(ValueError, r"viewport document\.viewport\.center_x must be a finite number"):
                load_viewport(viewport_path)


if __name__ == "__main__":
    unittest.main()
