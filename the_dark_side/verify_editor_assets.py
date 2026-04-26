#!/usr/bin/env python3

"""Verify editor-facing derived assets against canonical inputs."""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from types import SimpleNamespace

from .asset_pipeline_cli import add_editor_asset_args
from .apply_karura_patches import apply_patchset, load_patchset
from .build_karura_contigs import build_contigs
from .download_karura_map import load_map
from .junction_bindings import build_junction_bindings, load_junction_catalog
from .karura_common import (
    CONTIGS_JSON,
    EDITOR_MANIFEST_JSON,
    FRONTEND_MANIFEST_JSON,
    JUNCTION_BINDINGS_JSON,
    JUNCTIONS_JSON,
    MAP_JSON,
    MAP_PATCHES_JSON,
    PATCHED_MAP_JSON,
    SOURCE_ASSET_PATHS,
    WEB_GENERATED_DIR,
    WEB_SOURCE_DIR,
    repo_rel,
)
from .karura_common import include_ride_way
from .rebuild_editor_assets import build_editor_manifest, build_frontend_manifest
from .verify_helpers import assert_equal, load_json, normalized
from .web_assets import build_editor_graph_payload_from_map


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    add_editor_asset_args(parser, include_output_editor_manifest=True)
    parser.add_argument("--output-frontend-manifest", type=Path, default=FRONTEND_MANIFEST_JSON)
    return parser.parse_args(argv)


def assert_contains(label: str, haystack: str, needle: str) -> None:
    if needle not in haystack:
        raise SystemExit(f"{label} is stale; expected to find {needle!r}")


def assert_not_contains(label: str, haystack: str, needle: str) -> None:
    if needle in haystack:
        raise SystemExit(f"{label} is stale; unexpected legacy reference {needle!r}")


def assert_regex(label: str, haystack: str, pattern: str) -> None:
    if not re.search(pattern, haystack, flags=re.MULTILINE | re.DOTALL):
        raise SystemExit(f"{label} is stale; expected to match /{pattern}/")


def assert_not_regex(label: str, haystack: str, pattern: str) -> None:
    if re.search(pattern, haystack, flags=re.MULTILINE | re.DOTALL):
        raise SystemExit(f"{label} is stale; unexpected legacy pattern /{pattern}/")


def extract_single_inline_module_script(path: Path) -> str:
    html = path.read_text()
    matches = re.findall(
        r"<script\s+type=\"module\">(.*?)</script>",
        html,
        flags=re.MULTILINE | re.DOTALL,
    )
    if len(matches) != 1:
        raise SystemExit(f"{path} is stale; expected exactly one inline module bootstrap script")
    return matches[0]


def verify_sources_synced() -> None:
    for canonical_path in SOURCE_ASSET_PATHS:
        expected_path = WEB_SOURCE_DIR / canonical_path.name
        if not expected_path.exists():
            raise SystemExit(f"missing published source asset: {expected_path}; run rebuild_editor_assets and commit")
        assert_equal(
            str(expected_path),
            expected_path.read_text(),
            canonical_path.read_text(),
            rebuild_hint="run rebuild_editor_assets and commit",
        )


def verify_frontend_bootstrap_contract() -> None:
    index_bootstrap = extract_single_inline_module_script(WEB_GENERATED_DIR.parent / "index.html")
    editor_bootstrap = extract_single_inline_module_script(WEB_GENERATED_DIR.parent / "editor.html")
    app_js = (WEB_GENERATED_DIR.parent / "app.js").read_text()
    editor_js = (WEB_GENERATED_DIR.parent / "editor.js").read_text()

    assert_regex(
        "web/index.html",
        index_bootstrap,
        r'fetch\(\s*"\./generated/frontend-manifest\.json"\s*,\s*\{\s*cache:\s*"no-store"\s*\}\s*\)',
    )
    assert_regex("web/index.html", index_bootstrap, r'manifest\?\.\s*modules\?\.\s*app_version')
    assert_regex("web/index.html", index_bootstrap, r'if\s*\(\s*!version\s*\)\s*\{\s*throw new Error\("Frontend manifest is missing modules\.app_version"\)')
    assert_regex("web/index.html", index_bootstrap, r'const specifier = `\./app\.js\?v=\$\{encodeURIComponent\(version\)\}`')
    assert_not_regex("web/index.html", index_bootstrap, r'"\./app\.js"')

    assert_regex(
        "web/editor.html",
        editor_bootstrap,
        r'fetch\(\s*"\./generated/frontend-manifest\.json"\s*,\s*\{\s*cache:\s*"no-store"\s*\}\s*\)',
    )
    assert_regex("web/editor.html", editor_bootstrap, r'manifest\?\.\s*modules\?\.\s*editor_version')
    assert_regex("web/editor.html", editor_bootstrap, r'if\s*\(\s*!version\s*\)\s*\{\s*throw new Error\("Frontend manifest is missing modules\.editor_version"\)')
    assert_regex("web/editor.html", editor_bootstrap, r'const specifier = `\./editor\.js\?v=\$\{encodeURIComponent\(version\)\}`')
    assert_not_regex("web/editor.html", editor_bootstrap, r'"\./editor\.js"')

    assert_regex("web/app.js", app_js, r'new URL\("\./generated/app-manifest\.json", window\.location\.href\)')
    assert_regex("web/app.js", app_js, r'fetch\(appManifestUrl,\s*\{\s*cache:\s*"no-store"\s*\}\)')
    assert_regex("web/app.js", app_js, r'validateAppManifest\(await response\.json\(\)\)')
    assert_regex("web/app.js", app_js, r'await import\(`\./runtime-contracts\.mjs\$\{moduleSuffix\}`\)')
    assert_regex("web/app.js", app_js, r'await import\(`\./planner-worker-contracts\.mjs\$\{moduleSuffix\}`\)')
    assert_regex("web/app.js", app_js, r'function requireModuleVersion\(\)')
    assert_regex("web/app.js", app_js, r'throw new Error\("App runtime is missing required module version"\)')
    assert_regex("web/app.js", app_js, r'return \[junction\.location\.lat, junction\.location\.lon\];')
    assert_regex("web/app.js", app_js, r'function requireScenario\(')
    assert_regex("web/app.js", app_js, r'function junctionById\(')
    assert_regex("web/app.js", app_js, r'url\.searchParams\.set\("v", appState\.manifest\.planner\.network_version\)')
    assert_regex("web/app.js", app_js, r'await import\(`\./gpx\.mjs\$\{moduleSuffix\}`\)')
    assert_regex("web/app.js", app_js, r'workerUrl\.searchParams\.set\("v", MODULE_VERSION\)')
    assert_regex("web/app.js", app_js, r'parsePlannerWorkerResponse\(event\.data\)')
    assert_not_regex("web/app.js", app_js, r'function requireObject\(')
    assert_not_regex("web/app.js", app_js, r'function requireArray\(')
    assert_not_regex("web/app.js", app_js, r'function requireString\(')
    assert_not_regex("web/app.js", app_js, r'function requireFiniteNumber\(')
    assert_not_regex("web/app.js", app_js, r'function requireInteger\(')
    assert_not_regex("web/app.js", app_js, r'function validateAppManifest\(')
    assert_not_contains("web/app.js", app_js, "generated/karura-network.geojson")
    assert_not_contains("web/app.js", app_js, "generated/catalog.json")
    assert_not_contains("web/app.js", app_js, "junction.lat")
    assert_not_contains("web/app.js", app_js, "junction.lon")
    assert_not_contains("web/app.js", app_js, "|| area.scenarios[0]")
    assert_not_contains("web/app.js", app_js, "return scenario.id")
    assert_not_contains("web/app.js", app_js, 'searchParams.get("v") || ""')

    assert_regex("web/editor.js", editor_js, r'new URL\("\./generated/editor-manifest\.json", window\.location\.href\)')
    assert_regex("web/editor.js", editor_js, r'fetchJson\(editorManifestUrl,\s*\{\s*cache:\s*"no-store"\s*\}\)')
    assert_regex("web/editor.js", editor_js, r'validateEditorManifest\(')
    assert_regex("web/editor.js", editor_js, r'await import\(`\./runtime-contracts\.mjs\$\{moduleSuffix\}`\)')
    assert_regex("web/editor.js", editor_js, r'function requireModuleVersion\(\)')
    assert_regex("web/editor.js", editor_js, r'throw new Error\("Editor runtime is missing required module version"\)')
    assert_regex("web/editor.js", editor_js, r'url\.searchParams\.set\("v", appState\.editorManifest\.editor\.network_version\)')
    assert_regex("web/editor.js", editor_js, r'url\.searchParams\.set\("v", appState\.editorManifest\.meta\.patchset_digest\)')
    assert_regex("web/editor.js", editor_js, r'await import\(`\./editor-state\.mjs\$\{moduleSuffix\}`\)')
    assert_regex("web/editor.js", editor_js, r'await import\(`\./karura-policy\.mjs\$\{moduleSuffix\}`\)')
    assert_not_regex("web/editor.js", editor_js, r'function requireObject\(')
    assert_not_regex("web/editor.js", editor_js, r'function requireString\(')
    assert_not_regex("web/editor.js", editor_js, r'function validateEditorManifest\(')
    assert_not_contains("web/editor.js", editor_js, "generated/karura-editor-network.geojson")
    assert_not_contains("web/editor.js", editor_js, "source/karura-map-patches.json")
    assert_not_contains("web/editor.js", editor_js, '|| "–"')
    assert_not_contains("web/editor.js", editor_js, 'searchParams.get("v") || ""')

    route_worker_js = (WEB_GENERATED_DIR.parent / "route-worker.js").read_text()
    assert_regex("web/route-worker.js", route_worker_js, r'new Error\("Route worker is missing required module version"\)')
    assert_regex("web/route-worker.js", route_worker_js, r'import\(`\./planner-worker-contracts\.mjs\$\{moduleSuffix\}`\)')
    assert_regex("web/route-worker.js", route_worker_js, r'workerContracts\.parsePlannerWorkerRequest\(event\.data\)')
    assert_regex("web/route-worker.js", route_worker_js, r'workerContracts\.validatePlannerWorkerInitPayload\(payload\)')
    assert_regex("web/route-worker.js", route_worker_js, r'workerContracts\.validatePlannerWorkerPlanPayload\(payload\)')
    assert_regex("web/route-worker.js", route_worker_js, r'import\(`\./route-planner\.mjs\$\{moduleSuffix\}`\)')
    assert_not_regex("web/route-worker.js", route_worker_js, r'function requireObject\(')
    assert_not_regex("web/route-worker.js", route_worker_js, r'function requireString\(')
    assert_not_regex("web/route-worker.js", route_worker_js, r'function requireInteger\(')
    assert_not_regex("web/route-worker.js", route_worker_js, r'function requireRouteHistory\(')
    assert_not_regex("web/route-worker.js", route_worker_js, r'function parseWorkerRequest\(')
    assert_not_contains("web/route-worker.js", route_worker_js, 'searchParams.get("v") || ""')
    route_planner_js = (WEB_GENERATED_DIR.parent / "route-planner.mjs").read_text()
    assert_regex("web/route-planner.mjs", route_planner_js, r'import\s*\{\s*karuraTodayString,\s*isCurrentlyUnavailable\s*\}\s*from\s*"\./karura-policy\.mjs"')
    assert_regex("web/route-planner.mjs", route_planner_js, r'mcts_time_budget_ms:\s*requireFiniteNumber\(')
    assert_regex("web/route-planner.mjs", route_planner_js, r'mcts_progress_interval_iterations:\s*requireInteger\(')
    assert_not_contains("web/route-planner.mjs", route_planner_js, "plannerConfig.mcts_time_budget_ms == null")
    assert_not_contains("web/route-planner.mjs", route_planner_js, "plannerConfig.mcts_progress_interval_iterations == null")


def build_expected(args: argparse.Namespace) -> tuple[dict, dict, dict, dict, dict, dict]:
    baseline_map = load_map(args.map_json)
    patchset = load_patchset(args.patches_json)
    expected_patched_map = apply_patchset(
        baseline_map,
        patchset=patchset,
        source_map=repo_rel(args.map_json),
        patchset_path=repo_rel(args.patches_json),
        fill_segment_gaps=args.fill_segment_gaps,
        respect_inner_rings=args.respect_inner_rings,
    ).to_dict()
    expected_contigs = build_contigs(
        expected_patched_map,
        source_map=repo_rel(args.patched_map_json),
        patchset=patchset,
        patchset_path=repo_rel(args.patches_json),
        include_way=include_ride_way,
        graph_mode="ride",
    )
    graph = SimpleNamespace(
        asset_id=expected_contigs["meta"]["asset_id"],
        nodes={
            int(node_id): SimpleNamespace(
                id=int(node_id),
                lat=float(node_payload["lat"]),
                lon=float(node_payload["lon"]),
            )
            for node_id, node_payload in expected_contigs["nodes"].items()
        },
        adjacency={},
    )
    for contig in expected_contigs["contigs"]:
        first, second = [int(node_id) for node_id in contig["endpoint_node_ids"]]
        graph.adjacency.setdefault(first, []).append((int(contig["id"]), second))
        if first != second:
            graph.adjacency.setdefault(second, []).append((int(contig["id"]), first))
    junction_catalog = load_junction_catalog(args.junctions_json)
    expected_bindings = build_junction_bindings(
        junction_catalog,
        graph,
        junctions_path=args.junctions_json,
        graph_path=args.contigs_json,
    )
    expected_editor_graph, expected_editor_network = build_editor_graph_payload_from_map(
        editor_map_payload=expected_patched_map,
        editor_map_json=args.patched_map_json,
        editor_patches_json=args.patches_json,
    )
    expected_manifest = build_editor_manifest(args, expected_patched_map, expected_contigs, expected_bindings, expected_editor_graph)
    expected_frontend_manifest = build_frontend_manifest()
    return expected_patched_map, expected_contigs, expected_bindings, expected_editor_network, expected_manifest, expected_frontend_manifest


def verify_editor_assets(args: argparse.Namespace) -> dict:
    output_frontend_manifest = getattr(args, "output_frontend_manifest", FRONTEND_MANIFEST_JSON)
    verify_sources_synced()
    verify_frontend_bootstrap_contract()
    (
        expected_patched_map,
        expected_contigs,
        expected_bindings,
        expected_editor_network,
        expected_manifest,
        expected_frontend_manifest,
    ) = build_expected(args)
    actual_patched_map = load_json(args.patched_map_json)
    actual_contigs = load_json(args.contigs_json)
    actual_bindings = load_json(args.junction_bindings_json)
    actual_editor_network = load_json(args.output_editor_network)
    actual_manifest = load_json(args.output_editor_manifest)
    actual_frontend_manifest = load_json(output_frontend_manifest)
    rebuild_hint = "rebuild editor assets and commit the derived output"
    assert_equal(str(args.patched_map_json), actual_patched_map, expected_patched_map, rebuild_hint=rebuild_hint)
    assert_equal(str(args.contigs_json), actual_contigs, expected_contigs, rebuild_hint=rebuild_hint)
    assert_equal(
        str(args.junction_bindings_json),
        normalized(actual_bindings),
        normalized(expected_bindings),
        rebuild_hint=rebuild_hint,
    )
    assert_equal(str(args.output_editor_network), actual_editor_network, expected_editor_network, rebuild_hint=rebuild_hint)
    assert_equal(
        str(args.output_editor_manifest),
        normalized(actual_manifest),
        normalized(expected_manifest),
        rebuild_hint=rebuild_hint,
    )
    assert_equal(
        str(output_frontend_manifest),
        normalized(actual_frontend_manifest),
        normalized(expected_frontend_manifest),
        rebuild_hint=rebuild_hint,
    )
    return {
        "verified": True,
        "ride_graph_asset_id": actual_contigs["meta"]["asset_id"],
        "editor_graph_asset_id": actual_manifest["meta"]["editor_graph_asset_id"],
        "junction_bindings_asset_id": actual_bindings["meta"]["asset_id"],
        "editor_manifest": str(args.output_editor_manifest),
    }


def main() -> None:
    args = parse_args()
    print(json.dumps(verify_editor_assets(args), indent=2))


if __name__ == "__main__":
    main()
