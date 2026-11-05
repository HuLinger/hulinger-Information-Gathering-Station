export class DriveError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
    this.name = 'DriveError';
  }
}

export function storageError(error: unknown): never {
  if (error instanceof DriveError) throw error;
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  if (code === 'ENOSPC' || code === 'EDQUOT') throw new DriveError(507, 'STORAGE_FULL', '存储空间不足，请释放空间后继续上传。已完成的分片会保留。');
  if (code === 'ELOOP') throw new DriveError(503, 'UNSAFE_STORAGE', '存储目录或文件类型不安全，请由管理员检查存储挂载。');
  if (code === 'ENOENT' || code === 'EACCES' || code === 'EROFS') throw new DriveError(503, 'STORAGE_UNAVAILABLE', '云盘存储暂时不可用，请检查文件卷及访问权限。');
  throw error;
}
