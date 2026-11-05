import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, get } from 'node:http';
import { mock } from 'node:test';
import { ReadableStream as WebReadableStream } from 'node:stream/web';
import { setTimeout as delay } from 'node:timers/promises';
import type { NextApiRequest, NextApiResponse } from 'next';
import type { DriveStore } from '../../src/server/drive/store';

export async function verifyDriveHttpDownloads(
  handler: (request: NextApiRequest, response: NextApiResponse) => Promise<void>,
  store: DriveStore, id: string, bytes: Buffer, headers: Headers,
) {
  let completed = 0;
  const errors: unknown[] = [];
  const server = createServer((request, response) => {
    const input = Object.assign(request, { query: { id } }) as unknown as NextApiRequest;
    void handler(input, response as NextApiResponse).catch((error) => {
      errors.push(error);
      response.destroy();
    }).finally(() => { completed++; });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/drive/files/${id}/content`;
  const settled = async (condition: () => boolean) => {
    const deadline = Date.now() + 3000;
    while (!condition() && Date.now() < deadline) await delay(5);
    assert.ok(condition(), 'The HTTP handler and its source must settle after disconnect/error.');
  };
  try {
    const full = await fetch(url, { headers });
    assert.equal(full.status, 200);
    assert.equal(full.headers.get('content-length'), String(bytes.length));
    assert.deepEqual(Buffer.from(await full.arrayBuffer()), bytes);
    const head = await fetch(url, { method: 'HEAD', headers });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('content-length'), String(bytes.length));
    assert.equal((await head.arrayBuffer()).byteLength, 0);
    const rangeHeaders = new Headers(headers);
    rangeHeaders.set('range', 'bytes=2-8');
    const range = await fetch(url, { headers: rangeHeaders });
    assert.equal(range.status, 206);
    assert.equal(range.headers.get('content-length'), '7');
    assert.equal(range.headers.get('content-range'), `bytes 2-8/${bytes.length}`);
    assert.deepEqual(Buffer.from(await range.arrayBuffer()), bytes.subarray(2, 9));
    const denied = await fetch(url);
    assert.equal(denied.status, 401);
    assert.equal((await denied.json() as { code: string }).code, 'UNAUTHENTICATED');
    const unsupported = await fetch(url, { method: 'POST', headers });
    assert.equal(unsupported.status, 405);
    assert.equal(unsupported.headers.get('allow'), 'GET, HEAD');
    await unsupported.arrayBuffer();
    await settled(() => completed === 5);

    // Keep the real authorization and handler; replace only the already-authorized
    // store source to deterministically exercise slow consumers and source failure.
    let pulls = 0;
    let closed = false;
    let signal: AbortSignal | undefined;
    const source = mock.method(store, 'download', async (_owner: string, _id: string, request: Request) => {
      signal = request.signal;
      async function* chunks() {
        try {
          for (let index = 0; index < 512; index++) {
            pulls++;
            yield Buffer.alloc(64 * 1024, 17);
          }
        } finally { closed = true; }
      }
      return new Response(WebReadableStream.from(chunks()) as unknown as ReadableStream<Uint8Array>, {
        headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(32 * 1024 * 1024) },
      });
    });
    try {
      const slow = await new Promise<import('node:http').IncomingMessage>((resolve, reject) => {
        get(url, { headers: Object.fromEntries(headers) }, resolve).once('error', reject);
      });
      await once(slow, 'data');
      slow.pause();
      await delay(40);
      assert.ok(pulls < 512, 'A paused HTTP client must apply backpressure before the whole source is read.');
      slow.destroy();
      await settled(() => completed === 6 && closed && signal?.aborted === true);
    } finally { source.mock.restore(); }

    for (const afterFirstChunk of [false, true]) {
      const failing = mock.method(store, 'download', async () => {
        async function* chunks() {
          if (afterFirstChunk) {
            yield Buffer.alloc(64 * 1024, 18);
            await delay(10);
          }
          throw new Error('synthetic stream failure');
        }
        return new Response(WebReadableStream.from(chunks()) as unknown as ReadableStream<Uint8Array>, {
          headers: { 'Content-Length': String(128 * 1024) },
        });
      });
      try {
        if (afterFirstChunk) {
          const partial = await fetch(url, { headers });
          assert.equal(partial.status, 200);
          await assert.rejects(partial.arrayBuffer(), 'A failed stream must terminate the connection instead of completing truncated content.');
        } else {
          await assert.rejects(fetch(url, { headers }), 'An early source failure must not send JSON with the stale file Content-Length.');
        }
        await settled(() => completed === (afterFirstChunk ? 8 : 7));
      } finally { failing.mock.restore(); }
    }
    assert.deepEqual(errors, []);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}
