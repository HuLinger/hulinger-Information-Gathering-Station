import assert from 'node:assert/strict';
import { mkdtemp, open, realpath, rm, rmdir, writeFile, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PassThrough, Readable, pipeline } from 'node:stream';
import { ReadableStream as WebReadableStream } from 'node:stream/web';
import { setTimeout as delay } from 'node:timers/promises';
import { DriveStore } from '../../src/server/drive/store';
import type { DriveFile } from '../../src/shared/drive-contracts';

// This runs in its own process: the old Node adapter can throw outside the
// pipeTo promise. Catching those diagnostic exceptions must never affect the app.
const directory = await mkdtemp(join(tmpdir(), 'hulinger-download-cancel-'));
assert.equal(dirname(await realpath(directory)).toLowerCase(), (await realpath(tmpdir())).toLowerCase());
const filename = join(directory, 'synthetic.bin');
const bytes = Buffer.alloc(2 * 1024 * 1024, 17);
await writeFile(filename, bytes);
const handles: FileHandle[] = [];
const errors: Error[] = [];
const monitor = (error: Error) => { errors.push(error); };
const originalFrom = WebReadableStream.from;
let lastBufferedStream: PassThrough;
const file: DriveFile = {
  id: '00000000-0000-0000-0000-000000000001', name: 'synthetic.bin', size: bytes.length,
  status: 'ready', chunkSize: 1024 * 1024, chunkCount: 2, uploadedBytes: bytes.length,
  lastModified: 0, fingerprint: '0'.repeat(64), createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(), completedAt: new Date(0).toISOString(), deletedAt: null, etag: '"synthetic-fixture"',
};
const store = Object.create(DriveStore.prototype) as DriveStore;
const seam = store as unknown as {
  downloadInfo(): Promise<{ file: DriveFile; headers: Headers }>;
  fileHandle(): Promise<FileHandle>;
};
seam.downloadInfo = async () => ({ file, headers: new Headers({ 'Content-Type': 'application/octet-stream' }) });
seam.fileHandle = async () => {
  const handle = await open(filename, 'r');
  handles.push(handle);
  const createReadStream = handle.createReadStream.bind(handle);
  handle.createReadStream = (options) => {
    // Actual file bytes and autoClose, with a bounded buffered transport to make
    // scheduled resume ticks deterministic enough to exercise cancellation.
    const buffered = new PassThrough({ highWaterMark: 16 * 1024 });
    lastBufferedStream = buffered;
    pipeline(createReadStream(options), buffered, () => {});
    return buffered as unknown as ReturnType<FileHandle['createReadStream']>;
  };
  return handle;
};
process.on('uncaughtException', monitor);
const results: { mode: string; iterations: number; uncaught: number; openHandles: number }[] = [];
try {
  for (const mode of ['legacy', 'actual']) {
    // Both modes invoke the production DriveStore.download method. Only the
    // legacy diagnostic restores the old conversion factory in this child.
    WebReadableStream.from = mode === 'legacy' ? (() => Readable.toWeb(lastBufferedStream)) as unknown as typeof originalFrom : originalFrom;
    const before = errors.length;
    for (let iteration = 0; iteration < 40; iteration++) {
      const response = await store.download('synthetic-owner', file.id, new Request('http://127.0.0.1/synthetic-content'));
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let received = 0;
      const sink = new WritableStream<Uint8Array>({ async write(chunk) {
        received += chunk.byteLength;
        timer ??= setTimeout(() => controller.abort(), 3);
        await delay(1);
      } }, { highWaterMark: 1 });
      try { await response.body!.pipeTo(sink, { signal: controller.signal }); }
      catch (error) { if (!controller.signal.aborted) throw error; }
      finally { clearTimeout(timer); }
      assert.ok(received > 0, 'Cancel only after actual file bytes reach the consumer.');
      await delay(1);
    }
    const deadline = Date.now() + 2000;
    while (handles.some((handle) => handle.fd !== -1) && Date.now() < deadline) await delay(5);
    const currentErrors = errors.slice(before);
    const openHandles = handles.filter((handle) => handle.fd !== -1).length;
    results.push({ mode, iterations: 40, uncaught: currentErrors.length, openHandles });
    assert.equal(openHandles, 0, 'The real file descriptor must close even when the consumer cancels.');
    assert.ok(currentErrors.every((error) => 'code' in error && error.code === 'ERR_INVALID_STATE'), 'Unexpected exception in cancellation probe.');
    if (mode === 'actual') assert.deepEqual(currentErrors, [], 'Production download must not throw after consumer cancellation.');
  }
  console.log(JSON.stringify({ node: process.version, results }));
} finally {
  WebReadableStream.from = originalFrom;
  process.removeListener('uncaughtException', monitor);
  await Promise.all(handles.map((handle) => handle.close().catch(() => {})));
  await rm(filename);
  await rmdir(directory);
}
