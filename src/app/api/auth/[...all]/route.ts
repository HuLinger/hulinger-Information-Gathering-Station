import { getAuth } from '@/server/auth';
import { assertSameOrigin, AuthError, ownerId, ownerSession } from '@/server/authorize';
import { recordLogin, withAccountLock } from '@/server/accounts';
import { query } from '@/server/db';
import { readJsonObject } from '@/server/request-body';
import type { LoginEvent } from '@/shared/accounts-contracts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const signIn = new Set(['/sign-in/email', '/sign-in/username']);
const allowed = new Set([...signIn, '/sign-out', '/two-factor/enable', '/two-factor/verify-totp', '/two-factor/verify-backup-code']);
const verification = new Set(['/two-factor/verify-totp', '/two-factor/verify-backup-code']);
const safeHeaders = { 'Cache-Control': 'no-store, private', Vary: 'Cookie' };

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
  let loginUserId: string | null = null;
  let loginMethod: LoginEvent['method'] | null = null;
  let recorded = false;
  try {
    assertSameOrigin(request);
    const path = new URL(request.url).pathname.slice('/api/auth'.length);
    if (!allowed.has(path)) return Response.json({ code: 'NOT_FOUND', message: '此身份操作未开放。' }, { status: 404, headers: safeHeaders });
    const body = await readJsonObject(request);
    if (body.trustDevice === true || (path === '/two-factor/enable' && body.method && body.method !== 'totp')) {
      throw new AuthError(400, 'MFA_POLICY', '本站主账号要求身份验证器或一次性恢复码验证。');
    }
    const owner = await ownerId();
    if (!owner) throw new AuthError(503, 'OWNER_NOT_CONFIGURED', '请先在服务器创建主账号。');
    let forwardedPath = path;
    let forwardedBody = body;
    if (signIn.has(path)) {
      loginMethod = 'password';
      const identifier = path === '/sign-in/username' ? body.username : body.email;
      if (typeof identifier === 'string' && identifier.length <= 254) {
        const normalized = identifier.trim().toLowerCase();
        // admin is only an alias of the stable configured owner; it never grants a role by itself.
        const isAdminAlias = path === '/sign-in/username' && normalized === 'admin';
        const [user] = await query<{ id: string; email: string }>(isAdminAlias
          ? 'SELECT id,email FROM "user" WHERE id=$1'
          : path === '/sign-in/username' ? 'SELECT id,email FROM "user" WHERE lower(username)=$1' : 'SELECT id,email FROM "user" WHERE lower(email)=$1', [isAdminAlias ? owner : normalized]);
        loginUserId = user?.id ?? null;
        if (isAdminAlias && user) {
          forwardedPath = '/sign-in/email';
          forwardedBody = { ...body, email: user.email };
        } else if (path === '/sign-in/username') forwardedBody = { ...body, username: normalized };
        else forwardedBody = { ...body, email: normalized };
      }
    } else if (verification.has(path)) {
      loginUserId = owner;
      loginMethod = path === '/two-factor/verify-totp' ? 'totp' : 'backup-code';
      const existing = await getAuth().api.getSession({ headers: request.headers });
      if (existing?.user.twoFactorEnabled || (existing && path === '/two-factor/verify-backup-code')) {
        throw new AuthError(401, 'FRESH_LOGIN_REQUIRED', '请重新输入密码开始双重验证。');
      }
    }
    if (path === '/two-factor/enable') {
      const session = await ownerSession(request.headers);
      if (session.user.twoFactorEnabled) throw new AuthError(409, 'MFA_ALREADY_ENABLED', '已绑定身份验证器；恢复需使用服务器管理命令。');
    }
    const authenticate = async () => {
      const forwarded = new Request(new URL(`/api/auth${forwardedPath}`, request.url), {
        method: 'POST', headers: request.headers,
        body: JSON.stringify({ ...forwardedBody, ...(signIn.has(path) ? { rememberMe: false } : {}), ...(verification.has(path) ? { trustDevice: false } : {}) }),
      });
      const result = await getAuth().handler(forwarded);
      if (result.status >= 500) throw new AuthError(503, 'AUTH_UNAVAILABLE', '身份服务暂不可用，请稍后重试。');
      const payload = await result.json();
      if (result.ok && verification.has(path)) {
        const session = await ownerSession(responseCookies(request, result));
        if (!session.user.twoFactorEnabled) throw new AuthError(403, 'MFA_REQUIRED', '身份验证器尚未验证完成。');
        await query(`INSERT INTO auth_session_assurance(session_id, user_id)
          SELECT $1, $2 WHERE EXISTS (SELECT 1 FROM "twoFactor" WHERE "userId"=$2 AND verified=true)
          ON CONFLICT(session_id) DO UPDATE SET last_seen_at=now()`, [session.session.id, session.user.id]);
        await recordLogin(request.headers, session.user.id, 'success', loginMethod!);
        recorded = true;
      } else if (result.ok && signIn.has(path) && !payload?.twoFactorRedirect) {
        const session = await getAuth().api.getSession({ headers: responseCookies(request, result) });
        if (!session) throw new AuthError(401, 'INVALID_CREDENTIALS', '账号或密码不正确。');
        if (session.user.id !== owner) {
          const [member] = await query<{ user_id: string }>('SELECT user_id FROM member_accounts WHERE user_id=$1 AND disabled=false', [session.user.id]);
          if (!member || session.user.twoFactorEnabled) {
            await query('DELETE FROM "session" WHERE id=$1', [session.session.id]);
            throw new AuthError(401, 'INVALID_CREDENTIALS', '账号或密码不正确。');
          }
          await query('INSERT INTO auth_session_assurance(session_id,user_id) VALUES($1,$2)', [session.session.id, session.user.id]);
          await recordLogin(request.headers, session.user.id, 'success', 'password');
          recorded = true;
        }
      }
      if (!result.ok && loginMethod) {
        await recordLogin(request.headers, loginUserId, 'failure', loginMethod);
        recorded = true;
      }
      const headers = new Headers(result.headers);
      headers.set('Cache-Control', 'no-store, private');
      headers.set('Vary', 'Cookie');
      // The browser authenticates with HttpOnly cookies, never a token copied from a JSON body.
      if (payload && typeof payload === 'object') delete payload.token;
      if (!result.ok && signIn.has(path) && result.status !== 429) {
        return Response.json({ code: 'INVALID_CREDENTIALS', message: '账号或密码不正确。', error: '账号或密码不正确。' }, { status: 401, headers });
      }
      return Response.json(payload, { status: result.status, headers });
    };
    return loginUserId ? await withAccountLock(loginUserId, authenticate) : await authenticate();
  } catch (error) {
    if (loginMethod && !recorded) {
      try { await recordLogin(request.headers, loginUserId, 'failure', loginMethod); }
      catch { return Response.json({ code: 'AUTH_UNAVAILABLE', message: '身份服务暂不可用，请稍后重试。' }, { status: 503, headers: safeHeaders }); }
    }
    if (error instanceof AuthError) return Response.json({ code: error.code, message: error.message, error: error.message }, { status: error.status, headers: safeHeaders });
    return Response.json({ code: 'AUTH_UNAVAILABLE', message: '身份服务暂不可用，请稍后重试。' }, { status: 503, headers: safeHeaders });
  }
}

export async function GET() {
  return Response.json({ code: 'NOT_FOUND', message: '请使用站点身份状态入口。' }, { status: 404, headers: { 'Cache-Control': 'no-store' } });
}
