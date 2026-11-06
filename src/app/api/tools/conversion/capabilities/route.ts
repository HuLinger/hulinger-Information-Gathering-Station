import { conversionJson, conversionRequest } from '@/server/conversion/http';
import { capabilities } from '@/server/conversion/service';

export const dynamic = 'force-dynamic';
export const GET = (request: Request) => conversionRequest(request, async () => conversionJson(await capabilities(new URL(request.url).searchParams.get('extension') ?? '')));
