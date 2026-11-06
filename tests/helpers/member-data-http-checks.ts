import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DriveListing, DriveUpload } from '../../src/shared/drive-contracts';
import type { MemberAccount } from '../../src/shared/accounts-contracts';
import type { HubData, HubEvent } from '../../src/shared/contracts';
import type { ConversionJob, ConversionUpload } from '../../src/shared/conversion-contracts';

type PostAuth = (jar: string, path: string, body: object, origin?: string) => Promise<{ status: number; data: Record<string, unknown>; headers: Headers }>;
type AuthenticatedRequest = (path: string, jar?: string, method?: string, body?: unknown, origin?: string) => Request;

export async function verifyMemberHttpIsolation(memberId: string, cookieHeaders: (jar: string) => Headers, postAuth: PostAuth) {
  const accounts = await import('../../src/app/api/accounts/route');
  const hub = await import('../../src/app/api/hub/route');
  const exportsRoute = await import('../../src/app/api/hub/export/route');
  const driveList = await import('../../src/app/api/drive/route');
  const uploads = await import('../../src/app/api/drive/uploads/route');
  const parts = await import('../../src/app/api/drive/uploads/[id]/parts/[index]/route');
  const complete = await import('../../src/app/api/drive/uploads/[id]/complete/route');
  const files = await import('../../src/app/api/drive/files/[id]/route');
  const authorizeDownload = await import('../../src/app/api/drive/authorize-download/route');
  const { downloadResponse } = await import('../../src/server/drive/content');
  const game = await import('../../src/app/api/tools/shattered-pixel-dungeon/save/route');
  const { withAccountScope } = await import('../../src/server/db');
  const { processPendingExports } = await import('../../src/server/exports');
  const request = (path: string, jar = 'member', method = 'GET', body?: unknown, origin = process.env.APP_URL!) => {
    const headers = cookieHeaders(jar);
    headers.set('origin', origin);
    headers.set('content-type', 'application/json');
    return new Request(`${process.env.APP_URL}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  };
  const password = 'Synthetic-second-member-password';
  const created = await accounts.POST(request('/api/accounts', 'a', 'POST', { username: 'second_member', password }));
  assert.equal(created.status, 201);
  const secondId = (await created.json() as { account: MemberAccount }).account.id;
  assert.equal((await postAuth('second-member', '/sign-in/username', { username: 'second_member', password })).status, 200);

  const createEvent = async (jar: string, title: string) => {
    const response = await hub.POST(request('/api/hub', jar, 'POST', { action: 'create', title, summary: '合成隔离测试', kind: 'model', url: 'https://example.test/isolated-same-url', tags: [], note: `${title} private note` }));
    assert.equal(response.status, 200, await response.clone().text());
    return (await response.json() as { event: HubEvent }).event;
  };
  const firstEvent = await createEvent('member', '成员甲资料');
  const secondEvent = await createEvent('second-member', '成员乙资料');
  assert.notEqual(firstEvent.id, secondEvent.id);
  const firstList = await hub.GET(request('/api/hub'));
  assert.equal(firstList.status, 200);
  const firstData = await firstList.json() as HubData;
  assert.equal(firstData.total, 1);
  assert.equal(firstData.events[0].id, firstEvent.id);
  assert(firstData.sources.length > 0);
  assert(firstData.sources.every((source) => source.enabled === false));
  for (const jar of ['second-member', 'a']) {
    assert.equal((await hub.GET(request(`/api/hub?id=${firstEvent.id}`, jar))).status, 404);
    assert.equal((await hub.POST(request('/api/hub', jar, 'POST', { action: 'update', id: firstEvent.id, revision: firstEvent.revision, patch: { title: 'forbidden edit' } }))).status, 404);
  }
  assert.equal((await hub.POST(request('/api/hub', 'member', 'POST', { action: 'update', id: firstEvent.id, revision: firstEvent.revision, patch: { title: '成员甲自己的修改' } }))).status, 200);
  const ownerList = await hub.GET(request('/api/hub', 'a'));
  assert.equal((await ownerList.json() as HubData).total, 0);

  const bytes = Buffer.from('Synthetic independent member file');
  const digest = createHash('sha256').update(bytes).digest('hex');
  const upload = async (jar: string) => {
    const response = await uploads.POST(request('/api/drive/uploads', jar, 'POST', { name: '相同文件名.bin', size: bytes.length, lastModified: 0, fingerprint: digest }));
    assert.equal(response.status, 200, await response.clone().text());
    const file = (await response.json() as DriveUpload).file;
    const headers = cookieHeaders(jar);
    headers.set('origin', process.env.APP_URL!);
    headers.set('content-type', 'application/octet-stream');
    headers.set('x-chunk-sha256', digest);
    const put = new Request(`${process.env.APP_URL}/api/drive/uploads/${file.id}/parts/0`, { method: 'PUT', headers, body: bytes });
    assert.equal((await parts.PUT(put, { params: Promise.resolve({ id: file.id, index: '0' }) })).status, 200);
    assert.equal((await complete.POST(request(`/api/drive/uploads/${file.id}/complete`, jar, 'POST', {}), { params: Promise.resolve({ id: file.id }) })).status, 200);
    return file.id;
  };
  const firstFileId = await upload('member');
  const secondFileId = await upload('second-member');
  assert.notEqual(firstFileId, secondFileId);
  const firstFiles = await driveList.GET(request('/api/drive'));
  const listing = await firstFiles.json() as DriveListing;
  assert.equal(listing.files.length, 1);
  assert.equal(listing.files[0].id, firstFileId);
  assert.equal(listing.capacity.usedBytes, bytes.length);
  assert.equal((await (await driveList.GET(request('/api/drive', 'a'))).json() as DriveListing).files.length, 0);
  assert.deepEqual(Buffer.from(await (await downloadResponse(request(`/api/drive/files/${firstFileId}/content`), firstFileId)).arrayBuffer()), bytes);
  for (const jar of ['second-member', 'a']) {
    const context = { params: Promise.resolve({ id: firstFileId }) };
    assert.equal((await files.GET(request(`/api/drive/files/${firstFileId}`, jar), context)).status, 404);
    assert.equal((await files.POST(request(`/api/drive/files/${firstFileId}`, jar, 'POST', { action: 'rename', name: 'forbidden.bin' }), context)).status, 404);
    assert.equal((await downloadResponse(request(`/api/drive/files/${firstFileId}/content`, jar), firstFileId)).status, 404);
    assert.equal((await downloadResponse(request(`/api/drive/files/${firstFileId}/content`, jar, 'HEAD'), firstFileId)).status, 404);
  }
  const proxy = request('/api/drive/authorize-download');
  proxy.headers.set('x-forwarded-uri', `/api/drive/files/${firstFileId}/content`);
  proxy.headers.set('x-forwarded-method', 'GET');
  assert.equal((await authorizeDownload.GET(proxy)).headers.get('x-drive-storage-key'), `${firstFileId}.bin`);
  const crossProxy = request('/api/drive/authorize-download', 'second-member');
  crossProxy.headers.set('x-forwarded-uri', `/api/drive/files/${firstFileId}/content`);
  crossProxy.headers.set('x-forwarded-method', 'GET');
  assert.equal((await authorizeDownload.GET(crossProxy)).status, 404);

  const gamePath = '/api/tools/shattered-pixel-dungeon/save';
  assert.equal((await game.GET(request(gamePath, 'anonymous'))).status, 401);
  const empty = await (await game.GET(request(gamePath))).json();
  assert.equal(empty.scope, memberId);
  assert.equal(empty.snapshot, null);
  const snapshot = { formatVersion: 1, files: [], prefs: { syntheticOwner: 'member-A' } };
  assert.equal((await game.PUT(request(gamePath, 'member', 'PUT', { scope: secondId, revision: 0, snapshot }))).status, 409);
  assert.equal((await game.PUT(request(gamePath, 'member', 'PUT', { scope: memberId, revision: 0, snapshot }, 'https://attacker.example'))).status, 403);
  assert.equal((await game.PUT(request(gamePath, 'member', 'PUT', { scope: memberId, revision: 0, snapshot }))).status, 200);
  assert.equal((await game.PUT(request(gamePath, 'member', 'PUT', { scope: memberId, revision: 0, snapshot }))).status, 409);
  const other = await (await game.GET(request(`${gamePath}?scope=${memberId}`, 'second-member'))).json();
  assert.equal(other.scope, secondId);
  assert.equal(other.snapshot, null);
  assert.equal((await game.PUT(request(gamePath, 'second-member', 'PUT', { scope: secondId, revision: 0, snapshot: { ...snapshot, prefs: { syntheticOwner: 'member-B' } } }))).status, 200);
  const saved = await (await game.GET(request(gamePath))).json();
  assert.deepEqual(saved.snapshot, snapshot);
  assert.equal(saved.revision, 1);

  const exportJob = await hub.POST(request('/api/hub', 'member', 'POST', { action: 'export' }));
  assert.equal(exportJob.status, 200);
  const exportId = (await exportJob.json()).id as string;
  await withAccountScope(memberId, processPendingExports);
  const downloaded = await exportsRoute.GET(request(`/api/hub/export?id=${exportId}`));
  assert.equal(downloaded.status, 200);
  const document = await downloaded.json();
  assert.equal(document.events.length, 1);
  assert.equal(document.events[0].id, firstEvent.id);
  assert.equal(document.driveFiles.length, 1);
  assert.equal(document.driveFiles[0].id, firstFileId);
  assert.equal(document.gameSaves.length, 1);
  assert.deepEqual(document.gameSaves[0].snapshot, snapshot);
  for (const jar of ['second-member', 'a']) {
    assert.equal((await exportsRoute.GET(request(`/api/hub/export?id=${exportId}`, jar))).status, 404);
    assert.deepEqual((await (await hub.GET(request('/api/hub?exports=1', jar))).json()).exports, []);
  }
  await verifyConversionHttpIsolation(cookieHeaders, request);
}

async function verifyConversionHttpIsolation(cookieHeaders: (jar: string) => Headers, request: AuthenticatedRequest) {
  const listingRoute = await import('../../src/app/api/tools/conversion/route');
  const createUploadRoute = await import('../../src/app/api/tools/conversion/uploads/route');
  const uploadRoute = await import('../../src/app/api/tools/conversion/uploads/[id]/route');
  const contentRoute = await import('../../src/app/api/tools/conversion/uploads/[id]/content/route');
  const createJobRoute = await import('../../src/app/api/tools/conversion/jobs/route');
  const jobRoute = await import('../../src/app/api/tools/conversion/jobs/[id]/route');
  const outputRoute = await import('../../src/app/api/tools/conversion/outputs/[id]/route');
  const { requireUser } = await import('../../src/server/authorize');
  const { accountQuery, withAccountScope } = await import('../../src/server/db');
  const { jobDirectory } = await import('../../src/server/conversion/files');
  const root = await mkdtemp(join(tmpdir(), 'hulinger-auth-conversion-'));
  const environment = new Map(['CONVERTX_URL', 'TRANSMUTE_URL', 'TRANSMUTE_API_KEY', 'STIRLING_PDF_URL', 'NCMDUMP_URL', 'CONVERSION_STORAGE_PATH', 'CONVERSION_RESERVE_BYTES', 'CONVERSION_MAX_INPUT_BYTES', 'CONVERSION_ACCOUNT_QUOTA_BYTES'].map((key) => [key, process.env[key]]));
  let unexpectedEngineCalls = 0;
  // This is a simulated readiness probe only. These authorization checks never run a converter.
  const engine = createServer((incoming, response) => {
    if (incoming.method === 'GET' && incoming.url === '/health') {
      response.writeHead(200, { 'Content-Type': 'application/json' }); response.end('{"status":"ok"}');
    } else { unexpectedEngineCalls++; response.writeHead(404); response.end(); }
  });
  try {
    await new Promise<void>((resolve) => engine.listen(0, '127.0.0.1', resolve));
    const address = engine.address();
    assert.ok(address && typeof address !== 'string');
    Object.assign(process.env, {
      CONVERTX_URL: '', TRANSMUTE_URL: '', TRANSMUTE_API_KEY: '', STIRLING_PDF_URL: '', NCMDUMP_URL: `http://127.0.0.1:${address.port}`,
      CONVERSION_STORAGE_PATH: root, CONVERSION_RESERVE_BYTES: '0', CONVERSION_MAX_INPUT_BYTES: '1024', CONVERSION_ACCOUNT_QUOTA_BYTES: '4096',
    });
    const base = '/api/tools/conversion';
    const bytes = Buffer.from('Synthetic authorization fixture; not a real NCM file');
    const inputs: { jar: string; accountId: string; uploadId: string; jobId: string; outputId: string }[] = [];
    const putRequest = (id: string, jar: string) => {
      const headers = cookieHeaders(jar);
      headers.set('origin', process.env.APP_URL!); headers.set('content-type', 'application/octet-stream');
      return new Request(`${process.env.APP_URL}${base}/uploads/${id}/content`, { method: 'PUT', headers, body: bytes });
    };
    for (const jar of ['member', 'second-member', 'a']) {
      const accountId = (await requireUser(cookieHeaders(jar))).id;
      const uploaded = await createUploadRoute.POST(request(`${base}/uploads`, jar, 'POST', { name: '同名权限样例.ncm', bytes: bytes.length }));
      assert.equal(uploaded.status, 201, await uploaded.clone().text());
      const upload = (await uploaded.json() as { upload: ConversionUpload }).upload;
      assert.equal((await contentRoute.PUT(putRequest(upload.id, jar), { params: Promise.resolve({ id: upload.id }) })).status, 200);
      const created = await createJobRoute.POST(request(`${base}/jobs`, jar, 'POST', { uploadId: upload.id, targetFormat: 'audio', engine: 'ncmdump' }));
      assert.equal(created.status, 201, await created.clone().text());
      const job = (await created.json() as { job: ConversionJob }).job;
      assert.equal(job.state, 'queued');
      inputs.push({ jar, accountId, uploadId: upload.id, jobId: job.id, outputId: randomUUID() });
    }
    assert.equal(new Set(inputs.map((input) => input.uploadId)).size, 3);
    for (const input of inputs) {
      const listed = await listingRoute.GET(request(base, input.jar));
      assert.equal(listed.status, 200);
      const data = await listed.json() as { uploads: ConversionUpload[]; jobs: ConversionJob[] };
      assert.deepEqual(data.uploads.map((upload) => upload.id), [input.uploadId]);
      assert.deepEqual(data.jobs.map((job) => job.id), [input.jobId]);
      for (const foreign of inputs.filter((other) => other.jar !== input.jar)) {
        const uploadContext = { params: Promise.resolve({ id: input.uploadId }) };
        const jobContext = { params: Promise.resolve({ id: input.jobId }) };
        assert.equal((await contentRoute.PUT(putRequest(input.uploadId, foreign.jar), uploadContext)).status, 404);
        assert.equal((await createJobRoute.POST(request(`${base}/jobs`, foreign.jar, 'POST', { uploadId: input.uploadId, targetFormat: 'audio', engine: 'ncmdump' }))).status, 404);
        assert.equal((await uploadRoute.DELETE(request(`${base}/uploads/${input.uploadId}`, foreign.jar, 'DELETE'), uploadContext)).status, 404);
        assert.equal((await jobRoute.GET(request(`${base}/jobs/${input.jobId}`, foreign.jar), jobContext)).status, 404);
        assert.equal((await jobRoute.PATCH(request(`${base}/jobs/${input.jobId}`, foreign.jar, 'PATCH', { action: 'cancel' }), jobContext)).status, 404);
        assert.equal((await jobRoute.DELETE(request(`${base}/jobs/${input.jobId}`, foreign.jar, 'DELETE'), jobContext)).status, 404);
      }
      const own = await jobRoute.GET(request(`${base}/jobs/${input.jobId}`, input.jar), { params: Promise.resolve({ id: input.jobId }) });
      assert.equal(own.status, 200);
      assert.equal((await own.json() as { job: ConversionJob }).job.state, 'queued', 'foreign cancel/delete must not change the job');
    }
    // Seed explicit synthetic output bytes to exercise the real HTTP authorization and download path.
    // Converter execution and file-format validity are verified by separate integration tests.
    const outputBytes = Buffer.from('Synthetic output for HTTP account isolation');
    for (const input of inputs) {
      const storageName = randomUUID();
      await writeFile(join(await jobDirectory(input.jobId, true), storageName), outputBytes);
      await withAccountScope(input.accountId, async () => {
        await accountQuery("UPDATE conversion_jobs SET state='succeeded',finished_at=now() WHERE id=$1", [input.jobId]);
        await accountQuery('INSERT INTO conversion_outputs(id,job_id,name,storage_name,mime,bytes) VALUES($1,$2,$3,$4,$5,$6)', [input.outputId, input.jobId, '合成结果.txt', storageName, 'text/plain', outputBytes.length]);
      });
    }
    for (const input of inputs) {
      const outputPath = `${base}/outputs/${input.outputId}`;
      const outputContext = { params: Promise.resolve({ id: input.outputId }) };
      const own = await outputRoute.GET(request(outputPath, input.jar), outputContext);
      assert.equal(own.status, 200);
      assert.deepEqual(Buffer.from(await own.arrayBuffer()), outputBytes);
      assert.equal((await outputRoute.HEAD(request(outputPath, input.jar, 'HEAD'), outputContext)).status, 200);
      for (const foreign of inputs.filter((other) => other.jar !== input.jar)) {
        assert.equal((await outputRoute.GET(request(outputPath, foreign.jar), outputContext)).status, 404);
        assert.equal((await outputRoute.HEAD(request(outputPath, foreign.jar, 'HEAD'), outputContext)).status, 404);
        assert.equal((await jobRoute.DELETE(request(`${base}/jobs/${input.jobId}`, foreign.jar, 'DELETE'), { params: Promise.resolve({ id: input.jobId }) })).status, 404);
        assert.equal((await uploadRoute.DELETE(request(`${base}/uploads/${input.uploadId}`, foreign.jar, 'DELETE'), { params: Promise.resolve({ id: input.uploadId }) })).status, 404);
      }
      assert.equal((await outputRoute.HEAD(request(outputPath, input.jar, 'HEAD'), outputContext)).status, 200, 'foreign cleanup must preserve the output');
    }
    for (const input of inputs) {
      assert.equal((await uploadRoute.DELETE(request(`${base}/uploads/${input.uploadId}`, input.jar, 'DELETE'), { params: Promise.resolve({ id: input.uploadId }) })).status, 200);
      const listed = await listingRoute.GET(request(base, input.jar));
      assert.deepEqual(await listed.json(), { uploads: [], jobs: [] });
    }
    assert.equal(unexpectedEngineCalls, 0, 'the simulated engine must only serve readiness checks');
  } finally {
    for (const [key, value] of environment) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    if (engine.listening) await new Promise<void>((resolve, reject) => engine.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
}
