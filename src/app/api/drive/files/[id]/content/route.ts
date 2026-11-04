import { driveRequest } from '../../../../../../server/drive/http';
import { getDrive } from '../../../../../../server/drive/runtime';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
type Context = { params: Promise<{ id: string }> };
export async function GET(request: Request, context: Context) {
  return driveRequest(request, async (owner) => getDrive().download(owner, (await context.params).id, request));
}
export const HEAD = GET;
