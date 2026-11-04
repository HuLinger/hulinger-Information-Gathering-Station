import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pool,query } from '../src/server/db';
import { executeDomain,getDetail,listHub,defaultPersonal } from '../src/server/domain';
import type { HubEvent } from '../src/shared/contracts';
import { createExport,processPendingExports } from '../src/server/exports';

const enabled=process.env.RUN_DB_TESTS==='1';
if(enabled&&!new URL(process.env.DATABASE_URL!).pathname.endsWith('_test'))throw new Error('Integration tests require an explicitly named *_test database.');
after(async()=>{await pool.end();});
test('database transactions retain personal state, prevent stale edits, export relationships, and honor deletion',{skip:!enabled},async()=>{
  const prefix=`test-${randomUUID()}`;const eventIds:string[]=[];let exportId:string|undefined;
  const create=async(n:number)=>{
    const result=await executeDomain({action:'create',title:`${prefix} ${n}`,summary:'Synthetic source',kind:'model',url:`https://example.com/${prefix}/${n}`,tags:['测试'],note:`备注${n}`}) as {event:HubEvent};eventIds.push(result.event.id);return result.event;
  };
  try {
    let first=await create(1);const second=await create(2);
    await assert.rejects(()=>executeDomain({action:'create',title:'duplicate',summary:'',kind:'model',url:first.url,tags:[],note:''}),{code:'DUPLICATE'});
    const changed=await executeDomain({action:'update',id:first.id,revision:first.revision,patch:{title:`${prefix} corrected`,personal:{favorite:true,later:true}}}) as {event:HubEvent};
    await assert.rejects(()=>executeDomain({action:'update',id:first.id,revision:first.revision,patch:{title:'stale'}}),{code:'CONFLICT'});first=changed.event;
    const found=await listHub(new URLSearchParams({q:prefix,section:'favorite'}));assert.equal(found.total,1);assert.equal(found.events[0].id,first.id);
    const stored=(await getDetail(first.id)).event;assert.equal(stored.personal.note,'备注1');assert.equal(stored.overrides.title,`${prefix} corrected`);
    await executeDomain({action:'merge',ids:[first.id,second.id],revisions:{[first.id]:first.revision,[second.id]:second.revision},title:`${prefix} merged`,summary:'merged',personal:{...defaultPersonal,note:'备注1\n备注2'},tags:['测试']});
    let merged=(await getDetail(first.id)).event;assert.equal((await getDetail(second.id)).event.status,'merged');
    // Opening a merged detail marks it read; this must not make undo impossible.
    await executeDomain({action:'update',id:first.id,revision:merged.revision,patch:{personal:{read:true}}});
    merged=(await getDetail(first.id)).event;
    await executeDomain({action:'undoMerge',id:first.id,revision:merged.revision});assert.equal((await getDetail(second.id)).event.status,'active');
    assert.equal((await getDetail(first.id)).event.personal.read,true);
    assert.equal((await getDetail(first.id)).event.personal.note,'备注1');
    exportId=await createExport();await processPendingExports();
    const job=(await query<{status:string;payload:{events:HubEvent[];format:string}}>('SELECT * FROM export_jobs WHERE id=$1',[exportId]))[0];
    assert.equal(job.status,'completed');assert.equal(job.payload.format,'hulinger-personal-export');assert(job.payload.events.some(e=>e.id===first.id));assert(!('user' in job.payload));
    await executeDomain({action:'status',ids:[first.id],status:'trash'});assert.equal((await getDetail(first.id)).event.status,'trash');
    await executeDomain({action:'status',ids:[first.id],status:'active'});assert.equal((await getDetail(first.id)).event.personal.favorite,true);
    await executeDomain({action:'status',ids:[first.id],status:'trash'});await executeDomain({action:'status',ids:[first.id],status:'delete'});
    await assert.rejects(()=>getDetail(first.id),{status:404});
  }finally {await query('DELETE FROM events WHERE id=ANY($1::text[])',[eventIds]);if(exportId)await query('DELETE FROM export_jobs WHERE id=$1',[exportId]);}
});
test('10,000 synthetic records preserve bounded search and list latency',{skip:!enabled},async()=>{
  const prefix=`budget-${randomUUID()}`;
  try {
    await query(`INSERT INTO events(id,title,summary,kind,url,source_name) SELECT $1||'-'||g,$1||' 人工智能资料 '||g,'合成性能验收内容','tool','https://example.com/'||$1||'/'||g,'测试来源' FROM generate_series(1,10000) g`,[prefix]);
    const times=[];
    for(let n=0;n<20;n++){const start=performance.now();const result=await listHub(new URLSearchParams({q:prefix,page:String(n+1)}));assert.equal(result.total,10000);assert.equal(result.events.length,20);times.push(performance.now()-start);}
    const p95=times.sort((a,b)=>a-b)[18];console.log(`10k synthetic query p95: ${p95.toFixed(1)}ms on local PostgreSQL`);assert(p95<=500,`p95 ${p95.toFixed(1)}ms exceeds 500ms budget`);
  }finally {await query('DELETE FROM events WHERE id LIKE $1',[`${prefix}-%`]);}
});

test('undo merge takes all event locks in canonical order',{skip:!enabled},async()=>{
  const prefix=`lock-${randomUUID()}`;const events:HubEvent[]=[];const holder=await pool.connect();let undo:Promise<unknown>|undefined;
  try {
    for(let i=0;i<2;i++)events.push((await executeDomain({action:'create',title:prefix,summary:'',kind:'model',url:`https://example.com/${prefix}/${i}`,tags:[],note:''}) as {event:HubEvent}).event);
    events.sort((a,b)=>a.id.localeCompare(b.id));const [first,target]=events;
    const merged=(await executeDomain({action:'merge',ids:[target.id,first.id],revisions:{[first.id]:first.revision,[target.id]:target.revision},title:prefix,summary:'',personal:defaultPersonal,tags:[]}) as {event:HubEvent}).event;
    await holder.query('BEGIN');await holder.query('SELECT id FROM events WHERE id=$1 FOR UPDATE',[first.id]);
    undo=executeDomain({action:'undoMerge',id:target.id,revision:merged.revision});
    // Attach a handler immediately; the original promise is still asserted below.
    void undo.catch(()=>undefined);
    // Wait until the undo transaction is actually blocked on the held row.
    let waiting=false;
    for(let i=0;i<100;i++) {const rows=await query<{waiting:boolean}>("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock' AND query LIKE 'SELECT * FROM events WHERE id=%') AS waiting");if(rows[0].waiting){waiting=true;break;}await new Promise(resolve=>setTimeout(resolve,10));}
    assert.equal(waiting,true,'undo did not reach its event lock');
    await holder.query("SET LOCAL lock_timeout='1s'");
    // If undo locked its larger target first, this would time out or deadlock.
    await holder.query('SELECT id FROM events WHERE id=$1 FOR UPDATE',[target.id]);
    await holder.query('COMMIT');await undo;
    assert.equal((await getDetail(first.id)).event.status,'active');
  }finally {
    await holder.query('ROLLBACK');holder.release();await undo?.catch(()=>undefined);
    await query('DELETE FROM merge_operations WHERE target_id=ANY($1::text[])',[events.map(e=>e.id)]);
    await query('DELETE FROM events WHERE id=ANY($1::text[])',[events.map(e=>e.id)]);
  }
});
