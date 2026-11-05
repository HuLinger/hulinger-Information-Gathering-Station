import type { NextApiRequest, NextApiResponse } from 'next';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { downloadResponse } from '../../../../../server/drive/content';
import { failure, privateHeaders } from '../../../../../server/http';

// The App Router in Next 16.4 removes Content-Length from Response objects.
// Use its native HTTP API for byte-exact HEAD/Range framing and streamed files.
export const config = { api: { bodyParser: false, responseLimit: false } };

export default async function handler(request: NextApiRequest, response: NextApiResponse) {
  if (!['GET', 'HEAD'].includes(request.method ?? '')) {
    response.writeHead(405, { ...privateHeaders, Allow: 'GET, HEAD' });
    response.end();
    return;
  }
  const controller = new AbortController();
  const disconnected = () => { if (!response.writableFinished) controller.abort(); };
  response.once('close', disconnected);
  try {
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) {
      if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
    }
    const input = new Request('http://localhost/api/drive/content', { method: request.method, headers, signal: controller.signal });
    const result = await downloadResponse(input, typeof request.query.id === 'string' ? request.query.id : '');
    response.statusCode = result.status;
    result.headers.forEach((value, name) => response.setHeader(name, value));
    if (!result.body || request.method === 'HEAD') {
      await result.body?.cancel();
      response.end();
      return;
    }
    await pipeline(result.body as NodeReadableStream<Uint8Array>, response, { signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted || response.destroyed) return;
    if (response.headersSent) { response.destroy(); return; }
    const result = failure(error);
    response.statusCode = result.status;
    result.headers.forEach((value, name) => response.setHeader(name, value));
    response.end(Buffer.from(await result.arrayBuffer()));
  } finally { response.off('close', disconnected); }
}
