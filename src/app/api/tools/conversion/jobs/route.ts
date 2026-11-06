import { conversionJson, conversionRequest } from '@/server/conversion/http';
import { createJob } from '@/server/conversion/service';
import { readJsonObject } from '@/server/request-body';

export const dynamic = 'force-dynamic';
export const POST = (request: Request) => conversionRequest(request, async () => conversionJson({ job: await createJob(await readJsonObject(request)) }, 201));
