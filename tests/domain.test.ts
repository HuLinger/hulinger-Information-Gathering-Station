import { test } from 'node:test';
import assert from 'node:assert/strict';
import { actionSchema, applyPatch, assertRevision, defaultPersonal, safeUrl } from '../src/server/domain';
import type { HubEvent } from '../src/shared/contracts';
function event():HubEvent {return {id:'synthetic',title:'Source title',summary:'Source summary',kind:'model',url:'https://example.com/post',published_at:null,published_precision:'unknown',discovered_at:'2026-11-04T00:00:00Z',updated_at:'2026-11-04T00:00:00Z',entity_id:null,source_name:'Synthetic',review_reason:null,status:'active',deleted_at:null,revision:2,manual:false,personal:{...defaultPersonal,note:'Private note'},overrides:{},tags:[],originals:{title:'New source title',summary:'Latest source summary',kind:'model'}};}
test('overrides and personal notes remain independent; reset uses latest source',()=>{
  const original=event();const edited=applyPatch(original,{title:'My title',personal:{favorite:true}});
  assert.equal(original.title,'Source title');assert.equal(edited.personal.note,'Private note');
  assert.equal(edited.overrides.title,'My title');
  const reset=applyPatch(edited,{},['title']);assert.equal(reset.title,'New source title');assert.equal(reset.overrides.title,undefined);assert.equal(reset.personal.favorite,true);
});
test('concurrent revisions refuse silent overwrite',()=>{
  assert.throws(()=>assertRevision(event(),1),{code:'CONFLICT',status:409});assert.doesNotThrow(()=>assertRevision(event(),2));
});
test('input schema rejects executable links, credentials, mass assignment and oversized content',()=>{
  for(const url of ['javascript:alert(1)','data:text/html,test','https://secret:pass@example.com'])assert.equal(safeUrl.safeParse(url).success,false);
  assert.equal(actionSchema.safeParse({action:'update',id:'event',revision:1,patch:{status:'active'}}).success,false);
  assert.equal(actionSchema.safeParse({action:'create',title:'x'.repeat(501),url:'https://example.com',kind:'model'}).success,false);
  assert.equal(actionSchema.safeParse({action:'status',ids:['x','x'],status:'trash'}).success,false);
});
test('personal states do not erase each other',()=>{
  const e=event();e.personal.favorite=true;e.personal.later=true;
  const next=applyPatch(e,{personal:{read:true}});assert.equal(next.personal.later,true);assert.equal(next.personal.favorite,true);
});
