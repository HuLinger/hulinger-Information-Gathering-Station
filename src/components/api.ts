import type { HubData } from '../shared/contracts';

export class ApiError extends Error {
  constructor(message: string, public status: number, public code?: string) {
    super(message);
    this.name = 'ApiError';
  }
}

export async function requestHubData(url: string, options: RequestInit = {}): Promise<HubData> {
  const data = await requestJson<unknown>(url, options);
  if (!isHubData(data)) throw new ApiError('资料响应不完整，请刷新后重试。原有内容未被替换。', 502, 'INVALID_RESPONSE');
  return data;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isInteger(value: unknown, minimum = 0) { return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum; }
function textFields(value: Record<string, unknown>, fields: string[]) { return fields.every((field) => typeof value[field] === 'string'); }
function nullableTextFields(value: Record<string, unknown>, fields: string[]) { return fields.every((field) => value[field] === null || typeof value[field] === 'string'); }
function isEvent(value: unknown) {
  if (!isRecord(value) || !isRecord(value.personal)) return false;
  const personal = value.personal;
  return textFields(value, ['id', 'title', 'summary', 'kind', 'url', 'published_precision', 'discovered_at', 'updated_at', 'source_name', 'status'])
    && ['model', 'project', 'tool'].includes(value.kind as string)
    && ['active', 'review', 'excluded', 'trash', 'merged'].includes(value.status as string)
    && nullableTextFields(value, ['published_at', 'entity_id', 'review_reason', 'deleted_at'])
    && isInteger(value.revision, 1) && typeof value.manual === 'boolean'
    && ['favorite', 'later', 'read', 'archived'].every((field) => typeof personal[field] === 'boolean')
    && typeof personal.note === 'string' && isRecord(value.overrides) && isRecord(value.originals)
    && Array.isArray(value.tags) && value.tags.every((tag) => typeof tag === 'string');
}
function isEntity(value: unknown) {
  return isRecord(value) && textFields(value, ['id', 'name', 'kind', 'url'])
    && ['model', 'project', 'tool'].includes(value.kind as string)
    && isRecord(value.data) && typeof value.followed === 'boolean' && isInteger(value.revision, 1);
}
function isSource(value: unknown) {
  return isRecord(value) && textFields(value, ['id', 'name', 'kind', 'url'])
    && typeof value.enabled === 'boolean' && isInteger(value.interval_minutes, 1) && isRecord(value.config)
    && nullableTextFields(value, ['last_attempt', 'last_success', 'next_run', 'error', 'coverage']);
}
function isRun(value: unknown) {
  return isRecord(value) && textFields(value, ['id', 'source_id', 'status', 'started_at'])
    && nullableTextFields(value, ['finished_at', 'error', 'coverage'])
    && isInteger(value.added) && isInteger(value.updated) && isInteger(value.skipped);
}
function isHubData(value: unknown): value is HubData {
  return isRecord(value) && isInteger(value.total) && isInteger(value.page, 1)
    && Array.isArray(value.events) && value.events.every(isEvent)
    && Array.isArray(value.entities) && value.entities.every(isEntity)
    && Array.isArray(value.sources) && value.sources.every(isSource)
    && Array.isArray(value.runs) && value.runs.every(isRun)
    && Array.isArray(value.later) && value.later.every(isEvent);
}

export async function requestJson<T>(url: string, options: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...options,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json', ...options.headers },
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiError('暂时无法连接，请检查网络后重试。你的输入仍在当前页面。', 0);
  }
  let data: unknown;
  try { data = await response.json(); }
  catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiError('服务器返回的内容无法读取，请刷新后重试。', response.ok ? 502 : response.status, 'INVALID_RESPONSE');
  }
  if (!isRecord(data)) throw new ApiError('服务器返回的数据格式不正确，请刷新后重试。', response.ok ? 502 : response.status, 'INVALID_RESPONSE');
  if (!response.ok) {
    const fallback = response.status === 409
      ? '内容已在另一处更新。请查看最新版本后再保存，你的输入尚未提交。'
      : response.status === 401
        ? '登录已失效，请重新登录。'
        : response.status === 429
          ? '操作较频繁，请稍后重试。'
          : '操作未完成，请稍后重试。';
    throw new ApiError(typeof data.error === 'string' ? data.error : fallback, response.status, typeof data.code === 'string' ? data.code : undefined);
  }
  return data as T;
}

export function postJson<T = Record<string, unknown>>(url: string, body: unknown) {
  return requestJson<T>(url, { method: 'POST', body: JSON.stringify(body) });
}

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : '操作未完成，请稍后重试。';
}

export interface AuthStatus {
  state: 'unconfigured' | 'signed-out' | 'setup-mfa' | 'ready';
  user?: { id: string; email: string; name: string };
}

export type HubAction = (body: Record<string, unknown>, success?: string) => Promise<Record<string, unknown>>;
