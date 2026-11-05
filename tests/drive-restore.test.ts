import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import pg from 'pg';

const connection = process.env.AUTH_TEST_DATABASE_URL ?? process.env.TEST_DATABASE_URL;
test('restore verifier accepts paired bytes and rejects missing parts, wrong size and corruption', { skip: !connection, timeout: 30000 }, async () => {
  const admin = new pg.Pool({ connectionString: connection });
  const databaseName = `restore_test_${randomUUID().replaceAll('-', '')}`;
  const url = new URL(connection!);
  url.pathname = `/${databaseName}`;
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  const db = new pg.Pool({ connectionString: url.href });
  const directory = await mkdtemp(path.join(tmpdir(), 'hulinger-drive-restore-'));
  const id = randomUUID();
  const bytes = Buffer.from('paired-restored-file-bytes');
  const filename = path.join(directory, 'objects', `${id}.bin`);
  const run = () => spawnSync(process.execPath, ['--import', 'tsx', 'scripts/verify-drive-storage.ts'], {
    encoding: 'utf8', env: { ...process.env, DATABASE_URL: url.href, DRIVE_STORAGE_PATH: directory }, windowsHide: true,
  });
  try {
    await db.query(await readFile('migrations/004-drive.sql', 'utf8'));
    await mkdir(path.dirname(filename));
    await writeFile(filename, bytes);
    const sha = createHash('sha256').update(bytes).digest('hex');
    await db.query("INSERT INTO drive_files(id,owner_id,name,size,status,chunk_size,chunk_count,last_modified,fingerprint) VALUES($1,'fixture','fixture.bin',$2,'ready',1048576,1,0,$3)", [id, bytes.length, sha]);
    await db.query('INSERT INTO drive_parts(file_id,part_index,bytes,sha256) VALUES($1,0,$2,$3)', [id, bytes.length, sha]);
    const good = run();
    assert.equal(good.status, 0, good.stderr);
    assert.match(good.stdout, /Verified 1 restored files and 1 SHA-256 parts/);
    await writeFile(filename, Buffer.alloc(bytes.length, 0));
    assert.match(run().stderr, /Stored part hash differs/);
    await writeFile(filename, bytes.subarray(1));
    assert.match(run().stderr, /Stored file size\/type differs/);
    await writeFile(filename, bytes);
    await db.query('DELETE FROM drive_parts');
    assert.match(run().stderr, /Completed file part count differs/);
  } finally {
    await db.end();
    await admin.query(`DROP DATABASE "${databaseName}"`);
    await admin.end();
    await rm(directory, { recursive: true, force: true });
  }
});
