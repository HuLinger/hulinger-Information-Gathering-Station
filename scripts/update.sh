#!/usr/bin/env bash
set -euo pipefail
umask 077
source "$(dirname "${BASH_SOURCE[0]}")/lib/compose.sh"
hub_compose_init
ref="${1:-origin/main}"
[[ $# -le 1 && "$ref" != -* ]] || { echo 'Usage: bash scripts/update.sh [origin/main|release-ref]' >&2; exit 2; }
git_cmd=(git -c safe.directory="$HUB_DIR" -C "$HUB_DIR")
[[ "$("${git_cmd[@]}" rev-parse --show-toplevel)" == "$HUB_DIR" ]] || { echo 'Deployment directory must be the repository root.' >&2; exit 1; }
if [[ -n "$("${git_cmd[@]}" status --porcelain --untracked-files=normal)" ]]; then
  echo 'Update stopped: source changes or untracked files exist. Preserve them in a branch; move server settings to .env and compose.override.yml before retrying.' >&2
  exit 1
fi
hub_operation_lock
"${git_cmd[@]}" fetch --prune origin
previous="$("${git_cmd[@]}" rev-parse HEAD)"
target="$("${git_cmd[@]}" rev-parse --verify "$ref^{commit}")"
"${git_cmd[@]}" merge-base --is-ancestor "$previous" "$target" || {
  echo 'Update stopped: local commits diverge from this release. Keep the custom branch and reconcile it explicitly; no reset or overwrite was performed.' >&2
  exit 1
}
[[ "$previous" != "$target" ]] || { echo 'Already at the requested release.'; exit 0; }
"${compose[@]}" config --quiet
container="$("${compose[@]}" ps -q web)"
[[ -n "$container" ]] || { echo 'The existing web service must be running before an in-place update.' >&2; exit 1; }
image="$(docker inspect --format '{{.Image}}' "$container")"
rollback="hulinger-rollback:$(date -u +%Y%m%dT%H%M%SZ)"
docker image tag "$image" "$rollback"
printf 'previous_commit=%s\ntarget_commit=%s\nprevious_image=%s\nrollback_image=%s\n' "$previous" "$target" "$image" "$rollback" >"$HUB_DIR/.deploy/previous-release"
# The encrypted backup must finish before changing the deployment checkout.
export HUB_DIR HUB_ENV_FILE
bash "$HUB_DIR/scripts/backup.sh"
stage=checkout
failed() {
  code=$?
  if [[ "$code" != 0 ]]; then
    echo "Update stopped during $stage. Previous release: $previous; image: $rollback. See .deploy/previous-release and docs/deployment.md." >&2
    if [[ "$stage" == checkout || "$stage" == build ]]; then
      "${git_cmd[@]}" switch --detach "$previous" || true
      echo 'Existing containers remain on the previous image.' >&2
    else
      "${compose[@]}" stop web worker || true
      echo 'Application services remain stopped. Verify migration compatibility or restore the paired backup before restarting.' >&2
    fi
  fi
}
trap failed EXIT
"${git_cmd[@]}" merge --ff-only "$target"
# Re-read updated base configuration while retaining the same local environment and override.
source "$HUB_DIR/scripts/lib/compose.sh"
hub_compose_init
"${compose[@]}" config --quiet
stage=build
"${compose[@]}" build web worker migrate
stage=stop
"${compose[@]}" stop web worker
stage=migrate
"${compose[@]}" run --rm --no-deps migrate
stage=start
"${compose[@]}" up -d --no-build --wait --wait-timeout 180 web worker
"${compose[@]}" up -d --no-build caddy
"${compose[@]}" exec -T caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1 || "${compose[@]}" restart caddy
"${compose[@]}" exec -T web node -e "fetch('http://127.0.0.1:3000/api/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
printf '%s\n' "$target" >"$HUB_DIR/.deploy/current-release"
stage=complete
echo "Update healthy at $target. Local .env and Compose override were preserved."
