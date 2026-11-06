import { assertSameOrigin, requireOwner } from '@/server/authorize';
import { revokeMemberSessions } from '@/server/accounts';
import { failure, privateHeaders } from '@/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(request);
    const actor = await requireOwner(request.headers);
    const { id } = await context.params;
    await revokeMemberSessions(actor.id, id);
    return Response.json({ ok: true }, { headers: privateHeaders });
  } catch (error) { return failure(error); }
}
