#!/usr/bin/env bash
# Synthetic CI only: dedicated project names and a repository-local restic repository.
set -euo pipefail
[[ "${CI:-}" == true ]] || { echo 'This restore exercise is only for isolated CI.' >&2; exit 1; }
export HUB_DIR="$PWD" HUB_ENV_FILE="$PWD/.tmp/ci.env" HUB_COMPOSE_PROJECT=hulinger_ci
export HUB_BACKUP_STATE="$PWD/.tmp/backup-state" RESTIC_REPOSITORY="$PWD/.tmp/restic"
export RESTIC_PASSWORD_FILE="$PWD/.tmp/restic-password" BACKUP_HOST=hulinger-ci
umask 077
openssl rand -hex 32 >"$RESTIC_PASSWORD_FILE"
restic init
source scripts/lib/compose.sh
hub_compose_init
"${compose[@]}" exec -T web node --input-type=module <<'JS'
import { mkdir, open, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import pg from 'pg';
const id = '7251a825-1e4b-41d1-ae3c-74cc89247c72';
const data = Buffer.from('Synthetic paired backup and file restore fixture.\n');
const sha = createHash('sha256').update(data).digest('hex');
await mkdir('/data/drive/objects', { recursive: true });
await writeFile(`/data/drive/objects/${id}.bin`, data, { mode: 0o600 });
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
try {
  await pool.query("INSERT INTO drive_files(id,owner_id,name,size,status,chunk_size,chunk_count,last_modified,fingerprint,completed_at) VALUES($1,'ci-synthetic-owner','restore-fixture.bin',$2,'ready',1048576,1,0,$3,now())", [id, data.length, sha]);
  await pool.query('INSERT INTO drive_parts(file_id,part_index,bytes,sha256) VALUES($1,0,$2,$3)', [id, data.length, sha]);
  const pendingId = 'a7a651d6-8255-44ac-91f5-0fc343687ffa';
  const part = Buffer.alloc(1048576, 42);
  const partSha = createHash('sha256').update(part).digest('hex');
  const handle = await open(`/data/drive/objects/${pendingId}.bin`, 'w', 0o600);
  try { await handle.truncate(8 * 1048576); await handle.write(part, 0, part.length, 0); }
  finally { await handle.close(); }
  await pool.query("INSERT INTO drive_files(id,owner_id,name,size,status,chunk_size,chunk_count,last_modified,fingerprint) VALUES($1,'ci-synthetic-owner','pending-fixture.bin',$2,'uploading',1048576,8,0,$3)", [pendingId, 8 * 1048576, partSha]);
  await pool.query('INSERT INTO drive_parts(file_id,part_index,bytes,sha256) VALUES($1,0,$2,$3)', [pendingId, part.length, partSha]);
} finally { await pool.end(); }
JS
bash scripts/backup.sh
restore_root="$PWD/.tmp/paired-restore"
restic restore latest --sparse --target "$restore_root"
staging="$restore_root$HUB_BACKUP_STATE/staging"
drive_original="$(cat "$staging/drive-path.txt")"
[[ -n "$drive_original" && -f "$staging/hulinger.dump" && -d "$restore_root$drive_original/objects" ]]
cmp "$HUB_ENV_FILE" "$staging/site.env"
cp -- "$staging/site.env" .tmp/restored.env
# Explicit -f excludes any saved local override: it may point at a production bind/volume.
restore_dc=(docker compose --env-file .tmp/restored.env -p hulinger_restore_ci -f compose.yml)
cleanup() { "${restore_dc[@]}" down --volumes; }
trap cleanup EXIT
"${restore_dc[@]}" up -d --wait --wait-timeout 90 db
"${restore_dc[@]}" run --rm --no-deps migrate
"${restore_dc[@]}" exec -T db pg_restore -U postgres -d hulinger --clean --if-exists --exit-on-error <"$staging/hulinger.dump"
"${restore_dc[@]}" run --rm --no-deps migrate
"${restore_dc[@]}" run --rm --no-deps --user root --cap-add DAC_OVERRIDE --cap-add CHOWN --cap-add FOWNER -v "$restore_root$drive_original:/restore:ro" web sh -c 'cp -a --sparse=always /restore/. /data/drive/'
"${restore_dc[@]}" exec -T db psql -U postgres -d hulinger -At -F $'\t' -v ON_ERROR_STOP=1 -c "SELECT 'events',count(*) FROM events UNION ALL SELECT 'entities',count(*) FROM entities UNION ALL SELECT 'sources',count(*) FROM sources UNION ALL SELECT 'drive_files',count(*) FROM drive_files UNION ALL SELECT 'drive_parts',count(*) FROM drive_parts;" >.tmp/restored-counts.tsv
diff -u "$staging/counts.tsv" .tmp/restored-counts.tsv
"${restore_dc[@]}" run --rm --no-deps web node --import tsx scripts/verify-drive-storage.ts
"${restore_dc[@]}" exec -T db psql -U postgres -d hulinger -v ON_ERROR_STOP=1 -c 'UPDATE sources SET enabled=false; DELETE FROM "session";'
"${restore_dc[@]}" up -d --no-build --wait --wait-timeout 180 web worker
"${restore_dc[@]}" exec -T web node -e "Promise.all([fetch('http://127.0.0.1:3000/api/ready'),fetch('http://127.0.0.1:3000/api/drive/files/7251a825-1e4b-41d1-ae3c-74cc89247c72/content')]).then(([r,f])=>process.exit(r.ok&&f.status===401?0:1))"
echo 'Paired encrypted database/files restore, counts, hashes and startup verified.'
