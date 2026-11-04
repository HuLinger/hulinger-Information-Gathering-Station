import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { PoolClient } from 'pg';
import { query, transaction } from './db';
import type { HubEvent, Personal, Revision } from '../shared/contracts';

export class DomainError extends Error {
  constructor(message: string, public status = 400, public code = 'INVALID_INPUT') { super(message); }
}
export const defaultPersonal: Personal = {favorite:false,later:false,read:false,archived:false,note:''};
const id = z.string().min(1).max(150);
const ids = z.array(id).min(1).max(100).refine(v=>new Set(v).size===v.length,'不能重复选择');
const kind = z.enum(['model','project','tool']);
const personalSchema = z.object({favorite:z.boolean(),later:z.boolean(),read:z.boolean(),archived:z.boolean(),note:z.string().max(20000)});
const tags = z.array(z.string().trim().min(1).max(50)).max(30);
export const safeUrl = z.string().max(2048).url().refine(value=>{
  const url=new URL(value); return ['https:','http:'].includes(url.protocol)&&!url.username&&!url.password;
},'仅支持不含凭据的 HTTP / HTTPS 链接');
const patch = z.object({title:z.string().trim().min(1).max(500).optional(),summary:z.string().max(10000).optional(),kind:kind.optional(),entity_id:id.nullable().optional(),tags:tags.optional(),personal:personalSchema.partial().optional()}).strict();
export const actionSchema = z.discriminatedUnion('action',[
  z.object({action:z.literal('create'),title:z.string().trim().min(1).max(500),summary:z.string().max(10000).default(''),url:safeUrl,kind,published_at:z.string().datetime({offset:true}).nullable().optional(),published_precision:z.enum(['date','datetime','unknown']).optional(),entity_id:id.nullable().optional(),tags:tags.default([]),note:z.string().max(20000).default('')}),
  z.object({action:z.literal('update'),id,revision:z.number().int().positive(),patch,reset:z.array(z.enum(['title','summary','kind','entity_id','tags'])).optional()}),
  z.object({action:z.literal('batch'),ids,personal:personalSchema.partial()}),
  z.object({action:z.literal('status'),ids,status:z.enum(['active','review','excluded','trash','delete'])}),
  z.object({action:z.literal('follow'),id,followed:z.boolean()}),
  z.object({action:z.literal('mergePreview'),ids:ids.refine(v=>v.length>=2)}),
  z.object({action:z.literal('merge'),ids:ids.refine(v=>v.length>=2),revisions:z.record(z.string(),z.number().int()),title:z.string().trim().min(1).max(500),summary:z.string().max(10000),personal:personalSchema,tags}),
  z.object({action:z.literal('split'),id,revision:z.number().int(),groups:z.array(z.object({recordIds:ids,title:z.string().trim().min(1).max(500),personal:personalSchema,tags})).min(2).max(20)}),
  z.object({action:z.literal('undoMerge'),id,revision:z.number().int()}),
  z.object({action:z.literal('restoreRevision'),id,revision:z.number().int(),historyId:id}),
  z.object({action:z.literal('source'),id,enabled:z.boolean().optional(),config:z.record(z.string(),z.unknown()).optional()}),
  z.object({action:z.literal('sync'),id}),
  z.object({action:z.literal('export')})
]);
export type Action = z.infer<typeof actionSchema>;

export function assertRevision(event: HubEvent, revision: number) {
  if(event.revision!==revision) throw new DomainError('此内容已在另一处更新，请重新查看差异后保存。',409,'CONFLICT');
}
async function locked(client: PoolClient, eventId: string): Promise<HubEvent> {
  const row=(await client.query<HubEvent>('SELECT * FROM events WHERE id=$1 FOR UPDATE',[eventId])).rows[0];
  if(!row) throw new DomainError('内容不存在或已永久删除。',404,'NOT_FOUND');
  return row;
}
async function history(client:PoolClient,before:HubEvent|null,after:HubEvent,action:string) {
  await client.query('INSERT INTO revisions(id,event_id,action,before_data,after_data) VALUES($1,$2,$3,$4,$5)',[randomUUID(),after.id,action,before,after]);
}
async function write(client:PoolClient,before:HubEvent,after:HubEvent,action:string) {
  const result=await client.query<HubEvent>(`UPDATE events SET title=$2,summary=$3,kind=$4,entity_id=$5,status=$6,deleted_at=$7,personal=$8,overrides=$9,tags=$10,revision=revision+1,updated_at=now(),review_reason=$11,originals=$12,url=$13,source_name=$14,published_at=$15,published_precision=$16 WHERE id=$1 RETURNING *`,
    [after.id,after.title,after.summary,after.kind,after.entity_id,after.status,after.deleted_at,after.personal,after.overrides,after.tags,after.review_reason,after.originals,after.url,after.source_name,after.published_at,after.published_precision]);
  await history(client,before,result.rows[0],action); return result.rows[0];
}
function requireEditable(event:HubEvent) {
  if(['trash','merged','excluded'].includes(event.status)) throw new DomainError('请先恢复此内容，再进行修改。',409,'INACTIVE');
}
export function applyPatch(event:HubEvent,changes:z.infer<typeof patch>,reset:string[]=[]):HubEvent {
  const next=structuredClone(event);
  for(const key of reset) {
    delete next.overrides[key];
    if(key==='title'&&typeof next.originals.title==='string') next.title=next.originals.title;
    if(key==='summary'&&typeof next.originals.summary==='string') next.summary=next.originals.summary;
    if(key==='kind'&&['model','project','tool'].includes(String(next.originals.kind))) next.kind=next.originals.kind as HubEvent['kind'];
    if(key==='entity_id') next.entity_id=typeof next.originals.entity_id==='string'?next.originals.entity_id:null;
    if(key==='tags') next.tags=Array.isArray(next.originals.tags)?next.originals.tags as string[]:[];
  }
  for(const key of ['title','summary','kind','entity_id','tags'] as const) {
    if(changes[key]!==undefined) { Object.assign(next,{[key]:changes[key]}); next.overrides[key]=changes[key]; }
  }
  if(changes.personal) next.personal={...next.personal,...changes.personal};
  return next;
}
export async function getDetail(eventId:string) {
  id.parse(eventId);
  const event=(await query<HubEvent>('SELECT * FROM events WHERE id=$1',[eventId]))[0];
  if(!event) throw new DomainError('内容不存在或已永久删除。',404,'NOT_FOUND');
  const [records,historyRows]=await Promise.all([
    query('SELECT * FROM source_records WHERE event_id=$1 ORDER BY first_seen',[eventId]),
    query<Revision>('SELECT * FROM revisions WHERE event_id=$1 ORDER BY created_at DESC LIMIT 100',[eventId])
  ]);
  return {event,records,history:historyRows};
}

export async function listHub(params:URLSearchParams) {
  const values:unknown[]=[]; const conditions:string[]=[];
  const bind=(value:unknown)=>{values.push(value);return `$${values.length}`;};
  const section=params.get('section');
  const allowedStates=['review','excluded','trash'];
  if(section&&allowedStates.includes(section)) conditions.push(`e.status=${bind(section)}`);
  else {conditions.push("e.status='active'");if(!section&&!params.get('entity')&&!['search','models','projects'].includes(params.get('view')??'feed')) conditions.push("NOT (e.personal->>'archived')::boolean");}
  if(section&&['favorite','later','archived'].includes(section)) conditions.push(`(e.personal->>${bind(section)})::boolean=true`);
  if(params.get('unread')==='1') conditions.push("NOT (e.personal->>'read')::boolean");
  if(params.get('followed')==='1') conditions.push('EXISTS(SELECT 1 FROM entities n WHERE n.id=e.entity_id AND n.followed)');
  for(const [param,column] of [['kind','kind'],['source','source_name'],['entity','entity_id']] as const) if(params.get(param)) conditions.push(`e.${column}=${bind(params.get(param))}`);
  if(params.get('tag')) conditions.push(`${bind(params.get('tag'))}=ANY(e.tags)`);
  const search=params.get('q')?.trim().slice(0,300);
  if(search) {const term=bind(`%${search.replace(/[\\%_]/g,'\\$&')}%`);conditions.push(`(e.title ILIKE ${term} OR e.summary ILIKE ${term} OR e.personal->>'note' ILIKE ${term} OR EXISTS(SELECT 1 FROM unnest(e.tags) tag WHERE tag ILIKE ${term}) OR EXISTS(SELECT 1 FROM entities n WHERE n.id=e.entity_id AND n.name ILIKE ${term}))`);}
  for(const [param,op] of [['from','>='],['to','<']] as const) {
    const date=params.get(param);
    if(date) {if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||Number.isNaN(Date.parse(date)))throw new DomainError('日期格式无效');conditions.push(`e.published_at ${op} ${bind(`${date}T00:00:00+08:00`)}::timestamptz${param==='to'?" + interval '1 day'":''}`);}
  }
  if(params.get('dateUnknown')==='1') conditions.push('e.published_at IS NULL');
  const page=Math.max(1,Math.min(50000,Number(params.get('page'))||1));
  if(!Number.isInteger(page))throw new DomainError('页码无效');
  const where=conditions.join(' AND ');
  const [events,count,entities,sources,runs,later]=await Promise.all([
    query<HubEvent>(`SELECT e.* FROM events e WHERE ${where} ORDER BY COALESCE(e.published_at,e.discovered_at) DESC,e.id LIMIT 20 OFFSET ${bind((page-1)*20)}`,values),
    query<{count:string}>(`SELECT count(*) FROM events e WHERE ${where}`,values.slice(0,-1)),
    // The entity catalog also supplies stable names/options in details and edits.
    // Filtering it by an event's private-note search would hide its association.
    query('SELECT * FROM entities ORDER BY followed DESC,name LIMIT 500'),
    query('SELECT * FROM sources ORDER BY name'), query('SELECT * FROM sync_runs ORDER BY started_at DESC LIMIT 50'),
    query<HubEvent>("SELECT * FROM events WHERE status='active' AND (personal->>'later')::boolean ORDER BY updated_at DESC LIMIT 5")
  ]);
  for(const entity of entities)for(const key of ['growth24h','growth7d']) {
    const point=entity.data?.[key];
    if(point?.endAt&&Date.now()-Date.parse(point.endAt)>12*3600000)point.status='stale';
  }
  return {events,total:Number(count[0].count),entities,sources,runs,later,page};
}

export async function executeDomain(action:Action) {
  return transaction(async client=>{
    if(action.action==='create') {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['content-url:'+action.url]);
      const duplicate=(await client.query<{id:string}>('SELECT id FROM events WHERE url=$1 AND status<>\'merged\' LIMIT 1',[action.url])).rows[0];
      if(duplicate) throw new DomainError(`此链接已存在，可查看或恢复已有内容。`,409,'DUPLICATE');
      const event=(await client.query<HubEvent>(`INSERT INTO events(id,title,summary,kind,url,published_at,published_precision,entity_id,source_name,manual,personal,tags,originals) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'人工补充',true,$9,$10,$11) RETURNING *`,[randomUUID(),action.title,action.summary,action.kind,action.url,action.published_at??null,action.published_at?(action.published_precision??'datetime'):'unknown',action.entity_id??null,{...defaultPersonal,note:action.note},action.tags,{title:action.title,summary:action.summary,kind:action.kind,entity_id:action.entity_id??null,tags:action.tags}])).rows[0];
      await history(client,null,event,'人工补充'); return {event};
    }
    if(action.action==='update') {
      const before=await locked(client,action.id); requireEditable(before); assertRevision(before,action.revision);
      return {event:await write(client,before,applyPatch(before,action.patch,action.reset),'人工修正')};
    }
    if(action.action==='follow') {
      const result=await client.query('UPDATE entities SET followed=$2,revision=revision+1 WHERE id=$1 RETURNING *',[action.id,action.followed]);
      if(!result.rowCount)throw new DomainError('对象不存在',404);return {entity:result.rows[0]};
    }
    if(action.action==='batch'||action.action==='status') {
      // Lock in canonical order: simultaneous bulk operations cannot deadlock each other.
      const results=[];
      for(const eventId of [...action.ids].sort()) {
        const before=await locked(client,eventId); const after=structuredClone(before);
        if(action.action==='batch') {requireEditable(before);after.personal={...before.personal,...action.personal};}
        else if(action.status==='delete') {
          if(before.status!=='trash')throw new DomainError('永久删除前请先移入回收站',409);
          // Retain identifiers only. Source content and personal text are removed.
          await client.query("UPDATE source_records SET event_id=NULL,data='{}',excluded=true WHERE event_id=$1",[eventId]);
          await client.query('DELETE FROM merge_operations WHERE target_id=$1 OR snapshot::text LIKE $2',[eventId,`%${eventId}%`]);
          await client.query('DELETE FROM events WHERE id=$1',[eventId]);
          results.push({id:eventId,deleted:true}); continue;
        } else {
          if(before.status==='merged')throw new DomainError('合并内容请先撤销合并',409);
          if(action.status==='active'&&before.status==='trash'&&before.deleted_at&&Date.now()-new Date(before.deleted_at).getTime()>30*86400000)throw new DomainError('已超过30天可恢复期限',409);
          if(action.status==='excluded'&&before.status!=='review')throw new DomainError('只有需核对内容可以排除',409);
          after.status=action.status;after.deleted_at=action.status==='trash'?new Date().toISOString():null;
          if(action.status==='active')after.review_reason=null;
          await client.query('UPDATE source_records SET excluded=$2 WHERE event_id=$1',[eventId,['excluded','trash'].includes(action.status)]);
        }
        results.push({id:eventId,event:await write(client,before,after,action.action==='batch'?'批量整理':'状态变更')});
      }
      return {results};
    }
    if(action.action==='restoreRevision') {
      const before=await locked(client,action.id);requireEditable(before);assertRevision(before,action.revision);
      const revision=(await client.query<Revision>('SELECT * FROM revisions WHERE id=$1 AND event_id=$2',[action.historyId,action.id])).rows[0];
      if(!revision?.after_data)throw new DomainError('修订不存在',404);
      const old=revision.after_data;
      const next=applyPatch(before,{title:old.title,summary:old.summary,kind:old.kind,entity_id:old.entity_id,tags:old.tags,personal:old.personal});
      return {event:await write(client,before,next,'恢复修订')};
    }
    if(action.action==='mergePreview'||action.action==='merge') {
      const sorted:HubEvent[]=[];for(const eventId of [...action.ids].sort())sorted.push(await locked(client,eventId));
      const events=action.ids.map(eventId=>sorted.find(e=>e.id===eventId)!);events.forEach(requireEditable);
      const records=(await client.query('SELECT * FROM source_records WHERE event_id=ANY($1::text[]) ORDER BY first_seen',[action.ids])).rows;
      const conflicts:string[]=[];
      if(new Set(events.map(e=>e.kind)).size>1)conflicts.push('内容类型不同，不能合并。');
      if(new Set(events.map(e=>e.entity_id).filter(Boolean)).size>1)conflicts.push('关联实体不同，请先核对并修正。');
      const releaseTags=new Set(records.map(record=>record.data?.tag).filter((tag:unknown)=>typeof tag==='string'&&tag));
      if(releaseTags.size>1)conflicts.push('版本标识不同；不同版本必须保留为独立事件。');
      const separated=(await client.query('SELECT 1 FROM separate_records WHERE first_id=ANY($1::text[]) AND second_id=ANY($1::text[]) LIMIT 1',[records.map(r=>r.id)])).rowCount;
      if(separated)conflicts.push('这些来源曾被拆分，禁止再次自动或批量合并。');
      if(events.some(e=>Object.keys(e.overrides).length))conflicts.push('包含人工覆盖；原始事件与覆盖将完整保存在合并记录中，可撤销。');
      if(new Set(events.map(e=>e.personal.note)).size>1)conflicts.push('备注不同；请在确认内容中保留全部需要的备注。');
      if(action.action==='mergePreview')return {events,records,conflicts};
      if(new Set(events.map(e=>e.kind)).size>1||new Set(events.map(e=>e.entity_id).filter(Boolean)).size>1||releaseTags.size>1||separated)throw new DomainError('当前候选不能合并，请处理类型、实体、版本或拆分关系。',409);
      events.forEach(e=>assertRevision(e,action.revisions[e.id]));
      const target=events[0];
      const requiredNotes=events.map(e=>e.personal.note).filter(Boolean);
      if(requiredNotes.some(n=>!action.personal.note.includes(n)))throw new DomainError('合并备注必须保留各原始备注；可在合并后单独编辑。',409);
      if(events.some(e=>e.tags.some(t=>!action.tags.includes(t))))throw new DomainError('合并标签必须包含原有标签。',409);
      await client.query('INSERT INTO merge_operations(id,target_id,snapshot) VALUES($1,$2,$3)',[randomUUID(),target.id,{events,records}]);
      const result=await write(client,target,applyPatch(target,{title:action.title,summary:action.summary,personal:action.personal,tags:action.tags}),'合并');
      for(const event of events.slice(1))await write(client,event,{...event,status:'merged'},'合并入 '+target.id);
      await client.query('UPDATE source_records SET event_id=$1 WHERE event_id=ANY($2::text[])',[target.id,action.ids]);
      return {event:result};
    }
    if(action.action==='undoMerge') {
      type MergeOperation={id:string;snapshot:{events:HubEvent[];records:{id:string;event_id:string}[]}};
      const observed=(await client.query<MergeOperation>('SELECT * FROM merge_operations WHERE target_id=$1 AND NOT undone ORDER BY created_at DESC LIMIT 1',[action.id])).rows[0];
      if(!observed)throw new DomainError('没有可撤销的合并',409);
      // Use the same global event order as merge/batch; the target need not be
      // the smallest id. Recheck the operation only after taking event locks.
      const lockedEvents=new Map<string,HubEvent>();
      for(const eventId of [...new Set([action.id,...observed.snapshot.events.map(e=>e.id)])].sort())lockedEvents.set(eventId,await locked(client,eventId));
      const target=lockedEvents.get(action.id)!;assertRevision(target,action.revision);requireEditable(target);
      const op=(await client.query<MergeOperation>('SELECT * FROM merge_operations WHERE id=$1 AND target_id=$2 AND NOT undone FOR UPDATE',[observed.id,action.id])).rows[0];
      if(!op)throw new DomainError('合并关系已变化，请刷新后重试。',409,'CONFLICT');
      const mergedRevision=(await client.query<Revision>("SELECT * FROM revisions WHERE event_id=$1 AND action='合并' ORDER BY created_at DESC LIMIT 1",[target.id])).rows[0];
      const comparable=(event:HubEvent)=>JSON.stringify({title:event.title,summary:event.summary,kind:event.kind,entity_id:event.entity_id,status:event.status,personal:{...event.personal,read:false},overrides:event.overrides,tags:event.tags,originals:event.originals});
      if(!mergedRevision?.after_data||comparable(target)!==comparable(mergedRevision.after_data))throw new DomainError('合并后已有新修改，请使用拆分分配最新内容。',409,'CONFLICT');
      for(const old of [...op.snapshot.events].sort((a,b)=>a.id.localeCompare(b.id))) {const current=lockedEvents.get(old.id)!;const restored=old.id===target.id?{...old,personal:{...old.personal,read:target.personal.read}}:old;await write(client,current,restored,'撤销合并');}
      for(const record of op.snapshot.records) await client.query('UPDATE source_records SET event_id=$2 WHERE id=$1',[record.id,record.event_id]);
      await client.query('UPDATE merge_operations SET undone=true WHERE id=$1',[op.id]);return {id:action.id};
    }
    if(action.action==='split') {
      const before=await locked(client,action.id);requireEditable(before);assertRevision(before,action.revision);
      const records=(await client.query<{id:string;source_id:string;data:Record<string,unknown>}>('SELECT * FROM source_records WHERE event_id=$1 FOR UPDATE',[before.id])).rows;
      const all=action.groups.flatMap(g=>g.recordIds);
      if(new Set(all).size!==all.length||all.length!==records.length||records.some(r=>!all.includes(r.id)))throw new DomainError('每个来源必须且只能分配到一个结果。');
      if(before.personal.note&&!action.groups.some(g=>g.personal.note.includes(before.personal.note)))throw new DomainError('请为全部个人备注选择归属。');
      if(before.tags.some(t=>!action.groups.some(g=>g.tags.includes(t))))throw new DomainError('请为全部标签选择归属。');
      const created=[];
      for(const [index,group] of action.groups.entries()) {
        const primary=records.find(r=>r.id===group.recordIds[0])!;
        const raw=primary.data;
        let current=before;
        if(index>0) {
          current=(await client.query<HubEvent>(`INSERT INTO events(id,title,summary,kind,url,published_at,published_precision,entity_id,source_name,manual,personal,tags,originals,overrides) SELECT $2,title,summary,kind,url,published_at,published_precision,entity_id,source_name,manual,personal,tags,originals,overrides FROM events WHERE id=$1 RETURNING *`,[before.id,randomUUID()])).rows[0];
        }
        const next=applyPatch(current,{title:group.title,summary:typeof raw.summary==='string'?raw.summary:before.summary,personal:group.personal,tags:group.tags});
        next.originals={...raw,primaryRecordId:primary.id};
        if(typeof raw.url==='string')next.url=raw.url;
        next.published_at=typeof raw.published_at==='string'?raw.published_at:null;
        next.published_precision=typeof raw.published_precision==='string'?raw.published_precision:'unknown';
        next.source_name=(await client.query<{name:string}>('SELECT name FROM sources WHERE id=$1',[primary.source_id])).rows[0]?.name??before.source_name;
        const updated=await write(client,current,next,'拆分');created.push(updated);
        await client.query('UPDATE source_records SET event_id=$1 WHERE id=ANY($2::text[])',[updated.id,group.recordIds]);
      }
      for(let a=0;a<action.groups.length;a++)for(let b=a+1;b<action.groups.length;b++)for(const first of action.groups[a].recordIds)for(const second of action.groups[b].recordIds) {
        await client.query('INSERT INTO separate_records(first_id,second_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[[first,second].sort()[0],[first,second].sort()[1]]);
      }
      return {events:created};
    }
    throw new DomainError('不支持此操作');
  });
}
