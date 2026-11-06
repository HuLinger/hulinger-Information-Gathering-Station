import { randomUUID } from 'node:crypto';
import { accountQuery as query, accountTransaction as transaction, currentAccountId } from './db';
export async function createExport() {
  const id=randomUUID();
  await query('INSERT INTO export_jobs(id) VALUES($1)',[id]);return id;
}
export async function listExports() {return query('SELECT id,status,created_at,finished_at,expires_at,error FROM export_jobs ORDER BY created_at DESC LIMIT 30');}
export async function expireExports() {
  await query("UPDATE export_jobs SET payload=NULL,status='expired' WHERE expires_at<now() AND status<>'expired'");
}
export async function processPendingExports() {
  await expireExports();
  let runningId:string|undefined;
  try { await transaction(async client=>{
    const job=(await client.query<{id:string}>("SELECT id FROM export_jobs WHERE status='queued' AND expires_at>now() ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1")).rows[0];
    if(!job)return;
    runningId=job.id;
    const snapshot:Record<string,unknown>={format:'hulinger-personal-export',version:2,exportedAt:new Date().toISOString(),notice:'个人导出仅包含当前账号资料和游戏存档，不包含身份凭据，不代替数据库备份。云盘仅导出文件元数据，文件内容需另行下载或随完整备份保存。'};
    for(const table of ['events','entities','source_records','revisions','merge_operations','separate_records','snapshots','sync_runs'])snapshot[table]=(await client.query(`SELECT * FROM ${table}`)).rows;
    snapshot.sources=(await client.query('SELECT id,name,kind,url,enabled,interval_minutes,config,last_attempt,last_success,next_run,error,coverage FROM sources')).rows;
    snapshot.collectionProgress=(await client.query("SELECT key,value FROM account_settings WHERE key LIKE 'collector:%'")).rows;
    snapshot.driveFiles=(await client.query('SELECT id,name,size,status,chunk_size,chunk_count,created_at,completed_at,deleted_at FROM drive_files WHERE owner_id=$1',[currentAccountId()])).rows;
    snapshot.gameSaves=(await client.query('SELECT game_id,revision,snapshot,updated_at FROM game_saves')).rows;
    await client.query("UPDATE export_jobs SET status='completed',payload=$2,finished_at=now() WHERE id=$1",[job.id,snapshot]);
  }, true); } catch(error) {
    if(runningId)await query("UPDATE export_jobs SET status='failed',error='导出未完成，请重新生成。',finished_at=now() WHERE id=$1",[runningId]);
    console.error(JSON.stringify({event:'export_failed',errorType:error instanceof Error?error.name:'unknown'}));
  }
}
