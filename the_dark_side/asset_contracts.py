"""Shared JSON asset validators/loaders for canonical and derived documents."""

from __future__ import annotations

import json
from datetime import date
from pathlib import Path


def load_required_json(path: Path, *, label: str) -> dict:
    if not path.exists():
        raise FileNotFoundError(f"missing {label}: {path}")
    return require_json_object(json.loads(path.read_text()), label=label)


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


def require_iso_date_string(value: object, *, label: str) -> str:
    text = require_nonempty_string(value, label=label)
    try:
        parsed = date.fromisoformat(text)
    except ValueError as exc:
        raise ValueError(f"{label} must be a valid YYYY-MM-DD date") from exc
    if parsed.isoformat() != text:
        raise ValueError(f"{label} must be a valid YYYY-MM-DD date")
    return text


def validate_patchset_document(payload: object, *, label: str) -> dict:
    document = require_json_object(payload, label=label)
    meta = require_json_object(document.get("meta"), label=f"{label}.meta")
    require_nonempty_string(meta.get("asset_kind"), label=f"{label}.meta.asset_kind")
    require_nonempty_string(meta.get("patchset_id"), label=f"{label}.meta.patchset_id")
    require_json_array(document.get("patches"), label=f"{label}.patches")
    return document


def load_required_patchset(path: Path, *, label: str) -> dict:
    return validate_patchset_document(load_required_json(path, label=label), label=label)


def require_integer_array(value: object, *, label: str, min_length: int = 0) -> list[int]:
    items = require_json_array(value, label=label)
    if any(not isinstance(item, int) for item in items):
        raise ValueError(f"{label} must contain only integers")
    if len(items) < min_length:
        raise ValueError(f"{label} must contain at least {min_length} items")
    return items


def validate_route_policy_fields(policy: object, *, label: str) -> dict:
    normalized_policy = require_json_object(policy, label=label)
    if not normalized_policy:
        raise ValueError(f"{label} must contain at least one policy field")
    for key, value in normalized_policy.items():
        if key == "routing_state":
            if value not in {"include", "exclude"}:
                raise ValueError(f"{label}.routing_state must be include or exclude")
        elif key == "bikeability":
            if not isinstance(value, int) or value < 1 or value > 5:
                raise ValueError(f"{label}.bikeability must be an integer from 1 to 5")
        elif key == "bicycle_direction":
            if value not in {"forward", "backward"}:
                raise ValueError(f"{label}.bicycle_direction must be forward or backward")
        elif key == "unavailable_until":
            require_iso_date_string(value, label=f"{label}.unavailable_until")
        else:
            raise ValueError(f"{label} contains unsupported field {key!r}")
    return normalized_policy


def validate_route_policy_document(payload: object, *, label: str) -> dict:
    document = require_json_object(payload, label=label)
    meta = require_json_object(document.get("meta"), label=f"{label}.meta")
    require_nonempty_string(meta.get("asset_kind"), label=f"{label}.meta.asset_kind")
    require_nonempty_string(meta.get("asset_id"), label=f"{label}.meta.asset_id")
    rules = require_json_array(document.get("rules"), label=f"{label}.rules")
    for index, rule in enumerate(rules):
        item = require_json_object(rule, label=f"{label}.rules[{index}]")
        require_nonempty_string(item.get("id"), label=f"{label}.rules[{index}].id")
        selector = require_json_object(item.get("selector"), label=f"{label}.rules[{index}].selector")
        require_integer_array(selector.get("way_ids"), label=f"{label}.rules[{index}].selector.way_ids", min_length=1)
        require_integer_array(selector.get("node_ids"), label=f"{label}.rules[{index}].selector.node_ids", min_length=2)
        validate_route_policy_fields(item.get("policy"), label=f"{label}.rules[{index}].policy")
    return document


def load_required_route_policy(path: Path, *, label: str) -> dict:
    return validate_route_policy_document(load_required_json(path, label=label), label=label)


def validate_route_policy_bindings_document(payload: object, *, label: str) -> dict:
    document = require_json_object(payload, label=label)
    meta = require_json_object(document.get("meta"), label=f"{label}.meta")
    require_nonempty_string(meta.get("asset_id"), label=f"{label}.meta.asset_id")
    require_nonempty_string(meta.get("asset_kind"), label=f"{label}.meta.asset_kind")
    require_nonempty_string(meta.get("graph_asset_id"), label=f"{label}.meta.graph_asset_id")
    require_nonempty_string(meta.get("route_policy_asset_id"), label=f"{label}.meta.route_policy_asset_id")
    bindings = require_json_array(document.get("bindings"), label=f"{label}.bindings")
    for index, binding in enumerate(bindings):
        item = require_json_object(binding, label=f"{label}.bindings[{index}]")
        require_nonempty_string(item.get("rule_id"), label=f"{label}.bindings[{index}].rule_id")
        status = require_nonempty_string(item.get("status"), label=f"{label}.bindings[{index}].status")
        if status not in {"exact", "reversed", "split_across_contigs"}:
            raise ValueError(
                f"{label}.bindings[{index}].status must be exact, reversed, or split_across_contigs"
            )
        selector = require_json_object(item.get("selector"), label=f"{label}.bindings[{index}].selector")
        require_integer_array(selector.get("way_ids"), label=f"{label}.bindings[{index}].selector.way_ids", min_length=1)
        require_integer_array(selector.get("node_ids"), label=f"{label}.bindings[{index}].selector.node_ids", min_length=2)
        validate_route_policy_fields(item.get("policy"), label=f"{label}.bindings[{index}].policy")
        matches = require_json_array(item.get("matches"), label=f"{label}.bindings[{index}].matches")
        if len(matches) == 0:
            raise ValueError(f"{label}.bindings[{index}].matches must contain at least one match")
        for match_index, match in enumerate(matches):
            match_item = require_json_object(
                match,
                label=f"{label}.bindings[{index}].matches[{match_index}]",
            )
            contig_id = match_item.get("contig_id")
            if not isinstance(contig_id, int):
                raise ValueError(
                    f"{label}.bindings[{index}].matches[{match_index}].contig_id must be an integer"
                )
            require_integer_array(
                match_item.get("way_ids"),
                label=f"{label}.bindings[{index}].matches[{match_index}].way_ids",
                min_length=1,
            )
            require_integer_array(
                match_item.get("node_ids"),
                label=f"{label}.bindings[{index}].matches[{match_index}].node_ids",
                min_length=2,
            )
    return document


def load_required_route_policy_bindings(path: Path, *, label: str) -> dict:
    return validate_route_policy_bindings_document(load_required_json(path, label=label), label=label)


def validate_junction_catalog_document(payload: object, *, label: str) -> dict:
    document = require_json_object(payload, label=label)
    meta = require_json_object(document.get("meta"), label=f"{label}.meta")
    require_nonempty_string(meta.get("asset_id"), label=f"{label}.meta.asset_id")
    require_nonempty_string(meta.get("asset_kind"), label=f"{label}.meta.asset_kind")
    area_ids: set[str] = set()
    if "areas" in meta:
        areas = require_json_array(meta.get("areas"), label=f"{label}.meta.areas")
        for index, area in enumerate(areas):
            item = require_json_object(area, label=f"{label}.meta.areas[{index}]")
            area_id = require_nonempty_string(item.get("id"), label=f"{label}.meta.areas[{index}].id")
            require_nonempty_string(item.get("name"), label=f"{label}.meta.areas[{index}].name")
            if area_id in area_ids:
                raise ValueError(f"{label}.meta.areas contains duplicate id {area_id!r}")
            area_ids.add(area_id)
    junctions = require_json_array(document.get("junctions"), label=f"{label}.junctions")
    for index, junction in enumerate(junctions):
        item = require_json_object(junction, label=f"{label}.junctions[{index}]")
        require_nonempty_string(item.get("id"), label=f"{label}.junctions[{index}].id")
        require_nonempty_string(item.get("name"), label=f"{label}.junctions[{index}].name")
        area_id = item.get("area_id")
        if area_id is not None:
            normalized_area_id = require_nonempty_string(area_id, label=f"{label}.junctions[{index}].area_id")
            if area_ids and normalized_area_id not in area_ids:
                raise ValueError(
                    f"{label}.junctions[{index}].area_id references unknown area {normalized_area_id!r}"
                )
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


def validate_elevation_asset_document(payload: object, *, label: str) -> dict:
    document = require_json_object(payload, label=label)
    meta = require_json_object(document.get("meta"), label=f"{label}.meta")
    require_nonempty_string(meta.get("graph_asset_id"), label=f"{label}.meta.graph_asset_id")
    nodes = require_json_object(document.get("nodes"), label=f"{label}.nodes")
    for node_id, node_payload in nodes.items():
        if not isinstance(node_id, str):
            raise ValueError(f"{label}.nodes keys must be strings")
        item = require_json_object(node_payload, label=f"{label}.nodes[{node_id}]")
        elevation_m = item.get("elevation_m")
        if elevation_m is None:
            continue
        if not isinstance(elevation_m, (int, float)):
            raise ValueError(f"{label}.nodes[{node_id}].elevation_m must be numeric")
    return document


def load_required_elevation_asset(path: Path, *, label: str) -> dict:
    return validate_elevation_asset_document(load_required_json(path, label=label), label=label)


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


def validate_route_graph_document(payload: object, *, label: str) -> dict:
    document = require_json_object(payload, label=label)
    meta = require_json_object(document.get("meta"), label=f"{label}.meta")
    require_nonempty_string(meta.get("asset_id"), label=f"{label}.meta.asset_id")
    require_nonempty_string(meta.get("asset_kind"), label=f"{label}.meta.asset_kind")

    nodes = require_json_object(document.get("nodes"), label=f"{label}.nodes")
    for node_id, node_payload in nodes.items():
        if not isinstance(node_id, str):
            raise ValueError(f"{label}.nodes keys must be strings")
        item = require_json_object(node_payload, label=f"{label}.nodes[{node_id}]")
        lat = item.get("lat")
        lon = item.get("lon")
        if not isinstance(lat, (int, float)) or not isinstance(lon, (int, float)):
            raise ValueError(f"{label}.nodes[{node_id}] must contain numeric lat/lon")

    crossings = require_json_object(document.get("crossings"), label=f"{label}.crossings")
    for node_id, crossing_payload in crossings.items():
        if not isinstance(node_id, str):
            raise ValueError(f"{label}.crossings keys must be strings")
        item = require_json_object(crossing_payload, label=f"{label}.crossings[{node_id}]")
        degree = item.get("degree")
        if not isinstance(degree, int):
            raise ValueError(f"{label}.crossings[{node_id}].degree must be an integer")

    contigs = require_json_array(document.get("contigs"), label=f"{label}.contigs")
    for index, contig_payload in enumerate(contigs):
        item = require_json_object(contig_payload, label=f"{label}.contigs[{index}]")
        if not isinstance(item.get("id"), int):
            raise ValueError(f"{label}.contigs[{index}].id must be an integer")
        endpoint_node_ids = require_json_array(
            item.get("endpoint_node_ids"),
            label=f"{label}.contigs[{index}].endpoint_node_ids",
        )
        if len(endpoint_node_ids) != 2 or any(not isinstance(node_id, int) for node_id in endpoint_node_ids):
            raise ValueError(f"{label}.contigs[{index}].endpoint_node_ids must be a 2-element integer array")
        node_ids = require_json_array(item.get("node_ids"), label=f"{label}.contigs[{index}].node_ids")
        if len(node_ids) < 2 or any(not isinstance(node_id, int) for node_id in node_ids):
            raise ValueError(f"{label}.contigs[{index}].node_ids must be an integer array with at least 2 items")
        if not isinstance(item.get("length_m"), (int, float)):
            raise ValueError(f"{label}.contigs[{index}].length_m must be numeric")
        if not isinstance(item.get("is_cycle"), bool):
            raise ValueError(f"{label}.contigs[{index}].is_cycle must be a boolean")
        if not isinstance(item.get("segment_count"), int):
            raise ValueError(f"{label}.contigs[{index}].segment_count must be an integer")
        way_ids = require_json_array(item.get("way_ids"), label=f"{label}.contigs[{index}].way_ids")
        if any(not isinstance(way_id, int) for way_id in way_ids):
            raise ValueError(f"{label}.contigs[{index}].way_ids must be an integer array")
        way_names = require_json_array(item.get("way_names"), label=f"{label}.contigs[{index}].way_names")
        if any(not isinstance(name, str) for name in way_names):
            raise ValueError(f"{label}.contigs[{index}].way_names must be a string array")
        highway_types = require_json_object(
            item.get("highway_types"),
            label=f"{label}.contigs[{index}].highway_types",
        )
        for highway_name, count in highway_types.items():
            if not isinstance(highway_name, str) or not isinstance(count, int):
                raise ValueError(
                    f"{label}.contigs[{index}].highway_types must be an object of string -> integer"
                )
        tags = require_json_object(item.get("tags"), label=f"{label}.contigs[{index}].tags")
        for tag_key, tag_value in tags.items():
            if not isinstance(tag_key, str) or not isinstance(tag_value, str):
                raise ValueError(f"{label}.contigs[{index}].tags must be an object of string -> string")
    return document


def validate_route_asset_document(payload: object, *, label: str) -> dict:
    document = require_json_object(payload, label=label)
    meta = require_json_object(document.get("meta"), label=f"{label}.meta")
    require_nonempty_string(meta.get("asset_id"), label=f"{label}.meta.asset_id")
    require_nonempty_string(meta.get("asset_kind"), label=f"{label}.meta.asset_kind")
    require_nonempty_string(meta.get("algorithm"), label=f"{label}.meta.algorithm")
    require_nonempty_string(meta.get("graph_asset_id"), label=f"{label}.meta.graph_asset_id")
    require_nonempty_string(meta.get("graph_path"), label=f"{label}.meta.graph_path")
    require_nonempty_string(
        meta.get("junction_catalog_asset_id"),
        label=f"{label}.meta.junction_catalog_asset_id",
    )
    junction_bindings_asset_id = meta.get("junction_bindings_asset_id")
    if junction_bindings_asset_id is not None:
        require_nonempty_string(
            junction_bindings_asset_id,
            label=f"{label}.meta.junction_bindings_asset_id",
        )
    require_nonempty_string(meta.get("start_junction_id"), label=f"{label}.meta.start_junction_id")
    require_nonempty_string(meta.get("end_junction_id"), label=f"{label}.meta.end_junction_id")
    if not isinstance(meta.get("seed"), int):
        raise ValueError(f"{label}.meta.seed must be an integer")

    config = require_json_object(document.get("config"), label=f"{label}.config")
    if not config:
        raise ValueError(f"{label}.config must not be empty")

    for endpoint_name in ("start", "end"):
        endpoint = require_json_object(document.get(endpoint_name), label=f"{label}.{endpoint_name}")
        require_nonempty_string(endpoint.get("junction_id"), label=f"{label}.{endpoint_name}.junction_id")
        require_nonempty_string(endpoint.get("name"), label=f"{label}.{endpoint_name}.name")
        if not isinstance(endpoint.get("graph_node_id"), int):
            raise ValueError(f"{label}.{endpoint_name}.graph_node_id must be an integer")
        incident_contig_ids = require_json_array(
            endpoint.get("incident_contig_ids"),
            label=f"{label}.{endpoint_name}.incident_contig_ids",
        )
        for contig_index, contig_id in enumerate(incident_contig_ids):
            if not isinstance(contig_id, int):
                raise ValueError(
                    f"{label}.{endpoint_name}.incident_contig_ids[{contig_index}] must be an integer"
                )
        location = require_json_object(endpoint.get("location"), label=f"{label}.{endpoint_name}.location")
        lat = location.get("lat")
        lon = location.get("lon")
        if not isinstance(lat, (int, float)) or not isinstance(lon, (int, float)):
            raise ValueError(f"{label}.{endpoint_name}.location must contain numeric lat/lon")
        notes = endpoint.get("notes")
        if notes is not None and not isinstance(notes, str):
            raise ValueError(f"{label}.{endpoint_name}.notes must be a string")
        tags = endpoint.get("tags")
        if tags is not None:
            require_json_array(tags, label=f"{label}.{endpoint_name}.tags")

    routes = require_json_array(document.get("routes"), label=f"{label}.routes")
    for route_index, route in enumerate(routes):
        route_item = require_json_object(route, label=f"{label}.routes[{route_index}]")
        if not isinstance(route_item.get("complete"), bool):
            raise ValueError(f"{label}.routes[{route_index}].complete must be a boolean")
        if not isinstance(route_item.get("score"), (int, float)):
            raise ValueError(f"{label}.routes[{route_index}].score must be numeric")
        route_node_ids = require_json_array(
            route_item.get("route_node_ids"),
            label=f"{label}.routes[{route_index}].route_node_ids",
        )
        for node_index, node_id in enumerate(route_node_ids):
            if not isinstance(node_id, int):
                raise ValueError(
                    f"{label}.routes[{route_index}].route_node_ids[{node_index}] must be an integer"
                )
        steps = require_json_array(route_item.get("steps"), label=f"{label}.routes[{route_index}].steps")
        for step_index, step in enumerate(steps):
            step_item = require_json_object(step, label=f"{label}.routes[{route_index}].steps[{step_index}]")
            for field_name in ("contig_id", "from_node_id", "to_node_id"):
                if not isinstance(step_item.get(field_name), int):
                    raise ValueError(
                        f"{label}.routes[{route_index}].steps[{step_index}].{field_name} must be an integer"
                    )
            if not isinstance(step_item.get("reused"), bool):
                raise ValueError(f"{label}.routes[{route_index}].steps[{step_index}].reused must be a boolean")
            if not isinstance(step_item.get("length_m"), (int, float)):
                raise ValueError(
                    f"{label}.routes[{route_index}].steps[{step_index}].length_m must be numeric"
                )
    return document


def load_route_asset_document(path: Path, *, label: str) -> dict:
    return validate_route_asset_document(load_required_json(path, label=label), label=label)


def load_route_graph_document(path: Path, *, label: str) -> dict:
    return validate_route_graph_document(load_required_json(path, label=label), label=label)
