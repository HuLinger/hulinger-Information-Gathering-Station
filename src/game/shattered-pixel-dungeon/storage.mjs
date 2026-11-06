/* Hulinger game bridge, GPL-3.0-or-later. See the vendored game's LICENSE.txt. */
export const STORE = 'FILE_DATA';
export const FILE_ROOT = '/shattered-pixel-dungeon/';

export function bytesToBase64(bytes) {
  const view = ArrayBuffer.isView(bytes)
    ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    : new Uint8Array(bytes);
  const chunks = [];
  for (let offset = 0; offset < view.length; offset += 32768) {
    chunks.push(String.fromCharCode(...view.subarray(offset, offset + 32768)));
  }
  return btoa(chunks.join(''));
}

export function base64ToBytes(value) {
  const binary = atob(value);
  return Int8Array.from(binary, (character) => character.charCodeAt(0));
}

export function serializeFiles(entries) {
  return entries.filter(([path]) => path.startsWith(FILE_ROOT)).map(([path, value]) => ({
    path,
    type: value.type,
    data: value.type === 1 ? null : bytesToBase64(value.contents),
    modifiedAt: (value.date instanceof Date && !Number.isNaN(value.date.valueOf()) ? value.date : new Date(0)).toISOString(),
  })).sort((left, right) => left.path.localeCompare(right.path, 'en'));
}

export function deserializeFile(file) {
  return file.type === 1
    ? { type: 1, date: new Date(file.modifiedAt) }
    : { type: 2, date: new Date(file.modifiedAt), contents: base64ToBytes(file.data) };
}

export function collectPreferences(storage, prefix) {
  const entries = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key?.startsWith(prefix)) entries.push([key.slice(prefix.length), storage.getItem(key)]);
  }
  entries.sort(([left], [right]) => left.localeCompare(right, 'en'));
  return Object.fromEntries(entries);
}

export function canonicalSnapshot(snapshot) {
  // The backend rewrites timestamps even when no turn changed. Ignore only
  // those timestamps when detecting changes; retain them in the saved payload.
  return JSON.stringify({
    formatVersion: 1,
    files: snapshot.files.map(({ path, type, data }) => ({ path, type, data }))
      .sort((left, right) => compareKeys(left.path, right.path)),
    // PostgreSQL jsonb does not preserve object key order. A restored snapshot
    // must compare equal to the same browser preferences after hydration.
    prefs: Object.fromEntries(Object.entries(snapshot.prefs).sort(([left], [right]) => compareKeys(left, right))),
  });
}

function compareKeys(left, right) { return left < right ? -1 : left > right ? 1 : 0; }

export function openDatabase(name) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('浏览器存储不可用，请允许本站使用本地存储。'));
    request.onblocked = () => reject(new Error('浏览器存储被其他页面占用，请关闭旧游戏页面后重试。'));
  });
}

export function hydrateDatabase(database, snapshot) {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE, 'readwrite');
    const store = transaction.objectStore(STORE);
    store.clear();
    for (const file of snapshot?.files ?? []) store.put(deserializeFile(file), file.path);
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(new Error('存档未能载入浏览器，游戏尚未启动。'));
    transaction.onabort = transaction.onerror;
  });
}

export function readSnapshot(database, storage, prefix) {
  return new Promise((resolve, reject) => {
    const entries = [];
    const transaction = database.transaction(STORE, 'readonly');
    const request = transaction.objectStore(STORE).openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (cursor) { entries.push([cursor.key, cursor.value]); cursor.continue(); }
    };
    transaction.oncomplete = () => {
      try { resolve({ formatVersion: 1, files: serializeFiles(entries), prefs: collectPreferences(storage, prefix) }); }
      catch { reject(new Error('无法读取当前游戏存档。请保留此页面并重试。')); }
    };
    transaction.onerror = () => reject(new Error('读取浏览器存档失败，请保留此页面并重试。'));
    transaction.onabort = transaction.onerror;
  });
}
