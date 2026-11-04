import { z } from 'zod';
import { driveInput, driveJson, driveRequest } from '../../../../server/drive/http';
import { getDrive } from '../../../../server/drive/runtime';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
const schema = z.object({ name: z.string(), size: z.number().int().nonnegative(), lastModified: z.number().int().nonnegative(), fingerprint: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export async function POST(request: Request) {
  return driveRequest(request, async (owner) => driveJson(await getDrive().createUpload(owner, schema.parse(await driveInput(request)))));
}
