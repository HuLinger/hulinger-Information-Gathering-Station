import { DriveError } from './errors';

export function safeFilename(value: unknown): string {
  if (typeof value !== 'string') throw new DriveError(400, 'INVALID_NAME', '请输入有效文件名。');
  const name = value.trim().normalize('NFC');
  if (!name || name === '.' || name === '..' || /[/\\\x00-\x1f\x7f]/.test(name) || Buffer.byteLength(name, 'utf8') > 255) {
    throw new DriveError(400, 'INVALID_NAME', '文件名不能为空、包含路径或控制字符，且不得超过 255 字节。');
  }
  return name;
}

export function validId(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)) throw new DriveError(404, 'NOT_FOUND', '文件不存在或无权访问。');
  return value;
}

export function parseByteRange(header: string | null, size: number): { start: number; end: number } | null {
  if (header === null) return null;
  const invalid = () => { throw new DriveError(416, 'INVALID_RANGE', '请求的文件范围不可用。'); };
  if (header.length > 100 || !Number.isSafeInteger(size) || size < 0) return invalid();
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2]) || size === 0) return invalid();
  const total = BigInt(size);
  if (!match[1]) {
    const suffix = BigInt(match[2]);
    if (suffix <= 0n) return invalid();
    return { start: Number(suffix >= total ? 0n : total - suffix), end: size - 1 };
  }
  const start = BigInt(match[1]);
  const end = match[2] ? BigInt(match[2]) : total - 1n;
  if (start >= total || end < start) return invalid();
  return { start: Number(start), end: Number(end >= total ? total - 1n : end) };
}

export function disposition(name: string): string {
  const encoded = encodeURIComponent(name).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="download"; filename*=UTF-8''${encoded}`;
}
