export class ApiError extends Error {
  constructor(message: string, public status: number, public code?: string) {
    super(message);
    this.name = 'ApiError';
  }
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
  const data = await response.json().catch(() => ({})) as Record<string, unknown>;
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
