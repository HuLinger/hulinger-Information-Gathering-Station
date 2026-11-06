import { z } from 'zod';
import { accountQuery, currentAccountId } from '../db';
import { DomainError } from '../domain';

export const GAME_ID = 'shattered-pixel-dungeon';
export const SAVE_BODY_LIMIT = 32 * 1024 * 1024;
const path = z.string().max(512).refine((value) => {
  if (!value.startsWith('/shattered-pixel-dungeon/') || !value.endsWith('/')) return false;
  return value.slice(1,-1).split('/').every((part) => /^[\w.-]+$/.test(part) && part!=='.' && part!=='..');
});
const base64 = z.string().max(8 * 1024 * 1024).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);
export const snapshotSchema = z.object({
  formatVersion: z.literal(1),
  files: z.array(z.object({ path, type: z.union([z.literal(1),z.literal(2)]), data: base64.nullable(), modifiedAt: z.string().datetime({offset:true}) }).strict()).max(2048),
  prefs: z.record(z.string().min(1).max(256),z.string().max(16 * 1024)),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.files.map((file) => file.path)).size !== value.files.length) ctx.addIssue({code:'custom', message:'Duplicate save paths'});
  if (value.files.some((file) => file.type===1 ? file.data!==null : file.data===null)) ctx.addIssue({code:'custom', message:'Save file type does not match data'});
  if (Object.keys(value.prefs).length>512 || Buffer.byteLength(JSON.stringify(value.prefs))>256*1024) ctx.addIssue({code:'custom',message:'Preferences too large'});
});
export const saveSchema = z.object({scope:z.string().min(1).max(150),revision:z.number().int().min(0).max(2_147_483_646),snapshot:snapshotSchema}).strict();

export async function readSave(metadataOnly = false) {
  const [save] = await accountQuery<{revision:number;updated_at:Date;snapshot:unknown}>(`SELECT revision,updated_at,${metadataOnly?'NULL':'snapshot'} AS snapshot FROM game_saves WHERE game_id=$1`,[GAME_ID]);
  return {scope:currentAccountId(),revision:save?.revision??0,updatedAt:save?.updated_at.toISOString()??null,snapshot:save?.snapshot??null};
}
export async function writeSave(value:unknown) {
  const input=saveSchema.parse(value);
  const accountId=currentAccountId();
  if(input.scope!==accountId)throw new DomainError('登录账号已变化，请重新打开游戏。',409,'ACCOUNT_CHANGED');
  const [save]=await accountQuery<{revision:number;updated_at:Date}>(`INSERT INTO game_saves(owner_id,game_id,snapshot)
    SELECT $1,$2,$3::jsonb WHERE $4=0
    ON CONFLICT(owner_id,game_id) DO NOTHING RETURNING revision,updated_at`,[accountId,GAME_ID,input.snapshot,input.revision]);
  // Compare-and-swap protects different tabs/devices and never silently overwrites a newer save.
  const updated=save??(input.revision>0?(await accountQuery<{revision:number;updated_at:Date}>(`UPDATE game_saves SET snapshot=$2,revision=revision+1,updated_at=now()
    WHERE game_id=$1 AND revision=$3 RETURNING revision,updated_at`,[GAME_ID,input.snapshot,input.revision]))[0]:undefined);
  if(!updated)throw new DomainError('另一页面或设备已保存进度，请备份当前进度后重新载入。',409,'SAVE_CONFLICT');
  return {scope:accountId,revision:updated.revision,updatedAt:updated.updated_at.toISOString()};
}

export async function readSaveBody(request:Request):Promise<unknown> {
  if(request.headers.get('content-type')?.split(';')[0].trim()!=='application/json')throw new DomainError('游戏存档需要 JSON 请求。',415);
  const declared=Number(request.headers.get('content-length'));
  if(declared>SAVE_BODY_LIMIT)throw new DomainError('游戏存档过大，未写入服务器。',413);
  const reader=request.body?.getReader();
  if(!reader)throw new DomainError('缺少游戏存档。');
  const chunks:Uint8Array[]=[];let size=0;
  try {
    while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>SAVE_BODY_LIMIT)throw new DomainError('游戏存档过大，未写入服务器。',413);chunks.push(value);}
    try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new DomainError('游戏存档格式无效。');}
  }finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
}
