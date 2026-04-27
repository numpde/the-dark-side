#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
from typing import Iterable

from PIL import Image, ImageDraw

EARTH_RADIUS_METERS = 6378137.0


def latlon_to_mercator(lat: float, lon: float) -> tuple[float, float]:
    lat = max(-85.05112878, min(85.05112878, lat))
    lon_rad = math.radians(lon)
    lat_rad = math.radians(lat)
    x = EARTH_RADIUS_METERS * lon_rad
    y = EARTH_RADIUS_METERS * math.log(math.tan(math.pi / 4.0 + lat_rad / 2.0))
    return x, y


def image_point_from_fit(fit: dict, lon: float, lat: float) -> tuple[float, float]:
    x_m, y_m = latlon_to_mercator(lat, lon)
    transform = fit["transform"]
    fit_type = transform["type"]
    if fit_type == "axis-aligned":
      u = (x_m - transform["xOffsetMeters"]) / transform["xMetersPerPixel"]
      v = (y_m - transform["yOffsetMeters"]) / transform["yMetersPerPixel"]
      return u, v
    if fit_type == "similarity":
      a = transform["a"]
      b = transform["b"]
      tx = transform["txMeters"]
      ty = transform["tyMeters"]
      det = a * a + b * b
      if det == 0:
          raise ValueError("Similarity transform is degenerate")
      dx = x_m - tx
      dy = y_m - ty
      u = (a * dx + b * dy) / det
      v = (-b * dx + a * dy) / det
      return u, v
    if fit_type == "affine":
      a = transform["a"]
      b = transform["b"]
      c = transform["c"]
      d = transform["d"]
      tx = transform["txMeters"]
      ty = transform["tyMeters"]
      det = a * d - b * c
      if det == 0:
          raise ValueError("Affine transform is degenerate")
      dx = x_m - tx
      dy = y_m - ty
      u = (d * dx - b * dy) / det
      v = (-c * dx + a * dy) / det
      return u, v
    raise ValueError(f"Unsupported fit type: {fit_type}")


def feature_bbox(coordinates: Iterable[list[float]]) -> tuple[float, float, float, float]:
    xs = [coord[0] for coord in coordinates]
    ys = [coord[1] for coord in coordinates]
    return min(xs), min(ys), max(xs), max(ys)


def bbox_intersects(a: tuple[float, float, float, float], b: tuple[float, float, float, float]) -> bool:
    return not (a[2] < b[0] or a[0] > b[2] or a[3] < b[1] or a[1] > b[3])


def feature_style(properties: dict) -> tuple[tuple[int, int, int, int], int]:
    highway = (properties or {}).get("highway", "")
    if highway in {"motorway", "trunk", "primary", "secondary"}:
        return (216, 52, 86, 230), 6
    if highway in {"tertiary", "unclassified", "residential", "service"}:
        return (33, 32, 38, 220), 4
    if highway in {"path", "footway", "track", "cycleway", "bridleway"}:
        return (16, 16, 20, 220), 3
    return (24, 24, 28, 200), 2


def draw_fit_overlay(dataset_path: Path, fit_path: Path, output_path: Path) -> None:
    dataset = json.loads(dataset_path.read_text(encoding="utf-8"))
    fit = json.loads(fit_path.read_text(encoding="utf-8"))

    figure = next((item for item in dataset["figures"] if item["id"] == fit["figureId"]), None)
    if figure is None:
        raise ValueError(f"Figure {fit['figureId']} not found in dataset")

    root = dataset_path.parent.parent
    screenshot_path = root / figure["imagePath"]
    region_path = root / figure["regionGeoJsonPath"]
    screenshot = Image.open(screenshot_path).convert("RGBA")
    draw = ImageDraw.Draw(screenshot, "RGBA")
    region = json.loads(region_path.read_text(encoding="utf-8"))

    bounds = fit["inferredBounds"]
    viewport_bbox = (bounds["west"], bounds["south"], bounds["east"], bounds["north"])

    for feature in region["features"]:
        geometry = feature.get("geometry") or {}
        if geometry.get("type") != "LineString":
            continue
        coordinates = geometry.get("coordinates") or []
        if len(coordinates) < 2:
            continue
        if not bbox_intersects(feature_bbox(coordinates), viewport_bbox):
            continue
        points = [image_point_from_fit(fit, lon, lat) for lon, lat in coordinates]
        color, width = feature_style(feature.get("properties") or {})
        draw.line(points, fill=(255, 255, 255, 110), width=width + 3, joint="curve")
        draw.line(points, fill=color, width=width, joint="curve")

    corners = fit.get("corners") or []
    if len(corners) == 4:
        corner_points = [image_point_from_fit(fit, corner["lon"], corner["lat"]) for corner in corners]
        corner_points.append(corner_points[0])
        draw.line(corner_points, fill=(42, 114, 255, 220), width=3)

    screenshot.save(output_path)


def main() -> None:
    parser = argparse.ArgumentParser(description="Render an OSM-on-screenshot overlay from a saved fit JSON")
    parser.add_argument("fit_json", help="Path to fit JSON, e.g. fit-1.txt")
    parser.add_argument("--dataset", default="generated/strava-fit-dataset.json", help="Dataset JSON path, relative to cwd")
    parser.add_argument("--output", default=None, help="Overlay output path; defaults to fit-json stem + -overlay.png")
    args = parser.parse_args()

    fit_path = Path(args.fit_json).resolve()
    dataset_path = Path(args.dataset).resolve()
    if args.output:
        output_path = Path(args.output).resolve()
    else:
        output_path = fit_path.with_name(f"{fit_path.stem}-overlay.png")
    draw_fit_overlay(dataset_path, fit_path, output_path)
    print(output_path)


if __name__ == "__main__":
    main()
