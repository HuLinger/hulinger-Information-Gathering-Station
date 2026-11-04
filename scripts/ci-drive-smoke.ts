import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import pg from 'pg';
import { createOwnerAccount } from './owner';

// This creates a synthetic owner, so it must never run against an existing deployment.
if (process.env.CI !== 'true' || process.env.APP_URL !== 'https://hub.example.test'
  || new URL(process.env.DATABASE_URL ?? 'http://invalid').hostname !== 'db') {
  throw new Error('The HTTP smoke test requires the isolated CI Compose database and example origin.');
}
const database = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const jars = new Map<string, string>();
const origin = process.env.APP_URL;
const password = randomBytes(32).toString('base64url');
const email = 'synthetic-ci@example.test';
const cookie = () => [...jars].map(([key, value]) => `${key}=${value}`).join('; ');

async function request(route: string, init: RequestInit = {}, proxy = false, authenticated = true) {
  const headers = new Headers(init.headers);
  headers.set('Origin', origin);
  if (authenticated && !headers.has('Cookie')) headers.set('Cookie', cookie());
  const response = await fetch(`${proxy ? 'http://hub.example.test' : 'http://web:3000'}${route}`, {
    ...init, headers, redirect: 'manual', signal: AbortSignal.timeout(30000),
  });
  for (const setCookie of response.headers.getSetCookie()) {
    const pair = setCookie.split(';', 1)[0];
    const equals = pair.indexOf('=');
    if (/;\s*Max-Age=0(?:;|$)/i.test(setCookie)) jars.delete(pair.slice(0, equals));
    else jars.set(pair.slice(0, equals), pair.slice(equals + 1));
  }
  return response;
}
async function json(route: string, body: unknown, label: string) {
  const response = await request(route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal(response.status, 200, `${label}: HTTP status differs`);
  return response.json() as Promise<Record<string, unknown>>;
}
async function status(route: string, expected: number, init: RequestInit = {}, proxy = false, authenticated = true) {
  const response = await request(route, init, proxy, authenticated);
  await response.arrayBuffer();
  assert.equal(response.status, expected, `${route}: HTTP status differs`);
}
function totp(uri: string) {
  const encoded = new URL(uri).searchParams.get('secret')!;
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const bits = [...encoded.replace(/=+$/, '').toUpperCase()].map((value) => alphabet.indexOf(value).toString(2).padStart(5, '0')).join('');
  const key = Buffer.from((bits.match(/.{8}/g) ?? []).map((value) => Number.parseInt(value, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const digest = createHmac('sha1', key).update(counter).digest();
  return String((digest.readUInt32BE(digest[digest.length - 1] & 15) & 0x7fffffff) % 1000000).padStart(6, '0');
}
async function streamDigest(response: Response) {
  const hash = createHash('sha256');
  assert.ok(response.body);
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      hash.update(value);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  return hash.digest('hex');
}

try {
  const proxyHealth = await request('/api/health', {}, true, false);
  assert.equal(proxyHealth.status, 200);
  assert.equal((await proxyHealth.json() as { status: string }).status, 'ok');
  await status('/api/drive', 401, {}, false, false);
  await createOwnerAccount(database, email, password, 'Synthetic CI owner');
  await json('/api/auth/sign-in/email', { email, password }, 'sign in');
  await status('/api/drive', 403);
  const setup = await json('/api/auth/two-factor/enable', { password }, 'MFA setup');
  assert.equal(typeof setup.totpURI, 'string');
  await json('/api/auth/two-factor/verify-totp', { code: totp(setup.totpURI as string), trustDevice: false }, 'MFA verify');
  await status('/api/drive', 200);

  const first = Buffer.alloc(16 * 1024 * 1024, 0x73);
  const tail = Buffer.from('Synthetic final chunk / 合成尾片\n'.repeat(257));
  const expectedHash = createHash('sha256').update(first).update(tail).digest('hex');
  const created = await json('/api/drive/uploads', {
    name: 'CI 合成大文件.bin', size: first.length + tail.length, lastModified: 0, fingerprint: expectedHash,
  }, 'create upload') as { file: { id: string; chunkSize: number } };
  assert.equal(created.file.chunkSize, first.length);
  const id = created.file.id;
  const content = `/api/drive/files/${id}/content`;
  await status(content, 404, {}, true);
  await Promise.all([first, tail].map(async (body, index) => {
    const response = await request(`/api/drive/uploads/${id}/parts/${index}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', 'X-Chunk-SHA256': createHash('sha256').update(body).digest('hex') }, body,
    }, true);
    assert.equal(response.status, 200, `upload part ${index}: HTTP status differs`);
    await response.arrayBuffer();
  }));
  await json(`/api/drive/uploads/${id}/complete`, {}, 'complete upload');
  for (const proxy of [false, true]) {
    const full = await request(content, { headers: { 'Accept-Encoding': 'gzip', 'X-Drive-Storage-Key': '../../forged.bin' } }, proxy);
    assert.equal(full.status, 200);
    assert.equal(full.headers.get('content-type'), 'application/octet-stream');
    assert.equal(full.headers.get('content-encoding'), null);
    assert.equal(full.headers.get('cache-control'), 'private, no-store');
    assert.match(full.headers.get('content-disposition')!, /^attachment;/);
    assert.equal(await streamDigest(full), expectedHash);
    const etag = full.headers.get('etag')!;
    const head = await request(content, { method: 'HEAD' }, proxy);
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('content-length'), String(first.length + tail.length));
    assert.equal((await head.arrayBuffer()).byteLength, 0);
    const range = await request(content, { headers: { Range: `bytes=${first.length - 16}-${first.length + 15}`, 'If-Range': etag } }, proxy);
    assert.equal(range.status, 206);
    assert.deepEqual(Buffer.from(await range.arrayBuffer()), Buffer.concat([first.subarray(-16), tail.subarray(0, 16)]));
  }
  await status(content, 401, { headers: { 'X-Drive-Storage-Key': `${id}.bin` } }, true, false);
  await json(`/api/drive/files/${id}`, { action: 'trash' }, 'trash file');
  await status(content, 404, {}, true);
  await json(`/api/drive/files/${id}`, { action: 'restore' }, 'restore file');
  await status(content, 200, { method: 'HEAD' }, true);
  await json(`/api/drive/files/${id}`, { action: 'trash' }, 'trash before purge');
  await json(`/api/drive/files/${id}`, { action: 'purge', confirm: true }, 'purge file');
  assert.equal((await database.query('SELECT id FROM drive_files WHERE id=$1', [id])).rowCount, 0);
  const staleCookie = cookie();
  await json('/api/auth/sign-out', {}, 'sign out');
  await status(content, 401, { headers: { Cookie: staleCookie } }, true);
  console.log('HTTP owner/MFA, parallel 16 MiB upload, Caddy and application downloads, Range/HEAD, lifecycle and revoked-session checks passed.');
} finally {
  await database.end();
}
