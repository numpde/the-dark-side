#!/usr/bin/env python3

"""Verify editor and app assets against canonical inputs."""

from __future__ import annotations

import json

from .verify_app_assets import parse_args, verify_app_assets


def main() -> None:
    args = parse_args()
    print(json.dumps(verify_app_assets(args), indent=2))


if __name__ == "__main__":
    main()
