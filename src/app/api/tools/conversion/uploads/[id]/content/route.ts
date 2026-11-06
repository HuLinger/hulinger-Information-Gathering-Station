import { conversionJson, conversionRequest } from '@/server/conversion/http';
import { receiveUpload } from '@/server/conversion/service';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
type Context = { params: Promise<{ id: string }> };
export const PUT = (request: Request, context: Context) => conversionRequest(request, async () => conversionJson({ upload: await receiveUpload((await context.params).id, request) }));
