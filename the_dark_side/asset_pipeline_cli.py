from __future__ import annotations

import argparse
from pathlib import Path

from .karura_common import (
    APP_MANIFEST_JSON,
    CATALOG_BUILD_JSON,
    CONTIGS_JSON,
    EDITOR_MANIFEST_JSON,
    ELEVATION_JSON,
    JUNCTION_BINDINGS_JSON,
    JUNCTIONS_JSON,
    MAP_JSON,
    MAP_PATCHES_JSON,
    PATCHED_MAP_JSON,
    ROUTE_POLICY_BINDINGS_JSON,
    ROUTE_POLICY_JSON,
    WEB_GENERATED_DIR,
)


def add_boundary_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--boundary-buffer-m",
        type=float,
        default=75.0,
    )
    parser.add_argument(
        "--fill-segment-gaps",
        action=argparse.BooleanOptionalAction,
        default=True,
    )
    parser.add_argument(
        "--respect-inner-rings",
        action=argparse.BooleanOptionalAction,
        default=False,
    )


def add_editor_asset_args(
    parser: argparse.ArgumentParser,
    *,
    include_output_editor_manifest: bool = True,
) -> None:
    parser.add_argument("--map-json", type=Path, default=MAP_JSON)
    parser.add_argument("--map-patches-json", type=Path, default=MAP_PATCHES_JSON)
    parser.add_argument("--route-policy-json", type=Path, default=ROUTE_POLICY_JSON)
    parser.add_argument("--patched-map-json", type=Path, default=PATCHED_MAP_JSON)
    parser.add_argument("--contigs-json", type=Path, default=CONTIGS_JSON)
    parser.add_argument("--junctions-json", type=Path, default=JUNCTIONS_JSON)
    parser.add_argument("--junction-bindings-json", type=Path, default=JUNCTION_BINDINGS_JSON)
    parser.add_argument("--route-policy-bindings-json", type=Path, default=ROUTE_POLICY_BINDINGS_JSON)
    parser.add_argument("--output-editor-network", type=Path, default=WEB_GENERATED_DIR / "karura-editor-network.geojson")
    if include_output_editor_manifest:
        parser.add_argument("--output-editor-manifest", type=Path, default=EDITOR_MANIFEST_JSON)
    add_boundary_args(parser)


def add_app_asset_args(parser: argparse.ArgumentParser) -> None:
    add_editor_asset_args(parser, include_output_editor_manifest=True)
    parser.add_argument("--build-config-json", type=Path, default=CATALOG_BUILD_JSON)
    parser.add_argument("--elevation-json", type=Path, default=ELEVATION_JSON)
    parser.add_argument("--output-network", type=Path, default=WEB_GENERATED_DIR / "karura-network.geojson")
    parser.add_argument("--output-app-manifest", type=Path, default=APP_MANIFEST_JSON)


def editor_rebuild_argv_from_namespace(
    args: argparse.Namespace,
    *,
    include_output_editor_manifest: bool,
) -> list[str]:
    argv = [
        "--map-json", str(args.map_json),
        "--map-patches-json", str(args.map_patches_json),
        "--route-policy-json", str(args.route_policy_json),
        "--patched-map-json", str(args.patched_map_json),
        "--contigs-json", str(args.contigs_json),
        "--junctions-json", str(args.junctions_json),
        "--junction-bindings-json", str(args.junction_bindings_json),
        "--route-policy-bindings-json", str(args.route_policy_bindings_json),
        "--output-editor-network", str(args.output_editor_network),
        "--boundary-buffer-m", str(args.boundary_buffer_m),
        "--fill-segment-gaps" if args.fill_segment_gaps else "--no-fill-segment-gaps",
        "--respect-inner-rings" if args.respect_inner_rings else "--no-respect-inner-rings",
    ]
    if include_output_editor_manifest:
        argv.extend(["--output-editor-manifest", str(args.output_editor_manifest)])
    return argv


def app_rebuild_argv_from_namespace(args: argparse.Namespace) -> list[str]:
    argv = editor_rebuild_argv_from_namespace(args, include_output_editor_manifest=True)
    argv.extend(
        [
            "--build-config-json", str(args.build_config_json),
            "--elevation-json", str(args.elevation_json),
            "--output-network", str(args.output_network),
            "--output-app-manifest", str(args.output_app_manifest),
        ]
    )
    return argv
