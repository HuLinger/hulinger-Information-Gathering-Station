import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { pool, accountQuery as query, accountTransaction as transaction, withAccountScope } from '../src/server/db';
import { persistItem, cleanupTrash } from '../src/server/collector/storage';
import { DomainError, executeDomain } from '../src/server/domain';
import type { CollectedItem } from '../src/server/collector/domain';
import type { HubEvent } from '../src/shared/contracts';

test('真实PostgreSQL：幂等、人工覆盖、修订、拆分保护及删除防复活', { skip: process.env.COLLECTOR_DATABASE_TEST !== '1', timeout: 30_000 }, async () => {
  assert.match(process.env.DATABASE_URL ?? '', /(?:localhost|127\.0\.0\.1).*\/(?:[a-z0-9_]*test)(?:\?|$)/iu, 'Integration tests require an explicit isolated local test database.');
  const accountId=`collector-${randomUUID()}`;
  await pool.query('INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,$1,$2,true,now(),now())',[accountId,`${accountId}@example.test`]);
  return withAccountScope(accountId,async()=>{
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

    let signalLocked!: () => void;
    let releaseOwner!: () => void;
    const ownerLocked = new Promise<void>((resolve) => { signalLocked = resolve; });
    const mayUpdateRecords = new Promise<void>((resolve) => { releaseOwner = resolve; });
    const ownerOperation = transaction(async (client) => {
      await client.query('SELECT id FROM events WHERE id=$1 FOR UPDATE', [first.id]);
      signalLocked();
      await mayUpdateRecords;
      await client.query('UPDATE source_records SET last_seen=last_seen WHERE event_id=$1', [first.id]);
    });
    await ownerLocked;
    const concurrentCollection = persistItem(sourceA, { ...item, summary: 'Concurrent upstream update' });
    await new Promise((resolve) => setTimeout(resolve, 100));
    releaseOwner();
    await Promise.all([ownerOperation, concurrentCollection]);
    assert.equal((await query<HubEvent>('SELECT * FROM events WHERE id=$1', [first.id]))[0].personal.note, 'My private note');

    const sharedItem = { ...item, externalId: 'concurrent-manual-item', url: `${item.url}/concurrent`, title: `${prefix} concurrent create` };
    const blocker = await pool.connect();
    let outcomes: PromiseSettledResult<unknown>[] = [];
    try {
      await blocker.query('BEGIN');
      // Let duplicate reads finish while both insert paths wait. Without a
      // shared URL lock each path sees no event and inserts its own copy.
      await blocker.query('LOCK TABLE events IN SHARE MODE');
      const operations = Promise.allSettled([
        executeDomain({ action: 'create', title: sharedItem.title, summary: 'Manual summary', kind: sharedItem.kind, url: sharedItem.url, published_at: sharedItem.publishedAt, tags: [], note: '' }),
        persistItem(sourceB, sharedItem),
      ]);
      try {
        let waiting = false;
        for (let attempt = 0; attempt < 200; attempt += 1) {
          const rows = await query<{ count: number }>(`SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database()
            AND wait_event_type='Lock' AND (query LIKE 'INSERT INTO events(%' OR query LIKE 'SELECT pg_advisory_xact_lock(hashtextextended(%')`);
          if (rows[0].count >= 2) { waiting = true; break; }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.equal(waiting, true, 'Both create paths must reach the controlled lock barrier');
      } finally {
        await blocker.query('ROLLBACK');
        outcomes = await operations;
      }
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
    }
    const sharedEvents = await query<HubEvent>('SELECT * FROM events WHERE url=$1', [sharedItem.url]);
    ids.push(...sharedEvents.map((event) => event.id));
    assert.equal(outcomes[1].status, 'fulfilled', 'Collection must attach to the single event');
    if (outcomes[0].status === 'rejected') {
      assert(outcomes[0].reason instanceof DomainError && outcomes[0].reason.code === 'DUPLICATE');
    }
    assert.equal(sharedEvents.length, 1, 'Manual creation and collection must not create duplicate events');
    const sharedRecords = await query<{ event_id: string }>('SELECT event_id FROM source_records WHERE source_id=$1 AND external_id=$2', [sourceB.id, sharedItem.externalId]);
    assert.deepEqual(sharedRecords, [{ event_id: sharedEvents[0].id }]);

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
    await pool.query('DELETE FROM "user" WHERE id=$1',[accountId]);
    await pool.end();
  }
  });
});
