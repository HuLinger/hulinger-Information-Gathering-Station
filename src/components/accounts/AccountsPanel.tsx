'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Alert, App, Button, Form, Input, Modal, Pagination, Select, Skeleton, Space, Tabs, Tag } from 'antd';
import { EditOutlined, KeyOutlined, LockOutlined, PlusOutlined, ReloadOutlined, SafetyCertificateOutlined, StopOutlined, UnlockOutlined, UserOutlined } from '@ant-design/icons';
import type { AccountsResponse, LoginEventPage, MemberAccount } from '../../shared/accounts-contracts';
import { ApiError, errorMessage, postJson, requestJson } from '../api';
import { dateText, EmptyState } from '../format';
import { useReturnFocus } from '../useReturnFocus';

type AccountDialog = { kind: 'create' } | { kind: 'rename' | 'password'; account: MemberAccount };
interface AccountValues { username?: string; name?: string; password?: string; confirmPassword?: string }

export default function AccountsPanel() {
  const router = useRouter();
  const { modal, message } = App.useApp();
  const [accounts, setAccounts] = useState<MemberAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [epoch, setEpoch] = useState(0);
  const [tab, setTab] = useState('accounts');
  const [dialog, setDialog] = useState<AccountDialog | null>(null);
  const [pending, setPending] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    requestJson<AccountsResponse>('/api/accounts', { signal: controller.signal }).then((result) => {
      setAccounts(result.accounts); setError(''); setLoading(false);
    }).catch((cause) => {
      if (controller.signal.aborted) return;
      if (cause instanceof ApiError && cause.status === 401) { setAccounts([]); router.replace('/login'); return; }
      setError(errorMessage(cause)); setLoading(false);
    });
    return () => controller.abort();
  }, [epoch, router]);

  function refresh() { setLoading(true); setEpoch((value) => value + 1); }

  function confirmAction(account: MemberAccount, action: 'disable' | 'enable' | 'revoke') {
    const labels = { disable: '停用账号', enable: '启用账号', revoke: '撤销全部登录' };
    const content = action === 'disable' ? '该成员会退出所有已登录设备，无法再次登录。已保存的资料会保留，之后可以重新启用。' : action === 'enable' ? '该成员可以重新使用原用户名和当前密码登录。' : '该成员的所有设备都会退出登录。账号和已保存资料会保留，成员可以重新登录。';
    const confirmation = modal.confirm({
      title: labels[action] + '：' + (account.username ?? account.name) + '？',
      content,
      okText: labels[action],
      cancelText: '取消',
      focusable: { autoFocusButton: 'cancel' },
      okButtonProps: { danger: action !== 'enable' },
      onOk: async () => {
        setPending(account.id); setError('');
        try {
          if (action === 'revoke') await postJson('/api/accounts/' + encodeURIComponent(account.id) + '/revoke-sessions', {});
          else await requestJson('/api/accounts/' + encodeURIComponent(account.id), { method: 'PATCH', body: JSON.stringify({ disabled: action === 'disable' }) });
          void message.success(action === 'revoke' ? '该成员的全部登录已撤销' : action === 'disable' ? '账号已停用，已有登录已撤销' : '账号已启用');
          refresh();
        } catch (cause) {
          const detail = errorMessage(cause);
          setError(detail);
          confirmation.update({ content: <><p>{content}</p><Alert type="error" showIcon title={detail} /></> });
          throw cause;
        }
        finally { setPending(null); }
      },
    });
  }

  return <section className="accounts-panel" aria-label="账号管理">
    <Tabs activeKey={tab} onChange={setTab} items={[{ key: 'accounts', label: '成员账号' }, { key: 'logins', label: '登录记录' }]} />
    {tab === 'accounts' ? <>
      <div className="accounts-toolbar">
        <div><h2>管理受邀成员</h2><p className="muted">成员使用用户名和密码登录，拥有独立的资讯、文件与工具数据。</p></div>
        <Space wrap><Button icon={<ReloadOutlined />} loading={loading} onClick={refresh}>刷新</Button><Button type="primary" icon={<PlusOutlined />} disabled={!!pending} onClick={() => setDialog({ kind: 'create' })}>创建成员</Button></Space>
      </div>
      {error && <Alert type="error" showIcon title={error} className="section-alert" action={<Button onClick={refresh}>重试</Button>} />}
      {loading && !accounts.length ? <div className="surface-panel"><Skeleton active paragraph={{ rows: 5 }} /></div> : <div className="account-list" aria-busy={loading}>
        {accounts.map((account) => <article className="account-row surface-panel" key={account.id}>
          <div className="account-identity"><div className="account-name"><UserOutlined /><h3>{account.name}</h3><Tag color={account.role === 'owner' ? 'blue' : account.disabled ? 'default' : 'success'}>{account.role === 'owner' ? '主账号' : account.disabled ? '已停用' : '已启用'}</Tag></div><p className="account-handle">用户名：{account.username ?? (account.role === 'owner' ? 'admin' : '未设置')}</p><p className="account-meta">创建于 {dateText(account.createdAt, true)}<span>最近登录：{account.lastLoginAt ? dateText(account.lastLoginAt, true) : '尚未登录'}</span></p></div>
          {account.role === 'owner' ? <span className="account-owner-note"><SafetyCertificateOutlined /> 主账号保留双重验证</span> : <Space wrap className="account-actions">
            <Button icon={<EditOutlined />} disabled={!!pending || loading} onClick={() => setDialog({ kind: 'rename', account })}>修改名称</Button>
            <Button icon={<KeyOutlined />} disabled={!!pending || loading} onClick={() => setDialog({ kind: 'password', account })}>重置密码</Button>
            <Button icon={<LockOutlined />} disabled={!!pending || loading} onClick={() => confirmAction(account, 'revoke')}>撤销登录</Button>
            <Button danger={!account.disabled} icon={account.disabled ? <UnlockOutlined /> : <StopOutlined />} loading={pending === account.id} disabled={!!pending || loading} onClick={() => confirmAction(account, account.disabled ? 'enable' : 'disable')}>{account.disabled ? '启用账号' : '停用账号'}</Button>
          </Space>}
        </article>)}
        {!accounts.some((account) => account.role === 'member') && !error && <EmptyState title="还没有成员账号" description="创建一个成员账号，再将用户名和初始密码私下交给对方。新成员的数据从空工作空间开始。" />}
      </div>}
    </> : <LoginEventsPanel accounts={accounts} />}
    {dialog && <AccountEditor key={dialog.kind === 'create' ? 'create' : dialog.kind + dialog.account.id} dialog={dialog} onClose={() => setDialog(null)} onSaved={() => { setDialog(null); refresh(); }} />}
  </section>;
}

function AccountEditor({ dialog, onClose, onSaved }: { dialog: AccountDialog; onClose: () => void; onSaved: () => void }) {
  useReturnFocus();
  const { modal, message } = App.useApp();
  const [form] = Form.useForm<AccountValues>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const creating = dialog.kind === 'create';
  const password = dialog.kind !== 'rename';
  const title = creating ? '创建成员账号' : dialog.kind === 'rename' ? '修改成员名称' : '重置成员密码';

  function close() {
    if (pending) return;
    if (!form.isFieldsTouched()) { onClose(); return; }
    modal.confirm({ title: '放弃尚未保存的修改？', content: '本次填写的内容尚未保存。', okText: '放弃修改', cancelText: '继续编辑', onOk: onClose });
  }

  async function submit(values: AccountValues) {
    setPending(true); setError('');
    try {
      if (dialog.kind === 'create') await postJson('/api/accounts', { username: values.username?.trim(), name: values.name?.trim() || undefined, password: values.password });
      else if (dialog.kind === 'rename') await requestJson('/api/accounts/' + encodeURIComponent(dialog.account.id), { method: 'PATCH', body: JSON.stringify({ name: values.name?.trim() }) });
      else await postJson('/api/accounts/' + encodeURIComponent(dialog.account.id) + '/password', { password: values.password });
      void message.success(creating ? '成员账号已创建，请私下告知对方用户名和密码' : dialog.kind === 'rename' ? '成员名称已更新' : '密码已重置，旧登录已撤销');
      form.resetFields();
      onSaved();
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setPending(false); }
  }

  return <Modal open title={title} onCancel={close} closable={!pending} keyboard={!pending} mask={{ closable: !pending }} destroyOnHidden footer={<Space><Button disabled={pending} onClick={close}>取消</Button><Button type="primary" htmlType="submit" form="account-editor-form" loading={pending}>{creating ? '创建账号' : '保存'}</Button></Space>}>
    {error && <Alert type="error" showIcon title={error} className="section-alert" />}
    {!creating && <p className="muted">成员：{dialog.account.username ?? dialog.account.name}</p>}
    {dialog.kind === 'password' && <Alert type="warning" showIcon title="重置后会撤销该成员的全部登录" description="新密码保存后生效，请私下告知成员。" className="section-alert" />}
    <Form id="account-editor-form" form={form} layout="vertical" requiredMark={false} preserve={false} initialValues={{ name: dialog.kind === 'rename' ? dialog.account.name : undefined }} onFinish={submit}>
      {creating && <Form.Item name="username" label="用户名" extra="3–32 个字符，以字母或数字开头，可包含下划线、点或短横线；创建后固定。" rules={[{ required: true, message: '请输入成员用户名' }, { pattern: /^[A-Za-z0-9][A-Za-z0-9_.-]{2,31}$/, message: '请输入 3–32 个字符，以字母或数字开头，仅包含字母、数字、下划线、点或短横线' }, { validator: (_, value: string | undefined) => value?.toLowerCase() === 'admin' ? Promise.reject(new Error('admin 为主账号保留，请选择其他用户名')) : Promise.resolve() }]}><Input autoComplete="off" autoCapitalize="none" spellCheck={false} maxLength={32} placeholder="例如 reader01" /></Form.Item>}
      {dialog.kind !== 'password' && <Form.Item name="name" label={creating ? '显示名称（可选）' : '显示名称'} rules={[...(creating ? [] : [{ required: true, whitespace: true, message: '请输入显示名称' }]), { max: 80, message: '显示名称最多 80 个字符' }]}><Input autoComplete="off" maxLength={80} placeholder={creating ? '未填写时使用用户名' : '输入新的显示名称'} /></Form.Item>}
      {password && <>
        <Form.Item name="password" label={creating ? '初始密码' : '新密码'} extra="14–128 个字符。成员不需要绑定验证器。" rules={[{ required: true, message: '请输入密码' }, { min: 14, max: 128, message: '密码长度需为 14–128 个字符' }]}><Input.Password autoComplete="new-password" maxLength={128} /></Form.Item>
        <Form.Item name="confirmPassword" label="再次输入密码" dependencies={['password']} rules={[{ required: true, message: '请再次输入密码' }, ({ getFieldValue }) => ({ validator: (_, value: string) => !value || getFieldValue('password') === value ? Promise.resolve() : Promise.reject(new Error('两次输入的密码不一致')) })]}><Input.Password autoComplete="new-password" maxLength={128} /></Form.Item>
      </>}
    </Form>
  </Modal>;
}

function LoginEventsPanel({ accounts }: { accounts: MemberAccount[] }) {
  const router = useRouter();
  const [data, setData] = useState<LoginEventPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [page, setPage] = useState(1);
  const [accountId, setAccountId] = useState<string | undefined>();
  const [epoch, setEpoch] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams({ page: String(page) });
    if (accountId) params.set('accountId', accountId);
    requestJson<LoginEventPage>('/api/accounts/login-events?' + params, { signal: controller.signal }).then((result) => {
      setData(result); setError(''); setLoading(false);
    }).catch((cause) => {
      if (controller.signal.aborted) return;
      if (cause instanceof ApiError && cause.status === 401) { setData(null); router.replace('/login'); return; }
      setError(errorMessage(cause)); setLoading(false);
    });
    return () => controller.abort();
  }, [accountId, epoch, page, router]);

  return <section aria-label="登录记录" className="login-events-panel">
    <div className="accounts-toolbar"><div><h2>最近 30 天的登录记录</h2><p className="muted">区分密码和验证器步骤，网络地址按脱敏前缀展示。</p></div><Space wrap><Select aria-label="筛选登录账号" className="login-account-filter" value={accountId} allowClear placeholder="全部账号" options={accounts.map((account) => ({ value: account.id, label: account.name + '（' + (account.username ?? 'admin') + '）' }))} onChange={(value: string | undefined) => { setAccountId(value); setPage(1); setLoading(true); }} /><Button icon={<ReloadOutlined />} loading={loading} onClick={() => { setLoading(true); setEpoch((value) => value + 1); }}>刷新记录</Button></Space></div>
    {error && <Alert type="error" showIcon title={error} className="section-alert" />}
    {loading && !data ? <div className="surface-panel"><Skeleton active paragraph={{ rows: 5 }} /></div> : data?.events.length ? <>
      <ul className="login-event-list" aria-busy={loading}>{data.events.map((event) => <li className="surface-panel login-event-row" key={event.id}>
        <div className="login-event-summary"><strong>{event.username || '未识别账号'}</strong><Tag color={event.outcome === 'success' ? 'success' : 'error'}>{event.outcome === 'success' ? '验证成功' : '验证失败'}</Tag><span className="muted">{({ password: '密码', totp: '验证器', 'backup-code': '恢复码' } as const)[event.method]}</span><time dateTime={event.occurredAt}>{dateText(event.occurredAt, true)}</time></div>
        <div className="login-event-details"><span>网络前缀：{event.ipPrefix || '未知'}</span>{event.userAgent && <details><summary>浏览器信息</summary><p>{event.userAgent}</p></details>}</div>
      </li>)}</ul>
      <div className="list-pagination"><Pagination current={page} total={data.total} pageSize={data.pageSize} showSizeChanger={false} hideOnSinglePage onChange={(next) => { setPage(next); setLoading(true); }} showTotal={(total) => '共 ' + total + ' 条记录'} /></div>
    </> : !error && <EmptyState title={accountId ? '这个账号还没有登录记录' : '还没有登录记录'} description="之后的登录尝试会显示在这里；更早的历史不会补造记录。" />}
  </section>;
}
