import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { accountQuery, accountTransaction, activeAccountIds, allAccountIds, currentAccountId, pool, withAccountScope } from '../db';
import { DomainError } from '../domain';
import { conversionConfig } from './config';
import { diskCapacity, inputPath, inside, jobDirectory, openPrivateFile, removeInput, removeJobFiles, requireDisk } from './files';
import { ConversionProviderError, type ConversionProvider } from './provider-types';
import { getConversionProviders } from './providers';
import { usedConversionBytes, type JobRow, type UploadRow } from './service';

// A session lock spans conversion, recovery and cleanup. A second worker cannot
// mistake an in-flight job for a crashed attempt. PostgreSQL releases it on exit.
const WORKER_LOCK = 746_104_208;

async function recoverInterrupted(): Promise<void> {
  const rows = await accountQuery<JobRow>("SELECT * FROM conversion_jobs WHERE state='running'");
  for (const row of rows) {
    await removeJobFiles(row.id);
    await accountQuery(`UPDATE conversion_jobs SET state='failed',stage='处理已中断',error='后台服务曾中断，请使用保留的源文件重试。',
      finished_at=now(),expires_at=now()+interval '24 hours' WHERE id=$1 AND state='running'`, [row.id]);
  }
}

export async function expireConversions(): Promise<void> {
  await accountTransaction(async client => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`conversion-quota:${currentAccountId()}`]);
    const jobs = await client.query<JobRow>("SELECT * FROM conversion_jobs WHERE expires_at<=now() AND state<>'running' FOR UPDATE");
    for (const row of jobs.rows) {
      await removeJobFiles(row.id);
      await client.query('DELETE FROM conversion_jobs WHERE id=$1', [row.id]);
    }
    const uploads = await client.query<UploadRow>(`SELECT * FROM conversion_uploads upload WHERE expires_at<=now()
      AND NOT EXISTS(SELECT 1 FROM conversion_jobs job WHERE job.upload_id=upload.id) FOR UPDATE`);
    for (const row of uploads.rows) {
      // Upload requests hold the same key while streaming. Never remove an open
      // partial file, including on platforms that permit unlinking it.
      const { rows: [lock] } = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS locked', [`conversion-input:${row.id}`]);
      if (!lock.locked) continue;
      await removeInput(row.id);
      await client.query('DELETE FROM conversion_uploads WHERE id=$1', [row.id]);
    }
  });
}

async function executeJob(job: JobRow, providers: ConversionProvider[], signal: AbortSignal): Promise<void> {
  const config = conversionConfig();
  try {
    const [upload] = await accountQuery<UploadRow>('SELECT * FROM conversion_uploads WHERE id=$1 AND state=\'ready\' AND expires_at>now()', [job.upload_id]);
    if (!upload) throw new DomainError('源文件已到期，请重新上传。', 410);
    const path = await inputPath(upload.id);
    const input = await openPrivateFile(path, Number(upload.bytes));
    await input.close();
    const budget = Math.min(config.maxOutputBytes, config.accountQuotaBytes - await usedConversionBytes(), await diskCapacity());
    if (budget <= 0) throw new DomainError('转换临时空间不足，请清理旧文件后重试。', 507);
    const provider = providers.find(candidate => candidate.id === job.engine && candidate.configured);
    if (!provider) throw new ConversionProviderError('所选引擎尚未启用，请选择其他引擎或联系管理员。');
    const directory = await jobDirectory(job.id, true);
    const outputs = await provider.convert({ path, name: upload.name, extension: upload.extension, bytes: Number(upload.bytes) }, job.target_format, directory, {
      signal, maxOutputBytes: budget, maxOutputFiles: config.maxOutputFiles, beforeWrite: requireDisk,
      onStage: async stage => { await accountQuery("UPDATE conversion_jobs SET stage=$2 WHERE id=$1 AND state='running'", [job.id, stage.slice(0, 200)]); },
    });
    signal.throwIfAborted();
    if (!outputs.length || outputs.length > config.maxOutputFiles || new Set(outputs.map(output => output.storageName)).size !== outputs.length) throw new Error('Invalid conversion output');
    let total = 0;
    for (const output of outputs) {
      if (!Number.isSafeInteger(output.bytes) || output.bytes <= 0 || !output.name || output.name.length > 240 || /[\u0000-\u001f\u007f/\\]/.test(output.name)) throw new Error('Invalid output metadata');
      total += output.bytes;
      if (total > budget) throw new DomainError('转换结果超过临时容量限制，请缩小文件后重试。', 413);
      const file = await openPrivateFile(inside(directory, output.storageName), output.bytes);
      await file.close();
    }
    await accountTransaction(async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`conversion-quota:${currentAccountId()}`]);
      const { rows: [quota] } = await client.query<{ bytes: string }>(`SELECT COALESCE((SELECT sum(bytes) FROM conversion_uploads),0)+COALESCE((SELECT sum(bytes) FROM conversion_outputs),0) AS bytes`);
      if (Number(quota.bytes) + total > config.accountQuotaBytes) throw new DomainError('你的转换临时空间不足，请清理旧任务后重试。', 413);
      signal.throwIfAborted();
      for (const output of outputs) await client.query('INSERT INTO conversion_outputs(id,job_id,name,storage_name,mime,bytes) VALUES($1,$2,$3,$4,$5,$6)', [randomUUID(), job.id, output.name, output.storageName, output.mime, output.bytes]);
      await client.query("UPDATE conversion_jobs SET state='succeeded',stage='转换完成，可以下载',error=NULL,finished_at=now(),expires_at=now()+interval '24 hours' WHERE id=$1 AND state='running'", [job.id]);
      await client.query("UPDATE conversion_uploads SET expires_at=GREATEST(expires_at,now()+interval '24 hours') WHERE id=$1", [upload.id]);
    });
  } catch (error) {
    await removeJobFiles(job.id);
    const message = signal.aborted ? '转换已停止或超时，请使用源文件重试。'
      : error instanceof ConversionProviderError || error instanceof DomainError ? error.message : '转换未能完成，请重试或更换引擎。';
    await accountQuery(`UPDATE conversion_jobs SET state='failed',stage='转换未完成',error=$2,finished_at=now(),expires_at=now()+interval '24 hours'
      WHERE id=$1 AND state='running'`, [job.id, message]);
  }
}

let nextAccount = 0;
export async function processOneConversion(options: { providers?: ConversionProvider[]; signal?: AbortSignal } = {}): Promise<boolean> {
  const lock = await pool.connect();
  let held = false;
  const lostLock = new AbortController();
  const onError = () => lostLock.abort();
  lock.on('error', onError);
  try {
    held = (await lock.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1) AS locked', [WORKER_LOCK])).rows[0].locked;
    if (!held || options.signal?.aborted) return false;
    for (const id of await allAccountIds()) await withAccountScope(id, async () => { await recoverInterrupted(); await expireConversions(); });
    const ids = await activeAccountIds();
    const start = nextAccount % Math.max(ids.length, 1);
    for (let offset = 0; offset < ids.length; offset++) {
      if (options.signal?.aborted || lostLock.signal.aborted) return false;
      const index = (start + offset) % ids.length;
      const processed = await withAccountScope(ids[index], async () => {
        const [job] = await accountQuery<JobRow>(`UPDATE conversion_jobs SET state='running',stage='正在准备转换',started_at=now()
          WHERE id=(SELECT id FROM conversion_jobs WHERE state='queued' AND expires_at>now() ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
          AND state='queued' RETURNING *`);
        if (!job) return false;
        const signals = [lostLock.signal, AbortSignal.timeout(conversionConfig().timeoutSeconds * 1000)];
        if (options.signal) signals.push(options.signal);
        await executeJob(job, options.providers ?? getConversionProviders(), AbortSignal.any(signals));
        return true;
      });
      if (processed) { nextAccount = index + 1; return true; }
    }
    return false;
  } finally {
    lock.off('error', onError);
    if (held) await lock.query('SELECT pg_advisory_unlock($1)', [WORKER_LOCK]).catch(() => {});
    lock.release();
  }
}

export function startConversionWorker(): { stop: () => Promise<void> } {
  const controller = new AbortController();
  const run = (async () => {
    while (!controller.signal.aborted) {
      try { await processOneConversion({ signal: controller.signal }); }
      catch { if (!controller.signal.aborted) console.error('Conversion worker cycle failed; checking again shortly.'); }
      await delay(2000, undefined, { signal: controller.signal }).catch(() => {});
    }
  })();
  return { stop: async () => { controller.abort(); await run; } };
}
