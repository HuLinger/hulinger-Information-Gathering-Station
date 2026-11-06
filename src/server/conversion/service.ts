import { randomUUID, createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { z } from 'zod';
import { CONVERSION_ENGINES, CONVERSION_ENGINE_LABELS, type ConversionCapabilities, type ConversionEngine, type ConversionEngineChoice, type ConversionJob, type ConversionOption, type ConversionOutput, type ConversionUpload } from '../../shared/conversion-contracts';
import { accountQuery, accountTransaction, currentAccountId } from '../db';
import { DomainError } from '../domain';
import { privateHeaders } from '../http';
import { conversionConfig } from './config';
import { conversionLockConnection } from './connections';
import { conversionId, conversionName, fileExtension, inputPath, inside, jobDirectory, openPrivateFile, removeInput, removeJobFiles, requireDisk } from './files';
import { getConversionProviders } from './providers';

export type UploadRow = { id: string; name: string; extension: string; bytes: string; state: 'uploading' | 'ready'; sha256: string | null; created_at: Date; expires_at: Date };
export type JobRow = { id: string; upload_id: string; target_format: string; requested_engine: ConversionEngineChoice; engine: ConversionEngine; state: ConversionJob['state']; stage: string; error: string | null; created_at: Date; started_at: Date | null; finished_at: Date | null; expires_at: Date; input_name: string; input_extension: string };
export type OutputRow = { id: string; job_id: string; name: string; storage_name: string; mime: string; bytes: string };

export const uploadSchema = z.object({ name: z.string().trim().min(1).max(200).refine(name => !/[\u0000-\u001f\u007f/\\]/.test(name)), bytes: z.number().int().positive() }).strict();
export const jobSchema = z.object({ uploadId: z.string().uuid(), targetFormat: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,30}$/), engine: z.enum(['auto', ...CONVERSION_ENGINES]).default('auto') }).strict();

const uploadDto = (row: UploadRow): ConversionUpload => ({ id: row.id, name: row.name, extension: row.extension, bytes: Number(row.bytes), state: row.state, createdAt: row.created_at.toISOString(), expiresAt: row.expires_at.toISOString() });
const outputDto = (row: OutputRow): ConversionOutput => ({ id: row.id, name: row.name, bytes: Number(row.bytes), mime: row.mime });

export async function usedConversionBytes(): Promise<number> {
  const [row] = await accountQuery<{ bytes: string }>(`SELECT
    COALESCE((SELECT sum(bytes) FROM conversion_uploads),0)+
    COALESCE((SELECT sum(bytes) FROM conversion_outputs),0) AS bytes`);
  return Number(row.bytes);
}

export async function capabilities(extension = ''): Promise<ConversionCapabilities> {
  if (extension && !/^[a-z0-9]{1,20}$/.test(extension)) throw new DomainError('文件扩展名不正确。');
  const options: ConversionOption[] = [];
  const engines = await Promise.all(getConversionProviders().map(async provider => {
    const label = CONVERSION_ENGINE_LABELS[provider.id];
    if (!provider.configured) return { id: provider.id, label, state: 'unconfigured' as const, message: '尚未启用' };
    try {
      const signal = AbortSignal.timeout(5000);
      await provider.health(signal);
      if (extension) options.push(...await provider.options(extension, signal));
      return { id: provider.id, label, state: 'ready' as const, message: '可用' };
    } catch {
      return { id: provider.id, label, state: 'unavailable' as const, message: '暂时不可用，请稍后重试或换用其他引擎' };
    }
  }));
  const config = conversionConfig();
  return { engines, options: options.sort((a, b) => a.format.localeCompare(b.format) || a.engine.localeCompare(b.engine)), maxInputBytes: config.maxInputBytes, retentionHours: config.retentionHours, maxPendingJobs: config.maxPendingJobs };
}

export function chooseConversionEngine(options: ConversionOption[], target: string, choice: ConversionEngineChoice): ConversionEngine {
  const priority: ConversionEngine[] = target === 'pdf' || options.some(option => option.engine === 'stirling' && option.format === target)
    ? ['stirling', 'transmute', 'convertx', 'ncmdump'] : ['transmute', 'convertx', 'ncmdump', 'stirling'];
  const available = options.filter(option => option.format === target && (choice === 'auto' || option.engine === choice));
  const engine = priority.find(id => available.some(option => option.engine === id));
  if (!engine) throw new DomainError('所选引擎当前不能完成这个格式转换，请选择其他可用格式或引擎。', 422, 'UNSUPPORTED_CONVERSION');
  return engine;
}

export async function createUpload(input: unknown): Promise<ConversionUpload> {
  const data = uploadSchema.parse(input);
  const config = conversionConfig();
  if (data.bytes > config.maxInputBytes) throw new DomainError('文件超过本站单文件大小限制。', 413, 'FILE_TOO_LARGE');
  const extension = fileExtension(data.name);
  if (!extension) throw new DomainError('请上传带有受支持扩展名的文件。', 422, 'UNSUPPORTED_FILE');
  const supported = await capabilities(extension);
  if (!supported.options.length) throw new DomainError('当前没有可用引擎支持该文件类型，请检查文件扩展名或联系管理员。', 422, 'UNSUPPORTED_FILE');
  await requireDisk(data.bytes);
  const row = await accountTransaction(async client => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`conversion-quota:${currentAccountId()}`]);
    const { rows: [totals] } = await client.query<{ uploads: string; bytes: string }>(`SELECT
      (SELECT count(*) FROM conversion_uploads) AS uploads,
      COALESCE((SELECT sum(bytes) FROM conversion_uploads),0)+COALESCE((SELECT sum(bytes) FROM conversion_outputs),0) AS bytes`);
    if (Number(totals.uploads) >= config.maxUploads) throw new DomainError('保留中的文件较多，请清理旧文件后再上传。', 429, 'UPLOAD_LIMIT');
    if (Number(totals.bytes) + data.bytes > config.accountQuotaBytes) throw new DomainError('你的转换临时空间不足，请清理旧任务或文件。', 413, 'QUOTA_EXCEEDED');
    const { rows: [upload] } = await client.query<UploadRow>(`INSERT INTO conversion_uploads(id,name,extension,bytes) VALUES($1,$2,$3,$4) RETURNING *`, [randomUUID(), conversionName(data.name), extension, data.bytes]);
    return upload;
  });
  return uploadDto(row);
}

export async function getUpload(id: string): Promise<UploadRow> {
  const [row] = await accountQuery<UploadRow>('SELECT * FROM conversion_uploads WHERE id=$1 AND expires_at>now()', [conversionId(id)]);
  if (!row) throw new DomainError('源文件不存在或已到期，请重新上传。', 404, 'NOT_FOUND');
  return row;
}

export async function receiveUpload(id: string, request: Request): Promise<ConversionUpload> {
  const row = await getUpload(id);
  if (row.state === 'ready') return uploadDto(row);
  if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/octet-stream') throw new DomainError('请使用文件上传入口。', 415, 'BINARY_REQUIRED');
  const length = request.headers.get('content-length');
  if (length && (!/^\d+$/.test(length) || Number(length) !== Number(row.bytes))) throw new DomainError('上传文件大小与声明不一致。', 400, 'SIZE_MISMATCH');
  if (!request.body) throw new DomainError('上传内容不能为空。');
  const lock = await conversionLockConnection();
  let held = false, lockLost = false;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const onLost = () => { lockLost = true; void reader?.cancel().catch(() => {}); };
  const onAbort = () => { void reader?.cancel().catch(() => {}); };
  lock.on('error', onLost);
  request.signal.addEventListener('abort', onAbort, { once: true });
  try {
    held = (await lock.query<{ locked: boolean }>('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked', [`conversion-input:${row.id}`])).rows[0].locked;
    if (!held) throw new DomainError('该文件正在上传，请等待当前上传结束。', 409, 'UPLOAD_BUSY');
    const current = await getUpload(id);
    if (current.state === 'ready') return uploadDto(current);
    await removeInput(row.id);
    const file = await open(await inputPath(row.id), 'wx', 0o600);
    reader = request.body.getReader();
    const timeout = setTimeout(() => { void reader?.cancel('upload timeout'); }, 15 * 60_000);
    const hash = createHash('sha256');
    let bytes = 0;
    try {
      while (true) {
        if (request.signal.aborted || lockLost) throw new DomainError('上传已中断，请重新上传。', 400, 'UPLOAD_INTERRUPTED');
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > Number(row.bytes)) throw new DomainError('上传内容超过声明大小。', 413, 'SIZE_MISMATCH');
        await requireDisk(value.byteLength);
        hash.update(value);
        await file.writeFile(value);
      }
      if (request.signal.aborted || lockLost) throw new DomainError('上传已中断，请重新上传。', 400, 'UPLOAD_INTERRUPTED');
      if (bytes !== Number(row.bytes)) throw new DomainError('文件未完整上传，请重新上传。', 400, 'SIZE_MISMATCH');
      await file.sync();
    } catch (error) {
      await reader.cancel().catch(() => {});
      await file.close();
      // After a lost database session another attempt may own this UUID. Leave
      // the partial file for that attempt or expiry cleanup, never unlink it.
      if (!lockLost) await removeInput(row.id);
      throw error;
    } finally { clearTimeout(timeout); }
    await file.close();
    if (lockLost) throw new DomainError('上传连接已中断，请重新上传。', 503, 'UPLOAD_INTERRUPTED');
    const [complete] = await accountQuery<UploadRow>(`UPDATE conversion_uploads SET state='ready',sha256=$2,expires_at=now()+interval '24 hours'
      WHERE id=$1 AND state='uploading' RETURNING *`, [row.id, hash.digest('hex')]);
    if (!complete) { await removeInput(row.id); throw new DomainError('上传记录已失效，请重新选择文件。', 409, 'UPLOAD_EXPIRED'); }
    return uploadDto(complete);
  } finally {
    request.signal.removeEventListener('abort', onAbort);
    reader?.releaseLock();
    if (held && !lockLost) await lock.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [`conversion-input:${row.id}`]).catch(() => {});
    lock.off('error', onLost);
    lock.release(lockLost);
  }
}

export async function createJob(input: unknown): Promise<ConversionJob> {
  const data = jobSchema.parse(input);
  const upload = await getUpload(data.uploadId);
  if (upload.state !== 'ready') throw new DomainError('文件尚未上传完成。', 409, 'UPLOAD_PENDING');
  const handle = await openPrivateFile(await inputPath(upload.id), Number(upload.bytes));
  await handle.close();
  const available = await capabilities(upload.extension);
  const engine = chooseConversionEngine(available.options, data.targetFormat, data.engine);
  const jobId = randomUUID();
  await accountTransaction(async client => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`conversion-quota:${currentAccountId()}`]);
    const { rows: [count] } = await client.query<{ count: string }>("SELECT count(*) FROM conversion_jobs WHERE state IN ('queued','running')");
    if (Number(count.count) >= conversionConfig().maxPendingJobs) throw new DomainError('待处理任务已达到上限，请等待完成后再试。', 429, 'JOB_LIMIT');
    const ready = await client.query("UPDATE conversion_uploads SET expires_at=now()+interval '24 hours' WHERE id=$1 AND state='ready' AND expires_at>now() RETURNING id", [upload.id]);
    if (!ready.rowCount) throw new DomainError('源文件已到期，请重新上传。', 410, 'FILE_EXPIRED');
    await client.query('INSERT INTO conversion_jobs(id,upload_id,target_format,requested_engine,engine) VALUES($1,$2,$3,$4,$5)', [jobId, upload.id, data.targetFormat, data.engine, engine]);
  });
  return getJob(jobId);
}

const jobSelect = `SELECT job.*,upload.name AS input_name,upload.extension AS input_extension FROM conversion_jobs job
  JOIN conversion_uploads upload ON upload.owner_id=job.owner_id AND upload.id=job.upload_id`;
async function jobDtos(rows: JobRow[]): Promise<ConversionJob[]> {
  if (!rows.length) return [];
  const outputs = await accountQuery<OutputRow>('SELECT * FROM conversion_outputs WHERE job_id=ANY($1::uuid[]) ORDER BY name,id', [rows.map(row => row.id)]);
  return rows.map(row => ({ id: row.id, uploadId: row.upload_id, inputName: row.input_name, inputExtension: row.input_extension, targetFormat: row.target_format, requestedEngine: row.requested_engine, engine: row.engine, state: row.state, stage: row.stage, error: row.error, createdAt: row.created_at.toISOString(), startedAt: row.started_at?.toISOString() ?? null, finishedAt: row.finished_at?.toISOString() ?? null, expiresAt: row.expires_at.toISOString(), outputs: outputs.filter(output => output.job_id === row.id).map(outputDto) }));
}
export async function getJob(id: string): Promise<ConversionJob> {
  const [row] = await accountQuery<JobRow>(`${jobSelect} WHERE job.id=$1 AND job.expires_at>now()`, [conversionId(id)]);
  if (!row) throw new DomainError('转换任务不存在或已到期。', 404, 'NOT_FOUND');
  return (await jobDtos([row]))[0];
}
export async function listConversions(): Promise<{ uploads: ConversionUpload[]; jobs: ConversionJob[] }> {
  const [uploads, jobs] = await Promise.all([
    accountQuery<UploadRow>("SELECT * FROM conversion_uploads WHERE expires_at>now() ORDER BY created_at DESC LIMIT 30"),
    accountQuery<JobRow>(`${jobSelect} WHERE job.expires_at>now() ORDER BY job.created_at DESC LIMIT 50`),
  ]);
  return { uploads: uploads.map(uploadDto), jobs: await jobDtos(jobs) };
}

export async function deleteJob(id: string): Promise<void> {
  await accountTransaction(async client => {
    const { rows: [job] } = await client.query<JobRow>('SELECT * FROM conversion_jobs WHERE id=$1 FOR UPDATE', [conversionId(id)]);
    if (!job) throw new DomainError('转换任务不存在。', 404, 'NOT_FOUND');
    if (job.state === 'running') throw new DomainError('引擎正在处理，暂不能删除；完成后可清理。', 409, 'JOB_RUNNING');
    await removeJobFiles(job.id);
    await client.query('DELETE FROM conversion_jobs WHERE id=$1', [job.id]);
  });
}
export async function cancelJob(id: string): Promise<void> {
  const rows = await accountQuery("UPDATE conversion_jobs SET state='cancelled',stage='已取消排队',finished_at=now() WHERE id=$1 AND state='queued' RETURNING id", [conversionId(id)]);
  if (!rows.length) { await getJob(id); throw new DomainError('只能取消尚未开始的任务；处理中请等待完成。', 409, 'JOB_RUNNING'); }
}
export async function deleteUpload(id: string): Promise<void> {
  const lock = await conversionLockConnection();
  let held = false, lockLost = false;
  const onLost = () => { lockLost = true; };
  lock.on('error', onLost);
  try {
    await getUpload(id);
    held = (await lock.query<{ locked: boolean }>('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked', [`conversion-input:${conversionId(id)}`])).rows[0].locked;
    if (!held) throw new DomainError('文件仍在上传，暂不能清理。', 409, 'UPLOAD_BUSY');
    if (lockLost) throw new DomainError('清理连接已中断，请重试。', 503, 'CLEANUP_INTERRUPTED');
    await accountTransaction(async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`conversion-quota:${currentAccountId()}`]);
      const jobs = await client.query<JobRow>('SELECT * FROM conversion_jobs WHERE upload_id=$1 FOR UPDATE', [id]);
      if (jobs.rows.some(job => job.state === 'running' || job.state === 'queued')) throw new DomainError('该文件仍有待处理任务，请先完成或取消任务。', 409, 'JOB_RUNNING');
      for (const job of jobs.rows) await removeJobFiles(job.id);
      await removeInput(id);
      await client.query('DELETE FROM conversion_jobs WHERE upload_id=$1', [id]);
      await client.query('DELETE FROM conversion_uploads WHERE id=$1', [id]);
    });
  } finally {
    if (held && !lockLost) await lock.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [`conversion-input:${id}`]).catch(() => {});
    lock.off('error', onLost);
    lock.release(lockLost);
  }
}

export async function downloadOutput(id: string, head = false): Promise<Response> {
  const [output] = await accountQuery<OutputRow>(`SELECT output.* FROM conversion_outputs output JOIN conversion_jobs job ON job.owner_id=output.owner_id AND job.id=output.job_id
    WHERE output.id=$1 AND job.state='succeeded' AND job.expires_at>now()`, [conversionId(id)]);
  if (!output) throw new DomainError('转换结果不存在或已到期。', 404, 'NOT_FOUND');
  const handle = await openPrivateFile(inside(await jobDirectory(output.job_id), output.storage_name), Number(output.bytes));
  const headers = { ...privateHeaders, 'Content-Type': 'application/octet-stream', 'Content-Length': output.bytes,
    'Content-Disposition': `attachment; filename="converted-file"; filename*=UTF-8''${encodeURIComponent(output.name).replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16))}` };
  if (head) { await handle.close(); return new Response(null, { headers }); }
  let closed = false, offset = 0;
  const close = async () => { if (!closed) { closed = true; await handle.close(); } };
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const buffer = Buffer.allocUnsafe(Math.min(256 * 1024, Number(output.bytes) - offset));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
        if (!bytesRead) { await close(); controller.close(); return; }
        offset += bytesRead;
        controller.enqueue(new Uint8Array(buffer.subarray(0, bytesRead)));
        if (offset === Number(output.bytes)) { await close(); controller.close(); }
      } catch (error) { await close(); controller.error(error); }
    }, cancel: close,
  });
  return new Response(stream, { headers });
}
