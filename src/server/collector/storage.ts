import { randomUUID, createHash } from 'node:crypto';
import { transaction } from '../db';
import type { HubEvent, Source } from '../../shared/contracts';
import { stableId, type CollectedItem } from './domain';

export type PersistResult = 'added' | 'updated' | 'skipped';

export async function persistItem(source: Pick<Source, 'id' | 'name'>, item: CollectedItem): Promise<PersistResult> {
  return transaction(async (client) => {
    // The URL lock also serializes exact cross-source matches without fuzzy merging.
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`collector:${item.url}`]);
    const recordId = stableId('record', `${source.id}\0${item.externalId}`);
    const prior = (await client.query<{ id: string; event_id: string | null; excluded: boolean; data: Record<string, unknown> }>(
      'SELECT id,event_id,excluded,data FROM source_records WHERE source_id=$1 AND external_id=$2 FOR UPDATE', [source.id, item.externalId],
    )).rows[0];
    if (prior && (prior.excluded || !prior.event_id)) {
      await client.query('UPDATE source_records SET last_seen=now() WHERE id=$1', [prior.id]);
      return 'skipped';
    }
    const automatic = {
      title: item.title, summary: item.summary, kind: item.kind, url: item.url, published_at: item.publishedAt,
      published_precision: item.precision, entity_id: item.entity?.id ?? null, tags: item.tags,
    };
    const fingerprint = createHash('sha256').update(JSON.stringify({ ...automatic, data: item.data, reviewReason: item.reviewReason })).digest('hex');
    if (prior?.data.fingerprint === fingerprint) {
      await client.query('UPDATE source_records SET last_seen=now() WHERE id=$1', [prior.id]);
      return 'skipped';
    }

    let event: HubEvent | undefined;
    if (prior?.event_id) {
      event = (await client.query<HubEvent>('SELECT * FROM events WHERE id=$1 FOR UPDATE', [prior.event_id])).rows[0];
      if (!event || ['excluded', 'trash', 'merged'].includes(event.status)) {
        await client.query('UPDATE source_records SET last_seen=now() WHERE id=$1', [prior.id]);
        return 'skipped';
      }
    }
    if (item.entity) {
      await client.query(`INSERT INTO entities (id,kind,name,url,data) VALUES($1,$2,$3,$4,$5)
        ON CONFLICT(id) DO UPDATE SET data=entities.data || EXCLUDED.data`,
      [item.entity.id, item.entity.kind, item.entity.name, item.entity.url, JSON.stringify(item.entity.data)]);
    }

    let reviewReason = item.reviewReason ?? null;
    if (!event) {
      const matches = (await client.query<HubEvent>(`SELECT e.* FROM events e WHERE e.url=$1 AND COALESCE(e.originals->>'kind',e.kind)=$2
        AND e.status IN ('active','review') AND COALESCE(e.originals->>'title',e.title)=$3 AND e.published_at IS NOT DISTINCT FROM $4::timestamptz
        AND NOT EXISTS (SELECT 1 FROM source_records r JOIN separate_records s ON
          (s.first_id=r.id AND s.second_id=$5) OR (s.second_id=r.id AND s.first_id=$5) WHERE r.event_id=e.id)
        ORDER BY e.discovered_at LIMIT 2 FOR UPDATE OF e`,
      [item.url, item.kind, item.title, item.publishedAt, recordId])).rows;
      // A shared canonical URL plus identical title and timestamp is strong evidence;
      // ambiguous identities stay separate for the owner to review.
      if (matches.length === 1 && !item.reviewReason) event = matches[0];
      else if (matches.length > 1) reviewReason = '同一来源链接关联多个事件，需要人工核对';
      if (!event && !reviewReason) {
        const possible = await client.query(`SELECT id FROM events WHERE status IN ('active','review')
          AND COALESCE(originals->>'title',title)=$1 AND COALESCE(originals->>'kind',kind)=$2
          AND (url=$3 OR (published_at IS NOT DISTINCT FROM $4::timestamptz)) LIMIT 1`,
        [item.title, item.kind, item.url, item.publishedAt]);
        if (possible.rowCount) reviewReason = '标题或链接对应已有事件，但来源身份不充分，请核对是否重复';
      }
    }

    if (!event) {
      const id = randomUUID();
      await client.query(`INSERT INTO events(id,title,summary,kind,url,published_at,published_precision,entity_id,
        source_name,status,review_reason,tags,originals) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [id, item.title, item.summary, item.kind, item.url, item.publishedAt, item.precision, item.entity?.id ?? null,
        source.name, reviewReason ? 'review' : 'active', reviewReason, item.tags, JSON.stringify({ ...automatic, primaryRecordId: recordId })]);
      await client.query(`INSERT INTO source_records(id,source_id,external_id,event_id,data) VALUES($1,$2,$3,$4,$5)`,
        [recordId, source.id, item.externalId, id, JSON.stringify({ ...automatic, ...item.data, fingerprint })]);
      return 'added';
    }

    await client.query(`INSERT INTO source_records(id,source_id,external_id,event_id,data) VALUES($1,$2,$3,$4,$5)
      ON CONFLICT(source_id,external_id) DO UPDATE SET data=EXCLUDED.data,last_seen=now()`,
    [recordId, source.id, item.externalId, event.id, JSON.stringify({ ...automatic, ...item.data, fingerprint })]);
    // A secondary source never silently replaces the chosen primary source. The
    // detail view can inspect every current source record independently.
    const isPrimary = event.originals.primaryRecordId === recordId;
    if (isPrimary) {
      await client.query(`UPDATE events SET
        title=CASE WHEN manual OR overrides ? 'title' THEN title ELSE $2 END,
        summary=CASE WHEN manual OR overrides ? 'summary' THEN summary ELSE $3 END,
        kind=CASE WHEN manual OR overrides ? 'kind' THEN kind ELSE $4 END,
        entity_id=CASE WHEN manual OR overrides ? 'entity_id' THEN entity_id ELSE $5 END,
        tags=CASE WHEN manual OR overrides ? 'tags' THEN tags ELSE $6 END,
        published_at=$7,published_precision=$8,originals=$9,
        url=CASE WHEN manual OR overrides ? 'url' THEN url ELSE $10 END,
        status=CASE WHEN status='active' AND $11::text IS NOT NULL AND NOT manual AND NOT (overrides ? 'kind') THEN 'review' ELSE status END,
        review_reason=CASE WHEN $11::text IS NOT NULL AND NOT manual AND NOT (overrides ? 'kind') THEN $11 ELSE review_reason END,
        updated_at=now(),revision=revision+1
        WHERE id=$1`, [event.id, item.title, item.summary, item.kind, item.entity?.id ?? null, item.tags,
        item.publishedAt, item.precision, JSON.stringify({ ...automatic, primaryRecordId: recordId, sourceUpdated: Boolean(prior) }), item.url, reviewReason]);
    } else {
      await client.query('UPDATE events SET updated_at=now(),revision=revision+1 WHERE id=$1', [event.id]);
    }
    const after = (await client.query<HubEvent>('SELECT * FROM events WHERE id=$1', [event.id])).rows[0];
    await client.query('INSERT INTO revisions(id,event_id,action,before_data,after_data) VALUES($1,$2,$3,$4,$5)',
      [randomUUID(), event.id, prior ? 'source-updated' : 'source-linked', JSON.stringify(event), JSON.stringify(after)]);
    return 'updated';
  });
}

export async function cleanupTrash(eventIds?: string[]): Promise<number> {
  return transaction(async (client) => {
    const expired = (await client.query<{ id: string }>(`SELECT id FROM events WHERE status='trash'
      AND deleted_at < now()-interval '30 days' AND ($1::text[] IS NULL OR id=ANY($1)) FOR UPDATE SKIP LOCKED`, [eventIds ?? null])).rows;
    for (const { id } of expired) {
      // Keep only stable source identity and suppression, not copies of deleted content.
      await client.query(`UPDATE source_records SET data='{}',excluded=true,event_id=NULL WHERE event_id=$1`, [id]);
      await client.query(`DELETE FROM merge_operations WHERE target_id=$1
        OR jsonb_path_exists(snapshot,'$.** ? (@.id == $eventId)',jsonb_build_object('eventId',$1::text))`, [id]);
      await client.query('DELETE FROM events WHERE id=$1', [id]);
    }
    return expired.length;
  });
}
