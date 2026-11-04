'use client';

import { useState } from 'react';
import { Alert, Button, Descriptions, Drawer, Form, Select, Space, Switch, Table, Tabs, Tag } from 'antd';
import { ArrowRightOutlined, FileTextOutlined, GithubOutlined, ReloadOutlined, SettingOutlined, SyncOutlined } from '@ant-design/icons';
import type { Source, SyncRun } from '../shared/contracts';
import { errorMessage, type HubAction } from './api';
import { dateText, EmptyState, ExternalLink, sourceHealth } from './format';

const runLabels: Record<string, string> = { queued: '排队中', pending: '等待执行', running: '同步中', success: '成功', completed: '成功', partial: '部分成功', failed: '失败', error: '失败', partial_success: '部分成功' };
export function SourceIcon({ source }: { source: Source }) { return source.id.includes('github') ? <GithubOutlined /> : <FileTextOutlined />; }

export default function SourcesPanel({ sources, runs, act, onRefresh }: { sources: Source[]; runs: SyncRun[]; act: HubAction; onRefresh: () => void }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [tab, setTab] = useState('sources');
  const selected = sources.find((source) => source.id === selectedId);
  const selectedRun = runs.find((run) => run.id === selectedRunId);
  async function action(body: Record<string, unknown>, success: string) {
    setPendingId(String(body.id ?? '')); setError('');
    try { await act(body, success); }
    catch (cause) { setError(errorMessage(cause)); }
    finally { setPendingId(null); }
  }
  return <section>
    {error && <Alert type="error" showIcon title={error} className="section-alert" />}
    <div className="panel-toolbar"><Tabs activeKey={tab} onChange={setTab} items={[{ key: 'sources', label: '已支持来源' }, { key: 'runs', label: '同步任务' }]} /><Button icon={<ReloadOutlined />} onClick={onRefresh}>刷新状态</Button></div>
    {tab === 'sources' && <>
      <p className="muted">从已验证的公开来源开始。启用时会检查连接与解析，暂停不会删除已有资料。</p>
      {!sources.length && <EmptyState title="暂未配置来源" description="来源配置尚未准备好，请稍后刷新或联系部署者。" action={<Button onClick={onRefresh}>刷新</Button>} />}
      <div className="source-grid">{sources.map((source) => {
        const health = sourceHealth(source);
        return <article className="source-tile" key={source.id}>
          <div className="source-tile-heading"><span className="source-tile-icon"><SourceIcon source={source} /></span><div><h2>{source.name}</h2><span className={`status-text ${health.tone}`}>{health.label}</span></div><Switch checked={source.enabled} checkedChildren="已启用" unCheckedChildren="未启用" loading={pendingId === source.id} aria-label={`${source.enabled ? '暂停' : '启用'}${source.name}`} onChange={(enabled) => void action({ action: 'source', id: source.id, enabled }, enabled ? '来源已启用' : '来源已暂停，历史资料保留')} /></div>
          <p className="source-url"><ExternalLink href={source.url}>{source.url}</ExternalLink></p>
          <div className="source-times"><span>采集计划 <strong>每 {source.interval_minutes} 分钟</strong></span><span>最近成功 <strong>{dateText(source.last_success, true)}</strong></span></div>
          {source.error && <p className="source-error">{source.error}</p>}
          {source.coverage && <p className="muted">{source.coverage}</p>}
          <div className="source-tile-actions"><Button icon={<SettingOutlined />} onClick={() => setSelectedId(source.id)}>来源详情</Button><Button type="primary" ghost icon={<SyncOutlined />} disabled={!source.enabled} loading={pendingId === source.id} onClick={() => void action({ action: 'sync', id: source.id }, '同步任务已排队')}>立即同步</Button></div>
        </article>;
      })}</div>
      <div className="info-footnote">采集范围限于已登记入口。列表刷新读取本站资料，立即同步才会请求来源；重复请求会合并，来源配额仍然生效。</div>
    </>}
    {tab === 'runs' && <div className="surface-panel"><Table<SyncRun> dataSource={runs} rowKey="id" pagination={{ pageSize: 10, hideOnSinglePage: true }} locale={{ emptyText: <EmptyState title="还没有同步任务" description="启用一个来源并立即同步，任务结果会保留在这里。" /> }} scroll={{ x: 680 }} columns={[
      { title: '来源', dataIndex: 'source_id', render: (value: string) => sources.find((source) => source.id === value)?.name ?? value },
      { title: '状态', dataIndex: 'status', render: (value: string) => <Tag color={value === 'failed' ? 'red' : value === 'success' ? 'green' : 'blue'}>{runLabels[value] ?? value}</Tag> },
      { title: '开始时间', dataIndex: 'started_at', render: (value: string) => dateText(value, true) },
      { title: '新增 / 更新', render: (_, run) => `${run.added} / ${run.updated}` },
      { title: '详情', render: (_, run) => <Button type="link" onClick={() => setSelectedRunId(run.id)}>查看 <ArrowRightOutlined /></Button> },
    ]} /></div>}
    {selected && <Drawer open size="min(640px, 100vw)" title={selected.name} onClose={() => setSelectedId(null)}>
      {error && <Alert type="error" showIcon title={error} className="section-alert" />}
      <Alert type={selected.error ? 'warning' : 'info'} showIcon title={sourceHealth(selected).label} description={sourceHealth(selected).description} className="section-alert" />
      <Descriptions column={1} items={[
        { key: 'url', label: '登记入口', children: <ExternalLink href={selected.url}>{selected.url}</ExternalLink> },
        { key: 'type', label: '接入方式', children: selected.kind },
        { key: 'interval', label: '计划周期', children: `每 ${selected.interval_minutes} 分钟` },
        { key: 'attempt', label: '最后尝试', children: dateText(selected.last_attempt, true) },
        { key: 'success', label: '最后成功', children: dateText(selected.last_success, true) },
        { key: 'next', label: '下次计划', children: selected.enabled ? dateText(selected.next_run, true) : '已暂停' },
        { key: 'coverage', label: '覆盖情况', children: selected.coverage || '尚无成功采集记录' },
      ]} />
      {selected.id === 'github-projects' && <Form key={`${selected.id}-${JSON.stringify(selected.config)}`} layout="vertical" initialValues={{ topic: selected.config.topic ?? 'artificial-intelligence', includePrereleases: selected.config.includePrereleases === true }} onFinish={(config) => void action({ action: 'source', id: selected.id, config }, '来源范围已更新')} className="section-top">
        <Form.Item name="topic" label="项目发现主题"><Select options={[{ value: 'artificial-intelligence', label: '人工智能' }, { value: 'llm', label: '大语言模型' }, { value: 'machine-learning', label: '机器学习' }, { value: 'generative-ai', label: '生成式 AI' }]} /></Form.Item>
        <Form.Item name="includePrereleases" label="包含预发布版本" valuePropName="checked"><Switch /></Form.Item>
        <Button type="primary" htmlType="submit" loading={pendingId === selected.id}>验证并保存范围</Button>
      </Form>}
      <Space wrap className="section-top"><Button icon={<SyncOutlined />} disabled={!selected.enabled} loading={pendingId === selected.id} onClick={() => void action({ action: 'sync', id: selected.id }, '同步任务已排队')}>立即同步</Button><Button onClick={() => { setTab('runs'); setSelectedId(null); }}>查看同步任务</Button></Space>
      <p className="info-footnote">来源凭据由部署环境安全配置，此页面不会显示密钥。恢复采集只能补入来源仍然提供的内容，实际缺口会记录在覆盖情况中。</p>
    </Drawer>}
    {selectedRun && <Drawer open title="同步任务详情" size="min(600px, 100vw)" onClose={() => setSelectedRunId(null)}>
      {error && <Alert type="error" showIcon title={error} className="section-alert" />}
      <Descriptions column={1} items={[
        { key: 'source', label: '来源', children: sources.find((source) => source.id === selectedRun.source_id)?.name ?? selectedRun.source_id },
        { key: 'status', label: '运行状态', children: runLabels[selectedRun.status] ?? selectedRun.status },
        { key: 'start', label: '开始时间', children: dateText(selectedRun.started_at, true) },
        { key: 'finish', label: '完成时间', children: selectedRun.finished_at ? dateText(selectedRun.finished_at, true) : '尚未完成' },
        { key: 'counts', label: '处理结果', children: `新增 ${selectedRun.added} · 更新 ${selectedRun.updated} · 跳过 ${selectedRun.skipped}` },
        { key: 'coverage', label: '覆盖范围', children: selectedRun.coverage || '尚无覆盖报告' },
      ]} />
      {selectedRun.error && <Alert type="error" showIcon title="采集未完整完成" description={selectedRun.error} className="section-alert" />}
      <Button className="section-top" icon={<ReloadOutlined />} loading={pendingId === selectedRun.source_id} onClick={() => void action({ action: 'sync', id: selectedRun.source_id }, '重试任务已排队')}>重新同步此来源</Button>
    </Drawer>}
  </section>;
}
