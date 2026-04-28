from __future__ import annotations

import hashlib
import json
from typing import Any

from .asset_contracts import (
    validate_route_policy_bindings_document,
    validate_route_policy_document,
)
from .karura_common import (
    LOCAL_AVAILABILITY_TAG,
    LOCAL_BICYCLE_DIRECTION_TAG,
    LOCAL_BIKEABILITY_TAG,
    LOCAL_ROUTING_STATE_TAG,
    LOCAL_UNAVAILABLE_UNTIL_TAG,
    is_currently_unavailable,
)

POLICY_TAG_KEYS = (
    LOCAL_ROUTING_STATE_TAG,
    LOCAL_BIKEABILITY_TAG,
    LOCAL_BICYCLE_DIRECTION_TAG,
    LOCAL_AVAILABILITY_TAG,
    LOCAL_UNAVAILABLE_UNTIL_TAG,
)


def default_policy() -> dict[str, object]:
    return {
        "routing_state": None,
        "bikeability": None,
        "bicycle_direction": None,
        "unavailable_until": None,
    }


def normalize_policy(policy: dict[str, Any]) -> dict[str, object]:
    normalized = default_policy()
    if "routing_state" in policy:
        normalized["routing_state"] = str(policy["routing_state"])
    if "bikeability" in policy:
        normalized["bikeability"] = int(policy["bikeability"])
    if "bicycle_direction" in policy:
        normalized["bicycle_direction"] = str(policy["bicycle_direction"])
    if "unavailable_until" in policy:
        normalized["unavailable_until"] = str(policy["unavailable_until"])
    return normalized


def compact_policy(policy: dict[str, object]) -> dict[str, object]:
    return {
        key: value
        for key, value in normalize_policy(policy).items()
        if value is not None
    }


def policy_to_tags(policy: dict[str, object]) -> dict[str, str]:
    normalized = compact_policy(policy)
    tags: dict[str, str] = {}
    if normalized.get("routing_state") is not None:
        tags[LOCAL_ROUTING_STATE_TAG] = str(normalized["routing_state"])
    if normalized.get("bikeability") is not None:
        tags[LOCAL_BIKEABILITY_TAG] = str(normalized["bikeability"])
    if normalized.get("bicycle_direction") is not None:
        tags[LOCAL_BICYCLE_DIRECTION_TAG] = str(normalized["bicycle_direction"])
    if normalized.get("unavailable_until") is not None:
        tags[LOCAL_UNAVAILABLE_UNTIL_TAG] = str(normalized["unavailable_until"])
    return tags


def extract_policy_tags(tags: dict[str, Any]) -> dict[str, str]:
    extracted: dict[str, str] = {}
    for key in POLICY_TAG_KEYS:
        value = tags.get(key)
        if value is None:
            continue
        extracted[key] = str(value)
    return extracted


def has_policy_tags(tags: dict[str, Any]) -> bool:
    return any(key in tags for key in POLICY_TAG_KEYS)


def edge_key(a: int, b: int) -> tuple[int, int]:
    return (a, b) if a < b else (b, a)


def selector_for_contig(contig: dict[str, Any]) -> dict[str, list[int]]:
    return {
        "way_ids": [int(way_id) for way_id in contig["way_ids"]],
        "node_ids": [int(node_id) for node_id in contig["node_ids"]],
    }


def _normalize_way_ids(way_ids: list[int] | tuple[int, ...]) -> tuple[int, ...]:
    return tuple(sorted(int(way_id) for way_id in way_ids))


def route_rule_id_for_selector(selector: dict[str, Any]) -> str:
    text = json.dumps(
        {
            "way_ids": list(_normalize_way_ids(selector["way_ids"])),
            "node_ids": [int(node_id) for node_id in selector["node_ids"]],
        },
        separators=(",", ":"),
        sort_keys=True,
    )
    hash_value = 2166136261
    for byte in text.encode("utf-8"):
        hash_value ^= byte
        hash_value = (hash_value * 16777619) & 0xFFFFFFFF
    return f"route-policy-path-{hash_value:08x}"


def route_policy_digest(route_policy: dict[str, Any]) -> str:
    route_policy = validate_route_policy_document(route_policy, label="route policy")
    canonical = json.dumps(route_policy, sort_keys=True, separators=(",", ":"))
    return hashlib.sha1(canonical.encode("utf-8")).hexdigest()[:12]


def selected_way_ids(route_policy: dict[str, Any]) -> set[int]:
    route_policy = validate_route_policy_document(route_policy, label="route policy")
    selected: set[int] = set()
    for rule in route_policy["rules"]:
        selected.update(int(way_id) for way_id in rule["selector"]["way_ids"])
    return selected


def merge_policy_tags(
    existing_tags: dict[str, str],
    new_tags: dict[str, str],
    *,
    label: str,
) -> dict[str, str]:
    merged = dict(existing_tags)
    for key, value in new_tags.items():
        if key in merged and merged[key] != value:
            raise ValueError(f"{label} assigns conflicting values for {key}")
        merged[key] = value
    return merged


def _selector_edge_keys(selector: dict[str, Any], edge_graph: dict[tuple[int, int], dict], *, label: str) -> list[tuple[int, int]]:
    node_ids = [int(node_id) for node_id in selector["node_ids"]]
    way_ids = {int(way_id) for way_id in selector["way_ids"]}
    edge_keys: list[tuple[int, int]] = []
    for first_id, second_id in zip(node_ids, node_ids[1:]):
        key = edge_key(first_id, second_id)
        edge = edge_graph.get(key)
        if edge is None:
            raise ValueError(f"{label} references missing map edge {first_id}->{second_id}")
        edge_way_ids = {int(way_id) for way_id in edge["way_ids"]}
        if edge_way_ids.isdisjoint(way_ids):
            raise ValueError(f"{label} edge {first_id}->{second_id} no longer matches the selected way_ids")
        edge_keys.append(key)
    return edge_keys


def apply_route_policy_to_edge_graph(route_policy: dict[str, Any], edge_graph: dict[tuple[int, int], dict]) -> list[str]:
    route_policy = validate_route_policy_document(route_policy, label="route policy")
    applied_rule_ids: list[str] = []
    for rule in route_policy["rules"]:
        label = f"route policy rule {rule['id']}"
        selector_edge_keys = _selector_edge_keys(rule["selector"], edge_graph, label=label)
        policy_tags = policy_to_tags(rule["policy"])
        for key in selector_edge_keys:
            edge = edge_graph[key]
            edge["tags"] = merge_policy_tags(
                edge.get("tags", {}),
                policy_tags,
                label=f"{label} on edge {key[0]}->{key[1]}",
            )
        applied_rule_ids.append(str(rule["id"]))
    return applied_rule_ids


def edge_policy_signature(edge: dict[str, Any]) -> tuple[tuple[str, str], ...]:
    return tuple(sorted((str(key), str(value)) for key, value in edge.get("tags", {}).items()))


def contig_tags_for_segments(
    segment_pairs: list[list[int]],
    edge_graph: dict[tuple[int, int], dict],
) -> dict[str, str]:
    signatures = {
        edge_policy_signature(edge_graph[edge_key(int(first_id), int(second_id))])
        for first_id, second_id in segment_pairs
    }
    if len(signatures) > 1:
        raise ValueError("contig spans multiple policy states; graph should split at policy boundaries")
    signature = next(iter(signatures), ())
    return {key: value for key, value in signature}


def route_policy_document_from_legacy_patchset(
    patchset: dict[str, Any],
    *,
    contig_graph: dict[str, Any],
    asset_id: str = "karura-route-policy-v1",
    description: str = "Canonical route policy on patched-map paths, projected onto the current graph during rebuild.",
) -> dict[str, Any]:
    by_signature: dict[tuple[int, ...], list[dict[str, Any]]] = {}
    for contig in contig_graph["contigs"]:
        signature = tuple(int(node_id) for node_id in contig["node_ids"])
        by_signature.setdefault(signature, []).append(contig)
        by_signature.setdefault(tuple(reversed(signature)), []).append(contig)

    rules: list[dict[str, Any]] = []
    for patch in patchset.get("patches", []):
        if patch.get("enabled", True) is False:
            continue
        if patch.get("op") != "update_contig_tags":
            continue
        selector_node_ids = [int(node_id) for node_id in patch.get("node_ids", [])]
        if len(selector_node_ids) < 2:
            raise ValueError(f"legacy patch {patch.get('id', '(unnamed)')} is missing node_ids signature")
        matches = by_signature.get(tuple(selector_node_ids), [])
        if not matches:
            raise ValueError(f"legacy patch {patch.get('id', '(unnamed)')} no longer matches the current graph")
        if len(matches) > 1:
            raise ValueError(f"legacy patch {patch.get('id', '(unnamed)')} matches multiple current contigs")
        contig = matches[0]
        selector = selector_for_contig(contig)
        policy = {}
        patch_set = patch.get("set", {})
        if LOCAL_ROUTING_STATE_TAG in patch_set:
            policy["routing_state"] = str(patch_set[LOCAL_ROUTING_STATE_TAG])
        if LOCAL_BIKEABILITY_TAG in patch_set:
            policy["bikeability"] = int(str(patch_set[LOCAL_BIKEABILITY_TAG]))
        if LOCAL_BICYCLE_DIRECTION_TAG in patch_set:
            direction = str(patch_set[LOCAL_BICYCLE_DIRECTION_TAG])
            if direction != "both":
                policy["bicycle_direction"] = direction
        if LOCAL_UNAVAILABLE_UNTIL_TAG in patch_set:
            policy["unavailable_until"] = str(patch_set[LOCAL_UNAVAILABLE_UNTIL_TAG])
        if not policy:
            continue
        rule_id = route_rule_id_for_selector(selector)
        rules.append(
            {
                "id": rule_id,
                "selector": selector,
                "policy": policy,
            }
        )
    return {
        "meta": {
            "asset_kind": "route_policy",
            "asset_id": asset_id,
            "description": description,
        },
        "rules": rules,
    }


def _contig_lookup_by_edge(contig_graph: dict[str, Any]) -> dict[tuple[int, int], dict[str, Any]]:
    lookup: dict[tuple[int, int], dict[str, Any]] = {}
    for contig in contig_graph["contigs"]:
        if "segment_pairs" not in contig:
            continue
        for first_id, second_id in contig["segment_pairs"]:
            key = edge_key(int(first_id), int(second_id))
            if key in lookup:
                raise ValueError(f"graph edge {first_id}->{second_id} appears in multiple contigs")
            lookup[key] = contig
    return lookup


def _binding_status_for_rule(rule: dict[str, Any], matches: list[dict[str, Any]]) -> str:
    selector_node_ids = tuple(int(node_id) for node_id in rule["selector"]["node_ids"])
    if len(matches) == 1:
        match_node_ids = tuple(int(node_id) for node_id in matches[0]["node_ids"])
        if match_node_ids == selector_node_ids:
            return "exact"
        if match_node_ids == tuple(reversed(selector_node_ids)):
            return "reversed"
        raise ValueError(f"cannot bind route policy rule {rule['id']}; selector only partially overlaps current contig")
    return "split_across_contigs"


def build_route_policy_bindings(route_policy: dict[str, Any], contig_graph: dict[str, Any]) -> dict[str, Any]:
    route_policy = validate_route_policy_document(route_policy, label="route policy")
    by_edge = _contig_lookup_by_edge(contig_graph)

    bindings: list[dict[str, Any]] = []
    for rule in route_policy["rules"]:
        selector_node_ids = [int(node_id) for node_id in rule["selector"]["node_ids"]]
        matched_contigs: list[dict[str, Any]]
        if by_edge:
            matched_contigs = []
            previous_contig_id: int | None = None
            for first_id, second_id in zip(selector_node_ids, selector_node_ids[1:]):
                contig = by_edge.get(edge_key(first_id, second_id))
                if contig is None:
                    raise ValueError(f"cannot bind route policy rule {rule['id']}; selector no longer matches current graph")
                contig_id = int(contig["id"])
                if previous_contig_id == contig_id:
                    continue
                matched_contigs.append(contig)
                previous_contig_id = contig_id
        else:
            forward = tuple(selector_node_ids)
            reverse = tuple(reversed(selector_node_ids))
            matched_contigs = [
                contig
                for contig in contig_graph["contigs"]
                if tuple(int(node_id) for node_id in contig["node_ids"]) in {forward, reverse}
                and _normalize_way_ids(contig["way_ids"]) == _normalize_way_ids(rule["selector"]["way_ids"])
            ]
        if not matched_contigs:
            raise ValueError(f"cannot bind route policy rule {rule['id']}; selector contains no edges")
        if len(matched_contigs) > 1 and not by_edge:
            raise ValueError(f"cannot bind route policy rule {rule['id']}; selector is ambiguous on the current graph")
        bindings.append(
            {
                "rule_id": str(rule["id"]),
                "status": _binding_status_for_rule(rule, matched_contigs),
                "selector": {
                    "way_ids": [int(way_id) for way_id in rule["selector"]["way_ids"]],
                    "node_ids": selector_node_ids,
                },
                "policy": compact_policy(rule["policy"]),
                "matches": [
                    {
                        "contig_id": int(contig["id"]),
                        "way_ids": [int(way_id) for way_id in contig["way_ids"]],
                        "node_ids": [int(node_id) for node_id in contig["node_ids"]],
                    }
                    for contig in matched_contigs
                ],
            }
        )

    digest = route_policy_digest(route_policy)
    return {
        "meta": {
            "asset_kind": "route_policy_bindings",
            "asset_id": f"karura-route-policy-bindings-for-{contig_graph['meta']['asset_id']}-{digest}",
            "graph_asset_id": contig_graph["meta"]["asset_id"],
            "route_policy_asset_id": route_policy["meta"]["asset_id"],
            "route_policy_digest": digest,
            "binding_count": len(bindings),
        },
        "bindings": bindings,
    }


def apply_route_policy_bindings(
    contig_graph: dict[str, Any],
    bindings_document: dict[str, Any],
    *,
    route_policy_path: str,
) -> dict[str, Any]:
    bindings_document = validate_route_policy_bindings_document(
        bindings_document,
        label="route policy bindings",
    )
    by_id = {int(contig["id"]): contig for contig in contig_graph["contigs"]}
    applied_rule_ids: list[str] = []
    for binding in bindings_document["bindings"]:
        policy_tags = policy_to_tags(binding["policy"])
        for match in binding["matches"]:
            contig = by_id.get(int(match["contig_id"]))
            if contig is None:
                raise ValueError(
                    f"cannot apply route policy binding {binding['rule_id']}; missing contig {match['contig_id']}"
                )
            actual_node_ids = [int(node_id) for node_id in contig["node_ids"]]
            expected_node_ids = [int(node_id) for node_id in match["node_ids"]]
            if actual_node_ids != expected_node_ids:
                raise ValueError(
                    f"cannot apply route policy binding {binding['rule_id']}; contig node_ids no longer match binding"
                )
            actual_tags = extract_policy_tags(contig.get("tags", {}))
            merged_tags = merge_policy_tags(actual_tags, policy_tags, label=f"binding {binding['rule_id']}")
            if actual_tags and actual_tags != merged_tags:
                raise ValueError(
                    f"cannot apply route policy binding {binding['rule_id']}; contig tags conflict with projected policy"
                )
            contig["tags"] = {**dict(contig.get("tags", {})), **merged_tags}
        applied_rule_ids.append(str(binding["rule_id"]))

    contig_graph["meta"]["route_policy_path"] = route_policy_path
    contig_graph["meta"]["route_policy_asset_id"] = bindings_document["meta"]["route_policy_asset_id"]
    contig_graph["meta"]["route_policy_digest"] = bindings_document["meta"]["route_policy_digest"]
    contig_graph["meta"]["route_policy_bindings_asset_id"] = bindings_document["meta"]["asset_id"]
    contig_graph["meta"]["applied_route_policy_rule_ids"] = applied_rule_ids
    return contig_graph


def include_way_in_policy_candidate_graph(way_id: int, tags: dict[str, str], *, selected_way_ids: set[int], base_include: bool) -> bool:
    return base_include or int(way_id) in selected_way_ids or has_policy_tags(tags)
