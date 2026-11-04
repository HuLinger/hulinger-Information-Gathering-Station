import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, lstat, mkdir, open, readdir, realpath, statfs, unlink, type FileHandle } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import type { Pool, PoolClient, QueryResultRow } from 'pg';
import type { DriveFile, DriveListing, DrivePart, DriveUpload } from '../../shared/drive-contracts';
import { readDriveConfig, type DriveConfig } from './config';
import { DriveError, storageError } from './errors';
import { disposition, parseByteRange, safeFilename, validId } from './validation';

interface FileRow extends QueryResultRow {
  id: string; owner_id: string; name: string; size: string; status: DriveFile['status']; chunk_size: number; chunk_count: number;
  last_modified: string; fingerprint: string; created_at: Date; updated_at: Date; completed_at: Date | null; deleted_at: Date | null;
  uploaded_bytes?: string; activity_at?: Date;
}
const CAPACITY_LOCK = 842_106;
const TRANSFER_LOCK = 842_107;
const BYTE_TIMEOUT = 45_000;
const REQUEST_TIMEOUT = 15 * 60_000;
const metadata = `f.*, COALESCE((SELECT sum(bytes) FROM drive_parts p WHERE p.file_id=f.id),0)::text AS uploaded_bytes,
  GREATEST(f.updated_at,COALESCE((SELECT max(updated_at) FROM drive_parts p WHERE p.file_id=f.id),f.updated_at)) AS activity_at`;
const missing = () => new DriveError(404, 'NOT_FOUND', '文件不存在或无权访问。');
const conflict = (message: string) => new DriveError(409, 'STATE_CONFLICT', message);

export class DriveStore {
  readonly config: DriveConfig;
  readonly root: string;
  private readonly database: Pool;
  private readonly uploadDatabase: Pool;

  constructor(options: { database: Pool; uploadDatabase?: Pool; root: string; config?: Partial<DriveConfig> }) {
    this.database = options.database;
    this.uploadDatabase = options.uploadDatabase ?? options.database;
    this.root = resolve(options.root);
    this.config = { ...readDriveConfig(), ...options.config };
    const publicRoot = resolve('public');
    const publicRelative = relative(publicRoot, this.root);
    if (!publicRelative || (!publicRelative.startsWith(`..${sep}`) && publicRelative !== '..' && !isAbsolute(publicRelative))) {
      throw new Error('Drive storage must not be inside the public directory.');
    }
  }

  private async transaction<T>(fn: (client: PoolClient) => Promise<T>, uploads = false): Promise<T> {
    const client = await (uploads ? this.uploadDatabase : this.database).connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout='5s'");
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      if (error && typeof error === 'object' && 'code' in error && error.code === '55P03') throw new DriveError(429, 'TRANSFER_BUSY', '文件正在处理，请稍后重试。');
      return storageError(error);
    } finally { client.release(); }
  }

  private map(row: FileRow): DriveFile {
    return {
      id: row.id, name: row.name, size: Number(row.size), status: row.status,
      chunkSize: row.chunk_size, chunkCount: row.chunk_count, uploadedBytes: Number(row.uploaded_bytes ?? 0),
      lastModified: Number(row.last_modified), fingerprint: row.fingerprint,
      createdAt: row.created_at.toISOString(), updatedAt: (row.activity_at ?? row.updated_at).toISOString(),
      completedAt: row.completed_at?.toISOString() ?? null, deletedAt: row.deleted_at?.toISOString() ?? null,
      etag: `"${row.id}-${row.size}"`,
    };
  }

  private async storage(): Promise<string> {
    try {
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      const rootStat = await lstat(this.root);
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new DriveError(503, 'UNSAFE_STORAGE', '云盘根目录必须是独立的真实目录。');
      const actual = await realpath(this.root);
      const actualRoot = resolve(actual);
      if ((process.platform === 'win32' ? actualRoot.toLowerCase() !== this.root.toLowerCase() : actualRoot !== this.root)) throw new DriveError(503, 'UNSAFE_STORAGE', '云盘路径不能经过符号链接。');
      const directory = join(this.root, 'objects');
      await mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error; });
      const details = await lstat(directory);
      if (!details.isDirectory() || details.isSymbolicLink()) throw new DriveError(503, 'UNSAFE_STORAGE', '云盘对象目录不能使用符号链接。');
      return directory;
    } catch (error) { return storageError(error); }
  }

  private async path(id: string) { return join(await this.storage(), `${validId(id)}.bin`); }

  private async fileHandle(id: string, writable = false): Promise<FileHandle> {
    const path = await this.path(id);
    const entry = await lstat(path);
    if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1) throw new DriveError(503, 'UNSAFE_STORAGE', '存储对象类型不安全。');
    const handle = await open(path, (writable ? constants.O_RDWR : constants.O_RDONLY) | (constants.O_NOFOLLOW ?? 0));
    const actual = await handle.stat();
    // Windows lstat can report dev=0 while fstat reports the volume ID for the same file.
    const deviceChanged = actual.dev !== entry.dev && !(process.platform === 'win32' && entry.dev === 0);
    if (!actual.isFile() || actual.nlink !== 1 || deviceChanged || actual.ino !== entry.ino) {
      await handle.close();
      throw new DriveError(503, 'UNSAFE_STORAGE', '存储对象在读取时发生变化。');
    }
    return handle;
  }

  private async capacity(client: Pool | PoolClient): Promise<DriveListing['capacity']> {
    const [disk, totals] = await Promise.all([
      statfs(await this.storage(), { bigint: true }),
      client.query<{ used: string; reserved: string; total: string }>(`SELECT
        COALESCE(sum(size) FILTER(WHERE status<>'uploading'),0)::text AS used,
        COALESCE(sum(GREATEST(0,size-COALESCE((SELECT sum(bytes) FROM drive_parts p WHERE p.file_id=f.id),0))) FILTER(WHERE status='uploading'),0)::text AS reserved,
        COALESCE(sum(size),0)::text AS total FROM drive_files f`),
    ]);
    const maximum = BigInt(Number.MAX_SAFE_INTEGER);
    const bytes = disk.bavail * disk.bsize;
    const freeBytes = Number(bytes > maximum ? maximum : bytes);
    const row = totals.rows[0];
    const usedBytes = Number(row.used);
    const reservedBytes = Number(row.reserved);
    const diskAvailable = Math.max(0, freeBytes - this.config.reserveBytes - reservedBytes);
    const availableBytes = Math.max(0, Math.min(diskAvailable, this.config.quotaBytes === null ? Infinity : this.config.quotaBytes - Number(row.total)));
    return { usedBytes, reservedBytes, freeBytes, availableBytes, quotaBytes: this.config.quotaBytes };
  }

  async list(ownerId: string, options: { view: 'files' | 'trash'; q?: string; page?: number }): Promise<DriveListing> {
    const page = options.page ?? 1;
    if (!Number.isSafeInteger(page) || page < 1 || page > 100000 || (options.q?.length ?? 0) > 200) throw new DriveError(400, 'INVALID_INPUT', '搜索条件或页码无效。');
    const status = options.view === 'trash' ? 'trash' : 'ready';
    const search = (options.q ?? '').trim();
    const values = [ownerId, status, search];
    const filter = "f.owner_id=$1 AND f.status=$2 AND ($3='' OR strpos(lower(f.name),lower($3))>0)";
    const [files, count, uploads, capacity] = await Promise.all([
      this.database.query<FileRow>(`SELECT ${metadata} FROM drive_files f WHERE ${filter} ORDER BY f.created_at DESC,f.id LIMIT 20 OFFSET $4`, [...values, (page - 1) * 20]),
      this.database.query<{ count: string }>(`SELECT count(*) FROM drive_files f WHERE ${filter}`, values),
      this.database.query<FileRow>(`SELECT ${metadata} FROM drive_files f WHERE f.owner_id=$1 AND f.status='uploading' ORDER BY f.created_at DESC LIMIT 50`, [ownerId]),
      this.capacity(this.database),
    ]);
    const { chunkSize, maxFileBytes, defaultParallel, maxParallel, uploadRetentionDays, trashRetentionDays } = this.config;
    return { files: files.rows.map((row) => this.map(row)), uploads: uploads.rows.map((row) => this.map(row)), total: Number(count.rows[0].count), page, capacity,
      config: { chunkSize, maxFileBytes, defaultParallel, maxParallel, uploadRetentionDays, trashRetentionDays } };
  }

  async getFile(ownerId: string, id: string): Promise<DriveUpload> {
    validId(id);
    const { rows } = await this.database.query<FileRow>(`SELECT ${metadata} FROM drive_files f WHERE f.id=$1 AND f.owner_id=$2 AND f.status<>'deleting'`, [id, ownerId]);
    if (!rows[0]) throw missing();
    const parts = await this.database.query<{ part_index: number; sha256: string }>('SELECT part_index,sha256 FROM drive_parts WHERE file_id=$1 ORDER BY part_index', [id]);
    return { file: this.map(rows[0]), parts: parts.rows.map((part): DrivePart => ({ index: part.part_index, sha256: part.sha256 })) };
  }

  async createUpload(ownerId: string, input: { name: string; size: number; lastModified: number; fingerprint: string }): Promise<DriveUpload> {
    const name = safeFilename(input.name);
    if (!Number.isSafeInteger(input.size) || input.size < 0 || input.size > this.config.maxFileBytes || Math.ceil(input.size / this.config.chunkSize) > 100000) throw new DriveError(413, 'FILE_TOO_LARGE', '文件大小超过当前云盘允许范围。');
    if (!Number.isSafeInteger(input.lastModified) || input.lastModified < 0 || !/^[a-f0-9]{64}$/.test(input.fingerprint)) throw new DriveError(400, 'INVALID_INPUT', '文件标识无效，请重新选择文件。');
    const id = await this.transaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock($1)', [CAPACITY_LOCK]);
      const existing = await client.query<{ id: string }>(`SELECT id FROM drive_files WHERE owner_id=$1 AND fingerprint=$2 AND size=$3 AND last_modified=$4 AND name=$5 AND status='uploading' ORDER BY created_at LIMIT 1`, [ownerId, input.fingerprint, input.size, input.lastModified, name]);
      if (existing.rows[0]) return existing.rows[0].id;
      const count = await client.query<{ count: string }>("SELECT count(*) FROM drive_files WHERE owner_id=$1 AND status='uploading'", [ownerId]);
      if (Number(count.rows[0].count) >= this.config.maxPendingUploads) throw new DriveError(429, 'TOO_MANY_UPLOADS', '待完成上传过多，请先继续或取消已有任务。');
      const capacity = await this.capacity(client);
      if (input.size > capacity.availableBytes) throw new DriveError(507, 'STORAGE_FULL', '可用空间不足，已扣除其他上传任务预留空间。请清理文件后重试。');
      const id = randomUUID();
      const path = await this.path(id);
      const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | (constants.O_NOFOLLOW ?? 0), 0o600);
      try { await handle.truncate(input.size); await handle.sync(); } finally { await handle.close(); }
      // A rolled-back insert may leave only a UUID object. Cleanup removes old unreferenced objects.
      await client.query(`INSERT INTO drive_files(id,owner_id,name,size,chunk_size,chunk_count,last_modified,fingerprint)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [id, ownerId, name, input.size, this.config.chunkSize, Math.ceil(input.size / this.config.chunkSize), input.lastModified, input.fingerprint]);
      return id;
    });
    return this.getFile(ownerId, id);
  }

  async writePart(ownerId: string, id: string, index: number, request: Request): Promise<{ ok: true; index: number; uploadedBytes: number }> {
    validId(id);
    if (!Number.isSafeInteger(index) || index < 0) throw new DriveError(400, 'INVALID_PART', '分片编号无效。');
    const digest = request.headers.get('x-chunk-sha256');
    if (!digest || !/^[a-f0-9]{64}$/.test(digest)) throw new DriveError(400, 'INVALID_CHECKSUM', '缺少有效的分片校验值。');
    await this.transaction(async (client) => {
      const partLock = await client.query<{ acquired: boolean }>('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS acquired', [`drive-part:${id}:${index}`]);
      if (!partLock.rows[0].acquired) throw new DriveError(429, 'TRANSFER_BUSY', '此分片正在上传，请稍后重试。');
      let slot = false;
      for (let i = 0; i < this.config.maxParallel; i++) {
        const result = await client.query<{ acquired: boolean }>('SELECT pg_try_advisory_xact_lock($1,$2) AS acquired', [TRANSFER_LOCK, i]);
        if (result.rows[0].acquired) { slot = true; break; }
      }
      if (!slot) throw new DriveError(429, 'TRANSFER_BUSY', '上传通道已满，请稍后重试。');
      const result = await client.query<FileRow>('SELECT * FROM drive_files WHERE id=$1 AND owner_id=$2 FOR SHARE', [id, ownerId]);
      const row = result.rows[0];
      if (!row) throw missing();
      if (row.status !== 'uploading') throw conflict('此文件已完成或正在清理，不能再写入分片。');
      if (index >= row.chunk_count) throw new DriveError(400, 'INVALID_PART', '分片超出文件范围。');
      const length = Math.min(row.chunk_size, Number(row.size) - index * row.chunk_size);
      const headerLength = request.headers.get('content-length');
      if (headerLength !== null && (!/^\d+$/.test(headerLength) || Number(headerLength) !== length)) throw new DriveError(400, 'LENGTH_MISMATCH', '分片长度与文件范围不一致。');
      const existing = await client.query<{ sha256: string }>('SELECT sha256 FROM drive_parts WHERE file_id=$1 AND part_index=$2', [id, index]);
      if (existing.rows[0]) {
        if (existing.rows[0].sha256 !== digest) throw conflict('该分片已保存其他内容，请重新选择原文件或取消此上传。');
        await request.body?.cancel().catch(() => {});
        return;
      }
      if (!request.body) throw new DriveError(400, 'EMPTY_BODY', '上传内容为空。');
      const handle = await this.fileHandle(id, true);
      const reader = request.body.getReader();
      const hash = createHash('sha256');
      const deadline = Date.now() + REQUEST_TIMEOUT;
      let received = 0;
      try {
        if ((await handle.stat()).size !== Number(row.size)) throw new DriveError(503, 'FILE_SIZE_MISMATCH', '暂存文件大小异常，请取消后重新上传。');
        while (true) {
          if (request.signal.aborted) throw new DriveError(499, 'TRANSFER_ABORTED', '上传已暂停，已完成分片会保留。');
          let timer: ReturnType<typeof setTimeout> | undefined;
          const pending = reader.read();
          const timeout = new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new DriveError(408, 'UPLOAD_TIMEOUT', '上传连接长时间没有进展，请重试。')), Math.max(1, Math.min(BYTE_TIMEOUT, deadline - Date.now())));
          });
          const chunk = await Promise.race([pending, timeout]).finally(() => clearTimeout(timer));
          if (chunk.done) break;
          if (received + chunk.value.byteLength > length) throw new DriveError(413, 'PART_TOO_LARGE', '分片内容超出预期长度。');
          hash.update(chunk.value);
          let written = 0;
          while (written < chunk.value.byteLength) {
            const result = await handle.write(chunk.value, written, chunk.value.byteLength - written, index * row.chunk_size + received + written);
            if (!result.bytesWritten) throw new Error('Drive file write made no progress.');
            written += result.bytesWritten;
          }
          received += chunk.value.byteLength;
        }
        if (received !== length) throw new DriveError(400, 'LENGTH_MISMATCH', '分片传输不完整，请重试该分片。');
        if (hash.digest('hex') !== digest) throw new DriveError(422, 'CHECKSUM_MISMATCH', '分片校验失败，请重新传输。');
        await handle.datasync();
        await client.query('INSERT INTO drive_parts(file_id,part_index,bytes,sha256) VALUES($1,$2,$3,$4)', [id, index, length, digest]);
        // Never UPDATE the parent under FOR SHARE: parallel lock upgrades would deadlock.
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
        await handle.close();
      }
    }, true);
    const result = await this.database.query<{ bytes: string }>('SELECT COALESCE(sum(bytes),0)::text AS bytes FROM drive_parts WHERE file_id=$1', [id]);
    return { ok: true, index, uploadedBytes: Number(result.rows[0].bytes) };
  }

  async completeUpload(ownerId: string, id: string): Promise<DriveFile> {
    validId(id);
    await this.transaction(async (client) => {
      const result = await client.query<FileRow>('SELECT * FROM drive_files WHERE id=$1 AND owner_id=$2 FOR UPDATE', [id, ownerId]);
      const row = result.rows[0];
      if (!row) throw missing();
      if (row.status === 'ready') return;
      if (row.status !== 'uploading') throw conflict('此上传已取消或文件已进入回收站。');
      const parts = await client.query<{ count: string; bytes: string }>('SELECT count(*),COALESCE(sum(bytes),0)::text AS bytes FROM drive_parts WHERE file_id=$1', [id]);
      if (Number(parts.rows[0].count) !== row.chunk_count || Number(parts.rows[0].bytes) !== Number(row.size)) throw conflict('还有分片尚未完成，请继续上传后再确认。');
      const handle = await this.fileHandle(id, true);
      try {
        if ((await handle.stat()).size !== Number(row.size)) throw new DriveError(503, 'FILE_SIZE_MISMATCH', '文件大小异常，暂不能完成上传。');
        await handle.sync();
      } finally { await handle.close(); }
      // Persist the directory entry on POSIX before metadata can expose the immutable object.
      if (process.platform !== 'win32') {
        const directory = await open(await this.storage(), constants.O_RDONLY);
        try { await directory.sync(); } finally { await directory.close(); }
      }
      await client.query("UPDATE drive_files SET status='ready',completed_at=now(),updated_at=now() WHERE id=$1", [id]);
    });
    return (await this.getFile(ownerId, id)).file;
  }

  async action(ownerId: string, id: string, input: { action: 'rename' | 'trash' | 'restore' | 'purge' | 'cancel'; name?: string; confirm?: boolean }): Promise<{ ok: true; file?: DriveFile }> {
    validId(id);
    const remove = await this.transaction(async (client) => {
      const result = await client.query<FileRow>('SELECT * FROM drive_files WHERE id=$1 AND owner_id=$2 FOR UPDATE', [id, ownerId]);
      const row = result.rows[0];
      if (!row) throw missing();
      if (input.action === 'rename') {
        if (row.status !== 'ready') throw conflict('只能重命名已完成的文件。');
        await client.query('UPDATE drive_files SET name=$2,updated_at=now() WHERE id=$1', [id, safeFilename(input.name)]);
      } else if (input.action === 'trash') {
        if (row.status !== 'ready') throw conflict('只能将已完成文件移入回收站。');
        await client.query("UPDATE drive_files SET status='trash',deleted_at=now(),updated_at=now() WHERE id=$1", [id]);
      } else if (input.action === 'restore') {
        if (row.status !== 'trash') throw conflict('此文件不在回收站中。');
        const handle = await this.fileHandle(id);
        await handle.close();
        await client.query("UPDATE drive_files SET status='ready',deleted_at=NULL,updated_at=now() WHERE id=$1", [id]);
      } else if (input.action === 'purge' || input.action === 'cancel') {
        if (input.confirm !== true) throw new DriveError(400, 'CONFIRM_REQUIRED', '请确认不可恢复的清理操作。');
        if (row.status !== 'deleting' && row.status !== (input.action === 'purge' ? 'trash' : 'uploading')) throw conflict('文件状态已变化，请刷新后重试。');
        await client.query("UPDATE drive_files SET status='deleting',updated_at=now() WHERE id=$1", [id]);
        return true;
      } else throw new DriveError(400, 'INVALID_ACTION', '不支持此文件操作。');
      return false;
    });
    if (remove) { await this.removeObject(id); return { ok: true }; }
    return { ok: true, file: (await this.getFile(ownerId, id)).file };
  }

  private async removeObject(id: string): Promise<void> {
    try {
      const path = await this.path(id);
      // Unlink only this server-generated name; never recursively follow object paths.
      await unlink(path).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
      await this.database.query("DELETE FROM drive_files WHERE id=$1 AND status='deleting'", [id]);
    } catch (error) { return storageError(error); }
  }

  async downloadInfo(ownerId: string, id: string): Promise<{ file: DriveFile; headers: Headers }> {
    // Range requests need only immutable file metadata, not every part's checksum.
    // The explicit file-details endpoint supplies hashes for verified browser downloads.
    const { rows } = await this.database.query<FileRow>(
      "SELECT f.*,f.size::text AS uploaded_bytes FROM drive_files f WHERE f.id=$1 AND f.owner_id=$2 AND f.status='ready'",
      [validId(id), ownerId],
    );
    if (!rows[0]) throw missing();
    const file = this.map(rows[0]);
    const handle = await this.fileHandle(id).catch(storageError);
    try { if ((await handle.stat()).size !== file.size) throw new DriveError(503, 'FILE_SIZE_MISMATCH', '文件存储状态异常，请由管理员检查。'); }
    finally { await handle.close(); }
    return { file, headers: new Headers({
      'Content-Type': 'application/octet-stream', 'Content-Disposition': disposition(file.name),
      'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "sandbox; default-src 'none'", 'Accept-Ranges': 'bytes', ETag: file.etag,
      'Last-Modified': new Date(file.completedAt!).toUTCString(),
    }) };
  }

  async download(ownerId: string, id: string, request: Request): Promise<Response> {
    const { file, headers } = await this.downloadInfo(ownerId, id);
    let requestedRange = request.headers.get('range');
    const ifRange = request.headers.get('if-range');
    if (ifRange && ifRange !== file.etag) {
      const date = Date.parse(ifRange);
      if (!Number.isFinite(date) || Math.floor(Date.parse(file.completedAt!) / 1000) > Math.floor(date / 1000)) requestedRange = null;
    }
    let range: { start: number; end: number } | null;
    try { range = parseByteRange(requestedRange, file.size); }
    catch (error) {
      if (!(error instanceof DriveError) || error.status !== 416) throw error;
      headers.set('Content-Range', `bytes */${file.size}`);
      headers.set('Content-Length', '0');
      return new Response(null, { status: 416, headers });
    }
    const start = range?.start ?? 0;
    const end = range?.end ?? file.size - 1;
    headers.set('Content-Length', String(range ? end - start + 1 : file.size));
    if (range) headers.set('Content-Range', `bytes ${start}-${end}/${file.size}`);
    if (request.method === 'HEAD' || file.size === 0) return new Response(null, { status: range ? 206 : 200, headers });
    const handle = await this.fileHandle(id).catch(storageError);
    const stream = handle.createReadStream({ start, end, highWaterMark: 256 * 1024, autoClose: true, signal: request.signal });
    return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, { status: range ? 206 : 200, headers });
  }

  async cleanup(): Promise<{ removed: number; orphaned: number }> {
    const ids = await this.transaction(async (client) => {
      const result = await client.query<{ id: string }>(`SELECT f.id FROM drive_files f WHERE
        f.status='deleting' OR (f.status='trash' AND f.deleted_at < now()-$1::int*interval '1 day') OR
        (f.status='uploading' AND GREATEST(f.updated_at,COALESCE((SELECT max(updated_at) FROM drive_parts p WHERE p.file_id=f.id),f.updated_at)) < now()-$2::int*interval '1 day')
        ORDER BY f.created_at LIMIT 100 FOR UPDATE OF f SKIP LOCKED`, [this.config.trashRetentionDays, this.config.uploadRetentionDays]);
      const ids = result.rows.map((row) => row.id);
      if (ids.length) await client.query("UPDATE drive_files SET status='deleting',updated_at=now() WHERE id=ANY($1::uuid[])", [ids]);
      return ids;
    });
    for (const id of ids) await this.removeObject(id);
    let orphaned = 0;
    const directory = await this.storage();
    const cutoff = Date.now() - 24 * 60 * 60_000;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!/^[a-f0-9-]{36}\.bin$/.test(entry.name) || !entry.isFile()) continue;
      const path = join(directory, entry.name);
      const details = await lstat(path);
      if (details.mtimeMs >= cutoff || details.isSymbolicLink()) continue;
      const id = validId(entry.name.slice(0, -4));
      const present = await this.database.query('SELECT 1 FROM drive_files WHERE id=$1', [id]);
      if (!present.rowCount) { await unlink(path); orphaned++; }
    }
    return { removed: ids.length, orphaned };
  }

  async checkStorage(): Promise<void> { await access(await this.storage(), constants.R_OK | constants.W_OK); }
}
