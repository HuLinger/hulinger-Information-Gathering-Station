#!/usr/bin/env bash
set -euo pipefail
umask 077

# Run on the Linux Docker host; credentials are supplied by a root-only environment file.
: "${HUB_DIR:?Set HUB_DIR to the deployment checkout}"
: "${RESTIC_REPOSITORY:?Set an independent encrypted backup repository}"
: "${RESTIC_PASSWORD_FILE:?Set the root-only restic password file}"
test -f "$HUB_DIR/.env"
test -f "$RESTIC_PASSWORD_FILE"
command -v restic >/dev/null
command -v flock >/dev/null

state=/var/lib/hulinger-backup
staging="$state/staging"
install -d -m 0700 "$state" "$staging"
exec 9>"$state/backup.lock"
flock -n 9 || { echo 'A Hulinger backup is already running.' >&2; exit 1; }
cleanup() {
  rm -f -- "$staging/hulinger.dump" "$staging/site.env" "$staging/release.txt" "$staging/compose.yml" "$staging/Caddyfile"
}
trap cleanup EXIT

compose=(docker compose --project-directory "$HUB_DIR" --env-file "$HUB_DIR/.env" -f "$HUB_DIR/compose.yml" -p "${HUB_COMPOSE_PROJECT:-hulinger}")
"${compose[@]}" exec -T db pg_dump -U postgres -d hulinger --format=custom >"$staging/hulinger.dump"
test -s "$staging/hulinger.dump"
"${compose[@]}" exec -T db pg_restore --list <"$staging/hulinger.dump" >/dev/null
cp -- "$HUB_DIR/.env" "$staging/site.env"
cp -- "$HUB_DIR/compose.yml" "$HUB_DIR/Caddyfile" "$staging/"
git -c safe.directory="$HUB_DIR" -C "$HUB_DIR" rev-parse HEAD >"$staging/release.txt"
"${compose[@]}" images >>"$staging/release.txt"

backup_host="${BACKUP_HOST:-hulinger-production}"
restic backup --host "$backup_host" --tag hulinger --group-by host,tags "$staging"
restic forget --host "$backup_host" --tag hulinger --group-by host,tags --keep-daily 7 --keep-weekly 4 --prune
restic check
date -u +%FT%TZ >"$state/last-success"
echo 'Encrypted backup and repository metadata check completed.'
