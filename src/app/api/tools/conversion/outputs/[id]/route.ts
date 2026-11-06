import { conversionRequest } from '@/server/conversion/http';
import { downloadOutput } from '@/server/conversion/service';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
type Context = { params: Promise<{ id: string }> };
export const GET = (request: Request, context: Context) => conversionRequest(request, async () => downloadOutput((await context.params).id));
export const HEAD = (request: Request, context: Context) => conversionRequest(request, async () => downloadOutput((await context.params).id, true));
