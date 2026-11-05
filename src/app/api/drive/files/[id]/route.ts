import { z } from 'zod';
import { driveInput, driveJson, driveRequest } from '../../../../../server/drive/http';
import { getDrive } from '../../../../../server/drive/runtime';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
const action = z.discriminatedUnion('action', [
  z.object({ action: z.literal('rename'), name: z.string() }).strict(),
  z.object({ action: z.enum(['trash', 'restore']) }).strict(),
  z.object({ action: z.enum(['purge', 'cancel']), confirm: z.literal(true) }).strict(),
]);
type Context = { params: Promise<{ id: string }> };
export async function GET(request: Request, context: Context) {
  return driveRequest(request, async (owner) => driveJson(await getDrive().getFile(owner, (await context.params).id)));
}
export async function POST(request: Request, context: Context) {
  return driveRequest(request, async (owner) => driveJson(await getDrive().action(owner, (await context.params).id, action.parse(await driveInput(request)))));
}
