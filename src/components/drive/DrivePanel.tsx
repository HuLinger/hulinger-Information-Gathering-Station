'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, App, Button, Form, Input, Modal, Pagination, Progress, Select, Skeleton, Space, Tabs, Tag } from 'antd';
import { CloudUploadOutlined, DeleteOutlined, DownloadOutlined, EditOutlined, FileOutlined, PauseCircleOutlined, PlayCircleOutlined, ReloadOutlined, UndoOutlined } from '@ant-design/icons';
import type { DriveFile, DriveListing } from '../../shared/drive-contracts';
import { ApiError, errorMessage, requestJson } from '../api';
import { dateText, EmptyState, ErrorNotice } from '../format';
import { getDriveListing } from './api';
import { savePicker, uploadRunning, useDriveDownload, useUploadQueue, type UploadStatus } from './useTransfers';
import type { TransferProgress } from './transfer';

export function byteText(bytes: number) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(Math.max(1, bytes)) / Math.log(1024)));
  return `${new Intl.NumberFormat('zh-CN', { maximumFractionDigits: index ? 2 : 0 }).format(bytes / 1024 ** index)} ${units[index]}`;
}
function timeLeft(seconds: number | null) {
  if (seconds === null) return '正在计算剩余时间';
  if (seconds < 60) return `预计剩余 ${Math.max(1, Math.ceil(seconds))} 秒`;
  if (seconds < 3600) return `预计剩余 ${Math.ceil(seconds / 60)} 分钟`;
  return `预计剩余 ${(seconds / 3600).toFixed(1)} 小时`;
}
const uploadLabels: Record<UploadStatus, string> = { queued: '等待上传', preparing: '准备上传', checking: '核对续传文件', uploading: '上传中', finishing: '服务器确认中', pausing: '正在暂停', paused: '已暂停', 'needs-file': '等待选择原文件', error: '上传未完成', complete: '已上传并保存', canceling: '正在取消' };

function TransferMeter({ name, progress, complete, running, failed }: { name: string; progress: TransferProgress; complete: boolean; running: boolean; failed: boolean }) {
  const percent = complete ? 100 : progress.total ? Math.min(99.9, progress.bytes / progress.total * 100) : 0;
  return <div className="drive-transfer-meter">
    <Progress aria-label={`${name}传输进度`} percent={Number(percent.toFixed(1))} format={(value) => `${value}%`} status={complete ? 'success' : failed ? 'exception' : running ? 'active' : 'normal'} />
    <div className="drive-transfer-metrics"><span>{byteText(progress.bytes)} / {byteText(progress.total)}</span>{running && progress.phase === 'transferring' && <><span>{byteText(progress.bytesPerSecond)}/s</span><span>{timeLeft(progress.remainingSeconds)}</span></>}</div>
  </div>;
}

export default function DrivePanel({ active }: { active: boolean }) {
  const { modal, message } = App.useApp();
  const [view, setView] = useState<'files' | 'trash'>('files');
  const [searchText, setSearchText] = useState('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<DriveListing | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [actionError, setActionError] = useState('');
  const [epoch, setEpoch] = useState(0);
  const [parallel, setParallel] = useState(4);
  const [parallelAvailable, setParallelAvailable] = useState(false);
  const [sessionExpired, setSessionExpired] = useState(false);
  const [renaming, setRenaming] = useState<DriveFile | null>(null);
  const [renameName, setRenameName] = useState('');
  const [renameError, setRenameError] = useState('');
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const initialized = useRef(false);
  const composing = useRef(false);
  const uploadInput = useRef<HTMLInputElement>(null);
  const resumeInput = useRef<HTMLInputElement>(null);
  const resumeKey = useRef<string | null>(null);
  const refresh = useCallback(() => setEpoch((old) => old + 1), []);
  const expired = useCallback(() => setSessionExpired(true), []);
  const transfers = useUploadQueue({ parallel, maxFileBytes: data?.config.maxFileBytes ?? 0, onChange: refresh, onSessionExpired: expired });
  const download = useDriveDownload(parallel, expired);
  const mergePending = transfers.mergePending;

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    getDriveListing(new URLSearchParams({ view, q, page: String(page) }), controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      setData(result); setError(''); setLoading(false); setSessionExpired(false); mergePending(result.uploads);
      if (!initialized.current) { initialized.current = true; setParallel(result.config.defaultParallel); }
      else setParallel((old) => Math.min(old, result.config.maxParallel));
      setParallelAvailable(!!savePicker());
      const lastPage = Math.max(1, Math.ceil(result.total / 20));
      if (page > lastPage) setPage(lastPage);
    }).catch((cause) => {
      if (controller.signal.aborted) return;
      setError(errorMessage(cause)); setLoading(false);
      if (cause instanceof ApiError && cause.status === 401) expired();
    });
    return () => controller.abort();
  }, [active, view, q, page, epoch, mergePending, expired]);

  const unfinished = transfers.tasks.some((task) => task.local && task.status !== 'complete') || !!download.task && download.task.status !== 'complete';
  useEffect(() => {
    if (!unfinished) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [unfinished]);

  async function changeFile(file: DriveFile, action: 'rename' | 'trash' | 'restore' | 'purge', name?: string) {
    setPendingAction(file.id); setActionError('');
    try {
      const result = await requestJson<{ ok?: boolean }>(`/api/drive/files/${encodeURIComponent(file.id)}`, { method: 'POST', body: JSON.stringify({ action, ...(name !== undefined ? { name } : {}), ...(action === 'purge' ? { confirm: true } : {}) }) });
      if (result.ok !== true) throw new Error('服务器尚未确认操作结果，请刷新列表核对。');
      refresh();
      void message.success(action === 'rename' ? '文件已重命名' : action === 'restore' ? '文件已恢复' : action === 'purge' ? '文件已永久删除' : '文件已移入回收站');
    } catch (cause) { setActionError(errorMessage(cause)); if (cause instanceof ApiError && cause.status === 401) expired(); throw cause; }
    finally { setPendingAction(null); }
  }
  function confirmDelete(file: DriveFile, permanent: boolean) {
    modal.confirm({ title: permanent ? `永久删除“${file.name}”？` : `将“${file.name}”移入回收站？`, content: permanent ? `将删除 ${byteText(file.size)} 的文件内容，无法恢复。` : `文件可在 ${data?.config.trashRetentionDays ?? 30} 天内恢复，期间仍占用存储。`, okText: permanent ? '永久删除' : '移入回收站', cancelText: '取消', okButtonProps: { danger: true }, focusable: { autoFocusButton: 'cancel' }, onOk: () => changeFile(file, permanent ? 'purge' : 'trash') });
  }
  function cancelUpload(key: string, name: string) {
    modal.confirm({ title: `取消上传“${name}”？`, content: '服务器上已上传的部分将被清理，之后需要重新上传。', okText: '取消并清理', cancelText: '保留任务', okButtonProps: { danger: true }, focusable: { autoFocusButton: 'cancel' }, onOk: async () => { try { await transfers.cancel(key); } catch (cause) { setActionError(errorMessage(cause)); throw cause; } } });
  }
  function cancelDownload() {
    modal.confirm({ title: '停止本次并行下载？', content: '尚未完成的本地写入会被放弃。之后需重新选择保存位置并下载。', okText: '停止下载', cancelText: '继续保留', okButtonProps: { danger: true }, focusable: { autoFocusButton: 'cancel' }, onOk: async () => { try { await download.cancel(); } catch (cause) { setActionError(errorMessage(cause)); throw cause; } } });
  }
  function search(value: string) {
    if (composing.current) return;
    setQ(value.trim()); setSearchText(value); setPage(1); setLoading(true); refresh();
  }
  function saveRename() {
    if (!renaming || pendingAction) return;
    const name = renameName.trim();
    if (!name || /[\u0000-\u001f\u007f/\\]/.test(name)) { setRenameError('请输入文件名，不能包含路径分隔符或控制字符。'); return; }
    void changeFile(renaming, 'rename', name).then(() => setRenaming(null)).catch((cause) => setRenameError(errorMessage(cause)));
  }
  function closeRename() {
    if (pendingAction) return;
    if (renaming && renameName !== renaming.name) modal.confirm({ title: '放弃未保存的文件名？', content: '文件仍使用原名称。', okText: '放弃修改', cancelText: '继续编辑', focusable: { autoFocusButton: 'cancel' }, onOk: () => setRenaming(null) });
    else setRenaming(null);
  }
  const downloadBusy = !!download.task && !['complete', 'error'].includes(download.task.status) || !!download.task?.canResume;

  return <section className="drive-workspace" aria-label="个人云盘">
    {sessionExpired && <Alert className="section-alert" type="warning" showIcon title="登录已失效" description={<>上传进度保留在服务器，重新登录后需选择原文件续传。并行下载离开本页后需重新开始。<a href="/login">前往登录</a></>} />}
    {error && <div className="section-alert"><ErrorNotice error={error} retry={() => { setLoading(true); refresh(); }} /></div>}
    {actionError && <Alert className="section-alert" type="error" showIcon title="操作未完成" description={actionError} closable onClose={() => setActionError('')} />}
    {data && <div className="drive-capacity" aria-label="云盘容量"><div><span>文件占用</span><strong>{byteText(data.capacity.usedBytes)}</strong></div><div><span>上传预留</span><strong>{byteText(data.capacity.reservedBytes)}</strong></div><div><span>当前可用</span><strong>{byteText(data.capacity.availableBytes)}</strong></div></div>}
    <div className="drive-controls surface-panel">
      <div className="drive-upload-heading"><div><h2>把文件放进自己的云盘</h2><p className="muted">支持大文件分片上传、中断后续传。多个文件按队列逐个传输。</p></div><Button type="primary" icon={<CloudUploadOutlined />} disabled={!data || sessionExpired} onClick={() => uploadInput.current?.click()}>上传文件</Button></div>
      <input ref={uploadInput} type="file" multiple hidden aria-label="选择上传文件" onChange={(event) => { transfers.addFiles(Array.from(event.target.files ?? [])); event.target.value = ''; }} />
      <input ref={resumeInput} type="file" hidden aria-label="选择续传原文件" onChange={(event) => { const file = event.target.files?.[0]; if (file && resumeKey.current) transfers.resume(resumeKey.current, file); event.target.value = ''; resumeKey.current = null; }} />
      <div className="drive-preferences"><label htmlFor="drive-parallel">并行连接</label><Select id="drive-parallel" value={parallel} onChange={setParallel} disabled={!data} options={Array.from({ length: data?.config.maxParallel ?? 4 }, (_, index) => ({ value: index + 1, label: `${index + 1} 路` }))} /><span className="muted">用于下一次开始或继续的传输；实际速度取决于网络、服务器与磁盘。</span></div>
      <p className="drive-help muted">{data ? `单文件上限 ${byteText(data.config.maxFileBytes)}；分片 ${byteText(data.config.chunkSize)}；未完成上传保留 ${data.config.uploadRetentionDays} 天。` : '正在读取服务器容量与上传设置。'} 切换站内页面可继续传输；关闭或刷新浏览器会暂停上传。</p>
    </div>

    {!!transfers.tasks.length && <section className="drive-transfers surface-panel" aria-labelledby="drive-uploads-title"><div className="section-heading"><h2 id="drive-uploads-title">上传任务 · {transfers.tasks.length}</h2><span className="muted">续传会核对已保存的每个分片</span></div><ul className="drive-task-list">{transfers.tasks.map((task) => <li key={task.key} className="drive-task">
      <div className="drive-task-heading"><strong>{task.name}</strong><Tag color={task.status === 'complete' ? 'success' : task.status === 'error' ? 'error' : undefined}><span role="status">{uploadLabels[task.status]}</span></Tag></div>
      <TransferMeter name={task.name} progress={task.progress} complete={task.status === 'complete'} running={uploadRunning(task)} failed={task.status === 'error'} />
      {task.status === 'needs-file' && <p className="drive-help muted">重新选择原文件后，先核对已上传部分，再继续。</p>}
      {task.error && <Alert type="error" showIcon title={task.error} />}
      <div className="drive-task-actions">
        {(uploadRunning(task) || task.status === 'queued') && <Button icon={<PauseCircleOutlined />} onClick={() => transfers.pause(task.key)}>暂停</Button>}
        {(task.status === 'paused' || task.status === 'error') && task.local && <Button icon={<PlayCircleOutlined />} disabled={sessionExpired} onClick={() => transfers.resume(task.key)}>{task.status === 'error' ? '重试上传' : '继续上传'}</Button>}
        {['needs-file', 'paused', 'error'].includes(task.status) && <Button disabled={sessionExpired} onClick={() => { resumeKey.current = task.key; resumeInput.current?.click(); }}>选择原文件{task.local ? '' : '续传'}</Button>}
        {task.status !== 'complete' ? <Button danger disabled={task.status === 'canceling'} loading={task.status === 'canceling'} onClick={() => cancelUpload(task.key, task.name)}>取消任务</Button> : <Button onClick={() => transfers.dismiss(task.key)}>收起记录</Button>}
      </div>
    </li>)}</ul></section>}

    {download.task && <section className="drive-transfers surface-panel" aria-labelledby="drive-download-title"><h2 id="drive-download-title">并行下载</h2><div className="drive-task-heading"><strong>{download.task.file.name}</strong><Tag color={download.task.status === 'complete' ? 'success' : download.task.status === 'error' ? 'error' : undefined}><span role="status">{{ preparing: '选择保存位置', downloading: '下载中', finishing: '正在保存文件', paused: '已暂停', error: '下载未完成', complete: '已下载并保存', canceling: '正在停止' }[download.task.status]}</span></Tag></div>
      <TransferMeter name={download.task.file.name} progress={download.task.progress} complete={download.task.status === 'complete'} running={download.task.status === 'downloading'} failed={download.task.status === 'error'} />
      <p className="drive-help muted">并行下载只在当前页面支持暂停/继续；全部分片校验并保存后才算完成。刷新或关闭页面后需重新下载。</p>
      {download.task.error && <Alert type="error" showIcon title={download.task.error} />}
      <div className="drive-task-actions">
        {download.task.status === 'downloading' && <Button icon={<PauseCircleOutlined />} onClick={download.pause}>暂停下载</Button>}
        {['paused', 'error'].includes(download.task.status) && download.task.canResume && <Button icon={<PlayCircleOutlined />} onClick={() => void download.resume()} disabled={sessionExpired}>继续下载</Button>}
        {download.task.status === 'error' && !download.task.canResume && <Button icon={<DownloadOutlined />} onClick={() => void download.start(download.task!.file)} disabled={sessionExpired}>重新选择保存位置</Button>}
        {!['complete', 'preparing', 'finishing'].includes(download.task.status) && <Button danger disabled={download.task.status === 'canceling'} onClick={cancelDownload}>停止下载</Button>}
        {download.task.status === 'complete' && <Button onClick={() => void download.cancel()}>收起记录</Button>}
      </div>
    </section>}

    <section aria-label="云盘文件" className="drive-file-section">
      <div className="drive-file-toolbar"><Tabs activeKey={view} onChange={(key) => { setView(key as 'files' | 'trash'); setPage(1); setLoading(true); }} items={[{ key: 'files', label: '我的文件' }, { key: 'trash', label: '回收站' }]} /><div className="drive-file-search"><Input.Search value={searchText} aria-label="按文件名搜索云盘" placeholder="搜索文件名" allowClear onChange={(event) => setSearchText(event.target.value)} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }} onSearch={(value, event) => { if (event && 'isComposing' in event.nativeEvent && event.nativeEvent.isComposing) return; search(value); }} enterButton="搜索" /><Button icon={<ReloadOutlined />} aria-label="刷新云盘文件" onClick={() => { setLoading(true); refresh(); }} loading={loading && !!data} /></div></div>
      {q && <div className="filter-tags"><Tag closable onClose={() => search('')}>文件名：{q}</Tag><span className="muted">{data?.total ?? 0} 个结果</span></div>}
      {view === 'trash' && <p className="drive-help muted">删除的文件保留 {data?.config.trashRetentionDays ?? 30} 天，之后由后台清理；回收站仍占用存储空间。</p>}
      {loading && data && <p role="status" className="muted">正在刷新文件列表…</p>}
      {loading && !data ? <div className="surface-panel"><Skeleton active paragraph={{ rows: 5 }} /></div> : !data && error ? <div className="surface-panel"><h2>云盘暂时无法读取</h2><p className="muted">请使用上方重试。尚未获得文件列表。</p></div> : !data?.files.length ? <EmptyState title={q ? '没有匹配的文件' : view === 'trash' ? '回收站是空的' : '云盘里还没有文件'} description={q ? '试着缩短文件名关键词，或清除搜索。' : view === 'trash' ? '移入回收站的文件可以在保留期内恢复。' : '上传文件后，可以在电脑和手机登录下载。'} action={q ? <Button onClick={() => search('')}>清除搜索</Button> : view === 'files' ? <Button onClick={() => uploadInput.current?.click()} disabled={!data}>选择文件</Button> : undefined} /> : <ul className="drive-file-list">{data.files.map((file) => <li key={file.id} className="drive-file-row"><FileOutlined className="drive-file-icon" aria-hidden /><div className="drive-file-info"><h3>{file.name}</h3><p className="muted">{byteText(file.size)}<span aria-hidden> · </span>{file.status === 'trash' ? `删除于 ${dateText(file.deletedAt, true)}` : `上传于 ${dateText(file.completedAt, true)}`}</p>{file.status === 'deleting' && <Tag>正在清理</Tag>}</div><Space wrap className="drive-file-actions">
        {file.status === 'ready' && <><a className="drive-download-link" href={`/api/drive/files/${encodeURIComponent(file.id)}/content`} download={file.name}><DownloadOutlined /> 下载</a>{parallelAvailable && <Button disabled={downloadBusy || sessionExpired} onClick={() => void download.start(file)}>并行下载</Button>}<Button icon={<EditOutlined />} aria-label={`重命名 ${file.name}`} disabled={pendingAction === file.id} onClick={() => { setRenaming(file); setRenameName(file.name); setRenameError(''); }}>重命名</Button><Button danger icon={<DeleteOutlined />} aria-label={`删除 ${file.name}`} disabled={pendingAction === file.id} onClick={() => confirmDelete(file, false)}>删除</Button></>}
        {file.status === 'trash' && <><Button icon={<UndoOutlined />} loading={pendingAction === file.id} onClick={() => void changeFile(file, 'restore').catch(() => {})}>恢复</Button><Button danger disabled={pendingAction === file.id} onClick={() => confirmDelete(file, true)}>永久删除</Button></>}
      </Space></li>)}</ul>}
      {!!data && data.total > 20 && <div className="list-pagination"><Pagination current={page} total={data.total} pageSize={20} showSizeChanger={false} showTotal={(total) => `共 ${total} 个文件`} onChange={(next) => { setPage(next); setLoading(true); }} /></div>}
      <p className="drive-help muted">普通下载由浏览器管理，续传能力以浏览器为准。{parallelAvailable ? '并行下载会先选择本地保存位置；请先完成或停止当前下载，再开始下一个。' : '当前浏览器不提供直接写入文件接口，请使用普通下载。'} 速度以实际传输为准。</p>
    </section>

    <Modal open={!!renaming} title="重命名文件" onCancel={closeRename} onOk={saveRename} confirmLoading={!!pendingAction && !!renaming} okText="保存名称" cancelText="取消" destroyOnHidden>
      <Form layout="vertical" onFinish={saveRename}><Form.Item label="文件名" htmlFor="drive-rename" validateStatus={renameError ? 'error' : undefined} help={<span id="drive-rename-help">{renameError || '名称只影响显示，文件内容保持不变。'}</span>}><Input id="drive-rename" value={renameName} onChange={(event) => setRenameName(event.target.value)} maxLength={255} autoFocus aria-invalid={!!renameError} aria-describedby="drive-rename-help" onPressEnter={(event) => { event.preventDefault(); if (!event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) saveRename(); }} /></Form.Item></Form>
    </Modal>
  </section>;
}
