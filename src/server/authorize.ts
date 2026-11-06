import { getAuth, authConfiguration } from './auth';
import { query } from './db';

export class AuthError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

export function assertSameOrigin(request: Request) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return;
  if (request.headers.get('origin') !== authConfiguration().origin) {
    throw new AuthError(403, 'INVALID_ORIGIN', '请求来源不受信任，请从本站重新操作。');
  }
  const site = request.headers.get('sec-fetch-site');
  if (site && !['same-origin', 'none'].includes(site)) {
    throw new AuthError(403, 'INVALID_ORIGIN', '不接受跨站写入请求。');
  }
}

export async function ownerId(): Promise<string | null> {
  const [record] = await query<{ value: { id?: unknown } }>("SELECT value FROM app_settings WHERE key = 'owner'");
  return typeof record?.value?.id === 'string' ? record.value.id : null;
}

export async function ownerSession(headers: Headers) {
  const session = await getAuth().api.getSession({ headers });
  if (!session) throw new AuthError(401, 'UNAUTHENTICATED', '请先登录。');
  const id = await ownerId();
  if (!id || session.user.id !== id) throw new AuthError(403, 'FORBIDDEN', '此账号不是站点拥有者。');
  return session;
}

export async function requireOwner(headers: Headers): Promise<{ id: string }> {
  const session = await ownerSession(headers);
  if (!session.user.twoFactorEnabled) {
    throw new AuthError(403, 'MFA_REQUIRED', '请先完成身份验证器绑定。');
  }
  // An account-wide MFA flag is insufficient: sessions created before enrollment must stay blocked.
  const [assurance] = await query<{ user_id: string }>(`
    UPDATE auth_session_assurance SET last_seen_at = now()
    WHERE session_id = $1 AND user_id = $2
      AND verified_at > now() - interval '24 hours'
      AND last_seen_at > now() - interval '2 hours'
      AND EXISTS (SELECT 1 FROM "twoFactor" WHERE "userId" = $2 AND verified = true)
    RETURNING user_id
  `, [session.session.id, session.user.id]);
  if (!assurance) throw new AuthError(401, 'MFA_REQUIRED', '会话需要重新进行双重验证，请重新登录。');
  return { id: assurance.user_id };
}

export async function requireUser(headers: Headers): Promise<{ id: string; role: 'owner' | 'member' }> {
  const session = await getAuth().api.getSession({ headers });
  if (!session) throw new AuthError(401, 'UNAUTHENTICATED', '请先登录。');
  if (session.user.id === await ownerId()) return { ...await requireOwner(headers), role: 'owner' };
  const [member] = await query<{ user_id: string }>(`
    UPDATE auth_session_assurance assurance SET last_seen_at=now()
    FROM member_accounts member
    WHERE assurance.session_id=$1 AND assurance.user_id=$2
      AND member.user_id=assurance.user_id AND member.disabled=false
      AND assurance.verified_at > now() - interval '24 hours'
      AND assurance.last_seen_at > now() - interval '2 hours'
    RETURNING assurance.user_id
  `, [session.session.id, session.user.id]);
  if (!member) throw new AuthError(401, 'UNAUTHENTICATED', '登录已失效，请重新登录。');
  return { id: member.user_id, role: 'member' };
}
