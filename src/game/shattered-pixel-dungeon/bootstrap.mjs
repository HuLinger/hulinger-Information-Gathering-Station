/* Hulinger game bridge, GPL-3.0-or-later. See the vendored game's LICENSE.txt. */
import { canonicalSnapshot, collectPreferences, hydrateDatabase, openDatabase, readSnapshot } from './storage.mjs';

const CHANNEL = 'hulinger-dungeon-v1';
const SAVE_URL = '/api/tools/shattered-pixel-dungeon/save';
const loading = document.getElementById('loading');
let database;
let scope;
let revision = 0;
let updatedAt = null;
let preferencePrefix;
let namespace;
let ready = false;
let halted = false;
let haltReason = null;
let dirty = false;
let busy = null;
let pending = false;
let lastSaved = '';
let snapshotTimer;
let heartbeat;
let checkpoint;
let startupTimer;
let latestStatus = null;

function report(state, message) {
  // Authentication failure is terminal for this run. A conflict may only be
  // upgraded to authentication failure, never undone by a late async callback.
  if (haltReason === 'unauthorized' && state !== 'unauthorized') return;
  if (haltReason === 'conflict' && state !== 'conflict' && state !== 'unauthorized') return;
  latestStatus = { channel: CHANNEL, type: 'status', state, message, updatedAt, dirty, ready };
  window.parent.postMessage(latestStatus, window.location.origin);
  if (!ready || halted) {
    loading.hidden = false;
    loading.textContent = message;
  }
}

class RequestError extends Error {
  constructor(message, status, code) { super(message); this.status = status; this.code = code; }
}

async function request(body, metadata = false) {
  let response;
  try {
    response = await fetch(SAVE_URL + (metadata ? '?metadata=1' : ''), {
      method: body ? 'PUT' : 'GET', credentials: 'same-origin', cache: 'no-store',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30000),
    });
  } catch { throw new RequestError('网络连接中断，进度尚未同步。请保留此页面并重试。', 0); }
  let result;
  try { result = await response.json(); }
  catch { throw new RequestError('服务器响应无法读取，进度尚未同步。请稍后重试。', response.status || 502); }
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new RequestError('存档响应格式不正确，游戏已保留当前进度。', response.ok ? 502 : response.status);
  if (!response.ok) throw new RequestError(result.error || '存档未保存，请稍后重试。', response.status, result.code);
  if (typeof result.scope !== 'string' || !Number.isSafeInteger(result.revision)) throw new RequestError('存档响应格式不正确，游戏已保留当前进度。', 502);
  return result;
}

function halt(state, message) {
  if (haltReason === 'unauthorized') return;
  haltReason = state;
  halted = true;
  clearTimeout(startupTimer);
  // A conflicted run is paused but must still notice logout/account changes.
  if (state !== 'conflict') clearInterval(heartbeat);
  clearInterval(checkpoint);
  clearTimeout(snapshotTimer);
  window.HulingerDungeon?.pause?.();
  report(state, message);
}

function handleFailure(error) {
  clearTimeout(startupTimer);
  if (error.status === 401 || error.status === 403 || error.code === 'ACCOUNT_CHANGED') {
    halt('unauthorized', '登录已失效或账号已切换，游戏已停止。请重新登录后进入。');
  } else if (error.status === 409) {
    halt('conflict', '另一页面或设备已更新存档。当前游戏已暂停，先下载本次进度备份，再重新载入云端存档。');
  } else {
    const message = error.message || '同步失败，请保留此页面并重试。';
    const conflict = haltReason === 'conflict';
    report(conflict ? 'conflict' : 'error', conflict ? `游戏仍因存档冲突暂停。${message}` : message);
  }
}

async function synchronize() {
  if (!ready || halted) return false;
  if (busy) { pending = true; return busy; }
  async function uploadSnapshot() {
    try {
      const snapshot = await readSnapshot(database, localStorage, preferencePrefix);
      if (halted) return false;
      const canonical = canonicalSnapshot(snapshot);
      if (canonical === lastSaved) {
        dirty = false;
        report(updatedAt ? 'saved' : 'playing', updatedAt ? '进度已同步到当前账号' : '游戏已就绪，开始冒险后会自动保存');
        return true;
      }
      dirty = true;
      report('saving', '正在同步进度…');
      const result = await request({ scope, revision, snapshot });
      if (halted) return false;
      if (result.scope !== scope) throw new RequestError('账号已切换。', 403);
      revision = result.revision;
      updatedAt = result.updatedAt;
      lastSaved = canonical;
      dirty = pending;
      report('saved', '进度已同步到当前账号');
      return true;
    } catch (error) { handleFailure(error); return false; }
  }
  busy = (async () => {
    let success;
    do {
      pending = false;
      success = await uploadSnapshot();
    } while (success && pending && !halted);
    return success;
  })().finally(() => { busy = null; });
  return busy;
}

function queueSnapshot() {
  if (halted || !ready) return;
  dirty = true;
  if (busy) pending = true;
  clearTimeout(snapshotTimer);
  snapshotTimer = setTimeout(() => void synchronize(), 200);
}

async function saveNow() {
  if (!ready || halted) return false;
  // The Java engine only serializes a stable turn. Do not label a previous
  // checkpoint as the current turn when the hero is still moving/fighting.
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (halted) return false;
    if (window.HulingerDungeon.save()) {
      clearTimeout(snapshotTimer);
      return synchronize();
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  report('error', '当前回合尚未结束，请停止操作片刻后再次保存。');
  return false;
}

async function exportBackup() {
  if (!database || !ready) return;
  // Export remains available after a revision conflict, but an expired or
  // changed account is removed by the parent and cannot request an export.
  try {
    try {
      const current = await request(undefined, true);
      if (current.scope !== scope) throw new RequestError('账号已切换。', 403);
    } catch (error) {
      // A network outage must not prevent a player from rescuing their own
      // unsynced run. Explicit authentication/account failures still block it.
      if (error.status !== 0) throw error;
    }
    const snapshot = await readSnapshot(database, localStorage, preferencePrefix);
    if (haltReason === 'unauthorized') return;
    const document = { game: 'shattered-pixel-dungeon', formatVersion: 1, exportedAt: new Date().toISOString(), revision, snapshot };
    const url = URL.createObjectURL(new Blob([JSON.stringify(document)], { type: 'application/json' }));
    const anchor = window.document.createElement('a');
    anchor.href = url;
    anchor.download = `shattered-pixel-dungeon-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) { handleFailure(error); }
}

window.addEventListener('message', (event) => {
  if (event.source !== window.parent || event.origin !== window.location.origin || event.data?.channel !== CHANNEL) return;
  if (event.data.type === 'status-request') {
    if (namespace) window.parent.postMessage({ channel: CHANNEL, type: 'storage', namespace }, window.location.origin);
    if (latestStatus) window.parent.postMessage(latestStatus, window.location.origin);
  }
  if (event.data.type === 'save') void saveNow();
  if (event.data.type === 'export') void exportBackup();
  if (event.data.type === 'save-and-exit') {
    void saveNow().then((success) => {
      window.parent.postMessage({ channel: CHANNEL, type: 'exit-result', success }, window.location.origin);
    });
  }
});

window.addEventListener('hulinger-game-ready', () => {
  clearTimeout(startupTimer);
  if (halted) { window.HulingerDungeon?.pause?.(); return; }
  ready = true;
  loading.hidden = true;
  report('playing', '游戏已就绪，进度会自动同步');
  window.document.getElementById('canvas').focus();
  queueSnapshot();
});
window.addEventListener('hulinger-game-saved', queueSnapshot);
window.addEventListener('hulinger-game-save-error', () => report('error', '游戏未能生成存档，请保留此页面并重试。'));
window.addEventListener('beforeunload', (event) => { if (dirty) { event.preventDefault(); event.returnValue = ''; } });
document.addEventListener('contextmenu', (event) => event.preventDefault());
// Let Tab leave the canvas, even though the native game handles other keys.
document.addEventListener('keydown', (event) => { if (event.key === 'Tab') event.stopImmediatePropagation(); }, true);

async function start() {
  try {
    report('loading', '正在读取当前账号存档…');
    const initial = await request();
    scope = initial.scope;
    revision = initial.revision;
    updatedAt = initial.updatedAt;
    namespace = `hulinger-spd-${encodeURIComponent(scope)}-${crypto.randomUUID()}`;
    preferencePrefix = `pref:${namespace}:`;
    window.HulingerDungeon = { databaseName: namespace, storagePrefix: namespace };
    database = await openDatabase(namespace);
    await hydrateDatabase(database, initial.snapshot);
    for (const [key, value] of Object.entries(initial.snapshot?.prefs ?? {})) localStorage.setItem(preferencePrefix + key, value);
    // GameSettings stores String preferences with an "s" suffix. Use the
    // upstream Simplified Chinese locale only when the player has no choice.
    if (!Object.hasOwn(initial.snapshot?.prefs ?? {}, 'settings.xml:languages')) localStorage.setItem(preferencePrefix + 'settings.xml:languages', 'zh');
    lastSaved = canonicalSnapshot(initial.snapshot ?? { files: [], prefs: {} });
    window.parent.postMessage({ channel: CHANNEL, type: 'storage', namespace }, window.location.origin);
    report('loading', '正在加载游戏资源，首次进入需要下载约 74 MB…');
    startupTimer = setTimeout(() => {
      if (!ready && !halted) report('error', '游戏加载时间较长，尚未就绪。可以继续等待，或重新载入。');
    }, 180000);
    const script = document.createElement('script');
    script.src = './app.js';
    await new Promise((resolve, reject) => {
      script.onload = resolve;
      script.onerror = () => reject(new Error('游戏资源加载失败，请检查网络后重新载入。'));
      document.head.appendChild(script);
    });
    loading.hidden = true;
    window.main();
    heartbeat = setInterval(() => {
      void request(undefined, true).then((result) => {
        if (result.scope !== scope) throw new RequestError('账号已切换。', 403);
      }).catch(handleFailure);
    }, 15000);
    checkpoint = setInterval(() => { if (ready && !halted) window.HulingerDungeon.save(); }, 10000);
  } catch (error) { handleFailure(error); }
}

window.addEventListener('pagehide', () => {
  clearTimeout(startupTimer);
  clearInterval(heartbeat);
  clearInterval(checkpoint);
  clearTimeout(snapshotTimer);
  database?.close();
  if (namespace) indexedDB.deleteDatabase(namespace);
  if (preferencePrefix) {
    for (const key of Object.keys(collectPreferences(localStorage, preferencePrefix))) localStorage.removeItem(preferencePrefix + key);
  }
});

// The TeaVM backend disposes its scene on pagehide and this bridge closes its
// database. A BFCache restore must authenticate and hydrate a new run.
window.addEventListener('pageshow', (event) => { if (event.persisted) window.location.reload(); });

void start();
