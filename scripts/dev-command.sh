#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

if [ "${DARK_SIDE_IN_CONTAINER:-}" != "1" ]; then
  cat >&2 <<'EOF'
This repo's dev/test commands run only inside the locked dev container.

Use:
  ./scripts/dev-container.sh --install
  ./scripts/dev-container.sh test
  ./scripts/dev-container.sh run python -m unittest -v tests.test_cli_entrypoints
EOF
  exit 1
fi

ensure_node_deps() {
  if [ ! -d node_modules/@playwright/test ] || [ ! -d node_modules/esbuild ]; then
    cat >&2 <<'EOF'
node_modules is missing or incomplete.

Run:
  ./scripts/dev-container.sh --install
EOF
    exit 1
  fi
}

node_check() {
  ensure_node_deps
  local source_file
  for source_file in web/*.js; do
    node --input-type=module --check < "$source_file"
  done
  for source_file in web/*.mjs scripts/*.mjs; do
    node --check "$source_file"
  done
}

node_tests() {
  ensure_node_deps
  node --test \
    tests/test_gpx.mjs \
    tests/test_editor_state.mjs \
    tests/test_planner_worker_contracts.mjs \
    tests/test_route_planner.mjs \
    tests/test_route_scenarios.mjs
}

python_tests() {
  python -m unittest discover -s tests -p 'test_*.py' -v
}

build_web() {
  ensure_node_deps
  python -m the_dark_side.rebuild_app_assets
  node scripts/build-web-dist.mjs
}

preview_web() {
  local host="${DARK_SIDE_PREVIEW_HOST:-127.0.0.1}"
  local port="${DARK_SIDE_PREVIEW_PORT:-8765}"
  python -m http.server "$port" --bind "$host" --directory dist
}

serve_web() {
  build_web
  preview_web
}

verify_assets() {
  python -m the_dark_side.verify_editor_assets
  python -m the_dark_side.verify_app_assets
  python -m the_dark_side.verify_web_dist
}

playwright_tests() {
  ensure_node_deps
  node node_modules/@playwright/test/cli.js test "$@"
}

e2e_tests() {
  build_web
  playwright_tests "$@"
}

frontend_tests() {
  node_tests
  node_check
  e2e_tests
}

all_tests() {
  python_tests
  frontend_tests
}

release_checks() {
  node_check
  node_tests
  python_tests
  build_web
  verify_assets
  playwright_tests
}

usage() {
  cat <<'EOF'
Usage:
  scripts/dev-command.sh <command> [args...]

Commands:
  build:web              Rebuild app assets and bundle dist.
  preview:web            Serve existing dist.
  serve:web              Build and serve dist.
  check:web              Run JS syntax checks.
  test:web               Run Node source tests.
  test:e2e [args...]     Build dist and run Playwright tests.
  test:frontend          Run Node checks/tests plus Playwright.
  test:python            Run Python unittest discovery.
  test                   Run Python, Node, and Playwright tests.
  verify                 Verify editor/app/dist assets.
  rebuild:editor         Rebuild editor-facing generated assets.
  rebuild:app            Rebuild app-facing generated assets.
  rebuild:all [args...]  Rebuild all generated data/assets.
  ci                     Run the contained release/Pages check lane.
  run <command...>       Execute an arbitrary command in the container.
EOF
}

command_name="${1:-}"
if [ -z "$command_name" ]; then
  usage
  exit 2
fi
shift

case "$command_name" in
  build:web)
    build_web
    ;;
  preview:web)
    preview_web
    ;;
  serve:web)
    serve_web
    ;;
  check:web)
    node_check
    ;;
  test:web)
    node_tests
    ;;
  test:e2e)
    e2e_tests "$@"
    ;;
  test:frontend)
    frontend_tests
    ;;
  test:python)
    python_tests
    ;;
  test)
    all_tests
    ;;
  verify)
    verify_assets
    ;;
  rebuild:editor)
    python -m the_dark_side.rebuild_editor_assets
    ;;
  rebuild:app)
    python -m the_dark_side.rebuild_app_assets
    ;;
  rebuild:all)
    python -m the_dark_side.rebuild_all "$@"
    ;;
  ci|release)
    release_checks
    ;;
  run)
    if [ "$#" -eq 0 ]; then
      echo "run requires a command" >&2
      exit 2
    fi
    exec "$@"
    ;;
  -h|--help|help)
    usage
    ;;
  *)
    echo "Unknown command: $command_name" >&2
    usage >&2
    exit 2
    ;;
esac
