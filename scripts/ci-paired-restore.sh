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
"${compose[@]}" exec -T web node --import tsx --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { mkdir, open, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pool, withAccountScope, accountQuery } from './src/server/db.ts';
import { createMember, updateMember, resetMemberPassword, revokeMemberSessions, recordLogin, closeAccountConnections } from './src/server/accounts.ts';
import { writeSave } from './src/server/games/saves.ts';
const id = '7251a825-1e4b-41d1-ae3c-74cc89247c72';
const data = Buffer.from('Synthetic paired backup and file restore fixture.\n');
const sha = createHash('sha256').update(data).digest('hex');
await mkdir('/data/drive/objects', { recursive: true });
await writeFile(`/data/drive/objects/${id}.bin`, data, { mode: 0o600 });
try {
  const owner = (await pool.query("SELECT value->>'id' AS id FROM app_settings WHERE key='owner'")).rows[0]?.id;
  assert(owner, 'The preceding isolated owner/MFA smoke test must create the CI owner.');
  const alpha = await createMember(owner, { username: 'ci_restore_alpha', name: 'Synthetic restore alpha', password: 'Synthetic-restore-alpha-original' });
  const beta = await createMember(owner, { username: 'ci_restore_beta', name: 'Synthetic restore beta', password: 'Synthetic-restore-beta-password' });
  await resetMemberPassword(owner, alpha.id, { password: 'Synthetic-restore-alpha-reset' });
  await revokeMemberSessions(owner, alpha.id);
  await updateMember(owner, beta.id, { disabled: true });
  for (const [member, marker] of [[alpha, 'alpha'], [beta, 'beta']]) {
    await withAccountScope(member.id, async () => {
      // Deliberately reuse both logical IDs: ownership, not ID uniqueness, isolates the restored data.
      await accountQuery(`INSERT INTO events(id,title,summary,kind,url,source_name,personal)
        VALUES('ci-member-restore-event',$1,'Synthetic restore data','tool','https://example.test/paired-member','Synthetic CI',$2)`,
      [`Synthetic ${marker} event`, { favorite: true, later: false, read: false, archived: false, note: `Synthetic private ${marker} note` }]);
      // These bytes are explicitly synthetic opaque data, not a playable game save or gameplay validation.
      const snapshot = { formatVersion: 1, files: [{ path: '/shattered-pixel-dungeon/game1/game.dat/', type: 2,
        data: Buffer.from(`Synthetic ${marker} restore fixture; not a playable game save.`).toString('base64'),
        modifiedAt: '2026-11-06T00:00:00.000Z' }], prefs: { restoreFixture: marker } };
      await writeSave({ scope: member.id, revision: 0, snapshot });
      if (marker === 'alpha') await writeSave({ scope: member.id, revision: 1, snapshot });
    });
    // Synthetic audit events exercise persistence; real restored HTTP login is checked below.
    await recordLogin(new Headers({ 'x-forwarded-for': '203.0.113.159', 'user-agent': 'Synthetic Firefox/140.0 (Linux)' }),
      member.id, marker === 'alpha' ? 'success' : 'failure', 'password');
  }
  await pool.query("INSERT INTO drive_files(id,owner_id,name,size,status,chunk_size,chunk_count,last_modified,fingerprint,completed_at) VALUES($1,$2,'restore-fixture.bin',$3,'ready',1048576,1,0,$4,now())", [id, owner, data.length, sha]);
  await pool.query('INSERT INTO drive_parts(file_id,part_index,bytes,sha256) VALUES($1,0,$2,$3)', [id, data.length, sha]);
  const pendingId = 'a7a651d6-8255-44ac-91f5-0fc343687ffa';
  const part = Buffer.alloc(1048576, 42);
  const partSha = createHash('sha256').update(part).digest('hex');
  const handle = await open(`/data/drive/objects/${pendingId}.bin`, 'w', 0o600);
  try { await handle.truncate(8 * 1048576); await handle.write(part, 0, part.length, 0); }
  finally { await handle.close(); }
  await pool.query("INSERT INTO drive_files(id,owner_id,name,size,status,chunk_size,chunk_count,last_modified,fingerprint) VALUES($1,$2,'pending-fixture.bin',$3,'uploading',1048576,8,0,$4)", [pendingId, alpha.id, 8 * 1048576, partSha]);
  await pool.query('INSERT INTO drive_parts(file_id,part_index,bytes,sha256) VALUES($1,0,$2,$3)', [pendingId, part.length, partSha]);
} finally { await closeAccountConnections(); await pool.end(); }
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
for account_table in member_accounts login_events account_management_events account_settings game_saves; do
  "${restore_dc[@]}" exec -T db psql -U postgres -d hulinger -At -F $'\t' -v ON_ERROR_STOP=1 -c "SELECT '$account_table',count(*) FROM $account_table;" >>.tmp/restored-counts.tsv
done
diff -u "$staging/counts.tsv" .tmp/restored-counts.tsv
# Inspect the restored state through the restricted application role before starting either writer.
"${restore_dc[@]}" run --rm --no-deps -T web node --import tsx --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { verifyPassword } from 'better-auth/crypto';
import { pool, query, withAccountScope, accountQuery } from './src/server/db.ts';
import { readSave } from './src/server/games/saves.ts';
try {
  assert.equal((await query('SELECT current_user AS role'))[0].role, new URL(process.env.DATABASE_URL).username);
  assert.deepEqual((await query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user'))[0], { rolsuper: false, rolbypassrls: false });
  const owner = (await query("SELECT value->>'id' AS id FROM app_settings WHERE key='owner'"))[0].id;
  assert.equal((await query('SELECT "twoFactorEnabled" FROM "user" WHERE id=$1', [owner]))[0].twoFactorEnabled, true);
  assert.equal((await query('SELECT count(*)::int AS count FROM "twoFactor" WHERE "userId"=$1 AND verified=true', [owner]))[0].count, 1);
  const members = await query(`SELECT u.id,u.username,u."twoFactorEnabled",m.disabled,m.created_by,a.password
    FROM "user" u JOIN member_accounts m ON m.user_id=u.id JOIN account a ON a."userId"=u.id AND a."providerId"='credential'
    WHERE u.username IN ('ci_restore_alpha','ci_restore_beta') ORDER BY u.username`);
  assert.equal(members.length, 2);
  assert.deepEqual(await query('SELECT id FROM events'), [], 'Missing account scope must still deny restored private rows.');
  for (const member of members) {
    const marker = member.username === 'ci_restore_alpha' ? 'alpha' : 'beta';
    assert.equal(member.disabled, marker === 'beta');
    assert.equal(member.twoFactorEnabled, false);
    assert.equal(member.created_by, owner);
    assert(await verifyPassword({ hash: member.password, password: `Synthetic-restore-${marker}-${marker === 'alpha' ? 'reset' : 'password'}` }));
    if (marker === 'alpha') assert.equal(await verifyPassword({ hash: member.password, password: 'Synthetic-restore-alpha-original' }), false);
    const actions = await query('SELECT action,actor_id FROM account_management_events WHERE user_id=$1 ORDER BY action', [member.id]);
    assert.deepEqual(actions.map((event) => event.action), marker === 'alpha'
      ? ['member_created', 'password_reset', 'sessions_revoked'] : ['member_created', 'member_disabled']);
    assert(actions.every((event) => event.actor_id === owner));
    const audit = await query('SELECT outcome,method,ip_prefix,user_agent FROM login_events WHERE user_id=$1', [member.id]);
    assert.deepEqual(audit, [{ outcome: marker === 'alpha' ? 'success' : 'failure', method: 'password', ip_prefix: '203.0.113.0/24', user_agent: 'Firefox / Linux' }]);
    await withAccountScope(member.id, async () => {
      const events = await accountQuery('SELECT id,title,personal FROM events');
      assert.equal(events.length, 1);
      assert.equal(events[0].id, 'ci-member-restore-event');
      assert.equal(events[0].title, `Synthetic ${marker} event`);
      assert.equal(events[0].personal.note, `Synthetic private ${marker} note`);
      const other = members.find((candidate) => candidate.id !== member.id);
      assert.deepEqual(await accountQuery('SELECT id FROM events WHERE owner_id=$1', [other.id]), []);
      const saved = await readSave();
      assert.equal(saved.scope, member.id);
      assert.equal(saved.revision, marker === 'alpha' ? 2 : 1);
      assert.deepEqual(saved.snapshot, { formatVersion: 1, files: [{ path: '/shattered-pixel-dungeon/game1/game.dat/', type: 2,
        data: Buffer.from(`Synthetic ${marker} restore fixture; not a playable game save.`).toString('base64'),
        modifiedAt: '2026-11-06T00:00:00.000Z' }], prefs: { restoreFixture: marker } });
    });
  }
  assert.deepEqual(await query('SELECT id FROM events'), [], 'Restored pooled connections must not retain an account scope.');
  assert.equal((await query('SELECT owner_id FROM drive_files WHERE id=$1', ['7251a825-1e4b-41d1-ae3c-74cc89247c72']))[0].owner_id, owner);
  assert.equal((await query('SELECT owner_id FROM drive_files WHERE id=$1', ['a7a651d6-8255-44ac-91f5-0fc343687ffa']))[0].owner_id, members[0].id);
  await assert.rejects(pool.query('DELETE FROM account_management_events'), { code: '42501' });
  console.log('Synthetic members, credential reset, MFA policy, management/login audits and isolated events/game snapshots restored.');
} finally { await pool.end(); }
JS
"${restore_dc[@]}" run --rm --no-deps web node --import tsx scripts/verify-drive-storage.ts
"${restore_dc[@]}" exec -T db psql -U postgres -d hulinger -v ON_ERROR_STOP=1 -c 'UPDATE sources SET enabled=false; DELETE FROM "session";'
"${restore_dc[@]}" up -d --no-build --wait --wait-timeout 180 web worker
"${restore_dc[@]}" exec -T web node -e "Promise.all([fetch('http://127.0.0.1:3000/api/ready'),fetch('http://127.0.0.1:3000/api/drive/files/7251a825-1e4b-41d1-ae3c-74cc89247c72/content')]).then(([r,f])=>process.exit(r.ok&&f.status===401?0:1))"
"${restore_dc[@]}" exec -T web node --input-type=module <<'JS'
import assert from 'node:assert/strict';
const base = 'http://127.0.0.1:3000';
const origin = process.env.APP_URL;
async function signIn(username, password) {
  return fetch(`${base}/api/auth/sign-in/username`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }), signal: AbortSignal.timeout(30000) });
}
const signedIn = await signIn('ci_restore_alpha', 'Synthetic-restore-alpha-reset');
assert.equal(signedIn.status, 200);
const result = await signedIn.json();
assert.equal(result.twoFactorRedirect, undefined, 'Restored members must not require MFA.');
assert.equal(result.token, undefined);
const cookie = signedIn.headers.getSetCookie().map((value) => value.split(';', 1)[0]).join('; ');
assert(cookie);
const headers = { Cookie: cookie, Origin: origin };
const auth = await (await fetch(`${base}/api/auth/status`, { headers })).json();
assert.equal(auth.state, 'ready');
assert.equal(auth.user.role, 'member');
const hub = await (await fetch(`${base}/api/hub`, { headers })).json();
assert.equal(hub.events.length, 1);
assert.equal(hub.events[0].title, 'Synthetic alpha event');
const save = await (await fetch(`${base}/api/tools/shattered-pixel-dungeon/save`, { headers })).json();
assert.equal(save.scope, auth.user.id);
assert.equal(save.revision, 2);
assert.equal(save.snapshot.prefs.restoreFixture, 'alpha');
assert.equal((await fetch(`${base}/api/accounts`, { headers })).status, 403);
assert.equal((await fetch(`${base}/api/drive/files/7251a825-1e4b-41d1-ae3c-74cc89247c72/content`, { headers })).status, 404);
assert.equal((await signIn('ci_restore_alpha', 'Synthetic-restore-alpha-original')).status, 401);
assert.equal((await signIn('ci_restore_beta', 'Synthetic-restore-beta-password')).status, 401);
assert.equal((await fetch(`${base}/api/auth/sign-out`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: '{}' })).status, 200);
assert.equal((await fetch(`${base}/api/hub`, { headers })).status, 401);
console.log('Restored HTTP member login, disabled/reset credential rejection, account isolation and logout verified with synthetic fixtures.');
JS
echo 'Paired encrypted database/files restore, account audits, isolated synthetic data, file hashes and startup verified.'
