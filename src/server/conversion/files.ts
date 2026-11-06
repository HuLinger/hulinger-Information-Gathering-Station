import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rm, statfs, type FileHandle } from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import { DomainError } from '../domain';
import { conversionConfig } from './config';

export function conversionId(id: string): string {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(id)) {
    throw new DomainError('文件或任务不存在。', 404, 'NOT_FOUND');
  }
  return id;
}
export function conversionName(name: string): string {
  const safe = name.normalize('NFC').replace(/[\u0000-\u001f\u007f/\\]/g, '_').trim();
  return safe.slice(0, 200) || '转换文件';
}
export function fileExtension(name: string): string {
  return /\.([a-z0-9]{1,20})$/i.exec(name)?.[1].toLowerCase() ?? '';
}
export async function conversionStorage(): Promise<string> {
  const configured = conversionConfig().root;
  await mkdir(configured, { recursive: true, mode: 0o700 });
  const info = await lstat(/* turbopackIgnore: true */ configured);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('Conversion storage must be a real directory');
  const root = await realpath(/* turbopackIgnore: true */ configured);
  for (const publicPath of [resolve(/* turbopackIgnore: true */ 'public'), resolve(/* turbopackIgnore: true */ '.next/static')]) {
    const publicRoot = await realpath(/* turbopackIgnore: true */ publicPath).catch(() => publicPath);
    const child = relative(publicRoot, root);
    if (!child || (!isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`))) throw new Error('Conversion storage must not be publicly served');
  }
  for (const name of ['inputs', 'jobs']) {
    await mkdir(resolve(/* turbopackIgnore: true */ root, name), { recursive: true, mode: 0o700 });
    const child = await lstat(/* turbopackIgnore: true */ resolve(/* turbopackIgnore: true */ root, name));
    if (child.isSymbolicLink() || !child.isDirectory()) throw new Error('Unsafe conversion storage directory');
  }
  return root;
}
export function inside(directory: string, name: string): string {
  if (basename(name) !== name || name === '.' || name === '..' || /[\\/\0]/.test(name)) throw new Error('Unsafe storage name');
  const target = resolve(/* turbopackIgnore: true */ directory, name);
  if (!target.startsWith(resolve(/* turbopackIgnore: true */ directory) + sep)) throw new Error('Unsafe conversion storage path');
  return target;
}
export async function inputPath(id: string): Promise<string> {
  return inside(resolve(/* turbopackIgnore: true */ await conversionStorage(), 'inputs'), `${conversionId(id)}.input`);
}
export async function jobDirectory(id: string, create = false): Promise<string> {
  const target = inside(resolve(/* turbopackIgnore: true */ await conversionStorage(), 'jobs'), conversionId(id));
  if (create) await mkdir(target, { mode: 0o700 });
  const info = await lstat(/* turbopackIgnore: true */ target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT' && !create) return null;
    throw error;
  });
  if (info && (info.isSymbolicLink() || !info.isDirectory())) throw new Error('Unsafe conversion job directory');
  return target;
}
export async function diskCapacity(): Promise<number> {
  const stats = await statfs(/* turbopackIgnore: true */ await conversionStorage(), { bigint: true });
  const free = stats.bavail * stats.bsize - BigInt(conversionConfig().reserveBytes);
  return Number(free > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : free);
}
export async function requireDisk(bytes: number): Promise<void> {
  if (await diskCapacity() < bytes) throw new DomainError('转换临时空间不足，请清理旧任务或稍后重试。', 507, 'STORAGE_FULL');
}
export async function openPrivateFile(path: string, expectedBytes?: number): Promise<FileHandle> {
  const prior = await lstat(/* turbopackIgnore: true */ path, { bigint: true }).catch(() => null);
  if (!prior || !prior.isFile() || prior.isSymbolicLink() || prior.nlink !== 1n) throw new DomainError('文件已到期或已被清理，请重新上传。', 410, 'FILE_EXPIRED');
  const handle = await open(/* turbopackIgnore: true */ path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat({ bigint: true });
    // Windows path-based lstat reports dev=0 while fstat reports the volume ID.
    // Preserve the full 64-bit file ID and enforce device identity where supplied.
    const differentDevice = info.dev !== prior.dev && !(process.platform === 'win32' && prior.dev === 0n);
    if (!info.isFile() || info.nlink !== 1n || info.ino !== prior.ino || differentDevice || (expectedBytes !== undefined && info.size !== BigInt(expectedBytes))) {
      throw new DomainError('文件不完整，请重新上传后重试。', 409, 'FILE_CHANGED');
    }
    return handle;
  } catch (error) { await handle.close(); throw error; }
}
export async function removeInput(id: string): Promise<void> {
  await rm(await inputPath(id), { force: true });
}
export async function removeJobFiles(id: string): Promise<void> {
  // jobDirectory rejects symlinks and only permits a UUID directly below the
  // configured jobs directory; deletion cannot traverse a user-provided path.
  await rm(await jobDirectory(id), { force: true, recursive: true });
}
