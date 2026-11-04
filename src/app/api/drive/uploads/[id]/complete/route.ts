import { z } from 'zod';
import { driveInput, driveJson, driveRequest } from '../../../../../../server/drive/http';
import { getDrive } from '../../../../../../server/drive/runtime';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return driveRequest(request, async (owner) => {
    z.object({}).strict().parse(await driveInput(request));
    return driveJson({ file: await getDrive().completeUpload(owner, (await context.params).id) });
  });
}
