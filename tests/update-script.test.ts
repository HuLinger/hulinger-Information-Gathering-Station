import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const linux = process.platform === 'linux';
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'hulinger-update-'));
  const source = path.join(root, 'source');
  const deployment = path.join(root, 'deployment');
  const remote = path.join(root, 'remote.git');
  const bin = path.join(root, 'bin');
  mkdirSync(source); mkdirSync(bin);
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(source, 'init', '-b', 'main');
  git(source, 'config', 'user.email', 'fixture@example.test'); git(source, 'config', 'user.name', 'Fixture');
  cpSync('scripts', path.join(source, 'scripts'), { recursive: true });
  writeFileSync(path.join(source, 'scripts', 'backup.sh'), '#!/usr/bin/env bash\nprintf "backup\\n" >>"$CALLS"\n[[ "${FAIL_BACKUP:-}" != 1 ]]\n');
  writeFileSync(path.join(source, '.gitignore'), '.env\ncompose.override.yml\n.deploy/\n');
  writeFileSync(path.join(source, 'compose.yml'), 'services: {}\n');
  writeFileSync(path.join(source, 'tracked.txt'), 'previous\n');
  git(source, 'add', '.'); git(source, 'commit', '-m', 'fixture baseline');
  git(root, 'clone', '--bare', source, remote);
  git(source, 'remote', 'add', 'origin', remote);
  git(root, 'clone', remote, deployment);
  git(deployment, 'config', 'user.email', 'fixture@example.test'); git(deployment, 'config', 'user.name', 'Fixture');
  const before = git(deployment, 'rev-parse', 'HEAD');
  writeFileSync(path.join(source, 'tracked.txt'), 'release\n');
  git(source, 'add', '.'); git(source, 'commit', '-m', 'fixture release'); git(source, 'push', 'origin', 'main');
  const target = git(source, 'rev-parse', 'HEAD');
  writeFileSync(path.join(deployment, '.env'), 'SERVER_LOCAL_SETTING=preserved\n');
  writeFileSync(path.join(deployment, 'compose.override.yml'), 'services: {web: {cpus: 0.5}}\n');
  const calls = path.join(root, 'calls');
  writeFileSync(path.join(bin, 'docker'), `#!/usr/bin/env bash
printf '%s\n' "$*" >>"$CALLS"
case "$*" in
  *' ps -q web') echo fixture-container ;;
  'inspect --format {{.Image}} fixture-container') echo sha256:previous-image ;;
esac
if [[ "$*" == *' build web worker migrate' && "$FAIL_BUILD" == 1 ]]; then exit 42; fi
if [[ "$*" == *' run --rm --no-deps migrate' && "$FAIL_MIGRATION" == 1 ]]; then exit 43; fi
`, { mode: 0o755 });
  const run = (env: Record<string, string> = {}) => spawnSync('bash', ['scripts/update.sh'], { cwd: deployment, encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CALLS: calls, ...env } });
  return { root, source, deployment, before, target, git, calls, run };
}

test('Linux updater preserves local configuration and fast forwards only after backup', { skip: !linux }, () => {
  const f = fixture();
  try {
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(f.git(f.deployment, 'rev-parse', 'HEAD'), f.target);
    assert.equal(readFileSync(path.join(f.deployment, '.env'), 'utf8'), 'SERVER_LOCAL_SETTING=preserved\n');
    assert.equal(readFileSync(path.join(f.deployment, 'compose.override.yml'), 'utf8'), 'services: {web: {cpus: 0.5}}\n');
    const calls = readFileSync(f.calls, 'utf8');
    assert.ok(calls.indexOf('backup\n') < calls.indexOf(' build web worker migrate'));
    assert.ok(calls.indexOf(' build web worker migrate') < calls.indexOf(' stop web worker'));
    assert.ok(calls.indexOf(' run --rm --no-deps migrate') < calls.indexOf(' up -d --no-build --wait'));
    assert.ok(calls.split('\n').filter((line) => line.startsWith('compose ')).every((line) => line.includes('compose.override.yml')));
    assert.match(readFileSync(path.join(f.deployment, '.deploy/previous-release'), 'utf8'), new RegExp(f.before));
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('Linux updater refuses dirty sources and committed local divergence without overwriting either', { skip: !linux }, () => {
  const f = fixture();
  try {
    writeFileSync(path.join(f.deployment, 'tracked.txt'), 'local customization\n');
    assert.notEqual(f.run().status, 0);
    assert.equal(readFileSync(path.join(f.deployment, 'tracked.txt'), 'utf8'), 'local customization\n');
    f.git(f.deployment, 'add', '.'); f.git(f.deployment, 'commit', '-m', 'local customization');
    const localCommit = f.git(f.deployment, 'rev-parse', 'HEAD');
    const result = f.run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /local commits diverge/);
    assert.equal(f.git(f.deployment, 'rev-parse', 'HEAD'), localCommit);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('Linux updater leaves the old source on backup/build failure and stops after migration failure', { skip: !linux }, () => {
  for (const failure of ['FAIL_BACKUP', 'FAIL_BUILD', 'FAIL_MIGRATION']) {
    const f = fixture();
    try {
      assert.notEqual(f.run({ [failure]: '1' }).status, 0);
      const calls = readFileSync(f.calls, 'utf8');
      if (failure !== 'FAIL_MIGRATION') {
        assert.equal(f.git(f.deployment, 'rev-parse', 'HEAD'), f.before);
        assert.ok(!calls.includes(' stop web worker'));
      } else {
        assert.ok(calls.includes(' run --rm --no-deps migrate'));
        assert.ok(!calls.includes(' up -d --no-build --wait'));
      }
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }
});
