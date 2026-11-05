import { z } from 'zod';
import { driveJson, driveRequest } from '../../../server/drive/http';
import { getDrive } from '../../../server/drive/runtime';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export async function GET(request: Request) {
  return driveRequest(request, async (owner) => {
    const params = new URL(request.url).searchParams;
    const view = z.enum(['files', 'trash']).parse(params.get('view') ?? 'files');
    return driveJson(await getDrive().list(owner, { view, q: params.get('q') ?? '', page: Number(params.get('page') ?? 1) }));
  });
}
