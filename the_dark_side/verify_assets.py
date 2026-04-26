#!/usr/bin/env python3

"""Verify editor and app assets against canonical inputs."""

from __future__ import annotations

from .karura_common import print_json_document
from .verify_app_assets import parse_args, verify_app_assets


def main() -> None:
    args = parse_args()
    print_json_document(verify_app_assets(args))


if __name__ == "__main__":
    main()
