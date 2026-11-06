import { PgBoss } from 'pg-boss';
import { accountQuery as query, currentAccountId } from '../db';
import type { Source } from '../../shared/contracts';
import { CollectorError } from './network';
import { SOURCE_PRESETS, sourcePreset } from './domain';

export { growth, SOURCE_PRESETS } from './domain';
export { validateSource, collectSource } from './collect';
export { cleanupTrash } from './storage';

export const QUEUES = { source: 'hub-source-sync', tick: 'hub-tick', cleanup: 'hub-cleanup' } as const;
const shared = globalThis as typeof globalThis & { collectorBoss?: Promise<PgBoss> };

export async function getBoss(worker = false): Promise<PgBoss> {
  if (!shared.collectorBoss) {
    shared.collectorBoss = (async () => {
      if (!process.env.DATABASE_URL) throw new CollectorError('缺少数据库配置');
      // The administrator migration creates the schema. Workers may own objects
      // inside it, but do not need database-wide CREATE privileges.
      const boss = new PgBoss({ connectionString: process.env.DATABASE_URL, migrate: worker, createSchema: false, schedule: worker, supervise: worker });
      boss.on('error', () => console.error('任务队列异常，请检查数据库连接和 worker 状态'));
      await boss.start();
      if (worker) {
        await boss.createQueue(QUEUES.source, { policy: 'exclusive', retryLimit: 2, retryDelay: 900, retryBackoff: true, expireInSeconds: 900, heartbeatSeconds: 30 });
        await boss.createQueue(QUEUES.tick, { policy: 'exclusive', retryLimit: 2, retryDelay: 60, expireInSeconds: 300 });
        await boss.createQueue(QUEUES.cleanup, { policy: 'exclusive', retryLimit: 2, retryDelay: 300, expireInSeconds: 600 });
      }
      return boss;
    })().catch((error: unknown) => { shared.collectorBoss = undefined; throw error; });
  }
  return shared.collectorBoss;
}

export async function ensureSources(): Promise<void> {
  for (const source of SOURCE_PRESETS) {
    await query(`INSERT INTO sources(id,name,kind,url,enabled,interval_minutes,config)
      VALUES($1,$2,$3,$4,false,$5,$6) ON CONFLICT(owner_id,id) DO NOTHING`,
    [source.id, source.name, source.kind, source.url, source.interval, JSON.stringify(source.config)]);
  }
}

export async function enqueueSource(id: string): Promise<void> {
  sourcePreset(id);
  const source = (await query<Source>('SELECT * FROM sources WHERE id=$1', [id]))[0];
  if (!source?.enabled) throw new CollectorError('请先启用并验证该来源');
  const boss = await getBoss();
  const pending = await query(`SELECT id FROM pgboss.job WHERE name=$1 AND singleton_key=$2
    AND state IN ('created','retry','active') LIMIT 1`, [QUEUES.source, `${currentAccountId()}:${id}`]);
  if (pending.length) return;
  const runtime = (await query<{ value: { retryAt?: string } }>('SELECT value FROM account_settings WHERE key=$1', [`collector:${id}`]))[0]?.value;
  if (runtime?.retryAt && Date.parse(runtime.retryAt) > Date.now()) throw new CollectorError('来源仍在退避或限流等待中，请按计划时间重试', new Date(runtime.retryAt));
  if (source.last_attempt && Date.now() - new Date(source.last_attempt).getTime() < 60_000) {
    throw new CollectorError('来源刚刚同步，请至少等待一分钟再重试', new Date(new Date(source.last_attempt).getTime() + 60_000));
  }
  // Exclusive queue + singletonKey deduplicates both queued and active requests.
  const jobId = await boss.send(QUEUES.source, { accountId: currentAccountId(), sourceId: id }, { singletonKey: `${currentAccountId()}:${id}` });
  if (jobId) await query(`UPDATE sources SET coverage=COALESCE(coverage,'同步已进入持久任务队列，等待后台执行') WHERE id=$1`, [id]);
}

export async function enqueueDueSources(): Promise<void> {
  const sources = await query<Source>('SELECT * FROM sources WHERE enabled=true AND (next_run IS NULL OR next_run<=now()) ORDER BY id');
  for (const source of sources) {
    try { await enqueueSource(source.id); }
    catch (error) { if (!(error instanceof CollectorError)) throw error; }
  }
}
