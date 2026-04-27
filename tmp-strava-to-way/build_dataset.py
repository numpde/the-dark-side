#!/usr/bin/env python3
from __future__ import annotations

import json
import math
import re
import subprocess
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Iterable
from urllib.parse import urlparse


ROOT = Path(__file__).resolve().parent
SOURCES_PATH = ROOT / "sources.txt"
GENERATED_DIR = ROOT / "generated"
REGIONS_DIR = GENERATED_DIR / "regions"

PNG_HEADER = b"\x89PNG\r\n\x1a\n"
TILE_SIZE = 512
ASSUMED_DEVICE_PIXEL_RATIO = 2.0
REGION_MARGIN_FACTOR = 0.18


@dataclass
class SourceRecord:
    file_name: str
    source_url: str
    captured_from: str
    captured_at: str


def parse_sources(text: str) -> list[SourceRecord]:
    records: list[SourceRecord] = []
    current: dict[str, str] = {}
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line:
            if current:
                records.append(
                    SourceRecord(
                        file_name=current["file"],
                        source_url=current["source_url"],
                        captured_from=current["captured_from"],
                        captured_at=current["captured_at"],
                    )
                )
                current = {}
            continue
        key, value = line.split(": ", 1)
        current[key] = value
    if current:
        records.append(
            SourceRecord(
                file_name=current["file"],
                source_url=current["source_url"],
                captured_from=current["captured_from"],
                captured_at=current["captured_at"],
            )
        )
    return records


def read_png_size(path: Path) -> tuple[int, int]:
    with path.open("rb") as handle:
        signature = handle.read(8)
        if signature != PNG_HEADER:
            raise ValueError(f"{path} is not a PNG file")
        length = int.from_bytes(handle.read(4), "big")
        chunk_type = handle.read(4)
        if chunk_type != b"IHDR" or length < 8:
            raise ValueError(f"{path} does not contain a valid IHDR chunk")
        width = int.from_bytes(handle.read(4), "big")
        height = int.from_bytes(handle.read(4), "big")
        return width, height


def parse_view_hash(source_url: str) -> tuple[float, float, float]:
    parsed = urlparse(source_url)
    if not parsed.fragment:
        raise ValueError(f"{source_url} has no map hash")
    zoom_str, lat_str, lon_str = parsed.fragment.split("/")
    return float(zoom_str), float(lat_str), float(lon_str)


def lon_to_world_x(lon: float, zoom: float) -> float:
    return (lon + 180.0) / 360.0 * TILE_SIZE * (2 ** zoom)


def lat_to_world_y(lat: float, zoom: float) -> float:
    lat_rad = math.radians(lat)
    mercator = math.log(math.tan(math.pi / 4.0 + lat_rad / 2.0))
    return (1.0 - mercator / math.pi) / 2.0 * TILE_SIZE * (2 ** zoom)


def world_x_to_lon(world_x: float, zoom: float) -> float:
    return world_x / (TILE_SIZE * (2 ** zoom)) * 360.0 - 180.0


def world_y_to_lat(world_y: float, zoom: float) -> float:
    normalized = world_y / (TILE_SIZE * (2 ** zoom))
    mercator = math.pi * (1.0 - 2.0 * normalized)
    lat_rad = 2.0 * math.atan(math.exp(mercator)) - math.pi / 2.0
    return math.degrees(lat_rad)


def compute_bounds(center_lat: float, center_lon: float, zoom: float, image_width: int, image_height: int) -> dict[str, float]:
    viewport_width = image_width / ASSUMED_DEVICE_PIXEL_RATIO
    viewport_height = image_height / ASSUMED_DEVICE_PIXEL_RATIO
    center_x = lon_to_world_x(center_lon, zoom)
    center_y = lat_to_world_y(center_lat, zoom)
    west_x = center_x - viewport_width / 2.0
    east_x = center_x + viewport_width / 2.0
    north_y = center_y - viewport_height / 2.0
    south_y = center_y + viewport_height / 2.0
    return {
        "north": world_y_to_lat(north_y, zoom),
        "south": world_y_to_lat(south_y, zoom),
        "west": world_x_to_lon(west_x, zoom),
        "east": world_x_to_lon(east_x, zoom),
    }


def expand_bounds(bounds: dict[str, float], factor: float) -> dict[str, float]:
    lat_span = bounds["north"] - bounds["south"]
    lon_span = bounds["east"] - bounds["west"]
    return {
        "north": bounds["north"] + lat_span * factor,
        "south": bounds["south"] - lat_span * factor,
        "west": bounds["west"] - lon_span * factor,
        "east": bounds["east"] + lon_span * factor,
    }


def overpass_query(bounds: dict[str, float]) -> dict:
    query = (
        "[out:json][timeout:25];"
        f'(way["highway"]({bounds["south"]},{bounds["west"]},{bounds["north"]},{bounds["east"]}););'
        "out geom tags;"
    )
    endpoints = [
        "https://overpass-api.de/api/interpreter",
        "https://overpass.kumi.systems/api/interpreter",
        "https://lz4.overpass-api.de/api/interpreter",
    ]
    last_error: Exception | None = None
    for endpoint in endpoints:
        try:
            result = subprocess.run(
                [
                    "curl",
                    "--silent",
                    "--show-error",
                    "--fail",
                    "--header",
                    "Accept: application/json",
                    "--header",
                    "User-Agent: the-dark-side strava-fit-builder",
                    "--data-urlencode",
                    f"data={query}",
                    endpoint,
                ],
                check=True,
                capture_output=True,
                text=True,
            )
            return json.loads(result.stdout)
        except Exception as error:  # noqa: BLE001
            last_error = error
    raise RuntimeError(f"All Overpass endpoints failed for bounds {bounds}") from last_error


def to_feature_collection(overpass_payload: dict) -> dict:
    features = []
    for element in overpass_payload.get("elements", []):
        if element.get("type") != "way":
            continue
        geometry = element.get("geometry") or []
        if len(geometry) < 2:
            continue
        coordinates = [[point["lon"], point["lat"]] for point in geometry]
        features.append(
            {
                "type": "Feature",
                "id": f'way/{element["id"]}',
                "properties": {
                    "way_id": element["id"],
                    **(element.get("tags") or {}),
                },
                "geometry": {
                    "type": "LineString",
                    "coordinates": coordinates,
                },
            }
        )
    return {"type": "FeatureCollection", "features": features}


def slugify(path_name: str) -> str:
    stem = Path(path_name).stem
    return re.sub(r"[^a-z0-9]+", "-", stem.lower()).strip("-")


def ensure_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)


def build_dataset(records: Iterable[SourceRecord]) -> dict:
    ensure_dir(GENERATED_DIR)
    ensure_dir(REGIONS_DIR)

    figures = []
    for index, record in enumerate(records, start=1):
        image_path = ROOT / record.file_name
        width, height = read_png_size(image_path)
        zoom, center_lat, center_lon = parse_view_hash(record.source_url)
        approx_bounds = compute_bounds(center_lat, center_lon, zoom, width, height)
        region_bounds = expand_bounds(approx_bounds, REGION_MARGIN_FACTOR)
        region_slug = slugify(record.file_name)
        region_path = REGIONS_DIR / f"{region_slug}.geojson"
        region_fc = to_feature_collection(overpass_query(region_bounds))
        region_path.write_text(json.dumps(region_fc, indent=2) + "\n", encoding="utf-8")

        figures.append(
            {
                "id": region_slug,
                "index": index,
                "label": f"Figure {index}",
                "fileName": record.file_name,
                "imagePath": record.file_name,
                "sourceUrl": record.source_url,
                "capturedAt": record.captured_at,
                "capturedFrom": record.captured_from,
                "imageSize": {"width": width, "height": height},
                "assumedDevicePixelRatio": ASSUMED_DEVICE_PIXEL_RATIO,
                "view": {
                    "zoom": zoom,
                    "center": {"lat": center_lat, "lon": center_lon},
                },
                "approxBounds": approx_bounds,
                "regionBounds": region_bounds,
                "regionGeoJsonPath": str(region_path.relative_to(ROOT)),
            }
        )
    return {
        "generatedAt": datetime.now(UTC).isoformat(),
        "tileSize": TILE_SIZE,
        "figures": figures,
    }


def main() -> None:
    dataset = build_dataset(parse_sources(SOURCES_PATH.read_text(encoding="utf-8")))
    dataset_path = GENERATED_DIR / "strava-fit-dataset.json"
    dataset_path.write_text(json.dumps(dataset, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {dataset_path}")
    print(f"Wrote {len(dataset['figures'])} region files to {REGIONS_DIR}")


if __name__ == "__main__":
    main()
