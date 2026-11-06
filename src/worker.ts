import { pool, query, accountQuery, activeAccountIds, allAccountIds, withAccountScope } from './server/db';
import { processPendingExports, expireExports } from './server/exports';
import { collectSource, cleanupTrash, ensureSources, enqueueDueSources, getBoss, QUEUES } from './server/collector';
import { closeDrive, getDrive } from './server/drive/runtime';
import { startConversionWorker } from './server/conversion/runtime';
import { closeConversionConnections } from './server/conversion/connections';

async function main(): Promise<void> {
  await getDrive().checkStorage();
  const boss = await getBoss(true);
  const tick = async () => {
    await query(`INSERT INTO worker_heartbeats(id,seen_at) VALUES('collector',now()) ON CONFLICT(id) DO UPDATE SET seen_at=EXCLUDED.seen_at`);
    for (const id of await activeAccountIds()) await withAccountScope(id, async () => {
      await ensureSources();
      await enqueueDueSources();
      await processPendingExports();
    // A killed attempt must not leave a permanent "running" badge in the UI.
    await accountQuery(`UPDATE sync_runs SET status='interrupted',finished_at=now(),error='worker 中断，任务将从持久进度重试'
      WHERE status='running' AND started_at < now()-interval '20 minutes'`);
    });
  };
  await boss.work<{ accountId?: string; sourceId: string }>(QUEUES.source, { batchSize: 1, localConcurrency: 2, pollingIntervalSeconds: 2 }, async ([job]) => {
    // Legacy jobs lack identity and must never be attributed to an arbitrary account.
    const id=job.data.accountId;
    if (id && (await activeAccountIds()).includes(id)) await withAccountScope(id, () => collectSource(job.data.sourceId));
  });
  await boss.work(QUEUES.tick, async () => { await tick(); });
  await boss.work(QUEUES.cleanup, async () => {
    for (const id of await allAccountIds()) await withAccountScope(id, async () => { await cleanupTrash(); await expireExports(); });
    await getDrive().cleanup();
    await query("DELETE FROM login_events WHERE occurred_at<now()-interval '30 days'");
    await query("DELETE FROM account_management_events WHERE occurred_at<now()-interval '30 days'");
  });
  await boss.schedule(QUEUES.tick, '* * * * *', {}, { tz: 'UTC' });
  await boss.schedule(QUEUES.cleanup, '15 19 * * *', {}, { tz: 'UTC' });
  await tick();
  const conversions = startConversionWorker();
  console.log('Collector worker ready. Sources run only after owner enables them.');
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await conversions.stop();
    await closeConversionConnections();
    await boss.stop({ graceful: true, timeout: 30_000 });
    await closeDrive();
    await pool.end();
  };
  process.on('SIGTERM', () => { void stop().then(() => process.exit(0)); });
  process.on('SIGINT', () => { void stop().then(() => process.exit(0)); });
}

main().catch(async (error: unknown) => {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code).slice(0, 30) : 'unknown';
  console.error(`Collector worker failed to start (${code}). Check migrations and environment configuration.`);
  await pool.end();
  process.exit(1);
});
