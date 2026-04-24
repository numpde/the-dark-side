"""Shared constants and helpers for the Karura map pipeline."""

from __future__ import annotations

import math
from pathlib import Path


BASE = Path(__file__).resolve().parent
DATA_DIR = BASE / "data"
RAW_JSON = DATA_DIR / "karura_overpass.json"
MAP_JSON = DATA_DIR / "karura_map.json"
CONTIGS_JSON = DATA_DIR / "karura_contigs.json"
ROUTES_DIR = DATA_DIR / "routes"
BENCHMARKS_DIR = DATA_DIR / "benchmarks"
CURATED_DIR = BASE / "curated"
JUNCTIONS_JSON = CURATED_DIR / "karura_junctions.json"
SCREENSHOT = BASE / "karura-source-screenshot.png"
VIEWPORT = BASE / "karura-viewport.json"

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
