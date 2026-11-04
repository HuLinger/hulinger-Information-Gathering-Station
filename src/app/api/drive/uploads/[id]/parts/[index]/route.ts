import { driveJson, driveRequest } from '../../../../../../../server/drive/http';
import { getDrive } from '../../../../../../../server/drive/runtime';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export async function PUT(request: Request, context: { params: Promise<{ id: string; index: string }> }) {
  return driveRequest(request, async (owner) => {
    const { id, index } = await context.params;
    return driveJson(await getDrive().writePart(owner, id, /^\d+$/.test(index) ? Number(index) : NaN, request));
  });
}
