import { randomUUID } from 'node:crypto';
import { query, transaction } from './db';
export async function createExport() {
  const id=randomUUID();
  await query('INSERT INTO export_jobs(id) VALUES($1)',[id]);return id;
}
export async function listExports() {return query('SELECT id,status,created_at,finished_at,expires_at,error FROM export_jobs ORDER BY created_at DESC LIMIT 30');}
export async function processPendingExports() {
  await query("UPDATE export_jobs SET payload=NULL,status='expired' WHERE expires_at<now() AND status<>'expired'");
  let runningId:string|undefined;
  try { await transaction(async client=>{
    await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    const job=(await client.query<{id:string}>("SELECT id FROM export_jobs WHERE status='queued' AND expires_at>now() ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1")).rows[0];
    if(!job)return;
    runningId=job.id;
    const snapshot:Record<string,unknown>={format:'hulinger-personal-export',version:1,exportedAt:new Date().toISOString(),notice:'个人导出不包含身份凭据，不代替数据库备份。'};
    for(const table of ['events','entities','source_records','revisions','merge_operations','separate_records','snapshots','sync_runs'])snapshot[table]=(await client.query(`SELECT * FROM ${table}`)).rows;
    snapshot.sources=(await client.query('SELECT id,name,kind,url,enabled,interval_minutes,config,last_attempt,last_success,next_run,error,coverage FROM sources')).rows;
    snapshot.collectionProgress=(await client.query("SELECT key,value FROM app_settings WHERE key LIKE 'collector:%'")).rows;
    await client.query("UPDATE export_jobs SET status='completed',payload=$2,finished_at=now() WHERE id=$1",[job.id,snapshot]);
  }); } catch(error) {
    if(runningId)await query("UPDATE export_jobs SET status='failed',error='导出未完成，请重新生成。',finished_at=now() WHERE id=$1",[runningId]);
    console.error(JSON.stringify({event:'export_failed',errorType:error instanceof Error?error.name:'unknown'}));
  }
}
