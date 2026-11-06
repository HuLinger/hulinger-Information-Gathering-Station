'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Alert, Button, Checkbox, Form, Input, QRCode, Skeleton } from 'antd';
import { ArrowRightOutlined, LockOutlined, SafetyCertificateOutlined, UserOutlined } from '@ant-design/icons';
import { errorMessage, postJson, requestJson, type AuthStatus } from './api';

export default function Login() {
  const router = useRouter();
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [challenge, setChallenge] = useState(false);
  const [recovery, setRecovery] = useState(false);
  const [enrollment, setEnrollment] = useState<{ totpURI: string; backupCodes: string[] } | null>(null);
  const [savedCodes, setSavedCodes] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const next = await requestJson<AuthStatus>('/api/auth/status');
      setError('');
      if (next.state === 'ready') { router.replace('/'); return; }
      setStatus(next);
    } catch (cause) { setError(errorMessage(cause)); }
  }, [router]);
  useEffect(() => {
    const controller = new AbortController();
    requestJson<AuthStatus>('/api/auth/status', { signal: controller.signal }).then((next) => {
      if (next.state === 'ready') router.replace('/');
      else setStatus(next);
    }).catch((cause) => { if (!controller.signal.aborted) setError(errorMessage(cause)); });
    return () => controller.abort();
  }, [router]);

  async function login(values: { identifier: string; password: string }) {
    setPending(true); setError('');
    try {
      const identifier = values.identifier.trim();
      const result = await postJson<{ twoFactorRedirect?: boolean }>(identifier.includes('@') ? '/api/auth/sign-in/email' : '/api/auth/sign-in/username', {
        ...(identifier.includes('@') ? { email: identifier } : { username: identifier }),
        password: values.password,
        rememberMe: false,
      });
      if (result.twoFactorRedirect) setChallenge(true);
      else await refresh();
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setPending(false); }
  }

  async function enroll(values: { password: string }) {
    setPending(true); setError('');
    try {
      const result = await postJson<{ totpURI: string; backupCodes: string[] }>('/api/auth/two-factor/enable', values);
      setEnrollment(result);
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setPending(false); }
  }

  async function verify(values: { code: string }) {
    setPending(true); setError('');
    try {
      await postJson(`/api/auth/two-factor/${recovery ? 'verify-backup-code' : 'verify-totp'}`, { code: values.code.trim(), trustDevice: false });
      setEnrollment(null);
      setChallenge(false);
      await refresh();
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setPending(false); }
  }

  const secret = enrollment ? new URL(enrollment.totpURI).searchParams.get('secret') : '';
  const title = enrollment ? '连接你的验证器' : status?.state === 'setup-mfa' ? '为私人资料加一道保护' : challenge ? '确认是你本人' : '回到你的工作空间';

  return <main className="login-page">
    <a href="/login" className="brand login-brand" aria-label="Hulinger AI 情报与资料登录页"><strong>HULINGER</strong><span>AI 情报与资料</span></a>
    <section className={`login-card${enrollment ? ' enrollment-card' : ''}`} aria-labelledby="login-title">
      <div className="login-symbol"><SafetyCertificateOutlined /></div>
      <div className="eyebrow">YOUR PRIVATE WORKSPACE</div>
      <h1 id="login-title">{title}</h1>
      <p className="login-intro">{challenge ? '请输入验证器中的动态验证码。' : status?.state === 'setup-mfa' ? '主账号首次使用需要设置双重验证，保护账号管理操作。' : '关注模型的变化，收集值得留下的发现。'}</p>
      {error && <Alert type="error" showIcon title={error} className="section-alert" action={!status ? <Button onClick={() => void refresh()}>重试</Button> : undefined} />}
      {!status && !error && <Skeleton active paragraph={{ rows: 4 }} />}
      {status?.state === 'unconfigured' && <Alert type="info" showIcon title="工作空间尚未初始化" description="请由站点部署者完成拥有者配置，然后刷新此页面。此站点不开放公众注册。" action={<Button onClick={() => void refresh()}>刷新状态</Button>} />}
      {status?.state === 'signed-out' && !challenge && <Form layout="vertical" onFinish={login} requiredMark={false}>
        <Form.Item name="identifier" label="用户名或邮箱" extra="主账号可使用 admin 或已配置邮箱；成员使用分配的用户名。" rules={[{ required: true, whitespace: true, message: '请输入用户名或邮箱' }, { max: 254, message: '用户名或邮箱过长' }]}><Input prefix={<UserOutlined />} autoComplete="username" autoCapitalize="none" spellCheck={false} placeholder="admin 或成员用户名" /></Form.Item>
        <Form.Item name="password" label="密码" rules={[{ required: true, message: '请输入密码' }]}><Input.Password prefix={<LockOutlined />} autoComplete="current-password" placeholder="输入密码" /></Form.Item>
        <Button type="primary" htmlType="submit" block loading={pending} icon={<ArrowRightOutlined />} iconPlacement="end">进入工作空间</Button>
      </Form>}
      {status?.state === 'setup-mfa' && !enrollment && <Form layout="vertical" onFinish={enroll} requiredMark={false}>
        <Form.Item name="password" label="确认登录密码" rules={[{ required: true, message: '请输入密码以开启双重验证' }]}><Input.Password prefix={<LockOutlined />} autoComplete="current-password" /></Form.Item>
        <Button type="primary" htmlType="submit" block loading={pending}>设置验证器</Button>
      </Form>}
      {enrollment && <div className="enrollment">
        <p>1. 用你的验证器扫描二维码，或手动添加下方密钥。</p>
        <div className="qr-wrap"><QRCode value={enrollment.totpURI} size={184} /></div>
        <details><summary>手动输入密钥</summary><code className="secret-value">{secret}</code></details>
        <p>2. 将恢复码保存在离线安全位置。每个恢复码只能使用一次。</p>
        <pre className="backup-codes">{enrollment.backupCodes.join('\n')}</pre>
        <Checkbox checked={savedCodes} onChange={(event) => setSavedCodes(event.target.checked)}>我已安全保存恢复码</Checkbox>
      </div>}
      {(challenge || enrollment) && <Form key={recovery ? 'recovery' : 'totp'} layout="vertical" className="verification-form" onFinish={verify} requiredMark={false}>
        <Form.Item name="code" label={recovery ? '一次性恢复码' : '六位验证码'} rules={[{ required: true, message: recovery ? '请输入恢复码' : '请输入验证码' }, ...(recovery ? [] : [{ pattern: /^\d{6}$/, message: '请输入六位数字验证码' }])]}>
          <Input autoComplete="one-time-code" inputMode={recovery ? 'text' : 'numeric'} maxLength={recovery ? 100 : 6} placeholder={recovery ? '输入一条尚未使用的恢复码' : '000000'} className={recovery ? '' : 'totp-input'} />
        </Form.Item>
        <Button type="primary" htmlType="submit" block loading={pending} disabled={!!enrollment && !savedCodes}>验证并进入</Button>
        {challenge && <Button type="link" block onClick={() => { setRecovery(!recovery); setError(''); }}>{recovery ? '使用验证器验证码' : '无法使用验证器？使用恢复码'}</Button>}
      </Form>}
      {status?.state === 'setup-mfa' && <Button type="link" className="login-signout" onClick={async () => {
        try { await postJson('/api/auth/sign-out', {}); setEnrollment(null); setSavedCodes(false); await refresh(); } catch (cause) { setError(errorMessage(cause)); }
      }}>返回登录</Button>}
      <div className="login-private"><LockOutlined /> 私有站点 · 账号独立 · 你的资料由你掌握</div>
    </section>
    <footer className="login-footer">信息有出处，关注有方向。</footer>
  </main>;
}
