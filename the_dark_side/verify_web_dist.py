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
    if f'./{expected_prefix}.js' in html:
        raise SystemExit(f"{html_path} is stale; built HTML must reference a hashed {expected_prefix} asset, not source {expected_prefix}.js")
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
    require_path(dist_dir / "vendor" / "leaflet" / "leaflet.css")
    require_path(dist_dir / "vendor" / "leaflet" / "leaflet.js")
    require_path(dist_dir / "vendor" / "leaflet" / "images" / "marker-icon.png")

    worker_assets = sorted(assets_dir.glob("route-worker-*.js"))
    if len(worker_assets) != 1:
        raise SystemExit(f"{assets_dir} is stale; expected exactly one hashed route-worker bundle")
    if sorted(assets_dir.glob("*.js")) != sorted(
        [dist_dir / index_script.removeprefix("./"), dist_dir / editor_script.removeprefix("./"), worker_assets[0]]
    ):
        raise SystemExit(f"{assets_dir} is stale; expected exactly one hashed app bundle, editor bundle, and worker bundle")

    frontend_manifest = generated_dir / "frontend-manifest.json"
    if frontend_manifest.exists():
        raise SystemExit(f"{frontend_manifest} should not exist in the built dist artifact")

    app_bundle_text = (dist_dir / index_script.removeprefix("./")).read_text()
    editor_bundle_text = (dist_dir / editor_script.removeprefix("./")).read_text()
    worker_bundle_text = worker_assets[0].read_text()
    index_html = (dist_dir / "index.html").read_text()
    editor_html = (dist_dir / "editor.html").read_text()
    for html_label, html_text in (("index.html", index_html), ("editor.html", editor_html)):
        if "https://unpkg.com/leaflet" in html_text:
            raise SystemExit(f"{html_label} must use the vendored Leaflet assets")
        if "./vendor/leaflet/leaflet.css" not in html_text or "./vendor/leaflet/leaflet.js" not in html_text:
            raise SystemExit(f"{html_label} must reference vendored Leaflet CSS and JS")
    for label, bundle_text in (
        ("built app bundle", app_bundle_text),
        ("built editor bundle", editor_bundle_text),
        ("built worker bundle", worker_bundle_text),
    ):
        if "frontend-manifest" in bundle_text:
            raise SystemExit(f"{label} is stale; built runtime must not reference frontend-manifest.json")
        if "module-context" in bundle_text or "entry-bootstrap" in bundle_text:
            raise SystemExit(f"{label} is stale; built runtime must not reference legacy bootstrap modules")
    if worker_assets[0].name not in app_bundle_text:
        raise SystemExit("built app bundle is stale; expected the hashed route-worker filename to be embedded")
    if "route-worker.js" in app_bundle_text:
        raise SystemExit("built app bundle is stale; expected hashed worker asset, not source route-worker.js")

    app_manifest = load_required_json(generated_dir / "app-manifest.json", label="built app manifest")
    editor_manifest = load_required_json(generated_dir / "editor-manifest.json", label="built editor manifest")

    require_path(generated_dir / app_manifest["planner"]["network_path"])
    require_path(generated_dir / app_manifest["planner"]["background_network_path"])
    for area_index, area in enumerate(app_manifest.get("areas", [])):
        if not isinstance(area.get("network_path"), str) or not area["network_path"]:
            raise SystemExit(f"built app manifest is stale; areas[{area_index}] is missing network_path")
        if not isinstance(area.get("background_network_path"), str) or not area["background_network_path"]:
            raise SystemExit(f"built app manifest is stale; areas[{area_index}] is missing background_network_path")
        require_path(generated_dir / area["network_path"])
        require_path(generated_dir / area["background_network_path"])
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
