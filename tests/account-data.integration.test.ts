import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import { Pool } from 'pg';

const databaseURL=process.env.TEST_DATABASE_URL;
test('runtime roles isolate accounts across collection, relationships, exports, saves and pooled requests',{skip:!databaseURL,timeout:120_000},async()=>{
  const cluster=new Pool({connectionString:databaseURL,max:1});
  const name=`isolation_${randomUUID().replaceAll('-','')}`;
  const adminURL=new URL(databaseURL!);adminURL.pathname=`/${name}`;
  await cluster.query(`CREATE DATABASE "${name}"`);
  const admin=new Pool({connectionString:adminURL.href,max:4});
  const appName=`${name}_app`,workerName=`${name}_worker`,appPassword=randomBytes(24).toString('hex'),workerPassword=randomBytes(24).toString('hex');
  const appURL=new URL(adminURL);appURL.username=appName;appURL.password=appPassword;
  process.env.DATABASE_URL=appURL.href;process.env.APP_URL='http://127.0.0.1:3000';process.env.BETTER_AUTH_SECRET=randomBytes(32).toString('hex');
  Object.assign(process.env,{NODE_ENV:'test'});
  const {pool,withAccountScope,accountQuery,query,activeAccountIds,allAccountIds}=await import('../src/server/db');
  let worker:Pool|undefined;
  try {
    const {migrate}=await import('../scripts/migrate');
    const {createOwnerAccount}=await import('../scripts/owner');
    await migrate(admin,{roles:{appName,workerName,appPassword,workerPassword}});
    const owner=await createOwnerAccount(admin,'owner@example.test','Isolation-owner-password-123');
    const ids=[owner,randomUUID(),randomUUID()];
    for(const id of ids.slice(1)) {
      await admin.query('INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,$1,$2,true,now(),now())',[id,`${id}@example.test`]);
      await admin.query('INSERT INTO member_accounts(user_id,created_by) VALUES($1,$2)',[id,owner]);
    }
    const {ensureSources,SOURCE_PRESETS}=await import('../src/server/collector');
    const {persistItem}=await import('../src/server/collector/storage');
    const {executeDomain,getDetail,listHub}=await import('../src/server/domain');
    const {createExport,processPendingExports}=await import('../src/server/exports');
    const {readSave,writeSave}=await import('../src/server/games/saves');
    const source=SOURCE_PRESETS[0];
    const events=new Map<string,string>(),exports=new Map<string,string>();
    const snapshot={formatVersion:1,files:[{path:'/shattered-pixel-dungeon/game1/game.dat/',type:2,data:'AQID',modifiedAt:'2026-11-06T00:00:00.000Z'}],prefs:{}};
    // No default-owner fallback, even if the SQL connection is otherwise valid.
    await assert.rejects(()=>accountQuery('SELECT * FROM events'),/Account context is required/);
    assert.deepEqual(await query('SELECT * FROM events'),[]);
    await assert.rejects(()=>query("INSERT INTO events(id,title,kind,url,source_name) VALUES('missing-scope','x','tool','https://example.test','test')"));
    for(const id of ids)await withAccountScope(id,async()=>{
      await ensureSources();
      assert((await accountQuery('SELECT * FROM sources')).every(row=>row.owner_id===id&&!row.enabled));
      const item={externalId:'same-release',title:`Private ${id}`,summary:'Original',kind:'model' as const,url:'https://example.test/same-release',publishedAt:null,precision:'unknown' as const,tags:[],entity:{id:'same-entity',kind:'model' as const,name:id,url:'https://example.test/model',data:{}},data:{}};
      assert.equal(await persistItem(source,item),'added');
      assert.equal(await persistItem(source,item),'skipped');
      const listing=await listHub(new URLSearchParams());assert.equal(listing.total,1);
      const event=listing.events[0];events.set(id,event.id);assert.equal(event.title,`Private ${id}`);
      await executeDomain({action:'update',id:event.id,revision:event.revision,patch:{personal:{note:`Note ${id}`}}});
      assert.equal(await persistItem(source,{...item,summary:'Changed upstream'}),'updated');
      assert.equal((await getDetail(event.id)).event.personal.note,`Note ${id}`);
      await accountQuery('INSERT INTO account_settings(key,value) VALUES($1,$2)',[`collector:${source.id}`,{account:id}]);
      assert.equal((await readSave()).revision,0);
      const saved=await writeSave({scope:id,revision:0,snapshot});assert.equal(saved.revision,1);
      const raced=await Promise.allSettled([writeSave({scope:id,revision:1,snapshot}),writeSave({scope:id,revision:1,snapshot})]);
      assert.equal(raced.filter(x=>x.status==='fulfilled').length,1);assert.equal(raced.filter(x=>x.status==='rejected').length,1);
      assert.equal((await readSave(true)).snapshot,null);assert.equal((await readSave()).revision,2);
      await assert.rejects(()=>writeSave({scope:'other-account',revision:2,snapshot}),{code:'ACCOUNT_CHANGED'});
      await admin.query("INSERT INTO drive_files(id,owner_id,name,size,chunk_size,chunk_count,last_modified,fingerprint,status,completed_at) VALUES($1,$2,$3,0,16777216,0,0,$4,'ready',now())",[randomUUID(),id,`File ${id}`,'a'.repeat(64)]);
      exports.set(id,await createExport());
    });
    for(const id of ids)await withAccountScope(id,async()=>{
      const other=ids.find(value=>value!==id)!;
      await assert.rejects(()=>getDetail(events.get(other)!),{status:404});
      await assert.rejects(()=>executeDomain({action:'update',id:events.get(other)!,revision:1,patch:{title:'not mine'}}),{status:404});
      assert.equal((await accountQuery('SELECT * FROM export_jobs WHERE id=$1',[exports.get(other)])).length,0);
      await assert.rejects(()=>accountQuery('UPDATE events SET owner_id=$1 WHERE id=$2',[other,events.get(id)]),{code:'42501'});
      await accountQuery("INSERT INTO entities(id,kind,name,url) VALUES('only-mine','model','Mine','https://example.test')");
      await processPendingExports();
      const payload=(await accountQuery('SELECT payload FROM export_jobs WHERE id=$1',[exports.get(id)]))[0].payload;
      assert.equal(payload.events.length,1);assert.equal(payload.events[0].owner_id,id);
      assert.equal(payload.sources.length,SOURCE_PRESETS.length);assert.equal(payload.collectionProgress[0].value.account,id);
      assert.equal(payload.driveFiles.length,1);assert.equal(payload.driveFiles[0].name,`File ${id}`);assert.equal(payload.gameSaves.length,1);
      assert.equal(payload.revisions.length,2);assert.equal(payload.source_records.length,1);
      assert(!JSON.stringify(payload).includes(`Note ${other}`));
    });
    await withAccountScope(owner,()=>accountQuery("INSERT INTO entities(id,kind,name,url) VALUES('owner-only','model','Owner','https://example.test')"));
    await withAccountScope(ids[1],async()=>{
      await assert.rejects(()=>accountQuery('UPDATE events SET entity_id=$1 WHERE id=$2',['owner-only',events.get(ids[1])]),{code:'23503'});
      await assert.rejects(()=>accountQuery('INSERT INTO revisions(id,event_id,action) VALUES($1,$2,$3)',[randomUUID(),events.get(owner),'cross-account']),{code:'23503'});
    });
    // Concurrent pooled work cannot retain a prior request's SET LOCAL identity.
    await Promise.all(Array.from({length:30},(_,i)=>withAccountScope(ids[i%3],async()=>{
      const rows=await accountQuery('SELECT owner_id FROM events');assert.equal(rows.length,1);assert.equal(rows[0].owner_id,ids[i%3]);
    })));
    assert.deepEqual(await query('SELECT * FROM events'),[]);
    assert.equal((await query("SELECT NULLIF(current_setting('hub.account_id',true),'') AS id"))[0].id,null);
    assert.deepEqual(new Set(await activeAccountIds()),new Set(ids));
    await admin.query('UPDATE member_accounts SET disabled=true WHERE user_id=$1',[ids[2]]);
    assert.deepEqual(new Set(await activeAccountIds()),new Set(ids.slice(0,2)));
    assert.deepEqual(new Set(await allAccountIds()),new Set(ids));
    await withAccountScope(ids[2],async()=>{
      await accountQuery("UPDATE export_jobs SET expires_at=now()-interval '1 minute'");
      await (await import('../src/server/exports')).expireExports();
      const expired=(await accountQuery('SELECT status,payload FROM export_jobs'))[0];
      assert.equal(expired.status,'expired');assert.equal(expired.payload,null);
    });
    const workerURL=new URL(adminURL);workerURL.username=workerName;workerURL.password=workerPassword;
    worker=new Pool({connectionString:workerURL.href,max:1});
    assert.equal((await worker.query('SELECT * FROM events')).rowCount,0);
    await worker.query('BEGIN');await worker.query("SELECT set_config('hub.account_id',$1,true)",[owner]);
    assert.equal((await worker.query('SELECT * FROM events')).rowCount,1);await worker.query('ROLLBACK');
    await assert.rejects(()=>worker!.query('SELECT password FROM account'),{code:'42501'});
  }finally{
    await worker?.end();await pool.end();await admin.end();
    await cluster.query(`DROP DATABASE "${name}"`);
    for(const role of [appName,workerName])await cluster.query(`DROP ROLE IF EXISTS "${role}"`);
    await cluster.end();
  }
});
