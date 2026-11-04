import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { pool, query } from '../src/server/db';
import { persistItem, cleanupTrash } from '../src/server/collector/storage';
import type { CollectedItem } from '../src/server/collector/domain';
import type { HubEvent } from '../src/shared/contracts';

test('真实PostgreSQL：幂等、人工覆盖、修订、拆分保护及删除防复活', { skip: process.env.COLLECTOR_DATABASE_TEST !== '1', timeout: 30_000 }, async () => {
  assert.match(process.env.DATABASE_URL ?? '', /(?:localhost|127\.0\.0\.1).*\/(?:[a-z0-9_]*test)(?:\?|$)/iu, 'Integration tests require an explicit isolated local test database.');
  const prefix = `collector-test-${randomUUID()}`;
  const sourceA = { id: `${prefix}-a`, name: 'Synthetic Collector A' };
  const sourceB = { id: `${prefix}-b`, name: 'Synthetic Collector B' };
  const ids: string[] = [];
  const item: CollectedItem = {
    externalId: 'synthetic-item', title: 'Synthetic model release', summary: 'Original source summary',
    url: `https://example.invalid/${prefix}`, publishedAt: '2026-11-03T00:00:00.000Z', precision: 'instant',
    kind: 'model', tags: ['Synthetic'], entity: null, data: { summaryKind: 'source' },
  };
  try {
    for (const source of [sourceA, sourceB]) await query('INSERT INTO sources(id,name,kind,url) VALUES($1,$2,$3,$4)', [source.id, source.name, 'rss', item.url]);
    assert.equal(await persistItem(sourceA, item), 'added');
    const first = (await query<HubEvent>('SELECT e.* FROM events e JOIN source_records r ON r.event_id=e.id WHERE r.source_id=$1', [sourceA.id]))[0];
    ids.push(first.id);
    assert.equal(await persistItem(sourceA, item), 'skipped');
    assert.equal((await query('SELECT * FROM source_records WHERE source_id=$1', [sourceA.id])).length, 1);
    await query(`UPDATE events SET title='My manual title',overrides='{"title":"My manual title"}',personal=jsonb_set(personal,'{note}','"My private note"') WHERE id=$1`, [first.id]);
    assert.equal(await persistItem(sourceA, { ...item, title: 'Upstream corrected title', summary: 'Upstream corrected summary' }), 'updated');
    const corrected = (await query<HubEvent>('SELECT * FROM events WHERE id=$1', [first.id]))[0];
    assert.equal(corrected.title, 'My manual title');
    assert.equal(corrected.summary, 'Upstream corrected summary');
    assert.equal(corrected.originals.title, 'Upstream corrected title');
    assert.equal(corrected.personal.note, 'My private note');
    assert.equal((await query('SELECT * FROM revisions WHERE event_id=$1', [first.id])).length, 1);

    // A distinct source can link an exact, unambiguous event without copying it.
    const linkedItem = { ...item, title: String(corrected.originals.title), summary: corrected.summary };
    assert.equal(await persistItem(sourceB, linkedItem), 'updated');
    const records = await query<{ id: string; source_id: string; event_id: string }>('SELECT id,source_id,event_id FROM source_records WHERE source_id=ANY($1)', [[sourceA.id, sourceB.id]]);
    assert.equal(new Set(records.map((row) => row.event_id)).size, 1);
    // Simulate the owner's explicit split: future same-source updates stay attached.
    const splitId = randomUUID(); ids.push(splitId);
    await query(`INSERT INTO events(id,title,kind,url,source_name,originals) VALUES($1,$2,'model',$3,$4,$5)`, [splitId, 'Split human choice', item.url, sourceB.name, JSON.stringify({ primaryRecordId: records.find((row) => row.source_id === sourceB.id)!.id })]);
    await query('UPDATE source_records SET event_id=$1 WHERE source_id=$2', [splitId, sourceB.id]);
    await query('INSERT INTO separate_records(first_id,second_id) VALUES($1,$2)', [records[0].id, records[1].id]);
    await persistItem(sourceB, { ...linkedItem, summary: 'Rechecked after split' });
    assert.equal((await query<{ event_id: string }>('SELECT event_id FROM source_records WHERE source_id=$1', [sourceB.id]))[0].event_id, splitId);

    await query(`UPDATE events SET status='trash',deleted_at=now()-interval '31 days' WHERE id=$1`, [first.id]);
    const beforeTrashRecord = (await query<{ data: unknown }>('SELECT data FROM source_records WHERE source_id=$1', [sourceA.id]))[0].data;
    assert.equal(await persistItem(sourceA, { ...item, summary: 'Must not resurrect or overwrite trash' }), 'skipped');
    assert.deepEqual((await query<{ data: unknown }>('SELECT data FROM source_records WHERE source_id=$1', [sourceA.id]))[0].data, beforeTrashRecord);
    assert.equal(await cleanupTrash([first.id]), 1);
    assert.equal((await query('SELECT id FROM events WHERE id=$1', [first.id])).length, 0);
    const tombstone = (await query<{ excluded: boolean; data: unknown; event_id: string | null }>('SELECT excluded,data,event_id FROM source_records WHERE source_id=$1', [sourceA.id]))[0];
    assert.deepEqual(tombstone, { excluded: true, data: {}, event_id: null });
    assert.equal(await persistItem(sourceA, item), 'skipped');
    assert.equal((await query('SELECT id FROM events WHERE id=$1', [first.id])).length, 0);
  } finally {
    await query('DELETE FROM separate_records WHERE first_id IN (SELECT id FROM source_records WHERE source_id=ANY($1)) OR second_id IN (SELECT id FROM source_records WHERE source_id=ANY($1))', [[sourceA.id, sourceB.id]]);
    await query('DELETE FROM source_records WHERE source_id=ANY($1)', [[sourceA.id, sourceB.id]]);
    await query('DELETE FROM events WHERE id=ANY($1)', [ids]);
    await query('DELETE FROM sources WHERE id=ANY($1)', [[sourceA.id, sourceB.id]]);
    await pool.end();
  }
});
