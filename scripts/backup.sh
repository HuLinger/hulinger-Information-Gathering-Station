#!/usr/bin/env bash
set -euo pipefail
umask 077

# Run on the Linux Docker host; credentials are supplied by a root-only environment file.
: "${HUB_DIR:?Set HUB_DIR to the deployment checkout}"
: "${RESTIC_REPOSITORY:?Set an independent encrypted backup repository}"
: "${RESTIC_PASSWORD_FILE:?Set the root-only restic password file}"
source "$(dirname "${BASH_SOURCE[0]}")/lib/compose.sh"
hub_compose_init
test -f "$RESTIC_PASSWORD_FILE"
command -v restic >/dev/null
command -v flock >/dev/null
hub_operation_lock

state="${HUB_BACKUP_STATE:-/var/lib/hulinger-backup}"
staging="$state/staging"
install -d -m 0700 "$state" "$staging"
exec 9>"$state/backup.lock"
flock -n 9 || { echo 'A Hulinger backup is already running.' >&2; exit 1; }
running=()
stopped=false
cleanup() {
  code=$?
  if [[ "${stopped:-false}" == true && ${#running[@]} -gt 0 ]]; then
    "${compose[@]}" up -d --no-deps --no-build "${running[@]}" || code=1
  fi
  rm -f -- "$staging/hulinger.dump" "$staging/site.env" "$staging/release.txt" "$staging/compose.yml" "$staging/Caddyfile" "$staging/compose.override.yml" "$staging/compose.override.yaml" "$staging/drive-path.txt" "$staging/counts.tsv"
  exit "$code"
}
trap cleanup EXIT

# Quiesce both writers (including garbage collection) for one paired snapshot.
running_services="$("${compose[@]}" ps --status running --services)"
while IFS= read -r service; do
  [[ "$service" != web && "$service" != worker ]] || running+=("$service")
done <<<"$running_services"
stopped=true
"${compose[@]}" stop web worker
container="$("${compose[@]}" ps -aq web)"
drive_path=''
if [[ -n "$container" ]]; then
  drive_path="$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/data/drive"}}{{.Source}}{{end}}{{end}}' "$container")"
fi
has_drive="$("${compose[@]}" exec -T db psql -U postgres -d hulinger -At -v ON_ERROR_STOP=1 -c "SELECT to_regclass('public.drive_files') IS NOT NULL;")"
if [[ "$has_drive" == t && -z "$drive_path" ]]; then
  echo 'Drive metadata exists but no /data/drive mount was found. Refusing a database-only backup.' >&2
  exit 1
fi
paths=("$staging")
if [[ -n "$drive_path" ]]; then
  drive_path="$(realpath -- "$drive_path")"
  [[ -d "$drive_path/objects" ]] || { echo 'The mounted private drive directory is missing; backup stopped.' >&2; exit 1; }
  paths+=("$drive_path")
fi
printf '%s\n' "$drive_path" >"$staging/drive-path.txt"
"${compose[@]}" exec -T db pg_dump -U postgres -d hulinger --format=custom >"$staging/hulinger.dump"
test -s "$staging/hulinger.dump"
"${compose[@]}" exec -T db pg_restore --list <"$staging/hulinger.dump" >/dev/null
cp -- "$HUB_ENV_FILE" "$staging/site.env"
cp -- "$HUB_DIR/compose.yml" "$HUB_DIR/Caddyfile" "$staging/"
for override in compose.override.yml compose.override.yaml; do
  [[ ! -f "$HUB_DIR/$override" ]] || cp -- "$HUB_DIR/$override" "$staging/$override"
done
"${compose[@]}" exec -T db psql -U postgres -d hulinger -At -F $'\t' -v ON_ERROR_STOP=1 -c "SELECT 'events',count(*) FROM events UNION ALL SELECT 'entities',count(*) FROM entities UNION ALL SELECT 'sources',count(*) FROM sources;" >"$staging/counts.tsv"
if [[ "$has_drive" == t ]]; then
  "${compose[@]}" exec -T db psql -U postgres -d hulinger -At -F $'\t' -v ON_ERROR_STOP=1 -c "SELECT 'drive_files',count(*) FROM drive_files UNION ALL SELECT 'drive_parts',count(*) FROM drive_parts;" >>"$staging/counts.tsv"
fi
for account_table in member_accounts login_events account_management_events account_settings game_saves; do
  has_table="$("${compose[@]}" exec -T db psql -U postgres -d hulinger -At -v ON_ERROR_STOP=1 -c "SELECT to_regclass('public.$account_table') IS NOT NULL;")"
  if [[ "$has_table" == t ]]; then
    "${compose[@]}" exec -T db psql -U postgres -d hulinger -At -F $'\t' -v ON_ERROR_STOP=1 -c "SELECT '$account_table',count(*) FROM $account_table;" >>"$staging/counts.tsv"
  fi
done

git -c safe.directory="$HUB_DIR" -C "$HUB_DIR" rev-parse HEAD >"$staging/release.txt"
"${compose[@]}" images >>"$staging/release.txt"

backup_host="${BACKUP_HOST:-hulinger-production}"
restic backup --host "$backup_host" --tag hulinger --group-by host,tags "${paths[@]}"
# File objects are backed up incrementally in place, with no full tar/copy staging.
if [[ ${#running[@]} -gt 0 ]]; then
  "${compose[@]}" up -d --no-deps --no-build "${running[@]}"
fi
stopped=false
restic forget --host "$backup_host" --tag hulinger --group-by host,tags --keep-daily 7 --keep-weekly 4 --prune
restic check
date -u +%FT%TZ >"$state/last-success"
echo 'Encrypted backup and repository metadata check completed.'
