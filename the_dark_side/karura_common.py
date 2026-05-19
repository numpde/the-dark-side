"""Shared constants and helpers for the Karura map pipeline."""

from __future__ import annotations

import json
import math
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
ROUTE_POLICY_BINDINGS_JSON = DATA_DIR / "karura_route_policy_bindings.json"
ROUTES_DIR = DATA_DIR / "routes"
ROUTE_CATALOG_JSON = ROUTES_DIR / "karura-route-catalog.json"
BENCHMARKS_DIR = DATA_DIR / "benchmarks"
ELEVATION_CACHE_DIR = DATA_DIR / "elevation_cache"
CURATED_DIR = REPO_ROOT / "curated"
AREAS_JSON = CURATED_DIR / "areas.json"
JUNCTIONS_JSON = CURATED_DIR / "karura_junctions.json"
ROUTING_OVERRIDES_JSON = CURATED_DIR / "karura_routing_overrides.json"
ASSETS_DIR = REPO_ROOT / "assets"
REFERENCE_DIR = ASSETS_DIR / "reference"
DEBUG_DIR = ASSETS_DIR / "debug"
FIGURES_DIR = ASSETS_DIR / "figures"
SCREENSHOT = REFERENCE_DIR / "karura-source-screenshot.png"
VIEWPORT = REFERENCE_DIR / "karura-viewport.json"
WEB_DIR = REPO_ROOT / "web"
DIST_DIR = REPO_ROOT / "dist"
WEB_SOURCE_DIR = WEB_DIR / "source"
WEB_GENERATED_DIR = WEB_DIR / "generated"
EDITOR_MANIFEST_JSON = WEB_GENERATED_DIR / "editor-manifest.json"
APP_MANIFEST_JSON = WEB_GENERATED_DIR / "app-manifest.json"
MAP_PATCHES_JSON = SOURCE_DIR / "karura-map-patches.json"
ROUTE_POLICY_JSON = SOURCE_DIR / "karura-route-policy.json"
CATALOG_BUILD_JSON = SOURCE_DIR / "catalog_build.json"
SOURCE_ASSET_PATHS = (MAP_PATCHES_JSON, ROUTE_POLICY_JSON, CATALOG_BUILD_JSON)

R = 6378137.0
LOCAL_ROUTING_STATE_TAG = "local:routing_state"
LOCAL_BIKEABILITY_TAG = "local:bikeability"
LOCAL_BICYCLE_DIRECTION_TAG = "local:bicycle_direction"
LOCAL_AVAILABILITY_TAG = "local:availability"
LOCAL_UNAVAILABLE_UNTIL_TAG = "local:unavailable_until"
LOCAL_BOUNDARY_ZONE_TAG = "local:boundary_zone"
LOCAL_BOUNDARY_REFS_TAG = "local:boundary_refs"
KARURA_TIMEZONE = ZoneInfo("Africa/Nairobi")


def include_baseline_way(tags: dict[str, str]) -> bool:
    return "highway" in tags or tags.get("amenity") == "parking"


def boundary_zone(tags: dict[str, str]) -> str:
    zone = tags.get(LOCAL_BOUNDARY_ZONE_TAG)
    if zone in {"core", "buffer"}:
        return zone
    return "core"


def is_boundary_default_excluded(tags: dict[str, str]) -> bool:
    return boundary_zone(tags) == "buffer"


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


def write_json_document(path: Path, payload: object, *, sort_keys: bool = False) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=sort_keys) + "\n")


def print_json_document(payload: object, *, sort_keys: bool = False) -> None:
    print(json.dumps(payload, indent=2, sort_keys=sort_keys))


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
    if is_boundary_default_excluded(tags):
        return False
    if tags.get("local:context_only") == "yes":
        return False
    return include_baseline_way(tags)


def include_editor_way(_way_id: int, tags: dict[str, str]) -> bool:
    return include_baseline_way(tags) or is_boundary_default_excluded(tags)
