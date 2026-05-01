#!/usr/bin/env python3

import argparse
import base64
import hashlib
import json
import secrets
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any
from xml.etree import ElementTree


ROOT = Path(__file__).resolve().parent
SECRETS_DIR = ROOT / "secrets"
APP_CONFIG_PATH = SECRETS_DIR / "osm.tsv"
PENDING_AUTH_PATH = SECRETS_DIR / "osm-oauth-pending.json"
TOKEN_PATH = SECRETS_DIR / "osm-token.json"

AUTHORIZE_URL = "https://www.openstreetmap.org/oauth2/authorize"
TOKEN_URL = "https://www.openstreetmap.org/oauth2/token"
API_BASE_URL = "https://api.openstreetmap.org/api/0.6"
WRITE_SCOPE = "write_api"


def read_tsv_config(path: Path) -> dict[str, str]:
    config: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        key, value = line.split("\t", 1)
        config[key.strip()] = value.strip()
    return config


def load_app_config() -> dict[str, str]:
    if not APP_CONFIG_PATH.exists():
        raise SystemExit(f"Missing app config: {APP_CONFIG_PATH}")
    config = read_tsv_config(APP_CONFIG_PATH)
    required = ["Client ID", "Redirect URIs"]
    missing = [key for key in required if not config.get(key)]
    if missing:
        raise SystemExit(f"Missing required OSM config fields: {', '.join(missing)}")
    return config


def load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def save_json(path: Path, payload: dict[str, Any]) -> None:
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def generate_code_verifier() -> str:
    return base64.urlsafe_b64encode(secrets.token_bytes(48)).decode("ascii").rstrip("=")


def generate_code_challenge(verifier: str) -> str:
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    return base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")


def build_auth_url() -> str:
    app_config = load_app_config()
    state = secrets.token_urlsafe(24)
    verifier = generate_code_verifier()
    challenge = generate_code_challenge(verifier)
    pending = {
        "client_id": app_config["Client ID"],
        "redirect_uri": app_config["Redirect URIs"],
        "state": state,
        "code_verifier": verifier,
        "scope": WRITE_SCOPE,
        "created_at": int(time.time()),
    }
    save_json(PENDING_AUTH_PATH, pending)
    query = urllib.parse.urlencode(
        {
            "response_type": "code",
            "client_id": pending["client_id"],
            "redirect_uri": pending["redirect_uri"],
            "scope": pending["scope"],
            "state": pending["state"],
            "code_challenge": challenge,
            "code_challenge_method": "S256",
        }
    )
    return f"{AUTHORIZE_URL}?{query}"


def parse_callback_url(callback_url: str) -> dict[str, str]:
    parsed = urllib.parse.urlparse(callback_url)
    query = urllib.parse.parse_qs(parsed.query)
    if "error" in query:
        description = query.get("error_description", [""])[0]
        raise SystemExit(f"Authorization failed: {query['error'][0]} {description}".strip())
    code = query.get("code", [None])[0]
    state = query.get("state", [None])[0]
    if not code or not state:
        raise SystemExit("Callback URL is missing code or state.")
    return {"code": code, "state": state}


def post_form(url: str, payload: dict[str, str]) -> dict[str, Any]:
    body = urllib.parse.urlencode(payload).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=body,
        headers={"Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        details = exc.read().decode("utf-8", errors="replace")
        raise SystemExit(f"HTTP {exc.code} from token endpoint: {details}") from exc


def exchange_code(callback_url: str) -> dict[str, Any]:
    if not PENDING_AUTH_PATH.exists():
        raise SystemExit("Missing pending auth state. Run the auth-url command first.")
    pending = load_json(PENDING_AUTH_PATH)
    parsed = parse_callback_url(callback_url)
    if parsed["state"] != pending["state"]:
        raise SystemExit("State mismatch in OAuth callback.")

    app_config = load_app_config()
    token_request = {
        "grant_type": "authorization_code",
        "code": parsed["code"],
        "redirect_uri": pending["redirect_uri"],
        "client_id": pending["client_id"],
        "code_verifier": pending["code_verifier"],
    }
    client_secret = app_config.get("Client Secret")
    if client_secret:
        token_request["client_secret"] = client_secret

    token = post_form(TOKEN_URL, token_request)
    token["received_at"] = int(time.time())
    token["redirect_uri"] = pending["redirect_uri"]
    token["client_id"] = pending["client_id"]
    save_json(TOKEN_PATH, token)
    return token


def load_token() -> dict[str, Any]:
    if not TOKEN_PATH.exists():
        raise SystemExit("Missing access token. Run auth-url and exchange first.")
    return load_json(TOKEN_PATH)


def api_get(path: str) -> tuple[str, str]:
    token = load_token()
    request = urllib.request.Request(
        f"{API_BASE_URL}{path}",
        headers={
            "Authorization": f"Bearer {token['access_token']}",
            "Accept": "*/*",
            "User-Agent": "tmp-strava-to-way-osm-auth/1.0",
        },
    )
    try:
        with urllib.request.urlopen(request) as response:
            return response.headers.get_content_type(), response.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        details = exc.read().decode("utf-8", errors="replace")
        raise SystemExit(f"HTTP {exc.code} from API: {details}") from exc


def list_permissions() -> list[str]:
    content_type, body = api_get("/permissions")
    if "xml" not in content_type:
        raise SystemExit(f"Unexpected permissions response type: {content_type}")
    root = ElementTree.fromstring(body)
    return [element.attrib["name"] for element in root.findall(".//permission")]


def print_token_summary() -> None:
    token = load_token()
    summary = {
        "token_type": token.get("token_type"),
        "scope": token.get("scope"),
        "received_at": token.get("received_at"),
        "has_access_token": bool(token.get("access_token")),
    }
    print(json.dumps(summary, indent=2))


def cmd_auth_url(_: argparse.Namespace) -> int:
    print(build_auth_url())
    return 0


def cmd_exchange(args: argparse.Namespace) -> int:
    token = exchange_code(args.callback_url)
    summary = {
        "scope": token.get("scope"),
        "token_type": token.get("token_type"),
        "received_at": token.get("received_at"),
        "saved_to": str(TOKEN_PATH),
    }
    print(json.dumps(summary, indent=2))
    return 0


def cmd_permissions(_: argparse.Namespace) -> int:
    print(json.dumps({"permissions": list_permissions()}, indent=2))
    return 0


def cmd_token_info(_: argparse.Namespace) -> int:
    print_token_summary()
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="OpenStreetMap OAuth/API helper for tmp-strava-to-way")
    subparsers = parser.add_subparsers(dest="command", required=True)

    auth_url_parser = subparsers.add_parser("auth-url", help="Generate a browser authorization URL")
    auth_url_parser.set_defaults(func=cmd_auth_url)

    exchange_parser = subparsers.add_parser("exchange", help="Exchange an OAuth callback URL for a bearer token")
    exchange_parser.add_argument("callback_url", help="Full callback URL returned to /osm-callback")
    exchange_parser.set_defaults(func=cmd_exchange)

    permissions_parser = subparsers.add_parser("permissions", help="List granted OSM API permissions")
    permissions_parser.set_defaults(func=cmd_permissions)

    token_info_parser = subparsers.add_parser("token-info", help="Show a local summary of the stored token")
    token_info_parser.set_defaults(func=cmd_token_info)

    return parser


def main(argv: list[str]) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
