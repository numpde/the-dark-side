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
MAP_PATCHES_JSON = WEB_SOURCE_DIR / "karura-map-patches.json"

R = 6378137.0
LOCAL_ROUTING_STATE_TAG = "local:routing_state"
LOCAL_BIKEABILITY_TAG = "local:bikeability"
LOCAL_BICYCLE_DIRECTION_TAG = "local:bicycle_direction"
LOCAL_AVAILABILITY_TAG = "local:availability"


def include_baseline_way(tags: dict[str, str]) -> bool:
    return "highway" in tags or tags.get("amenity") == "parking"


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
    routing_state = tags.get(LOCAL_ROUTING_STATE_TAG)
    availability = tags.get(LOCAL_AVAILABILITY_TAG)
    if routing_state == "exclude":
        return False
    if availability == "temporarily_unavailable":
        return False
    if routing_state == "include":
        return True
    if tags.get("local:context_only") == "yes":
        return False
    return include_baseline_way(tags)


def include_editor_way(_way_id: int, tags: dict[str, str]) -> bool:
    return include_baseline_way(tags)
