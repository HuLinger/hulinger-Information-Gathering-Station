import { assertSameOrigin, requireOwner } from '@/server/authorize';
import { updateMember } from '@/server/accounts';
import { failure, privateHeaders } from '@/server/http';
import { readJsonObject } from '@/server/request-body';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(request);
    const actor = await requireOwner(request.headers);
    const { id } = await context.params;
    return Response.json({ account: await updateMember(actor.id, id, await readJsonObject(request)) }, { headers: privateHeaders });
  } catch (error) { return failure(error); }
}
