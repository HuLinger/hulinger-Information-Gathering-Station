#!/usr/bin/env bash
# Shared by operational commands so local server configuration is always included.
hub_compose_init() {
  HUB_DIR="$(cd "${HUB_DIR:-$(dirname "${BASH_SOURCE[0]}")/../..}" && pwd -P)"
  HUB_ENV_FILE="${HUB_ENV_FILE:-$HUB_DIR/.env}"
  test -f "$HUB_ENV_FILE" || { echo 'Deployment environment file is missing.' >&2; return 1; }
  test -f "$HUB_DIR/compose.yml" || return 1
  if [[ -f "$HUB_DIR/compose.override.yml" && -f "$HUB_DIR/compose.override.yaml" ]]; then
    echo 'Keep only one local compose.override.yml or compose.override.yaml.' >&2
    return 1
  fi
  compose=(docker compose --project-directory "$HUB_DIR" --env-file "$HUB_ENV_FILE" -f "$HUB_DIR/compose.yml" -p "${HUB_COMPOSE_PROJECT:-hulinger}")
  for override in "$HUB_DIR/compose.override.yml" "$HUB_DIR/compose.override.yaml"; do
    [[ ! -f "$override" ]] || compose+=(-f "$override")
  done
}

hub_operation_lock() {
  command -v flock >/dev/null
  mkdir -p "$HUB_DIR/.deploy"
  local operation_lock="$HUB_DIR/.deploy/operation.lock"
  # An update invokes backup as a child. Reuse its inherited, verified lock fd.
  if [[ "${HUB_OPERATION_LOCK_PATH:-}" != "$operation_lock" || ! -e /proc/self/fd/8 || "$(readlink /proc/self/fd/8)" != "$operation_lock" ]]; then
    exec 8>"$operation_lock"
  fi
  flock -n 8 || { echo 'Another deployment update or backup is running.' >&2; return 1; }
  export HUB_OPERATION_LOCK_PATH="$operation_lock"
}
