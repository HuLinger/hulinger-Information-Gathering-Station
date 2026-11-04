import assert from 'node:assert/strict';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import { Pool } from 'pg';

const databaseURL = process.env.AUTH_TEST_DATABASE_URL ?? process.env.TEST_DATABASE_URL;

// Independent RFC 6238 test client: only test code handles this secret, never a production helper.
function totp(uri: string) {
  const encoded = new URL(uri).searchParams.get('secret')!;
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const character of encoded.replace(/=+$/, '').toUpperCase()) bits += alphabet.indexOf(character).toString(2).padStart(5, '0');
  const key = Buffer.from((bits.match(/.{8}/g) ?? []).map((byte) => parseInt(byte, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const digest = createHmac('sha1', key).update(counter).digest();
  const offset = digest[digest.length - 1] & 15;
  return String((digest.readUInt32BE(offset) & 0x7fff_ffff) % 1_000_000).padStart(6, '0');
}

test('real PostgreSQL: owner, MFA enrollment, stale sessions, recovery and role separation', { skip: !databaseURL, timeout: 90_000 }, async () => {
  const admin = new Pool({ connectionString: databaseURL, max: 2 });
  const name = `auth_test_${randomUUID().replaceAll('-', '')}`;
  const url = new URL(databaseURL!);
  url.pathname = `/${name}`;
  await admin.query(`CREATE DATABASE "${name}"`);
  const database = new Pool({ connectionString: url.href, max: 4 });
  const appPassword = randomBytes(32).toString('hex');
  const workerPassword = randomBytes(32).toString('hex');
  const appName = `${name}_app`;
  const workerName = `${name}_worker`;
  const appURL = new URL(url);
  appURL.username = appName;
  appURL.password = appPassword;
  process.env.DATABASE_URL = appURL.href;
  process.env.APP_URL = 'http://127.0.0.1:3000';
  process.env.BETTER_AUTH_SECRET = randomBytes(32).toString('hex');
  Object.assign(process.env, { NODE_ENV: 'test' });
  let applicationPool: Pool | undefined;
  let worker: Pool | undefined;
  try {
    const { migrate } = await import('../scripts/migrate');
    const { createOwnerAccount, recoverOwnerAccount } = await import('../scripts/owner');
    const { requireOwner } = await import('../src/server/authorize');
    const { pool } = await import('../src/server/db');
    applicationPool = pool;
    await migrate(database, { roles: { appPassword, workerPassword, appName, workerName } });
    await migrate(database, { roles: { appPassword, workerPassword, appName, workerName } });
    const { POST } = await import('../src/app/api/auth/[...all]/route');
    const { GET } = await import('../src/app/api/auth/status/route');
    const jars = new Map<string, Map<string, string>>();
    const cookieHeaders = (jar: string) => new Headers({ cookie: [...(jars.get(jar) ?? [])].map(([key, value]) => `${key}=${value}`).join('; ') });
    let ipCounter = 1;
    async function post(jar: string, path: string, body: object, origin = process.env.APP_URL!) {
      const headers = cookieHeaders(jar);
      headers.set('origin', origin);
      headers.set('content-type', 'application/json');
      headers.set('x-forwarded-for', `203.0.113.${ipCounter++}`);
      const response = await POST(new Request(`${process.env.APP_URL}/api/auth${path}`, { method: 'POST', headers, body: JSON.stringify(body) }));
      const cookies = jars.get(jar) ?? new Map<string, string>();
      for (const cookie of response.headers.getSetCookie()) {
        const part = cookie.split(';', 1)[0];
        const index = part.indexOf('=');
        cookies.set(part.slice(0, index), part.slice(index + 1));
      }
      jars.set(jar, cookies);
      return { status: response.status, data: await response.json() as Record<string, unknown>, headers: response.headers };
    }
    const status = async (jar: string) => (await GET(new Request(`${process.env.APP_URL}/api/auth/status`, { headers: cookieHeaders(jar) }))).json();
    assert.equal((await status('a')).state, 'unconfigured');
    const password = randomBytes(24).toString('base64url');
    const id = await createOwnerAccount(database, 'owner@example.test', password);
    await assert.rejects(createOwnerAccount(database, 'other@example.test', password));
    assert.equal((await database.query('SELECT count(*)::int AS count FROM "user"')).rows[0].count, 1);
    assert.equal((await post('a', '/sign-up/email', { email: 'other@example.test', password })).status, 404);
    assert.equal((await post('a', '/sign-in/email', { email: 'owner@example.test', password }, 'https://attacker.example')).status, 403);
    await assert.rejects(requireOwner(cookieHeaders('a')), { status: 401 });
    const firstLogin = await post('a', '/sign-in/email', { email: 'owner@example.test', password });
    assert.equal(firstLogin.status, 200, JSON.stringify(firstLogin.data));
    assert.equal(firstLogin.data.token, undefined);
    assert.equal((await status('a')).state, 'setup-mfa');
    await assert.rejects(requireOwner(cookieHeaders('a')), { code: 'MFA_REQUIRED' });
    assert.equal((await post('b', '/sign-in/email', { email: 'owner@example.test', password })).status, 200);
    const setup = await post('a', '/two-factor/enable', { password });
    assert.equal(setup.status, 200, JSON.stringify(setup.data));
    const uri = setup.data.totpURI as string;
    const backupCodes = setup.data.backupCodes as string[];
    assert.equal(backupCodes.length, 10);
    assert.equal((await post('a', '/two-factor/verify-totp', { code: 'not-a-code' })).status, 401);
    const verify = await post('a', '/two-factor/verify-totp', { code: totp(uri), trustDevice: false });
    assert.equal(verify.status, 200, JSON.stringify(verify.data));
    assert.equal(verify.data.token, undefined);
    assert.equal((await status('a')).state, 'ready');
    assert.deepEqual(await requireOwner(cookieHeaders('a')), { id });
    await assert.rejects(requireOwner(cookieHeaders('b')), { code: 'MFA_REQUIRED' });
    assert.equal((await post('b', '/two-factor/verify-totp', { code: totp(uri) })).status, 401);
    assert.equal((await post('a', '/two-factor/disable', { password })).status, 404);
    await post('a', '/sign-out', {});
    await assert.rejects(requireOwner(cookieHeaders('a')), { status: 401 });
    const challenge = await post('a', '/sign-in/email', { email: 'owner@example.test', password });
    assert.equal(challenge.status, 200);
    assert.equal(challenge.data.twoFactorRedirect, true);
    await assert.rejects(requireOwner(cookieHeaders('a')), { status: 401 });
    jars.set('replay', new Map(jars.get('a')));
    assert.equal((await post('a', '/two-factor/verify-totp', { code: totp(uri), trustDevice: true })).status, 400);
    assert.equal((await post('a', '/two-factor/verify-totp', { code: totp(uri) })).status, 200);
    assert.equal((await post('replay', '/two-factor/verify-totp', { code: totp(uri) })).status, 401);
    await database.query("UPDATE auth_session_assurance SET last_seen_at = now() - interval '3 hours'");
    await assert.rejects(requireOwner(cookieHeaders('a')), { code: 'MFA_REQUIRED' });
    assert.equal((await post('a', '/two-factor/verify-totp', { code: totp(uri) })).status, 401);
    await post('a', '/sign-out', {});
    await post('a', '/sign-in/email', { email: 'owner@example.test', password });
    assert.equal((await post('a', '/two-factor/verify-backup-code', { code: backupCodes[0] })).status, 200);
    assert.deepEqual(await requireOwner(cookieHeaders('a')), { id });
    await post('a', '/sign-out', {});
    await post('a', '/sign-in/email', { email: 'owner@example.test', password });
    assert.equal((await post('a', '/two-factor/verify-backup-code', { code: backupCodes[0] })).status, 401);
    assert.equal((await post('a', '/two-factor/verify-backup-code', { code: backupCodes[1] })).status, 200);
    const workerURL = new URL(url);
    workerURL.username = workerName;
    workerURL.password = workerPassword;
    worker = new Pool({ connectionString: workerURL.href, max: 1 });
    assert.equal((await worker.query("SELECT value FROM app_settings WHERE key = 'owner'")).rowCount, 0);
    await assert.rejects(worker.query('SELECT * FROM "user"'), { code: '42501' });
    await assert.rejects(pool.query("UPDATE app_settings SET value = '{}' WHERE key = 'owner'").then((result) => {
      if (!result.rowCount) throw new Error('blocked');
    }));
    await assert.rejects(pool.query('CREATE TABLE forbidden_test (id integer)'), { code: '42501' });
    const newPassword = randomBytes(24).toString('base64url');
    await recoverOwnerAccount(database, newPassword);
    await assert.rejects(requireOwner(cookieHeaders('a')), { status: 401 });
    assert.equal((await post('a', '/sign-in/email', { email: 'owner@example.test', password })).status, 401);
    assert.equal((await post('a', '/sign-in/email', { email: 'owner@example.test', password: newPassword })).status, 200);
    assert.equal((await status('a')).state, 'setup-mfa');
    assert.equal((await database.query('SELECT count(*)::int AS count FROM auth_admin_audit')).rows[0].count, 2);
  } finally {
    await worker?.end();
    await applicationPool?.end();
    await database.end();
    await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
    await admin.query(`DROP ROLE IF EXISTS "${appName}", "${workerName}"`);
    await admin.end();
  }
});
