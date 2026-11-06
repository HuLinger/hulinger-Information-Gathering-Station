import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import type { ConversionProvider } from '../src/server/conversion/provider-types';

const databaseURL = process.env.TEST_DATABASE_URL;
test('conversion persistence, account RLS, worker recovery, bounded upload and 24-hour cleanup', { skip: !databaseURL, timeout: 90_000 }, async () => {
  const cluster = new Pool({ connectionString: databaseURL, max: 1 });
  const name = `conversion_${randomUUID().replaceAll('-', '')}`;
  const adminURL = new URL(databaseURL!); adminURL.pathname = `/${name}`;
  await cluster.query(`CREATE DATABASE "${name}"`);
  const admin = new Pool({ connectionString: adminURL.href, max: 3 });
  const appName = `${name}_app`, workerName = `${name}_worker`;
  const appPassword = randomBytes(24).toString('hex'), workerPassword = randomBytes(24).toString('hex');
  const appURL = new URL(adminURL); appURL.username = appName; appURL.password = appPassword;
  const root = await mkdtemp(join(tmpdir(), 'hulinger-conversion-test-'));
  const fakeEngine = createServer((_req, response) => { response.setHeader('content-type', 'application/json'); response.end('{"status":"ok"}'); });
  await new Promise<void>(ready => fakeEngine.listen(0, '127.0.0.1', ready));
  const address = fakeEngine.address(); assert(address && typeof address === 'object');
  Object.assign(process.env, { DATABASE_URL: appURL.href, APP_URL: 'http://127.0.0.1:3000', BETTER_AUTH_SECRET: randomBytes(32).toString('hex'),
    NODE_ENV: 'test', CONVERSION_STORAGE_PATH: root, CONVERSION_RESERVE_BYTES: '0', CONVERSION_MAX_INPUT_BYTES: '100', CONVERSION_ACCOUNT_QUOTA_BYTES: '1000',
    CONVERTX_URL: '', TRANSMUTE_URL: '', STIRLING_PDF_URL: '', NCMDUMP_URL: `http://127.0.0.1:${address.port}` });
  const { pool, withAccountScope, accountQuery, query } = await import('../src/server/db');
  let worker: Pool | undefined;
  try {
    const { migrate } = await import('../scripts/migrate');
    await migrate(admin, { roles: { appName, workerName, appPassword, workerPassword } });
    await migrate(admin, { roles: { appName, workerName, appPassword, workerPassword } });
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    for (const id of ids) await admin.query('INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,$1,$2,true,now(),now())', [id, `${id}@example.test`]);
    await admin.query("INSERT INTO app_settings(key,value) VALUES('owner',$1)", [{ id: ids[0] }]);
    for (const id of ids.slice(1)) await admin.query('INSERT INTO member_accounts(user_id,created_by) VALUES($1,$2)', [id, ids[0]]);
    const service = await import('../src/server/conversion/service');
    const { processOneConversion, expireConversions } = await import('../src/server/conversion/runtime');
    const { inputPath } = await import('../src/server/conversion/files');
    const listingRoute = await import('../src/app/api/tools/conversion/route');
    assert.equal((await listingRoute.GET(new Request('http://127.0.0.1:3000/api/tools/conversion'))).status, 401);
    await assert.rejects(() => service.listConversions(), /Account context is required/);
    assert.deepEqual(await query('SELECT * FROM conversion_uploads'), []);
    const bytes = Buffer.from('synthetic-ncm-input');
    const uploadFor = (id: string) => withAccountScope(id, async () => {
      const upload = await service.createUpload({ name: '中文试音.ncm', bytes: bytes.length });
      await service.receiveUpload(upload.id, new Request('http://localhost/upload', { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: bytes }));
      return upload;
    });
    const first = await uploadFor(ids[1]), second = await uploadFor(ids[2]);
    assert.notEqual(first.id, second.id);
    await withAccountScope(ids[1], async () => {
      assert.equal((await service.listConversions()).uploads.length, 1);
      await assert.rejects(() => service.createUpload({ name: 'huge.ncm', bytes: 101 }), { status: 413 });
      const incomplete = await service.createUpload({ name: 'broken.ncm', bytes: 4 });
      await assert.rejects(() => service.receiveUpload(incomplete.id, new Request('http://localhost/upload', { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: Buffer.from('TOO LONG') })), { status: 413 });
      await assert.rejects(() => inputPath(incomplete.id).then(path => stat(path)), { code: 'ENOENT' });
      assert.equal((await service.getUpload(incomplete.id)).state, 'uploading');
      await service.deleteUpload(incomplete.id);
    });
    const job = await withAccountScope(ids[1], () => service.createJob({ uploadId: first.id, targetFormat: 'audio', engine: 'ncmdump' }));
    for (const id of [ids[0], ids[2]]) await withAccountScope(id, async () => {
      await assert.rejects(() => service.getUpload(first.id), { status: 404 });
      await assert.rejects(() => service.getJob(job.id), { status: 404 });
      await assert.rejects(() => service.deleteJob(job.id), { status: 404 });
      await assert.rejects(() => service.deleteUpload(first.id), { status: 404 });
      await assert.rejects(() => service.createJob({ uploadId: first.id, targetFormat: 'audio' }), { status: 404 });
      await assert.rejects(() => accountQuery('INSERT INTO conversion_jobs(id,upload_id,target_format,requested_engine,engine) VALUES($1,$2,\'audio\',\'auto\',\'ncmdump\')', [randomUUID(), first.id]), { code: '23503' });
    });
    const outputBytes = Buffer.from('ID3-synthetic-output');
    let calls = 0;
    const provider: ConversionProvider = {
      id: 'ncmdump', configured: true, health: async () => {}, options: async () => [],
      async convert(_input, _format, directory, context) {
        calls++;
        assert.equal(await processOneConversion({ providers: [provider] }), false, 'second worker cannot claim or recover an active job');
        await assert.rejects(() => service.deleteUpload(first.id), { status: 409 });
        await assert.rejects(() => service.deleteJob(job.id), { status: 409 });
        await context.onStage('合成引擎正在写入');
        await writeFile(join(directory, 'synthetic.mp3'), outputBytes);
        return [{ storageName: 'synthetic.mp3', name: '中文试音.mp3', mime: 'audio/mpeg', bytes: outputBytes.length }];
      },
    };
    assert.equal(await processOneConversion({ providers: [provider] }), true);
    assert.equal(calls, 1);
    const done = await withAccountScope(ids[1], () => service.getJob(job.id));
    assert.equal(done.state, 'succeeded'); assert.equal(done.outputs.length, 1);
    assert(Date.parse(done.expiresAt) - Date.parse(done.finishedAt!) >= 24 * 60 * 60_000 - 1000);
    await withAccountScope(ids[1], async () => {
      const response = await service.downloadOutput(done.outputs[0].id);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), outputBytes);
      assert.match(response.headers.get('content-disposition')!, /filename\*=UTF-8/);
      assert.equal(response.headers.get('cache-control'), 'private, no-store');
      const head = await service.downloadOutput(done.outputs[0].id, true); assert.equal(head.body, null);
      const cancel = await service.downloadOutput(done.outputs[0].id); await cancel.body!.cancel();
    });
    for (const id of [ids[0], ids[2]]) await withAccountScope(id, () => assert.rejects(() => service.downloadOutput(done.outputs[0].id), { status: 404 }));
    const interruptedId = await withAccountScope(ids[1], async () => {
      const cancelled = await service.createJob({ uploadId: first.id, targetFormat: 'audio' });
      await service.cancelJob(cancelled.id); assert.equal((await service.getJob(cancelled.id)).state, 'cancelled');
      const interrupted = await service.createJob({ uploadId: first.id, targetFormat: 'audio' });
      await accountQuery("UPDATE conversion_jobs SET state='running',started_at=now() WHERE id=$1", [interrupted.id]);
      return interrupted.id;
    });
    assert.equal(await processOneConversion({ providers: [provider] }), false);
    await withAccountScope(ids[1], async () => {
      assert.equal((await service.getJob(interruptedId)).state, 'failed');
      assert.match((await service.getJob(interruptedId)).error!, /中断/);
    });
    const disabledJob = await withAccountScope(ids[2], () => service.createJob({ uploadId: second.id, targetFormat: 'audio' }));
    await admin.query('UPDATE member_accounts SET disabled=true WHERE user_id=$1', [ids[2]]);
    assert.equal(await processOneConversion({ providers: [provider] }), false);
    assert.equal((await withAccountScope(ids[2], () => service.getJob(disabledJob.id))).state, 'queued');
    await admin.query('UPDATE member_accounts SET disabled=false WHERE user_id=$1', [ids[2]]);
    const badProvider: ConversionProvider = { ...provider, convert: async () => [{ storageName: 'missing', name: 'invalid.mp3', bytes: 4, mime: 'audio/mpeg' }] };
    assert.equal(await processOneConversion({ providers: [badProvider] }), true);
    await withAccountScope(ids[2], async () => { const jobs = (await service.listConversions()).jobs; assert.equal(jobs[0].state, 'failed'); assert.deepEqual(jobs[0].outputs, []); });
    const workerURL = new URL(adminURL); workerURL.username = workerName; workerURL.password = workerPassword;
    worker = new Pool({ connectionString: workerURL.href, max: 1 });
    assert.equal((await worker.query('SELECT * FROM conversion_jobs')).rowCount, 0);
    await worker.query('BEGIN'); await worker.query("SELECT set_config('hub.account_id',$1,true)", [ids[1]]);
    assert((await worker.query('SELECT * FROM conversion_jobs')).rowCount! > 0); await worker.query('ROLLBACK');
    await withAccountScope(ids[1], async () => {
      await accountQuery("UPDATE conversion_jobs SET expires_at=now()-interval '1 minute'");
      await accountQuery("UPDATE conversion_uploads SET expires_at=now()-interval '1 minute'");
      await assert.rejects(() => service.downloadOutput(done.outputs[0].id), { status: 404 });
      await expireConversions();
      assert.deepEqual(await service.listConversions(), { uploads: [], jobs: [] });
      await assert.rejects(() => inputPath(first.id).then(path => stat(path)), { code: 'ENOENT' });
    });
    assert.equal((await withAccountScope(ids[2], () => service.listConversions())).uploads.length, 1);
    assert.equal((await readdir(join(root, 'inputs'))).length, 1);
    await withAccountScope(ids[2], () => service.deleteUpload(second.id));
    assert.deepEqual(await readdir(join(root, 'inputs')), []);
    assert.deepEqual(await readdir(join(root, 'jobs')), []);

    // Ten unfinished bodies used to hold every shared DB connection and prevent
    // login/listing/finalization. Admission must be bounded independently.
    const waiting = await withAccountScope(ids[1], () => Promise.all(Array.from({ length: 10 }, () => service.createUpload({ name: '慢速.ncm', bytes: 19 }))));
    const controllers: ReadableStreamDefaultController<Uint8Array>[] = [];
    const attempts = waiting.map(upload => {
      const body = new ReadableStream<Uint8Array>({ start(controller) { controllers.push(controller); } });
      const request = new Request('http://localhost/upload', { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body, duplex: 'half' } as RequestInit);
      return withAccountScope(ids[1], () => service.receiveUpload(upload.id, request)).then(() => null, error => error as { status: number });
    });
    const heldLocks = async () => Number((await admin.query(`SELECT count(*) AS count FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid
      WHERE a.datname=$1 AND a.application_name='hulinger-conversion-upload-lock' AND l.locktype='advisory' AND l.granted`, [name])).rows[0].count);
    for (let index = 0; index < 100 && await heldLocks() < 4; index++) await delay(20);
    assert.equal(await heldLocks(), 4);
    const listing = await withAccountScope(ids[1], () => service.listConversions());
    assert.equal(listing.uploads.length, 10); assert(listing.uploads.every(upload => upload.state === 'uploading'));
    await delay(1100); // Let excess admissions fail while four bodies remain open.
    controllers.forEach(controller => controller.close());
    const outcomes = await Promise.all(attempts);
    assert.equal(outcomes.filter(error => error?.status === 429).length, 6);
    assert.equal(outcomes.filter(error => error?.status === 400).length, 4);
    await withAccountScope(ids[1], async () => { for (const upload of waiting) await service.deleteUpload(upload.id); });

    // Losing the session lock interrupts the stream instead of allowing an
    // unprotected writer to publish success or crashing the process.
    const lost = await withAccountScope(ids[1], () => service.createUpload({ name: '连接中断.ncm', bytes: bytes.length }));
    const heldRequest = new Request('http://localhost/upload', { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: new ReadableStream(), duplex: 'half' } as RequestInit);
    const lostAttempt = withAccountScope(ids[1], () => service.receiveUpload(lost.id, heldRequest)).then(() => null, error => error as { code: string });
    for (let index = 0; index < 100 && await heldLocks() < 1; index++) await delay(20);
    assert.equal(await heldLocks(), 1);
    await admin.query(`SELECT pg_terminate_backend(l.pid) FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid
      WHERE a.datname=$1 AND a.application_name='hulinger-conversion-upload-lock' AND l.locktype='advisory' AND l.granted`, [name]);
    assert.equal((await lostAttempt)?.code, 'UPLOAD_INTERRUPTED');
    await withAccountScope(ids[1], async () => {
      assert.equal((await service.getUpload(lost.id)).state, 'uploading');
      await service.receiveUpload(lost.id, new Request('http://localhost/upload', { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: bytes }));
      assert.equal((await service.getUpload(lost.id)).state, 'ready');
    });

    // A connection may disappear after the file is complete while the final
    // state UPDATE waits on another transaction. Losing the input lock must
    // also prevent that queued UPDATE from publishing an unprotected success.
    const publishing = await withAccountScope(ids[1], () => service.createUpload({ name: '提交中断.ncm', bytes: bytes.length }));
    const blocker = await admin.connect();
    let finalizing: Promise<{ upload?: Awaited<ReturnType<typeof service.receiveUpload>>; error?: { code: string } }> | undefined;
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT id FROM conversion_uploads WHERE id=$1 FOR UPDATE', [publishing.id]);
      finalizing = withAccountScope(ids[1], () => service.receiveUpload(publishing.id, new Request('http://localhost/upload', {
        method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: bytes,
      }))).then(upload => ({ upload }), error => ({ error }));
      const waitingToPublish = async () => Number((await admin.query(`SELECT count(*) AS count FROM pg_stat_activity
        WHERE datname=$1 AND wait_event_type='Lock' AND query LIKE 'UPDATE conversion_uploads SET state=%'`, [name])).rows[0].count);
      for (let index = 0; index < 100 && await waitingToPublish() < 1; index++) await delay(20);
      assert.equal(await waitingToPublish(), 1, 'final ready UPDATE is waiting on the controlled row lock');
      await admin.query(`SELECT pg_terminate_backend(l.pid) FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid
        WHERE a.datname=$1 AND a.application_name='hulinger-conversion-upload-lock' AND l.locktype='advisory' AND l.granted`, [name]);
      await delay(50);
      await blocker.query('ROLLBACK');
      const outcome = await finalizing;
      assert.equal(outcome.upload, undefined, 'a lost upload lock cannot report ready after finalization was queued');
      assert.equal(outcome.error?.code, 'UPLOAD_INTERRUPTED');
      await withAccountScope(ids[1], async () => {
        assert.equal((await service.getUpload(publishing.id)).state, 'uploading');
        await service.receiveUpload(publishing.id, new Request('http://localhost/upload', { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: bytes }));
        assert.equal((await service.getUpload(publishing.id)).state, 'ready');
        await service.deleteUpload(publishing.id);
      });
    } finally {
      await blocker.query('ROLLBACK').catch(() => {});
      blocker.release();
      await finalizing;
    }
    const abort = new AbortController();
    const aborted = await withAccountScope(ids[1], () => service.createJob({ uploadId: lost.id, targetFormat: 'audio' }));
    const aborting: ConversionProvider = { ...provider, async convert(_input, _format, directory, context) {
      await writeFile(join(directory, 'partial'), 'partial'); abort.abort(); context.signal.throwIfAborted(); return [];
    } };
    assert.equal(await processOneConversion({ providers: [aborting], signal: abort.signal }), true);
    await withAccountScope(ids[1], async () => {
      const result = await service.getJob(aborted.id); assert.equal(result.state, 'failed'); assert.deepEqual(result.outputs, []);
      assert.match(result.error!, /停止或超时/); await service.deleteUpload(lost.id);
    });
    assert.deepEqual(await readdir(join(root, 'inputs')), []); assert.deepEqual(await readdir(join(root, 'jobs')), []);
  } finally {
    await (await import('../src/server/conversion/connections')).closeConversionConnections();
    await worker?.end(); await pool.end(); await admin.end();
    await cluster.query(`DROP DATABASE "${name}"`);
    for (const role of [appName, workerName]) await cluster.query(`DROP ROLE IF EXISTS "${role}"`);
    await cluster.end();
    await new Promise<void>((done, reject) => fakeEngine.close(error => error ? reject(error) : done()));
    assert.equal(dirname(resolve(root)).toLowerCase(), resolve(tmpdir()).toLowerCase());
    await rm(root, { recursive: true, force: true });
  }
});
