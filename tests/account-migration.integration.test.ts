import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { Pool } from 'pg';

const databaseURL = process.env.AUTH_TEST_DATABASE_URL ?? process.env.TEST_DATABASE_URL;

test('existing owner upgrade retains credentials, MFA, sessions and owned data across repeated migrations', { skip: !databaseURL, timeout: 60_000 }, async () => {
  const admin = new Pool({ connectionString: databaseURL, max: 1 });
  const name = `migration_test_${randomUUID().replaceAll('-', '')}`;
  const url = new URL(databaseURL!);
  url.pathname = `/${name}`;
  const legacyDirectory = await mkdtemp(join(tmpdir(), 'hulinger-legacy-migrations-'));
  await admin.query(`CREATE DATABASE "${name}"`);
  const database = new Pool({ connectionString: url.href, max: 4 });
  process.env.DATABASE_URL = url.href;
  process.env.APP_URL = 'http://127.0.0.1:3000';
  process.env.BETTER_AUTH_SECRET = randomBytes(32).toString('hex');
  Object.assign(process.env, { NODE_ENV: 'test' });
  try {
    for (const file of await readdir('migrations')) {
      if (/^00[1-4]-.*\.sql$/.test(file)) await copyFile(join('migrations', file), join(legacyDirectory, file));
    }
    const { migrate } = await import('../scripts/migrate');
    const { createOwnerAccount } = await import('../scripts/owner');
    await migrate(database, { directory: legacyDirectory });
    const id = await createOwnerAccount(database, 'legacy@example.test', 'Legacy-owner-synthetic-password');
    await database.query('UPDATE "user" SET "twoFactorEnabled"=true WHERE id=$1', [id]);
    await database.query(`INSERT INTO "twoFactor"(id,secret,"backupCodes","userId",verified)
      VALUES($1,'synthetic-encrypted-secret','synthetic-encrypted-backup-codes',$2,true)`, [randomUUID(), id]);
    const sessionId = randomUUID();
    await database.query(`INSERT INTO "session"(id,token,"userId","expiresAt","createdAt","updatedAt")
      VALUES($1,$2,$3,now()+interval '1 day',now(),now())`, [sessionId, randomBytes(32).toString('hex'), id]);
    await database.query('INSERT INTO auth_session_assurance(session_id,user_id) VALUES($1,$2)', [sessionId, id]);
    const eventId = randomUUID();
    await database.query(`INSERT INTO events(id,title,summary,kind,url,source_name)
      VALUES($1,'合成旧资料','保留人工记录','model','https://example.test/legacy','合成来源')`, [eventId]);
    const credential = (await database.query('SELECT password FROM account WHERE "userId"=$1', [id])).rows[0].password;
    await migrate(database);
    await migrate(database);
    assert.equal((await database.query("SELECT value->>'id' AS id FROM app_settings WHERE key='owner'")).rows[0].id, id);
    const user = (await database.query('SELECT username,email,"twoFactorEnabled" FROM "user" WHERE id=$1', [id])).rows[0];
    assert.deepEqual(user, { username: 'admin', email: 'legacy@example.test', twoFactorEnabled: true });
    assert.equal((await database.query('SELECT password FROM account WHERE "userId"=$1', [id])).rows[0].password, credential);
    assert.equal((await database.query('SELECT secret FROM "twoFactor" WHERE "userId"=$1', [id])).rows[0].secret, 'synthetic-encrypted-secret');
    assert.equal((await database.query('SELECT count(*)::int AS count FROM auth_session_assurance WHERE session_id=$1', [sessionId])).rows[0].count, 1);
    const event = (await database.query('SELECT owner_id,title FROM events WHERE id=$1', [eventId])).rows[0];
    assert.deepEqual(event, { owner_id: id, title: '合成旧资料' });
    assert.equal((await database.query("SELECT 1 FROM pg_indexes WHERE indexname='only_one_owner_account'")).rowCount, 0);
    assert.equal((await database.query('SELECT count(*)::int AS count FROM member_accounts')).rows[0].count, 0);
  } finally {
    await database.end();
    const { pool } = await import('../src/server/db');
    await pool.end();
    await admin.query(`DROP DATABASE "${name}"`);
    await admin.end();
    assert.equal(dirname(resolve(legacyDirectory)).toLowerCase(), resolve(tmpdir()).toLowerCase());
    await rm(legacyDirectory, { recursive: true, force: true });
  }
});
