import { conversionJson, conversionRequest } from '@/server/conversion/http';
import { createUpload } from '@/server/conversion/service';
import { readJsonObject } from '@/server/request-body';

export const dynamic = 'force-dynamic';
export const POST = (request: Request) => conversionRequest(request, async () => conversionJson({ upload: await createUpload(await readJsonObject(request)) }, 201));
