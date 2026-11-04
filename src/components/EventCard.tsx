'use client';

import { Button, Checkbox, Tag, Tooltip } from 'antd';
import { ArrowRightOutlined, BookFilled, BookOutlined, ClockCircleOutlined, EditOutlined } from '@ant-design/icons';
import type { HubEvent } from '../shared/contracts';
import { eventDate, KindIcon, kindLabels } from './format';

interface Props {
  event: HubEvent;
  featured?: boolean;
  managing?: boolean;
  selected?: boolean;
  pending?: boolean;
  selectionDisabled?: boolean;
  onSelect?: (checked: boolean) => void;
  onOpen: () => void;
  onFavorite: () => void;
}

export default function EventCard({ event, featured, managing, selected, pending, selectionDisabled, onSelect, onOpen, onFavorite }: Props) {
  const hasOverride = Object.keys(event.overrides ?? {}).length > 0;
  return <article className={`event-card${featured ? ' featured-event' : ''}${event.personal.read ? ' is-read' : ''}`}>
    {!featured && <div className="event-row-icon" aria-hidden><KindIcon kind={event.kind} /></div>}
    <div className="event-card-body">
      <div className="event-kicker">
        {managing && <Checkbox checked={selected} disabled={selectionDisabled} onChange={(change) => onSelect?.(change.target.checked)} aria-label={`选择 ${event.title}`} />}
        {featured && <KindIcon kind={event.kind} />}
        <span>{kindLabels[event.kind]}</span>
        {hasOverride && <span className="event-label"><EditOutlined /> 已人工修正</span>}
        {!event.personal.read && <span className="unread-label">未读</span>}
        {event.status === 'review' && <Tag color="gold">需核对</Tag>}
        {event.personal.archived && <Tag>已归档</Tag>}
      </div>
      <button className="event-title" onClick={onOpen}>{event.title}</button>
      {!featured && <div className="event-source">来源：{event.source_name || '人工补充'}</div>}
      <p className="event-summary">{!featured && <span className="summary-label">{Object.hasOwn(event.overrides, 'summary') || event.manual ? '人工整理' : '来源摘要'}：</span>}{event.summary || '来源未提供摘要，查看详情了解出处与已保存资料。'}</p>
      {event.tags.length > 0 && <div className="event-tags">{event.tags.slice(0, 4).map((tag) => <Tag key={tag}>{tag}</Tag>)}{event.tags.length > 4 && <span className="muted">+{event.tags.length - 4}</span>}</div>}
      <div className="event-bottom">
        <span className="event-meta">{featured && <>来源：{event.source_name || '人工补充'} <span className="meta-separator">|</span> </>}{event.published_at ? '发布：' : ''}{eventDate(event)}{event.personal.later && <span className="later-meta"><ClockCircleOutlined /> 稍后读</span>}</span>
        {featured && <Button type="link" onClick={onOpen} icon={<ArrowRightOutlined />} iconPlacement="end">阅读详情</Button>}
      </div>
    </div>
    {!featured && <Tooltip title={event.personal.favorite ? '取消收藏' : '收藏'}><Button className="event-bookmark" type="text" icon={event.personal.favorite ? <BookFilled /> : <BookOutlined />} aria-label={event.personal.favorite ? '取消收藏' : '收藏'} aria-pressed={event.personal.favorite} loading={pending} onClick={onFavorite} /></Tooltip>}
  </article>;
}
