import { getAuth } from '@/server/auth';
import { assertSameOrigin, AuthError, ownerId, ownerSession } from '@/server/authorize';
import { query } from '@/server/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const allowed = new Set(['/sign-in/email', '/sign-out', '/two-factor/enable', '/two-factor/verify-totp', '/two-factor/verify-backup-code']);
const verification = new Set(['/two-factor/verify-totp', '/two-factor/verify-backup-code']);

async function readBody(request: Request): Promise<Record<string, unknown>> {
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

function responseCookies(request: Request, response: Response) {
  const values = new Map<string, string>();
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index > 0) values.set(part.slice(0, index).trim(), part.slice(index + 1).trim());
  }
  for (const cookie of response.headers.getSetCookie()) {
    const pair = cookie.split(';', 1)[0];
    const index = pair.indexOf('=');
    if (index > 0) values.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
  }
  const headers = new Headers(request.headers);
  headers.set('cookie', [...values].map(([key, value]) => `${key}=${value}`).join('; '));
  return headers;
}

export async function POST(request: Request) {
  const safeHeaders = { 'Cache-Control': 'no-store, private', Vary: 'Cookie' };
  try {
    assertSameOrigin(request);
    const path = new URL(request.url).pathname.slice('/api/auth'.length);
    if (!allowed.has(path)) return Response.json({ code: 'NOT_FOUND', message: '此身份操作未开放。' }, { status: 404, headers: safeHeaders });
    const body = await readBody(request);
    if (body.trustDevice === true || (path === '/two-factor/enable' && body.method && body.method !== 'totp')) {
      throw new AuthError(400, 'MFA_POLICY', '本站要求身份验证器或一次性恢复码验证。');
    }
    if (!await ownerId()) throw new AuthError(503, 'OWNER_NOT_CONFIGURED', '请先在服务器创建拥有者账号。');
    if (verification.has(path)) {
      const existing = await getAuth().api.getSession({ headers: request.headers });
      if (existing?.user.twoFactorEnabled || (existing && path === '/two-factor/verify-backup-code')) {
        throw new AuthError(401, 'FRESH_LOGIN_REQUIRED', '请重新输入密码开始双重验证。');
      }
    }
    if (path === '/two-factor/enable') {
      const session = await ownerSession(request.headers);
      if (session.user.twoFactorEnabled) throw new AuthError(409, 'MFA_ALREADY_ENABLED', '已绑定身份验证器；恢复需使用服务器管理命令。');
    }
    const forwarded = new Request(request.url, {
      method: 'POST',
      headers: request.headers,
      body: JSON.stringify({ ...body, ...(path === '/sign-in/email' ? { rememberMe: false } : {}), ...(verification.has(path) ? { trustDevice: false } : {}) }),
    });
    const result = await getAuth().handler(forwarded);
    if (result.ok && verification.has(path)) {
      const session = await ownerSession(responseCookies(request, result));
      if (!session.user.twoFactorEnabled) throw new AuthError(403, 'MFA_REQUIRED', '身份验证器尚未验证完成。');
      await query(`INSERT INTO auth_session_assurance(session_id, user_id)
        SELECT $1, $2 WHERE EXISTS (SELECT 1 FROM "twoFactor" WHERE "userId" = $2 AND verified = true)
        ON CONFLICT(session_id) DO UPDATE SET last_seen_at = now()`, [session.session.id, session.user.id]);
    }
    const headers = new Headers(result.headers);
    headers.set('Cache-Control', 'no-store, private');
    headers.set('Vary', 'Cookie');
    if (result.status >= 500) {
      return Response.json({ code: 'AUTH_UNAVAILABLE', message: '身份服务暂不可用，请稍后重试。' }, { status: 503, headers: safeHeaders });
    }
    const payload = await result.json();
    // The browser authenticates with HttpOnly cookies, never a token copied from a JSON body.
    if (payload && typeof payload === 'object') delete payload.token;
    return Response.json(payload, { status: result.status, headers });
  } catch (error) {
    if (error instanceof AuthError) return Response.json({ code: error.code, message: error.message }, { status: error.status, headers: safeHeaders });
    return Response.json({ code: 'AUTH_UNAVAILABLE', message: '身份服务暂不可用，请稍后重试。' }, { status: 503, headers: safeHeaders });
  }
}

export async function GET() {
  return Response.json({ code: 'NOT_FOUND', message: '请使用站点身份状态入口。' }, { status: 404, headers: { 'Cache-Control': 'no-store' } });
}
