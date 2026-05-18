#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  ./scripts/dev-container.sh --install
  ./scripts/dev-container.sh [--build|--no-build] [--allow-network] <command> [args...]
  ./scripts/dev-container.sh [--build|--no-build] [--allow-network] run <command...>
  ./scripts/dev-container.sh [--build|--no-build] [--allow-network] shell

Commands are executed in the locked dev container. Normal command runs use no
runtime network. Preview/serve use Docker bridge networking only to publish
127.0.0.1:8765 for a host browser. Use --allow-network only for explicit
external data refreshes.

Options:
  --install    Build toolchain images and run npm ci in the install container.
  --build      Build the check image before running the command.
  --no-build   Reuse the existing image.
  --allow-network
               Give the command Docker's default bridge network.
  -h, --help   Show this help.

Environment:
  DARK_SIDE_DOCKER_IMAGE          Check image tag.
                                  Default: the-dark-side-toolchain:python3.12-bookworm
  DARK_SIDE_DOCKER_INSTALL_IMAGE  Install image tag.
                                  Default: ${DARK_SIDE_DOCKER_IMAGE}-install
  DARK_SIDE_HOST_PORT             Host port for preview/serve. Default: 8765
  DARK_SIDE_MEMORY                Container memory limit. Default: 3g
  DARK_SIDE_PIDS_LIMIT            Container PID limit. Default: 512
EOF
}

root_dir="$(cd "$(dirname "$0")/.." && pwd)"
image="${DARK_SIDE_DOCKER_IMAGE:-the-dark-side-toolchain:python3.12-bookworm}"
install_image="${DARK_SIDE_DOCKER_INSTALL_IMAGE:-${image}-install}"
mode="command"
build_image="auto"
allow_network="0"
command_args=()

while [ "$#" -gt 0 ]; do
  case "$1" in
    --install)
      mode="install"
      ;;
    --build)
      build_image="1"
      ;;
    --no-build)
      build_image="0"
      ;;
    --allow-network)
      allow_network="1"
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --)
      shift
      command_args=(run "$@")
      break
      ;;
    *)
      command_args=("$@")
      break
      ;;
  esac
  shift
done

if [ "$mode" = "command" ] && [ "${#command_args[@]}" -eq 0 ]; then
  usage >&2
  exit 2
fi

if [ "$build_image" = "auto" ]; then
  if [ "$mode" = "install" ]; then
    build_image="1"
  else
    build_image="0"
  fi
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required for contained dev/test commands." >&2
  exit 1
fi

build_check_image() {
  docker build --target the_dark_side_check -t "$image" -f "$root_dir/Dockerfile" "$root_dir"
}

build_install_image() {
  docker build --target the_dark_side_install -t "$install_image" -f "$root_dir/Dockerfile" "$root_dir"
}

if [ "$build_image" = "1" ]; then
  if [ "$mode" = "install" ]; then
    build_install_image
  fi
  build_check_image
elif ! docker image inspect "$image" >/dev/null 2>&1; then
  cat >&2 <<EOF
Docker image not found: $image

Run:
  ./scripts/dev-container.sh --install

Or build only the check image:
  ./scripts/dev-container.sh --build ${command_args[*]:-test}
EOF
  exit 1
fi

if [ "$mode" = "install" ] && ! docker image inspect "$install_image" >/dev/null 2>&1; then
  cat >&2 <<EOF
Docker install image not found: $install_image

Run:
  ./scripts/dev-container.sh --install --build
EOF
  exit 1
fi

common_run_options=(
  --rm
  --init
  --user "$(id -u):$(id -g)"
  --cap-drop ALL
  --security-opt no-new-privileges:true
  --read-only
  --pids-limit "${DARK_SIDE_PIDS_LIMIT:-512}"
  --memory "${DARK_SIDE_MEMORY:-3g}"
  --memory-swap "${DARK_SIDE_MEMORY_SWAP:-${DARK_SIDE_MEMORY:-3g}}"
  --shm-size "${DARK_SIDE_SHM_SIZE:-1g}"
  --env DARK_SIDE_IN_CONTAINER=1
  --env HOME=/tmp/home
  --env PYTHONDONTWRITEBYTECODE=1
  --env PYTHONUNBUFFERED=1
  --env npm_config_cache=/tmp/npm-cache
  --env npm_config_update_notifier=false
  --env npm_config_progress=false
  --mount "type=bind,src=${root_dir},dst=/work"
  --workdir /work
)

if [ "$mode" = "install" ]; then
  docker run \
    "${common_run_options[@]}" \
    --env npm_config_audit=false \
    --env npm_config_fund=false \
    --env npm_config_ignore_scripts=true \
    --tmpfs /tmp:rw,nosuid,nodev,noexec,size=1536m \
    "$install_image" \
    npm ci --ignore-scripts --no-audit --fund=false
  exit 0
fi

if [ "$allow_network" = "1" ]; then
  network_options=()
else
  network_options=(--network none)
fi
container_command=(./scripts/dev-command.sh "${command_args[@]}")
interactive_options=()
first_command="${command_args[0]}"

case "$first_command" in
  preview:web|serve:web)
    network_options=(
      --network bridge
      --publish "127.0.0.1:${DARK_SIDE_HOST_PORT:-8765}:8765"
      --env DARK_SIDE_PREVIEW_HOST=0.0.0.0
      --env DARK_SIDE_PREVIEW_PORT=8765
    )
    ;;
  shell)
    container_command=(bash)
    if [ -t 0 ] && [ -t 1 ]; then
      interactive_options=(-it)
    fi
    ;;
esac

docker run \
  "${interactive_options[@]}" \
  "${common_run_options[@]}" \
  "${network_options[@]}" \
  --tmpfs /tmp:rw,nosuid,nodev,noexec,size=1536m \
  "$image" \
  "${container_command[@]}"
