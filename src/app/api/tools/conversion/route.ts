import { conversionJson, conversionRequest } from '@/server/conversion/http';
import { listConversions } from '@/server/conversion/service';

export const dynamic = 'force-dynamic';
export const GET = (request: Request) => conversionRequest(request, async () => conversionJson(await listConversions()));
