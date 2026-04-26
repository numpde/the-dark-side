#!/usr/bin/env python3

"""Shared helpers for derived-asset verification."""

from __future__ import annotations

import json
from pathlib import Path


def load_json(path: Path) -> dict:
    return json.loads(path.read_text())


def normalized(payload: dict) -> dict:
    clone = json.loads(json.dumps(payload))
    clone.get("meta", {}).pop("generated_at", None)
    return clone


def assert_equal(label: str, actual, expected, *, rebuild_hint: str) -> None:
    if actual != expected:
        raise SystemExit(f"{label} is stale; {rebuild_hint}")
