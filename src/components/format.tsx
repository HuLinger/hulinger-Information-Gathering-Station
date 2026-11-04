'use client';

import { Alert, Button, Empty } from 'antd';
import { AppstoreOutlined, FileTextOutlined, GithubOutlined, ReloadOutlined } from '@ant-design/icons';
import type { HubEvent, Kind, Source } from '../shared/contracts';

export const kindLabels: Record<Kind, string> = { model: '模型更新', project: '开源项目', tool: '工具动态' };
export const kindOptions = Object.entries(kindLabels).map(([value, label]) => ({ value, label }));

export function KindIcon({ kind }: { kind: Kind }) {
  return kind === 'project' ? <GithubOutlined /> : kind === 'model' ? <AppstoreOutlined /> : <FileTextOutlined />;
}

export function dateText(value: string | null | undefined, withTime = false): string {
  if (!value) return '尚无记录';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '时间未知';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    ...(withTime ? { hour: '2-digit', minute: '2-digit' } as const : {}),
  }).format(date);
}

export function eventDate(event: HubEvent) {
  return event.published_at ? dateText(event.published_at) : `发布时间未知 · 发现于 ${dateText(event.discovered_at)}`;
}

export function safeUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : undefined;
  } catch { return undefined; }
}

export function ExternalLink({ href, children, className }: { href: unknown; children: React.ReactNode; className?: string }) {
  const url = safeUrl(href);
  return url ? <a href={url} target="_blank" rel="noopener noreferrer" className={className}>{children}</a> : <span className={className}>{children}</span>;
}

export function sourceHealth(source: Source): { label: string; tone: string; description: string } {
  if (!source.enabled) return { label: source.last_attempt ? '已暂停' : '未启用', tone: 'muted', description: source.last_attempt ? '历史内容保留，后续采集已暂停' : '启用后按计划收集公开资料' };
  if (source.error) return { label: '同步异常', tone: 'danger', description: source.error };
  if (!source.last_success) return { label: '等待同步', tone: 'muted', description: '首次同步尚未完成' };
  const delayed = Date.now() - new Date(source.last_success).getTime() > source.interval_minutes * 2 * 60_000;
  return delayed
    ? { label: '同步延迟', tone: 'warning', description: `上次成功 ${dateText(source.last_success, true)}` }
    : { label: '同步成功', tone: 'success', description: `上次成功 ${dateText(source.last_success, true)}` };
}

export function ErrorNotice({ error, retry }: { error: string; retry?: () => void }) {
  return <Alert type="error" showIcon title="暂时没有完成" description={error} action={retry ? <Button onClick={retry} icon={<ReloadOutlined />}>重试</Button> : undefined} />;
}

export function EmptyState({ title, description, action }: { title: string; description?: string; action?: React.ReactNode }) {
  return <div className="hub-empty"><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={<><strong>{title}</strong>{description && <p>{description}</p>}</>}>{action}</Empty></div>;
}

export function stringValue(value: unknown, fallback = '暂无资料') { return typeof value === 'string' && value ? value : fallback; }
export function numberValue(value: unknown): number | null { return typeof value === 'number' && Number.isFinite(value) ? value : null; }
export function recordValue(value: unknown): Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
export function stringArray(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []; }
