import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import type { IncomingMessage } from 'node:http';
import ipaddr from 'ipaddr.js';

const FEEDS = new Set([
  'https://openai.com/news/rss.xml',
  'https://platform.claude.com/docs/en/release-notes/feed.xml',
  'https://blogs.microsoft.com/blog/tag/ai/feed/',
]);
const GITHUB_PATH = /^\/repos\/[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+(?:\/releases)?$/u;
export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export class CollectorError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(message: string, public readonly retryAt?: Date) {
    super(message); this.name = 'CollectorError';
    this.status = retryAt ? 429 : 400;
    this.code = retryAt ? 'COLLECTOR_RATE_LIMIT' : 'COLLECTOR_ERROR';
  }
}

export function validateTarget(input: string): URL {
  let url: URL;
  try { url = new URL(input); } catch { throw new CollectorError('来源地址无效'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) {
    throw new CollectorError('来源必须使用无凭据、无自定义端口的 HTTPS 地址');
  }
  if (FEEDS.has(url.href)) return url;
  if (url.hostname !== 'api.github.com' || (url.pathname !== '/search/repositories' && !GITHUB_PATH.test(url.pathname))) {
    throw new CollectorError('来源不在已验证的采集白名单中');
  }
  if ([...url.searchParams.keys()].some((key) => !['q', 'sort', 'order', 'per_page', 'page'].includes(key))) {
    throw new CollectorError('来源请求包含不允许的参数');
  }
  return url;
}

export function isPublicAddress(value: string): boolean {
  try { return ipaddr.process(value).range() === 'unicast'; } catch { return false; }
}

export async function resolvePublicAddress(hostname: string, resolver = lookup): Promise<{ address: string; family: number }> {
  const addresses = await resolver(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) {
    throw new CollectorError('来源 DNS 返回非公网地址，已阻止连接');
  }
  // Pin a validated address in the actual connection; there is no second DNS lookup.
  return addresses.find(({ family }) => family === 4) ?? addresses[0];
}

export function retryTime(headers: Record<string, string | string[] | undefined>, now = Date.now()): Date {
  const retryAfter = String(headers['retry-after'] ?? '');
  const reset = Number(headers['x-ratelimit-reset']);
  const delay = /^\d+$/u.test(retryAfter) ? now + Number(retryAfter) * 1000 : Date.parse(retryAfter);
  const target = Number.isFinite(delay) ? delay : Number.isFinite(reset) && reset > 0 ? reset * 1000 : now + 15 * 60_000;
  return new Date(Math.max(now + 60_000, target));
}

type SourceResponse = { body: string; etag: string | null; notModified: boolean; headers: Record<string, string | string[] | undefined> };

export function consumeResponse(response: IncomingMessage): Promise<SourceResponse> {
  return new Promise((resolve, reject) => {
    const status = response.statusCode ?? 0;
    const rejectResponse = (error: CollectorError) => { response.destroy(); reject(error); };
    const resultHeaders = response.headers;
    if (status === 304) { response.resume(); resolve({ body: '', etag: response.headers.etag ?? null, notModified: true, headers: resultHeaders }); return; }
    if (status === 429 || (status === 403 && (response.headers['x-ratelimit-remaining'] === '0' || response.headers['retry-after']))) {
      rejectResponse(new CollectorError('来源达到请求配额，已延后重试', retryTime(resultHeaders))); return;
    }
    if (status >= 300 && status < 400) { rejectResponse(new CollectorError('来源发生重定向，需重新核验固定入口')); return; }
    if (status !== 200) { rejectResponse(new CollectorError(`来源请求失败（HTTP ${status}）`)); return; }
    if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') {
      rejectResponse(new CollectorError('来源返回不支持的压缩格式')); return;
    }
    if (Number(response.headers['content-length'] ?? 0) > MAX_RESPONSE_BYTES) {
      rejectResponse(new CollectorError('来源响应超过大小限制')); return;
    }
    let length = 0;
    const chunks: Buffer[] = [];
    response.on('data', (chunk: Buffer) => {
      length += chunk.length;
      if (length > MAX_RESPONSE_BYTES) { rejectResponse(new CollectorError('来源响应超过大小限制')); return; }
      chunks.push(chunk);
    });
    response.on('end', () => resolve({ body: Buffer.concat(chunks).toString('utf8'), etag: response.headers.etag ?? null, notModified: false, headers: resultHeaders }));
    response.on('error', () => reject(new CollectorError('来源响应中断')));
  });
}

export async function safeFetch(input: string, options: { etag?: string; timeoutMs?: number } = {}): Promise<SourceResponse> {
  const url = validateTarget(input);
  const timeoutMs = options.timeoutMs ?? 20_000;
  const started = Date.now();
  let dnsTimer: ReturnType<typeof setTimeout> | undefined;
  const address = await Promise.race([
    resolvePublicAddress(url.hostname),
    new Promise<never>((_, reject) => { dnsTimer = setTimeout(() => reject(new CollectorError('来源 DNS 解析超时')), timeoutMs); }),
  ]).finally(() => clearTimeout(dnsTimer));

  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      'User-Agent': 'Hulinger-AI-Hub/1.0 (+private personal reader)',
      Accept: url.hostname === 'api.github.com' ? 'application/vnd.github+json' : 'application/rss+xml, application/atom+xml, text/xml',
      'Accept-Encoding': 'identity',
    };
    if (options.etag && !/[\r\n]/u.test(options.etag)) headers['If-None-Match'] = options.etag;
    if (url.hostname === 'api.github.com') {
      headers['X-GitHub-Api-Version'] = '2022-11-28';
      if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    }
    const req = request(url, {
      method: 'GET', headers, agent: false, family: address.family,
      lookup: (_hostname, _lookupOptions, callback) => callback(null, address.address, address.family),
    }, (response) => {
      void consumeResponse(response).then(resolve, reject);
    });
    const timer = setTimeout(() => req.destroy(new CollectorError('来源请求超时')), Math.max(1, timeoutMs - (Date.now() - started)));
    req.on('close', () => clearTimeout(timer));
    req.on('error', (error) => reject(error instanceof CollectorError ? error : new CollectorError('无法安全连接来源，请稍后重试')));
    req.end();
  });
}
