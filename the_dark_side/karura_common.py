"""Shared constants and helpers for the Karura map pipeline."""

from __future__ import annotations

import math
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parent.parent
BASE = REPO_ROOT
DATA_DIR = REPO_ROOT / "data"
RAW_JSON = DATA_DIR / "karura_overpass.json"
MAP_JSON = DATA_DIR / "karura_map.json"
PATCHED_MAP_JSON = DATA_DIR / "karura_map_patched.json"
CONTIGS_JSON = DATA_DIR / "karura_contigs.json"
ELEVATION_JSON = DATA_DIR / "karura_elevation.json"
ROUTES_DIR = DATA_DIR / "routes"
BENCHMARKS_DIR = DATA_DIR / "benchmarks"
ELEVATION_CACHE_DIR = DATA_DIR / "elevation_cache"
CURATED_DIR = REPO_ROOT / "curated"
JUNCTIONS_JSON = CURATED_DIR / "karura_junctions.json"
MAP_PATCHES_JSON = CURATED_DIR / "karura_map_patches.json"
ROUTING_OVERRIDES_JSON = CURATED_DIR / "karura_routing_overrides.json"
ASSETS_DIR = REPO_ROOT / "assets"
REFERENCE_DIR = ASSETS_DIR / "reference"
DEBUG_DIR = ASSETS_DIR / "debug"
FIGURES_DIR = ASSETS_DIR / "figures"
SCREENSHOT = REFERENCE_DIR / "karura-source-screenshot.png"
VIEWPORT = REFERENCE_DIR / "karura-viewport.json"
WEB_DIR = REPO_ROOT / "web"
WEB_GENERATED_DIR = WEB_DIR / "generated"

R = 6378137.0
RIDEABLE = {
    "cycleway",
    "footway",
    "path",
    "residential",
    "service",
    "steps",
    "track",
    "unclassified",
}
SKIP_SERVICE_TYPES = {"parking_aisle"}
EXCLUDED_WAY_IDS = {643633767}


def resolve_map_json(prefer_patched: bool = True) -> Path:
    if prefer_patched and PATCHED_MAP_JSON.exists():
        return PATCHED_MAP_JSON
    return MAP_JSON


def mercator(lon: float, lat: float) -> tuple[float, float]:
    lon_r = math.radians(lon)
    lat_r = math.radians(lat)
    return (
        R * lon_r,
        R * math.log(math.tan(math.pi / 4 + lat_r / 2)),
    )


def include_ride_way(way_id: int, tags: dict[str, str]) -> bool:
    if way_id in EXCLUDED_WAY_IDS:
        return False
    return tags.get("highway") in RIDEABLE and tags.get("service") not in SKIP_SERVICE_TYPES
