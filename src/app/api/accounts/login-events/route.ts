import { requireOwner } from '@/server/authorize';
import { listLoginEvents } from '@/server/accounts';
import { failure, privateHeaders } from '@/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    await requireOwner(request.headers);
    return Response.json(await listLoginEvents(new URL(request.url).searchParams), { headers: privateHeaders });
  } catch (error) { return failure(error); }
}
