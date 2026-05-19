"""Helpers for the canonical area catalog."""

from __future__ import annotations

from pathlib import Path
from typing import Iterable

from .asset_contracts import load_required_area_catalog
from .karura_common import AREAS_JSON


def boundary_component_ref(component_type: str, component_id: int) -> str:
    if component_type == "relation":
        return f"r{int(component_id)}"
    if component_type == "way":
        return f"w{int(component_id)}"
    raise ValueError(f"unsupported boundary component type: {component_type!r}")


def boundary_component_refs(components: Iterable[dict]) -> list[str]:
    return [
        boundary_component_ref(str(component["type"]), int(component["id"]))
        for component in components
    ]


def load_area_catalog(path: Path = AREAS_JSON) -> dict:
    return load_required_area_catalog(path, label="area catalog")


def area_defs(area_catalog: dict) -> list[dict]:
    return [
        {
            **area,
            "boundary_refs": boundary_component_refs(area["boundary_components"]),
        }
        for area in area_catalog["areas"]
    ]


def relation_ids_from_areas(area_catalog: dict) -> list[int]:
    return sorted({
        int(component["id"])
        for area in area_catalog["areas"]
        for component in area["boundary_components"]
        if component["type"] == "relation"
    })


def boundary_way_ids_from_areas(area_catalog: dict) -> list[int]:
    return sorted({
        int(component["id"])
        for area in area_catalog["areas"]
        for component in area["boundary_components"]
        if component["type"] == "way"
    })
