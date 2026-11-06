import { AuthError, ownerId, requireUser } from '@/server/authorize';
import { getAuth } from '@/server/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const headers = { 'Cache-Control': 'no-store, private', Vary: 'Cookie' };
  try {
    const owner = await ownerId();
    if (!owner) return Response.json({ state: 'unconfigured' }, { headers });
    const session = await getAuth().api.getSession({ headers: request.headers });
    if (!session) return Response.json({ state: 'signed-out' }, { headers });
    const role = session.user.id === owner ? 'owner' : 'member';
    const user = { id: session.user.id, email: session.user.email, name: session.user.name, username: session.user.username ?? (role === 'owner' ? 'admin' : null), role };
    if (role === 'owner' && !session.user.twoFactorEnabled) return Response.json({ state: 'setup-mfa', user }, { headers });
    await requireUser(request.headers);
    return Response.json({ state: 'ready', user }, { headers });
  } catch (error) {
    if (error instanceof AuthError) return Response.json({ state: 'signed-out' }, { headers });
    return Response.json({ code: 'AUTH_UNAVAILABLE', message: '身份服务暂不可用，请稍后重试。' }, { status: 503, headers });
  }
}
