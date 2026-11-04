import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DriveFile, DriveUpload } from '../src/shared/drive-contracts';
import { ApiError } from '../src/components/api';
import { parseDriveUpload } from '../src/components/drive/api';
import { delay, downloadParts, fileFingerprint, isAbort, retryTransfer, runPool, sha256, uploadParts, type TransferProgress } from '../src/components/drive/transfer';

const signal = () => new AbortController().signal;
const progress = () => {};
const id = '00000000-0000-4000-8000-000000000001';

async function fixture(content: Uint8Array<ArrayBuffer>, chunkSize = 4): Promise<{ local: File; upload: DriveUpload }> {
  const local = new File([content], 'synthetic-file.bin', { lastModified: 1234 });
  const file: DriveFile = { id, name: local.name, size: local.size, chunkSize, chunkCount: Math.ceil(local.size / chunkSize), status: 'uploading', uploadedBytes: 0, fingerprint: await fileFingerprint(local, signal()), lastModified: local.lastModified, etag: '"synthetic-etag"', createdAt: '2026-11-04T00:00:00Z', updatedAt: '2026-11-04T00:00:00Z', completedAt: null, deletedAt: null };
  const parts = await Promise.all(Array.from({ length: file.chunkCount }, async (_, index) => ({ index, sha256: await sha256(content.slice(index * chunkSize, (index + 1) * chunkSize).buffer) })));
  return { local, upload: { file, parts } };
}

function rangeResponse(content: Uint8Array<ArrayBuffer>, file: DriveFile, options: RequestInit) {
  const range = new Headers(options.headers).get('Range');
  const match = /^bytes=(\d+)-(\d+)$/.exec(range ?? '');
  assert.ok(match);
  assert.equal(new Headers(options.headers).get('If-Range'), file.etag);
  const start = Number(match[1]); const end = Number(match[2]);
  return new Response(content.slice(start, end + 1), { status: 206, headers: { 'Content-Range': `bytes ${start}-${end}/${file.size}`, ETag: file.etag, 'Content-Length': String(end - start + 1) } });
}

test('upload verifies existing part hashes, skips only those parts, and bounds concurrency', async () => {
  const content = Uint8Array.from({ length: 24 }, (_, index) => index);
  const { local, upload } = await fixture(content);
  upload.parts = upload.parts.filter((part) => part.index === 0 || part.index === 4);
  let active = 0; let maximum = 0;
  const sent: number[] = [];
  const updates: TransferProgress[] = [];
  await uploadParts({ local, upload, parallel: 2, signal: signal(), onProgress: (value) => updates.push(value), send: async (fileId, index, chunk, hash, partSignal, onBytes) => {
    assert.equal(fileId, id); assert.equal(hash, await sha256(await chunk.arrayBuffer()));
    active++; maximum = Math.max(maximum, active);
    onBytes(chunk.size / 2);
    await delay(index % 2 ? 5 : 1, partSignal);
    onBytes(chunk.size); sent.push(index); active--;
  } });
  assert.deepEqual(sent.sort((a, b) => a - b), [1, 2, 3, 5]);
  assert.equal(maximum, 2);
  assert.equal(updates.at(-1)?.phase, 'finishing');
  assert.equal(updates.at(-1)?.committedBytes, content.length);
  assert.ok(updates.every((value) => value.bytes <= content.length));
});

test('same fingerprint does not allow a changed middle section to overwrite a resumed upload', async () => {
  const original = new Uint8Array(200_000);
  const { local, upload } = await fixture(original, 65536);
  const changed = original.slice(); changed[80000] = 42;
  const wrongFile = new File([changed], local.name, { lastModified: local.lastModified });
  assert.equal(await fileFingerprint(wrongFile, signal()), upload.file.fingerprint, 'first/last sample is deliberately identical');
  upload.parts = upload.parts.filter((part) => part.index === 1);
  let writes = 0;
  await assert.rejects(uploadParts({ local: wrongFile, upload, parallel: 4, signal: signal(), onProgress: progress, send: async () => { writes++; } }), (error) => error instanceof ApiError && error.code === 'RESUME_MISMATCH');
  assert.equal(writes, 0, 'all existing parts must validate before sending any missing part');
});

test('resumed upload rejects changed file metadata before reading or sending file bytes', async () => {
  const { local, upload } = await fixture(Uint8Array.of(1, 2, 3));
  let writes = 0;
  const wrong = new File([await local.arrayBuffer()], local.name, { lastModified: local.lastModified + 1 });
  await assert.rejects(uploadParts({ local: wrong, upload, parallel: 4, signal: signal(), onProgress: progress, send: async () => { writes++; } }), (error) => error instanceof ApiError && error.code === 'RESUME_MISMATCH');
  assert.equal(writes, 0);
});

test('empty files and bounded Blob slices never require reading the entire File object', async () => {
  class BoundedFile extends File { override arrayBuffer(): Promise<ArrayBuffer> { throw new Error('Whole-file reads are forbidden'); } }
  for (const content of [new Uint8Array(0), new Uint8Array(130)]) {
    const { upload } = await fixture(content, 16);
    const local = new BoundedFile([content], 'synthetic-file.bin', { lastModified: 1234 });
    await fileFingerprint(local, signal());
    upload.parts = [];
    let largest = 0;
    await uploadParts({ local, upload, parallel: 4, signal: signal(), onProgress: progress, send: async (_id, _index, chunk) => { largest = Math.max(largest, chunk.size); } });
    assert.ok(largest <= 16);
  }
});

test('transient errors retry with a bound; authorization and validation errors do not retry', async () => {
  const waits: number[] = [];
  let attempts = 0;
  const result = await retryTransfer(async () => { if (++attempts < 3) throw new ApiError('temporary', 503); return 42; }, signal(), async (ms) => { waits.push(ms); });
  assert.equal(result, 42); assert.equal(attempts, 3); assert.deepEqual(waits, [600, 1200]);
  for (const status of [400, 401, 403, 409, 413, 422]) {
    let calls = 0;
    await assert.rejects(retryTransfer(async () => { calls++; throw new ApiError('permanent', status); }, signal(), async () => { throw new Error('must not wait'); }));
    assert.equal(calls, 1);
  }
  attempts = 0;
  await assert.rejects(retryTransfer(async () => { attempts++; throw new ApiError('network', 0); }, signal(), async () => {}));
  assert.equal(attempts, 3);
});

test('abort interrupts backoff without performing another attempt', async () => {
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(retryTransfer(async () => { calls++; throw new ApiError('network', 0); }, controller.signal, async (ms, current) => { controller.abort(); await delay(ms, current); }), isAbort);
  assert.equal(calls, 1);
});

test('a failed pool cancels siblings and awaits their in-flight cleanup before returning', async () => {
  let cleaned = false; let started = 0;
  await assert.rejects(runPool([0, 1, 2, 3], 2, signal(), async (item, current) => {
    started++;
    if (item === 0) { await delay(1, current); throw new Error('first failure'); }
    await new Promise<void>((resolve) => current.addEventListener('abort', () => { setTimeout(() => { cleaned = true; resolve(); }, 5); }, { once: true }));
  }), /first failure/);
  assert.equal(started, 2); assert.equal(cleaned, true);
});

test('pause waits for active upload requests to stop and does not begin later parts', async () => {
  const { local, upload } = await fixture(new Uint8Array(20)); upload.parts = [];
  const controller = new AbortController(); let started = 0; let stopped = 0;
  await assert.rejects(uploadParts({ local, upload, parallel: 2, signal: controller.signal, onProgress: progress, send: async (_id, _index, _chunk, _hash, current) => {
    started++;
    const waiting = new Promise<void>((_resolve, reject) => current.addEventListener('abort', () => { stopped++; reject(new DOMException('aborted', 'AbortError')); }, { once: true }));
    if (started === 2) controller.abort();
    await waiting;
  } }), isAbort);
  assert.equal(started, 2); assert.equal(stopped, 2);
});

test('parallel range download writes verified bytes at correct offsets despite out-of-order responses', async () => {
  const content = Uint8Array.from({ length: 23 }, (_, index) => index * 3);
  const { upload } = await fixture(content); upload.file.status = 'ready';
  const output = new Uint8Array(content.length);
  const completed = new Set<number>();
  let reads = 0; let maximumReads = 0; let writes = 0; let maximumWrites = 0;
  await downloadParts({ upload, parallel: 3, completed, signal: signal(), onProgress: progress,
    request: async (_url, options) => {
      reads++; maximumReads = Math.max(maximumReads, reads);
      const start = Number(new Headers(options.headers).get('Range')?.match(/\d+/)?.[0]);
      await delay(start === 0 ? 12 : 1, options.signal as AbortSignal);
      reads--; return rangeResponse(content, upload.file, options);
    }, sink: { write: async ({ position, data }) => { writes++; maximumWrites = Math.max(maximumWrites, writes); await delay(2, signal()); output.set(data, position); writes--; } },
  });
  assert.deepEqual(output, content); assert.equal(completed.size, upload.file.chunkCount);
  assert.equal(maximumReads, 3); assert.equal(maximumWrites, 1, 'disk writes must be serialized and awaited');
});

test('download resume skips only parts already written in this page', async () => {
  const content = Uint8Array.from({ length: 12 }, (_, index) => index);
  const { upload } = await fixture(content); upload.file.status = 'ready';
  const completed = new Set([1]);
  const positions: number[] = [];
  await downloadParts({ upload, completed, parallel: 2, signal: signal(), onProgress: progress, request: async (_url, options) => rangeResponse(content, upload.file, options), sink: { write: async ({ position }) => { positions.push(position); } } });
  assert.deepEqual(positions.sort((a, b) => a - b), [0, 8]); assert.equal(completed.size, 3);
});

test('full-file 200 responses are canceled without reading them into memory', async () => {
  const { upload } = await fixture(new Uint8Array(8)); upload.file.status = 'ready';
  let canceled = false; let writes = 0;
  const body = new ReadableStream<Uint8Array>({ cancel() { canceled = true; } });
  await assert.rejects(downloadParts({ upload, completed: new Set(), parallel: 1, signal: signal(), onProgress: progress, request: async () => new Response(body, { status: 200 }), sink: { write: async () => { writes++; } } }), (error) => error instanceof ApiError && error.code === 'INVALID_RANGE');
  assert.equal(canceled, true); assert.equal(writes, 0);
});

test('incorrect range, ETag, length, excess bytes, or checksum cannot reach the local file', async () => {
  const content = Uint8Array.of(1, 2, 3, 4);
  const { upload } = await fixture(content); upload.file.status = 'ready';
  const valid = { 'Content-Range': 'bytes 0-3/4', ETag: upload.file.etag };
  const cases = [
    () => new Response(content, { status: 206, headers: { ...valid, 'Content-Range': 'bytes 1-4/4' } }),
    () => new Response(content, { status: 206, headers: { ...valid, ETag: '"another-file"' } }),
    () => new Response(content, { status: 206, headers: { ...valid, 'Content-Length': '999' } }),
    () => new Response(new Uint8Array(5), { status: 206, headers: valid }),
    () => new Response(new Uint8Array(4), { status: 206, headers: valid }),
  ];
  for (const response of cases) {
    let writes = 0;
    await assert.rejects(downloadParts({ upload, completed: new Set(), parallel: 1, signal: signal(), onProgress: progress, request: async () => response(), sink: { write: async () => { writes++; } } }));
    assert.equal(writes, 0);
  }
});

test('disk write failure is surfaced and does not mark a part as saved', async () => {
  const content = Uint8Array.of(1, 2, 3, 4);
  const { upload } = await fixture(content); upload.file.status = 'ready';
  const completed = new Set<number>(); let writes = 0;
  await assert.rejects(downloadParts({ upload, completed, parallel: 4, signal: signal(), onProgress: progress, request: async (_url, options) => rangeResponse(content, upload.file, options), sink: { write: async () => { writes++; throw new DOMException('disk full', 'QuotaExceededError'); } } }), (error) => error instanceof ApiError && error.code === 'LOCAL_WRITE_FAILED');
  assert.equal(writes, 1); assert.equal(completed.size, 0);
});

test('pause waits for an already-started disk write and remembers exactly those saved bytes', async () => {
  const content = Uint8Array.from({ length: 12 }, (_, index) => index);
  const { upload } = await fixture(content); upload.file.status = 'ready';
  const completed = new Set<number>(); const controller = new AbortController();
  let finishedWriting = false; let count = 0;
  await assert.rejects(downloadParts({ upload, completed, parallel: 2, signal: controller.signal, onProgress: progress, request: async (_url, options) => rangeResponse(content, upload.file, options), sink: { write: async () => { count++; controller.abort(); await delay(3, signal()); finishedWriting = true; } } }), isAbort);
  assert.equal(finishedWriting, true); assert.equal(count, 1); assert.equal(completed.size, 1);
});

test('invalid duplicate/out-of-range resume metadata and oversized chunks are rejected at the API boundary', async () => {
  const { upload } = await fixture(new Uint8Array(8));
  assert.deepEqual(parseDriveUpload(upload), upload);
  const invalid = [
    { ...upload, parts: [upload.parts[0], upload.parts[0]] },
    { ...upload, parts: [{ ...upload.parts[0], index: 2 }] },
    { ...upload, parts: [{ ...upload.parts[0], sha256: 'invalid' }] },
    { ...upload, file: { ...upload.file, size: 128 * 1024 * 1024, chunkSize: 128 * 1024 * 1024, chunkCount: 1 } },
    { ...upload, file: { ...upload.file, chunkCount: 3 } },
  ];
  for (const value of invalid) assert.throws(() => parseDriveUpload(value), (error) => error instanceof ApiError && error.code === 'INVALID_RESPONSE');
});
