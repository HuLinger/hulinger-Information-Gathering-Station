import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, truncate, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import type { DriveUpload } from '../src/shared/drive-contracts';

const databaseURL = process.env.AUTH_TEST_DATABASE_URL ?? process.env.TEST_DATABASE_URL;
const MiB = 1024 * 1024;
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const status = (expected: number) => (error: unknown) => error instanceof Error && 'status' in error && error.status === expected;

function partRequest(bytes: Uint8Array, options: { hash?: string; contentLength?: number; stream?: ReadableStream<Uint8Array> } = {}) {
  const headers = new Headers({ 'Content-Type': 'application/octet-stream', 'X-Chunk-SHA256': options.hash ?? digest(bytes) });
  if (options.contentLength !== undefined) headers.set('Content-Length', String(options.contentLength));
  const init: RequestInit & { duplex?: 'half' } = { method: 'PUT', headers };
  if (options.stream) { init.body = options.stream; init.duplex = 'half'; }
  else init.body = new Blob([Uint8Array.from(bytes)]);
  return new Request('http://127.0.0.1/api/drive/uploads/synthetic/parts/0', init);
}

function uploadInput(name: string, bytes: Uint8Array) {
  return { name, size: bytes.byteLength, lastModified: 1_700_000_000_000, fingerprint: digest(bytes) };
}

test('real PostgreSQL and disk: resumable private drive preserves bytes, ownership and lifecycle', { skip: !databaseURL, timeout: 120_000 }, async (suite) => {
  const admin = new Pool({ connectionString: databaseURL, max: 2 });
  const databaseName = `drive_test_${randomUUID().replaceAll('-', '')}`;
  const url = new URL(databaseURL!);
  url.pathname = `/${databaseName}`;
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  const database = new Pool({ connectionString: url.href, max: 10 });
  const uploadDatabase = new Pool({ connectionString: url.href, max: 4 });
  const testDirectory = await mkdtemp(join(tmpdir(), 'hulinger-drive-test-'));
  const storageRoot = join(testDirectory, 'drive');
  const temporaryParent = await realpath(tmpdir());
  const resolvedTest = await realpath(testDirectory);
  assert.equal(dirname(resolvedTest).toLowerCase(), temporaryParent.toLowerCase());
  process.env.DATABASE_URL = url.href;
  process.env.APP_URL = 'http://127.0.0.1:3000';
  process.env.BETTER_AUTH_SECRET = randomBytes(32).toString('hex');
  Object.assign(process.env, { NODE_ENV: 'test' });

  try {
    const { migrate } = await import('../scripts/migrate');
    const { DriveStore } = await import('../src/server/drive/store');
    await migrate(database);
    await migrate(database);
    const config = { chunkSize: MiB, reserveBytes: 0, maxFileBytes: 100 * MiB };
    const newStore = (overrides: Partial<typeof config> & { quotaBytes?: number | null; maxPendingUploads?: number } = {}) => new DriveStore({ database, uploadDatabase, root: storageRoot, config: { ...config, ...overrides } });
    let store = newStore();
    const owner = 'synthetic-drive-owner';
    async function reset() {
      await database.query('TRUNCATE drive_parts, drive_files CASCADE');
      assert.equal(dirname(resolve(storageRoot)), resolve(testDirectory));
      await rm(storageRoot, { recursive: true, force: true });
      store = newStore();
    }
    async function upload(bytes: Uint8Array, name = '合成大文件.bin') {
      const session = await store.createUpload(owner, uploadInput(name, bytes));
      for (let index = 0; index < session.file.chunkCount; index++) {
        await store.writePart(owner, session.file.id, index, partRequest(bytes.subarray(index * MiB, Math.min(bytes.byteLength, (index + 1) * MiB))));
      }
      return session;
    }
    const download = (id: string, headers: HeadersInit = {}, method = 'GET') => store.download(owner, id, new Request(`http://127.0.0.1/api/drive/files/${id}/content`, { headers, method }));

    await suite.test('out-of-order parallel parts and duplicate requests survive a new store instance', async () => {
      await reset();
      const bytes = randomBytes(2 * MiB + 137);
      const input = uploadInput('合成断点续传.bin', bytes);
      const session = await store.createUpload(owner, input);
      assert.equal((await store.createUpload(owner, input)).file.id, session.file.id, 'same pending file should resume');
      const id = session.file.id;
      await assert.rejects(download(id), status(404));
      await assert.rejects(store.writePart('different-synthetic-owner', id, 0, partRequest(bytes.subarray(0, MiB))), status(404));
      await assert.rejects(store.completeUpload('different-synthetic-owner', id), status(404));
      await Promise.all([2, 0].map((index) => store.writePart(owner, id, index, partRequest(bytes.subarray(index * MiB, Math.min(bytes.length, (index + 1) * MiB))))));
      store = newStore();
      const resumed = await store.getFile(owner, id);
      assert.deepEqual(resumed.parts.map((part) => part.index).sort(), [0, 2]);
      assert.equal(resumed.file.uploadedBytes, MiB + 137);
      const duplicates = await Promise.allSettled([0, 1, 1].map((index) => store.writePart(owner, id, index, partRequest(bytes.subarray(index * MiB, (index + 1) * MiB)))));
      for (const result of duplicates) if (result.status === 'rejected') assert.ok(status(429)(result.reason), 'a concurrent same-part writer may be asked to retry');
      await store.writePart(owner, id, 1, partRequest(bytes.subarray(MiB, 2 * MiB)));
      const complete = await store.completeUpload(owner, id);
      assert.equal(complete.status, 'ready');
      assert.equal((await store.completeUpload(owner, id)).id, id, 'completion is idempotent');
      assert.deepEqual(Buffer.from(await (await download(id)).arrayBuffer()), bytes);
      assert.equal((await stat(join(storageRoot, 'objects', `${id}.bin`))).size, bytes.length);
      assert.equal((await database.query('SELECT count(*)::int AS count FROM drive_parts WHERE file_id=$1', [id])).rows[0].count, 3);
      await assert.rejects(store.writePart(owner, id, 0, partRequest(randomBytes(MiB))), status(409));
      assert.deepEqual(Buffer.from(await (await download(id)).arrayBuffer()), bytes, 'ready content stays immutable');
    });

    await suite.test('short, oversized, incorrect checksums and failed streams never become completed parts', async () => {
      await reset();
      const bytes = randomBytes(MiB);
      const { file } = await store.createUpload(owner, uploadInput('合成失败重试.bin', bytes));
      await assert.rejects(store.writePart(owner, file.id, 0, partRequest(bytes.subarray(0, bytes.length - 1))));
      await assert.rejects(store.writePart(owner, file.id, 0, partRequest(Buffer.concat([bytes, Buffer.from([1])]))));
      await assert.rejects(store.writePart(owner, file.id, 0, partRequest(bytes, { hash: '0'.repeat(64) })));
      await assert.rejects(store.writePart(owner, file.id, 0, partRequest(bytes, { contentLength: MiB + 1 })));
      let read = false;
      const broken = new ReadableStream<Uint8Array>({ pull(controller) {
        if (!read) { read = true; controller.enqueue(bytes.subarray(0, 4096)); }
        else controller.error(new Error('synthetic interrupted transport'));
      } });
      await assert.rejects(store.writePart(owner, file.id, 0, partRequest(bytes, { stream: broken })));
      assert.equal((await store.getFile(owner, file.id)).parts.length, 0);
      await assert.rejects(store.completeUpload(owner, file.id), status(409));
      await store.writePart(owner, file.id, 0, partRequest(bytes));
      await store.completeUpload(owner, file.id);
      assert.deepEqual(Buffer.from(await (await download(file.id)).arrayBuffer()), bytes);
    });

    await suite.test('empty files are valid while impossible sizes and offsets are refused', async () => {
      await reset();
      const empty = await store.createUpload(owner, uploadInput('empty.bin', Buffer.alloc(0)));
      assert.equal(empty.file.chunkCount, 0);
      await store.completeUpload(owner, empty.file.id);
      const response = await download(empty.file.id);
      assert.equal(response.headers.get('content-length'), '0');
      assert.equal((await response.arrayBuffer()).byteLength, 0);
      const impossible = { ...uploadInput('invalid.bin', Buffer.from('x')), size: Number.MAX_SAFE_INTEGER + 1 };
      for (const size of [-1, 0.5, NaN, Infinity, 101 * MiB, impossible.size]) {
        await assert.rejects(store.createUpload(owner, { ...impossible, size }));
      }
      const pending = await store.createUpload(owner, uploadInput('bounded.bin', Buffer.from('bounded')));
      for (const index of [-1, 0.5, 1, Number.MAX_SAFE_INTEGER + 1]) {
        await assert.rejects(store.writePart(owner, pending.file.id, index, partRequest(Buffer.from('bounded'))));
      }
      assert.equal((await store.getFile(owner, pending.file.id)).parts.length, 0);
    });

    await suite.test('owner checks and Range/If-Range retain private, byte-exact downloads', async () => {
      await reset();
      const bytes = Buffer.from('0123456789abcdefghijklmnopqrstuvwxyz');
      const { file } = await upload(bytes, '中文 文件.html');
      await store.completeUpload(owner, file.id);
      await assert.rejects(store.getFile('different-synthetic-owner', file.id), status(404));
      await assert.rejects(store.action('different-synthetic-owner', file.id, { action: 'trash' }), status(404));
      await assert.rejects(store.download('different-synthetic-owner', file.id, new Request('http://127.0.0.1/content')), status(404));
      const full = await download(file.id);
      assert.equal(full.status, 200);
      assert.equal(full.headers.get('accept-ranges'), 'bytes');
      assert.equal(full.headers.get('content-type'), 'application/octet-stream');
      assert.match(full.headers.get('content-disposition')!, /^attachment;/);
      assert.match(full.headers.get('cache-control')!, /no-store/);
      assert.equal(full.headers.get('x-content-type-options'), 'nosniff');
      const etag = full.headers.get('etag')!;
      assert.ok(etag);
      await full.body?.cancel();
      const range = await download(file.id, { Range: 'bytes=3-7', 'If-Range': etag });
      assert.equal(range.status, 206);
      assert.equal(range.headers.get('content-range'), `bytes 3-7/${bytes.length}`);
      assert.equal(range.headers.get('content-length'), '5');
      assert.equal(await range.text(), '34567');
      const suffix = await download(file.id, { Range: 'bytes=-4' });
      assert.equal(suffix.status, 206);
      assert.equal(await suffix.text(), 'wxyz');
      const stale = await download(file.id, { Range: 'bytes=3-7', 'If-Range': '"stale-version"' });
      assert.equal(stale.status, 200);
      assert.equal(await stale.text(), bytes.toString());
      const outside = await download(file.id, { Range: `bytes=${bytes.length}-` });
      assert.equal(outside.status, 416);
      assert.equal(outside.headers.get('content-range'), `bytes */${bytes.length}`);
      const head = await download(file.id, {}, 'HEAD');
      assert.equal(head.status, 200);
      assert.equal(head.headers.get('content-length'), String(bytes.length));
      assert.equal((await head.arrayBuffer()).byteLength, 0);
    });

    await suite.test('quota reservation and upload limits remain correct under competing requests', async () => {
      await reset();
      store = newStore({ quotaBytes: MiB + 128 });
      const attempts = await Promise.allSettled(['a.bin', 'b.bin'].map((name) => store.createUpload(owner, uploadInput(name, randomBytes(MiB)))));
      assert.equal(attempts.filter((result) => result.status === 'fulfilled').length, 1);
      const accepted = attempts.find((result): result is PromiseFulfilledResult<DriveUpload> => result.status === 'fulfilled')!.value;
      const listing = await store.list(owner, { view: 'files' });
      assert.equal(listing.capacity.reservedBytes, MiB);
      await assert.rejects(store.action(owner, accepted.file.id, { action: 'cancel' }));
      await store.action(owner, accepted.file.id, { action: 'cancel', confirm: true });
      const after = await store.createUpload(owner, uploadInput('after.bin', randomBytes(MiB)));
      assert.ok(after.file.id);
      await reset();
      store = newStore({ maxPendingUploads: 1 });
      await store.createUpload(owner, uploadInput('one.bin', Buffer.from('one')));
      await assert.rejects(store.createUpload(owner, uploadInput('two.bin', Buffer.from('two'))));
      await assert.rejects(async () => newStore({ reserveBytes: Number.MAX_SAFE_INTEGER }).createUpload(owner, uploadInput('no-space.bin', Buffer.from('space'))));
    });

    await suite.test('capacity does not reserve NTFS allocations twice and still reserves sparse holes', async (context) => {
      await reset();
      const size = 64 * MiB;
      const { file } = await store.createUpload(owner, {
        name: 'allocation-fixture.bin', size, lastModified: 0, fingerprint: digest(Buffer.from('allocation fixture')),
      });
      const object = join(storageRoot, 'objects', `${file.id}.bin`);
      const allocation = (await stat(object)).blocks * 512;
      const listing = await store.list(owner, { view: 'files' });
      assert.equal(listing.capacity.reservedBytes, size, 'The public upload-progress reservation remains logical bytes.');
      if (allocation >= size) {
        assert.equal(listing.capacity.availableBytes, listing.capacity.freeBytes, 'Preallocated file space is already absent from disk free space.');
      } else if (allocation === 0) {
        assert.equal(listing.capacity.availableBytes, listing.capacity.freeBytes - size, 'A sparse empty upload still reserves every future byte.');
      } else {
        assert.ok(listing.capacity.availableBytes < listing.capacity.freeBytes);
        assert.ok(listing.capacity.availableBytes >= listing.capacity.freeBytes - size);
      }
      context.diagnostic(`Actual ${process.platform} allocation: ${allocation} of ${size} bytes.`);
      await store.writePart(owner, file.id, 0, partRequest(Buffer.alloc(MiB, 7)));
      assert.equal((await store.list(owner, { view: 'files' })).capacity.reservedBytes, size - MiB);
      await truncate(object, size - 1);
      await assert.rejects(store.list(owner, { view: 'files' }), status(503));
      await rm(object);
      await assert.rejects(store.list(owner, { view: 'files' }), status(503));
    });

    await suite.test('storage readiness exercises real read/write/delete without leaving probe files', async () => {
      await reset();
      await Promise.all(Array.from({ length: 4 }, () => store.checkStorage()));
      assert.deepEqual(await readdir(join(storageRoot, 'objects')), []);
    });

    await suite.test('storage readiness rejects a read-only object directory', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async () => {
      await reset();
      const objects = join(storageRoot, 'objects');
      await mkdir(objects, { recursive: true });
      await chmod(objects, 0o500);
      try {
        await assert.rejects(store.checkStorage(), (error: unknown) => error instanceof Error && 'code' in error && ['EACCES', 'EPERM', 'EROFS'].includes(String(error.code)));
      } finally { await chmod(objects, 0o700); }
      assert.deepEqual(await readdir(objects), []);
    });

    await suite.test('completion and cancellation cannot both publish and remove a ready file', async () => {
      await reset();
      const { file } = await upload(Buffer.from('synthetic completion race'));
      const outcomes = await Promise.allSettled([
        store.completeUpload(owner, file.id),
        store.action(owner, file.id, { action: 'cancel', confirm: true }),
      ]);
      assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1);
      if (outcomes[0].status === 'fulfilled') {
        assert.equal((await store.getFile(owner, file.id)).file.status, 'ready');
        assert.equal(await (await download(file.id)).text(), 'synthetic completion race');
      } else {
        await assert.rejects(store.getFile(owner, file.id), status(404));
        await assert.rejects(stat(join(storageRoot, 'objects', `${file.id}.bin`)), { code: 'ENOENT' });
      }
    });

    await suite.test('trash is recoverable, purge is explicit, and expired uploads are cleaned', async () => {
      await reset();
      const { file } = await upload(Buffer.from('synthetic retained file'), '原始名称.bin');
      await store.completeUpload(owner, file.id);
      await store.action(owner, file.id, { action: 'rename', name: '更新名称.bin' });
      assert.equal((await store.list(owner, { view: 'files', q: '更新名称' })).files[0].id, file.id);
      await store.action(owner, file.id, { action: 'trash' });
      assert.equal((await store.list(owner, { view: 'files' })).files.length, 0);
      assert.equal((await store.list(owner, { view: 'trash' })).files[0].id, file.id);
      await assert.rejects(download(file.id));
      await store.action(owner, file.id, { action: 'restore' });
      assert.equal(await (await download(file.id)).text(), 'synthetic retained file');
      await store.action(owner, file.id, { action: 'trash' });
      await assert.rejects(store.action(owner, file.id, { action: 'purge' }));
      await store.action(owner, file.id, { action: 'purge', confirm: true });
      await assert.rejects(store.getFile(owner, file.id), status(404));
      await assert.rejects(stat(join(storageRoot, 'objects', `${file.id}.bin`)), { code: 'ENOENT' });
      const expired = await store.createUpload(owner, uploadInput('expired.bin', Buffer.from('expired')));
      const current = await store.createUpload(owner, uploadInput('current.bin', Buffer.from('current')));
      const expiredTrash = await upload(Buffer.from('old trash'), 'old-trash.bin');
      await store.completeUpload(owner, expiredTrash.file.id);
      await store.action(owner, expiredTrash.file.id, { action: 'trash' });
      await database.query("UPDATE drive_files SET updated_at=now()-interval '8 days' WHERE id=$1", [expired.file.id]);
      await database.query("UPDATE drive_files SET deleted_at=now()-interval '31 days' WHERE id=$1", [expiredTrash.file.id]);
      await store.cleanup();
      await assert.rejects(store.getFile(owner, expired.file.id), status(404));
      await assert.rejects(store.getFile(owner, expiredTrash.file.id), status(404));
      assert.equal((await store.getFile(owner, current.file.id)).file.id, current.file.id);
    });

    await suite.test('untrusted names cannot escape storage', async () => {
      await reset();
      for (const name of ['../outside.bin', '..\\outside.bin', '/absolute.bin', 'a/b.bin', 'bad\u0000name.bin', 'header\r\nInjected: yes']) {
        await assert.rejects(store.createUpload(owner, uploadInput(name, Buffer.from('synthetic'))), `unsafe name ${JSON.stringify(name)}`);
      }
    });

    await suite.test('orphan cleanup removes old unreferenced objects and retains recent or live objects', async () => {
      await reset();
      const live = await store.createUpload(owner, uploadInput('live.bin', Buffer.from('live')));
      const objects = join(storageRoot, 'objects');
      const orphan = join(objects, `${randomUUID()}.bin`);
      const fresh = join(objects, `${randomUUID()}.bin`);
      const unrelated = join(objects, 'unrelated-note.txt');
      const liveObject = join(objects, `${live.file.id}.bin`);
      for (const path of [orphan, fresh, unrelated]) await writeFile(path, 'synthetic cleanup marker');
      const old = new Date(Date.now() - 2 * 24 * 60 * 60_000);
      for (const path of [orphan, unrelated, liveObject]) await utimes(path, old, old);
      const result = await store.cleanup();
      assert.equal(result.orphaned, 1);
      await assert.rejects(stat(orphan), { code: 'ENOENT' });
      for (const path of [fresh, unrelated, liveObject]) assert.ok((await stat(path)).isFile());
      assert.equal((await store.getFile(owner, live.file.id)).file.id, live.file.id);
    });

    await suite.test('a substituted file symlink cannot overwrite a file outside the object directory', async (context) => {
      await reset();
      const { file } = await store.createUpload(owner, uploadInput('safe.bin', Buffer.from('safe')));
      const outsidePath = join(testDirectory, 'outside-synthetic.bin');
      await writeFile(outsidePath, 'outside remains unchanged');
      const objectPath = join(storageRoot, 'objects', `${file.id}.bin`);
      await rm(objectPath);
      try { await symlink(outsidePath, objectPath, 'file'); }
      catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'EPERM') {
          context.skip('File symlink creation is unavailable on this host; Linux CI executes this negative case.');
          return;
        }
        throw error;
      }
      await assert.rejects(store.writePart(owner, file.id, 0, partRequest(Buffer.from('safe'))));
      assert.equal(await readFile(outsidePath, 'utf8'), 'outside remains unchanged');
    });

    await suite.test('a substituted object directory symlink cannot redirect storage', async () => {
      await reset();
      await mkdir(storageRoot, { recursive: true });
      const externalObjects = join(testDirectory, 'external-objects');
      await mkdir(externalObjects);
      await symlink(externalObjects, join(storageRoot, 'objects'), process.platform === 'win32' ? 'junction' : 'dir');
      await assert.rejects(newStore().createUpload(owner, uploadInput('blocked.bin', Buffer.from('blocked'))));
    });
  } finally {
    await uploadDatabase.end();
    await database.end();
    try {
      const deadline = Date.now() + 5000;
      while ((await admin.query('SELECT 1 FROM pg_stat_activity WHERE datname=$1', [databaseName])).rowCount) {
        if (Date.now() >= deadline) throw new Error('Drive test database still has connections after pool shutdown.');
        await delay(25);
      }
      await admin.query(`DROP DATABASE "${databaseName}"`);
    } finally {
      await admin.end();
      assert.equal((await realpath(testDirectory)).toLowerCase(), resolvedTest.toLowerCase());
      await rm(testDirectory, { recursive: true, force: true });
    }
  }
});
