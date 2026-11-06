import test from 'node:test';
import assert from 'node:assert/strict';
import { base64ToBytes, bytesToBase64, canonicalSnapshot, collectPreferences, deserializeFile, serializeFiles } from '../src/game/shattered-pixel-dungeon/storage.mjs';

test('game snapshot preserves signed bytes, file path delimiters, directories and timestamps', () => {
  const bytes = Int8Array.from([0, 1, 127, -128, -1]);
  const timestamp = new Date('2026-11-06T01:02:03.000Z');
  const files = serializeFiles([
    ['/shattered-pixel-dungeon/game1/game.dat/', { type: 2, date: timestamp, contents: bytes }],
    ['/shattered-pixel-dungeon/game1/', { type: 1, date: timestamp }],
    ['/unrelated-private-app/secret/', { type: 2, date: timestamp, contents: bytes }],
  ]);
  assert.equal(files.length, 2);
  const file = files.find((entry: { type: number }) => entry.type === 2)!;
  assert.equal(file.path, '/shattered-pixel-dungeon/game1/game.dat/');
  assert.equal(file.modifiedAt, timestamp.toISOString());
  assert.deepEqual(deserializeFile(file).contents, bytes);
  const directory = files.find((entry: { type: number }) => entry.type === 1)!;
  assert.equal(directory.data, null);
  assert.equal(deserializeFile(directory).type, 1);
});

test('base64 codec preserves nonzero-offset views and empty files', () => {
  const bytes = new Uint8Array([55, 0, 255, 128, 66]);
  assert.deepEqual(Array.from(base64ToBytes(bytesToBase64(bytes.subarray(1, 4)))), [0, -1, -128]);
  assert.equal(bytesToBase64(new Uint8Array()), '');
  assert.equal(base64ToBytes('').length, 0);
});

test('preferences include only the exact current run and strip its namespace', () => {
  const entries = new Map([
    ['pref:run-a:settings.xml:musicb', 'true'],
    ['pref:run-b:settings.xml:musicb', 'false'],
    ['session-token', 'do-not-export'],
  ]);
  const storage = { length: entries.size, key: (index: number) => [...entries.keys()][index], getItem: (key: string) => entries.get(key) };
  assert.deepEqual(collectPreferences(storage, 'pref:run-a:'), { 'settings.xml:musicb': 'true' });
});

test('timestamp-only writes do not create new cloud versions but changed file bytes do', () => {
  const snapshot = { files: [{ path: '/shattered-pixel-dungeon/game1/game.dat/', type: 2, data: 'AA==', modifiedAt: '2026-11-06T00:00:00.000Z' }], prefs: {} };
  const later = structuredClone(snapshot);
  later.files[0].modifiedAt = '2026-11-06T00:00:03.000Z';
  assert.equal(canonicalSnapshot(snapshot), canonicalSnapshot(later));
  later.files[0].data = 'AQ==';
  assert.notEqual(canonicalSnapshot(snapshot), canonicalSnapshot(later));
});
