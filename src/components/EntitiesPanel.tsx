'use client';

import { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Descriptions, Drawer, Input, Pagination, Select, Skeleton, Space, Tabs, Tag, Timeline } from 'antd';
import { ArrowRightOutlined, CheckOutlined, ExportOutlined, PlusOutlined, StarOutlined } from '@ant-design/icons';
import type { Entity, HubEvent } from '../shared/contracts';
import { errorMessage, requestHubData, type HubAction } from './api';
import { dateText, EmptyState, ErrorNotice, eventDate, ExternalLink, KindIcon, numberValue, recordValue, stringArray, stringValue } from './format';
import { useReturnFocus } from './useReturnFocus';

function growthData(entity: Entity, window: string) { return recordValue(entity.data[window === '7d' ? 'growth7d' : 'growth24h']); }
function discoveredAt(entity: Entity): string | null { const value = entity.data.firstDiscoveredAt ?? entity.data.firstSeenAt ?? recordValue(entity).created_at; return typeof value === 'string' ? value : null; }
function Growth({ entity, window = '24h' }: { entity: Entity; window?: string }) {
  const growth = growthData(entity, window);
  const delta = numberValue(growth.delta);
  if (growth.status === 'stale') return <span className="warning">更新延迟</span>;
  if (growth.status !== 'ok' || delta === null) return <span className="muted">观测积累中</span>;
  return <span className={delta < 0 ? 'muted' : 'success'}>{delta > 0 ? '+' : ''}{delta.toLocaleString('zh-CN')} Star <span className="muted">/ {numberValue(growth.hours)?.toFixed(1) ?? '—'} 小时</span></span>;
}

export default function EntitiesPanel({ entities, kind, act, onOpen, onSources }: { entities: Entity[]; kind: 'model' | 'project'; act: HubAction; onOpen: (id: string) => void; onSources: () => void }) {
  const [tab, setTab] = useState('recent');
  const [window, setWindow] = useState('24h');
  const [query, setQuery] = useState('');
  const [provider, setProvider] = useState<string | undefined>();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState('');
  const base = entities.filter((entity) => kind === 'project' ? entity.kind === 'project' : entity.kind !== 'project');
  const providers = [...new Set(base.map((entity) => stringValue(entity.data.provider, '')).filter(Boolean))];
  const filtered = useMemo(() => {
    let list = entities.filter((entity) => kind === 'project' ? entity.kind === 'project' : entity.kind !== 'project');
    if (query) list = list.filter((entity) => `${entity.name} ${stringValue(entity.data.description, '')} ${stringArray(entity.data.topics).join(' ')}`.toLowerCase().includes(query.toLowerCase()));
    if (provider) list = list.filter((entity) => entity.data.provider === provider);
    if (tab === 'followed') list = list.filter((entity) => entity.followed);
    if (tab === 'growth') list = list.filter((entity) => entity.data.sampled !== false && growthData(entity, window).status === 'ok' && numberValue(growthData(entity, window).delta) !== null).sort((a, b) => Number(growthData(b, window).delta) - Number(growthData(a, window).delta));
    else if (tab === 'stars') list.sort((a, b) => (numberValue(b.data.stars) ?? -1) - (numberValue(a.data.stars) ?? -1));
    else if (tab === 'recent') list.sort((a, b) => Date.parse(discoveredAt(b) ?? '1970-01-01') - Date.parse(discoveredAt(a) ?? '1970-01-01'));
    return list;
  }, [entities, kind, query, provider, tab, window]);
  async function follow(entity: Entity) {
    setPending(entity.id); setError('');
    try { await act({ action: 'follow', id: entity.id, followed: !entity.followed }, entity.followed ? '已取消关注' : '已关注，后续更新会进入关注视图'); }
    catch (cause) { setError(errorMessage(cause)); }
    finally { setPending(null); }
  }
  return <section>
    {error && <ErrorNotice error={error} />}
    <div className="entity-toolbar"><Tabs activeKey={tab} onChange={setTab} items={kind === 'project' ? [{ key: 'recent', label: '全部项目' }, { key: 'stars', label: '累计 Star' }, { key: 'growth', label: '关注增长' }, { key: 'followed', label: '我关注的' }] : [{ key: 'recent', label: '全部模型 / 产品' }, { key: 'followed', label: '我关注的' }]} /><Input.Search aria-label={kind === 'project' ? '查找项目' : '查找模型或产品'} placeholder={kind === 'project' ? '查找项目或主题' : '查找模型或厂商'} allowClear value={query} onChange={(change) => setQuery(change.target.value)} className="entity-search" /></div>
    {kind === 'model' && providers.length > 0 && <Select aria-label="按厂商筛选" className="provider-select" allowClear placeholder="全部厂商" value={provider} onChange={setProvider} options={providers.map((value) => ({ value, label: value }))} />}
    {kind === 'project' && <div className="sampling-note"><span>范围：{tab === 'growth' ? `当前采样的 ${base.filter((entity) => entity.data.sampled !== false).length} 个项目` : `本站已观测的 ${base.length} 个项目`}，非 GitHub 全站榜单。数据以各项目观测时间为准。</span>{tab === 'growth' && <Select aria-label="关注增长观察窗口" value={window} onChange={setWindow} options={[{ value: '24h', label: '约 24 小时' }, { value: '7d', label: '约 7 天' }]} />}</div>}
    {!filtered.length ? <EmptyState title={tab === 'growth' ? '还没有可比较的增长数据' : tab === 'followed' ? '还没有关注的对象' : query || provider ? '没有符合条件的结果' : kind === 'project' ? '准备发现你的下一个工具' : '让模型更新汇集到这里'} description={tab === 'growth' ? '需要两个符合窗口要求的真实快照；首次观测不会虚构增长。' : '启用公开来源并完成同步后，相关模型和项目会自动整理到这里。'} action={<Button onClick={onSources}>查看来源管理</Button>} /> : <div className="entity-grid">{filtered.map((entity) => {
      const release = recordValue(entity.data.latestRelease);
      return <article key={entity.id} className="entity-card">
        <div className="entity-card-top"><span className="entity-icon"><KindIcon kind={entity.kind} /></span><div><span className="eyebrow">{kind === 'project' ? 'OPEN SOURCE' : stringValue(entity.data.provider, 'MODEL & PRODUCT')}</span><button className="entity-name" onClick={() => onOpen(entity.id)}>{entity.name}</button></div><Button size="small" type={entity.followed ? 'primary' : 'default'} ghost={entity.followed} icon={entity.followed ? <CheckOutlined /> : <PlusOutlined />} loading={pending === entity.id} onClick={() => void follow(entity)}>{entity.followed ? '已关注' : '关注'}</Button></div>
        <p className="entity-description">{stringValue(entity.data.description, '来源尚未提供简介，打开详情查看可核验资料。')}</p>
        <div className="entity-topics">{stringArray(entity.data.topics).slice(0, 4).map((topic) => <Tag key={topic}>{topic}</Tag>)}</div>
        {kind === 'project' && <div className="project-metrics"><span><StarOutlined /> {numberValue(entity.data.stars)?.toLocaleString('zh-CN') ?? '未知'}</span><span>{stringValue(entity.data.language, '语言未知')}</span><span>{stringValue(entity.data.license, '许可证待核对')}</span></div>}
        {kind === 'project' && tab === 'growth' && <div className="growth-line"><Growth entity={entity} window={window} /></div>}
        {typeof release.tag === 'string' && <div className="release-line">最近记录版本 <strong>{release.tag}</strong>{release.prerelease === true && <Tag>预发布</Tag>}</div>}
        <div className="entity-card-bottom"><span className="muted">{kind === 'project' ? `观测于 ${dateText(stringValue(entity.data.observedAt, ''))}` : `资料更新 ${dateText(stringValue(entity.data.lastObservedAt, ''))}`}</span><Button type="link" icon={<ArrowRightOutlined />} iconPlacement="end" onClick={() => onOpen(entity.id)}>查看时间线</Button></div>
      </article>;
    })}</div>}
  </section>;
}

export function EntityDetail({ entity, epoch, act, onClose, onEvent }: { entity: Entity; epoch: number; act: HubAction; onClose: () => void; onEvent: (event: HubEvent) => void }) {
  useReturnFocus();
  const [events, setEvents] = useState<HubEvent[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [pending, setPending] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    requestHubData(`/api/hub?view=feed&entity=${encodeURIComponent(entity.id)}&page=${page}`, { signal: controller.signal }).then((data) => { setEvents(data.events); setTotal(data.total); setError(''); setLoaded(true); }).catch((cause) => { if (!controller.signal.aborted) { setError(errorMessage(cause)); setLoaded(true); } });
    return () => controller.abort();
  }, [entity.id, page, epoch]);
  const isProject = entity.kind === 'project';
  const release = recordValue(entity.data.latestRelease);
  return <Drawer open title={isProject ? '开源项目档案' : '模型 / 产品档案'} size="min(840px, 100vw)" onClose={onClose}>
    <div className="detail-content"><div className="entity-detail-title"><span className="entity-icon"><KindIcon kind={entity.kind} /></span><div><div className="eyebrow">{isProject ? 'OPEN SOURCE PROJECT' : stringValue(entity.data.provider, 'MODEL & PRODUCT')}</div><h1>{entity.name}</h1></div></div>
      <p className="entity-detail-description">{stringValue(entity.data.description, '暂未收录简介，具体变化请查看下方来源事件。')}</p>
      <Space wrap><Button type={entity.followed ? 'default' : 'primary'} icon={entity.followed ? <CheckOutlined /> : <PlusOutlined />} loading={pending} onClick={async () => { setPending(true); try { await act({ action: 'follow', id: entity.id, followed: !entity.followed }, entity.followed ? '已取消关注' : '已关注'); } catch (cause) { setError(errorMessage(cause)); } finally { setPending(false); } }}>{entity.followed ? '已关注 · 取消' : '关注更新'}</Button><ExternalLink href={entity.url} className="external-action">{isProject ? '打开 GitHub 仓库' : '访问官方来源'} <ExportOutlined /></ExternalLink></Space>
      {error && <ErrorNotice error={error} />}
      <div className="entity-topics section-top">{stringArray(entity.data.topics).map((topic) => <Tag key={topic}>{topic}</Tag>)}</div>
      {isProject && <section className="entity-facts"><Descriptions column={{ xs: 1, sm: 2 }} items={[
        { key: 'stars', label: '累计 Star', children: numberValue(entity.data.stars)?.toLocaleString('zh-CN') ?? '未知' },
        { key: 'observed', label: '观测时间', children: dateText(stringValue(entity.data.observedAt, ''), true) },
        { key: 'language', label: '主要语言', children: stringValue(entity.data.language, '来源未提供') },
        { key: 'license', label: '许可证', children: stringValue(entity.data.license, '待核对，请查看仓库') },
        { key: 'created', label: '仓库创建', children: dateText(stringValue(entity.data.createdAt, '')) },
        { key: 'discovered', label: '本站发现', children: dateText(discoveredAt(entity)) },
      ]} />{typeof release.tag === 'string' && <div className="release-summary"><strong>最近记录版本</strong><ExternalLink href={release.url}>{release.tag} <ExportOutlined /></ExternalLink><span>{dateText(stringValue(release.publishedAt, ''))}</span>{release.prerelease === true && <Tag>预发布</Tag>}</div>}
        <h2>关注增长 · 本站观测</h2><p className="muted">{stringValue(entity.data.scope, '仅比较本站观测的候选集合，不代表 GitHub 全站排名。')}</p>
        <div className="growth-panels">{['24h', '7d'].map((window) => { const growth = growthData(entity, window); return <div className="growth-panel" key={window}><h3>{window === '24h' ? '约 24 小时' : '约 7 天'}</h3><Growth entity={entity} window={window} /><p className="muted">{growth.startAt && growth.endAt ? `${dateText(stringValue(growth.startAt, ''), true)} — ${dateText(stringValue(growth.endAt, ''), true)}` : '等待符合观察窗口的真实快照'}</p></div>; })}</div>
        <Alert type="info" showIcon title="Star 是关注信号，不是质量认证。" description="增长使用两次真实快照的净差；数据不足或延迟时不参与当前增长排行。" />
      </section>}
      <div className="section-heading section-top"><h2>更新与事件时间线</h2><span className="muted">{total} 条事件</span></div>
      {!loaded && <Skeleton active paragraph={{ rows: 5 }} />}
      {loaded && !events.length && <EmptyState title="暂未收录相关事件" description="实体资料已建立；后续可验证的版本或公告会出现在时间线中。" />}
      <Timeline items={events.map((event) => ({ content: <div className="timeline-event"><span className="muted">{eventDate(event)}</span><button className="timeline-title" onClick={() => onEvent(event)}>{event.title}</button><p>{event.summary || '来源未提供摘要'}</p><span className="muted">{event.source_name}</span></div> }))} />
      {total > 20 && <Pagination current={page} total={total} pageSize={20} onChange={setPage} showSizeChanger={false} />}
    </div>
  </Drawer>;
}
