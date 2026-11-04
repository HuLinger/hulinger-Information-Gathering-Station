import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('paired backup holds both writers, snapshots the actual mount and restores only originally running services', { skip: process.platform !== 'linux' }, () => {
  for (const failure of ['', 'restic', 'missing-mount']) {
    const root = mkdtempSync(path.join(tmpdir(), 'hulinger-backup-'));
    const deployment = path.join(root, 'deployment');
    const drive = path.join(root, 'custom-disk');
    const state = path.join(root, 'state');
    const bin = path.join(root, 'bin');
    const callsPath = path.join(root, 'calls');
    for (const directory of [deployment, path.join(drive, 'objects'), bin]) mkdirSync(directory, { recursive: true });
    cpSync('scripts', path.join(deployment, 'scripts'), { recursive: true });
    for (const file of ['.env', 'compose.yml', 'compose.override.yml', 'Caddyfile', 'password']) writeFileSync(path.join(deployment, file), 'synthetic fixture\n');
    writeFileSync(path.join(drive, 'objects', 'fixture.bin'), 'private synthetic bytes');
    writeFileSync(path.join(bin, 'docker'), `#!/usr/bin/env bash
printf 'docker %s\n' "$*" >>"$CALLS"
case "$*" in
  *' ps --status running --services') printf 'web\ndb\n' ;;
  *' ps -aq web') echo fixture-container ;;
  'inspect '*) [[ "$FAILURE" == missing-mount ]] || echo "$FIXTURE_DRIVE" ;;
  *'SELECT to_regclass'*) echo t ;;
  *'pg_dump '*) echo synthetic-dump ;;
  *'pg_restore --list') cat >/dev/null ;;
  *'SELECT '*count*) printf 'events\t0\n' ;;
esac
exit 0
`, { mode: 0o755 });
    writeFileSync(path.join(bin, 'git'), '#!/usr/bin/env bash\necho synthetic-commit\n', { mode: 0o755 });
    writeFileSync(path.join(bin, 'restic'), `#!/usr/bin/env bash
printf 'restic %s\n' "$*" >>"$CALLS"
if [[ "$1" == backup && "$FAILURE" == restic ]]; then exit 47; fi
`, { mode: 0o755 });
    try {
      const result = spawnSync('bash', ['scripts/backup.sh'], { cwd: deployment, encoding: 'utf8', env: {
        ...process.env, PATH: `${bin}:${process.env.PATH}`, HUB_DIR: deployment, HUB_BACKUP_STATE: state,
        RESTIC_REPOSITORY: path.join(root, 'repository'), RESTIC_PASSWORD_FILE: path.join(deployment, 'password'),
        CALLS: callsPath, FIXTURE_DRIVE: drive, FAILURE: failure,
      } });
      assert.equal(result.status === 0, failure === '', result.stderr);
      const calls = readFileSync(callsPath, 'utf8');
      assert.ok(calls.includes(' stop web worker'));
      assert.ok(calls.includes(' up -d --no-deps --no-build web'));
      assert.ok(!calls.includes(' up -d --no-deps --no-build web worker'));
      assert.ok(calls.split('\n').filter((line) => line.startsWith('docker compose ')).every((line) => line.includes('compose.override.yml')));
      if (failure === 'missing-mount') {
        assert.match(result.stderr, /Refusing a database-only backup/);
        assert.ok(!calls.includes('restic backup'));
      } else {
        assert.ok(calls.indexOf(' stop web worker') < calls.indexOf('pg_dump '));
        assert.ok(calls.indexOf('pg_dump ') < calls.indexOf('restic backup'));
        assert.ok(calls.indexOf('restic backup') < calls.indexOf(' up -d --no-deps --no-build web'));
        assert.match(calls, new RegExp(`restic backup[^\n]+${drive}`));
      }
      assert.equal(existsSync(path.join(state, 'last-success')), failure === '');
      assert.equal(existsSync(path.join(state, 'staging', 'site.env')), false);
      assert.equal(readFileSync(path.join(drive, 'objects', 'fixture.bin'), 'utf8'), 'private synthetic bytes');
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});
