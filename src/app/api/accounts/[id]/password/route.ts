import { assertSameOrigin, requireOwner } from '@/server/authorize';
import { resetMemberPassword } from '@/server/accounts';
import { failure, privateHeaders } from '@/server/http';
import { readJsonObject } from '@/server/request-body';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(request);
    const actor = await requireOwner(request.headers);
    const { id } = await context.params;
    await resetMemberPassword(actor.id, id, await readJsonObject(request));
    return Response.json({ ok: true }, { headers: privateHeaders });
  } catch (error) { return failure(error); }
}
