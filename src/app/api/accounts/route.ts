import { assertSameOrigin, requireOwner } from '@/server/authorize';
import { createMember, listAccounts } from '@/server/accounts';
import { failure, privateHeaders } from '@/server/http';
import { readJsonObject } from '@/server/request-body';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    await requireOwner(request.headers);
    return Response.json({ accounts: await listAccounts() }, { headers: privateHeaders });
  } catch (error) { return failure(error); }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const actor = await requireOwner(request.headers);
    return Response.json({ account: await createMember(actor.id, await readJsonObject(request)) }, { status: 201, headers: privateHeaders });
  } catch (error) { return failure(error); }
}
