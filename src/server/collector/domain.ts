import { createHash } from 'node:crypto';
import { load } from 'cheerio';
import Parser from 'rss-parser';
import type { Kind } from '../../shared/contracts';
import { CollectorError } from './network';

export const SOURCE_PRESETS = [
  { id: 'openai-news', name: 'OpenAI 官方公告', kind: 'rss', url: 'https://openai.com/news/rss.xml', interval: 60, config: {} },
  { id: 'claude-platform', name: 'Claude Platform 更新', kind: 'rss', url: 'https://platform.claude.com/docs/en/release-notes/feed.xml', interval: 60, config: {} },
  { id: 'microsoft-ai', name: 'Microsoft AI 官方动态', kind: 'rss', url: 'https://blogs.microsoft.com/blog/tag/ai/feed/', interval: 60, config: {} },
  { id: 'github-projects', name: 'GitHub AI 开源项目', kind: 'github', url: 'https://api.github.com/search/repositories', interval: 360, config: { topic: 'artificial-intelligence', includePrereleases: false } },
] as const;

export const TOPICS = ['artificial-intelligence', 'llm', 'machine-learning', 'generative-ai'] as const;
export type Snapshot = { observed_at: Date | string; stars: number };
export type Growth = { status: 'ok' | 'insufficient' | 'stale'; delta: number | null; startAt: string | null; endAt: string | null; hours: number | null };

export function growth(snapshots: Snapshot[], windowHours = 24, now: Date | number = Date.now(), intervalHours = 6): Growth {
  const points = snapshots.filter((p) => Number.isFinite(new Date(p.observed_at).getTime()) && Number.isInteger(p.stars) && p.stars >= 0)
    .sort((a, b) => new Date(b.observed_at).getTime() - new Date(a.observed_at).getTime());
  const end = points[0];
  const empty: Growth = { status: 'insufficient', delta: null, startAt: null, endAt: end ? new Date(end.observed_at).toISOString() : null, hours: null };
  if (!end || !Number.isFinite(windowHours) || windowHours <= 0) return empty;
  const endMs = new Date(end.observed_at).getTime();
  const target = endMs - windowHours * 3_600_000;
  const start = points.find((p) => new Date(p.observed_at).getTime() <= target);
  const stale = Number(now) - endMs > intervalHours * 2 * 3_600_000;
  if (!start || target - new Date(start.observed_at).getTime() > 6 * 3_600_000) return { ...empty, status: stale ? 'stale' : 'insufficient' };
  return { status: stale ? 'stale' : 'ok', delta: end.stars - start.stars, startAt: new Date(start.observed_at).toISOString(), endAt: new Date(end.observed_at).toISOString(), hours: (endMs - new Date(start.observed_at).getTime()) / 3_600_000 };
}

export function sourcePreset(id: string) {
  const preset = SOURCE_PRESETS.find((item) => item.id === id);
  if (!preset) throw new CollectorError('未知来源，不能采集未登记地址');
  return preset;
}

export function githubConfig(value: Record<string, unknown>) {
  const topic = value.topic ?? 'artificial-intelligence';
  if (!TOPICS.some((allowed) => allowed === topic)) throw new CollectorError('请选择支持的 GitHub 主题');
  if (value.includePrereleases !== undefined && typeof value.includePrereleases !== 'boolean') throw new CollectorError('预发布选项必须为布尔值');
  if (Object.keys(value).some((key) => !['topic', 'includePrereleases'].includes(key))) throw new CollectorError('来源配置包含不支持的字段');
  return { topic: String(topic), includePrereleases: value.includePrereleases === true };
}

export function plainText(value: unknown, max = 1200): string {
  if (typeof value !== 'string') return '';
  const $ = load(value);
  $('script,style,iframe,noscript').remove();
  return $.root().text().replace(/\s+/gu, ' ').trim().slice(0, max);
}

export function publicLink(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null; } catch { return null; }
}

export function stableId(prefix: string, value: string): string { return `${prefix}-${createHash('sha256').update(value).digest('hex').slice(0, 32)}`; }

export type CollectedItem = {
  externalId: string; title: string; summary: string; url: string; publishedAt: string | null;
  precision: 'instant' | 'date' | 'unknown'; kind: Kind; tags: string[];
  entity: { id: string; kind: Kind; name: string; url: string; data: Record<string, unknown> } | null;
  reviewReason?: string; data: Record<string, unknown>;
};

function dateInfo(value: unknown): { publishedAt: string | null; precision: CollectedItem['precision'] } {
  if (typeof value !== 'string' || !value.trim()) return { publishedAt: null, precision: 'unknown' };
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.getTime() > Date.now() + 24 * 3_600_000) return { publishedAt: null, precision: 'unknown' };
  if (/^\d{4}-\d{2}-\d{2}$/u.test(value)) return { publishedAt: `${value}T00:00:00.000Z`, precision: 'date' };
  // Do not invent a timezone for an incomplete source timestamp.
  if (!/(?:Z|[+-]\d{2}:?\d{2}|GMT|UTC)$/iu.test(value.trim())) return { publishedAt: null, precision: 'unknown' };
  return { publishedAt: date.toISOString(), precision: 'instant' };
}

export async function parseFeed(sourceId: string, xml: string): Promise<CollectedItem[]> {
  const preset = sourcePreset(sourceId);
  if (preset.kind !== 'rss') throw new CollectorError('来源类型不支持 RSS 解析');
  if (/<!\s*(?:DOCTYPE|ENTITY)/iu.test(xml)) throw new CollectorError('订阅内容包含不允许的 XML 声明');
  const feed = await new Parser().parseString(xml).catch(() => { throw new CollectorError('来源订阅格式无法解析'); });
  if (!Array.isArray(feed.items)) throw new CollectorError('来源没有有效条目集合');
  return feed.items.map((item): CollectedItem => {
    const title = plainText(item.title, 400);
    // Sanitize the original markup before falling back to parser-generated text;
    // otherwise script/style bodies may already have lost their tag boundaries.
    const summary = plainText(item.summary ?? item.content ?? item.contentSnippet, 1200);
    const link = publicLink(item.link);
    const externalId = String(item.guid ?? link ?? stableId('missing', title + (item.pubDate ?? ''))).slice(0, 2000);
    const modelName = title.match(/\b(?:GPT[- ]?\d[\w.-]*|Phi[- ]?\d[\w.-]*|o[1-9](?:[- ][a-z]+)?|Claude\s+(?:Opus|Sonnet|Haiku)(?:\s+\d+(?:[.-]\d+)*)?|Claude\s+\d+(?:[.-]\d+)*|(?:Opus|Sonnet|Haiku)\s+\d+(?:[.-]\d+)*)\b/iu)?.[0] ?? null;
    const provider = sourceId === 'openai-news' ? 'OpenAI' : sourceId === 'microsoft-ai' ? 'Microsoft' : 'Anthropic';
    const kind: Kind = modelName ? 'model' : 'tool';
    const entity = modelName ? { id: stableId('model', `${provider}:${modelName.toLowerCase().replace(/\s+/gu, '-')}`), kind, name: modelName, url: link ?? preset.url, data: { provider, description: '', lastObservedAt: new Date().toISOString() } } : null;
    const date = dateInfo(item.pubDate ?? item.isoDate);
    const categories = (item.categories ?? []).map((category) => plainText(category, 80)).slice(0, 10);
    const corporateTitle = /\b(?:hiring|careers|appoints?|appointment|chief\s+(?:[a-z]+\s+){0,4}officer|board of directors|funding|fundrais(?:ing|e)|financing|investment|politic(?:s|al)?|election|lawsuit|litigation|court|policy|case study|customer stor(?:y|ies))\b/iu.test(title)
      || /^how\s+.+\s+(?:uses?|is using|adopts?|built|builds)\s/iu.test(title);
    const corporateCategory = categories.some((category) => /^(?:company|global affairs|policy|customer stories|customers|partnerships|funding)$/iu.test(category));
    const concreteProduct = /\b(?:introduc(?:e|es|ing)|releas(?:e|es|ed|ing)|launch(?:es|ed|ing)?|new model|model update|API|SDK|deprecat(?:e|ion|ed)|retir(?:e|ing))\b/iu.test(title);
    const excludedMarketing = corporateTitle || (corporateCategory && !concreteProduct);
    return {
      externalId, title: title || '待核对：来源未提供标题', summary, url: link ?? preset.url, ...date, kind, tags: [provider], entity,
      reviewReason: !title || !link ? '来源缺少标题或有效原文链接' : excludedMarketing ? '公告可能属于人事、融资、政策或案例宣传，请核对收集范围' : undefined,
      data: { sourceTitle: item.title ?? '', sourcePublished: item.pubDate ?? item.isoDate ?? null, summaryKind: 'source', categories },
    };
  });
}
