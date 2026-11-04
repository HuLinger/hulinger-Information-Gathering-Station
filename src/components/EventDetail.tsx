'use client';

import { useEffect, useState } from 'react';
import { Alert, App, Button, Descriptions, Divider, Drawer, Dropdown, Skeleton, Space, Tag, Timeline } from 'antd';
import { BookFilled, BookOutlined, ClockCircleOutlined, EditOutlined, ExportOutlined, MoreOutlined } from '@ant-design/icons';
import type { Entity, HubEvent, Revision, Source } from '../shared/contracts';
import { errorMessage, requestJson, type HubAction } from './api';
import { dateText, ErrorNotice, ExternalLink, KindIcon, kindLabels, stringValue } from './format';
import EventEditor from './EventEditor';
import { useReturnFocus } from './useReturnFocus';

export interface SourceRecord {
  id: string; source_id: string; external_id: string; event_id: string;
  data: Record<string, unknown>; first_seen: string; last_seen: string;
}
export interface EventDetailData { event: HubEvent; records: SourceRecord[]; history: Revision[] }

export default function EventDetail({ id, epoch, entities, sources, act, onClose, onEntity, onMerge, onSplit }: {
  id: string; epoch: number; entities: Entity[]; sources: Source[]; act: HubAction; onClose: () => void;
  onEntity: (id: string) => void; onMerge: (ids: string[]) => void; onSplit: (detail: EventDetailData) => void;
}) {
  useReturnFocus();
  const { modal } = App.useApp();
  const [detail, setDetail] = useState<EventDetailData | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [editing, setEditing] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    requestJson<EventDetailData>(`/api/hub?id=${encodeURIComponent(id)}`, { signal: controller.signal }).then((result) => {
      setDetail(result); setError(''); setLoading(false);
      if (!result.event.personal.read && result.event.status === 'active') {
        void act({ action: 'batch', ids: [id], personal: { read: true } }).catch((cause) => setError(errorMessage(cause)));
      }
    }).catch((cause) => { if (!controller.signal.aborted) { setError(errorMessage(cause)); setLoading(false); } });
    return () => controller.abort();
  }, [id, epoch, act, retry]);

  async function change(body: Record<string, unknown>, success: string) {
    setPending(true); setError('');
    try { await act(body, success); }
    catch (cause) { setError(errorMessage(cause)); }
    finally { setPending(false); }
  }
  function confirmStatus(status: 'trash' | 'delete' | 'excluded') {
    modal.confirm({
      title: status === 'delete' ? '永久删除这条内容？' : status === 'trash' ? '移入回收站？' : '排除这条候选信息？',
      content: status === 'delete' ? '内容、私人备注与人工覆盖将被清除，无法恢复。最少来源标识会保留，用于防止同一来源条目再次进入。' : status === 'trash' ? '30 天内可从回收站恢复。收藏等个人整理会一并保留。' : '同一来源的条目不会在下次同步时原样返回。你可以在“需核对 → 已排除”中恢复。',
      okText: status === 'delete' ? '永久删除' : '确认', okButtonProps: { danger: status !== 'excluded' }, cancelText: '取消',
      onOk: async () => { await act({ action: 'status', ids: [id], status }, status === 'delete' ? '已永久删除' : status === 'trash' ? '已移入回收站' : '已排除'); onClose(); },
    });
  }
  const event = detail?.event;
  const entity = entities.find((item) => item.id === event?.entity_id);
  const overriddenFields = event ? Object.keys(event.overrides).filter((field) => ['title', 'summary', 'kind', 'entity_id', 'tags'].includes(field) && JSON.stringify(event.originals[field]) !== JSON.stringify(event[field as keyof HubEvent])) : [];
  const fieldLabel: Record<string, string> = { title: '标题', summary: '摘要', kind: '内容分类', entity_id: '实体关联', tags: '标签' };
  function displayField(field: string, value: unknown): string {
    if (field === 'kind') return kindLabels[value as keyof typeof kindLabels] ?? '未分类';
    if (field === 'entity_id') return entities.find((item) => item.id === value)?.name ?? (value ? '其他关联对象' : '未关联');
    return Array.isArray(value) ? value.join('、') : typeof value === 'string' && value ? value : '无';
  }
  const menus = event ? [
    { key: 'read', label: event.personal.read ? '标记为未读' : '标记为已读' },
    { key: 'archive', label: event.personal.archived ? '取消归档' : '归档' },
    { key: 'history', label: '查看修订记录' },
    ...(event.status !== 'trash' ? [{ key: 'merge', label: '合并相同事件' }, { key: 'split', label: '拆分来源记录', disabled: (detail?.records.length ?? 0) < 2 }] : []),
    ...(event.status === 'trash' ? [{ key: 'restore', label: '从回收站恢复' }, { key: 'delete', label: '永久删除', danger: true }] : [{ key: 'trash', label: '移入回收站', danger: true }]),
  ] : [];

  return <>
    <Drawer open onClose={onClose} title="资讯详情" size="min(820px, 100vw)" className="detail-drawer" extra={event && <Dropdown menu={{ items: menus, onClick: ({ key }) => {
      if (key === 'read' || key === 'archive') void change({ action: 'batch', ids: [id], personal: key === 'read' ? { read: !event.personal.read } : { archived: !event.personal.archived } }, '整理状态已更新');
      if (key === 'history') setShowHistory(!showHistory);
      if (key === 'merge') onMerge([id]);
      if (key === 'split' && detail) onSplit(detail);
      if (key === 'trash' || key === 'delete') confirmStatus(key);
      if (key === 'restore') void change({ action: 'status', ids: [id], status: 'active' }, '已恢复');
    } }} trigger={['click']}><Button icon={<MoreOutlined />} aria-label="更多内容操作">更多</Button></Dropdown>}>
      {error && <ErrorNotice error={error} retry={() => setRetry((value) => value + 1)} />}
      {loading && !detail && <Skeleton active paragraph={{ rows: 8 }} />}
      {event && <div className="detail-content">
        <div className="event-kicker"><KindIcon kind={event.kind} /> {kindLabels[event.kind]} {Object.keys(event.overrides).length > 0 && <Tag color="blue">已人工修正</Tag>}</div>
        <h1>{event.title}</h1>
        <div className="detail-byline"><span>{event.source_name || '人工补充'}</span><span>{event.published_at ? `发布于 ${dateText(event.published_at)}` : '发布时间未知'}</span></div>
        {(event.originals.sourceUpdated === true || overriddenFields.length > 0) && <Alert type="info" showIcon title={event.originals.sourceUpdated === true ? '来源记录有修订' : '当前展示你的人工修正'} className="section-alert" description={<div><p>{overriddenFields.length ? '你的人工整理仍然保留。可以比较最新来源值，逐字段决定是否恢复自动值。' : '内容保留了来源修订记录，可在下方历史中核对变化。'}</p>{overriddenFields.length > 0 && <details><summary>比较来源资料与当前展示</summary>{overriddenFields.map((field) => <div key={field} className="source-difference"><strong>{fieldLabel[field]}</strong><dl><dt>最新来源值</dt><dd>{displayField(field, event.originals[field])}</dd><dt>当前人工值</dt><dd>{displayField(field, event[field as keyof HubEvent])}</dd></dl></div>)}</details>}<Button type="link" onClick={() => setEditing(true)} disabled={event.status === 'trash'}>核对 / 恢复自动值</Button></div>} />}
        {event.status === 'review' && <Alert type="warning" showIcon title="这条内容需要核对" description={event.review_reason || '请核对来源、分类和事件归属。'} className="section-alert" action={<Space wrap><Button onClick={() => setEditing(true)}>修正资料</Button><Button type="primary" loading={pending} onClick={() => void change({ action: 'status', ids: [id], status: 'active' }, '已归类入站')}>归类入站</Button><Button onClick={() => confirmStatus('excluded')}>排除</Button></Space>} />}
        {event.status === 'excluded' && <Alert type="info" showIcon title="已排除" description="这条内容不会出现在正常动态中。恢复后需要重新核对。" action={<Button onClick={() => void change({ action: 'status', ids: [id], status: 'review' }, '已恢复至需核对')}>恢复至需核对</Button>} className="section-alert" />}
        {event.status === 'trash' && <Alert type="warning" showIcon title="这条内容在回收站中" description={`删除于 ${dateText(event.deleted_at, true)}；默认保留 30 天。`} action={<Button onClick={() => void change({ action: 'status', ids: [id], status: 'active' }, '已恢复')}>恢复</Button>} className="section-alert" />}
        <div className="detail-actions">
          <Button icon={event.personal.favorite ? <BookFilled /> : <BookOutlined />} type={event.personal.favorite ? 'primary' : 'default'} onClick={() => void change({ action: 'batch', ids: [id], personal: { favorite: !event.personal.favorite } }, event.personal.favorite ? '已取消收藏' : '已收藏')} loading={pending} aria-pressed={event.personal.favorite}>{event.personal.favorite ? '已收藏' : '收藏'}</Button>
          <Button icon={<ClockCircleOutlined />} onClick={() => void change({ action: 'batch', ids: [id], personal: { later: !event.personal.later } }, event.personal.later ? '已移出稍后读' : '已加入稍后读')} aria-pressed={event.personal.later}>{event.personal.later ? '移出稍后读' : '稍后读'}</Button>
          <Button icon={<EditOutlined />} data-edit-trigger onClick={() => setEditing(true)} disabled={event.status === 'trash'}>修正 / 备注</Button>
          <ExternalLink href={event.url} className="external-action">阅读原文 <ExportOutlined /></ExternalLink>
        </div>
        <div className="detail-summary"><div className="eyebrow">{event.manual || Object.hasOwn(event.overrides, 'summary') ? '人工整理' : '来源摘要'}</div><p>{event.summary || '来源未提供摘要。你可以打开原文查看完整内容。'}</p></div>
        {event.tags.length > 0 && <div className="detail-tags">{event.tags.map((tag) => <Tag key={tag}>{tag}</Tag>)}</div>}
        {entity && <div className="entity-link-box"><span className="muted">关联{entity.kind === 'project' ? '项目' : '模型 / 产品'}</span><Button type="link" onClick={() => onEntity(entity.id)}>{entity.name}</Button></div>}
        <section className="note-section"><h2>私人备注</h2><p>{event.personal.note || '还没有备注。记下为什么值得关注，之后更容易找回。'}</p><Button type="link" icon={<EditOutlined />} onClick={() => setEditing(true)} disabled={event.status === 'trash'}>{event.personal.note ? '编辑备注' : '添加备注'}</Button></section>
        <Divider />
        <h2>来源与时间</h2>
        <Descriptions column={1} size="small" items={[
          { key: 'published', label: '来源发布时间', children: event.published_at ? dateText(event.published_at, event.published_precision !== 'date') : '来源未提供' },
          { key: 'discovered', label: '本站首次发现', children: dateText(event.discovered_at, true) },
          { key: 'updated', label: '资料更新时间', children: dateText(event.updated_at, true) },
        ]} />
        <div className="source-records">{detail.records.length ? detail.records.map((record) => <div key={record.id} className="source-record"><ExternalLink href={record.data.url}>{stringValue(record.data.title, '查看来源记录')} <ExportOutlined /></ExternalLink><span className="muted">{sources.find((source) => source.id === record.source_id)?.name ?? '未登记来源'} · 最近检查 {dateText(record.last_seen, true)}</span><details><summary>查看此来源的摘要与时间</summary><p className="preserve-lines">{stringValue(record.data.summary, '来源未提供摘要')}</p><p className="muted">发布时间：{typeof record.data.published_at === 'string' ? dateText(record.data.published_at, record.data.published_precision !== 'date') : '来源未提供'}<br />本站首次发现：{dateText(record.first_seen, true)}</p></details></div>) : <div className="source-record"><ExternalLink href={event.url}>原始链接 <ExportOutlined /></ExternalLink><span className="muted">此条目由人工补充</span></div>}</div>
        <div className="detail-history-heading"><h2>修订记录</h2><Button type="link" onClick={() => setShowHistory(!showHistory)}>{showHistory ? '收起' : `查看 ${detail.history.length} 条记录`}</Button></div>
        {showHistory && <Timeline items={detail.history.map((revision) => ({ content: <div><strong>{({ 'source-updated': '来源资料已更新', 'source-linked': '增加关联来源' } as Record<string, string>)[revision.action] ?? revision.action}</strong><p className="muted">{dateText(revision.created_at, true)}</p>{revision.after_data && <details><summary>查看此版本内容</summary><p>{revision.after_data.title}</p><p className="preserve-lines">{revision.after_data.summary}</p></details>}<Button size="small" disabled={!revision.after_data || event.status === 'trash'} onClick={() => modal.confirm({ title: '恢复到此版本？', content: '将恢复此版本的资料与个人整理；请确认这不会覆盖你要保留的新内容。', okText: '恢复', cancelText: '取消', onOk: () => act({ action: 'restoreRevision', id, revision: event.revision, historyId: revision.id }, '修订已恢复').then(() => undefined) })}>恢复到此版本</Button></div> }))} />}
        {detail.history.some((revision) => revision.action === '合并' || revision.action === 'merge') && <Button onClick={() => modal.confirm({ title: '撤销上次合并？', content: '会按保存的关系恢复原事件；如果之后已有新修订，将先检查冲突。', okText: '确认撤销', cancelText: '取消', onOk: () => act({ action: 'undoMerge', id, revision: event.revision }, '已撤销合并').then(() => onClose()) })}>撤销合并</Button>}
      </div>}
    </Drawer>
    {editing && event && <EventEditor event={event} entities={entities} act={act} onClose={() => setEditing(false)} />}
  </>;
}
