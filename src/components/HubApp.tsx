'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Alert, App, Button, Checkbox, Drawer, Dropdown, Form, Input, Pagination, Select, Skeleton, Space, Tabs, Tag } from 'antd';
import type { InputRef } from 'antd';
import { AppstoreOutlined, ArrowRightOutlined, BookOutlined, CheckOutlined, CloudOutlined, DeleteOutlined, DownOutlined, FilterOutlined, GithubOutlined, HomeOutlined, LinkOutlined, LogoutOutlined, MenuOutlined, MoreOutlined, PlusOutlined, SearchOutlined, SettingOutlined, SyncOutlined, UserOutlined, WifiOutlined } from '@ant-design/icons';
import type { HubData, HubEvent, Personal } from '../shared/contracts';
import { ApiError, errorMessage, postJson, requestHubData, requestJson, type AuthStatus, type HubAction } from './api';
import { EmptyState, ErrorNotice, kindOptions, recordValue, sourceHealth, stringArray, stringValue } from './format';
import EventCard from './EventCard';
import EventEditor from './EventEditor';
import EventDetail, { type EventDetailData } from './EventDetail';
import { MergeDialog, SplitDialog } from './MergeSplit';
import EntitiesPanel, { EntityDetail } from './EntitiesPanel';
import SourcesPanel, { SourceIcon } from './SourcesPanel';
import SettingsPanel from './SettingsPanel';
import DrivePanel from './drive/DrivePanel';

const views = ['feed', 'models', 'projects', 'mine', 'sources', 'search', 'settings', 'drive'] as const;
type View = typeof views[number];
const navItems: { key: View; label: string; mobile: string; icon: React.ReactNode }[] = [
  { key: 'feed', label: '最新动态', mobile: '动态', icon: <HomeOutlined /> },
  { key: 'models', label: '模型更新', mobile: '模型', icon: <AppstoreOutlined /> },
  { key: 'projects', label: '开源项目', mobile: '项目', icon: <GithubOutlined /> },
  { key: 'mine', label: '我的整理', mobile: '我的', icon: <BookOutlined /> },
  { key: 'sources', label: '来源管理', mobile: '来源', icon: <WifiOutlined /> },
  { key: 'drive', label: '个人云盘', mobile: '云盘', icon: <CloudOutlined /> },
];
const titles: Record<View, { title: string; subtitle: string }> = {
  feed: { title: '今天，关注这些变化。', subtitle: '汇集可信来源的 AI 更新与开源发现，让值得关注的信息留在这里。' },
  models: { title: '模型在进化，关注不遗漏。', subtitle: '沿着模型与产品的时间线，看清每一次变化的来源和适用范围。' },
  projects: { title: '发现工具，也发现可能。', subtitle: '从用途出发了解开源项目，用可追溯的观测理解关注度。' },
  mine: { title: '值得留下的，都在这里。', subtitle: '收藏、稍后读与个人备注，构成你自己的 AI 资料库。' },
  sources: { title: '每条信息，都有来处。', subtitle: '管理自动收集的范围，了解来源健康、同步进度与覆盖缺口。' },
  search: { title: '找回你关注的信息。', subtitle: '搜索资讯、模型、开源项目，以及你的标签与私人备注。' },
  settings: { title: '你的资料，由你掌握。', subtitle: '管理个人工作空间、阅读偏好与完整数据导出。' },
  drive: { title: '文件随行，存储由你掌握。', subtitle: '在自己的服务器保存大文件，登录后上传、续传、下载与整理。' },
};
const sectionItems = [{ key: 'favorite', label: '收藏' }, { key: 'later', label: '稍后读' }, { key: 'archived', label: '归档' }, { key: 'review', label: '需核对' }, { key: 'trash', label: '回收站' }];
const validSections = [...sectionItems.map((item) => item.key), 'excluded'];
const normalizeView = (value: string): View => views.includes(value as View) ? value as View : 'feed';
const viewStorageKey = (view: View, section: string) => `hulinger-view-${view}-${view === 'mine' ? section : 'default'}`;
interface Filters { kind?: string; source?: string; tag?: string; from?: string; to?: string; dateUnknown?: boolean }

export default function HubApp({ initialView, initialSection, initialEventId, initialEntityId }: { initialView: string; initialSection: string; initialEventId: string | null; initialEntityId: string | null }) {
  const router = useRouter();
  const { message, modal } = App.useApp();
  const [view, setView] = useState<View>(normalizeView(initialView));
  const [section, setSection] = useState(validSections.includes(initialSection) ? initialSection : 'favorite');
  const [eventId, setEventId] = useState(initialEventId);
  const [entityId, setEntityId] = useState(initialEntityId);
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [data, setData] = useState<HubData | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [epoch, setEpoch] = useState(0);
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [searchText, setSearchText] = useState('');
  const [feedTab, setFeedTab] = useState('all');
  const [filters, setFilters] = useState<Filters>({});
  const [filterOpen, setFilterOpen] = useState(false);
  const [filterError, setFilterError] = useState('');
  const [managing, setManaging] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [mutationPending, setMutationPending] = useState(false);
  const [editingNew, setEditingNew] = useState(false);
  const [mergeIds, setMergeIds] = useState<string[] | null>(null);
  const [splitDetail, setSplitDetail] = useState<EventDetailData | null>(null);
  const [density, setDensity] = useState('comfortable');
  const [mobileNav, setMobileNav] = useState(false);
  const [sessionReady, setSessionReady] = useState(false);
  const searchRef = useRef<InputRef>(null);
  const searchComposing = useRef(false);
  const abortRef = useRef<AbortController | null>(null);

  const restoreViewState = useCallback((nextView: View, nextSection: string) => {
    let saved: Record<string, unknown> = {};
    try { saved = recordValue(JSON.parse(window.sessionStorage.getItem(viewStorageKey(nextView, nextSection)) ?? '{}')); } catch { /* Session preferences are optional. */ }
    const savedFilters = recordValue(saved.filters);
    const restoredFilters: Filters = {};
    if (kindOptions.some((option) => option.value === savedFilters.kind)) restoredFilters.kind = String(savedFilters.kind);
    if (typeof savedFilters.source === 'string') restoredFilters.source = savedFilters.source.slice(0, 300);
    if (typeof savedFilters.tag === 'string') restoredFilters.tag = savedFilters.tag.slice(0, 50);
    for (const key of ['from', 'to'] as const) if (typeof savedFilters[key] === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(savedFilters[key])) restoredFilters[key] = savedFilters[key];
    if (savedFilters.dateUnknown === true) restoredFilters.dateUnknown = true;
    const restoredQ = typeof saved.q === 'string' ? saved.q.slice(0, 300) : '';
    setQ(restoredQ); setSearchText(restoredQ); setFilters(restoredFilters);
    setFeedTab(typeof saved.feedTab === 'string' && ['all', 'unread', 'followed'].includes(saved.feedTab) ? saved.feedTab : 'all');
    setPage(typeof saved.page === 'number' && Number.isInteger(saved.page) && saved.page > 0 ? saved.page : 1);
  }, []);

  useEffect(() => {
    requestJson<AuthStatus>('/api/auth/status').then((status) => {
      if (status.state !== 'ready') { router.replace('/login'); return; }
      const current = new URL(window.location.href);
      restoreViewState(normalizeView(current.searchParams.get('view') ?? 'feed'), current.searchParams.get('section') ?? 'favorite');
      setAuth(status);
      setSessionReady(true);
      try { if (window.localStorage.getItem('hulinger-density') === 'compact') setDensity('compact'); } catch { /* A blocked preference store must not prevent login. */ }
    }).catch((cause) => { setError(errorMessage(cause)); setLoading(false); });
    const onPop = () => {
      const url = new URL(window.location.href);
      const nextView = normalizeView(url.searchParams.get('view') ?? 'feed');
      const nextSection = url.searchParams.get('section') ?? 'favorite';
      setView(nextView); setSection(nextSection); restoreViewState(nextView, nextSection); setLoading(true);
      setEventId(url.searchParams.get('id')); setEntityId(url.searchParams.get('entity'));
      setSelectedIds([]); setManaging(false);
    };
    const onKey = (event: KeyboardEvent) => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); searchRef.current?.focus(); } };
    window.addEventListener('popstate', onPop); window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('popstate', onPop); window.removeEventListener('keydown', onKey); };
  }, [router, restoreViewState]);

  useEffect(() => {
    if (!sessionReady) return;
    try { window.sessionStorage.setItem(viewStorageKey(view, section), JSON.stringify({ q, filters, feedTab, page })); } catch { /* Browsing still works when session storage is unavailable. */ }
  }, [sessionReady, view, section, q, filters, feedTab, page]);

  useEffect(() => {
    if (auth?.state !== 'ready' || view === 'drive') return;
    const controller = new AbortController(); abortRef.current = controller;
    const params = new URLSearchParams({ view, page: String(page) });
    if (view === 'mine') params.set('section', section);
    if (q) params.set('q', q);
    if (view === 'feed' && feedTab === 'unread') params.set('unread', '1');
    if (view === 'feed' && feedTab === 'followed') params.set('followed', '1');
    for (const [key, value] of Object.entries(filters)) if (value) params.set(key, value === true ? '1' : String(value));
    requestHubData(`/api/hub?${params}`, { signal: controller.signal }).then((result) => { setData(result); setError(''); setLoading(false); }).catch((cause) => {
      if (controller.signal.aborted) return;
      if (cause instanceof ApiError && cause.status === 401) { router.replace('/login'); return; }
      setError(errorMessage(cause)); setLoading(false);
    });
    return () => controller.abort();
  }, [auth?.state, view, page, section, q, filters, feedTab, epoch, router]);

  useEffect(() => {
    if (view !== 'sources' || auth?.state !== 'ready') return;
    const interval = window.setInterval(() => setEpoch((value) => value + 1), 8000);
    return () => window.clearInterval(interval);
  }, [view, auth?.state]);

  const act: HubAction = useCallback(async (body, success) => {
    try {
      const result = await postJson('/api/hub', body);
      setEpoch((value) => value + 1);
      if (success) void message.success(success);
      return result;
    } catch (cause) {
      void message.error(errorMessage(cause));
      throw cause;
    }
  }, [message]);

  function location(nextView: View, nextSection: string, nextEvent: string | null, nextEntity: string | null) {
    const params = new URLSearchParams();
    if (nextView !== 'feed') params.set('view', nextView);
    if (nextView === 'mine') params.set('section', nextSection);
    if (nextEvent) params.set('id', nextEvent);
    if (nextEntity) params.set('entity', nextEntity);
    window.history.pushState(null, '', params.size ? `/?${params}` : '/');
  }
  function navigate(next: View, nextSection = 'favorite') {
    abortRef.current?.abort(); setLoading(true); setView(next); setSection(nextSection); setPage(1); setSelectedIds([]); setManaging(false); setQ(''); setSearchText(''); setFilters({}); setEventId(null); setEntityId(null); setMobileNav(false);
    location(next, nextSection, null, null); window.scrollTo({ top: 0 });
  }
  function search(value: string) {
    if (searchComposing.current) return;
    setQ(value.trim()); setSearchText(value); setView('search'); setPage(1); setSelectedIds([]); setManaging(false); setEventId(null); setEntityId(null); setLoading(true); setEpoch((old) => old + 1); location('search', section, null, null);
  }
  function openEvent(event: HubEvent) { setEventId(event.id); location(view, section, event.id, entityId); }
  function openEntity(id: string) { setEntityId(id); setEventId(null); location(view, section, null, id); }
  function reload() { if (!auth) { window.location.reload(); return; } setLoading(true); setSelectedIds([]); setEpoch((value) => value + 1); }
  async function toggleFavorite(event: HubEvent) {
    setMutationPending(true);
    try { await act({ action: 'batch', ids: [event.id], personal: { favorite: !event.personal.favorite } }, event.personal.favorite ? '已取消收藏' : '已收藏'); }
    catch (cause) { setError(errorMessage(cause)); }
    finally { setMutationPending(false); }
  }
  async function bulk(personal: Partial<Personal>) {
    const ids = validSelection();
    if (!ids) return;
    setMutationPending(true); setError('');
    try { await act({ action: 'batch', ids, personal }, `已整理 ${ids.length} 条内容`); setSelectedIds([]); }
    catch (cause) { setError(errorMessage(cause)); }
    finally { setMutationPending(false); }
  }
  function validSelection(): string[] | null {
    if (loading) { setError('列表正在更新，请等待结果加载后再批量操作。'); return null; }
    if (!selectedIds.length || selectedIds.some((id) => !data?.events.some((event) => event.id === id))) { setSelectedIds([]); setError('列表范围已变化，请重新选择需要处理的条目。'); return null; }
    return [...selectedIds];
  }
  function bulkStatus(status: string) {
    const ids = validSelection();
    if (!ids) return;
    modal.confirm({ title: status === 'delete' ? `永久删除 ${ids.length} 条内容？` : status === 'trash' ? `将 ${ids.length} 条内容移入回收站？` : `处理 ${ids.length} 条内容？`, content: status === 'delete' ? '将清除内容、私人备注及人工覆盖，无法恢复。最少来源标识用于阻止重复采集。' : '只处理当前明确选中的条目。', okText: status === 'delete' ? '永久删除' : '确认', cancelText: '取消', okButtonProps: { danger: status === 'delete' || status === 'trash' }, onOk: async () => { await act({ action: 'status', ids, status }, '选中内容已处理'); setSelectedIds([]); } });
  }
  const currentTitle = navItems.find((item) => item.key === view)?.label ?? (view === 'search' ? '全局搜索' : '设置');
  const entity = data?.entities.find((item) => item.id === entityId);
  const matchingEntities = q ? data?.entities.filter((item) => [
    item.name,
    stringValue(item.data.description, ''),
    ...stringArray(item.data.aliases),
    ...stringArray(item.data.topics),
  ].join(' ').toLocaleLowerCase().includes(q.toLocaleLowerCase())) ?? [] : [];
  const activeFilters = Object.entries(filters).filter(([, value]) => !!value);
  const showList = view === 'feed' || view === 'mine' || view === 'search';
  const showRail = view === 'feed';
  const sectionLabel = sectionItems.find((item) => item.key === section)?.label ?? '已排除';
  const hasFilter = activeFilters.length > 0 || !!q || (view === 'feed' && feedTab !== 'all');
  const initialLoadFailed = !!error && !data && !loading;
  const emptyDescription = hasFilter ? '试着清除筛选条件，或换一个更宽泛的关键词。' : view === 'mine' ? `你整理的${sectionLabel}内容会显示在这里。` : data?.sources.some((source) => source.enabled) ? '来源已启用。完成首次同步后，可核验的资讯会自动出现在这里。' : '先启用几个你信任的公开来源，或添加一条值得留下的链接。';
  const moreMenu = { items: [{ key: 'drive', label: '个人云盘', icon: <CloudOutlined /> }, { key: 'sources', label: '来源管理', icon: <WifiOutlined /> }, { key: 'settings', label: '设置与数据导出', icon: <SettingOutlined /> }, { type: 'divider' as const }, { key: 'logout', label: '退出登录', icon: <LogoutOutlined /> }], onClick: ({ key }: { key: string }) => {
    if (key === 'logout') { modal.confirm({ title: '退出当前登录？', okText: '退出', cancelText: '取消', onOk: async () => { await postJson('/api/auth/sign-out', {}); router.replace('/login'); router.refresh(); } }); }
    else navigate(key as View);
  } };

  const navigation = <nav aria-label="主导航" className="side-nav">{navItems.map((item) => <button className={`nav-item${view === item.key ? ' selected' : ''}`} key={item.key} onClick={() => navigate(item.key)} aria-label={item.label} title={item.label} aria-current={view === item.key ? 'page' : undefined}>{item.icon}<span>{item.label}</span></button>)}</nav>;
  const listContent = <>
    {view === 'search' && <div className="search-workspace"><Input.Search ref={searchRef} autoFocus aria-label="全局搜索" placeholder="搜索 AI 动态、模型、开源项目或个人备注…" value={searchText} onChange={(change) => setSearchText(change.target.value)} onCompositionStart={() => { searchComposing.current = true; }} onCompositionEnd={() => { searchComposing.current = false; }} onSearch={(value, event) => { if (event && 'isComposing' in event.nativeEvent && event.nativeEvent.isComposing) return; search(value); }} allowClear enterButton="搜索" size="large" /></div>}
    {view === 'mine' && <div className="mobile-utility"><Button icon={<CloudOutlined />} onClick={() => navigate('drive')}>个人云盘</Button><Button icon={<WifiOutlined />} onClick={() => navigate('sources')}>来源管理</Button><Button icon={<SettingOutlined />} onClick={() => navigate('settings')}>设置与导出</Button></div>}
    <div className="feed-toolbar">
      {view === 'feed' ? <Tabs activeKey={feedTab} onChange={(key) => { setFeedTab(key); setPage(1); setSelectedIds([]); setLoading(true); }} items={[{ key: 'all', label: '全部' }, { key: 'unread', label: '未读' }, { key: 'followed', label: '我关注的' }]} /> : view === 'mine' ? <Tabs activeKey={section === 'excluded' ? 'review' : section} onChange={(key) => { setSection(key); setPage(1); setSelectedIds([]); setManaging(false); setLoading(true); location('mine', key, null, null); }} items={sectionItems} /> : <span className="search-count">{q ? `找到 ${data?.total ?? 0} 条资讯` : '跨类型检索'}</span>}
      <div className="toolbar-actions"><Button icon={<FilterOutlined />} onClick={() => { setFilterError(''); setFilterOpen(true); }}>筛选{activeFilters.length > 0 ? ` · ${activeFilters.length}` : ''} <DownOutlined /></Button>{view !== 'mine' && <Button type="primary" icon={<PlusOutlined />} onClick={() => setEditingNew(true)}>添加链接</Button>}<Dropdown trigger={['click']} menu={{ items: [{ key: 'manage', label: managing ? '退出批量整理' : '批量整理' }, { key: 'refresh', label: '刷新列表' }], onClick: ({ key }) => key === 'refresh' ? reload() : (setManaging(!managing), setSelectedIds([])) }}><Button type="text" icon={<MoreOutlined />} aria-label="列表更多操作" /></Dropdown></div>
    </div>
    {view === 'mine' && (section === 'review' || section === 'excluded') && <Space className="review-switch"><Button type={section === 'review' ? 'primary' : 'default'} onClick={() => { if (section !== 'review') { setSection('review'); setPage(1); setSelectedIds([]); setLoading(true); location('mine', 'review', null, null); } }}>待核对</Button><Button type={section === 'excluded' ? 'primary' : 'default'} onClick={() => { if (section !== 'excluded') { setSection('excluded'); setPage(1); setSelectedIds([]); setLoading(true); location('mine', 'excluded', null, null); } }}>已排除 · 可恢复</Button></Space>}
    {activeFilters.length > 0 && <div className="filter-tags">{activeFilters.map(([key, value]) => <Tag key={key} closable onClose={() => { setFilters((old) => ({ ...old, [key]: undefined })); setPage(1); setSelectedIds([]); setLoading(true); }}>{({ kind: '类型', source: '来源', tag: '标签', from: '起始日期', to: '结束日期', dateUnknown: '发布时间未知' } as Record<string, string>)[key]}{value === true ? '' : `：${key === 'kind' ? kindOptions.find((option) => option.value === value)?.label : value}`}</Tag>)}<Button type="link" onClick={() => { setFilters({}); setPage(1); setSelectedIds([]); setLoading(true); }}>清除全部</Button></div>}
    {managing && <div className="bulk-toolbar">
      <Checkbox disabled={loading} checked={!!data?.events.length && data.events.every((event) => selectedIds.includes(event.id))} indeterminate={selectedIds.length > 0 && selectedIds.length < (data?.events.length ?? 0)} onChange={(change) => setSelectedIds(change.target.checked ? data?.events.map((event) => event.id) ?? [] : [])}>本页全选</Checkbox>
      <span>已选 {selectedIds.length} 条</span>
      <Space wrap>
        {section !== 'trash' && section !== 'excluded' && <>
          <Button disabled={!selectedIds.length || loading} loading={mutationPending} onClick={() => void bulk({ favorite: true })}>收藏</Button>
          <Button disabled={!selectedIds.length || loading} onClick={() => void bulk({ archived: section !== 'archived' })}>{section === 'archived' ? '取消归档' : '归档'}</Button>
          <Button disabled={selectedIds.length < 2 || loading} onClick={() => { const ids = validSelection(); if (ids) setMergeIds(ids); }}>合并</Button>
        </>}
        {section === 'review' && <Button disabled={!selectedIds.length || loading} onClick={() => bulkStatus('excluded')}>排除</Button>}
        {(section === 'trash' || section === 'excluded') && <Button disabled={!selectedIds.length || loading} onClick={() => bulkStatus(section === 'excluded' ? 'review' : 'active')}>恢复</Button>}
        <Button danger icon={<DeleteOutlined />} disabled={!selectedIds.length || loading} onClick={() => bulkStatus(section === 'trash' ? 'delete' : 'trash')}>{section === 'trash' ? '永久删除' : '删除'}</Button>
      </Space>
    </div>}
    {initialLoadFailed ? <div className="surface-panel"><h2>资料暂时无法加载</h2><p className="muted">尚未获得可读取的结果。请使用上方“重试”重新加载。</p></div> : view === 'search' && !q ? <EmptyState title="从一个关键词开始" description="标题、摘要、模型与仓库名称、标签和你的备注都可以查找。默认不查询回收站。" /> : loading && !data ? <div className="surface-panel loading-panel"><Skeleton active paragraph={{ rows: 7 }} /></div> : !data?.events.length ? <EmptyState title={hasFilter ? '没有符合条件的资讯' : view === 'mine' ? `这里还没有${sectionLabel}内容` : '你的情报工作空间，准备就绪。'} description={emptyDescription} action={hasFilter ? <Button onClick={() => { setFilters({}); setQ(''); setSearchText(''); setFeedTab('all'); }}>清除条件</Button> : view === 'feed' ? <Space wrap><Button type="primary" onClick={() => navigate('sources')}>启用来源 <ArrowRightOutlined /></Button><Button icon={<LinkOutlined />} onClick={() => setEditingNew(true)}>添加第一条链接</Button></Space> : <Button onClick={() => navigate('feed')}>去浏览动态</Button>} /> : <div className="event-list">
      {view === 'feed' && page === 1 && !managing && <EventCard event={data.events[0]} featured onOpen={() => openEvent(data.events[0])} onFavorite={() => void toggleFavorite(data.events[0])} />}
      <div className="event-list-surface">{data.events.slice(view === 'feed' && page === 1 && !managing ? 1 : 0).map((event) => <EventCard key={event.id} event={event} managing={managing} selected={selectedIds.includes(event.id)} selectionDisabled={loading} onSelect={(checked) => setSelectedIds((old) => checked ? [...new Set([...old, event.id])] : old.filter((id) => id !== event.id))} onOpen={() => openEvent(event)} pending={mutationPending} onFavorite={() => void toggleFavorite(event)} />)}</div>
      {data.total > 20 && <div className="list-pagination"><Pagination current={page} total={data.total} pageSize={20} showSizeChanger={false} onChange={(next) => { setPage(next); setSelectedIds([]); setLoading(true); window.scrollTo({ top: 0 }); }} showTotal={(total) => `共 ${total} 条`} /></div>}
    </div>}
    {view === 'search' && matchingEntities.length > 0 && <section className="search-entities"><h2>相关模型与项目</h2><div className="search-entity-list">{matchingEntities.map((item) => <Button key={item.id} onClick={() => openEntity(item.id)} icon={item.kind === 'project' ? <GithubOutlined /> : <AppstoreOutlined />}>{item.name} <ArrowRightOutlined /></Button>)}</div></section>}
  </>;

  return <div className={`hub-app density-${density}`}>
    <a href="#main-content" className="skip-link">跳到主要内容</a>
    <aside className="app-sidebar"><button className="brand" onClick={() => navigate('feed')} aria-label="Hulinger AI 情报与资料首页"><strong className="brand-full">HULINGER</strong><strong className="brand-short" aria-hidden="true">HL</strong>{' '}<span>AI 情报与资料</span></button>{navigation}<div className="sidebar-bottom"><Dropdown menu={moreMenu} trigger={['click']} placement="topLeft"><button className="user-menu"><UserOutlined /><span>{auth?.user?.name || 'Hulinger'}</span><MoreOutlined /></button></Dropdown></div></aside>
    <header className="app-header"><div className="mobile-header-brand"><Button icon={<MenuOutlined />} type="text" aria-label="打开导航" onClick={() => setMobileNav(true)} /><strong>HULINGER</strong></div><div className="breadcrumb"><span>工作空间</span><span>/</span><strong>{currentTitle}</strong></div><div className="header-search"><Input ref={view === 'search' ? undefined : searchRef} prefix={<SearchOutlined />} suffix={<kbd>⌘ K</kbd>} aria-label="搜索 AI 动态、模型、开源项目" placeholder="搜索 AI 动态、模型、开源项目…" value={searchText} onChange={(change) => setSearchText(change.target.value)} onCompositionStart={() => { searchComposing.current = true; }} onCompositionEnd={() => { searchComposing.current = false; }} onPressEnter={(event) => { if (!event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) search(searchText); }} /></div><div className="mobile-header-actions"><Button icon={<SearchOutlined />} type="text" aria-label="全局搜索" onClick={() => navigate('search')} /><Dropdown menu={moreMenu} trigger={['click']}><Button type="text" icon={<UserOutlined />}>更多</Button></Dropdown></div></header>
    <main className="app-main" id="main-content"><div className="page-intro">{view === 'feed' && <p className="today-date">{new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' }).format(new Date())}</p>}<h1 tabIndex={-1}>{titles[view].title}</h1><p className="page-description">{titles[view].subtitle}</p></div>
      {error && (view !== 'drive' || !auth) && <div className="section-alert"><ErrorNotice error={error} retry={reload} /></div>}
      {loading && data && view !== 'drive' && <div className="refresh-status" role="status"><SyncOutlined spin /> 正在读取最新资料…</div>}
      {auth?.state === 'ready' && <div hidden={view !== 'drive'}><DrivePanel active={view === 'drive'} /></div>}
      <div className={showRail ? 'workspace-columns' : 'workspace-single'}>
        <div className="main-column">{showList && listContent}{(view === 'models' || view === 'projects') && (data ? <EntitiesPanel key={view} entities={data.entities} kind={view === 'projects' ? 'project' : 'model'} act={act} onOpen={openEntity} onSources={() => navigate('sources')} /> : loading ? <Skeleton active /> : null)}{view === 'sources' && (data ? <SourcesPanel sources={data.sources} runs={data.runs} act={act} onRefresh={reload} /> : loading ? <Skeleton active /> : null)}{view === 'settings' && auth?.state === 'ready' && <SettingsPanel user={auth.user} act={act} density={density} onDensity={(next) => { setDensity(next); window.localStorage.setItem('hulinger-density', next); }} onSources={() => navigate('sources')} />}</div>
        {showRail && <aside className="context-rail" aria-label="来源与稍后读"><section className="rail-card"><div className="rail-card-heading"><AppstoreOutlined /><h2>来源状态</h2><Button type="text" aria-label="查看全部来源" onClick={() => navigate('sources')}>全部 <ArrowRightOutlined /></Button></div><div className="rail-source-list">{data?.sources.length ? [...data.sources].sort((a, b) => Number(b.enabled) - Number(a.enabled)).slice(0, 3).map((source) => { const health = sourceHealth(source); return <button key={source.id} className="rail-source" onClick={() => navigate('sources')}><span className="rail-source-icon"><SourceIcon source={source} /></span><div><strong>{source.name}</strong><span>{source.id.includes('github') ? '开源项目与发布动态' : '模型更新与官方公告'}</span></div><span className={`status-text ${health.tone}`}>{health.label}</span></button>; }) : <p className="rail-empty">{loading ? '正在读取来源状态…' : '启用来源后，自动收集的状态会显示在这里。'}</p>}</div></section><section className="rail-card"><div className="rail-card-heading"><BookOutlined /><h2>稍后读</h2><Button type="text" icon={<ArrowRightOutlined />} aria-label="查看全部稍后读" onClick={() => navigate('mine', 'later')} /></div>{data?.later.length ? <div className="rail-later-list">{data.later.map((event) => <button key={event.id} onClick={() => openEvent(event)}>{event.title}</button>)}</div> : <div className="rail-empty"><p>先留住，慢慢读。</p><span>在资讯详情中加入稍后读，方便下次继续。</span></div>}</section><div className="rail-note"><CheckOutlined /><span>内容保留来源，个人整理由你掌握。</span></div></aside>}
      </div>
    </main>
    <nav className="mobile-bottom-nav" aria-label="手机主导航">{navItems.slice(0, 4).map((item) => <button key={item.key} className={view === item.key ? 'selected' : ''} aria-label={item.label} aria-current={view === item.key ? 'page' : undefined} onClick={() => navigate(item.key)}>{item.icon}<span>{item.mobile}</span></button>)}</nav>
    <Drawer open={mobileNav} title="工作空间" placement="left" onClose={() => setMobileNav(false)} size={280}>{navigation}<Button icon={<SettingOutlined />} block onClick={() => navigate('settings')}>设置与数据导出</Button></Drawer>
    <Drawer open={filterOpen} title="筛选资讯" size="min(420px, 100vw)" onClose={() => setFilterOpen(false)} destroyOnHidden>{filterError && <Alert type="error" showIcon title={filterError} className="section-alert" />}<Form key={JSON.stringify(filters)} layout="vertical" initialValues={filters} onFinish={(values: Filters) => {
      if (values.dateUnknown && (values.from || values.to)) { setFilterError('发布时间未知与日期范围不能同时选择，请保留其中一种条件。'); return; }
      if (values.from && values.to && values.from > values.to) { setFilterError('结束日期不能早于开始日期。'); return; }
      setFilters(values); setPage(1); setSelectedIds([]); setLoading(true); setFilterOpen(false);
    }}><Form.Item name="kind" label="内容类型"><Select allowClear options={kindOptions} placeholder="全部类型" /></Form.Item><Form.Item name="source" label="来源"><Select allowClear options={[...(data?.sources.map((source) => ({ value: source.name, label: source.name })) ?? []), { value: '人工补充', label: '人工补充' }]} placeholder="全部来源" /></Form.Item><Form.Item name="tag" label="标签"><Input placeholder="输入一个完整标签" /></Form.Item><div className="form-columns"><Form.Item name="from" label="发布日期从"><Input type="date" /></Form.Item><Form.Item name="to" label="发布日期至"><Input type="date" /></Form.Item></div><Form.Item name="dateUnknown" valuePropName="checked"><Checkbox>仅显示发布时间未知的内容</Checkbox></Form.Item><p className="muted">日期按北京时间筛选。发布时间未知的内容不进入已知日期范围，请勿同时选择这两种条件。</p><div className="form-actions"><Button onClick={() => { setFilters({}); setPage(1); setFilterOpen(false); }}>重置</Button><Button htmlType="submit" type="primary">应用筛选</Button></div></Form></Drawer>
    {editingNew && <EventEditor entities={data?.entities ?? []} act={act} onClose={() => setEditingNew(false)} />}
    {entity && <EntityDetail key={entity.id} entity={entity} epoch={epoch} act={act} onClose={() => { setEntityId(null); location(view, section, eventId, null); }} onEvent={openEvent} />}
    {entityId && data && !entity && <Drawer open title="实体资料" onClose={() => { setEntityId(null); location(view, section, eventId, null); }}><EmptyState title="当前范围内未找到这个对象" description="请清除搜索条件后重新查找，或检查实体是否已变更。" /></Drawer>}
    {eventId && <EventDetail key={eventId} id={eventId} epoch={epoch} entities={data?.entities ?? []} sources={data?.sources ?? []} act={act} onClose={() => { setEventId(null); location(view, section, null, entityId); }} onEntity={openEntity} onMerge={setMergeIds} onSplit={setSplitDetail} />}
    {mergeIds && <MergeDialog initialIds={mergeIds} candidates={data?.events ?? []} act={act} onClose={() => { setMergeIds(null); setSelectedIds([]); }} />}
    {splitDetail && <SplitDialog detail={splitDetail} act={act} onClose={() => { setSplitDetail(null); setEventId(null); location(view, section, null, entityId); }} />}
  </div>;
}
