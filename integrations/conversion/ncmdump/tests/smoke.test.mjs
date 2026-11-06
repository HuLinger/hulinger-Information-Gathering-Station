import assert from 'node:assert/strict';
import { createCipheriv } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const projectDirectory = fileURLToPath(new URL('../', import.meta.url));
const scratch = await mkdtemp(join(tmpdir(), 'hulinger-ncm-smoke-'));
const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const freePortServer = createServer();
await listen(freePortServer);
const gatewayPort = freePortServer.address().port;
await new Promise((resolve) => freePortServer.close(resolve));
const base = `http://127.0.0.1:${gatewayPort}`;
let coverRequests = 0;
const coverServer = createServer((_, response) => {
  coverRequests += 1;
  response.end('cover');
});
await listen(coverServer);
let child;
let diagnostics = '';

before(async () => {
  child = spawn(process.env.NCM_DOTNET ?? 'dotnet', [
    join(projectDirectory, 'bin', 'Release', 'net10.0', 'NcmGateway.dll'), '--urls', base,
  ], {
    cwd: projectDirectory,
    windowsHide: true,
    env: { ...process.env, NCM_TEMP_ROOT: scratch, NCM_MAX_FILE_BYTES: '4096', NCM_TIMEOUT_SECONDS: '2' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => { diagnostics += chunk; });
  child.stderr.on('data', (chunk) => { diagnostics += chunk; });
  for (let count = 0; count < 100; count += 1) {
    if (child.exitCode !== null) throw new Error(`Gateway exited: ${diagnostics}`);
    try { if ((await fetch(`${base}/health`)).ok) return; } catch { /* startup */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Gateway did not start: ${diagnostics}`);
});

after(async () => {
  if (child && child.exitCode === null) {
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill();
    await exited;
  }
  await new Promise((resolve) => coverServer.close(resolve));
  await rm(scratch, { recursive: true, force: true });
});

function uint32(value) {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(value);
  return bytes;
}

function encrypt(key, value) {
  const cipher = createCipheriv('aes-128-ecb', key, null);
  return Buffer.concat([cipher.update(value), cipher.final()]);
}

// Independently construct synthetic containers with Node's AES implementation.
function ncm(audio, metadata) {
  const key = Buffer.from(Array.from({ length: 16 }, (_, index) => index + 1));
  const encryptedKey = encrypt(Buffer.from('hzHRAmso5kInbaxW'), Buffer.concat([Buffer.from('neteasecloudmusic'), key]));
  const maskedKey = encryptedKey.map((byte) => byte ^ 0x64);
  const keyBox = Uint8Array.from({ length: 256 }, (_, index) => index);
  let last = 0;
  for (let index = 0; index < 256; index += 1) {
    const current = keyBox[index];
    const swapIndex = (current + last + key[index % key.length]) & 0xff;
    keyBox[index] = keyBox[swapIndex];
    keyBox[swapIndex] = current;
    last = swapIndex;
  }
  const payload = Buffer.from(audio);
  for (let index = 0; index < payload.length; index += 1) {
    const value = (index + 1) & 0xff;
    payload[index] ^= keyBox[(keyBox[value] + keyBox[(keyBox[value] + value) & 0xff]) & 0xff];
  }
  const metadataBytes = metadata ? Buffer.from(`163 key(Don't modify):${encrypt(
    Buffer.from([0x23, 0x31, 0x34, 0x6c, 0x6a, 0x6b, 0x5f, 0x21, 0x5c, 0x5d, 0x26, 0x30, 0x55, 0x3c, 0x27, 0x28]),
    Buffer.from(`music:${JSON.stringify(metadata)}`),
  ).toString('base64')}`).map((byte) => byte ^ 0x63) : Buffer.alloc(0);
  return Buffer.concat([
    Buffer.from('CTENFDAM'), Buffer.alloc(2), uint32(maskedKey.length), maskedKey,
    uint32(metadataBytes.length), metadataBytes, Buffer.alloc(13), payload,
  ]);
}

function minimalFlac() {
  const info = Buffer.alloc(34);
  info.writeUInt16BE(16, 0);
  info.writeUInt16BE(4096, 2);
  info.writeBigUInt64BE((44100n << 44n) | (1n << 41n) | (15n << 36n), 10);
  return Buffer.concat([Buffer.from('fLaC'), Buffer.from([0x80, 0, 0, 34]), info]);
}

async function upload(bytes, name = '测试.ncm', extra) {
  const form = new FormData();
  form.append('file', new Blob([bytes]), name);
  if (extra) form.append(extra, 'http://127.0.0.1/private');
  return fetch(`${base}/convert`, { method: 'POST', body: form });
}

async function assertError(response, status, code) {
  assert.equal(response.status, status);
  assert.deepEqual(Object.keys(await response.clone().json()).sort(), ['code', 'message']);
  assert.equal((await response.json()).code, code);
}

async function assertClean() {
  for (let count = 0; count < 20; count += 1) {
    if ((await readdir(scratch)).length === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.deepEqual(await readdir(scratch), []);
}

test('health and exact synthetic MP3/FLAC bytes with safe download names', async () => {
  assert.deepEqual(await (await fetch(`${base}/health`)).json(), { status: 'ok' });
  for (const [audio, mime, extension] of [
    [Buffer.from('ID3\x04\x00\x00\x00\x00\x00\x00synthetic-audio'), 'audio/mpeg', 'mp3'],
    [minimalFlac(), 'audio/flac', 'flac'],
  ]) {
    const response = await upload(ncm(audio), '..\\private/测试.ncm');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), mime);
    assert.match(response.headers.get('content-disposition'), new RegExp(`\\.${extension}`));
    assert.doesNotMatch(response.headers.get('content-disposition'), /private|\.\./);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), audio);
    await assertClean();
  }
});

test('metadata cover URL is never fetched', async () => {
  const response = await upload(ncm(minimalFlac(), {
    musicName: 'Synthetic song', album: 'Synthetic album', artist: [['Tester']], format: 'flac',
    albumPic: `http://127.0.0.1:${coverServer.address().port}/cover`,
  }));
  assert.equal(response.status, 200);
  assert.equal(Buffer.from(await response.arrayBuffer()).subarray(0, 4).toString(), 'fLaC');
  assert.equal(coverRequests, 0);
  await assertClean();
});

test('corrupt, empty, unsupported, oversized, and extra-input requests fail and clean up', async () => {
  await assertError(await upload(Buffer.from('not-ncm')), 422, 'INVALID_NCM');
  await assertError(await upload(Buffer.alloc(0)), 422, 'EMPTY_FILE');
  await assertError(await upload(Buffer.from('hello'), 'hello.mp3'), 415, 'UNSUPPORTED_FILE');
  await assertError(await upload(Buffer.alloc(5000)), 413, 'FILE_TOO_LARGE');
  await assertError(await upload(Buffer.alloc(100_000)), 413, 'FILE_TOO_LARGE');
  await assertError(await upload(ncm(minimalFlac()), 'file.ncm', 'url'), 400, 'INVALID_REQUEST');
  await assertError(await fetch(`${base}/convert?path=/etc/passwd`, { method: 'POST' }), 400, 'INVALID_REQUEST');
  await assertError(await fetch(`${base}/convert`, { method: 'POST', body: '{}' }), 415, 'INVALID_CONTENT_TYPE');
  await assertClean();
});

test('oversized embedded cover lengths are rejected before allocation', async () => {
  const bytes = ncm(minimalFlac());
  const keyLength = bytes.readUInt32LE(10);
  const coverOffset = 14 + keyLength + 4 + 5;
  bytes.writeUInt32LE(0x7fffffff, coverOffset);
  bytes.writeUInt32LE(0x7fffffff, coverOffset + 4);
  await assertError(await upload(bytes), 422, 'INVALID_NCM');
  await assertClean();
});

test('a slow request times out, concurrent conversion receives 429, and files are removed', async () => {
  const boundary = 'ncm-smoke-slow';
  let bodyController;
  const body = new ReadableStream({
    start(controller) {
      bodyController = controller;
      controller.enqueue(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="slow.ncm"\r\n\r\nCTENFDAM`));
    },
  });
  const pending = fetch(`${base}/convert`, {
    method: 'POST', headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` }, body, duplex: 'half',
  });
  for (let count = 0; count < 20 && (await readdir(scratch)).length === 0; count += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  await assertError(await upload(ncm(minimalFlac())), 429, 'CONVERTER_BUSY');
  await assertError(await pending, 504, 'CONVERSION_TIMEOUT');
  try { bodyController.close(); } catch { /* fetch has already closed the upload */ }
  await assertClean();
});
