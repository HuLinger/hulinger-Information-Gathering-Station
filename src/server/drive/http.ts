import { assertSameOrigin, requireUser } from '../authorize';
import { failure, privateHeaders } from '../http';
import { DriveError } from './errors';

export async function driveRequest(request: Request, handle: (ownerId: string) => Promise<Response>): Promise<Response> {
  try {
    const owner = await requireUser(request.headers);
    assertSameOrigin(request);
    return await handle(owner.id);
  } catch (error) {
    const response = failure(error);
    if (response.status === 429) response.headers.set('Retry-After', '2');
    return response;
  }
}
export function driveJson(body: unknown, status = 200) { return Response.json(body, { status, headers: privateHeaders }); }
export async function driveInput(request: Request): Promise<unknown> {
  if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') throw new DriveError(415, 'JSON_REQUIRED', '此操作需要 JSON 请求。');
  const reader = request.body?.getReader();
  if (!reader) throw new DriveError(400, 'INVALID_INPUT', '缺少请求内容。');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 16 * 1024) throw new DriveError(413, 'INPUT_TOO_LARGE', '文件操作信息过长。');
      chunks.push(value);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new DriveError(400, 'INVALID_INPUT', 'JSON 格式无效。'); }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
