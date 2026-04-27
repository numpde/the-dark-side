#!/usr/bin/env python3

"""Verify editor-facing derived assets against canonical inputs."""

from __future__ import annotations

import argparse
import re
from pathlib import Path
from types import SimpleNamespace

from .asset_contracts import load_required_junction_catalog, load_required_patchset, load_required_json
from .asset_pipeline_cli import add_editor_asset_args
from .apply_karura_patches import apply_patchset
from .build_karura_contigs import build_contigs
from .download_karura_map import load_map
from .junction_bindings import build_junction_bindings
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
    print_json_document,
    repo_rel,
)
from .karura_common import include_ride_way
from .rebuild_editor_assets import build_editor_manifest, build_frontend_manifest
from .verify_helpers import assert_equal, normalized
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


def assert_uses_module_context(label: str, haystack: str, module_label: str) -> None:
    assert_regex(
        label,
        haystack,
        r'await import\(`\./module-context\.mjs\$\{new URL\(import\.meta\.url\)\.search\}`\)',
    )
    assert_regex(
        label,
        haystack,
        rf'requireVersionedModuleContext\(import\.meta,\s*"{re.escape(module_label)}"\)',
    )
    assert_not_regex(label, haystack, r"function requireModuleVersion\(")
    assert_not_contains(label, haystack, 'searchParams.get("v") || ""')


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
    route_controller_js = (WEB_GENERATED_DIR.parent / "route-controller.mjs").read_text()
    editor_js = (WEB_GENERATED_DIR.parent / "editor.js").read_text()
    planner_client_js = (WEB_GENERATED_DIR.parent / "planner-client.mjs").read_text()
    route_map_view_js = (WEB_GENERATED_DIR.parent / "route-map-view.mjs").read_text()
    route_runtime_js = (WEB_GENERATED_DIR.parent / "route-runtime.mjs").read_text()
    route_selection_controls_js = (WEB_GENERATED_DIR.parent / "route-selection-controls.mjs").read_text()
    route_shell_view_js = (WEB_GENERATED_DIR.parent / "route-shell-view.mjs").read_text()
    route_scenarios_js = (WEB_GENERATED_DIR.parent / "route-scenarios.mjs").read_text()
    route_summary_view_js = (WEB_GENERATED_DIR.parent / "route-summary-view.mjs").read_text()
    module_context_js = (WEB_GENERATED_DIR.parent / "module-context.mjs").read_text()
    entry_bootstrap_js = (WEB_GENERATED_DIR.parent / "entry-bootstrap.mjs").read_text()
    editor_asset_runtime_js = (WEB_GENERATED_DIR.parent / "editor-asset-runtime.mjs").read_text()
    editor_controller_js = (WEB_GENERATED_DIR.parent / "editor-controller.mjs").read_text()
    editor_policy_contracts_js = (WEB_GENERATED_DIR.parent / "editor-policy-contracts.mjs").read_text()
    editor_shell_view_js = (WEB_GENERATED_DIR.parent / "editor-shell-view.mjs").read_text()

    assert_regex(
        "web/index.html",
        index_bootstrap,
        r'fetch\(\s*"\./generated/frontend-manifest\.json"\s*,\s*\{\s*cache:\s*"no-store"\s*\}\s*\)',
    )
    assert_regex("web/index.html", index_bootstrap, r'manifest\?\.\s*modules\?\.\s*bootstrap_version')
    assert_regex("web/index.html", index_bootstrap, r'if\s*\(\s*!version\s*\)\s*\{\s*throw new Error\("Frontend manifest is missing modules\.bootstrap_version"\)')
    assert_regex("web/index.html", index_bootstrap, r'await import\(`\./entry-bootstrap\.mjs\?v=\$\{encodeURIComponent\(version\)\}`\)')
    assert_regex("web/index.html", index_bootstrap, r'await bootVersionedEntry\(\{\s*manifest,')
    assert_regex("web/index.html", index_bootstrap, r'entryVersionKey:\s*"app_version"')
    assert_regex("web/index.html", index_bootstrap, r'entryPath:\s*"\./app\.js"')
    assert_not_regex("web/index.html", index_bootstrap, r'await import\(`\./app\.js')

    assert_regex(
        "web/editor.html",
        editor_bootstrap,
        r'fetch\(\s*"\./generated/frontend-manifest\.json"\s*,\s*\{\s*cache:\s*"no-store"\s*\}\s*\)',
    )
    assert_regex("web/editor.html", editor_bootstrap, r'manifest\?\.\s*modules\?\.\s*bootstrap_version')
    assert_regex("web/editor.html", editor_bootstrap, r'if\s*\(\s*!version\s*\)\s*\{\s*throw new Error\("Frontend manifest is missing modules\.bootstrap_version"\)')
    assert_regex("web/editor.html", editor_bootstrap, r'await import\(`\./entry-bootstrap\.mjs\?v=\$\{encodeURIComponent\(version\)\}`\)')
    assert_regex("web/editor.html", editor_bootstrap, r'await bootVersionedEntry\(\{\s*manifest,')
    assert_regex("web/editor.html", editor_bootstrap, r'entryVersionKey:\s*"editor_version"')
    assert_regex("web/editor.html", editor_bootstrap, r'entryPath:\s*"\./editor\.js"')
    assert_not_regex("web/editor.html", editor_bootstrap, r'await import\(`\./editor\.js')

    assert_regex("web/entry-bootstrap.mjs", entry_bootstrap_js, r"export async function bootVersionedEntry\(")
    assert_regex("web/entry-bootstrap.mjs", entry_bootstrap_js, r"function requireManifestModuleVersion\(")
    assert_regex("web/entry-bootstrap.mjs", entry_bootstrap_js, r'manifest\?\.\s*modules\?\.\[key\]')
    assert_regex("web/entry-bootstrap.mjs", entry_bootstrap_js, r'requireManifestModuleVersion\(manifest,\s*bootstrapVersionKey\)')
    assert_regex("web/entry-bootstrap.mjs", entry_bootstrap_js, r'requireManifestModuleVersion\(manifest,\s*entryVersionKey\)')
    assert_regex("web/entry-bootstrap.mjs", entry_bootstrap_js, r'const specifier = `\$\{entryPath\}\?v=\$\{encodeURIComponent\(entryVersion\)\}`')
    assert_regex("web/entry-bootstrap.mjs", entry_bootstrap_js, r"export function renderBootstrapFailure\(")
    assert_not_regex("web/entry-bootstrap.mjs", entry_bootstrap_js, r'fetch\(')

    assert_regex("web/app.js", app_js, r'new URL\("\./generated/app-manifest\.json", window\.location\.href\)')
    assert_uses_module_context("web/app.js", app_js, "App runtime")
    assert_regex("web/app.js", app_js, r'await import\(`\./route-controller\.mjs\$\{moduleSuffix\}`\)')
    assert_regex("web/app.js", app_js, r'createRouteController\(\{')
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
    assert_not_regex("web/app.js", app_js, r'function ensurePlannerWorker\(')
    assert_not_regex("web/app.js", app_js, r'function scenarioHistoryKey\(')
    assert_not_regex("web/app.js", app_js, r'function routeSequenceSignature\(')
    assert_not_regex("web/app.js", app_js, r'function recentRoutesForScenario\(')
    assert_not_regex("web/app.js", app_js, r'function rememberRouteForScenario\(')
    assert_not_regex("web/app.js", app_js, r'function findScenario\(')
    assert_not_regex("web/app.js", app_js, r'function requireScenario\(')
    assert_not_regex("web/app.js", app_js, r'function junctionById\(')
    assert_not_regex("web/app.js", app_js, r'function scenarioLabelText\(')
    assert_not_regex("web/app.js", app_js, r'function canonicalSelectionFromQuery\(')
    assert_not_regex("web/app.js", app_js, r'function mixColor\(')
    assert_not_regex("web/app.js", app_js, r'function boundsToLeaflet\(')
    assert_not_regex("web/app.js", app_js, r'function junctionLatLon\(')
    assert_not_regex("web/app.js", app_js, r'function ensureMap\(')
    assert_not_regex("web/app.js", app_js, r'function formatDistance\(')
    assert_not_regex("web/app.js", app_js, r'function formatElevationChange\(')
    assert_not_regex("web/app.js", app_js, r'function setControlsDisabled\(')
    assert_not_regex("web/app.js", app_js, r'function updateRouteSurfaceState\(')
    assert_not_regex("web/app.js", app_js, r'function installShellPlaceholders\(')
    assert_not_regex("web/app.js", app_js, r'function showError\(')
    assert_not_regex("web/app.js", app_js, r'function clearError\(')
    assert_not_regex("web/app.js", app_js, r'function updateUrl\(')
    assert_not_regex("web/app.js", app_js, r'function replaceUrlWithSelection\(')
    assert_not_regex("web/app.js", app_js, r'function populateAreaOptions\(')
    assert_not_regex("web/app.js", app_js, r'function populateJunctionSelectors\(')
    assert_not_regex("web/app.js", app_js, r'function syncSelectionControlsFromQuery\(')
    assert_not_regex("web/app.js", app_js, r'function resolveScenarioSelection\(')
    assert_not_regex("web/app.js", app_js, r'function nextRouteSeed\(')
    assert_not_regex("web/app.js", app_js, r'function ensurePlannerClient\(')
    assert_not_regex("web/app.js", app_js, r'function sendWorkerMessage\(')
    assert_not_regex("web/app.js", app_js, r'function networkUrlForArea\(')
    assert_not_regex("web/app.js", app_js, r'function currentScenario\(')
    assert_not_regex("web/app.js", app_js, r'function currentJunctions\(')
    assert_not_regex("web/app.js", app_js, r'function updateDownloadLink\(')
    assert_not_regex("web/app.js", app_js, r'function updateSummary\(')
    assert_not_regex("web/app.js", app_js, r'function chooseRoute\(')
    assert_not_regex("web/app.js", app_js, r'function loadArea\(')
    assert_not_regex("web/app.js", app_js, r'function bindControls\(')
    assert_not_regex("web/app.js", app_js, r'async function boot\(')

    assert_uses_module_context("web/route-controller.mjs", route_controller_js, "Route controller module")
    assert_regex("web/route-controller.mjs", route_controller_js, r'await import\(`\./runtime-contracts\.mjs\$\{moduleSuffix\}`\)')
    assert_regex("web/route-controller.mjs", route_controller_js, r'await import\(`\./planner-worker-contracts\.mjs\$\{moduleSuffix\}`\)')
    assert_regex("web/route-controller.mjs", route_controller_js, r'await import\(`\./gpx\.mjs\$\{moduleSuffix\}`\)')
    assert_regex("web/route-controller.mjs", route_controller_js, r'await import\(`\./route-map-view\.mjs\$\{moduleSuffix\}`\)')
    assert_regex("web/route-controller.mjs", route_controller_js, r'await import\(`\./route-runtime\.mjs\$\{moduleSuffix\}`\)')
    assert_regex("web/route-controller.mjs", route_controller_js, r'await import\(`\./route-shell-view\.mjs\$\{moduleSuffix\}`\)')
    assert_regex("web/route-controller.mjs", route_controller_js, r'await import\(`\./route-selection-controls\.mjs\$\{moduleSuffix\}`\)')
    assert_regex("web/route-controller.mjs", route_controller_js, r'await import\(`\./route-summary-view\.mjs\$\{moduleSuffix\}`\)')
    assert_regex("web/route-controller.mjs", route_controller_js, r'await import\(`\./route-scenarios\.mjs\$\{moduleSuffix\}`\)')
    assert_regex("web/route-controller.mjs", route_controller_js, r'export function createRouteController\(')
    assert_regex("web/route-controller.mjs", route_controller_js, r'function networkUrlForArea\(')
    assert_regex("web/route-controller.mjs", route_controller_js, r'function currentScenario\(')
    assert_regex("web/route-controller.mjs", route_controller_js, r'function currentJunctions\(')
    assert_regex("web/route-controller.mjs", route_controller_js, r'function updateDownloadLink\(')
    assert_regex("web/route-controller.mjs", route_controller_js, r'function updateSummary\(')
    assert_regex("web/route-controller.mjs", route_controller_js, r'async function chooseRoute\(')
    assert_regex("web/route-controller.mjs", route_controller_js, r'async function loadArea\(')
    assert_regex("web/route-controller.mjs", route_controller_js, r'function bindControls\(')
    assert_regex("web/route-controller.mjs", route_controller_js, r'async function boot\(')
    assert_not_regex("web/route-controller.mjs", route_controller_js, r'^import .* from "\./')

    assert_regex("web/planner-client.mjs", planner_client_js, r'export function createPlannerClient\(')
    assert_contains("web/planner-client.mjs", planner_client_js, "parsePlannerWorkerResponse(event.data)")
    assert_contains("web/planner-client.mjs", planner_client_js, 'workerUrl.searchParams.set("v", moduleVersion)')
    assert_contains("web/planner-client.mjs", planner_client_js, "const workerBootedPromise = new Promise")
    assert_contains("web/planner-client.mjs", planner_client_js, 'if (type === "booted")')
    assert_contains("web/planner-client.mjs", planner_client_js, "await workerBootedPromise")
    assert_not_contains("web/planner-client.mjs", planner_client_js, "rejectPendingRequests(")
    assert_not_contains("web/planner-client.mjs", planner_client_js, 'new URL("./generated/app-manifest.json"')

    assert_uses_module_context("web/route-runtime.mjs", route_runtime_js, "Route runtime module")
    assert_regex("web/route-runtime.mjs", route_runtime_js, r'await import\(`\./planner-client\.mjs\$\{moduleSuffix\}`\)')
    assert_regex("web/route-runtime.mjs", route_runtime_js, r'export function createRouteRuntime\(')
    assert_regex("web/route-runtime.mjs", route_runtime_js, r'get plannerReady\(\)')
    assert_regex("web/route-runtime.mjs", route_runtime_js, r'nextRouteSeed\(\)')
    assert_regex("web/route-runtime.mjs", route_runtime_js, r'initializePlanner\(')
    assert_regex("web/route-runtime.mjs", route_runtime_js, r'requestRoute\(')
    assert_not_regex("web/route-runtime.mjs", route_runtime_js, r'function renderRouteSummary\(')
    assert_not_regex("web/route-runtime.mjs", route_runtime_js, r'^import .* from "\./')

    assert_regex("web/route-scenarios.mjs", route_scenarios_js, r'export function recentRoutesForScenario\(')
    assert_regex("web/route-scenarios.mjs", route_scenarios_js, r'export function rememberRouteForScenario\(')
    assert_regex("web/route-scenarios.mjs", route_scenarios_js, r'export function requireScenario\(')
    assert_regex("web/route-scenarios.mjs", route_scenarios_js, r'export function junctionsForScenario\(')
    assert_regex("web/route-scenarios.mjs", route_scenarios_js, r'export function resolveCanonicalSelection\(')
    assert_regex("web/route-scenarios.mjs", route_scenarios_js, r'export function resolveScenarioSelection\(')
    assert_not_regex("web/route-scenarios.mjs", route_scenarios_js, r'function setScenarioLabelParts\(')

    assert_regex("web/route-map-view.mjs", route_map_view_js, r'export function createRouteMapView\(')
    assert_regex("web/route-map-view.mjs", route_map_view_js, r'await import\(`\./karura-policy\.mjs\$\{moduleSuffix\}`\)')
    assert_regex("web/route-map-view.mjs", route_map_view_js, r'function mixColor\(')
    assert_regex("web/route-map-view.mjs", route_map_view_js, r'function boundsToLeaflet\(')
    assert_regex("web/route-map-view.mjs", route_map_view_js, r'function junctionLatLon\(')
    assert_regex("web/route-map-view.mjs", route_map_view_js, r'return \[junction\.location\.lat, junction\.location\.lon\];')
    assert_regex("web/route-map-view.mjs", route_map_view_js, r'function networkFeatureStyle\(')
    assert_regex("web/route-map-view.mjs", route_map_view_js, r'isCurrentlyUnavailable\(tags\)')
    assert_not_regex("web/route-map-view.mjs", route_map_view_js, r'function setScenarioLabelParts\(')

    assert_uses_module_context(
        "web/route-selection-controls.mjs",
        route_selection_controls_js,
        "Route selection controls module",
    )
    assert_regex("web/route-selection-controls.mjs", route_selection_controls_js, r'await import\(`\./route-scenarios\.mjs\$\{moduleSuffix\}`\)')
    assert_regex("web/route-selection-controls.mjs", route_selection_controls_js, r'export function installSelectionPlaceholders\(')
    assert_regex("web/route-selection-controls.mjs", route_selection_controls_js, r'export function populateJunctionSelectors\(')
    assert_regex("web/route-selection-controls.mjs", route_selection_controls_js, r'export function syncSelectorsFromQuery\(')
    assert_regex("web/route-selection-controls.mjs", route_selection_controls_js, r'export function canonicalizeSelectorScenario\(')
    assert_regex("web/route-selection-controls.mjs", route_selection_controls_js, r'export function replaceUrlWithSelection\(')
    assert_regex("web/route-selection-controls.mjs", route_selection_controls_js, r'export function syncUrlFromSelectors\(')
    assert_not_regex("web/route-selection-controls.mjs", route_selection_controls_js, r'function renderRouteSummary\(')
    assert_not_regex("web/route-selection-controls.mjs", route_selection_controls_js, r'^import .* from "\./')

    assert_uses_module_context("web/route-shell-view.mjs", route_shell_view_js, "Route shell view module")
    assert_regex("web/route-shell-view.mjs", route_shell_view_js, r'await import\(`\./route-selection-controls\.mjs\$\{moduleSuffix\}`\)')
    assert_regex("web/route-shell-view.mjs", route_shell_view_js, r'await import\(`\./route-summary-view\.mjs\$\{moduleSuffix\}`\)')
    assert_regex("web/route-shell-view.mjs", route_shell_view_js, r'export function setControlsDisabled\(')
    assert_regex("web/route-shell-view.mjs", route_shell_view_js, r'export function updateRouteSurfaceState\(')
    assert_regex("web/route-shell-view.mjs", route_shell_view_js, r'export function installShellPlaceholders\(')
    assert_regex("web/route-shell-view.mjs", route_shell_view_js, r'export function showError\(')
    assert_regex("web/route-shell-view.mjs", route_shell_view_js, r'export function clearError\(')
    assert_not_regex("web/route-shell-view.mjs", route_shell_view_js, r'function renderRouteSummary\(')
    assert_not_regex("web/route-shell-view.mjs", route_shell_view_js, r'^import .* from "\./')

    assert_regex("web/route-summary-view.mjs", route_summary_view_js, r'export function setSummaryText\(')
    assert_regex("web/route-summary-view.mjs", route_summary_view_js, r'export function renderRouteSummary\(')
    assert_regex("web/route-summary-view.mjs", route_summary_view_js, r'function formatDistance\(')
    assert_regex("web/route-summary-view.mjs", route_summary_view_js, r'function formatElevationChange\(')
    assert_regex("web/route-summary-view.mjs", route_summary_view_js, r'function animatedLoopArrow\(')
    assert_not_regex("web/route-summary-view.mjs", route_summary_view_js, r'function currentScenario\(')

    assert_regex("web/module-context.mjs", module_context_js, r"export function requireVersionedModuleContext\(")
    assert_regex("web/module-context.mjs", module_context_js, r'new URL\(importMeta\.url\)\.searchParams\.get\("v"\)')
    assert_regex("web/module-context.mjs", module_context_js, r'throw new Error\(`\$\{label\} is missing required module version`\)')

    assert_regex("web/editor.js", editor_js, r'new URL\("\./generated/editor-manifest\.json", window\.location\.href\)')
    assert_uses_module_context("web/editor.js", editor_js, "Editor runtime")
    assert_regex("web/editor.js", editor_js, r'await import\(`\./editor-controller\.mjs\$\{moduleSuffix\}`\)')
    assert_regex("web/editor.js", editor_js, r'const controller = createEditorController\(')
    assert_regex("web/editor.js", editor_js, r'controller\.boot\(\)\.catch\(')
    assert_not_regex("web/editor.js", editor_js, r'await import\(`\./runtime-contracts\.mjs\$\{moduleSuffix\}`\)')
    assert_not_regex("web/editor.js", editor_js, r'await import\(`\./editor-state\.mjs\$\{moduleSuffix\}`\)')
    assert_not_regex("web/editor.js", editor_js, r'await import\(`\./editor-asset-runtime\.mjs\$\{moduleSuffix\}`\)')
    assert_not_regex("web/editor.js", editor_js, r'await import\(`\./editor-map-view\.mjs\$\{moduleSuffix\}`\)')
    assert_not_regex("web/editor.js", editor_js, r'await import\(`\./editor-shell-view\.mjs\$\{moduleSuffix\}`\)')
    assert_not_regex("web/editor.js", editor_js, r'await import\(`\./karura-policy\.mjs\$\{moduleSuffix\}`\)')
    assert_not_regex("web/editor.js", editor_js, r'function requireObject\(')
    assert_not_regex("web/editor.js", editor_js, r'function requireString\(')
    assert_not_regex("web/editor.js", editor_js, r'function validateEditorManifest\(')
    assert_not_regex("web/editor.js", editor_js, r'function requireElement\(')
    assert_not_regex("web/editor.js", editor_js, r'function guard\(')
    assert_not_regex("web/editor.js", editor_js, r'function guardAsync\(')
    assert_not_regex("web/editor.js", editor_js, r'async function fetchJson\(')
    assert_not_regex("web/editor.js", editor_js, r'function waysUrlFromManifest\(')
    assert_not_regex("web/editor.js", editor_js, r'function patchesUrlFromManifest\(')
    assert_not_regex("web/editor.js", editor_js, r'function canonicalPatchFilename\(')
    assert_not_regex("web/editor.js", editor_js, r'async function readJsonFile\(')
    assert_not_regex("web/editor.js", editor_js, r'function ensureMap\(')
    assert_not_regex("web/editor.js", editor_js, r'function geometryEndpoints\(')
    assert_not_regex("web/editor.js", editor_js, r'function endpointMarker\(')
    assert_not_regex("web/editor.js", editor_js, r'function renderSelectedWay\(')
    assert_not_regex("web/editor.js", editor_js, r'function renderWays\(')
    assert_not_regex("web/editor.js", editor_js, r'function updateWayStyle\(')
    assert_not_regex("web/editor.js", editor_js, r'function updateAllWayStyles\(')
    assert_not_regex("web/editor.js", editor_js, r'function updateControls\(')
    assert_not_regex("web/editor.js", editor_js, r'function updateSelectedPolicy\(')
    assert_not_regex("web/editor.js", editor_js, r'function downloadJson\(')
    assert_not_regex("web/editor.js", editor_js, r'function exportPatchset\(')
    assert_not_regex("web/editor.js", editor_js, r'async function importPatchset\(')
    assert_not_regex("web/editor.js", editor_js, r'async function boot\(')
    assert_not_contains("web/editor.js", editor_js, "generated/karura-editor-network.geojson")
    assert_not_contains("web/editor.js", editor_js, "source/karura-map-patches.json")
    assert_not_contains("web/editor.js", editor_js, '|| "–"')
    assert_uses_module_context("web/editor-controller.mjs", editor_controller_js, "Editor controller module")
    assert_regex("web/editor-controller.mjs", editor_controller_js, r'await import\(`\./editor-state\.mjs\$\{moduleSuffix\}`\)')
    assert_regex("web/editor-controller.mjs", editor_controller_js, r'await import\(`\./editor-asset-runtime\.mjs\$\{moduleSuffix\}`\)')
    assert_regex("web/editor-controller.mjs", editor_controller_js, r'await import\(`\./editor-map-view\.mjs\$\{moduleSuffix\}`\)')
    assert_regex("web/editor-controller.mjs", editor_controller_js, r'await import\(`\./editor-shell-view\.mjs\$\{moduleSuffix\}`\)')
    assert_regex("web/editor-controller.mjs", editor_controller_js, r'await import\(`\./runtime-contracts\.mjs\$\{moduleSuffix\}`\)')
    assert_regex("web/editor-controller.mjs", editor_controller_js, r'export function createEditorController\(')
    assert_regex("web/editor-controller.mjs", editor_controller_js, r'function currentPatchDocument\(')
    assert_regex("web/editor-controller.mjs", editor_controller_js, r'function renderShell\(')
    assert_regex("web/editor-controller.mjs", editor_controller_js, r'function selectWay\(')
    assert_regex("web/editor-controller.mjs", editor_controller_js, r'function updateSelectedPolicy\(')
    assert_regex("web/editor-controller.mjs", editor_controller_js, r'function exportPatchset\(')
    assert_regex("web/editor-controller.mjs", editor_controller_js, r'async function importPatchset\(')
    assert_regex("web/editor-controller.mjs", editor_controller_js, r'async function boot\(')
    assert_not_regex("web/editor-controller.mjs", editor_controller_js, r'function requireElement\(')
    assert_not_regex("web/editor-controller.mjs", editor_controller_js, r'function guard\(')
    assert_not_regex("web/editor-controller.mjs", editor_controller_js, r'function guardAsync\(')
    assert_not_regex("web/editor-controller.mjs", editor_controller_js, r'function geometryEndpoints\(')
    assert_not_regex("web/editor-controller.mjs", editor_controller_js, r'function endpointMarker\(')
    assert_not_regex("web/editor-controller.mjs", editor_controller_js, r'^import .* from "\./')
    editor_map_view_js = (WEB_GENERATED_DIR.parent / "editor-map-view.mjs").read_text()
    assert_uses_module_context("web/editor-map-view.mjs", editor_map_view_js, "Editor map view module")
    assert_regex("web/editor-map-view.mjs", editor_map_view_js, r'export function styleForPolicy\(')
    assert_regex("web/editor-map-view.mjs", editor_map_view_js, r'export function createEditorMapView\(')
    assert_regex("web/editor-map-view.mjs", editor_map_view_js, r'function geometryEndpoints\(')
    assert_regex("web/editor-map-view.mjs", editor_map_view_js, r'function endpointMarker\(')
    assert_not_regex("web/editor-map-view.mjs", editor_map_view_js, r'^import .* from "\./')
    assert_uses_module_context("web/editor-asset-runtime.mjs", editor_asset_runtime_js, "Editor asset runtime module")
    assert_regex("web/editor-asset-runtime.mjs", editor_asset_runtime_js, r'async function fetchJson\(')
    assert_regex("web/editor-asset-runtime.mjs", editor_asset_runtime_js, r'export function buildEditorAssetUrls\(')
    assert_regex("web/editor-asset-runtime.mjs", editor_asset_runtime_js, r'export async function loadEditorBundle\(')
    assert_regex("web/editor-asset-runtime.mjs", editor_asset_runtime_js, r'export async function readJsonFile\(')
    assert_regex("web/editor-asset-runtime.mjs", editor_asset_runtime_js, r'export function downloadJsonDocument\(')
    assert_regex("web/editor-asset-runtime.mjs", editor_asset_runtime_js, r'waysUrl\.searchParams\.set\("v", editorManifest\.editor\.network_version\)')
    assert_regex("web/editor-asset-runtime.mjs", editor_asset_runtime_js, r'patchesUrl\.searchParams\.set\("v", editorManifest\.meta\.patchset_digest\)')
    assert_not_regex("web/editor-asset-runtime.mjs", editor_asset_runtime_js, r'^import .* from "\./')
    editor_state_js = (WEB_GENERATED_DIR.parent / "editor-state.mjs").read_text()
    assert_uses_module_context("web/editor-state.mjs", editor_state_js, "Editor state module")
    assert_regex("web/editor-state.mjs", editor_state_js, r'await import\(`\./editor-policy-contracts\.mjs\$\{moduleSuffix\}`\)')
    assert_not_regex("web/editor-state.mjs", editor_state_js, r'function normalizeRoutingState\(')
    assert_not_regex("web/editor-state.mjs", editor_state_js, r'function requireRoutingState\(')
    assert_not_regex("web/editor-state.mjs", editor_state_js, r'function normalizeBikeability\(')
    assert_not_regex("web/editor-state.mjs", editor_state_js, r'function requireBikeability\(')
    assert_not_regex("web/editor-state.mjs", editor_state_js, r'function normalizeBicycleDirection\(')
    assert_not_regex("web/editor-state.mjs", editor_state_js, r'function requireBicycleDirection\(')
    assert_not_regex("web/editor-state.mjs", editor_state_js, r'function normalizeUnavailableUntil\(')
    assert_not_regex("web/editor-state.mjs", editor_state_js, r'function requireUnavailableUntil\(')
    assert_uses_module_context(
        "web/editor-policy-contracts.mjs",
        editor_policy_contracts_js,
        "Editor policy contracts module",
    )
    assert_regex("web/editor-policy-contracts.mjs", editor_policy_contracts_js, r'export const POLICY_TAGS = \{')
    assert_regex("web/editor-policy-contracts.mjs", editor_policy_contracts_js, r'export function defaultWayPolicy\(')
    assert_regex("web/editor-policy-contracts.mjs", editor_policy_contracts_js, r'export function normalizeRoutingState\(')
    assert_regex("web/editor-policy-contracts.mjs", editor_policy_contracts_js, r'export function requireRoutingState\(')
    assert_regex("web/editor-policy-contracts.mjs", editor_policy_contracts_js, r'export function normalizeBikeability\(')
    assert_regex("web/editor-policy-contracts.mjs", editor_policy_contracts_js, r'export function requireBikeability\(')
    assert_regex("web/editor-policy-contracts.mjs", editor_policy_contracts_js, r'export function normalizeBicycleDirection\(')
    assert_regex("web/editor-policy-contracts.mjs", editor_policy_contracts_js, r'export function requireBicycleDirection\(')
    assert_regex("web/editor-policy-contracts.mjs", editor_policy_contracts_js, r'export function normalizeUnavailableUntil\(')
    assert_regex("web/editor-policy-contracts.mjs", editor_policy_contracts_js, r'export function requireUnavailableUntil\(')
    assert_not_regex("web/editor-policy-contracts.mjs", editor_policy_contracts_js, r'^import .* from "\./')
    assert_uses_module_context("web/editor-shell-view.mjs", editor_shell_view_js, "Editor shell view module")
    assert_regex("web/editor-shell-view.mjs", editor_shell_view_js, r'export function createEditorShellView\(')
    assert_regex("web/editor-shell-view.mjs", editor_shell_view_js, r'function requireElement\(')
    assert_regex("web/editor-shell-view.mjs", editor_shell_view_js, r'function guard\(')
    assert_regex("web/editor-shell-view.mjs", editor_shell_view_js, r'function guardAsync\(')
    assert_regex("web/editor-shell-view.mjs", editor_shell_view_js, r'importInput\.files \|\| \[\]')
    assert_regex("web/editor-shell-view.mjs", editor_shell_view_js, r'exportHint\.innerHTML = `Export downloads a replacement')
    assert_not_regex("web/editor-shell-view.mjs", editor_shell_view_js, r'^import .* from "\./')
    route_worker_js = (WEB_GENERATED_DIR.parent / "route-worker.js").read_text()
    runtime_contracts_js = (WEB_GENERATED_DIR.parent / "runtime-contracts.mjs").read_text()
    worker_contracts_js = (WEB_GENERATED_DIR.parent / "planner-worker-contracts.mjs").read_text()
    contract_primitives_js = (WEB_GENERATED_DIR.parent / "contract-primitives.mjs").read_text()
    route_graph_js = (WEB_GENERATED_DIR.parent / "route-graph.mjs").read_text()
    route_network_contracts_js = (WEB_GENERATED_DIR.parent / "route-network-contracts.mjs").read_text()
    route_search_js = (WEB_GENERATED_DIR.parent / "route-search.mjs").read_text()
    route_selection_js = (WEB_GENERATED_DIR.parent / "route-selection.mjs").read_text()

    assert_uses_module_context("web/runtime-contracts.mjs", runtime_contracts_js, "Runtime contracts module")
    assert_regex("web/runtime-contracts.mjs", runtime_contracts_js, r'await import\(`\./contract-primitives\.mjs\$\{moduleSuffix\}`\)')
    assert_not_regex("web/runtime-contracts.mjs", runtime_contracts_js, r'function requireContract\(')
    assert_not_regex("web/runtime-contracts.mjs", runtime_contracts_js, r'function requireObject\(')
    assert_not_regex("web/runtime-contracts.mjs", runtime_contracts_js, r'function requireArray\(')
    assert_not_regex("web/runtime-contracts.mjs", runtime_contracts_js, r'function requireString\(')
    assert_not_regex("web/runtime-contracts.mjs", runtime_contracts_js, r'function requireFiniteNumber\(')
    assert_not_regex("web/runtime-contracts.mjs", runtime_contracts_js, r'function requireInteger\(')
    assert_not_regex("web/runtime-contracts.mjs", runtime_contracts_js, r'^import .* from "\./')
    assert_not_contains("web/runtime-contracts.mjs", runtime_contracts_js, "areas[0].junctions[")
    assert_not_contains("web/runtime-contracts.mjs", runtime_contracts_js, "areas[0].scenarios[")

    assert_uses_module_context(
        "web/planner-worker-contracts.mjs",
        worker_contracts_js,
        "Planner worker contracts module",
    )
    assert_regex(
        "web/planner-worker-contracts.mjs",
        worker_contracts_js,
        r'await import\(`\./contract-primitives\.mjs\$\{moduleSuffix\}`\)',
    )
    assert_contains("web/planner-worker-contracts.mjs", worker_contracts_js, 'if (type === "booted")')
    assert_not_regex("web/planner-worker-contracts.mjs", worker_contracts_js, r'function requireObject\(')
    assert_not_regex("web/planner-worker-contracts.mjs", worker_contracts_js, r'function requireString\(')
    assert_not_regex("web/planner-worker-contracts.mjs", worker_contracts_js, r'function requireInteger\(')
    assert_not_regex("web/planner-worker-contracts.mjs", worker_contracts_js, r'function requireFiniteNumber\(')
    assert_not_regex("web/planner-worker-contracts.mjs", worker_contracts_js, r'function requireCoordinatePair\(')
    assert_not_regex("web/planner-worker-contracts.mjs", worker_contracts_js, r'function requireIntegerArray\(')
    assert_not_regex("web/planner-worker-contracts.mjs", worker_contracts_js, r'^import .* from "\./')

    assert_regex("web/contract-primitives.mjs", contract_primitives_js, r'export function requireObject\(')
    assert_regex("web/contract-primitives.mjs", contract_primitives_js, r'export function requireArray\(')
    assert_regex("web/contract-primitives.mjs", contract_primitives_js, r'export function requireString\(')
    assert_regex("web/contract-primitives.mjs", contract_primitives_js, r'export function requireFiniteNumber\(')
    assert_regex("web/contract-primitives.mjs", contract_primitives_js, r'export function requireInteger\(')
    assert_regex("web/contract-primitives.mjs", contract_primitives_js, r'export function requireCoordinatePair\(')
    assert_regex("web/contract-primitives.mjs", contract_primitives_js, r'export function requireIntegerArray\(')

    assert_uses_module_context("web/route-graph.mjs", route_graph_js, "Route graph module")
    assert_regex("web/route-graph.mjs", route_graph_js, r'await import\(`\./route-network-contracts\.mjs\$\{moduleSuffix\}`\)')
    assert_regex("web/route-graph.mjs", route_graph_js, r'export function buildGraphFromGeoJson\(')
    assert_regex("web/route-graph.mjs", route_graph_js, r'export function buildRoutePayload\(')
    assert_not_regex("web/route-graph.mjs", route_graph_js, r'function makeRng\(')
    assert_not_regex("web/route-graph.mjs", route_graph_js, r'function moveCandidates\(')
    assert_not_regex("web/route-graph.mjs", route_graph_js, r'^import .* from "\./')

    assert_uses_module_context("web/route-selection.mjs", route_selection_js, "Route selection module")
    assert_regex("web/route-selection.mjs", route_selection_js, r'await import\(`\./contract-primitives\.mjs\$\{moduleSuffix\}`\)')
    assert_regex("web/route-selection.mjs", route_selection_js, r'export function normalizeRouteHistory\(')
    assert_regex(
        "web/route-selection.mjs",
        route_selection_js,
        r'export function pickHistoryAwarePrimaryCandidate\(',
    )
    assert_not_regex("web/route-selection.mjs", route_selection_js, r'function moveCandidates\(')
    assert_not_regex("web/route-selection.mjs", route_selection_js, r'function rolloutRoute\(')
    assert_not_regex("web/route-selection.mjs", route_selection_js, r'^import .* from "\./')

    assert_uses_module_context("web/route-search.mjs", route_search_js, "Route search module")
    assert_regex("web/route-search.mjs", route_search_js, r'await import\(`\./karura-policy\.mjs\$\{moduleSuffix\}`\)')
    assert_regex("web/route-search.mjs", route_search_js, r'await import\(`\./route-selection\.mjs\$\{moduleSuffix\}`\)')
    assert_regex("web/route-search.mjs", route_search_js, r'export function createInitialState\(')
    assert_regex("web/route-search.mjs", route_search_js, r'export function rolloutRoute\(')
    assert_regex("web/route-search.mjs", route_search_js, r'export function routeReward\(')
    assert_regex("web/route-search.mjs", route_search_js, r'export function expandMctsNode\(')
    assert_not_regex("web/route-search.mjs", route_search_js, r'function requireFiniteNumber\(')
    assert_not_regex("web/route-search.mjs", route_search_js, r'function requireInteger\(')
    assert_not_regex("web/route-search.mjs", route_search_js, r'^import .* from "\./')

    assert_uses_module_context(
        "web/route-network-contracts.mjs",
        route_network_contracts_js,
        "Route network contracts module",
    )
    assert_regex("web/route-network-contracts.mjs", route_network_contracts_js, r'await import\(`\./contract-primitives\.mjs\$\{moduleSuffix\}`\)')
    assert_regex(
        "web/route-network-contracts.mjs",
        route_network_contracts_js,
        r'export function normalizeRouteNetworkFeatureCollection\(',
    )
    assert_not_regex("web/route-network-contracts.mjs", route_network_contracts_js, r'function roundMeters\(')
    assert_not_regex("web/route-network-contracts.mjs", route_network_contracts_js, r'^import .* from "\./')

    assert_uses_module_context("web/route-worker.js", route_worker_js, "Route worker")
    assert_regex("web/route-worker.js", route_worker_js, r'import\(`\./planner-worker-contracts\.mjs\$\{moduleSuffix\}`\)')
    assert_regex("web/route-worker.js", route_worker_js, r'workerContracts\.parsePlannerWorkerRequest\(event\.data\)')
    assert_regex("web/route-worker.js", route_worker_js, r'workerContracts\.validatePlannerWorkerInitPayload\(payload\)')
    assert_regex("web/route-worker.js", route_worker_js, r'workerContracts\.validatePlannerWorkerPlanPayload\(payload\)')
    assert_regex("web/route-worker.js", route_worker_js, r'import\(`\./route-planner\.mjs\$\{moduleSuffix\}`\)')
    assert_contains("web/route-worker.js", route_worker_js, 'type: "booted"')
    assert_contains("web/route-worker.js", route_worker_js, "requestId: 0")
    assert_not_regex("web/route-worker.js", route_worker_js, r'function requireObject\(')
    assert_not_regex("web/route-worker.js", route_worker_js, r'function requireString\(')
    assert_not_regex("web/route-worker.js", route_worker_js, r'function requireInteger\(')
    assert_not_regex("web/route-worker.js", route_worker_js, r'function requireRouteHistory\(')
    assert_not_regex("web/route-worker.js", route_worker_js, r'function parseWorkerRequest\(')
    route_planner_js = (WEB_GENERATED_DIR.parent / "route-planner.mjs").read_text()
    assert_uses_module_context("web/route-planner.mjs", route_planner_js, "Route planner module")
    assert_regex("web/route-planner.mjs", route_planner_js, r'await import\(`\./contract-primitives\.mjs\$\{moduleSuffix\}`\)')
    assert_regex("web/route-planner.mjs", route_planner_js, r'await import\(`\./route-graph\.mjs\$\{moduleSuffix\}`\)')
    assert_regex("web/route-planner.mjs", route_planner_js, r'await import\(`\./route-selection\.mjs\$\{moduleSuffix\}`\)')
    assert_regex("web/route-planner.mjs", route_planner_js, r'await import\(`\./route-search\.mjs\$\{moduleSuffix\}`\)')
    assert_contains("web/route-planner.mjs", route_planner_js, "normalizeRouteHistory,")
    assert_contains("web/route-planner.mjs", route_planner_js, "pickHistoryAwarePrimaryCandidate,")
    assert_not_regex("web/route-planner.mjs", route_planner_js, r'export function buildGraphFromGeoJson\(')
    assert_not_regex("web/route-planner.mjs", route_planner_js, r'function failNetwork\(')
    assert_not_regex("web/route-planner.mjs", route_planner_js, r'function requireArray\(')
    assert_not_regex("web/route-planner.mjs", route_planner_js, r'function requireObject\(')
    assert_not_regex("web/route-planner.mjs", route_planner_js, r'function requireFiniteNumber\(')
    assert_not_regex("web/route-planner.mjs", route_planner_js, r'function requireInteger\(')
    assert_not_regex("web/route-planner.mjs", route_planner_js, r'function requireCoordinatePair\(')
    assert_not_regex("web/route-planner.mjs", route_planner_js, r'function normalizeFeature\(')
    assert_not_regex("web/route-planner.mjs", route_planner_js, r'function summarizeRouteElevations\(')
    assert_not_regex("web/route-planner.mjs", route_planner_js, r'function buildRoutePayload\(')
    assert_not_regex("web/route-planner.mjs", route_planner_js, r'function normalizeRouteHistory\(')
    assert_not_regex("web/route-planner.mjs", route_planner_js, r'function buildDiverseCandidatePool\(')
    assert_not_regex("web/route-planner.mjs", route_planner_js, r'function pickHistoryAwarePrimaryCandidate\(')
    assert_not_regex("web/route-planner.mjs", route_planner_js, r'function findArticulationPoints\(')
    assert_not_regex("web/route-planner.mjs", route_planner_js, r'function moveCandidates\(')
    assert_not_regex("web/route-planner.mjs", route_planner_js, r'function rolloutRoute\(')
    assert_not_regex("web/route-planner.mjs", route_planner_js, r'function routeReward\(')
    assert_not_regex("web/route-planner.mjs", route_planner_js, r'function createInitialState\(')
    assert_regex("web/route-planner.mjs", route_planner_js, r'mcts_time_budget_ms:\s*requireFiniteNumber\(')
    assert_regex("web/route-planner.mjs", route_planner_js, r'mcts_progress_interval_iterations:\s*requireInteger\(')
    assert_not_contains("web/route-planner.mjs", route_planner_js, "plannerConfig.mcts_time_budget_ms == null")
    assert_not_contains("web/route-planner.mjs", route_planner_js, "plannerConfig.mcts_progress_interval_iterations == null")
    assert_not_regex("web/route-planner.mjs", route_planner_js, r'^import .* from "\./')


def build_expected(args: argparse.Namespace) -> tuple[dict, dict, dict, dict, dict, dict]:
    baseline_map = load_map(args.map_json)
    patchset = load_required_patchset(args.patches_json, label="patchset file")
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
    junction_catalog = load_required_junction_catalog(args.junctions_json, label="junction catalog")
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
    actual_patched_map = load_required_json(args.patched_map_json, label="patched map")
    actual_contigs = load_required_json(args.contigs_json, label="contig graph")
    actual_bindings = load_required_json(args.junction_bindings_json, label="junction bindings")
    actual_editor_network = load_required_json(args.output_editor_network, label="editor network")
    actual_manifest = load_required_json(args.output_editor_manifest, label="editor manifest")
    actual_frontend_manifest = load_required_json(output_frontend_manifest, label="frontend manifest")
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
    print_json_document(verify_editor_assets(args))


if __name__ == "__main__":
    main()
