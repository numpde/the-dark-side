#!/usr/bin/env python3

"""Verify editor-facing derived assets against canonical inputs."""

from __future__ import annotations

import argparse
import re
from pathlib import Path
from types import SimpleNamespace

from .apply_karura_patches import apply_patchset
from .asset_contracts import (
    load_required_junction_catalog,
    load_required_json,
    load_required_patchset,
    load_required_route_policy,
    load_required_route_policy_bindings,
)
from .asset_pipeline_cli import add_editor_asset_args
from .build_karura_contigs import build_contigs
from .download_karura_map import load_map
from .junction_bindings import build_junction_bindings
from .karura_common import (
    SOURCE_ASSET_PATHS,
    WEB_DIR,
    WEB_SOURCE_DIR,
    include_baseline_way,
    print_json_document,
    repo_rel,
)
from .rebuild_editor_assets import build_editor_manifest
from .route_policy import apply_route_policy_bindings, build_route_policy_bindings
from .verify_helpers import assert_equal, normalized
from .web_assets import build_editor_graph_payload_from_map


LEGACY_FRONTEND_PATTERNS = (
    "frontend-manifest",
    "module-context",
    "entry-bootstrap",
)


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    add_editor_asset_args(parser, include_output_editor_manifest=True)
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


def verify_sources_synced() -> None:
    for canonical_path in SOURCE_ASSET_PATHS:
        expected_path = WEB_SOURCE_DIR / canonical_path.name
        if not expected_path.exists():
            raise SystemExit(
                f"missing published source asset: {expected_path}; run rebuild_editor_assets and commit"
            )
        if canonical_path.name == "karura-route-policy.json":
            canonical_text = canonical_path.read_text()
            assert_not_contains(str(canonical_path), canonical_text, "editor-policy-contig-")
            assert_not_contains(
                str(canonical_path),
                canonical_text,
                "Local route policy resolved onto the current graph during rebuild.",
            )
        assert_equal(
            str(expected_path),
            expected_path.read_text(),
            canonical_path.read_text(),
            rebuild_hint="run rebuild_editor_assets and commit",
        )


def verify_source_frontend_contract() -> None:
    for legacy_path in (WEB_DIR / "entry-bootstrap.mjs", WEB_DIR / "module-context.mjs"):
        if legacy_path.exists():
            raise SystemExit(f"{legacy_path} is stale; legacy frontend bootstrap file should be removed")

    index_html = (WEB_DIR / "index.html").read_text()
    editor_html = (WEB_DIR / "editor.html").read_text()
    app_js = (WEB_DIR / "app.js").read_text()
    editor_js = (WEB_DIR / "editor.js").read_text()
    planner_client_js = (WEB_DIR / "planner-client.mjs").read_text()
    route_worker_js = (WEB_DIR / "route-worker.js").read_text()
    asset_urls_js = (WEB_DIR / "asset-urls.mjs").read_text()

    assert_regex(
        "web/index.html",
        index_html,
        r'<script\s+type="module"\s+src="\./app\.js"\s*></script>',
    )
    assert_regex(
        "web/editor.html",
        editor_html,
        r'<script\s+type="module"\s+src="\./editor\.js"\s*></script>',
    )
    if re.search(r"<script\s+type=\"module\">", index_html):
        raise SystemExit("web/index.html is stale; inline module bootstrap should be removed")
    if re.search(r"<script\s+type=\"module\">", editor_html):
        raise SystemExit("web/editor.html is stale; inline module bootstrap should be removed")

    assert_regex(
        "web/app.js",
        app_js,
        r'^import\s+\{\s*createRouteController\s*\}\s+from\s+"\./route-controller\.mjs";',
    )
    assert_regex(
        "web/app.js",
        app_js,
        r'^import\s+\{\s*createFatalErrorReporter,\s*installWindowErrorHandlers\s*\}\s+from\s+"\./fatal-error-runtime\.mjs";',
    )
    assert_regex(
        "web/editor.js",
        editor_js,
        r'^import\s+\{\s*createEditorController\s*\}\s+from\s+"\./editor-controller\.mjs";',
    )
    assert_regex(
        "web/editor.js",
        editor_js,
        r'^import\s+\{\s*createFatalErrorReporter,\s*installWindowErrorHandlers\s*\}\s+from\s+"\./fatal-error-runtime\.mjs";',
    )
    assert_regex(
        "web/planner-client.mjs",
        planner_client_js,
        r'^import\s+\{\s*ROUTE_WORKER_URL\s*\}\s+from\s+"\./asset-urls\.mjs";',
    )
    assert_regex(
        "web/route-worker.js",
        route_worker_js,
        r'^import\s+\*\s+as\s+workerContracts\s+from\s+"\./planner-worker-contracts\.mjs";',
    )
    assert_regex(
        "web/route-worker.js",
        route_worker_js,
        r'^import\s+\{\s*buildGraphFromGeoJson,\s*planBrowserRoute\s*\}\s+from\s+"\./route-planner\.mjs";',
    )
    assert_contains("web/asset-urls.mjs", asset_urls_js, 'export const ROUTE_WORKER_URL = "./route-worker.js";')
    assert_not_contains(
        "web/planner-client.mjs",
        planner_client_js,
        'searchParams.set("v", moduleVersion)',
    )

    for source_path in sorted(WEB_DIR.glob("*")):
        if source_path.suffix not in {".html", ".js", ".mjs"}:
            continue
        text = source_path.read_text()
        for needle in LEGACY_FRONTEND_PATTERNS:
            assert_not_contains(str(source_path), text, needle)
        if "import(" in text:
            raise SystemExit(f"{source_path} is stale; frontend runtime should not rely on dynamic module imports")


def build_expected(args: argparse.Namespace) -> tuple[dict, dict, dict, dict, dict, dict]:
    baseline_map = load_map(args.map_json)
    patchset = load_required_patchset(args.map_patches_json, label="map patchset file")
    expected_patched_map = apply_patchset(
        baseline_map,
        patchset=patchset,
        source_map=repo_rel(args.map_json),
        patchset_path=repo_rel(args.map_patches_json),
        boundary_buffer_m=args.boundary_buffer_m,
        fill_segment_gaps=args.fill_segment_gaps,
        respect_inner_rings=args.respect_inner_rings,
    ).to_dict()
    route_policy = load_required_route_policy(args.route_policy_json, label="route policy file")
    expected_contigs = build_contigs(
        expected_patched_map,
        source_map=repo_rel(args.patched_map_json),
        include_way=include_baseline_way,
        route_policy=route_policy,
        graph_mode="ride",
    )
    expected_route_policy_bindings = build_route_policy_bindings(route_policy, expected_contigs)
    expected_contigs = apply_route_policy_bindings(
        expected_contigs,
        expected_route_policy_bindings,
        route_policy_path=repo_rel(args.route_policy_json),
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
        route_policy=route_policy,
    )
    expected_manifest = build_editor_manifest(
        args,
        expected_patched_map,
        expected_contigs,
        expected_bindings,
        expected_editor_graph,
    )
    return (
        expected_patched_map,
        expected_contigs,
        expected_bindings,
        expected_route_policy_bindings,
        expected_editor_network,
        expected_manifest,
    )


def verify_editor_assets(args: argparse.Namespace) -> dict:
    verify_sources_synced()
    verify_source_frontend_contract()
    (
        expected_patched_map,
        expected_contigs,
        expected_bindings,
        expected_route_policy_bindings,
        expected_editor_network,
        expected_manifest,
    ) = build_expected(args)
    actual_patched_map = load_required_json(args.patched_map_json, label="patched map")
    actual_contigs = load_required_json(args.contigs_json, label="contig graph")
    actual_bindings = load_required_json(args.junction_bindings_json, label="junction bindings")
    actual_route_policy_bindings = load_required_route_policy_bindings(
        args.route_policy_bindings_json,
        label="route policy bindings",
    )
    actual_editor_network = load_required_json(args.output_editor_network, label="editor network")
    actual_manifest = load_required_json(args.output_editor_manifest, label="editor manifest")
    rebuild_hint = "rebuild editor assets and commit the derived output"
    assert_equal(str(args.patched_map_json), actual_patched_map, expected_patched_map, rebuild_hint=rebuild_hint)
    assert_equal(str(args.contigs_json), actual_contigs, expected_contigs, rebuild_hint=rebuild_hint)
    assert_equal(
        str(args.junction_bindings_json),
        normalized(actual_bindings),
        normalized(expected_bindings),
        rebuild_hint=rebuild_hint,
    )
    assert_equal(
        str(args.route_policy_bindings_json),
        normalized(actual_route_policy_bindings),
        normalized(expected_route_policy_bindings),
        rebuild_hint=rebuild_hint,
    )
    assert_equal(
        str(args.output_editor_network),
        actual_editor_network,
        expected_editor_network,
        rebuild_hint=rebuild_hint,
    )
    assert_equal(
        str(args.output_editor_manifest),
        normalized(actual_manifest),
        normalized(expected_manifest),
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
