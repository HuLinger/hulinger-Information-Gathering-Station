import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';

// Run only against a stopped, isolated restore before exposing it or starting cleanup.
if (!process.env.DATABASE_URL || !process.env.DRIVE_STORAGE_PATH) throw new Error('DATABASE_URL and DRIVE_STORAGE_PATH are required.');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
try {
  const files = await pool.query<{ id: string; size: string; status: string; chunk_size: number; chunk_count: number }>(
    "SELECT id,size,status,chunk_size,chunk_count FROM drive_files WHERE status<>'deleting' ORDER BY id",
  );
  let checkedParts = 0;
  for (const file of files.rows) {
    if (!/^[0-9a-f-]{36}$/.test(file.id)) throw new Error('Invalid stored file identifier.');
    const filename = path.join(process.env.DRIVE_STORAGE_PATH, 'objects', `${file.id}.bin`);
    const info = await lstat(filename);
    if (!info.isFile() || info.isSymbolicLink() || info.size !== Number(file.size)) throw new Error(`Stored file size/type differs: ${file.id}`);
    const parts = await pool.query<{ part_index: number; bytes: number; sha256: string }>(
      'SELECT part_index,bytes,sha256 FROM drive_parts WHERE file_id=$1 ORDER BY part_index', [file.id],
    );
    if (file.status !== 'uploading' && parts.rowCount !== file.chunk_count) throw new Error(`Completed file part count differs: ${file.id}`);
    for (const part of parts.rows) {
      const start = part.part_index * file.chunk_size;
      const expected = Math.min(file.chunk_size, Number(file.size) - start);
      if (part.part_index < 0 || part.part_index >= file.chunk_count || expected !== part.bytes) throw new Error(`Part reference differs: ${file.id}`);
      const hash = createHash('sha256');
      for await (const bytes of createReadStream(filename, { start, end: start + part.bytes - 1 })) hash.update(bytes);
      if (hash.digest('hex') !== part.sha256) throw new Error(`Stored part hash differs: ${file.id}`);
      checkedParts++;
    }
  }
  console.log(`Verified ${files.rowCount} restored files and ${checkedParts} SHA-256 parts.`);
} finally {
  await pool.end();
}
