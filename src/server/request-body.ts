import { AuthError } from './authorize';

export async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') {
    throw new AuthError(415, 'JSON_REQUIRED', '请使用 JSON 请求。');
  }
  const reader = request.body?.getReader();
  if (!reader) throw new AuthError(400, 'INVALID_BODY', '请求不能为空。');
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 16_384) {
      await reader.cancel();
      throw new AuthError(413, 'BODY_TOO_LARGE', '请求过大。');
    }
    chunks.push(value);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('object required');
    return value;
  } catch {
    throw new AuthError(400, 'INVALID_BODY', '请求格式不正确。');
  }
}
