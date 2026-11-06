import { randomUUID, createHash } from 'node:crypto';
import { accountQuery as query, accountTransaction as transaction } from '../db';
import type { Source, Entity } from '../../shared/contracts';
import { CollectorError, safeFetch } from './network';
import { githubConfig, growth, parseFeed, plainText, publicLink, sourcePreset, type CollectedItem, type Snapshot } from './domain';
import { persistItem } from './storage';

interface Cursor {
  since?: string; etag?: string; offset?: number; feedSignature?: string; parserVersion?: number;
  repos?: string[]; repositoryIndex?: number; releasePage?: number;
  scope?: string; totalMatches?: number; incomplete?: boolean; retryAt?: string;
  failures?: { repository: string; message: string }[];
}
interface Counts { added: number; updated: number; skipped: number }
interface CollectionResult { complete: boolean; coverage: string; counts: Counts; warning?: string }
interface Repository {
  id: number; full_name: string; name: string; html_url: string; description: string | null;
  stargazers_count: number; forks_count: number; language: string | null; topics?: string[];
  license: { spdx_id: string } | null; created_at: string; archived: boolean; private: boolean;
}
interface Release { id: number; name: string; tag_name: string; html_url: string; body: string; published_at: string | null; created_at: string; prerelease: boolean; draft: boolean }

function counter(): Counts { return { added: 0, updated: 0, skipped: 0 }; }
async function cursorFor(sourceId: string): Promise<Cursor> {
  return (await query<{ value: Cursor }>('SELECT value FROM account_settings WHERE key=$1', [`collector:${sourceId}`]))[0]?.value ?? {};
}
async function saveCursor(sourceId: string, value: Cursor): Promise<void> {
  await query(`INSERT INTO account_settings(key,value) VALUES($1,$2) ON CONFLICT(owner_id,key) DO UPDATE SET value=EXCLUDED.value`, [`collector:${sourceId}`, JSON.stringify(value)]);
}
function githubUrl(path: string, params: Record<string, string> = {}): string {
  const url = new URL(path, 'https://api.github.com');
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.href;
}
async function githubJson<T>(path: string, params: Record<string, string> = {}): Promise<T> {
  const response = await safeFetch(githubUrl(path, params));
  try { return JSON.parse(response.body) as T; } catch { throw new CollectorError('GitHub 返回无法解析的数据'); }
}
function repositoryName(value: unknown): value is string { return typeof value === 'string' && /^[\w.-]+\/[\w.-]+$/u.test(value); }
function validateRepository(repo: Repository): void {
  if (!Number.isSafeInteger(repo.id) || !repositoryName(repo.full_name) || !Number.isSafeInteger(repo.stargazers_count) || repo.stargazers_count < 0 || repo.private || !publicLink(repo.html_url)) {
    throw new CollectorError('GitHub 仓库记录无效或不是公开仓库');
  }
}

export async function validateSource(id: string, config: Record<string, unknown> = {}): Promise<void> {
  const preset = sourcePreset(id);
  if (preset.kind === 'github') {
    const settings = githubConfig(config);
    const result = await githubJson<{ items: Repository[] }>('/search/repositories', { q: `topic:${settings.topic} archived:false is:public`, sort: 'stars', order: 'desc', per_page: '1', page: '1' });
    if (!Array.isArray(result.items)) throw new CollectorError('GitHub 搜索返回无效数据');
    result.items.forEach(validateRepository);
  } else {
    if (Object.keys(config).length) throw new CollectorError('该公告来源不接受自定义采集参数');
    const response = await safeFetch(preset.url);
    await parseFeed(id, response.body);
  }
}

async function collectFeed(source: Source, cursor: Cursor, counts: Counts): Promise<CollectionResult> {
  const parserVersion = 1;
  const response = await safeFetch(sourcePreset(source.id).url, { etag: cursor.offset || cursor.parserVersion !== parserVersion ? undefined : cursor.etag });
  if (response.notModified) return { complete: true, coverage: '订阅未修改；保留此前覆盖范围，不代表全站没有更新', counts };
  const all = await parseFeed(source.id, response.body);
  const eligible = all.filter((item) => !item.publishedAt || Date.parse(item.publishedAt) >= Date.parse(cursor.since!));
  // Replaying a page is harmless; retain the cursor until the whole accessible feed is processed.
  const signature = createHash('sha256').update(JSON.stringify(eligible.map((item) => item.externalId))).digest('hex');
  const offset = cursor.feedSignature === signature ? cursor.offset ?? 0 : 0;
  const batch = eligible.slice(offset, offset + 100);
  for (const item of batch) counts[await persistItem(source, item)] += 1;
  const complete = offset + batch.length >= eligible.length;
  await saveCursor(source.id, { ...cursor, parserVersion, feedSignature: signature, offset: complete ? 0 : offset + batch.length, etag: complete ? response.etag ?? undefined : undefined });
  const oldest = all.map((item) => item.publishedAt).filter((date): date is string => Boolean(date)).sort()[0];
  return {
    complete, counts,
    coverage: `本次处理 ${batch.length} 条；订阅当前提供 ${all.length} 条，起始窗口内 ${eligible.length} 条。${complete ? '本轮可取得条目已处理' : `尚待处理 ${eligible.length - offset - batch.length} 条，下一批继续`}。${oldest ? `来源最早可见日期 ${oldest.slice(0, 10)}` : '来源时间未知'}；来源未提供的历史不能追回。`,
  };
}

async function prepareRepositories(source: Source, cursor: Cursor): Promise<Cursor> {
  const config = githubConfig(source.config);
  const found = await githubJson<{ total_count: number; incomplete_results: boolean; items: Repository[] }>('/search/repositories', {
    q: `topic:${config.topic} archived:false is:public`, sort: 'stars', order: 'desc', per_page: '100', page: '1',
  });
  if (!Array.isArray(found.items)) throw new CollectorError('GitHub 搜索返回无效数据');
  found.items.forEach(validateRepository);
  const followed = await query<Entity>(`SELECT * FROM entities WHERE kind='project' AND followed=true ORDER BY id`);
  const currentNames = new Map(found.items.map((item) => [item.id, item.full_name]));
  const names = followed.map((entity) => currentNames.get(Number(entity.data.repositoryId)) ?? entity.data.fullName).filter(repositoryName);
  if (names.length > 100) throw new CollectorError('已关注仓库超过 100 个，请先调整关注范围');
  const selected = [...new Set([...names, ...found.items.map((item) => item.full_name)])].slice(0, 100);
  const next = { ...cursor, repos: selected, repositoryIndex: 0, releasePage: 1, failures: [], scope: `topic:${config.topic}；累计 Star 排序候选与本人关注；观测上限 100`, totalMatches: found.total_count, incomplete: found.incomplete_results || found.total_count > found.items.length };
  await query(`UPDATE entities SET data=data || '{"sampled":false}'::jsonb WHERE kind='project' AND data->>'sourceId'=$1`, [source.id]);
  await saveCursor(source.id, next);
  return next;
}

async function updateRepository(repo: Repository, source: Source, cursor: Cursor): Promise<string> {
  validateRepository(repo);
  const entityId = `github-${repo.id}`;
  const observedAt = new Date().toISOString();
  await transaction(async (client) => {
    const data = {
      repositoryId: repo.id, fullName: repo.full_name, description: plainText(repo.description, 800), language: repo.language,
      license: repo.license?.spdx_id ?? null, topics: (repo.topics ?? []).slice(0, 20), stars: repo.stargazers_count,
      forks: repo.forks_count, observedAt, createdAt: repo.created_at, firstDiscoveredAt: observedAt, archived: repo.archived,
      sourceId: source.id, sourceUpdatedAt: observedAt, scope: cursor.scope, sampled: true, collectionError: null,
    };
    await client.query(`INSERT INTO entities(id,kind,name,url,data) VALUES($1,'project',$2,$3,$4)
      ON CONFLICT(owner_id,id) DO UPDATE SET name=EXCLUDED.name,url=EXCLUDED.url,
      data=entities.data || EXCLUDED.data || jsonb_build_object('firstDiscoveredAt',COALESCE(entities.data->'firstDiscoveredAt',EXCLUDED.data->'firstDiscoveredAt')),
      revision=entities.revision+1`,
    [entityId, repo.full_name, repo.html_url, JSON.stringify(data)]);
    await client.query('INSERT INTO snapshots(entity_id,observed_at,stars) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [entityId, observedAt, repo.stargazers_count]);
    const snapshots = (await client.query<Snapshot>(`SELECT observed_at,stars FROM snapshots WHERE entity_id=$1
      AND observed_at >= now()-interval '9 days' ORDER BY observed_at DESC`, [entityId])).rows;
    await client.query('UPDATE entities SET data=data || $2::jsonb WHERE id=$1', [entityId, JSON.stringify({ growth24h: growth(snapshots, 24), growth7d: growth(snapshots, 168) })]);
  });
  return entityId;
}

async function collectGithub(source: Source, initial: Cursor, counts: Counts): Promise<CollectionResult> {
  const config = githubConfig(source.config);
  const cursor = initial.repos ? initial : await prepareRepositories(source, initial);
  const repos = cursor.repos!;
  let index = cursor.repositoryIndex ?? 0;
  let page = cursor.releasePage ?? 1;
  let processed = 0;
  // Ten repo/release pages per attempt bounds request count and duration. Cursor
  // survives rate limits and process restarts; followed repositories are first.
  while (index < repos.length && processed < 10) {
    const name = repos[index];
    if (!repositoryName(name)) throw new CollectorError('待采集仓库名称无效');
    try {
    const repo = await githubJson<Repository>(`/repos/${name}`);
    const entityId = await updateRepository(repo, source, cursor);
    const discovered: CollectedItem = {
      externalId: `repository:${repo.id}:discovered`, title: `发现项目：${repo.full_name}`,
      summary: plainText(repo.description, 800), url: repo.html_url,
      publishedAt: null, precision: 'unknown', kind: 'project', tags: (repo.topics ?? []).slice(0, 10),
      entity: { id: entityId, kind: 'project', name: repo.full_name, url: repo.html_url, data: {} },
      data: { eventType: 'project-discovered', summaryKind: 'source', repositoryId: repo.id, repositoryCreatedAt: repo.created_at },
    };
    // Discovery is a stable event of our observation, not a claim that the
    // repository was created or released today. Its source publication is unknown.
    counts[await persistItem(source, discovered)] += 1;
    const releasePageSize = 30;
    const releases = await githubJson<Release[]>(`/repos/${repo.full_name}/releases`, { per_page: String(releasePageSize), page: String(page) });
    if (!Array.isArray(releases)) throw new CollectorError('GitHub Release 返回无效数据');
    const visible = releases.filter((release) => !release.draft && (config.includePrereleases || !release.prerelease));
    if (page === 1) {
      const latest = visible[0];
      await query('UPDATE entities SET data=data || $2::jsonb WHERE id=$1', [entityId, JSON.stringify({ latestRelease: latest ? {
        tag: plainText(latest.tag_name, 100), name: plainText(latest.name, 300), url: publicLink(latest.html_url), publishedAt: latest.published_at, prerelease: latest.prerelease,
      } : null })]);
    }
    for (const release of visible) {
      if (!Number.isSafeInteger(release.id) || !publicLink(release.html_url)) { counts.skipped += 1; continue; }
      const publishedAt = release.published_at && Number.isFinite(Date.parse(release.published_at)) ? new Date(release.published_at).toISOString() : null;
      if (publishedAt && Date.parse(publishedAt) < Date.parse(cursor.since!)) { counts.skipped += 1; continue; }
      const item: CollectedItem = {
        externalId: `release:${release.id}:${release.prerelease ? 'preview' : 'stable'}`,
        title: `${repo.full_name} · ${plainText(release.name || release.tag_name, 240)}${release.prerelease ? '（预发布）' : ''}`,
        summary: plainText(release.body, 1200), kind: 'project', url: release.html_url, publishedAt,
        precision: publishedAt ? 'instant' : 'unknown', tags: (repo.topics ?? []).slice(0, 10),
        entity: { id: entityId, kind: 'project', name: repo.full_name, url: repo.html_url, data: {} },
        data: { summaryKind: 'source', prerelease: release.prerelease, tag: release.tag_name, repositoryId: repo.id, historical: !source.last_success },
      };
      counts[await persistItem(source, item)] += 1;
    }
    // Do not infer complete time-window coverage from the last publication date
    // on a page: older-created releases may have been published more recently.
    if (releases.length < releasePageSize) { index += 1; page = 1; }
    else page += 1;
    } catch (error) {
      // A deleted/unavailable repository must not block all remaining projects.
      // Global quota exhaustion defers the batch without advancing its cursor.
      if (!(error instanceof CollectorError) || error.retryAt) throw error;
      cursor.failures = [...(cursor.failures ?? []), { repository: name, message: error.message }];
      await query(`UPDATE entities SET data=data || $2::jsonb WHERE data->>'fullName'=$1`, [name, JSON.stringify({ collectionError: error.message })]);
      index += 1;
      page = 1;
    }
    processed += 1;
    cursor.repositoryIndex = index;
    cursor.releasePage = page;
    await saveCursor(source.id, cursor);
  }
  const complete = index >= repos.length;
  if (complete) await saveCursor(source.id, { since: cursor.since, scope: cursor.scope, totalMatches: cursor.totalMatches, incomplete: cursor.incomplete });
  return {
    complete, counts,
    warning: cursor.failures?.length ? `${cursor.failures.length} 个仓库检查失败，其他结果已保留；下轮重试` : undefined,
    coverage: `${cursor.scope}；本轮已检查 ${index}/${repos.length} 个仓库${complete ? '' : `，当前版本页 ${page}，下一批继续`}。搜索匹配 ${cursor.totalMatches ?? '未知'} 个，${cursor.incomplete ? '为有限采样/部分结果' : '本次搜索结果已覆盖'}，不是全 GitHub 榜单。${cursor.failures?.length ? `失败：${cursor.failures.slice(0, 3).map((failure) => `${failure.repository}（${failure.message}）`).join('、')}` : ''}`,
  };
}

export async function collectSource(id: string): Promise<void> {
  sourcePreset(id);
  const source = (await query<Source>('SELECT * FROM sources WHERE id=$1', [id]))[0];
  if (!source?.enabled) return;
  const cursor = await cursorFor(id);
  if (cursor.retryAt && Date.parse(cursor.retryAt) > Date.now()) {
    await query('UPDATE sources SET next_run=$2 WHERE id=$1', [id, cursor.retryAt]);
    return;
  }
  delete cursor.retryAt;
  if (!cursor.since) cursor.since = new Date(Date.now() - 7 * 86_400_000).toISOString();
  await saveCursor(id, cursor);
  const runId = randomUUID();
  const counts = counter();
  await query(`INSERT INTO sync_runs(id,source_id,status) VALUES($1,$2,'running')`, [runId, id]);
  await query('UPDATE sources SET last_attempt=now(),error=NULL WHERE id=$1', [id]);
  try {
    const result = sourcePreset(id).kind === 'rss' ? await collectFeed(source, cursor, counts) : await collectGithub(source, cursor, counts);
    await query(`UPDATE sources SET last_success=CASE WHEN $2 THEN now() ELSE last_success END,
      next_run=now()+($3::integer * interval '1 minute'),coverage=$4,error=$5 WHERE id=$1`,
    [id, result.complete && !result.warning, result.complete ? (result.warning ? 15 : source.interval_minutes) : 1, result.coverage, result.warning ?? null]);
    await query(`UPDATE sync_runs SET status=$2,finished_at=now(),added=$3,updated=$4,skipped=$5,coverage=$6,error=$7 WHERE id=$1`,
      [runId, result.complete && !result.warning ? 'success' : 'partial', result.counts.added, result.counts.updated, result.counts.skipped, result.coverage, result.warning ?? null]);
  } catch (error) {
    const message = error instanceof CollectorError ? error.message : '采集失败，请查看脱敏运行记录并重试';
    const retryAt = error instanceof CollectorError && error.retryAt ? error.retryAt : new Date(Date.now() + 15 * 60_000);
    const saved = await cursorFor(id);
    await saveCursor(id, { ...saved, retryAt: retryAt.toISOString() });
    const coverage = saved.repos ? `已检查 ${saved.repositoryIndex ?? 0}/${saved.repos.length} 个仓库，当前版本页 ${saved.releasePage ?? 1}；持久进度已保留，恢复后继续。${saved.scope ?? ''}；有限采样，不是全 GitHub 榜单。` : source.coverage;
    await query('UPDATE sources SET error=$2,next_run=$3,coverage=COALESCE($4,coverage) WHERE id=$1', [id, message, retryAt, coverage]);
    await query(`UPDATE sync_runs SET status='failed',finished_at=now(),error=$2,added=$3,updated=$4,skipped=$5,coverage=$6 WHERE id=$1`, [runId, message, counts.added, counts.updated, counts.skipped, coverage]);
    // Record a safe error only: upstream response bodies can contain sensitive data.
    throw new CollectorError(message, retryAt);
  }
}
