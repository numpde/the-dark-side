#!/usr/bin/env python3

"""Verify the built dist/ artifact used for local preview and GitHub Pages."""

from __future__ import annotations

import argparse
import re
from pathlib import Path

from .asset_contracts import load_required_json
from .karura_common import DIST_DIR, print_json_document


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dist-dir", type=Path, default=DIST_DIR)
    return parser.parse_args(argv)


def require_path(path: Path) -> Path:
    if not path.exists():
        raise SystemExit(f"missing dist artifact: {path}")
    return path


def parse_entry_script(html_path: Path, expected_prefix: str) -> str:
    html = html_path.read_text()
    if "frontend-manifest" in html:
        raise SystemExit(f"{html_path} is stale; built HTML must not reference frontend-manifest.json")
    match = re.search(
        rf'<script\s+type="module"\s+src="((?:\./)?assets/{re.escape(expected_prefix)}-[A-Za-z0-9]+\.js)"\s*></script>',
        html,
    )
    if not match:
        raise SystemExit(
            f"{html_path} is stale; expected a single hashed {expected_prefix} module script under ./assets/"
        )
    if re.search(r"<script\s+type=\"module\">", html):
        raise SystemExit(f"{html_path} is stale; built HTML must not contain inline module bootstrap")
    return match.group(1)


def verify_web_dist(args: argparse.Namespace) -> dict:
    dist_dir = require_path(args.dist_dir)
    assets_dir = require_path(dist_dir / "assets")
    generated_dir = require_path(dist_dir / "generated")
    source_dir = require_path(dist_dir / "source")

    index_script = parse_entry_script(require_path(dist_dir / "index.html"), "app")
    editor_script = parse_entry_script(require_path(dist_dir / "editor.html"), "editor")
    require_path(dist_dir / index_script.removeprefix("./"))
    require_path(dist_dir / editor_script.removeprefix("./"))

    worker_assets = sorted(assets_dir.glob("route-worker-*.js"))
    if len(worker_assets) != 1:
        raise SystemExit(f"{assets_dir} is stale; expected exactly one hashed route-worker bundle")

    frontend_manifest = generated_dir / "frontend-manifest.json"
    if frontend_manifest.exists():
        raise SystemExit(f"{frontend_manifest} should not exist in the built dist artifact")

    app_manifest = load_required_json(generated_dir / "app-manifest.json", label="built app manifest")
    editor_manifest = load_required_json(generated_dir / "editor-manifest.json", label="built editor manifest")

    require_path(generated_dir / app_manifest["planner"]["network_path"])
    require_path(generated_dir / app_manifest["planner"]["background_network_path"])
    require_path(generated_dir / editor_manifest["editor"]["network_path"])

    route_policy_path = editor_manifest["meta"]["route_policy_path"]
    require_path(dist_dir / route_policy_path)
    require_path(source_dir / "catalog_build.json")
    require_path(source_dir / "karura-map-patches.json")
    require_path(source_dir / "karura-route-policy.json")

    return {
        "verified": True,
        "dist_dir": str(dist_dir),
        "app_entry": index_script,
        "editor_entry": editor_script,
        "worker_entry": worker_assets[0].name,
    }


def main() -> None:
    args = parse_args()
    print_json_document(verify_web_dist(args))


if __name__ == "__main__":
    main()
