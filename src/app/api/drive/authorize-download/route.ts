import { DriveError } from '../../../../server/drive/errors';
import { driveRequest } from '../../../../server/drive/http';
import { getDrive } from '../../../../server/drive/runtime';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export async function GET(request: Request) {
  return driveRequest(request, async (owner) => {
    const uri = request.headers.get('x-forwarded-uri') ?? '';
    const method = request.headers.get('x-forwarded-method');
    const match = /^\/api\/drive\/files\/([a-f0-9-]{36})\/content(?:\?[^\r\n]*)?$/.exec(uri);
    if (!match || !['GET', 'HEAD'].includes(method ?? '')) throw new DriveError(403, 'INVALID_DOWNLOAD', '下载请求无效。');
    const { file, headers } = await getDrive().downloadInfo(owner, match[1]);
    return new Response(null, { status: 200, headers: {
      'Cache-Control': 'private, no-store',
      'X-Drive-Storage-Key': `${file.id}.bin`,
      'X-Drive-Disposition': headers.get('Content-Disposition')!,
      'X-Drive-ETag': file.etag,
    } });
  });
}
