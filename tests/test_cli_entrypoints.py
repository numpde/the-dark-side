from __future__ import annotations

import subprocess
import unittest

from the_dark_side.karura_common import REPO_ROOT


CLI_MODULES = [
    "the_dark_side.download_karura_map",
    "the_dark_side.apply_karura_patches",
    "the_dark_side.build_karura_contigs",
    "the_dark_side.build_karura_elevation",
    "the_dark_side.render_karura_overlay",
    "the_dark_side.render_karura_route",
    "the_dark_side.render_karura_figures",
    "the_dark_side.plan_karura_route",
    "the_dark_side.benchmark_karura_routes",
    "the_dark_side.export_karura_web_catalog",
    "the_dark_side.rebuild_editor_assets",
    "the_dark_side.rebuild_app_assets",
    "the_dark_side.rebuild_all",
    "the_dark_side.verify_editor_assets",
    "the_dark_side.verify_app_assets",
    "the_dark_side.verify_web_dist",
    "the_dark_side.verify_assets",
]


class CliEntrypointTests(unittest.TestCase):
    def test_all_cli_entrypoints_bootstrap_with_help(self) -> None:
        for module in CLI_MODULES:
            with self.subTest(module=module):
                result = subprocess.run(
                    ["python3", "-m", module, "--help"],
                    cwd=REPO_ROOT,
                    capture_output=True,
                    text=True,
                )
                self.assertEqual(
                    result.returncode,
                    0,
                    msg=f"{module} --help failed:\nSTDOUT:\n{result.stdout}\nSTDERR:\n{result.stderr}",
                )
