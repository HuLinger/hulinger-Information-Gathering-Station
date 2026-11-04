import { AuthError, ownerId, ownerSession, requireOwner } from '@/server/authorize';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const headers = { 'Cache-Control': 'no-store, private', Vary: 'Cookie' };
  try {
    if (!await ownerId()) return Response.json({ state: 'unconfigured' }, { headers });
    const session = await ownerSession(request.headers);
    const user = { id: session.user.id, email: session.user.email, name: session.user.name };
    if (!session.user.twoFactorEnabled) return Response.json({ state: 'setup-mfa', user }, { headers });
    await requireOwner(request.headers);
    return Response.json({ state: 'ready', user }, { headers });
  } catch (error) {
    if (error instanceof AuthError) return Response.json({ state: 'signed-out' }, { headers });
    return Response.json({ code: 'AUTH_UNAVAILABLE', message: '身份服务暂不可用，请稍后重试。' }, { status: 503, headers });
  }
}
