import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

// Execute the actual bridge with browser/storage/network boundaries controlled.
// Only the module import and automatic startup are removed; lifecycle handlers
// and the request/synchronization code run unchanged.
const source = readFileSync(new URL('../src/game/shattered-pixel-dungeon/bootstrap.mjs', import.meta.url), 'utf8')
  .replace(/^import .*;\r?\n/m, '')
  .replace(/void start\(\);\s*$/, '');
type Listener = (event?: unknown) => void;
type Reply = { ok: boolean; status: number; json: () => Promise<unknown> };
const response = (status: number, body: unknown): Reply => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function bridge(initialResponse?: () => Promise<Reply>) {
  const statuses: string[] = [];
  const statusDetails: { state: string; ready: boolean }[] = [];
  const listeners = new Map<string, Listener>();
  const intervals = new Map<number, { callback: () => void; delay: number }>();
  const timers = new Map<number, () => void>();
  const preferences = new Map<string, string>();
  const scope = 'synthetic-lifecycle-account';
  const parent = { postMessage(message: { type: string; state?: string; ready?: boolean }) {
    if (message.type === 'status' && message.state) {
      statuses.push(message.state);
      statusDetails.push({ state: message.state, ready: message.ready === true });
    }
  } };
  let nextTimer = 1;
  let pauses = 0;
  let focusCalls = 0;
  let scriptsLoaded = 0;
  const network = {
    metadata: async (): Promise<Reply> => response(200, { scope, revision: 0, updatedAt: null }),
    upload: async (): Promise<Reply> => response(409, { error: 'Synthetic revision conflict' }),
  };
  const loading = { hidden: false, textContent: '' };
  const window: Record<string, unknown> = {
    location: { origin: 'https://synthetic.test' }, parent,
    addEventListener: (name: string, listener: Listener) => listeners.set(name, listener),
    main: () => {
      const engine = window.HulingerDungeon as Record<string, unknown>;
      engine.pause = () => { pauses += 1; };
      engine.save = () => true;
      listeners.get('hulinger-game-ready')?.();
    },
  };
  const document = {
    getElementById: (id: string) => id === 'loading' ? loading : { focus: () => { focusCalls += 1; } },
    addEventListener() {},
    createElement: () => ({ onload: undefined as (() => void) | undefined }),
    head: { appendChild: (script: { onload?: () => void }) => { scriptsLoaded += 1; script.onload?.(); } },
  };
  window.document = document;
  const context = createContext({
    window, document, console,
    crypto: { randomUUID: () => 'synthetic-run' },
    AbortSignal: { timeout: () => undefined },
    localStorage: {
      setItem: (key: string, value: string) => preferences.set(key, value),
      removeItem: (key: string) => preferences.delete(key),
    },
    indexedDB: { deleteDatabase() {} },
    openDatabase: async () => ({ close() {} }),
    hydrateDatabase: async () => {},
    collectPreferences: () => ({}),
    readSnapshot: async () => ({ files: [], prefs: { 'settings.xml:languages': 'zh' } }),
    canonicalSnapshot: JSON.stringify,
    fetch: async (url: string, init: { method: string }) => {
      if (init.method === 'PUT') return network.upload();
      if (url.includes('metadata=1')) return network.metadata();
      if (initialResponse) return initialResponse();
      return response(200, { scope, revision: 0, updatedAt: null, snapshot: null });
    },
    setInterval: (callback: () => void, delay: number) => {
      const id = nextTimer++;
      intervals.set(id, { callback, delay });
      return id;
    },
    clearInterval: (id: number) => intervals.delete(id),
    setTimeout: (callback: () => void) => {
      const id = nextTimer++;
      timers.set(id, callback);
      return id;
    },
    clearTimeout: (id: number) => timers.delete(id),
  });
  runInContext(source, context);
  await runInContext('start()', context);
  if (!initialResponse) assert.equal(statuses.at(-1), 'playing', 'the real startup must reach ready before testing lifecycle transitions');
  return {
    statuses, statusDetails, network, scope,
    paused: () => pauses,
    focused: () => focusCalls,
    scriptsLoaded: () => scriptsLoaded,
    activeIntervals: () => intervals.size,
    heartbeat: () => {
      const interval = [...intervals.values()].find(({ delay }) => delay === 15000);
      assert.ok(interval, 'identity heartbeat must remain active while the game is conflicted');
      interval.callback();
    },
    emit: (name: string) => listeners.get(name)?.(),
    save: () => listeners.get('message')?.({ source: parent, origin: 'https://synthetic.test', data: { channel: 'hulinger-dungeon-v1', type: 'save' } }),
    requestStatus: ({ fromParent = true, origin = 'https://synthetic.test' } = {}) => listeners.get('message')?.({
      source: fromParent ? parent : {}, origin, data: { channel: 'hulinger-dungeon-v1', type: 'status-request' },
    }),
  };
}

test('an expired identity remains terminal when an overlapping heartbeat later fails offline', async () => {
  const game = await bridge();
  const expired = deferred<Reply>();
  const offline = deferred<Reply>();
  const responses = [expired.promise, offline.promise];
  game.network.metadata = () => responses.shift()!;
  game.heartbeat();
  game.heartbeat();
  expired.resolve(response(401, { error: 'Synthetic expired session' }));
  await flush();
  assert.equal(game.statuses.at(-1), 'unauthorized');
  offline.reject(new Error('Synthetic offline response arriving later'));
  await flush();
  assert.equal(game.statuses.at(-1), 'unauthorized');
  assert.equal(game.activeIntervals(), 0);
});

test('a late engine save error cannot replace the conflict pause state', async () => {
  const game = await bridge();
  game.save();
  await flush();
  assert.equal(game.statuses.at(-1), 'conflict');
  game.emit('hulinger-game-save-error');
  assert.equal(game.statuses.at(-1), 'conflict');
  assert.ok(game.paused() > 0);
});

test('a conflicted game keeps checking identity and upgrades to unauthorized after logout', async () => {
  const game = await bridge();
  game.save();
  await flush();
  assert.equal(game.statuses.at(-1), 'conflict');
  game.network.metadata = async () => response(403, { error: 'Synthetic revoked session' });
  game.heartbeat();
  await flush();
  assert.equal(game.statuses.at(-1), 'unauthorized');
  assert.equal(game.activeIntervals(), 0);
});

test('a late engine ready event cannot resume a game whose identity expired', async () => {
  const game = await bridge();
  game.network.metadata = async () => response(401, { error: 'Synthetic expired session' });
  game.heartbeat();
  await flush();
  const focusCalls = game.focused();
  game.emit('hulinger-game-ready');
  assert.equal(game.statuses.at(-1), 'unauthorized');
  assert.equal(game.focused(), focusCalls, 'a stopped frame must not reclaim keyboard focus');
});

test('an explicit HTTP identity rejection remains unauthorized even when its JSON body is malformed', async () => {
  for (const status of [401, 403]) {
    for (const body of [null, []]) {
      const game = await bridge();
      game.network.metadata = async () => response(status, body);
      game.heartbeat();
      await flush();
      assert.equal(game.statuses.at(-1), 'unauthorized', `HTTP ${status} with ${body === null ? 'null' : 'array'} JSON must remain an identity rejection`);
      assert.equal(game.activeIntervals(), 0);
      assert.ok(game.paused() > 0);
    }
  }
});

test('a save response arriving after identity expiry cannot report the game as saved again', async () => {
  const game = await bridge();
  const upload = deferred<Reply>();
  game.network.upload = () => upload.promise;
  game.save();
  await flush();
  assert.equal(game.statuses.at(-1), 'saving');
  game.network.metadata = async () => response(401, { error: 'Synthetic expired session' });
  game.heartbeat();
  await flush();
  assert.equal(game.statuses.at(-1), 'unauthorized');
  upload.resolve(response(200, { scope: game.scope, revision: 1, updatedAt: '2026-11-06T00:00:00.000Z' }));
  await flush();
  assert.equal(game.statuses.at(-1), 'unauthorized');
});

for (const [name, body] of [['null', null], ['array', []]] as const) {
  test(`an early ${name} startup response can be recovered only by the trusted parent status handshake`, async () => {
    const game = await bridge(async () => response(200, body));
    assert.deepEqual(game.statusDetails.at(-1), { state: 'error', ready: false });
    assert.equal(game.scriptsLoaded(), 0, 'invalid account data must not start the game engine');
    // Model a parent listener installed after all of these initial messages.
    game.statuses.length = 0;
    game.statusDetails.length = 0;
    game.requestStatus({ fromParent: false });
    game.requestStatus({ origin: 'https://untrusted.test' });
    assert.equal(game.statusDetails.length, 0, 'other windows and origins cannot request bridge status');
    game.requestStatus();
    assert.deepEqual(game.statusDetails, [{ state: 'error', ready: false }]);
    assert.equal(game.scriptsLoaded(), 0);
  });
}
