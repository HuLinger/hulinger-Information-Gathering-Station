import type { DriveFile, DriveUpload } from '../../shared/drive-contracts';
import { ApiError } from '../api';

export interface TransferProgress {
  phase: 'checking' | 'transferring' | 'finishing';
  bytes: number;
  committedBytes: number;
  total: number;
  bytesPerSecond: number;
  remainingSeconds: number | null;
}
export interface DownloadSink {
  write(data: { type: 'write'; position: number; data: Uint8Array<ArrayBuffer> }): Promise<void>;
}
export type ChunkSender = (id: string, index: number, chunk: Blob, hash: string, signal: AbortSignal, progress: (bytes: number) => void) => Promise<void>;
export type RangeRequester = (url: string, options: RequestInit) => Promise<Response>;

export function abortError() { return new DOMException('传输已暂停。', 'AbortError'); }
export function isAbort(error: unknown) { return error instanceof Error && error.name === 'AbortError'; }
function checkAbort(signal: AbortSignal) { if (signal.aborted) throw abortError(); }
export function partLength(file: DriveFile, index: number) { return Math.min(file.chunkSize, file.size - index * file.chunkSize); }

export async function sha256(data: ArrayBuffer) {
  if (!globalThis.crypto?.subtle) throw new Error('文件校验需要 HTTPS 或本机安全连接，请使用安全地址打开网站。');
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function fileFingerprint(file: File, signal: AbortSignal) {
  checkAbort(signal);
  // A bounded candidate hint; every previously uploaded part is checked separately.
  const hint = new Blob([`${file.size}:${file.lastModified}:`, file.slice(0, 65536), file.slice(Math.max(0, file.size - 65536))]);
  const result = await sha256(await hint.arrayBuffer());
  checkAbort(signal);
  return result;
}

export function delay(ms: number, signal: AbortSignal): Promise<void> {
  checkAbort(signal);
  return new Promise((resolve, reject) => {
    const onAbort = () => { clearTimeout(timer); reject(abortError()); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export async function retryTransfer<T>(work: () => Promise<T>, signal: AbortSignal, wait = delay): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    checkAbort(signal);
    try { return await work(); }
    catch (error) {
      checkAbort(signal);
      const retryable = error instanceof TypeError || error instanceof ApiError && (error.status === 0 || error.status === 408 || error.status === 429 || error.status >= 500);
      if (!retryable || attempt >= 2) throw error;
      await wait(600 * 2 ** attempt, signal);
    }
  }
}

/** Await all workers before returning, so pause/retry never overlaps old writes. */
export async function runPool<T>(items: readonly T[], parallel: number, signal: AbortSignal, work: (item: T, signal: AbortSignal) => Promise<void>) {
  checkAbort(signal);
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  let cursor = 0;
  let failure: unknown;
  let failed = false;
  try {
    const count = Math.min(items.length, Math.max(1, Math.min(8, Math.floor(parallel) || 1)));
    await Promise.all(Array.from({ length: count }, async () => {
      try {
        while (!controller.signal.aborted) {
          const index = cursor++;
          if (index >= items.length) break;
          await work(items[index], controller.signal);
        }
      } catch (error) {
        if (!failed) { failure = error; failed = true; }
        controller.abort();
      }
    }));
    checkAbort(signal);
    if (failed) throw failure;
  } finally { signal.removeEventListener('abort', abort); }
}

function progressMeter(total: number, onProgress: (value: TransferProgress) => void) {
  let network = 0;
  let lastReport = -Infinity;
  const samples: { time: number; bytes: number }[] = [{ time: performance.now(), bytes: 0 }];
  return {
    transferred(bytes: number) { network += Math.max(0, bytes); },
    report(phase: TransferProgress['phase'], bytes: number, committedBytes: number, force = false) {
      const now = performance.now();
      if (!force && now - lastReport < 120) return;
      lastReport = now;
      samples.push({ time: now, bytes: network });
      while (samples.length > 2 && samples[1].time < now - 5000) samples.shift();
      const elapsed = (now - samples[0].time) / 1000;
      const speed = phase === 'transferring' && elapsed >= 0.2 ? (network - samples[0].bytes) / elapsed : 0;
      onProgress({ phase, bytes: Math.min(total, bytes), committedBytes, total, bytesPerSecond: speed, remainingSeconds: speed > 0 ? Math.max(0, total - bytes) / speed : null });
    },
  };
}

export const sendChunk: ChunkSender = (id, index, chunk, hash, signal, progress) => {
  checkAbort(signal);
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      if (error) reject(error); else resolve();
    };
    const onAbort = () => { xhr.abort(); finish(abortError()); };
    xhr.upload.onprogress = (event) => progress(Math.min(chunk.size, event.loaded));
    xhr.onerror = () => finish(new ApiError('分片连接中断，请检查网络后重试。', 0));
    xhr.ontimeout = () => finish(new ApiError('分片上传超时，可以继续已保存的进度。', 408));
    xhr.onabort = () => finish(abortError());
    xhr.onload = () => {
      let response: Record<string, unknown> = {};
      try { const parsed: unknown = JSON.parse(xhr.responseText); if (parsed && typeof parsed === 'object') response = parsed as Record<string, unknown>; } catch { /* Validate the response below. */ }
      if (xhr.status >= 200 && xhr.status < 300 && response.ok === true && response.index === index && Number.isSafeInteger(response.uploadedBytes) && Number(response.uploadedBytes) >= chunk.size) finish();
      else finish(new ApiError(typeof response.error === 'string' ? response.error : xhr.status === 401 ? '登录已失效，请重新登录后续传。' : '分片未获服务器确认，请重试。', xhr.status >= 200 && xhr.status < 300 ? 502 : xhr.status, typeof response.code === 'string' ? response.code : undefined));
    };
    xhr.open('PUT', `/api/drive/uploads/${encodeURIComponent(id)}/parts/${index}`);
    xhr.timeout = 30 * 60 * 1000;
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.setRequestHeader('X-Chunk-SHA256', hash);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort(); else xhr.send(chunk);
  });
};

export async function uploadParts(options: {
  local: File; upload: DriveUpload; parallel: number; signal: AbortSignal;
  onProgress: (value: TransferProgress) => void; send?: ChunkSender;
}) {
  const { local, upload, parallel, signal, onProgress, send = sendChunk } = options;
  const { file, parts } = upload;
  if (local.size !== file.size || local.lastModified !== file.lastModified) throw new ApiError('所选文件的大小或修改时间不同，请重新选择原文件。', 409, 'RESUME_MISMATCH');
  const meter = progressMeter(file.size, onProgress);
  const complete = new Set<number>();
  let committed = 0;
  meter.report('checking', 0, 0, true);
  // Verify every existing part before sending any new data. A fingerprint alone is insufficient.
  await runPool(parts, parallel, signal, async (part, partSignal) => {
    const start = part.index * file.chunkSize;
    const actual = await sha256(await local.slice(start, start + partLength(file, part.index)).arrayBuffer());
    checkAbort(partSignal);
    if (actual !== part.sha256) throw new ApiError('所选文件与已上传内容不一致，未继续上传。请选择原文件，或取消旧任务后重新上传。', 409, 'RESUME_MISMATCH');
    complete.add(part.index);
    committed += partLength(file, part.index);
    meter.report('checking', committed, committed);
  });
  const inFlight = new Map<number, number>();
  const report = (force = false) => meter.report('transferring', committed + [...inFlight.values()].reduce((sum, value) => sum + value, 0), committed, force);
  report(true);
  const missing = Array.from({ length: file.chunkCount }, (_, index) => index).filter((index) => !complete.has(index));
  const ticker = setInterval(() => report(), 1000);
  try {
    await runPool(missing, parallel, signal, async (index, partSignal) => {
      const start = index * file.chunkSize;
      const chunk = local.slice(start, start + partLength(file, index));
      const hash = await sha256(await chunk.arrayBuffer());
      checkAbort(partSignal);
      await retryTransfer(async () => {
        let previous = 0;
        inFlight.set(index, 0);
        await send(file.id, index, chunk, hash, partSignal, (bytes) => {
          const current = Math.max(0, Math.min(chunk.size, bytes));
          meter.transferred(Math.max(0, current - previous)); previous = current;
          inFlight.set(index, current); report();
        });
        meter.transferred(chunk.size - previous);
      }, partSignal);
      inFlight.delete(index);
      committed += chunk.size;
      report(true);
    });
  } finally { clearInterval(ticker); }
  meter.report('finishing', file.size, committed, true);
}

async function readRange(response: Response, file: DriveFile, index: number, signal: AbortSignal, onBytes: (bytes: number) => void) {
  const start = index * file.chunkSize;
  const length = partLength(file, index);
  const expected = `bytes ${start}-${start + length - 1}/${file.size}`;
  if (response.status !== 206 || response.headers.get('Content-Range') !== expected || response.headers.get('ETag') !== file.etag) {
    await response.body?.cancel();
    const status = response.ok ? 409 : response.status;
    throw new ApiError(status === 401 ? '登录已失效，请重新登录后下载。' : '未收到匹配的文件分片。请刷新文件列表后重试，或使用普通下载。', status, 'INVALID_RANGE');
  }
  const declared = response.headers.get('Content-Length');
  if (declared !== null && Number(declared) !== length) { await response.body?.cancel(); throw new ApiError('下载分片长度不符，未写入文件。', 422, 'INVALID_RANGE'); }
  const reader = response.body?.getReader();
  if (!reader) throw new ApiError('下载响应为空，请重试。', 502);
  const data = new Uint8Array(length);
  let received = 0;
  try {
    while (true) {
      checkAbort(signal);
      const { done, value } = await reader.read();
      if (done) break;
      if (received + value.length > length) throw new ApiError('服务器返回的分片超出请求范围，已停止下载。', 422, 'INVALID_RANGE');
      data.set(value, received); received += value.length; onBytes(value.length);
    }
    checkAbort(signal);
    if (received !== length) throw new ApiError('下载分片不完整，请重试。', 502);
    return data;
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export async function downloadParts(options: {
  upload: DriveUpload; sink: DownloadSink; completed: Set<number>; parallel: number; signal: AbortSignal;
  onProgress: (value: TransferProgress) => void; request?: RangeRequester;
}) {
  const { upload, sink, completed, parallel, signal, onProgress, request = fetch } = options;
  const { file, parts } = upload;
  if (file.status !== 'ready' || parts.length !== file.chunkCount) throw new ApiError('文件尚未就绪或校验信息不完整，请刷新列表后重试。', 409);
  const hashes = new Map(parts.map((part) => [part.index, part.sha256]));
  let committed = [...completed].reduce((sum, index) => sum + partLength(file, index), 0);
  const meter = progressMeter(file.size, onProgress);
  const inFlight = new Map<number, number>();
  const report = (force = false) => meter.report('transferring', committed + [...inFlight.values()].reduce((sum, value) => sum + value, 0), committed, force);
  let writeChain: Promise<void> = Promise.resolve();
  let writeFailed = false;
  report(true);
  const ticker = setInterval(() => report(), 1000);
  try {
    await runPool(Array.from({ length: file.chunkCount }, (_, index) => index).filter((index) => !completed.has(index)), parallel, signal, async (index, partSignal) => {
      const start = index * file.chunkSize;
      const data = await retryTransfer(async () => {
        inFlight.set(index, 0);
        const response = await request(`/api/drive/files/${encodeURIComponent(file.id)}/content`, { credentials: 'same-origin', cache: 'no-store', signal: partSignal, headers: { Range: `bytes=${start}-${start + partLength(file, index) - 1}`, 'If-Range': file.etag } });
        const buffer = await readRange(response, file, index, partSignal, (bytes) => { meter.transferred(bytes); inFlight.set(index, (inFlight.get(index) ?? 0) + bytes); report(); });
        if (await sha256(buffer.buffer) !== hashes.get(index)) throw new ApiError('下载内容校验失败，未写入该分片。请重试或使用普通下载。', 422, 'CHECKSUM_MISMATCH');
        return buffer;
      }, partSignal);
      checkAbort(partSignal);
      // Serialize disk writes, and make each worker await its own write before fetching another part.
      const writing = writeChain.then(async () => {
        checkAbort(partSignal);
        try {
          if (writeFailed) throw new Error('A previous disk write failed');
          await sink.write({ type: 'write', position: start, data });
        } catch { writeFailed = true; throw new ApiError('本地文件写入失败。请检查磁盘空间与文件权限，然后重新选择保存位置。', 0, 'LOCAL_WRITE_FAILED'); }
        completed.add(index); committed += data.byteLength; inFlight.delete(index); report(true);
      });
      writeChain = writing.catch(() => {});
      await writing;
    });
  } finally { clearInterval(ticker); }
  meter.report('finishing', file.size, committed, true);
}
