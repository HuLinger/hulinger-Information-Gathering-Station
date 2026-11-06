import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { ConversionProviderError, type ProviderContext, type ProviderInput } from '../src/server/conversion/provider-types';
import { getConversionProviders } from '../src/server/conversion/providers';

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);
const jpeg = Buffer.from([255, 216, 255, 1, 2, 3]);
const zip = Buffer.from([80, 75, 3, 4, 1, 2, 3, 4]);
const signal = () => new AbortController().signal;
const context = (overrides: Partial<ProviderContext> = {}): ProviderContext => ({ signal: signal(), maxOutputBytes: 1024 * 1024, maxOutputFiles: 10, onStage: async () => {}, ...overrides });
const providers = () => getConversionProviders({ CONVERTX_URL: 'http://convertx.test', TRANSMUTE_URL: 'http://transmute.test', TRANSMUTE_API_KEY: 'synthetic-api-key', STIRLING_PDF_URL: 'http://stirling.test', NCMDUMP_URL: 'http://ncm.test' });
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
const hasCode = (code: string) => (error: unknown) => error instanceof ConversionProviderError && error.code === code;

async function fixture(t: TestContext, extension = 'png', contents: Buffer = png) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hulinger-conversion-test-'));
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });
  const source = path.join(directory, 'source');
  await writeFile(source, contents);
  const input: ProviderInput = { path: source, name: `中文样例.${extension}`, extension, bytes: contents.byteLength };
  return { directory, input };
}

function mockFetch(t: TestContext, handler: (url: URL, init: RequestInit) => Response | Promise<Response>) {
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init: RequestInit = {}) => {
    assert.equal(init.redirect, 'manual', 'upstream must never redirect credentials to another origin');
    assert.ok(init.signal, 'every upstream operation must be cancellable');
    return handler(new URL(url instanceof Request ? url.url : url.toString()), init);
  });
}

function convertxSession(jobId = '123', userId = '456') {
  const jwt = `header.${Buffer.from(JSON.stringify({ id: userId })).toString('base64url')}.signature`;
  const headers = new Headers();
  headers.append('Set-Cookie', `auth=${jwt}; HttpOnly; Path=/`);
  headers.append('Set-Cookie', `jobId=${jobId}; HttpOnly; Path=/`);
  return new Response('<html></html>', { headers });
}

function conversionRows(names: string[], jobId = '123', userId = '456', status = 'Done') {
  return `<progress value="1" max="1"></progress><table><tbody>${names.map((name) => `<tr><td>${name}</td><td>${status}</td><td><a href="/download/${userId}/${jobId}/${encodeURIComponent(name)}" download="${name}">Download</a></td></tr>`).join('')}</tbody></table>`;
}

test('missing or unsafe server configuration is unavailable without making network requests', async (t) => {
  mockFetch(t, () => { throw new Error('must not fetch'); });
  assert.ok(getConversionProviders({}).every((provider) => !provider.configured));
  const bad = getConversionProviders({ CONVERTX_URL: 'https://secret:password@example.invalid', TRANSMUTE_URL: 'http://transmute.test', STIRLING_PDF_URL: 'file:///data', NCMDUMP_URL: 'http://ncm.test/?secret=value' });
  assert.ok(bad.every((provider) => !provider.configured));
  for (const provider of bad) await assert.rejects(provider.health(signal()), hasCode('ENGINE_UNCONFIGURED'));
});

test('ConvertX capabilities use the installed service and exclude protocol pseudo-formats', async (t) => {
  mockFetch(t, (url, init) => {
    assert.equal(url.pathname, '/conversions');
    assert.equal(init.method, 'POST');
    assert.deepEqual(JSON.parse(String(init.body)), { fileType: 'png' });
    return new Response('<button class="target" data-target="jpeg" data-converter="imagemagick"></button><button class="target" data-target="jpeg" data-converter="vips"></button><button class="target" data-target="https" data-converter="imagemagick"></button><button class="target" data-target="pdf" data-converter="bad,converter"></button>');
  });
  assert.deepEqual(await providers()[0].options('PNG', signal()), [{ format: 'jpeg', label: 'JPEG', engine: 'convertx' }]);
  assert.deepEqual(await providers()[0].options('https', signal()), []);
});

test('ConvertX uses independent sessions, verifies all output rows and downloads each generated page', async (t) => {
  const { directory, input } = await fixture(t, 'pdf', Buffer.from('%PDF-synthetic'));
  let session = 0;
  const deleted: string[] = [];
  mockFetch(t, async (url, init) => {
    const route = url.pathname;
    if (route === '/conversions') return new Response('<button class="target" data-target="png" data-converter="imagemagick"></button>');
    if (route === '/') return convertxSession(String(++session), String(100 + session));
    const cookie = new Headers(init.headers).get('cookie');
    assert.ok(cookie?.includes(`jobId=${session}`));
    if (route === '/upload') {
      assert.ok(init.body instanceof FormData);
      const file = init.body.get('file');
      assert.ok(file instanceof File);
      assert.equal(file.name, 'input.pdf');
      assert.equal(file.type, 'application/pdf');
      assert.equal(await file.text(), '%PDF-synthetic');
      return json({ message: 'Files uploaded successfully.' });
    }
    if (route === '/convert') {
      assert.deepEqual(JSON.parse(String(init.body)), { convert_to: 'png,imagemagick', file_names: '["input.pdf"]' });
      return new Response(null, { status: 302, headers: { Location: `/results/${session}` } });
    }
    if (route === `/progress/${session}`) return new Response(conversionRows(['input-0.png', 'input-1.png'], String(session), String(100 + session)));
    if (route.startsWith(`/download/${100 + session}/${session}/`)) return new Response(png, { headers: { 'Content-Type': 'image/png' } });
    if (route === `/delete/${session}`) { deleted.push(route); return new Response(null, { status: 302, headers: { Location: '/history' } }); }
    throw new Error(`Unexpected route ${route}`);
  });
  const provider = providers()[0];
  const first = await provider.convert(input, 'png', directory, context());
  const second = await provider.convert(input, 'png', directory, context());
  assert.deepEqual(first.map((output) => output.name), ['中文样例-0.png', '中文样例-1.png']);
  assert.equal(new Set([...first, ...second].map((output) => output.storageName)).size, 4);
  for (const output of [...first, ...second]) {
    assert.equal(output.bytes, png.byteLength);
    assert.deepEqual(await readFile(path.join(directory, output.storageName)), png);
    assert.ok(!output.storageName.includes('中文'));
  }
  assert.deepEqual(deleted, ['/delete/1', '/delete/2']);
});

for (const scenario of ['failed-status', 'foreign-link', 'wrong-format', 'duplicate-output', 'too-many-files', 'total-size', 'invalid-binary'] as const) {
  test(`ConvertX rejects ${scenario}, removes partial downloads, and cleans its terminal job`, async (t) => {
    const { directory, input } = await fixture(t);
    let deleted = false;
    let downloads = 0;
    mockFetch(t, (url) => {
      if (url.pathname === '/conversions') return new Response('<button class="target" data-target="png" data-converter="vips"></button>');
      if (url.pathname === '/') return convertxSession();
      if (url.pathname === '/upload') return json({ message: 'Files uploaded successfully.' });
      if (url.pathname === '/convert') return new Response(null, { status: 302, headers: { Location: '/results/123' } });
      if (url.pathname === '/progress/123') {
        const names = scenario === 'duplicate-output' ? ['input.png', 'input.png'] : scenario === 'wrong-format' ? ['input.pdf'] : scenario === 'total-size' || scenario === 'too-many-files' ? ['input-0.png', 'input-1.png'] : ['input.png'];
        const rows = conversionRows(names, '123', '456', scenario === 'failed-status' ? 'Failed, check logs' : 'Done');
        return new Response(scenario === 'foreign-link' ? rows.replace('/download/456', 'https://leak.invalid/download/456') : rows);
      }
      if (url.pathname.startsWith('/download/')) { downloads++; return new Response(scenario === 'invalid-binary' ? Buffer.from('not an image') : png); }
      if (url.pathname === '/delete/123') { deleted = true; return new Response(null, { status: 302 }); }
      throw new Error('Unexpected request');
    });
    const code = scenario === 'failed-status' ? 'CONVERSION_FAILED' : scenario === 'total-size' || scenario === 'too-many-files' ? 'OUTPUT_LIMIT' : 'INVALID_ENGINE_RESPONSE';
    await assert.rejects(providers()[0].convert(input, 'png', directory, context({ maxOutputBytes: scenario === 'total-size' ? png.byteLength + 1 : 1024, maxOutputFiles: scenario === 'too-many-files' ? 1 : 10 })), hasCode(code));
    assert.ok(deleted);
    assert.deepEqual(await readdir(directory), ['source']);
    if (['failed-status', 'foreign-link', 'wrong-format', 'duplicate-output', 'too-many-files'].includes(scenario)) assert.equal(downloads, 0);
  });
}

test('ConvertX cancellation does not report success or delete files from a still-running upstream task', async (t) => {
  const { directory, input } = await fixture(t);
  const controller = new AbortController();
  mockFetch(t, (url) => {
    if (url.pathname === '/conversions') return new Response('<button class="target" data-target="jpeg" data-converter="vips"></button>');
    if (url.pathname === '/') return convertxSession();
    if (url.pathname === '/upload') return json({ message: 'Files uploaded successfully.' });
    if (url.pathname === '/convert') return new Response(null, { status: 302, headers: { Location: '/results/123' } });
    if (url.pathname === '/progress/123') { controller.abort(); throw new DOMException('Aborted', 'AbortError'); }
    throw new Error('Must not download or delete an active conversion');
  });
  await assert.rejects(providers()[0].convert(input, 'jpeg', directory, context({ signal: controller.signal })), hasCode('CONVERSION_ABORTED'));
  assert.deepEqual(await readdir(directory), ['source']);
});

test('ConvertX rejects an unexpected HTML page immediately instead of polling until timeout', async (t) => {
  const { directory, input } = await fixture(t);
  mockFetch(t, (url) => {
    if (url.pathname === '/conversions') return new Response('<button class="target" data-target="jpeg" data-converter="vips"></button>');
    if (url.pathname === '/') return convertxSession();
    if (url.pathname === '/upload') return json({ message: 'Files uploaded successfully.' });
    if (url.pathname === '/convert') return new Response(null, { status: 302, headers: { Location: '/results/123' } });
    if (url.pathname === '/progress/123') return new Response('<html><h1>Please sign in</h1></html>');
    throw new Error('Unknown job state must not trigger a download or deletion');
  });
  await assert.rejects(providers()[0].convert(input, 'jpeg', directory, context()), hasCode('INVALID_ENGINE_RESPONSE'));
});

test('Transmute uses authenticated capabilities and filters unsupported URL output types', async (t) => {
  mockFetch(t, (url, init) => {
    assert.equal(url.pathname, '/api/converters');
    assert.equal(new Headers(init.headers).get('Authorization'), 'Bearer synthetic-api-key');
    return json({ converters: [
      { supported_input_formats: ['png'], supported_output_formats: ['jpg', 'webp', 'https'] },
      { supported_input_formats: ['docx'], supported_output_formats: ['pdf'] },
    ] });
  });
  assert.deepEqual((await providers()[1].options('png', signal())).map((option) => option.format), ['jpeg', 'webp']);
});

test('Transmute checks actual detected formats, waits for terminal success and cleans remote input/output', async (t) => {
  const { directory, input } = await fixture(t);
  const cleanup: string[] = [];
  mockFetch(t, async (url, init) => {
    assert.equal(new Headers(init.headers).get('Authorization'), 'Bearer synthetic-api-key');
    if (url.pathname === '/api/files' && init.method === 'POST') {
      assert.ok(init.body instanceof FormData);
      const file = init.body.get('file');
      assert.ok(file instanceof File);
      assert.deepEqual(Buffer.from(await file.arrayBuffer()), png);
      return json({ metadata: { id: 'source-id', compatible_formats: { jpg: [] } } });
    }
    if (url.pathname === '/api/jobs') {
      assert.deepEqual(JSON.parse(String(init.body)), { id: 'source-id', output_format: 'jpg' });
      return json({ id: 'job-id', status: 'running', progress: 100 });
    }
    if (url.pathname === '/api/jobs/job-id') return json({ id: 'job-id', status: 'completed', output_file_id: 'output-id' });
    if (url.pathname === '/api/files/output-id') return new Response(jpeg, { headers: { 'Content-Type': 'image/jpeg', 'Content-Disposition': 'attachment; filename="input.jpeg"' } });
    if (init.method === 'DELETE') { cleanup.push(url.pathname); return json({ message: 'deleted' }); }
    throw new Error('Unexpected route');
  });
  const result = await providers()[1].convert(input, 'jpeg', directory, context());
  assert.equal(result[0].name, '中文样例.jpeg');
  assert.deepEqual(await readFile(path.join(directory, result[0].storageName)), jpeg);
  assert.deepEqual(cleanup, ['/api/conversions/output-id', '/api/files/source-id']);
});

test('Transmute rejects unsupported detected input and deletes the upload before submitting a job', async (t) => {
  const { directory, input } = await fixture(t);
  let deleted = false;
  mockFetch(t, (url, init) => {
    if (url.pathname === '/api/files' && init.method === 'POST') return json({ metadata: { id: 'source-id', compatible_formats: { txt: [] } } });
    if (url.pathname === '/api/files/source-id' && init.method === 'DELETE') { deleted = true; return json({ message: 'deleted' }); }
    throw new Error('No job may be submitted');
  });
  await assert.rejects(providers()[1].convert(input, 'jpeg', directory, context()), hasCode('UNSUPPORTED_FORMAT'));
  assert.ok(deleted);
});

test('Transmute never exposes upstream job errors or treats progress=100 as completed', async (t) => {
  const { directory, input } = await fixture(t);
  const deleted: string[] = [];
  mockFetch(t, (url, init) => {
    if (url.pathname === '/api/files') return json({ metadata: { id: 'source-id', compatible_formats: { jpeg: [] } } });
    if (url.pathname === '/api/jobs') return json({ id: 'job-id', status: 'running', progress: 100 });
    if (init.method === 'DELETE') { deleted.push(url.pathname); return new Response(null, { status: 204 }); }
    if (url.pathname === '/api/jobs/job-id') return json({ id: 'job-id', status: 'failed', error_message: 'secret-api-key /data/private-file' });
    throw new Error('Must not download failed output');
  });
  await assert.rejects(providers()[1].convert(input, 'jpeg', directory, context()), (error: unknown) => error instanceof ConversionProviderError && error.code === 'CONVERSION_FAILED' && !error.message.includes('secret') && !error.message.includes('/data'));
  assert.deepEqual(deleted, ['/api/jobs/job-id', '/api/files/source-id']);
});

test('Stirling exposes PDF image archives explicitly and sends the exact multipart operation', async (t) => {
  const { directory, input } = await fixture(t, 'pdf', Buffer.from('%PDF-synthetic'));
  mockFetch(t, (url, init) => {
    assert.equal(url.pathname, '/api/v1/convert/pdf/img');
    assert.ok(init.body instanceof FormData);
    assert.equal(init.body.get('imageFormat'), 'png');
    assert.equal(init.body.get('singleOrMultiple'), 'multiple');
    assert.equal(init.body.get('pageNumbers'), 'all');
    assert.equal(init.body.get('colorType'), 'color');
    assert.equal((init.body.get('fileInput') as File).type, 'application/pdf');
    return new Response(zip, { headers: { 'Content-Type': 'application/zip', 'Content-Disposition': 'attachment; filename="converted.zip"' } });
  });
  const provider = providers()[2];
  assert.ok((await provider.options('pdf', signal())).find((option) => option.format === 'png')?.label.includes('ZIP'));
  const outputs = await provider.convert(input, 'png', directory, context());
  assert.equal(outputs[0].name, '中文样例-png.zip');
  assert.equal(outputs[0].mime, 'application/zip');
  assert.deepEqual(await readFile(path.join(directory, outputs[0].storageName)), zip);
});

test('Stirling Office conversion disables the optional commercial converter and validates a PDF result', async (t) => {
  const { directory, input } = await fixture(t, 'docx', zip);
  mockFetch(t, (url, init) => {
    assert.equal(url.pathname, '/api/v1/convert/file/pdf');
    assert.ok(init.body instanceof FormData);
    assert.equal(init.body.get('useStirlingOfficeConvert'), 'false');
    assert.equal((init.body.get('fileInput') as File).name, 'input.docx');
    return new Response('%PDF-synthetic', { headers: { 'Content-Type': 'application/pdf' } });
  });
  const [output] = await providers()[2].convert(input, 'pdf', directory, context());
  assert.equal(output.mime, 'application/pdf');
  assert.equal(output.name, '中文样例.pdf');
});

test('NCM exposes original audio only and preserves the real FLAC format without pretending to transcode', async (t) => {
  const { directory, input } = await fixture(t, 'ncm', Buffer.from('synthetic-ncm'));
  mockFetch(t, (url, init) => {
    assert.equal(url.pathname, '/convert');
    assert.ok(init.body instanceof FormData);
    assert.equal((init.body.get('file') as File).name, 'input.ncm');
    return new Response('fLaCsynthetic', { headers: { 'Content-Type': 'audio/flac', 'Content-Disposition': 'attachment; filename="input.flac"' } });
  });
  const provider = providers()[3];
  assert.deepEqual(await provider.options('ncm', signal()), [{ engine: 'ncmdump', format: 'audio', label: '原始音频（MP3 / FLAC）' }]);
  await assert.rejects(provider.convert(input, 'mp3', directory, context()), hasCode('UNSUPPORTED_FORMAT'));
  const [output] = await provider.convert(input, 'audio', directory, context());
  assert.equal(output.name, '中文样例.flac');
  assert.equal(output.mime, 'audio/flac');
});

test('streaming output limits cancel oversized response bodies and remove the partial file', async (t) => {
  const { directory, input } = await fixture(t, 'ncm', Buffer.from('synthetic-ncm'));
  let cancelled = false;
  mockFetch(t, () => new Response(new ReadableStream<Uint8Array>({
    pull(controller) { controller.enqueue(Buffer.from('fLaC1234567890123456789012345678901234567890')); },
    cancel() { cancelled = true; },
  }), { headers: { 'Content-Type': 'audio/flac' } }));
  await assert.rejects(providers()[3].convert(input, 'audio', directory, context({ maxOutputBytes: 10 })), hasCode('OUTPUT_LIMIT'));
  assert.ok(cancelled);
  assert.deepEqual(await readdir(directory), ['source']);
});

test('output cancellation propagates to the engine stream and removes partial content', async (t) => {
  const { directory, input } = await fixture(t, 'ncm', Buffer.from('synthetic-ncm'));
  const controller = new AbortController();
  let cancelled = false;
  mockFetch(t, () => new Response(new ReadableStream<Uint8Array>({
    start(stream) { stream.enqueue(Buffer.from('fLaC1234')); setImmediate(() => controller.abort()); },
    cancel() { cancelled = true; },
  }), { headers: { 'Content-Type': 'audio/flac' } }));
  await assert.rejects(providers()[3].convert(input, 'audio', directory, context({ signal: controller.signal })), hasCode('CONVERSION_ABORTED'));
  assert.ok(cancelled);
  assert.deepEqual(await readdir(directory), ['source']);
});

test('disk capacity is checked with backpressure before each output chunk and failure removes partial content', async (t) => {
  const { directory, input } = await fixture(t, 'ncm', Buffer.from('synthetic-ncm'));
  const chunks = [Buffer.from('fLaC1234'), Buffer.from('5678')];
  mockFetch(t, () => new Response(new ReadableStream<Uint8Array>({
    start(stream) { for (const chunk of chunks) stream.enqueue(chunk); stream.close(); },
  }), { headers: { 'Content-Type': 'audio/flac' } }));
  const checks: number[] = [];
  let activeChecks = 0;
  await assert.rejects(providers()[3].convert(input, 'audio', directory, context({ beforeWrite: async (bytes) => {
    assert.equal(activeChecks, 0, 'disk checks must not run concurrently');
    activeChecks++;
    checks.push(bytes);
    await new Promise<void>((resolve) => setImmediate(resolve));
    activeChecks--;
    if (checks.length === 2) throw Object.assign(new Error('internal disk path must stay private'), { code: 'STORAGE_FULL' });
  } })), (error: unknown) => error instanceof ConversionProviderError && error.code === 'STORAGE_FULL' && !error.message.includes('internal'));
  assert.deepEqual(checks, [8, 4]);
  assert.deepEqual(await readdir(directory), ['source']);
});

test('a partial HTTP download is not accepted as a complete conversion result', async (t) => {
  const { directory, input } = await fixture(t, 'ncm', Buffer.from('synthetic-ncm'));
  mockFetch(t, () => new Response('fLaC1234', { status: 206, headers: { 'Content-Type': 'audio/flac', 'Content-Range': 'bytes 0-7/100' } }));
  await assert.rejects(providers()[3].convert(input, 'audio', directory, context()), hasCode('INVALID_ENGINE_RESPONSE'));
  assert.deepEqual(await readdir(directory), ['source']);
});

test('a JSON problem response cannot become a successful text conversion download', async (t) => {
  const { directory, input } = await fixture(t, 'pdf', Buffer.from('%PDF-synthetic'));
  mockFetch(t, () => new Response('{"detail":"internal failure"}', { headers: { 'Content-Type': 'application/problem+json' } }));
  await assert.rejects(providers()[2].convert(input, 'txt', directory, context()), hasCode('INVALID_ENGINE_RESPONSE'));
  assert.deepEqual(await readdir(directory), ['source']);
});

test('large metadata and upstream exception text are bounded and never passed to the user', async (t) => {
  mockFetch(t, () => new Response('x'.repeat(1024 * 1024 + 1)));
  await assert.rejects(providers()[0].options('png', signal()), hasCode('INVALID_ENGINE_RESPONSE'));
  t.mock.restoreAll();
  mockFetch(t, () => { throw new Error('private-api-key at http://internal-host/private'); });
  await assert.rejects(providers()[0].health(signal()), (error: unknown) => error instanceof ConversionProviderError && error.code === 'ENGINE_UNAVAILABLE' && !error.message.includes('private'));
});
