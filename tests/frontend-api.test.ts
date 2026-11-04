import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApiError, requestHubData, requestJson } from '../src/components/api';
import type { HubData, HubEvent } from '../src/shared/contracts';

const emptyHub = () => ({ events: [], entities: [], sources: [], runs: [], later: [], total: 0, page: 1 });
const invalidResponse = (error: unknown) => error instanceof ApiError && error.code === 'INVALID_RESPONSE';

test('a 200 HTML response rejects rather than becoming a successful empty object', async (context) => {
  context.mock.method(globalThis, 'fetch', async () => new Response('<html>upstream error</html>', { status: 200 }));
  await assert.rejects(requestJson('/api/hub'), invalidResponse);
});

test('JSON null, scalars and arrays cannot masquerade as API response objects', async (context) => {
  for (const value of [null, 'unexpected', 42, [], true]) {
    context.mock.method(globalThis, 'fetch', async () => Response.json(value));
    await assert.rejects(requestJson('/api/hub'), invalidResponse);
  }
});

test('incomplete or malformed HubData is rejected before replacing the visible page data', async (context) => {
  const previous: HubData = emptyHub();
  const cases: unknown[] = [
    {},
    { ...emptyHub(), entities: undefined },
    ...['events', 'entities', 'sources', 'runs', 'later'].map((key) => ({ ...emptyHub(), [key]: {} })),
    { ...emptyHub(), total: -1 },
    { ...emptyHub(), total: '0' },
    { ...emptyHub(), total: 1.5 },
    { ...emptyHub(), page: 0 },
    { ...emptyHub(), page: 1.5 },
    { ...emptyHub(), entities: [null] },
    { ...emptyHub(), events: [{}] },
  ];
  for (const body of cases) {
    context.mock.method(globalThis, 'fetch', async () => Response.json(body));
    let visible = previous;
    await assert.rejects(requestHubData('/api/hub').then((next) => { visible = next; }), invalidResponse);
    assert.equal(visible, previous, 'invalid data must not reach the state update');
    assert.doesNotThrow(() => visible.entities.find(() => true));
  }
});

test('a genuine empty result remains valid and server errors retain actionable status', async (context) => {
  context.mock.method(globalThis, 'fetch', async () => Response.json(emptyHub()));
  assert.deepEqual(await requestHubData('/api/hub'), emptyHub());
  context.mock.method(globalThis, 'fetch', async () => Response.json({ error: '内容已更新', code: 'CONFLICT' }, { status: 409 }));
  await assert.rejects(requestJson('/api/hub'), (error) => error instanceof ApiError && error.status === 409 && error.code === 'CONFLICT' && error.message === '内容已更新');
});

test('valid records remain intact, including source values and private notes', async (context) => {
  const event: HubEvent = {
    id: 'synthetic-event', title: '合成测试资料', summary: '来源摘要', kind: 'model', url: 'https://example.com/post',
    published_at: null, published_precision: 'unknown', discovered_at: '2026-11-04T00:00:00Z', updated_at: '2026-11-04T00:00:00Z',
    entity_id: 'synthetic-model', source_name: '合成来源', review_reason: null, status: 'active', deleted_at: null, revision: 1, manual: false,
    personal: { favorite: true, later: true, read: false, archived: false, note: '合成私人备注' }, overrides: {}, tags: ['合成标签'], originals: { title: '合成测试资料' },
  };
  const valid: HubData = {
    ...emptyHub(), events: [event], later: [event], total: 1,
    entities: [{ id: 'synthetic-model', kind: 'model', name: '合成模型', url: 'https://example.com', data: {}, followed: true, revision: 1 }],
    sources: [{ id: 'synthetic-source', name: '合成来源', kind: 'rss', url: 'https://example.com/feed', enabled: true, interval_minutes: 60, config: {}, last_attempt: null, last_success: null, next_run: null, error: null, coverage: null }],
    runs: [{ id: 'synthetic-run', source_id: 'synthetic-source', status: 'success', started_at: '2026-11-04T00:00:00Z', finished_at: null, added: 1, updated: 0, skipped: 0, error: null, coverage: null }],
  };
  context.mock.method(globalThis, 'fetch', async () => Response.json(valid));
  assert.deepEqual(await requestHubData('/api/hub'), valid);
});
