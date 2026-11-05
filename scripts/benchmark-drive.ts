import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createReadStream } from 'node:fs';
import { lstat, mkdtemp, readFile, readdir, realpath, rmdir, statfs, unlink, writeFile } from 'node:fs/promises';
import { Agent, createServer, request as httpRequest, type IncomingMessage, type Server } from 'node:http';
import { cpus, release, tmpdir, totalmem, version } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import type { DriveFile } from '../src/shared/drive-contracts';
import { DriveStore } from '../src/server/drive/store';
import { parseByteRange } from '../src/server/drive/validation';

const MiB = 1024 ** 2;
const chunkBytes = 16 * MiB;
const streamBytes = 256 * 1024;
const temporaryPrefix = 'hulinger-drive-benchmark-';
const owner = 'synthetic-drive-benchmark-owner';

function options(args: string[]) {
  let sizeMiB = 512; let parallel = 4;
  for (let index = 0; index < args.length; index++) {
    const [name, inline] = args[index].split('=', 2);
    if (name === '--help') return null;
    if (!['--size-mib', '--parallel'].includes(name)) throw new Error(`Unknown option: ${name}`);
    const raw = inline ?? args[++index];
    if (!/^\d+$/.test(raw ?? '')) throw new Error(`${name} requires an integer.`);
    const value = Number(raw);
    if (name === '--size-mib') sizeMiB = value; else parallel = value;
  }
  if (!Number.isSafeInteger(sizeMiB) || sizeMiB < 1 || sizeMiB > 65536) throw new Error('--size-mib must be 1–65536 (maximum 64 GiB).');
  if (!Number.isSafeInteger(parallel) || parallel < 1 || parallel > 8) throw new Error('--parallel must be 1–8.');
  return { sizeMiB, parallel };
}

function samePath(left: string, right: string) { return process.platform === 'win32' ? resolve(left).toLowerCase() === resolve(right).toLowerCase() : resolve(left) === resolve(right); }
function digest(bytes: Uint8Array) { return createHash('sha256').update(bytes).digest('hex'); }
function headerList(incoming: IncomingMessage) {
  const headers = new Headers();
  for (const [key, value] of Object.entries(incoming.headers)) {
    if (Array.isArray(value)) for (const item of value) headers.append(key, item);
    else if (value !== undefined) headers.set(key, value);
  }
  return headers;
}

async function parallelParts(count: number, parallel: number, signal: AbortSignal, work: (index: number, signal: AbortSignal) => Promise<void>) {
  const failed = new AbortController();
  const combined = AbortSignal.any([signal, failed.signal]);
  let next = 0; let firstError: unknown;
  await Promise.all(Array.from({ length: Math.min(count, parallel) }, async () => {
    try {
      while (!combined.aborted) {
        const index = next++;
        if (index >= count) return;
        await work(index, combined);
      }
    } catch (error) { firstError ??= error; failed.abort(); }
  }));
  if (firstError) throw firstError;
  signal.throwIfAborted();
}

interface StageResult { seconds: number; bytes: number; mibPerSecond: number; rssBeforeMiB: number; peakRssMiB: number; peakExternalMiB: number; samples: number }
async function measure(bytes: number, work: () => Promise<void>): Promise<StageResult> {
  const before = process.memoryUsage();
  let peakRss = before.rss; let peakExternal = before.external; let samples = 0;
  const sample = () => { const memory = process.memoryUsage(); peakRss = Math.max(peakRss, memory.rss); peakExternal = Math.max(peakExternal, memory.external); samples++; };
  const timer = setInterval(sample, 20);
  const start = performance.now();
  try { await work(); }
  finally { clearInterval(timer); sample(); }
  const seconds = (performance.now() - start) / 1000;
  return { seconds, bytes, mibPerSecond: bytes / MiB / seconds, rssBeforeMiB: before.rss / MiB, peakRssMiB: peakRss / MiB, peakExternalMiB: peakExternal / MiB, samples };
}

async function putPart(url: URL, bytes: Buffer, hash: string, agent: Agent, signal: AbortSignal) {
  const request = httpRequest(url, { method: 'PUT', agent, signal, headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': bytes.length, 'X-Chunk-SHA256': hash } });
  request.setTimeout(15 * 60_000, () => request.destroy(new Error('Synthetic upload timed out.')));
  const responsePromise = new Promise<IncomingMessage>((resolveResponse, reject) => { request.once('response', resolveResponse); request.once('error', reject); });
  void responsePromise.catch(() => {});
  try {
    // Respect socket backpressure; only one fixed-size generated part is retained per worker.
    for (let offset = 0; offset < bytes.length; offset += 64 * 1024) {
      signal.throwIfAborted();
      if (!request.write(bytes.subarray(offset, Math.min(bytes.length, offset + 64 * 1024)))) await once(request, 'drain', { signal });
    }
    request.end();
    const response = await responsePromise;
    let body = '';
    for await (const piece of response) {
      body += Buffer.from(piece).toString('utf8');
      if (body.length > 65536) { response.destroy(); throw new Error('Unexpectedly large upload acknowledgement.'); }
    }
    if (response.statusCode !== 200) throw new Error(`Synthetic upload failed with HTTP ${response.statusCode}.`);
    const result = JSON.parse(body) as { ok?: boolean; index?: number };
    assert.equal(result.ok, true); assert.equal(result.index, Number(url.pathname.split('/').at(-1)));
  } catch (error) { request.destroy(); await responsePromise.catch(() => {}); throw error; }
}

async function readPart(url: URL, file: DriveFile, index: number, expected: string, agent: Agent, signal: AbortSignal) {
  const start = index * chunkBytes;
  const end = Math.min(file.size, start + chunkBytes) - 1;
  const request = httpRequest(url, { agent, signal, headers: { Range: `bytes=${start}-${end}`, 'If-Range': file.etag } });
  request.setTimeout(15 * 60_000, () => request.destroy(new Error('Synthetic download timed out.')));
  const responsePromise = new Promise<IncomingMessage>((resolveResponse, reject) => { request.once('response', resolveResponse); request.once('error', reject); });
  request.end();
  const response = await responsePromise;
  try {
    assert.equal(response.statusCode, 206);
    assert.equal(response.headers['content-range'], `bytes ${start}-${end}/${file.size}`);
    assert.equal(response.headers.etag, file.etag);
    assert.equal(response.headers['content-length'], String(end - start + 1));
    const hash = createHash('sha256'); let received = 0;
    for await (const bytes of response) {
      signal.throwIfAborted();
      received += bytes.length;
      assert.ok(received <= end - start + 1, 'Response exceeded the requested range');
      hash.update(bytes);
    }
    assert.equal(received, end - start + 1);
    assert.equal(hash.digest('hex'), expected, `SHA-256 mismatch for part ${index}`);
  } finally { response.destroy(); }
}

async function cleanupTemporary(directory: string, parent: string, marker: string) {
  const resolved = await realpath(directory);
  assert.ok(samePath(resolved, directory), 'Temporary directory changed location');
  assert.ok(samePath(dirname(resolved), parent), 'Temporary directory escaped its verified parent');
  assert.match(basename(resolved), /^hulinger-drive-benchmark-[A-Za-z0-9]+$/);
  const root = await lstat(resolved);
  assert.ok(root.isDirectory() && !root.isSymbolicLink());
  const markerPath = join(resolved, '.benchmark-owner');
  const markerStat = await lstat(markerPath);
  assert.ok(markerStat.isFile() && !markerStat.isSymbolicLink() && markerStat.nlink === 1);
  assert.equal(await readFile(markerPath, 'utf8'), marker);
  const objects = join(resolved, 'objects');
  const objectStat = await lstat(objects).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
  if (objectStat) {
    assert.ok(objectStat.isDirectory() && !objectStat.isSymbolicLink());
    assert.ok(samePath(await realpath(objects), objects));
    const entries = await readdir(objects, { withFileTypes: true });
    for (const entry of entries) {
      assert.match(entry.name, /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.bin$/);
      const objectPath = join(objects, entry.name);
      const object = await lstat(objectPath);
      assert.ok(object.isFile() && !object.isSymbolicLink() && object.nlink === 1, 'Refusing to remove an unexpected object');
      await unlink(objectPath);
    }
    await rmdir(objects);
  }
  assert.deepEqual((await readdir(resolved)).sort(), ['.benchmark-owner']);
  await unlink(markerPath);
  await rmdir(resolved);
}

async function closeServer(server: Server | undefined) {
  if (!server?.listening) return;
  const closing = new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  server.closeAllConnections();
  await closing;
}

async function main() {
  const config = options(process.argv.slice(2));
  if (!config) {
    process.stdout.write('Usage: npx tsx scripts/benchmark-drive.ts [--size-mib 512] [--parallel 4]\nRequires TEST_DATABASE_URL or AUTH_TEST_DATABASE_URL for a local *_test PostgreSQL administrator database. Only generated data is used.\n');
    return;
  }
  if (process.env.NODE_ENV === 'production') throw new Error('Refusing to run a synthetic benchmark with NODE_ENV=production.');
  const adminString = process.env.TEST_DATABASE_URL ?? process.env.AUTH_TEST_DATABASE_URL;
  if (!adminString) throw new Error('Set TEST_DATABASE_URL or AUTH_TEST_DATABASE_URL explicitly; DATABASE_URL and .env are not used.');
  const adminUrl = new URL(adminString);
  if (!['postgres:', 'postgresql:'].includes(adminUrl.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(adminUrl.hostname) || !/^\/[A-Za-z0-9_]+_test$/.test(adminUrl.pathname)) throw new Error('The benchmark administrator must point to a loopback PostgreSQL *_test database.');
  const databaseName = `drive_benchmark_${randomUUID().replaceAll('-', '')}_test`;
  assert.match(databaseName, /^drive_benchmark_[a-f0-9]{32}_test$/);
  const isolatedUrl = new URL(adminUrl); isolatedUrl.pathname = `/${databaseName}`;
  const size = config.sizeMiB * MiB;
  const count = Math.ceil(size / chunkBytes);
  const admin = new Pool({ connectionString: adminUrl.href, max: 2, connectionTimeoutMillis: 5000 });
  const database = new Pool({ connectionString: isolatedUrl.href, max: 4, connectionTimeoutMillis: 5000 });
  const uploadDatabase = new Pool({ connectionString: isolatedUrl.href, max: config.parallel, connectionTimeoutMillis: 5000 });
  const agent = new Agent({ keepAlive: true, maxSockets: config.parallel });
  const temporaryParent = await realpath(tmpdir());
  const directory = await mkdtemp(join(temporaryParent, temporaryPrefix));
  const marker = randomUUID();
  await writeFile(join(directory, '.benchmark-owner'), marker, { flag: 'wx', mode: 0o600 });
  let createdDatabase = false;
  let implicitPool: Pool | undefined;
  let server: Server | undefined;
  let report: Record<string, unknown> | undefined;
  const shutdown = new AbortController();
  const stop = () => shutdown.abort(new Error('Synthetic benchmark interrupted.'));
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  const requests = new Set<AbortController>();
  try {
    await admin.query(`CREATE DATABASE "${databaseName}"`); createdDatabase = true;
    Object.assign(process.env, {
      NODE_ENV: 'test', DATABASE_URL: isolatedUrl.href, APP_URL: 'http://127.0.0.1:3000', BETTER_AUTH_SECRET: randomBytes(32).toString('hex'),
      DRIVE_CHUNK_BYTES: String(chunkBytes), DRIVE_MAX_FILE_BYTES: String(size), DRIVE_RESERVE_BYTES: '0', DRIVE_QUOTA_BYTES: '0', DRIVE_MAX_PARALLEL: '8',
    });
    const { migrate } = await import('./migrate');
    implicitPool = (await import('../src/server/db')).pool;
    await migrate(database);
    const postgresVersion = (await database.query<{ server_version: string }>('SHOW server_version')).rows[0].server_version;
    const store = new DriveStore({ database, uploadDatabase, root: directory, config: { chunkSize: chunkBytes, maxFileBytes: size, reserveBytes: 0, quotaBytes: null, maxParallel: 8 } });
    const seed = randomBytes(64 * 1024);
    const hashes = new Array<string>(count);
    let file: DriveFile | undefined;
    let origin = '';
    server = createServer((incoming, outgoing) => {
      const current = new AbortController(); requests.add(current);
      incoming.once('aborted', () => current.abort());
      outgoing.once('close', () => { if (!outgoing.writableFinished) current.abort(); });
      void (async () => {
        if (!file) { outgoing.writeHead(503); outgoing.end(); return; }
        const path = new URL(incoming.url ?? '/', origin).pathname;
        const uploadMatch = new RegExp(`^/drive/${file.id}/parts/(\\d+)$`).exec(path);
        const headers = headerList(incoming);
        if (incoming.method === 'PUT' && uploadMatch) {
          const init: RequestInit & { duplex: 'half' } = { method: 'PUT', headers, body: Readable.toWeb(incoming) as ReadableStream<Uint8Array>, duplex: 'half', signal: current.signal };
          const result = await store.writePart(owner, file.id, Number(uploadMatch[1]), new Request(`${origin}${path}`, init));
          outgoing.writeHead(200, { 'Content-Type': 'application/json' }); outgoing.end(JSON.stringify(result));
        } else if (incoming.method === 'GET' && path === `/drive/${file.id}/content`) {
          const response = await store.download(owner, file.id, new Request(`${origin}${path}`, { headers, signal: current.signal }));
          outgoing.writeHead(response.status, Object.fromEntries(response.headers));
          if (response.body) await pipeline(Readable.fromWeb(response.body as unknown as NodeReadableStream), outgoing);
          else outgoing.end();
        } else if (incoming.method === 'GET' && path === `/direct/${file.id}`) {
          const range = parseByteRange(headers.get('range'), file.size);
          assert.ok(range, 'The baseline requires a bounded Range request');
          outgoing.writeHead(206, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(range.end - range.start + 1), 'Content-Range': `bytes ${range.start}-${range.end}/${file.size}`, ETag: file.etag, 'Cache-Control': 'no-store' });
          await pipeline(createReadStream(join(directory, 'objects', `${file.id}.bin`), { start: range.start, end: range.end, highWaterMark: streamBytes, signal: current.signal }), outgoing);
        } else { outgoing.writeHead(404); outgoing.end(); }
      })().catch(() => {
        if (!outgoing.headersSent) { outgoing.writeHead(500, { 'Content-Type': 'application/json' }); outgoing.end('{"error":"Synthetic benchmark request failed"}'); }
        else outgoing.destroy();
      }).finally(() => requests.delete(current));
    });
    server.requestTimeout = 15 * 60_000;
    await new Promise<void>((resolveListen, reject) => { server!.once('error', reject); server!.listen(0, '127.0.0.1', resolveListen); });
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    origin = `http://127.0.0.1:${address.port}`;
    process.stderr.write(`Synthetic benchmark: ${config.sizeMiB} MiB, ${config.parallel} parallel, 16 MiB parts; loopback only.\n`);
    const upload = await measure(size, async () => {
      file = (await store.createUpload(owner, { name: 'synthetic-benchmark.bin', size, lastModified: 1_700_000_000_000, fingerprint: digest(seed) })).file;
      await parallelParts(count, config.parallel, shutdown.signal, async (index, signal) => {
        const bytes = Buffer.allocUnsafe(Math.min(chunkBytes, size - index * chunkBytes)).fill(seed);
        bytes.writeUInt32LE(index, 0);
        const hash = digest(bytes); hashes[index] = hash;
        await putPart(new URL(`/drive/${file!.id}/parts/${index}`, origin), bytes, hash, agent, signal);
      });
      file = await store.completeUpload(owner, file.id);
    });
    const ready = file!; assert.equal(ready.status, 'ready'); assert.equal(ready.uploadedBytes, size);
    const saved = await store.getFile(owner, ready.id);
    assert.equal(saved.parts.length, count);
    for (const part of saved.parts) assert.equal(part.sha256, hashes[part.index]);
    process.stderr.write('Upload persisted and all metadata checksums matched; verifying DriveStore range download.\n');
    const driveDownload = await measure(size, () => parallelParts(count, config.parallel, shutdown.signal, (index, signal) => readPart(new URL(`/drive/${ready.id}/content`, origin), ready, index, hashes[index], agent, signal)));
    process.stderr.write('DriveStore download checksums matched; verifying direct fs streaming control.\n');
    const directDownload = await measure(size, () => parallelParts(count, config.parallel, shutdown.signal, (index, signal) => readPart(new URL(`/direct/${ready.id}`, origin), ready, index, hashes[index], agent, signal)));
    const disk = await statfs(directory, { bigint: true });
    report = {
      measuredAt: new Date().toISOString(), dataset: { bytes: size, parts: count, chunkBytes, parallel: config.parallel, syntheticOnly: true, uniquePartMarker: true },
      environment: { platform: process.platform, architecture: process.arch, osVersion: version(), osRelease: release(), node: process.version, postgres: postgresVersion, cpu: [...new Set(cpus().map((cpu) => cpu.model))], logicalCpus: cpus().length, totalMemoryBytes: totalmem(), filesystemType: disk.type.toString(), storage: 'OS temporary directory; generated directory removed after run' },
      memory: { scope: 'HTTP client and server in the same Node process; PostgreSQL and OS file cache excluded', samplingIntervalMs: 20, uploadPayloadBoundBytes: config.parallel * chunkBytes, seedBytes: seed.length, fullFileBuffer: false },
      upload, driveDownload, directDownload,
      integrity: { persistedMetadataChecksumsMatched: count, driveDownloadChunksVerified: count, directDownloadChunksVerified: count, completeFileBytesVerifiedPerDownload: size },
      limitations: ['Loopback only; no WAN, TLS, reverse proxy or browser involved.', 'Page cache is not flushed. Upload runs first, then DriveStore download, then direct fs control.', 'Throughput includes client generation/checksumming and server persistence/read work; it is not a network bandwidth guarantee.', 'RSS is sampled and includes retained allocator pages; it is not solely live transfer buffers.'],
    };
  } finally {
    shutdown.abort();
    for (const request of requests) request.abort();
    agent.destroy();
    const cleanupErrors: unknown[] = [];
    try { await closeServer(server); } catch (error) { cleanupErrors.push(error); }
    const pools = await Promise.allSettled([uploadDatabase.end(), database.end(), ...(implicitPool ? [implicitPool.end()] : [])]);
    for (const result of pools) if (result.status === 'rejected') cleanupErrors.push(result.reason);
    if (createdDatabase) {
      try {
        const deadline = Date.now() + 10_000;
        while ((await admin.query('SELECT 1 FROM pg_stat_activity WHERE datname=$1', [databaseName])).rowCount) {
          if (Date.now() >= deadline) throw new Error(`Generated database ${databaseName} still has connections; it was not dropped.`);
          await delay(25);
        }
        await admin.query(`DROP DATABASE "${databaseName}"`);
      } catch (error) { cleanupErrors.push(error); }
    }
    try { await admin.end(); } catch (error) { cleanupErrors.push(error); }
    try { await cleanupTemporary(directory, temporaryParent, marker); } catch (error) { cleanupErrors.push(error); }
    process.off('SIGINT', stop); process.off('SIGTERM', stop);
    if (cleanupErrors.length) throw new AggregateError(cleanupErrors, `Benchmark cleanup failed (${cleanupErrors.length} errors); inspect only the generated benchmark database/directory.`);
  }
  process.stdout.write(`${JSON.stringify({ ...report, cleanup: { isolatedDatabaseDropped: true, temporaryFilesRemoved: true, listenerClosed: true } }, null, 2)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`Drive benchmark failed: ${error instanceof Error ? error.message : 'Unknown error'}\n`);
  process.exitCode = 1;
});
