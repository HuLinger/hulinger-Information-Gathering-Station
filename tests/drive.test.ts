import assert from 'node:assert/strict';
import test from 'node:test';
import { readDriveConfig } from '../src/server/drive/config';
import { parseByteRange, safeFilename, validId } from '../src/server/drive/validation';

const MiB = 1024 * 1024;
const invalidRange = (error: unknown) => error instanceof Error && 'status' in error && error.status === 416;

test('drive names preserve normal Unicode but reject path components and header injection', () => {
  for (const name of ['电影 2026.mp4', 'archive.tar.zst', '资料📁.zip', 'a'.repeat(255)]) {
    assert.equal(safeFilename(name), name);
  }
  for (const name of ['', ' ', '.', '..', '../secret', 'a/b', 'a\\b', '/etc/passwd', '\u0000bad', 'a\r\nHeader:value', 'a\tb', 'a'.repeat(256), '中'.repeat(86), null, 123, {}]) {
    assert.throws(() => safeFilename(name), `unsafe filename ${JSON.stringify(name)}`);
  }
});

test('drive object identifiers are canonical opaque UUIDs, never filesystem paths', () => {
  const id = 'a6d2448a-8c62-4e87-b8f5-31dc9a8a1b90';
  assert.equal(validId(id), id);
  for (const invalid of [id.toUpperCase(), `../${id}`, `${id}.bin`, `${id}/file`, '', 'not-a-uuid', id.slice(1), `${id}\u0000`, 'g6d2448a-8c62-4e87-b8f5-31dc9a8a1b90']) {
    assert.throws(() => validId(invalid));
  }
});

test('single byte ranges clamp endpoints and support resumable and suffix downloads', () => {
  assert.equal(parseByteRange(null, 10), null);
  assert.equal(parseByteRange(null, 0), null);
  assert.deepEqual(parseByteRange('bytes=0-0', 10), { start: 0, end: 0 });
  assert.deepEqual(parseByteRange('bytes=3-7', 10), { start: 3, end: 7 });
  assert.deepEqual(parseByteRange('bytes=3-', 10), { start: 3, end: 9 });
  assert.deepEqual(parseByteRange('bytes=3-999', 10), { start: 3, end: 9 });
  assert.deepEqual(parseByteRange('bytes=-3', 10), { start: 7, end: 9 });
  assert.deepEqual(parseByteRange('bytes=-999', 10), { start: 0, end: 9 });
  assert.deepEqual(parseByteRange('bytes=4294967296-4294967300', 8 * 1024 ** 3), { start: 4294967296, end: 4294967300 });
});

test('invalid, multiple and unsatisfiable ranges are rejected rather than fetching the entire file', () => {
  for (const header of ['', 'bytes=', 'items=0-1', 'bytes=3-2', 'bytes=-0', 'bytes=10-', 'bytes=99-100', 'bytes=0-1,4-5', 'bytes=1.5-2', 'bytes=-1-2', 'bytes=1e2-', 'bytes=9007199254740992-', 'bytes=0-Infinity', 'bytes=--']) {
    assert.throws(() => parseByteRange(header, 10), invalidRange, header);
  }
  assert.throws(() => parseByteRange('bytes=0-', 0), invalidRange);
});

test('drive configuration bounds memory, parallelism and the number of resumable chunks', () => {
  const defaults = readDriveConfig({ NODE_ENV: 'test' });
  assert.equal(defaults.chunkSize, 16 * MiB);
  assert.equal(defaults.maxFileBytes, 1024 ** 4);
  assert.equal(defaults.quotaBytes, null);
  assert.equal(defaults.reserveBytes, 1024 ** 3);
  assert.equal(defaults.maxParallel, 8);
  assert.equal(defaults.defaultParallel, 4);
  const smallerChunks = readDriveConfig({ NODE_ENV: 'test', DRIVE_CHUNK_BYTES: String(MiB) });
  assert.ok(smallerChunks.maxFileBytes <= smallerChunks.chunkSize * 100_000, 'default maximum must remain achievable after a smaller chunk-size setting');
  const custom = readDriveConfig({ NODE_ENV: 'test', DRIVE_CHUNK_BYTES: String(MiB), DRIVE_MAX_FILE_BYTES: String(100 * MiB), DRIVE_QUOTA_BYTES: String(200 * MiB), DRIVE_RESERVE_BYTES: '0', DRIVE_MAX_PARALLEL: '2' });
  assert.equal(custom.chunkSize, MiB);
  assert.equal(custom.maxFileBytes, 100 * MiB);
  assert.equal(custom.quotaBytes, 200 * MiB);
  assert.equal(custom.reserveBytes, 0);
  assert.equal(custom.maxParallel, 2);
  assert.ok(custom.defaultParallel <= custom.maxParallel);
  for (const env of [
    { DRIVE_CHUNK_BYTES: '0' },
    { DRIVE_CHUNK_BYTES: String(MiB - 1) },
    { DRIVE_CHUNK_BYTES: String(32 * MiB + 1) },
    { DRIVE_MAX_PARALLEL: '0' },
    { DRIVE_MAX_PARALLEL: '9' },
    { DRIVE_MAX_PARALLEL: '1.5' },
    { DRIVE_MAX_PARALLEL: '4oops' },
    { DRIVE_MAX_FILE_BYTES: '9007199254740992' },
    { DRIVE_MAX_FILE_BYTES: String(16 * MiB * 100_001) },
    { DRIVE_QUOTA_BYTES: '-1' },
    { DRIVE_RESERVE_BYTES: '-1' },
  ]) assert.throws(() => readDriveConfig({ NODE_ENV: 'test', ...env }), JSON.stringify(env));
});
