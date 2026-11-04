'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Alert, App, Button, Descriptions, Select, Space, Table, Tag } from 'antd';
import { DownloadOutlined, LogoutOutlined, ReloadOutlined, SafetyCertificateOutlined } from '@ant-design/icons';
import { ApiError, errorMessage, postJson, requestJson, type AuthStatus, type HubAction } from './api';
import { dateText, EmptyState } from './format';

interface ExportJob { id: string; status: string; created_at: string; finished_at: string | null; error: string | null; expires_at: string | null }

export default function SettingsPanel({ user, act, density, onDensity, onSources }: { user?: AuthStatus['user']; act: HubAction; density: string; onDensity: (value: string) => void; onSources: () => void }) {
  const router = useRouter();
  const { modal } = App.useApp();
  const [exports, setExports] = useState<ExportJob[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState(false);
  const refresh = useCallback(async () => {
    try {
      const response = await requestJson<{ exports: ExportJob[] }>('/api/hub?exports=1');
      setExports(response.exports); setLoaded(true); setError('');
    } catch (cause) { setError(errorMessage(cause)); setLoaded(true); }
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    requestJson<{ exports: ExportJob[] }>('/api/hub?exports=1', { signal: controller.signal }).then((response) => {
      setExports(response.exports); setLoaded(true); setError('');
    }).catch((cause) => { if (!controller.signal.aborted) { setError(errorMessage(cause)); setLoaded(true); } });
    return () => controller.abort();
  }, []);
  const active = exports.some((job) => ['pending', 'queued', 'running'].includes(job.status));
  useEffect(() => {
    if (!active) return;
    const interval = window.setInterval(() => void refresh(), 5000);
    return () => window.clearInterval(interval);
  }, [active, refresh]);
  async function createExport() {
    setPending(true); setError('');
    try { await act({ action: 'export' }, '导出任务已创建，可以离开页面后回来下载'); await refresh(); }
    catch (cause) { setError(errorMessage(cause)); }
    finally { setPending(false); }
  }
  async function download(job: ExportJob) {
    setPending(true); setError('');
    try {
      const response = await fetch(`/api/hub/export?id=${encodeURIComponent(job.id)}`, { credentials: 'same-origin', cache: 'no-store' });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new ApiError(typeof body.error === 'string' ? body.error : '文件尚不可下载，请刷新任务状态。', response.status);
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = `hulinger-export-${job.id}.json`;
      document.body.appendChild(anchor); anchor.click(); anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setPending(false); }
  }
  return <div className="settings-grid">
    <section className="surface-panel settings-section"><h2><SafetyCertificateOutlined /> 你的工作空间</h2><p className="muted">单人私有，只有已配置的拥有者能够访问。</p><Descriptions column={1} items={[
      { key: 'name', label: '拥有者', children: user?.name || 'Hulinger' },
      { key: 'email', label: '登录邮箱', children: user?.email || '当前拥有者' },
      { key: 'mfa', label: '身份保护', children: <Tag color="green">双重验证已启用</Tag> },
      { key: 'timezone', label: '时间显示', children: 'Asia/Shanghai（北京时间）' },
    ]} /><div className="setting-row"><div><strong>列表密度</strong><p className="muted">仅保存在这台设备，不改变另一设备的阅读方式。</p></div><Select aria-label="列表密度" value={density} onChange={onDensity} options={[{ value: 'comfortable', label: '舒适' }, { value: 'compact', label: '紧凑' }]} /></div><Space wrap><Button onClick={onSources}>来源管理</Button><Button icon={<LogoutOutlined />} onClick={() => modal.confirm({ title: '退出当前工作空间？', content: '当前登录会话会在服务端撤销。', okText: '退出登录', cancelText: '取消', onOk: async () => { await postJson('/api/auth/sign-out', {}); router.replace('/login'); router.refresh(); } })}>退出登录</Button></Space></section>
    <section className="surface-panel settings-section"><div className="section-heading"><div><h2>带走你的资料</h2><p className="muted">完整导出资讯、来源、实体关系和个人整理。</p></div><Button type="primary" icon={<DownloadOutlined />} loading={pending} onClick={() => void createExport()}>创建导出</Button></div>
      <Alert type="info" showIcon title="结构化 JSON · 含格式版本与字段说明" description="包含收藏、关注、已读、标签、私人备注及必要修订；不包含密码或服务凭据。导出文件含私人资料，请妥善保存。数据导出不能替代服务器备份。" className="section-alert" />
      {error && <Alert type="error" showIcon title={error} className="section-alert" />}
      <div className="section-heading"><h3>导出记录</h3><Button type="text" icon={<ReloadOutlined />} onClick={() => void refresh()}>刷新</Button></div>
      <Table<ExportJob> rowKey="id" dataSource={exports} loading={!loaded} pagination={{ pageSize: 5, hideOnSinglePage: true }} scroll={{ x: 520 }} locale={{ emptyText: <EmptyState title="还没有导出记录" description="创建导出后，任务会在后台继续，稍后可以回来下载。" /> }} columns={[
        { title: '创建时间', dataIndex: 'created_at', render: (value: string) => dateText(value, true) },
        { title: '状态', render: (_, job) => <div><Tag color={['ready', 'completed', 'success'].includes(job.status) ? 'green' : job.status === 'failed' ? 'red' : 'blue'}>{({ pending: '等待生成', queued: '排队中', running: '生成中', ready: '可下载', completed: '可下载', success: '可下载', failed: '失败', expired: '已过期' } as Record<string, string>)[job.status] ?? job.status}</Tag>{job.error && <p className="muted">{job.error}</p>}{job.expires_at && <p className="muted">有效至 {dateText(job.expires_at, true)}</p>}</div> },
        { title: '操作', render: (_, job) => ['ready', 'completed', 'success'].includes(job.status) && (!job.expires_at || Date.parse(job.expires_at) > Date.now()) ? <Button type="link" icon={<DownloadOutlined />} loading={pending} onClick={() => void download(job)}>下载</Button> : job.status === 'failed' || job.status === 'expired' ? <Button type="link" onClick={() => void createExport()}>重新生成</Button> : <span className="muted">等待任务完成</span> },
      ]} />
    </section>
  </div>;
}
