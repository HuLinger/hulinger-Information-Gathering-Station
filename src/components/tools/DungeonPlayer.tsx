'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Alert, App, Button, Modal, Result, Space, Typography } from 'antd';
import { ArrowLeftOutlined, DownloadOutlined, FullscreenOutlined, InfoCircleOutlined, ReloadOutlined, SaveOutlined } from '@ant-design/icons';
import styles from './DungeonPlayer.module.css';

const CHANNEL = 'hulinger-dungeon-v1';
const ASSETS = '/api/tools/shattered-pixel-dungeon/assets';
const states = ['loading', 'playing', 'saving', 'saved', 'error', 'conflict', 'unauthorized'] as const;
type State = typeof states[number];
type Status = { state: State; message: string; updatedAt: string | null; dirty: boolean; ready: boolean };
const initialStatus: Status = { state: 'loading', message: '正在读取当前账号存档…', updatedAt: null, dirty: false, ready: false };

function discardBrowserRun(namespace: string | null) {
  if (!namespace || !/^hulinger-spd-[A-Za-z0-9%_-]+$/u.test(namespace)) return;
  try {
    const prefix = `pref:${namespace}:`;
    for (const key of Object.keys(localStorage)) if (key.startsWith(prefix)) localStorage.removeItem(key);
    // The old frame's connection closes when React removes it. A blocked
    // deletion remains queued until then, without touching another run.
    indexedDB.deleteDatabase(namespace);
  } catch { /* Storage can be disabled after the page loaded; no server data is affected. */ }
}

export default function DungeonPlayer() {
  const { modal, message } = App.useApp();
  const router = useRouter();
  const frame = useRef<HTMLIFrameElement>(null);
  const game = useRef<HTMLDivElement>(null);
  const namespace = useRef<string | null>(null);
  const exitRequested = useRef(false);
  const identityExpired = useRef(false);
  const [status, setStatus] = useState<Status>(initialStatus);
  const [run, setRun] = useState(0);
  const [leaving, setLeaving] = useState(false);
  const [help, setHelp] = useState(false);

  useEffect(() => {
    function receive(event: MessageEvent) {
      if (event.origin !== location.origin || event.source !== frame.current?.contentWindow || event.data?.channel !== CHANNEL) return;
      if (identityExpired.current) return;
      const data = event.data;
      if (data.type === 'storage' && typeof data.namespace === 'string') namespace.current = data.namespace;
      if (data.type === 'status' && states.includes(data.state) && typeof data.message === 'string') {
        setStatus({ state: data.state, message: data.message, updatedAt: typeof data.updatedAt === 'string' ? data.updatedAt : null, dirty: data.dirty === true, ready: data.ready === true });
        if (data.state === 'unauthorized') {
          identityExpired.current = true;
          discardBrowserRun(namespace.current);
          namespace.current = null;
          exitRequested.current = false;
          setLeaving(false);
        }
      }
      if (data.type === 'exit-result' && exitRequested.current) {
        exitRequested.current = false;
        setLeaving(false);
        if (data.success === true) router.push('/?view=tools');
        else modal.confirm({
          title: '进度尚未同步',
          content: '离开会丢失尚未上传的本次进度。建议留在这里重试，或先下载进度备份。',
          okText: '仍然离开', cancelText: '留在游戏', okButtonProps: { danger: true },
          onOk: () => router.push('/?view=tools'),
        });
      }
    }
    window.addEventListener('message', receive);
    // The frame may report an early load failure before React has hydrated.
    // Request its latest status after the listener is installed.
    frame.current?.contentWindow?.postMessage({ channel: CHANNEL, type: 'status-request' }, location.origin);
    return () => { window.removeEventListener('message', receive); discardBrowserRun(namespace.current); };
  }, [modal, router]);

  function command(type: 'save' | 'export' | 'save-and-exit' | 'status-request') {
    frame.current?.contentWindow?.postMessage({ channel: CHANNEL, type }, location.origin);
  }
  function leave() {
    if (!status.ready || status.state === 'unauthorized') { router.push('/?view=tools'); return; }
    exitRequested.current = true;
    setLeaving(true);
    command('save-and-exit');
  }
  function reload() {
    const restart = () => {
      discardBrowserRun(namespace.current);
      namespace.current = null;
      identityExpired.current = false;
      setStatus(initialStatus);
      setRun((current) => current + 1);
    };
    if (status.ready && (status.dirty || status.state === 'conflict')) {
      modal.confirm({ title: '重新载入云端存档？', content: '本次尚未同步的进度会被丢弃。需要保留时，请先下载进度备份。', okText: '载入云端', cancelText: '取消', onOk: restart });
    } else restart();
  }
  async function fullscreen() {
    try {
      if (!game.current?.requestFullscreen) { void message.info('当前浏览器不支持网页全屏，可以直接使用当前游戏画面。'); return; }
      await game.current.requestFullscreen();
    } catch { void message.error('未能进入全屏，请直接使用当前游戏画面。'); }
  }

  const blocked = status.state === 'conflict' || status.state === 'unauthorized';
  return <main className={styles.page}>
    <header className={styles.toolbar}>
      <div className={styles.leading}>
        <Button icon={<ArrowLeftOutlined />} onClick={leave} loading={leaving}>小工具</Button>
        <h1 className={styles.heading}>破碎的像素地牢</h1>
      </div>
      <div className={styles.actions}>
        <Button type="primary" icon={<SaveOutlined />} onClick={() => command('save')} disabled={!status.ready || blocked} loading={status.state === 'saving'}>同步进度</Button>
        <Button icon={<FullscreenOutlined />} onClick={() => void fullscreen()} disabled={!status.ready || blocked}>全屏</Button>
        <Button icon={<InfoCircleOutlined />} onClick={() => setHelp(true)} aria-label="操作说明与游戏源码">说明</Button>
      </div>
    </header>
    <div className={styles.status} role="status" aria-live="polite">
      <span>{status.message}</span>
      {status.updatedAt && <span>上次同步 {new Date(status.updatedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>}
    </div>
    {(status.state === 'error' || status.state === 'conflict') && <Alert className={styles.notice} showIcon type={status.state === 'conflict' ? 'warning' : 'error'}
      title={status.state === 'conflict' ? '存档版本冲突' : status.ready ? '进度尚未同步' : '游戏尚未载入'} description={status.message}
      action={<Space wrap>
        {status.ready && <Button icon={<DownloadOutlined />} onClick={() => command('export')}>下载进度备份</Button>}
        <Button icon={<ReloadOutlined />} onClick={reload}>重新载入云端</Button>
      </Space>} />}
    {status.state === 'unauthorized'
      ? <div className={styles.empty}><Result status="403" title="请重新登录" subTitle={status.message} extra={<Button type="primary" href="/login">前往登录</Button>} /></div>
      : <div ref={game} className={styles.game}>
        <iframe key={run} ref={frame} className={styles.frame} title="破碎的像素地牢游戏" src={`${ASSETS}/index.html`} onLoad={() => command('status-request')}
          allow="fullscreen" sandbox="allow-scripts allow-same-origin allow-downloads" />
      </div>}
    <Modal open={help} title="操作与存档" footer={<Button onClick={() => setHelp(false)}>知道了</Button>} onCancel={() => setHelp(false)}>
      <Typography.Paragraph>电脑可点击地图移动与交互，也可使用游戏内设置的快捷键。手机点击地图操作，拖动画面、双指缩放；横竖屏均可使用。按 Tab 可离开游戏画面返回网页控件。</Typography.Paragraph>
      <Typography.Paragraph>游戏在回合结束后自动保存并同步到当前账号；离开前可点击“同步进度”。网络中断时请保留此页面并重试。多台设备同时游玩会触发版本冲突，请先下载本次进度备份再载入云端。下载备份用于保留和人工恢复，当前页面不提供自动导入。</Typography.Paragraph>
      <Typography.Paragraph>这是 Shattered Pixel Dungeon 的非官方 Web 适配，原作者 Evan Debenham，Pixel Dungeon 原作者 Oleg Dolya（Watabou），Web 移植 glassesmonkey。保留原作署名与 GPL 许可；本站增加账号存档和网页适配。</Typography.Paragraph>
      <div className={styles.sourceLinks}>
        <a href={`${ASSETS}/source.tar.gz`} download>下载本构建对应源码</a>
        <a href={`${ASSETS}/LICENSE.txt`} target="_blank" rel="noreferrer">GPL 许可证</a>
        <a href="https://github.com/glassesmonkey/shattered-pixel-dungeon-web" target="_blank" rel="noreferrer">Web 上游项目</a>
        <a href="https://shatteredpixel.com/shatteredpd/" target="_blank" rel="noreferrer">原作官网</a>
      </div>
    </Modal>
  </main>;
}
