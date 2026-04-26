#!/usr/bin/env python3

"""Download Karura OSM data and normalize it into a local JSON structure."""

from __future__ import annotations

import argparse
import json
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .karura_common import MAP_JSON as DEFAULT_MAP_JSON, RAW_JSON as DEFAULT_RAW_JSON

DEFAULT_RELATION_IDS = [13626194, 15417497]
DEFAULT_OVERPASS_URL = "https://overpass-api.de/api/interpreter"
USER_AGENT = "karura-map-downloader/1.0"


def timestamp_asset_suffix(iso_timestamp: str) -> str:
    return (
        iso_timestamp.replace("-", "")
        .replace(":", "")
        .replace(".", "")
        .replace("+00:00", "Z")
    )


@dataclass(frozen=True)
class NodeRecord:
    id: int
    lat: float
    lon: float

    def to_dict(self) -> dict[str, Any]:
        return {"id": self.id, "lat": self.lat, "lon": self.lon}


@dataclass(frozen=True)
class WayRecord:
    id: int
    node_ids: list[int]
    tags: dict[str, str]
    segment_pairs: list[list[int]]
    total_length_m: float
    inside_length_m: float
    bounds: list[float]

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "node_ids": self.node_ids,
            "tags": self.tags,
            "segment_pairs": self.segment_pairs,
            "total_length_m": round(self.total_length_m, 3),
            "inside_length_m": round(self.inside_length_m, 3),
            "bounds": self.bounds,
        }


@dataclass(frozen=True)
class BoundaryComponent:
    relation_id: int
    relation_tags: dict[str, str]
    outer_rings: list[list[int]]
    inner_rings: list[list[int]]

    def to_dict(self) -> dict[str, Any]:
        return {
            "relation_id": self.relation_id,
            "relation_tags": self.relation_tags,
            "outer_rings": self.outer_rings,
            "inner_rings": self.inner_rings,
        }


@dataclass(frozen=True)
class BoundaryRecord:
    relation_id: int
    relation_tags: dict[str, str]
    outer_rings: list[list[int]]
    inner_rings: list[list[int]]
    components: list[BoundaryComponent] = field(default_factory=list)

    def iter_components(self) -> list[BoundaryComponent]:
        if self.components:
            return self.components
        return [
            BoundaryComponent(
                relation_id=self.relation_id,
                relation_tags=self.relation_tags,
                outer_rings=self.outer_rings,
                inner_rings=self.inner_rings,
            )
        ]

    def to_dict(self) -> dict[str, Any]:
        payload = {
            "relation_id": self.relation_id,
            "relation_tags": self.relation_tags,
            "outer_rings": self.outer_rings,
            "inner_rings": self.inner_rings,
        }
        if self.components:
            payload["components"] = [component.to_dict() for component in self.components]
            payload["relation_ids"] = [component.relation_id for component in self.components]
        return payload


@dataclass(frozen=True)
class KaruraMap:
    meta: dict[str, Any]
    boundary: BoundaryRecord
    nodes: dict[int, NodeRecord]
    ways: dict[int, WayRecord]

    def to_dict(self) -> dict[str, Any]:
        return {
            "meta": self.meta,
            "boundary": self.boundary.to_dict(),
            "nodes": {str(node_id): node.to_dict() for node_id, node in sorted(self.nodes.items())},
            "ways": {str(way_id): way.to_dict() for way_id, way in sorted(self.ways.items())},
        }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--relation-id",
        dest="relation_ids",
        type=int,
        action="append",
        help="OSM relation id to include; repeat to union multiple relations",
    )
    parser.add_argument("--overpass-url", default=DEFAULT_OVERPASS_URL)
    parser.add_argument("--raw-json", type=Path, default=DEFAULT_RAW_JSON)
    parser.add_argument("--map-json", type=Path, default=DEFAULT_MAP_JSON)
    parser.add_argument("--timeout", type=int, default=180)
    parser.add_argument("--retries", type=int, default=3)
    parser.add_argument("--pause-seconds", type=float, default=2.0)
    parser.add_argument(
        "--fill-segment-gaps",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Fill clipped gaps between kept segments on the same way",
    )
    parser.add_argument(
        "--respect-inner-rings",
        action=argparse.BooleanOptionalAction,
        default=False,
        help="Respect inner rings as holes instead of using only the outer shell",
    )
    args = parser.parse_args()
    if not args.relation_ids:
        args.relation_ids = list(DEFAULT_RELATION_IDS)
    return args


def build_query(relation_ids: list[int], timeout: int) -> str:
    relation_lines: list[str] = []
    collect_lines: list[str] = []
    for index, relation_id in enumerate(relation_ids):
        relation_lines.extend(
            [
                f"rel({relation_id})->.rel{index};",
                f".rel{index} map_to_area->.area{index};",
            ]
        )
        collect_lines.extend(
            [
                f"  .rel{index};",
                f"  way(r.rel{index});",
                f"  way(area.area{index});",
            ]
        )
    return f"""
[out:json][timeout:{timeout}];
{chr(10).join(relation_lines)}
(
{chr(10).join(collect_lines)}
);
(._;>;);
out body;
""".strip()


def download_overpass(query: str, url: str, timeout: int, retries: int, pause_seconds: float) -> dict[str, Any]:
    payload = urllib.parse.urlencode({"data": query}).encode("utf-8")
    headers = {
        "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
        "User-Agent": USER_AGENT,
    }

    last_error: Exception | None = None
    for attempt in range(1, retries + 1):
        request = urllib.request.Request(url, data=payload, headers=headers, method="POST")
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return json.loads(response.read().decode("utf-8"))
        except (TimeoutError, urllib.error.URLError, urllib.error.HTTPError, json.JSONDecodeError) as exc:
            last_error = exc
            if attempt == retries:
                break
            time.sleep(pause_seconds)

    raise RuntimeError(f"Overpass download failed after {retries} attempts") from last_error


def join_rings(ref_lists: list[list[int]]) -> list[list[int]]:
    chains = [list(refs) for refs in ref_lists if len(refs) >= 2]
    rings: list[list[int]] = []

    while chains:
        ring = chains.pop(0)
        changed = True
        while changed:
            changed = False
            index = 0
            while index < len(chains):
                seq = chains[index]
                if ring[-1] == seq[0]:
                    ring = ring + seq[1:]
                elif ring[-1] == seq[-1]:
                    ring = ring + list(reversed(seq[:-1]))
                elif ring[0] == seq[-1]:
                    ring = seq[:-1] + ring
                elif ring[0] == seq[0]:
                    ring = list(reversed(seq[1:])) + ring
                else:
                    index += 1
                    continue
                chains.pop(index)
                changed = True
        if ring and ring[0] == ring[-1]:
            rings.append(ring)

    return rings


def point_in_ring(point: tuple[float, float], ring: list[tuple[float, float]]) -> bool:
    lon, lat = point
    inside = False

    for index in range(len(ring) - 1):
        lon1, lat1 = ring[index]
        lon2, lat2 = ring[index + 1]
        if ((lat1 > lat) != (lat2 > lat)) and (
            lon < (lon2 - lon1) * (lat - lat1) / ((lat2 - lat1) or 1e-12) + lon1
        ):
            inside = not inside

    return inside


def haversine_meters(a: NodeRecord, b: NodeRecord) -> float:
    from math import asin, cos, radians, sin, sqrt

    dlat = radians(b.lat - a.lat)
    dlon = radians(b.lon - a.lon)
    lat1 = radians(a.lat)
    lat2 = radians(b.lat)
    value = sin(dlat / 2) ** 2 + cos(lat1) * cos(lat2) * sin(dlon / 2) ** 2
    return 2 * 6371000.0 * asin(sqrt(value))


def keep_segment_by_endpoint(first: NodeRecord, second: NodeRecord, inside_karura) -> bool:
    return inside_karura((first.lon, first.lat)) or inside_karura((second.lon, second.lat))


def fill_kept_segment_gaps(keep_flags: list[bool]) -> list[bool]:
    kept_indices = [index for index, keep in enumerate(keep_flags) if keep]
    if len(kept_indices) < 2:
        return keep_flags
    filled = list(keep_flags)
    for start_index, end_index in zip(kept_indices, kept_indices[1:]):
        if end_index - start_index > 1:
            for index in range(start_index + 1, end_index):
                filled[index] = True
    return filled


def build_map(
    payload: dict[str, Any],
    relation_ids: list[int],
    overpass_url: str,
    query: str,
    *,
    fill_segment_gaps: bool = True,
    respect_inner_rings: bool = False,
) -> KaruraMap:
    nodes: dict[int, NodeRecord] = {}
    way_rows: dict[int, dict[str, Any]] = {}
    relations: dict[int, dict[str, Any]] = {}

    for element in payload.get("elements", []):
        element_type = element.get("type")
        element_id = int(element["id"])
        if element_type == "node":
            nodes[element_id] = NodeRecord(id=element_id, lat=float(element["lat"]), lon=float(element["lon"]))
        elif element_type == "way":
            way_rows[element_id] = {
                "id": element_id,
                "node_ids": [int(node_id) for node_id in element.get("nodes", [])],
                "tags": dict(element.get("tags", {})),
            }
        elif element_type == "relation" and element_id in relation_ids:
            relations[element_id] = element

    missing_relations = [relation_id for relation_id in relation_ids if relation_id not in relations]
    if missing_relations:
        raise RuntimeError(f"Relations were not returned by Overpass: {missing_relations}")

    boundary_components: list[BoundaryComponent] = []
    boundary_way_refs: set[int] = set()
    for relation_id in relation_ids:
        relation = relations[relation_id]
        outer_way_refs = [
            int(member["ref"])
            for member in relation.get("members", [])
            if member.get("type") == "way" and member.get("role") == "outer"
        ]
        inner_way_refs = [
            int(member["ref"])
            for member in relation.get("members", [])
            if member.get("type") == "way" and member.get("role") == "inner"
        ]
        boundary_way_refs.update(outer_way_refs)
        boundary_way_refs.update(inner_way_refs)
        boundary_components.append(
            BoundaryComponent(
                relation_id=relation_id,
                relation_tags=dict(relation.get("tags", {})),
                outer_rings=join_rings([way_rows[way_id]["node_ids"] for way_id in outer_way_refs if way_id in way_rows]),
                inner_rings=join_rings([way_rows[way_id]["node_ids"] for way_id in inner_way_refs if way_id in way_rows]),
            )
        )

    component_coords = [
        (
            [[(nodes[node_id].lon, nodes[node_id].lat) for node_id in ring if node_id in nodes] for ring in component.outer_rings],
            [[(nodes[node_id].lon, nodes[node_id].lat) for node_id in ring if node_id in nodes] for ring in component.inner_rings],
        )
        for component in boundary_components
    ]

    def inside_karura(point: tuple[float, float]) -> bool:
        for outer_ring_coords, inner_ring_coords in component_coords:
            if not any(point_in_ring(point, ring) for ring in outer_ring_coords):
                continue
            if respect_inner_rings and any(point_in_ring(point, ring) for ring in inner_ring_coords):
                continue
            return True
        return False

    ways: dict[int, WayRecord] = {}
    for way_id, row in way_rows.items():
        node_ids = [node_id for node_id in row["node_ids"] if node_id in nodes]
        if len(node_ids) < 2:
            continue

        segment_pairs: list[list[int]] = []
        total_length_m = 0.0
        inside_length_m = 0.0

        lats = [nodes[node_id].lat for node_id in node_ids]
        lons = [nodes[node_id].lon for node_id in node_ids]
        bounds = [min(lons), min(lats), max(lons), max(lats)]

        segments = list(zip(node_ids, node_ids[1:]))
        keep_flags = []
        segment_lengths = []
        for first_id, second_id in segments:
            first = nodes[first_id]
            second = nodes[second_id]
            segment_length = haversine_meters(first, second)
            total_length_m += segment_length
            segment_lengths.append(segment_length)
            keep_flags.append(keep_segment_by_endpoint(first, second, inside_karura))

        if fill_segment_gaps:
            keep_flags = fill_kept_segment_gaps(keep_flags)
        for (first_id, second_id), segment_length, keep in zip(segments, segment_lengths, keep_flags):
            if keep:
                segment_pairs.append([first_id, second_id])
                inside_length_m += segment_length

        if not segment_pairs and way_id not in boundary_way_refs:
            continue

        ways[way_id] = WayRecord(
            id=way_id,
            node_ids=node_ids,
            tags=row["tags"],
            segment_pairs=segment_pairs,
            total_length_m=total_length_m,
            inside_length_m=inside_length_m,
            bounds=[round(value, 7) for value in bounds],
        )

    relation_names = [relations[relation_id].get("tags", {}).get("name", str(relation_id)) for relation_id in relation_ids]
    boundary = BoundaryRecord(
        relation_id=relation_ids[0],
        relation_tags={"name": "Karura union boundary", "type": "derived_union"},
        outer_rings=[ring for component in boundary_components for ring in component.outer_rings],
        inner_rings=[ring for component in boundary_components for ring in component.inner_rings],
        components=boundary_components,
    )

    downloaded_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    meta = {
        "name": " + ".join(relation_names),
        "asset_id": f"karura-map-r{'-r'.join(str(relation_id) for relation_id in relation_ids)}-{timestamp_asset_suffix(downloaded_at)}",
        "asset_kind": "map",
        "downloaded_at": downloaded_at,
        "overpass_url": overpass_url,
        "query": query,
        "relation_ids": relation_ids,
        "relations": [
            {
                "relation_id": relation_id,
                "relation_tags": dict(relations[relation_id].get("tags", {})),
            }
            for relation_id in relation_ids
        ],
        "fill_segment_gaps": fill_segment_gaps,
        "respect_inner_rings": respect_inner_rings,
        "node_count": len(nodes),
        "way_count": len(ways),
        "raw_element_count": len(payload.get("elements", [])),
    }

    return KaruraMap(meta=meta, boundary=boundary, nodes=nodes, ways=ways)


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n")


def load_map(path: Path) -> KaruraMap:
    payload = json.loads(path.read_text())
    boundary_payload = payload["boundary"]
    boundary = BoundaryRecord(
        relation_id=int(boundary_payload["relation_id"]),
        relation_tags=dict(boundary_payload["relation_tags"]),
        outer_rings=[[int(node_id) for node_id in ring] for ring in boundary_payload["outer_rings"]],
        inner_rings=[[int(node_id) for node_id in ring] for ring in boundary_payload["inner_rings"]],
        components=[
            BoundaryComponent(
                relation_id=int(component_payload["relation_id"]),
                relation_tags=dict(component_payload["relation_tags"]),
                outer_rings=[[int(node_id) for node_id in ring] for ring in component_payload["outer_rings"]],
                inner_rings=[[int(node_id) for node_id in ring] for ring in component_payload["inner_rings"]],
            )
            for component_payload in boundary_payload.get("components", [])
        ],
    )
    nodes = {
        int(node_id): NodeRecord(
            id=int(node_payload["id"]),
            lat=float(node_payload["lat"]),
            lon=float(node_payload["lon"]),
        )
        for node_id, node_payload in payload["nodes"].items()
    }
    ways = {
        int(way_id): WayRecord(
            id=int(way_payload["id"]),
            node_ids=[int(node_id) for node_id in way_payload["node_ids"]],
            tags=dict(way_payload["tags"]),
            segment_pairs=[[int(node_id) for node_id in pair] for pair in way_payload["segment_pairs"]],
            total_length_m=float(way_payload["total_length_m"]),
            inside_length_m=float(way_payload["inside_length_m"]),
            bounds=[float(value) for value in way_payload["bounds"]],
        )
        for way_id, way_payload in payload["ways"].items()
    }
    return KaruraMap(meta=dict(payload["meta"]), boundary=boundary, nodes=nodes, ways=ways)


def main() -> None:
    args = parse_args()
    query = build_query(args.relation_ids, args.timeout)
    payload = download_overpass(
        query=query,
        url=args.overpass_url,
        timeout=args.timeout,
        retries=args.retries,
        pause_seconds=args.pause_seconds,
    )
    write_json(args.raw_json, payload)

    karura_map = build_map(
        payload,
        relation_ids=args.relation_ids,
        overpass_url=args.overpass_url,
        query=query,
        fill_segment_gaps=args.fill_segment_gaps,
        respect_inner_rings=args.respect_inner_rings,
    )
    write_json(args.map_json, karura_map.to_dict())

    summary = {
        "relation_ids": args.relation_ids,
        "raw_json": str(args.raw_json),
        "map_json": str(args.map_json),
        "node_count": len(karura_map.nodes),
        "way_count": len(karura_map.ways),
        "outer_ring_count": len(karura_map.boundary.outer_rings),
        "inner_ring_count": len(karura_map.boundary.inner_rings),
        "fill_segment_gaps": args.fill_segment_gaps,
        "respect_inner_rings": args.respect_inner_rings,
    }
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
