import { randomUUID } from 'node:crypto';
import { openAsBlob } from 'node:fs';
import { open, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import type { ConversionOption, ConversionEngine } from '../../../shared/conversion-contracts';
import { ConversionProviderError, type ProviderContext, type ProviderInput, type ProviderOutput } from '../provider-types';

// These are file formats, deliberately excluding URL/protocol pseudo-formats.
const FILE_FORMATS = new Set('png jpg jpeg webp gif bmp tiff tif ico heic heif avif mp3 wav flac ogg opus aac m4a aiff wma mp4 mov webm mkv avi mpeg mpg pdf doc docx xls xlsx ppt pptx odt ods odp rtf txt csv md epub mobi azw3 fb2 zip 7z tar gz bz2 xz ttf otf woff woff2 ncm'.split(' '));
const MIME: Record<string, string> = {
  pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp', tiff: 'image/tiff', tif: 'image/tiff',
  mp3: 'audio/mpeg', flac: 'audio/flac', wav: 'audio/wav', ogg: 'audio/ogg', opus: 'audio/ogg', mp4: 'video/mp4', webm: 'video/webm',
  txt: 'text/plain', csv: 'text/csv', md: 'text/markdown', rtf: 'application/rtf', zip: 'application/zip',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text', ods: 'application/vnd.oasis.opendocument.spreadsheet', odp: 'application/vnd.oasis.opendocument.presentation', epub: 'application/epub+zip',
};

export function fileFormat(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.toLowerCase().replace(/^\./, '');
  return FILE_FORMATS.has(normalized) ? normalized : null;
}

export function requireFormat(value: string): string {
  const format = fileFormat(value);
  if (!format) throw new ConversionProviderError('暂不支持此文件格式，请选择其他格式或引擎。', 'UNSUPPORTED_FORMAT');
  return format;
}

export function optionsFor(engine: ConversionEngine, formats: Iterable<string>): ConversionOption[] {
  return [...new Set([...formats].map(formatKey))].sort().map((format) => ({ engine, format, label: format.toUpperCase() }));
}

export function formatKey(format: string): string {
  return format === 'jpg' ? 'jpeg' : format === 'tif' ? 'tiff' : format;
}

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidResponse();
  return value as Record<string, unknown>;
}

export function upstreamId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(value)) throw invalidResponse();
  return value;
}

export function invalidResponse(): ConversionProviderError {
  return new ConversionProviderError('转换服务返回了无法识别的结果，请更换引擎或联系管理员。', 'INVALID_ENGINE_RESPONSE');
}

export function unsupported(): never {
  throw new ConversionProviderError('此引擎不支持该转换，请选择其他格式或引擎。', 'UNSUPPORTED_FORMAT');
}

export async function safeCall<T>(signal: AbortSignal, action: () => Promise<T>): Promise<T> {
  try {
    signal.throwIfAborted();
    return await action();
  } catch (error) {
    if (signal.aborted) throw new ConversionProviderError('等待转换已中断或超时，请稍后重试。', 'CONVERSION_ABORTED');
    if (error instanceof ConversionProviderError) throw error;
    throw new ConversionProviderError('转换服务请求失败，请稍后重试或更换引擎。', 'ENGINE_UNAVAILABLE');
  }
}

export class EngineClient {
  private readonly base: URL | null;
  readonly configured: boolean;

  constructor(value: string | undefined, private readonly headers: Record<string, string> = {}) {
    this.base = null;
    if (value) {
      try {
        const url = new URL(value);
        if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash) {
          url.pathname = `${url.pathname.replace(/\/$/, '')}/`;
          this.base = url;
        }
      } catch { /* Invalid server configuration is reported without exposing its value. */ }
    }
    this.configured = this.base !== null;
  }

  url(endpoint: string): URL {
    if (!this.base) throw new ConversionProviderError('此转换引擎尚未配置，请联系管理员。', 'ENGINE_UNCONFIGURED');
    if (!/^\/(?!\/)/.test(endpoint) || endpoint.includes('\\')) throw invalidResponse();
    const url = new URL(endpoint.slice(1), this.base);
    if (url.origin !== this.base.origin || !url.pathname.startsWith(this.base.pathname)) throw invalidResponse();
    return url;
  }

  async request(endpoint: string, signal: AbortSignal, init: RequestInit = {}, accepted: number[] = []): Promise<Response> {
    const headers = new Headers(this.headers);
    new Headers(init.headers).forEach((value, name) => headers.set(name, value));
    const response = await fetch(this.url(endpoint), { ...init, headers, signal, redirect: 'manual' });
    if (!response.ok && !accepted.includes(response.status)) {
      await discard(response);
      if (response.status === 413) throw new ConversionProviderError('转换服务拒绝了文件大小，请缩小文件后重试。', 'ENGINE_SIZE_LIMIT');
      if (response.status === 429) throw new ConversionProviderError('转换服务繁忙，请稍后重试。', 'ENGINE_BUSY');
      if ([400, 415, 422].includes(response.status)) throw new ConversionProviderError('转换服务无法处理此文件，请检查文件内容或更换引擎。', 'INVALID_INPUT');
      if ([401, 403].includes(response.status)) throw new ConversionProviderError('转换服务认证失败，请联系管理员检查配置。', 'ENGINE_AUTH_FAILED');
      throw new ConversionProviderError('转换服务暂不可用，请稍后重试或更换引擎。', 'ENGINE_UNAVAILABLE');
    }
    return response;
  }
}

export async function discard(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => {});
}

export async function readText(response: Response): Promise<string> {
  const limit = 1024 * 1024;
  if (Number(response.headers.get('content-length')) > limit) {
    await discard(response);
    throw invalidResponse();
  }
  if (!response.body) throw invalidResponse();
  const reader = response.body.getReader();
  let bytes = 0;
  const buffers: Uint8Array[] = [];
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > limit) throw invalidResponse();
      buffers.push(next.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return Buffer.concat(buffers).toString('utf8');
}

export async function readJson(response: Response): Promise<Record<string, unknown>> {
  const text = await readText(response);
  try { return record(JSON.parse(text)); } catch { throw invalidResponse(); }
}

export function jsonBody(value: unknown): RequestInit {
  return { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) };
}

export async function uploadBody(input: ProviderInput, field = 'file'): Promise<FormData> {
  const extension = requireFormat(input.extension);
  const info = await stat(input.path);
  if (!info.isFile() || info.size !== input.bytes) throw new ConversionProviderError('上传文件已改变或丢失，请重新上传。', 'INPUT_UNAVAILABLE');
  const form = new FormData();
  form.append(field, await openAsBlob(input.path, { type: MIME[extension] ?? 'application/octet-stream' }), `input.${extension}`);
  return form;
}

export function resultName(input: ProviderInput, extension: string, suffix = ''): string {
  const base = input.name.replace(/\.[^.]*$/, '').replace(/[<>:"/\\|?*\p{Cc}\p{Cf}]/gu, '_').replace(/[ .]+$/, '').slice(0, 150) || '转换结果';
  return `${base}${suffix}.${extension}`;
}

export function responseExtension(response: Response, fallback: string, allowed: string[]): string {
  const disposition = response.headers.get('content-disposition') ?? '';
  const encoded = /filename\*=UTF-8''([^;\s]+)/i.exec(disposition)?.[1];
  let name = /filename="([^"]+)"/i.exec(disposition)?.[1] ?? /filename=([^;\s]+)/i.exec(disposition)?.[1] ?? '';
  if (encoded) { try { name = decodeURIComponent(encoded); } catch { throw invalidResponse(); } }
  const extension = name.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase();
  const mime = response.headers.get('content-type')?.split(';')[0].toLowerCase();
  const candidate = mime === 'application/zip' ? 'zip' : extension ?? fallback;
  if (!allowed.includes(candidate)) throw invalidResponse();
  return candidate;
}

export async function pollDelay(signal: AbortSignal): Promise<void> {
  await delay(1000, undefined, { signal });
}

export class ResultWriter {
  private readonly outputs: ProviderOutput[] = [];
  private total = 0;

  constructor(private readonly directory: string, private readonly context: ProviderContext) {}

  async write(response: Response, name: string, extension: string): Promise<ProviderOutput> {
    const remaining = this.context.maxOutputBytes - this.total;
    if (this.outputs.length >= this.context.maxOutputFiles || remaining <= 0 || Number(response.headers.get('content-length')) > remaining) {
      await discard(response);
      throw new ConversionProviderError('转换结果超过文件数量或容量限制，请缩小文件后重试。', 'OUTPUT_LIMIT');
    }
    const contentType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
    if (response.status !== 200 || !response.body || ['application/json', 'text/html', 'application/xhtml+xml', 'application/xml', 'text/xml'].includes(contentType ?? '') || contentType?.endsWith('+json') || contentType?.startsWith('text/') && !['txt', 'csv', 'md', 'rtf'].includes(extension)) {
      await discard(response);
      throw invalidResponse();
    }
    const storageName = randomUUID();
    const destination = path.join(this.directory, storageName);
    let bytes = 0;
    let prefix = Buffer.alloc(0);
    const beforeWrite = this.context.beforeWrite;
    const limit = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.byteLength;
        if (bytes > remaining) {
          callback(new ConversionProviderError('转换结果超过容量限制，请缩小文件后重试。', 'OUTPUT_LIMIT'));
          return;
        }
        void Promise.resolve().then(() => beforeWrite?.(chunk.byteLength)).then(() => {
          if (prefix.length < 16) prefix = Buffer.concat([prefix, chunk.subarray(0, 16 - prefix.length)]);
          callback(null, chunk);
        }, (error: unknown) => {
          callback(error instanceof Error && 'code' in error && error.code === 'STORAGE_FULL'
            ? new ConversionProviderError('转换临时空间不足，请清理旧任务或稍后重试。', 'STORAGE_FULL')
            : error instanceof Error ? error : new Error('Output capacity check failed'));
        });
      },
    });
    let created = false;
    try {
      const handle = await open(destination, 'wx', 0o600);
      created = true;
      try {
        await pipeline(Readable.fromWeb(response.body as import('node:stream/web').ReadableStream<Uint8Array>), limit, handle.createWriteStream(), { signal: this.context.signal });
      } finally { await handle.close(); }
      if (!bytes || !validSignature(prefix, extension)) throw invalidResponse();
    } catch (error) {
      await discard(response);
      if (created) await rm(destination, { force: true });
      throw error;
    }
    const output = { storageName, name, mime: MIME[extension] ?? 'application/octet-stream', bytes };
    this.total += bytes;
    this.outputs.push(output);
    return output;
  }

  async removeAll(): Promise<void> {
    await Promise.all(this.outputs.map((output) => rm(path.join(this.directory, output.storageName), { force: true })));
  }
}

function validSignature(bytes: Buffer, extension: string): boolean {
  if (extension === 'pdf') return bytes.subarray(0, 5).toString() === '%PDF-';
  if (extension === 'png') return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (extension === 'jpg' || extension === 'jpeg') return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (['zip', 'docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp', 'epub'].includes(extension)) return bytes[0] === 80 && bytes[1] === 75 && (bytes[2] === 3 && bytes[3] === 4 || bytes[2] === 5 && bytes[3] === 6 || bytes[2] === 7 && bytes[3] === 8);
  if (extension === 'flac') return bytes.subarray(0, 4).toString() === 'fLaC';
  if (extension === 'mp3') return bytes.subarray(0, 3).toString() === 'ID3' || bytes[0] === 255 && (bytes[1] & 224) === 224;
  return true;
}
