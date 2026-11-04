export interface DriveConfig {
  chunkSize: number;
  maxFileBytes: number;
  quotaBytes: number | null;
  reserveBytes: number;
  maxParallel: number;
  defaultParallel: number;
  uploadRetentionDays: number;
  trashRetentionDays: number;
  maxPendingUploads: number;
}

export function readDriveConfig(env: NodeJS.ProcessEnv = process.env): DriveConfig {
  const number = (key: string, fallback: number, min: number, max: number) => {
    const raw = env[key];
    if (raw === undefined || raw === '') return fallback;
    const value = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid ${key} configuration.`);
    return value;
  };
  const chunkSize = number('DRIVE_CHUNK_BYTES', 16 * 1024 ** 2, 1024 ** 2, 32 * 1024 ** 2);
  const maxParallel = number('DRIVE_MAX_PARALLEL', 8, 1, 8);
  return {
    chunkSize,
    maxFileBytes: number('DRIVE_MAX_FILE_BYTES', Math.min(1024 ** 4, chunkSize * 100000), 1, chunkSize * 100000),
    quotaBytes: number('DRIVE_QUOTA_BYTES', 0, 0, Number.MAX_SAFE_INTEGER) || null,
    reserveBytes: number('DRIVE_RESERVE_BYTES', 1024 ** 3, 0, Number.MAX_SAFE_INTEGER),
    maxParallel, defaultParallel: Math.min(4, maxParallel),
    uploadRetentionDays: 7, trashRetentionDays: 30, maxPendingUploads: 50,
  };
}
