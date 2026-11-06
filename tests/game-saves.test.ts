import { test } from 'node:test';
import assert from 'node:assert/strict';
import { snapshotSchema, readSaveBody, SAVE_BODY_LIMIT } from '../src/server/games/saves';

const snapshot={formatVersion:1,files:[{path:'/shattered-pixel-dungeon/game1/game.dat/',type:2,data:'AQID',modifiedAt:'2026-11-06T00:00:00.000Z'}],prefs:{'settings.xml:musicb':'true'}};
test('game save accepts actual TeaVM paths and rejects malformed or cross-root snapshots',()=>{
  assert.equal(snapshotSchema.safeParse(snapshot).success,true);
  for(const path of ['/other/game.dat/','/shattered-pixel-dungeon/../game.dat/','/shattered-pixel-dungeon//game.dat/','/shattered-pixel-dungeon/game.dat','/shattered-pixel-dungeon/a\\b/'])assert.equal(snapshotSchema.safeParse({...snapshot,files:[{...snapshot.files[0],path}]}).success,false);
  for(const data of ['not base64','A===',null])assert.equal(snapshotSchema.safeParse({...snapshot,files:[{...snapshot.files[0],data}]}).success,false);
  assert.equal(snapshotSchema.safeParse({...snapshot,files:[snapshot.files[0],snapshot.files[0]]}).success,false);
  assert.equal(snapshotSchema.safeParse({...snapshot,prefs:Object.fromEntries(Array.from({length:513},(_,i)=>[String(i),'x']))}).success,false);
  assert.equal(snapshotSchema.safeParse({...snapshot,prefs:{setting:'x'.repeat(16385)}}).success,false);
  assert.equal(snapshotSchema.safeParse({...snapshot,files:[{...snapshot.files[0],type:1,data:null}]}).success,true);
});
test('game save body rejects wrong content type, malformed and oversized streams',async()=>{
  const request=(body:string,headers:HeadersInit={'content-type':'application/json'})=>new Request('https://example.test/save',{method:'PUT',headers,body});
  assert.deepEqual(await readSaveBody(request(JSON.stringify(snapshot))),snapshot);
  await assert.rejects(()=>readSaveBody(request('{}',{})),{status:415});
  await assert.rejects(()=>readSaveBody(request('{broken')),{status:400});
  await assert.rejects(()=>readSaveBody(request('{}',{'content-type':'application/json','content-length':String(SAVE_BODY_LIMIT+1)})),{status:413});
  let cancelled=false;
  const stream=new ReadableStream<Uint8Array>({pull(c){c.enqueue(new Uint8Array(1024*1024));},cancel(){cancelled=true;}});
  await assert.rejects(()=>readSaveBody(new Request('https://example.test/save',{method:'PUT',headers:{'content-type':'application/json'},body:stream,duplex:'half'} as RequestInit)),{status:413});
  assert.equal(cancelled,true);
});
