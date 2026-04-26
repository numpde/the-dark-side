"""Shared constants and helpers for the Karura map pipeline."""

from __future__ import annotations

import math
import hashlib
import json
import shutil
from datetime import date, datetime
from pathlib import Path
from zoneinfo import ZoneInfo


REPO_ROOT = Path(__file__).resolve().parent.parent
BASE = REPO_ROOT
DATA_DIR = REPO_ROOT / "data"
SOURCE_DIR = REPO_ROOT / "source"
RAW_JSON = DATA_DIR / "karura_overpass.json"
MAP_JSON = DATA_DIR / "karura_map.json"
PATCHED_MAP_JSON = DATA_DIR / "karura_map_patched.json"
CONTIGS_JSON = DATA_DIR / "karura_contigs.json"
ELEVATION_JSON = DATA_DIR / "karura_elevation.json"
JUNCTION_BINDINGS_JSON = DATA_DIR / "karura_junction_bindings.json"
ROUTES_DIR = DATA_DIR / "routes"
ROUTE_CATALOG_JSON = ROUTES_DIR / "karura-route-catalog.json"
BENCHMARKS_DIR = DATA_DIR / "benchmarks"
ELEVATION_CACHE_DIR = DATA_DIR / "elevation_cache"
CURATED_DIR = REPO_ROOT / "curated"
JUNCTIONS_JSON = CURATED_DIR / "karura_junctions.json"
ROUTING_OVERRIDES_JSON = CURATED_DIR / "karura_routing_overrides.json"
ASSETS_DIR = REPO_ROOT / "assets"
REFERENCE_DIR = ASSETS_DIR / "reference"
DEBUG_DIR = ASSETS_DIR / "debug"
FIGURES_DIR = ASSETS_DIR / "figures"
SCREENSHOT = REFERENCE_DIR / "karura-source-screenshot.png"
VIEWPORT = REFERENCE_DIR / "karura-viewport.json"
WEB_DIR = REPO_ROOT / "web"
WEB_SOURCE_DIR = WEB_DIR / "source"
WEB_GENERATED_DIR = WEB_DIR / "generated"
EDITOR_MANIFEST_JSON = WEB_GENERATED_DIR / "editor-manifest.json"
APP_MANIFEST_JSON = WEB_GENERATED_DIR / "app-manifest.json"
FRONTEND_MANIFEST_JSON = WEB_GENERATED_DIR / "frontend-manifest.json"
MAP_PATCHES_JSON = SOURCE_DIR / "karura-map-patches.json"
CATALOG_BUILD_JSON = SOURCE_DIR / "catalog_build.json"
SOURCE_ASSET_PATHS = (MAP_PATCHES_JSON, CATALOG_BUILD_JSON)
APP_MODULE_PATHS = (
    WEB_DIR / "app.js",
    WEB_DIR / "contract-primitives.mjs",
    WEB_DIR / "gpx.mjs",
    WEB_DIR / "karura-policy.mjs",
    WEB_DIR / "planner-client.mjs",
    WEB_DIR / "planner-worker-contracts.mjs",
    WEB_DIR / "route-graph.mjs",
    WEB_DIR / "route-network-contracts.mjs",
    WEB_DIR / "route-selection.mjs",
    WEB_DIR / "runtime-contracts.mjs",
    WEB_DIR / "route-worker.js",
    WEB_DIR / "route-planner.mjs",
)
EDITOR_MODULE_PATHS = (
    WEB_DIR / "contract-primitives.mjs",
    WEB_DIR / "editor.js",
    WEB_DIR / "editor-state.mjs",
    WEB_DIR / "karura-policy.mjs",
    WEB_DIR / "runtime-contracts.mjs",
)

R = 6378137.0
LOCAL_ROUTING_STATE_TAG = "local:routing_state"
LOCAL_BIKEABILITY_TAG = "local:bikeability"
LOCAL_BICYCLE_DIRECTION_TAG = "local:bicycle_direction"
LOCAL_AVAILABILITY_TAG = "local:availability"
LOCAL_UNAVAILABLE_UNTIL_TAG = "local:unavailable_until"
KARURA_TIMEZONE = ZoneInfo("Africa/Nairobi")


def include_baseline_way(tags: dict[str, str]) -> bool:
    return "highway" in tags or tags.get("amenity") == "parking"


def karura_today() -> date:
    return datetime.now(KARURA_TIMEZONE).date()


def utc_now_z() -> str:
    return datetime.now(ZoneInfo("UTC")).isoformat().replace("+00:00", "Z")


def parse_iso_date(value: str | None) -> date | None:
    if value is None:
        return None
    try:
        return date.fromisoformat(str(value))
    except ValueError:
        return None


def is_currently_unavailable(tags: dict[str, str], *, on_date: date | None = None) -> bool:
    if tags.get(LOCAL_AVAILABILITY_TAG) == "temporarily_unavailable":
        return True
    until = parse_iso_date(tags.get(LOCAL_UNAVAILABLE_UNTIL_TAG))
    if until is None:
        return False
    return (on_date or karura_today()) <= until


def resolve_map_json(prefer_patched: bool = True) -> Path:
    if prefer_patched and PATCHED_MAP_JSON.exists():
        return PATCHED_MAP_JSON
    return MAP_JSON


def repo_rel(path: Path | str) -> str:
    candidate = Path(path)
    try:
        return str(candidate.resolve().relative_to(REPO_ROOT))
    except Exception:
        return str(path)


def sync_web_source_assets() -> list[Path]:
    WEB_SOURCE_DIR.mkdir(parents=True, exist_ok=True)
    synced: list[Path] = []
    missing: list[Path] = []
    for source_path in SOURCE_ASSET_PATHS:
        if not source_path.exists():
            missing.append(source_path)
            continue
        target_path = WEB_SOURCE_DIR / source_path.name
        shutil.copy2(source_path, target_path)
        synced.append(target_path)
    if missing:
        missing_paths = ", ".join(repo_rel(path) for path in missing)
        raise FileNotFoundError(f"missing canonical source assets: {missing_paths}")
    return synced


def load_required_json(path: Path, *, label: str) -> dict:
    if not path.exists():
        raise FileNotFoundError(f"missing {label}: {path}")
    return json.loads(path.read_text())


def require_json_object(payload: object, *, label: str) -> dict:
    if not isinstance(payload, dict):
        raise ValueError(f"{label} must be a JSON object")
    return payload


def require_json_array(payload: object, *, label: str) -> list:
    if not isinstance(payload, list):
        raise ValueError(f"{label} must be a JSON array")
    return payload


def require_nonempty_string(value: object, *, label: str) -> str:
    if not isinstance(value, str) or value == "":
        raise ValueError(f"{label} must be a non-empty string")
    return value


def validate_patchset_document(payload: object, *, label: str) -> dict:
    document = require_json_object(payload, label=label)
    meta = require_json_object(document.get("meta"), label=f"{label}.meta")
    require_nonempty_string(meta.get("asset_kind"), label=f"{label}.meta.asset_kind")
    require_nonempty_string(meta.get("patchset_id"), label=f"{label}.meta.patchset_id")
    require_json_array(document.get("patches"), label=f"{label}.patches")
    return document


def load_required_patchset(path: Path, *, label: str) -> dict:
    return validate_patchset_document(load_required_json(path, label=label), label=label)


def validate_junction_catalog_document(payload: object, *, label: str) -> dict:
    document = require_json_object(payload, label=label)
    meta = require_json_object(document.get("meta"), label=f"{label}.meta")
    require_nonempty_string(meta.get("asset_id"), label=f"{label}.meta.asset_id")
    require_nonempty_string(meta.get("asset_kind"), label=f"{label}.meta.asset_kind")
    junctions = require_json_array(document.get("junctions"), label=f"{label}.junctions")
    for index, junction in enumerate(junctions):
        item = require_json_object(junction, label=f"{label}.junctions[{index}]")
        require_nonempty_string(item.get("id"), label=f"{label}.junctions[{index}].id")
        require_nonempty_string(item.get("name"), label=f"{label}.junctions[{index}].name")
        location = require_json_object(item.get("location"), label=f"{label}.junctions[{index}].location")
        lat = location.get("lat")
        lon = location.get("lon")
        if not isinstance(lat, (int, float)) or not isinstance(lon, (int, float)):
            raise ValueError(f"{label}.junctions[{index}].location must contain numeric lat/lon")
        tags = item.get("tags")
        if tags is not None:
            require_json_array(tags, label=f"{label}.junctions[{index}].tags")
    return document


def load_required_junction_catalog(path: Path, *, label: str) -> dict:
    return validate_junction_catalog_document(load_required_json(path, label=label), label=label)


def validate_junction_bindings_document(payload: object, *, label: str) -> dict:
    document = require_json_object(payload, label=label)
    meta = require_json_object(document.get("meta"), label=f"{label}.meta")
    require_nonempty_string(meta.get("asset_id"), label=f"{label}.meta.asset_id")
    require_nonempty_string(meta.get("asset_kind"), label=f"{label}.meta.asset_kind")
    require_nonempty_string(meta.get("graph_asset_id"), label=f"{label}.meta.graph_asset_id")
    require_nonempty_string(
        meta.get("junction_catalog_asset_id"),
        label=f"{label}.meta.junction_catalog_asset_id",
    )
    bindings = require_json_array(document.get("bindings"), label=f"{label}.bindings")
    for index, binding in enumerate(bindings):
        item = require_json_object(binding, label=f"{label}.bindings[{index}]")
        require_nonempty_string(item.get("junction_id"), label=f"{label}.bindings[{index}].junction_id")
        graph_node_id = item.get("graph_node_id")
        if not isinstance(graph_node_id, int):
            raise ValueError(f"{label}.bindings[{index}].graph_node_id must be an integer")
        incident_contig_ids = require_json_array(
            item.get("incident_contig_ids"),
            label=f"{label}.bindings[{index}].incident_contig_ids",
        )
        for contig_index, contig_id in enumerate(incident_contig_ids):
            if not isinstance(contig_id, int):
                raise ValueError(
                    f"{label}.bindings[{index}].incident_contig_ids[{contig_index}] must be an integer"
                )
        distance_m = item.get("distance_m")
        if not isinstance(distance_m, (int, float)):
            raise ValueError(f"{label}.bindings[{index}].distance_m must be numeric")
    return document


def load_required_junction_bindings(path: Path, *, label: str) -> dict:
    return validate_junction_bindings_document(load_required_json(path, label=label), label=label)


def validate_figure_catalog_document(payload: object, *, label: str) -> dict:
    document = require_json_object(payload, label=label)
    meta = require_json_object(document.get("meta"), label=f"{label}.meta")
    require_nonempty_string(meta.get("asset_id"), label=f"{label}.meta.asset_id")
    require_nonempty_string(meta.get("asset_kind"), label=f"{label}.meta.asset_kind")
    figures = require_json_array(document.get("figures"), label=f"{label}.figures")
    for figure_index, figure in enumerate(figures):
        item = require_json_object(figure, label=f"{label}.figures[{figure_index}]")
        require_nonempty_string(item.get("id"), label=f"{label}.figures[{figure_index}].id")
        require_nonempty_string(item.get("kind"), label=f"{label}.figures[{figure_index}].kind")
        require_nonempty_string(
            item.get("output_path"),
            label=f"{label}.figures[{figure_index}].output_path",
        )
        header = require_json_object(item.get("header"), label=f"{label}.figures[{figure_index}].header")
        require_nonempty_string(header.get("title"), label=f"{label}.figures[{figure_index}].header.title")
        require_nonempty_string(
            header.get("subtitle"),
            label=f"{label}.figures[{figure_index}].header.subtitle",
        )
        items = require_json_array(item.get("items"), label=f"{label}.figures[{figure_index}].items")
        for item_index, figure_item in enumerate(items):
            figure_entry = require_json_object(
                figure_item,
                label=f"{label}.figures[{figure_index}].items[{item_index}]",
            )
            require_nonempty_string(
                figure_entry.get("junction_id"),
                label=f"{label}.figures[{figure_index}].items[{item_index}].junction_id",
            )
            color = require_json_array(
                figure_entry.get("color"),
                label=f"{label}.figures[{figure_index}].items[{item_index}].color",
            )
            if len(color) != 4 or any(not isinstance(value, int) for value in color):
                raise ValueError(
                    f"{label}.figures[{figure_index}].items[{item_index}].color must be a 4-element integer array"
                )
            for coord_key in ("label_dx", "label_dy"):
                coord_value = figure_entry.get(coord_key)
                if not isinstance(coord_value, (int, float)):
                    raise ValueError(
                        f"{label}.figures[{figure_index}].items[{item_index}].{coord_key} must be numeric"
                    )
            subtitle_template = figure_entry.get("subtitle_template")
            if subtitle_template is not None and not isinstance(subtitle_template, str):
                raise ValueError(
                    f"{label}.figures[{figure_index}].items[{item_index}].subtitle_template must be a string"
                )
    return document


def load_required_figure_catalog(path: Path, *, label: str) -> dict:
    return validate_figure_catalog_document(load_required_json(path, label=label), label=label)


def digest_paths(paths: tuple[Path, ...] | list[Path]) -> str:
    digest = hashlib.sha256()
    for path in paths:
        digest.update(repo_rel(path).encode("utf-8"))
        digest.update(b"\0")
        digest.update(path.read_bytes())
        digest.update(b"\0")
    return digest.hexdigest()[:12]


def mercator(lon: float, lat: float) -> tuple[float, float]:
    lon_r = math.radians(lon)
    lat_r = math.radians(lat)
    return (
        R * lon_r,
        R * math.log(math.tan(math.pi / 4 + lat_r / 2)),
    )


def include_ride_way(way_id: int, tags: dict[str, str]) -> bool:
    routing_state = tags.get(LOCAL_ROUTING_STATE_TAG)
    if routing_state == "exclude":
        return False
    if is_currently_unavailable(tags):
        return False
    if routing_state == "include":
        return True
    if tags.get("local:context_only") == "yes":
        return False
    return include_baseline_way(tags)


def include_editor_way(_way_id: int, tags: dict[str, str]) -> bool:
    return include_baseline_way(tags)
