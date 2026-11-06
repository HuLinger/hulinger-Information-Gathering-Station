import { conversionJson, conversionRequest } from '@/server/conversion/http';
import { cancelJob, deleteJob, getJob } from '@/server/conversion/service';
import { readJsonObject } from '@/server/request-body';
import { DomainError } from '@/server/domain';

export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ id: string }> };
export const GET = (request: Request, context: Context) => conversionRequest(request, async () => conversionJson({ job: await getJob((await context.params).id) }));
export const DELETE = (request: Request, context: Context) => conversionRequest(request, async () => {
  await deleteJob((await context.params).id);
  return conversionJson({ success: true });
});
export const PATCH = (request: Request, context: Context) => conversionRequest(request, async () => {
  const input = await readJsonObject(request);
  if (input.action !== 'cancel' || Object.keys(input).length !== 1) throw new DomainError('不支持的操作。');
  await cancelJob((await context.params).id);
  return conversionJson({ success: true });
});
