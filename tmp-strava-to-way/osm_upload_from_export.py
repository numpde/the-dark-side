#!/usr/bin/env python3

import argparse
import json
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable
from xml.etree import ElementTree


ROOT = Path(__file__).resolve().parent
TOKEN_PATH = ROOT / "secrets" / "osm-token.json"
API_BASE_URL = "https://api.openstreetmap.org/api/0.6"
USER_AGENT = "tmp-strava-to-way-osm-upload/1.0"


@dataclass
class ExportWay:
    way_id: int
    nd_refs: list[int]
    tags: dict[str, str]
    version: int | None


@dataclass
class ExportPayload:
    new_nodes: list[ElementTree.Element]
    modified_ways: list[ExportWay]
    new_ways: list[ExportWay]


@dataclass
class CurrentWay:
    way_id: int
    version: int
    nd_refs: list[int]
    tags: dict[str, str]


def load_token() -> dict:
    if not TOKEN_PATH.exists():
        raise SystemExit(f"Missing token file: {TOKEN_PATH}")
    return json.loads(TOKEN_PATH.read_text(encoding="utf-8"))


def api_request(path: str, method: str = "GET", body: bytes | None = None, content_type: str | None = None) -> str:
    token = load_token()
    headers = {
        "Authorization": f"Bearer {token['access_token']}",
        "User-Agent": USER_AGENT,
        "Accept": "*/*",
    }
    if content_type:
        headers["Content-Type"] = content_type
    request = urllib.request.Request(f"{API_BASE_URL}{path}", data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request) as response:
            return response.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        details = exc.read().decode("utf-8", errors="replace")
        raise SystemExit(f"HTTP {exc.code} {method} {path}: {details}") from exc


def parse_way_element(element: ElementTree.Element) -> ExportWay:
    return ExportWay(
        way_id=int(element.attrib["id"]),
        nd_refs=[int(nd.attrib["ref"]) for nd in element.findall("nd")],
        tags={tag.attrib["k"]: tag.attrib["v"] for tag in element.findall("tag")},
        version=int(element.attrib["version"]) if "version" in element.attrib else None,
    )


def parse_export(path: Path) -> ExportPayload:
    root = ElementTree.parse(path).getroot()
    if root.tag == "osmChange":
        create = root.find("create")
        modify = root.find("modify")
        new_nodes = [element for element in create.findall("node")] if create is not None else []
        new_ways = [parse_way_element(element) for element in create.findall("way")] if create is not None else []
        modified_ways = [parse_way_element(element) for element in modify.findall("way")] if modify is not None else []
    else:
        new_nodes = [element for element in root.findall("node") if int(element.attrib["id"]) < 0]
        new_ways = []
        modified_ways = []
        for element in root.findall("way"):
            way = parse_way_element(element)
            if way.way_id < 0:
                new_ways.append(way)
            else:
                modified_ways.append(way)
    if not new_ways:
        raise SystemExit(f"No new negative-id way found in {path}")
    return ExportPayload(new_nodes=new_nodes, modified_ways=modified_ways, new_ways=new_ways)


def fetch_current_way(way_id: int) -> CurrentWay:
    body = api_request(f"/way/{way_id}")
    root = ElementTree.fromstring(body)
    way_element = root.find("way")
    if way_element is None:
        raise SystemExit(f"Way {way_id} not found in API response")
    return CurrentWay(
        way_id=way_id,
        version=int(way_element.attrib["version"]),
        nd_refs=[int(nd.attrib["ref"]) for nd in way_element.findall("nd")],
        tags={tag.attrib["k"]: tag.attrib["v"] for tag in way_element.findall("tag")},
    )


def strip_negative_refs(refs: Iterable[int]) -> list[int]:
    return [ref for ref in refs if ref > 0]


def verify_baseline(modified_way: ExportWay, current_way: CurrentWay) -> None:
    exported_positive_refs = strip_negative_refs(modified_way.nd_refs)
    if exported_positive_refs != current_way.nd_refs:
        raise SystemExit(
            "Ref mismatch for way "
            f"{modified_way.way_id}: export baseline no longer matches live OSM. "
            "Aborting upload to avoid overwriting newer geometry."
        )


def build_changeset_create_xml(comment: str, source: str) -> bytes:
    root = ElementTree.Element("osm", version="0.6", generator=USER_AGENT)
    changeset = ElementTree.SubElement(root, "changeset")
    tags = {
        "created_by": USER_AGENT,
        "comment": comment,
        "source": source,
    }
    for key, value in tags.items():
        ElementTree.SubElement(changeset, "tag", k=key, v=value)
    return to_xml_bytes(root)


def build_osmchange_xml(
    changeset_id: int,
    new_nodes: list[ElementTree.Element],
    modified_ways: list[tuple[ExportWay, CurrentWay]],
    new_ways: list[ExportWay],
) -> tuple[bytes, dict[str, dict[int, int]]]:
    new_nodes = dedupe_new_nodes(new_nodes)
    root = ElementTree.Element("osmChange", version="0.6", generator=USER_AGENT)
    create = ElementTree.SubElement(root, "create")
    modify = ElementTree.SubElement(root, "modify")
    placeholder_maps = build_unique_placeholder_maps(new_nodes, new_ways)

    for node in new_nodes:
      upload_node_id = placeholder_maps["node_ids"][int(node.attrib["id"])]
      ElementTree.SubElement(
          create,
          "node",
          {
              "id": str(upload_node_id),
              "changeset": str(changeset_id),
              "lat": node.attrib["lat"],
              "lon": node.attrib["lon"],
          },
      )

    for export_way, current_way in modified_ways:
        way_element = ElementTree.SubElement(
            modify,
            "way",
            {
                "id": str(current_way.way_id),
                "version": str(current_way.version),
                "changeset": str(changeset_id),
            },
        )
        for ref in export_way.nd_refs:
            ElementTree.SubElement(way_element, "nd", ref=str(ref))
        for key, value in current_way.tags.items():
            ElementTree.SubElement(way_element, "tag", k=key, v=value)

    for new_way in new_ways:
        new_way_element = ElementTree.SubElement(
            create,
            "way",
            {
                "id": str(placeholder_maps["way_ids"][new_way.way_id]),
                "changeset": str(changeset_id),
            },
        )
        for ref in new_way.nd_refs:
            ElementTree.SubElement(
                new_way_element,
                "nd",
                ref=str(placeholder_maps["node_ids"].get(ref, ref)),
            )
        for key, value in new_way.tags.items():
            ElementTree.SubElement(new_way_element, "tag", k=key, v=value)

    return to_xml_bytes(root), placeholder_maps


def build_unique_placeholder_maps(
    new_nodes: list[ElementTree.Element], new_ways: list[ExportWay]
) -> dict[str, dict[int, int]]:
    used_ids: set[int] = set()
    node_ids: dict[int, int] = {}
    way_ids: dict[int, int] = {}

    next_placeholder = -1

    def allocate(preferred_id: int) -> int:
        nonlocal next_placeholder
        candidate = preferred_id
        if candidate >= 0 or candidate in used_ids:
            while next_placeholder in used_ids or next_placeholder >= 0:
                next_placeholder -= 1
            candidate = next_placeholder
            next_placeholder -= 1
        used_ids.add(candidate)
        return candidate

    for node in new_nodes:
        original_id = int(node.attrib["id"])
        node_ids[original_id] = allocate(original_id)

    for way in new_ways:
        way_ids[way.way_id] = allocate(way.way_id)

    return {
        "node_ids": node_ids,
        "way_ids": way_ids,
    }


def dedupe_new_nodes(new_nodes: list[ElementTree.Element]) -> list[ElementTree.Element]:
    unique_nodes: dict[int, ElementTree.Element] = {}
    for node in new_nodes:
        unique_nodes.setdefault(int(node.attrib["id"]), node)
    return list(unique_nodes.values())


def to_xml_bytes(root: ElementTree.Element) -> bytes:
    ElementTree.indent(ElementTree.ElementTree(root), space="  ")
    return ElementTree.tostring(root, encoding="utf-8", xml_declaration=True)


def create_changeset(comment: str, source: str) -> int:
    body = build_changeset_create_xml(comment, source)
    response = api_request("/changeset/create", method="PUT", body=body, content_type="text/xml")
    return int(response.strip())


def upload_changeset(changeset_id: int, osmchange_xml: bytes) -> str:
    return api_request(
        f"/changeset/{changeset_id}/upload",
        method="POST",
        body=osmchange_xml,
        content_type="text/xml",
    )


def close_changeset(changeset_id: int) -> None:
    api_request(f"/changeset/{changeset_id}/close", method="PUT")


def parse_diffresult(diffresult_xml: str) -> dict:
    root = ElementTree.fromstring(diffresult_xml)
    created_nodes = []
    created_ways = []
    for action in root:
        old_id = int(action.attrib["old_id"])
        new_id = int(action.attrib["new_id"])
        if action.tag == "node":
            created_nodes.append({"old_id": old_id, "new_id": new_id})
        elif action.tag == "way":
            created_ways.append({"old_id": old_id, "new_id": new_id})
    return {
        "created_nodes": created_nodes,
        "created_ways": created_ways,
    }


def remap_diffresult_placeholders(parsed: dict, placeholder_maps: dict[str, dict[int, int]]) -> dict:
    inverse_node_ids = {upload_id: original_id for original_id, upload_id in placeholder_maps["node_ids"].items()}
    inverse_way_ids = {upload_id: original_id for original_id, upload_id in placeholder_maps["way_ids"].items()}
    return {
        "created_nodes": [
            {
                **item,
                "old_id": inverse_node_ids.get(item["old_id"], item["old_id"]),
            }
            for item in parsed["created_nodes"]
        ],
        "created_ways": [
            {
                **item,
                "old_id": inverse_way_ids.get(item["old_id"], item["old_id"]),
            }
            for item in parsed["created_ways"]
        ],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Upload tagged Strava-to-Way export to OSM.")
    parser.add_argument("export_path", type=Path)
    parser.add_argument(
        "--comment",
        default="Add foot/MTB path in Karura traced from Strava heatmap",
        help="Changeset comment",
    )
    parser.add_argument("--source", default="Strava", help="Changeset source tag")
    parser.add_argument(
        "--save-prefix",
        type=Path,
        default=None,
        help="Write the final osmChange XML and diffResult alongside this prefix",
    )
    args = parser.parse_args()

    export_payload = parse_export(args.export_path)
    current_way_pairs: list[tuple[ExportWay, CurrentWay]] = []
    for modified_way in export_payload.modified_ways:
        current_way = fetch_current_way(modified_way.way_id)
        verify_baseline(modified_way, current_way)
        current_way_pairs.append((modified_way, current_way))

    changeset_id = create_changeset(args.comment, args.source)
    osmchange_xml, placeholder_maps = build_osmchange_xml(
        changeset_id,
        export_payload.new_nodes,
        current_way_pairs,
        export_payload.new_ways,
    )

    prefix = args.save_prefix
    if prefix is not None:
        prefix.parent.mkdir(parents=True, exist_ok=True)
        prefix.with_suffix(".osc").write_bytes(osmchange_xml)

    diffresult_xml = ""
    try:
        diffresult_xml = upload_changeset(changeset_id, osmchange_xml)
        parsed = remap_diffresult_placeholders(parse_diffresult(diffresult_xml), placeholder_maps)
    finally:
        close_changeset(changeset_id)

    if prefix is not None:
        prefix.with_suffix(".diffResult.xml").write_text(diffresult_xml, encoding="utf-8")
        prefix.with_suffix(".upload-summary.json").write_text(
            json.dumps(
                {
                    "changeset_id": changeset_id,
                    "comment": args.comment,
                    "source": args.source,
                    "modified_way_ids": [way.way_id for way, _ in current_way_pairs],
                    "new_way_old_ids": [way.way_id for way in export_payload.new_ways],
                    **parsed,
                },
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )

    print(
        json.dumps(
            {
                "changeset_id": changeset_id,
                "changeset_url": f"https://www.openstreetmap.org/changeset/{changeset_id}",
                "modified_way_ids": [way.way_id for way, _ in current_way_pairs],
                "created_nodes": parsed["created_nodes"],
                "created_ways": parsed["created_ways"],
            },
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
