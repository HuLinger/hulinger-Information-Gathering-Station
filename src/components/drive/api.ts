import type { DriveFile, DriveListing, DriveUpload } from '../../shared/drive-contracts';
import { ApiError, requestJson } from '../api';

function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function integer(value: unknown, minimum = 0) { return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum; }
function invalid(): never { throw new ApiError('云盘响应不完整，请刷新后重试。', 502, 'INVALID_RESPONSE'); }
export function parseDriveFile(value: unknown): DriveFile {
  if (!record(value) || !['id', 'name', 'fingerprint', 'etag', 'createdAt', 'updatedAt'].every((key) => typeof value[key] === 'string')
    || !['uploading', 'ready', 'trash', 'deleting'].includes(String(value.status))
    || !['size', 'uploadedBytes', 'chunkCount', 'lastModified'].every((key) => integer(value[key]))
    || !integer(value.chunkSize, 1) || Number(value.chunkSize) > 64 * 1024 * 1024
    || Number(value.chunkCount) !== Math.ceil(Number(value.size) / Number(value.chunkSize)) || Number(value.uploadedBytes) > Number(value.size)
    || !['completedAt', 'deletedAt'].every((key) => value[key] === null || typeof value[key] === 'string')) invalid();
  return value as unknown as DriveFile;
}
export function parseDriveUpload(value: unknown): DriveUpload {
  if (!record(value) || !Array.isArray(value.parts)) invalid();
  const file = parseDriveFile(value.file);
  const indices = new Set<number>();
  for (const part of value.parts) {
    if (!record(part) || !integer(part.index) || Number(part.index) >= file.chunkCount || indices.has(Number(part.index)) || typeof part.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(part.sha256)) invalid();
    indices.add(Number(part.index));
  }
  return { file, parts: value.parts as DriveUpload['parts'] };
}
export function parseDriveListing(value: unknown): DriveListing {
  if (!record(value) || !Array.isArray(value.files) || !Array.isArray(value.uploads) || !integer(value.total) || !integer(value.page, 1) || !record(value.capacity) || !record(value.config)) invalid();
  const { capacity, config } = value;
  if (!['usedBytes', 'reservedBytes', 'freeBytes', 'availableBytes'].every((key) => integer(capacity[key])) || !(capacity.quotaBytes === null || integer(capacity.quotaBytes))
    || !['chunkSize', 'maxFileBytes', 'defaultParallel', 'maxParallel', 'uploadRetentionDays', 'trashRetentionDays'].every((key) => integer(config[key], 1))
    || Number(config.maxParallel) > 8 || Number(config.defaultParallel) > Number(config.maxParallel) || Number(config.chunkSize) > 64 * 1024 * 1024) invalid();
  const files = value.files.map(parseDriveFile);
  const uploads = value.uploads.map(parseDriveFile);
  if (files.length > 20 || uploads.length > 50 || uploads.some((file) => file.status !== 'uploading')) invalid();
  return { ...value, files, uploads } as unknown as DriveListing;
}
export async function getDriveListing(params: URLSearchParams, signal: AbortSignal) { return parseDriveListing(await requestJson(`/api/drive?${params}`, { signal })); }
export async function getDriveUpload(id: string, signal?: AbortSignal) { return parseDriveUpload(await requestJson(`/api/drive/files/${encodeURIComponent(id)}`, { signal })); }
export async function createDriveUpload(body: { name: string; size: number; lastModified: number; fingerprint: string }) {
  return parseDriveUpload(await requestJson('/api/drive/uploads', { method: 'POST', body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) }));
}
