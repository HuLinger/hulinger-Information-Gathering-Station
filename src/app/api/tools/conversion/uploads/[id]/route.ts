import { conversionJson, conversionRequest } from '@/server/conversion/http';
import { deleteUpload } from '@/server/conversion/service';

export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ id: string }> };
export const DELETE = (request: Request, context: Context) => conversionRequest(request, async () => {
  await deleteUpload((await context.params).id);
  return conversionJson({ success: true });
});
