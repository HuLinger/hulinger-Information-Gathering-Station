import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('Caddy authorizes every file response, strips forged headers and streams Range bytes', { skip: !process.env.CADDY_BINARY, timeout: 30000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'hulinger-caddy-'));
  const id = '7ed071be-a39a-4c99-91de-34f7d951a610';
  const bytes = Buffer.from('private-drive-content-'.repeat(5000));
  const etag = '"immutable-fixture-sha256"';
  await writeFile(path.join(directory, `${id}.bin`), bytes);
  let authChecks = 0;
  const upstream = createServer(async (request, response) => {
    if (request.url === '/api/drive/authorize-download') {
      authChecks++;
      assert.equal(request.headers['x-drive-storage-key'], undefined);
      assert.equal(request.headers['x-drive-etag'], undefined);
      assert.match(String(request.headers['x-forwarded-uri']), new RegExp(`^/api/drive/files/${id}/content$`));
      assert.ok(['GET', 'HEAD'].includes(String(request.headers['x-forwarded-method'])));
      if (request.headers.cookie === 'fixture=owner') {
        response.writeHead(200, { 'X-Drive-Storage-Key': `${id}.bin`, 'X-Drive-Disposition': "attachment; filename*=UTF-8''fixture.bin", 'X-Drive-ETag': etag });
      } else if (request.headers.cookie === 'fixture=missing-header') {
        response.writeHead(200);
      } else if (request.headers.cookie === 'fixture=bad-key') {
        response.writeHead(200, { 'X-Drive-Storage-Key': '../private.txt' });
      } else {
        response.writeHead(401);
      }
      response.end();
      return;
    }
    let length = 0;
    try {
      for await (const chunk of request) length += chunk.length;
      response.writeHead(200, { 'Content-Type': 'text/plain' });
      response.end(String(length));
    } catch {
      response.destroy();
    }
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const upstreamPort = (upstream.address() as { port: number }).port;
  const portReservation = createServer();
  portReservation.listen(0, '127.0.0.1');
  await once(portReservation, 'listening');
  const caddyPort = (portReservation.address() as { port: number }).port;
  await new Promise<void>((resolve) => portReservation.close(() => resolve()));
  const config = (await readFile('Caddyfile', 'utf8'))
    .replaceAll('web:3000', `127.0.0.1:${upstreamPort}`)
    .replace('/data/drive/objects', directory.replaceAll('\\', '/'));
  const configPath = path.join(directory, 'Caddyfile');
  await writeFile(configPath, config);
  let logs = '';
  const caddy = spawn(process.env.CADDY_BINARY!, ['run', '--config', configPath, '--adapter', 'caddyfile'], {
    env: { ...process.env, SITE_DOMAIN: `http://127.0.0.1:${caddyPort}` }, windowsHide: true,
  });
  caddy.stdout.on('data', (data) => { logs += data; });
  caddy.stderr.on('data', (data) => { logs += data; });
  const base = `http://127.0.0.1:${caddyPort}`;
  const url = `${base}/api/drive/files/${id}/content`;
  const headers = { Cookie: 'fixture=owner', 'Accept-Encoding': 'gzip', 'X-Drive-Storage-Key': 'forged.bin', 'X-Drive-ETag': '"forged"' };
  try {
    let listening = false;
    for (let attempt = 0; attempt < 50; attempt++) {
      try { await fetch(base); listening = true; break; } catch { await new Promise((resolve) => setTimeout(resolve, 50)); }
    }
    assert.ok(listening, logs);
    assert.equal((await fetch(url, { headers: { 'X-Drive-Storage-Key': `${id}.bin` } })).status, 401);
    for (const fixture of ['missing-header', 'bad-key']) {
      assert.equal((await fetch(url, { headers: { ...headers, Cookie: `fixture=${fixture}` } })).status, 403);
    }
    const full = await fetch(url, { headers });
    assert.equal(full.status, 200);
    assert.equal(full.headers.get('content-encoding'), null);
    assert.equal(full.headers.get('cache-control'), 'private, no-store');
    assert.equal(full.headers.get('content-type'), 'application/octet-stream');
    assert.match(full.headers.get('content-disposition')!, /^attachment;/);
    assert.equal(full.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(full.headers.get('etag'), etag);
    assert.deepEqual(Buffer.from(await full.arrayBuffer()), bytes);
    const range = await fetch(url, { headers: { ...headers, Range: 'bytes=5-19', 'If-Range': etag } });
    assert.equal(range.status, 206);
    assert.equal(range.headers.get('content-range'), `bytes 5-19/${bytes.length}`);
    assert.deepEqual(Buffer.from(await range.arrayBuffer()), bytes.subarray(5, 20));
    const stale = await fetch(url, { headers: { ...headers, Range: 'bytes=5-19', 'If-Range': '"old-version"' } });
    assert.equal(stale.status, 200);
    assert.deepEqual(Buffer.from(await stale.arrayBuffer()), bytes);
    const head = await fetch(url, { method: 'HEAD', headers });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('content-length'), String(bytes.length));
    assert.equal((await head.arrayBuffer()).byteLength, 0);
    assert.equal((await fetch(url, { headers: { ...headers, Range: 'bytes=99999999-' } })).status, 416);
    assert.equal(authChecks, 8);
    const body = Buffer.alloc(2 * 1024 * 1024, 1);
    const upload = await fetch(`${base}/api/drive/uploads/${id}/parts/0`, { method: 'PUT', body });
    assert.equal(upload.status, 200);
    assert.equal(await upload.text(), String(body.length));
    assert.equal((await fetch(`${base}/api/hub`, { method: 'POST', body })).status, 413);
    assert.equal((await fetch(`${base}/api/drive/uploads/${id}/parts/0`, { method: 'PUT', body: Buffer.alloc(34 * 1024 * 1024, 1) })).status, 413);
  } finally {
    caddy.kill();
    await once(caddy, 'exit');
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
