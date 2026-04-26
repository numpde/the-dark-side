"""Shared helpers for screenshot-aligned debug renderers."""

from __future__ import annotations

import json
from pathlib import Path

from PIL import Image, ImageOps

from .karura_common import mercator


BASE_IMAGE_ALPHA = 0.7


def load_viewport(path: Path) -> dict:
    return json.loads(path.read_text())["viewport"]


def prepare_base_image(path: Path, *, alpha: float = BASE_IMAGE_ALPHA) -> Image.Image:
    source = Image.open(path).convert("RGBA")
    grayscale = ImageOps.grayscale(source).convert("RGBA")
    grayscale.putalpha(int(round(255 * alpha)))
    canvas = Image.new("RGBA", source.size, (255, 255, 255, 255))
    canvas.alpha_composite(grayscale)
    return canvas


def project_mercator_point(xy: tuple[float, float], viewport: dict, size: tuple[int, int]) -> tuple[float, float]:
    width, height = size
    return (
        (xy[0] - viewport["center_x"]) / viewport["meters_per_px"] + width / 2,
        (viewport["center_y"] - xy[1]) / viewport["meters_per_px"] + height / 2,
    )


def project_lon_lat(lon: float, lat: float, viewport: dict, size: tuple[int, int]) -> tuple[float, float]:
    return project_mercator_point(mercator(lon, lat), viewport, size)
