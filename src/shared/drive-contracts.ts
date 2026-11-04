export type DriveStatus = 'uploading' | 'ready' | 'trash' | 'deleting';
export interface DriveFile {
  id: string;
  name: string;
  size: number;
  status: DriveStatus;
  chunkSize: number;
  chunkCount: number;
  uploadedBytes: number;
  lastModified: number;
  fingerprint: string;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  deletedAt: string | null;
  etag: string;
}
export interface DrivePart { index: number; sha256: string }
export interface DriveUpload { file: DriveFile; parts: DrivePart[] }
export interface DriveListing {
  files: DriveFile[];
  uploads: DriveFile[];
  total: number;
  page: number;
  capacity: { usedBytes: number; reservedBytes: number; freeBytes: number; availableBytes: number; quotaBytes: number | null };
  config: { chunkSize: number; maxFileBytes: number; defaultParallel: number; maxParallel: number; uploadRetentionDays: number; trashRetentionDays: number };
}

// GET /api/drive?view=files|trash&q=&page=1 -> DriveListing (20 files/page, up to 50 pending uploads).
// POST /api/drive/uploads {name,size,lastModified,fingerprint} -> DriveUpload; reuse a matching pending upload.
// fingerprint: SHA-256 of first/last 64 KiB plus size and lastModified (resume hint only).
// GET /api/drive/files/:id -> DriveUpload, including all completed part hashes for safe resume/download checks.
// PUT /api/drive/uploads/:id/parts/:index raw Blob with X-Chunk-SHA256 -> {ok:true,index,uploadedBytes}.
// POST /api/drive/uploads/:id/complete {} -> {file:DriveFile}; idempotent when already ready.
// POST /api/drive/files/:id {action:'rename',name} | {action:'trash'|'restore'}
//   | {action:'purge'|'cancel',confirm:true} -> {ok:true,file?:DriveFile}.
// GET/HEAD /api/drive/files/:id/content -> authenticated attachment; Accept-Ranges, ETag, If-Range.
// Only metadata goes through requestJson; file bytes use bounded Blob/stream APIs.
