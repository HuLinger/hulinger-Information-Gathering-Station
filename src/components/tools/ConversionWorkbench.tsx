'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Alert, App, Button, Card, Empty, Form, Modal, Progress, Select, Skeleton, Tag, Upload } from 'antd';
import { ArrowLeftOutlined, DeleteOutlined, DownloadOutlined, FileOutlined, InfoCircleOutlined, ReloadOutlined, UploadOutlined } from '@ant-design/icons';
import { CONVERSION_ENGINE_LABELS, type ConversionCapabilities, type ConversionEngineChoice, type ConversionJob, type ConversionOption, type ConversionOutput, type ConversionState, type ConversionUpload } from '../../shared/conversion-contracts';
import { ApiError, errorMessage, requestJson } from '../api';
import { dateText } from '../format';
import styles from './ConversionWorkbench.module.css';

const API = '/api/tools/conversion';
type Snapshot = { uploads: ConversionUpload[]; jobs: ConversionJob[] };
type Source = { key: number; file: File | null; upload: ConversionUpload | null };
type UploadProgress = { loaded: number; total: number | null };
type SubmitStage = 'preparing' | 'uploading' | 'confirming' | 'creating' | null;
type CapabilityResult = { key: string; data: ConversionCapabilities; error?: never } | { key: string; error: string; data?: never };

const stateLabels: Record<ConversionState, string> = {
  queued: '排队中', running: '处理中', succeeded: '已完成', failed: '转换失败', cancelled: '已取消',
};
const stageLabels: Record<Exclude<SubmitStage, null>, string> = {
  preparing: '正在准备上传…', uploading: '正在上传文件…', confirming: '文件已传输，正在等待服务器确认…', creating: '正在创建转换任务…',
};
const isPending = (job: ConversionJob) => job.state === 'queued' || job.state === 'running';
const isExpired = (value: string) => new Date(value).getTime() <= Date.now();
function extensionOf(name: string) { return name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : ''; }
function bytesText(bytes: number) {
  const units = ['B', 'KiB', 'MiB', 'GiB'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(Math.max(1, bytes)) / Math.log(1024)));
  return `${new Intl.NumberFormat('zh-CN', { maximumFractionDigits: index ? 1 : 0 }).format(bytes / 1024 ** index)} ${units[index]}`;
}
function outputOptions(options: ConversionOption[], choice: ConversionEngineChoice) {
  const grouped = new Map<string, ConversionOption[]>();
  for (const option of options) grouped.set(option.format, [...(grouped.get(option.format) ?? []), option]);
  return Array.from(grouped, ([value, variants]) => ({
    value,
    label: variants.find((option) => option.engine === choice)?.label ?? Array.from(new Set(variants.map((option) => option.label))).join(' / '),
  }));
}

function uploadFile(id: string, file: File, onProgress: (progress: UploadProgress) => void, onRequest: (request: XMLHttpRequest) => void): Promise<ConversionUpload> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('PUT', `${API}/uploads/${encodeURIComponent(id)}/content`);
    request.setRequestHeader('Content-Type', 'application/octet-stream');
    request.responseType = 'json';
    request.timeout = 15 * 60_000;
    request.upload.onprogress = (event) => onProgress({ loaded: event.loaded, total: event.lengthComputable ? event.total : null });
    request.onload = () => {
      const data = request.response as { upload?: ConversionUpload; error?: string; code?: string } | null;
      if (request.status >= 200 && request.status < 300) {
        if (data?.upload?.id === id && data.upload.state === 'ready') resolve(data.upload);
        else reject(new ApiError('服务器尚未确认文件完整上传，请重试。', 502));
      } else reject(new ApiError(data?.error ?? '上传未完成，请检查网络后重试。本地文件仍保留在当前页面。', request.status, data?.code));
    };
    request.onerror = () => reject(new ApiError('网络连接中断，文件尚未上传完成。可以保留当前文件重新上传。', 0));
    request.ontimeout = () => reject(new ApiError('上传超时，文件尚未上传完成。请检查网络后重试。', 0));
    request.onabort = () => reject(new ApiError('上传已停止。本地文件仍保留在当前页面，可以重新上传。', 0, 'UPLOAD_ABORTED'));
    onRequest(request);
    request.send(file);
  });
}

export default function ConversionWorkbench() {
  const { message, modal } = App.useApp();
  const router = useRouter();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [refreshing, setRefreshing] = useState(true);
  const [listError, setListError] = useState('');
  const [actionError, setActionError] = useState('');
  const [sessionExpired, setSessionExpired] = useState(false);
  const [source, setSource] = useState<Source | null>(null);
  const [selectedTarget, setSelectedTarget] = useState<string>();
  const [engineChoice, setEngineChoice] = useState<ConversionEngineChoice>('auto');
  const [capabilityEpoch, setCapabilityEpoch] = useState(0);
  const [capabilityResult, setCapabilityResult] = useState<CapabilityResult | null>(null);
  const [knownOptions, setKnownOptions] = useState<Record<string, ConversionOption[]>>({});
  const [submitStage, setSubmitStage] = useState<SubmitStage>(null);
  const [uploadProgress, setUploadProgress] = useState<UploadProgress | null>(null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [formNotice, setFormNotice] = useState('');
  const [showAllUploads, setShowAllUploads] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const alive = useRef(true);
  const sourceRef = useRef<Source | null>(null);
  const sourceSequence = useRef(0);
  const snapshotSequence = useRef(0);
  const snapshotRequest = useRef<AbortController | null>(null);
  const uploadRequest = useRef<XMLHttpRequest | null>(null);
  const submitLock = useRef(false);
  const actionLock = useRef(false);
  const sessionExpiredRef = useRef(false);
  const formHeading = useRef<HTMLHeadingElement>(null);

  const noteFailure = useCallback((cause: unknown) => {
    if (cause instanceof ApiError && (cause.status === 401 || cause.status === 403)) {
      sessionExpiredRef.current = true;
      setSessionExpired(true);
    }
  }, []);

  const refreshSnapshot = useCallback((quiet = false) => {
    if (sessionExpiredRef.current || quiet && snapshotRequest.current) return Promise.resolve();
    snapshotRequest.current?.abort();
    const controller = new AbortController();
    const sequence = ++snapshotSequence.current;
    snapshotRequest.current = controller;
    return requestJson<Snapshot>(API, { signal: controller.signal }).then((result) => {
      if (!Array.isArray(result.uploads) || !Array.isArray(result.jobs)) throw new ApiError('文件与任务记录不完整，请重新读取。', 502);
      if (!alive.current || controller.signal.aborted || sequence !== snapshotSequence.current) return;
      setSnapshot(result);
      setListError('');
      const selected = sourceRef.current;
      const refreshedUpload = selected?.upload && result.uploads.find((upload) => upload.id === selected.upload!.id);
      if (selected && refreshedUpload) {
        const next = { ...selected, upload: refreshedUpload };
        sourceRef.current = next;
        setSource(next);
      }
    }).catch((cause) => {
      if (!alive.current || controller.signal.aborted || sequence !== snapshotSequence.current) return;
      setListError(errorMessage(cause));
      noteFailure(cause);
    }).finally(() => {
      if (alive.current && sequence === snapshotSequence.current) {
        snapshotRequest.current = null;
        setRefreshing(false);
      }
    });
  }, [noteFailure]);

  function refreshRecords() {
    setRefreshing(true);
    void refreshSnapshot();
  }

  useEffect(() => {
    alive.current = true;
    void refreshSnapshot();
    return () => {
      alive.current = false;
      snapshotRequest.current?.abort();
      uploadRequest.current?.abort();
    };
  }, [refreshSnapshot]);

  const pendingCount = snapshot?.jobs.filter(isPending).length ?? 0;
  useEffect(() => {
    if (sessionExpired) return;
    const refreshVisible = () => { if (document.visibilityState === 'visible') void refreshSnapshot(true); };
    const timer = window.setInterval(refreshVisible, pendingCount ? 4000 : 20_000);
    document.addEventListener('visibilitychange', refreshVisible);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', refreshVisible); };
  }, [pendingCount, refreshSnapshot, sessionExpired]);

  const sourceName = source?.upload?.name ?? source?.file?.name ?? '';
  const sourceBytes = source?.upload?.bytes ?? source?.file?.size ?? 0;
  const extension = source?.upload?.extension ?? extensionOf(sourceName);
  const capabilityKey = `${source?.key ?? 'empty'}:${capabilityEpoch}`;
  useEffect(() => {
    if (sessionExpired) return;
    const controller = new AbortController();
    requestJson<ConversionCapabilities>(`${API}/capabilities?extension=${encodeURIComponent(extension)}`, { signal: controller.signal }).then((data) => {
      if (controller.signal.aborted) return;
      if (!Array.isArray(data.engines) || !Array.isArray(data.options) || !(data.maxInputBytes > 0)) throw new ApiError('转换能力响应不完整，请重新查询。', 502);
      setCapabilityResult({ key: capabilityKey, data });
      setKnownOptions((old) => ({ ...old, [extension]: data.options }));
    }).catch((cause) => {
      if (controller.signal.aborted) return;
      setCapabilityResult({ key: capabilityKey, error: errorMessage(cause) });
      noteFailure(cause);
    });
    return () => controller.abort();
  }, [extension, capabilityKey, noteFailure, sessionExpired]);

  useEffect(() => {
    if (!submitStage) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [submitStage]);

  const capabilities = capabilityResult?.key === capabilityKey ? capabilityResult.data : undefined;
  const capabilityError = capabilityResult?.key === capabilityKey ? capabilityResult.error : undefined;
  const checkingCapabilities = capabilityResult?.key !== capabilityKey;
  const formatOptions = outputOptions(capabilities?.options ?? [], engineChoice);
  const targetFormat = selectedTarget ?? (formatOptions.length === 1 ? formatOptions[0].value : undefined);
  const supportingEngines = capabilities?.options.filter((option) => option.format === targetFormat).map((option) => option.engine) ?? [];
  const readyEngineCount = capabilities?.engines.filter((engine) => engine.state === 'ready').length ?? 0;
  const targetSupported = formatOptions.some((option) => option.value === targetFormat);
  const engineSupported = engineChoice === 'auto' ? supportingEngines.length > 0 : supportingEngines.includes(engineChoice);
  const uploadReady = source?.upload?.state === 'ready';
  const sourceExpired = !!source?.upload && isExpired(source.upload.expiresAt);
  const fileTooLarge = !!source && !!capabilities && sourceBytes > capabilities.maxInputBytes;
  const queueFull = !!capabilities && pendingCount >= capabilities.maxPendingJobs;
  const canSubmit = !!source && !!snapshot && !sessionExpired && !submitStage && !pendingAction && !checkingCapabilities && !capabilityError
    && !!capabilities && targetSupported && engineSupported && !sourceExpired && !fileTooLarge && !queueFull && (uploadReady || !!source.file);
  const retentionHours = capabilities?.retentionHours ?? 24;

  function chooseSource(next: Source, target?: string) {
    if (next.upload?.state === 'uploading' && !next.file) {
      setActionError('未完成上传，请重新选择本地文件。可以先清理这次未完成上传，释放临时空间。');
      return;
    }
    sourceRef.current = next;
    setSource(next);
    setSelectedTarget(target);
    setEngineChoice('auto');
    setUploadProgress(null);
    setActionError('');
    setFormNotice('');
  }
  function chooseFile(file: File) {
    if (!file.size) { setActionError('文件是空的，请选择包含内容的文件。'); return false; }
    if (!/^[a-z0-9]{1,20}$/.test(extensionOf(file.name))) { setActionError('请使用带有文件扩展名的文件，例如 .png、.pdf 或 .ncm。'); return false; }
    if (capabilities && file.size > capabilities.maxInputBytes) { setActionError(`文件超过单文件上限 ${bytesText(capabilities.maxInputBytes)}，请选择较小的文件。`); return false; }
    chooseSource({ key: ++sourceSequence.current, file, upload: null });
    return false;
  }
  function retainUpload(upload: ConversionUpload, key: number) {
    if (sourceRef.current?.key !== key) return;
    const next = { ...sourceRef.current, upload };
    sourceRef.current = next;
    setSource(next);
  }
  function focusForm() {
    formHeading.current?.focus();
    formHeading.current?.scrollIntoView({ block: 'start', behavior: 'instant' });
  }
  function invalidateSnapshotRequest() {
    snapshotRequest.current?.abort();
    snapshotRequest.current = null;
    snapshotSequence.current++;
  }

  async function submitConversion() {
    const selected = sourceRef.current;
    if (!canSubmit || !selected || !targetFormat || submitLock.current) return;
    submitLock.current = true;
    setActionError('');
    setFormNotice('');
    let creatingJob = false;
    try {
      let upload = selected.upload;
      if (!upload) {
        if (!selected.file) return;
        setSubmitStage('preparing');
        const result = await requestJson<{ upload: ConversionUpload }>(`${API}/uploads`, { method: 'POST', body: JSON.stringify({ name: selected.file.name, bytes: selected.file.size }) });
        if (!alive.current) return;
        if (!result.upload?.id) throw new ApiError('服务器没有返回上传记录，请重试。', 502);
        upload = result.upload;
        retainUpload(upload, selected.key);
      }
      if (upload.state !== 'ready') {
        if (!selected.file) throw new ApiError('文件尚未完整上传，请重新选择原文件。', 409);
        setSubmitStage('uploading');
        setUploadProgress({ loaded: 0, total: selected.file.size });
        upload = await uploadFile(upload.id, selected.file, (progress) => {
          if (!alive.current || sourceRef.current?.key !== selected.key) return;
          setUploadProgress(progress);
          if (progress.total && progress.loaded >= progress.total) setSubmitStage('confirming');
        }, (request) => { uploadRequest.current = request; });
        if (!alive.current) return;
        retainUpload(upload, selected.key);
        setUploadProgress({ loaded: selected.file.size, total: selected.file.size });
        invalidateSnapshotRequest();
        const readyUpload = upload;
        setSnapshot((old) => old && ({ ...old, uploads: [readyUpload, ...old.uploads.filter((item) => item.id !== readyUpload.id)] }));
      }
      setSubmitStage('creating');
      creatingJob = true;
      const result = await requestJson<{ job: ConversionJob }>(`${API}/jobs`, { method: 'POST', body: JSON.stringify({ uploadId: upload.id, targetFormat, engine: engineChoice }) });
      if (!alive.current) return;
      if (!result.job?.id) throw new ApiError('服务器没有确认任务已创建，请刷新记录后再试，避免重复提交。', 502);
      invalidateSnapshotRequest();
      setSnapshot((old) => old && ({ ...old, jobs: [result.job, ...old.jobs.filter((job) => job.id !== result.job.id)] }));
      setFormNotice('任务已加入队列。可以在下方查看结果，也可以离开页面，后台会继续处理。');
      void message.success('转换任务已创建');
      refreshRecords();
    } catch (cause) {
      if (!alive.current) return;
      setActionError(`${errorMessage(cause)}${creatingJob && cause instanceof ApiError && (cause.status === 0 || cause.status >= 500) ? ' 任务可能已提交，请先在最近任务中核对，避免重复创建。' : ''}`);
      noteFailure(cause);
      void refreshSnapshot(true);
    } finally {
      submitLock.current = false;
      uploadRequest.current = null;
      if (alive.current) setSubmitStage(null);
    }
  }

  async function mutate(key: string, path: string, options: RequestInit, onSuccess: () => void) {
    if (actionLock.current) return;
    actionLock.current = true;
    setPendingAction(key);
    setActionError('');
    try {
      const result = await requestJson<{ success: boolean }>(path, options);
      if (result.success !== true) throw new ApiError('服务器尚未确认操作结果，请刷新记录核对。', 502);
      if (!alive.current) return;
      invalidateSnapshotRequest();
      onSuccess();
      refreshRecords();
    } catch (cause) {
      if (alive.current) { setActionError(errorMessage(cause)); noteFailure(cause); }
      throw cause;
    } finally {
      actionLock.current = false;
      if (alive.current) setPendingAction(null);
    }
  }
  function cancelJob(job: ConversionJob) {
    void mutate(`job:${job.id}`, `${API}/jobs/${encodeURIComponent(job.id)}`, { method: 'PATCH', body: JSON.stringify({ action: 'cancel' }) }, () => {
      setSnapshot((old) => old && ({ ...old, jobs: old.jobs.map((item) => item.id === job.id ? { ...item, state: 'cancelled', stage: '已取消排队' } : item) }));
      void message.success('已取消排队');
    }).catch(() => { /* The persistent error above retains the retry context. */ });
  }
  function deleteJob(job: ConversionJob) {
    modal.confirm({
      title: `删除“${job.inputName}”的这次任务？`,
      content: '这次转换记录及其全部结果会被永久删除，无法恢复。已上传的源文件仍可用于其他转换。',
      okText: '删除任务及结果', cancelText: '保留', okButtonProps: { danger: true }, focusable: { autoFocusButton: 'cancel' },
      onOk: () => mutate(`job:${job.id}`, `${API}/jobs/${encodeURIComponent(job.id)}`, { method: 'DELETE' }, () => {
        setSnapshot((old) => old && ({ ...old, jobs: old.jobs.filter((item) => item.id !== job.id) }));
        void message.success('任务及结果已删除');
      }).catch(() => { /* Close the dialog so the persistent failure message is visible. */ }),
    });
  }
  function deleteUpload(upload: ConversionUpload) {
    const related = snapshot?.jobs.filter((job) => job.uploadId === upload.id).length ?? 0;
    const incomplete = upload.state === 'uploading';
    modal.confirm({
      title: `清理“${upload.name}”？`,
      content: incomplete ? <p>将删除这次未完成上传的记录和已接收的内容，释放临时空间。电脑上的原文件不受影响；需要转换时请重新选择本地文件。</p> : <><p>将永久删除这个已上传的源文件，以及它关联的所有已完成、失败或取消的任务和转换结果，无法恢复。</p><p>当前列表中有 {related} 个关联任务。需要保留的结果请先下载；电脑上的原文件不受影响。</p></>,
      okText: incomplete ? '清理未完成上传' : '清理源文件及全部结果', cancelText: '保留', okButtonProps: { danger: true }, focusable: { autoFocusButton: 'cancel' },
      onOk: () => mutate(`upload:${upload.id}`, `${API}/uploads/${encodeURIComponent(upload.id)}`, { method: 'DELETE' }, () => {
        setSnapshot((old) => old && ({ uploads: old.uploads.filter((item) => item.id !== upload.id), jobs: old.jobs.filter((job) => job.uploadId !== upload.id) }));
        if (sourceRef.current?.upload?.id === upload.id) {
          sourceRef.current = null;
          setSource(null);
          setSelectedTarget(undefined);
          setEngineChoice('auto');
          setUploadProgress(null);
          setFormNotice('');
        }
        void message.success(incomplete ? '未完成上传已清理，临时空间已释放' : '源文件及关联结果已清理');
      }).catch(() => { /* Close the dialog so the persistent failure message is visible. */ }),
    });
  }
  function retryJob(job: ConversionJob) {
    const upload = snapshot?.uploads.find((item) => item.id === job.uploadId && item.state === 'ready');
    if (!upload) { setActionError('源文件已到期或不在当前列表，请刷新记录或重新选择原文件。'); return; }
    chooseSource({ key: ++sourceSequence.current, file: null, upload }, job.targetFormat);
    setFormNotice('已选中这次任务的原文件。可以更换转换引擎后重试，无需重复上传。');
    focusForm();
  }
  async function downloadOutput(output: ConversionOutput) {
    if (downloading) return;
    setDownloading(output.id);
    setActionError('');
    try {
      const url = `${API}/outputs/${encodeURIComponent(output.id)}`;
      const response = await fetch(url, { method: 'HEAD', credentials: 'same-origin', cache: 'no-store' });
      if (!response.ok) throw new ApiError(response.status === 401 || response.status === 403 ? '登录已失效，请重新登录后下载。' : response.status === 404 ? '转换结果不存在或已到期，请刷新任务记录。' : '暂时无法下载，请稍后重试。', response.status);
      if (!alive.current) return;
      const link = document.createElement('a');
      link.href = url;
      link.download = output.name;
      document.body.appendChild(link);
      link.click();
      link.remove();
    } catch (cause) {
      if (alive.current) { setActionError(cause instanceof ApiError ? cause.message : '暂时无法连接，请检查网络后重试下载。'); noteFailure(cause); }
    } finally { if (alive.current) setDownloading(null); }
  }
  function jobFormatLabel(job: ConversionJob) {
    return knownOptions[job.inputExtension]?.find((option) => option.format === job.targetFormat && (!job.engine || option.engine === job.engine))?.label
      ?? (job.inputExtension === 'ncm' && job.targetFormat === 'audio' ? '原始音频（MP3 / FLAC）' : job.targetFormat.toUpperCase());
  }

  const visibleUploads = showAllUploads ? snapshot?.uploads : snapshot?.uploads.slice(0, 5);
  const controlsDisabled = !!submitStage || !!pendingAction || sessionExpired;
  const progressPercent = uploadProgress?.total ? Math.min(100, Math.round(uploadProgress.loaded / uploadProgress.total * 1000) / 10) : null;
  return <main className={styles.page}>
    <header className={styles.toolbar}>
      <div className={styles.leading}>
        <Button icon={<ArrowLeftOutlined />} onClick={() => router.push('/?view=tools')} disabled={!!submitStage}>返回小工具</Button>
        <h1>格式转换</h1>
      </div>
      <Button icon={<InfoCircleOutlined />} onClick={() => setShowHelp(true)}>使用说明</Button>
    </header>
    <div className={styles.content}>
      <p className={styles.intro}>上传一次，按需转换。选择目标格式与可用引擎，在这里查看并下载结果。</p>
      {sessionExpired && <Alert type="warning" showIcon title="登录状态已失效" description="已有文件和任务保留在当前账号，重新登录后可以继续查看。未完成上传的本地文件需要重新选择。" action={<Button href="/login">重新登录</Button>} />}
      {actionError && <Alert type="error" showIcon title="操作未完成" description={actionError} closable onClose={() => setActionError('')} />}
      {listError && <Alert type="error" showIcon title="文件与任务记录暂时无法更新" description={listError} action={<Button onClick={refreshRecords} disabled={sessionExpired} loading={refreshing}>重试读取</Button>} />}

      <div className={styles.workspace}>
        <Card className={styles.card} title={<h2 ref={formHeading} tabIndex={-1}>开始转换</h2>}>
          <Form layout="vertical" onFinish={() => void submitConversion()} className={styles.form}>
            <Form.Item label="源文件" htmlFor="conversion-file" extra="一次选择一个文件；也可以从“源文件记录”直接选用已完成上传的文件。">
              <Upload.Dragger id="conversion-file" multiple={false} fileList={[]} showUploadList={false} beforeUpload={chooseFile} disabled={controlsDisabled} aria-label="选择要转换的文件">
                <UploadOutlined className={styles.uploadIcon} aria-hidden />
                <p className={styles.uploadTitle}>{source ? '选择另一个文件' : '点击选择文件，或拖到这里'}</p>
                <p className={styles.uploadHint}>开始转换时上传，切换引擎无需重新选择文件</p>
              </Upload.Dragger>
            </Form.Item>
            {source && <div className={styles.sourceSummary}>
              <FileOutlined aria-hidden />
              <div className={styles.sourceInfo}><strong>{sourceName}</strong><span>{bytesText(sourceBytes)} · {extension.toUpperCase()}{source.upload && ` · 到期 ${dateText(source.upload.expiresAt, true)}`}</span></div>
              <Tag color={sourceExpired ? 'warning' : uploadReady ? 'success' : undefined}>{sourceExpired ? '已到期' : uploadReady ? '已上传，可复用' : source.upload ? '等待完整上传' : '待上传'}</Tag>
            </div>}
            {uploadProgress && <div className={styles.transfer} aria-live="polite">
              {progressPercent !== null && <Progress percent={progressPercent} format={(value) => `${value}%`} status={uploadReady ? 'success' : actionError ? 'exception' : 'normal'} aria-label="文件上传进度" />}
              <p>{bytesText(uploadProgress.loaded)}{uploadProgress.total !== null && ` / ${bytesText(uploadProgress.total)}`} · {uploadReady ? '服务器已确认上传完成' : submitStage === 'confirming' ? '等待服务器确认' : '文件传输进度'}</p>
            </div>}

            <div className={styles.options}>
              <Form.Item label="目标格式" htmlFor="conversion-target" required>
                <Select id="conversion-target" value={targetFormat} onChange={(value) => { setSelectedTarget(value); setEngineChoice('auto'); setFormNotice(''); }}
                  options={selectedTarget && !targetSupported && !checkingCapabilities ? [...formatOptions, { value: selectedTarget, label: `${selectedTarget.toUpperCase()}（当前不可用）`, disabled: true }] : formatOptions}
                  placeholder={!source ? '请先选择源文件' : checkingCapabilities ? '正在查询可用格式' : formatOptions.length ? '选择目标格式' : '暂无可用格式'} loading={checkingCapabilities} showSearch optionFilterProp="label"
                  disabled={!source || controlsDisabled || checkingCapabilities || !formatOptions.length || !!capabilityError} aria-describedby="conversion-options-help" />
              </Form.Item>
              <Form.Item label="转换引擎" htmlFor="conversion-engine" required>
                <Select id="conversion-engine" value={engineChoice} onChange={(value: ConversionEngineChoice) => { setEngineChoice(value); setFormNotice(''); }}
                  options={[{ value: 'auto', label: '自动推荐', disabled: !supportingEngines.length }, ...(capabilities?.engines ?? []).map((engine) => ({ value: engine.id, label: `${engine.label}${engine.state !== 'ready' ? ` · ${engine.state === 'unconfigured' ? '未启用' : '暂不可用'}` : !supportingEngines.includes(engine.id) ? ' · 不支持此格式' : ''}`, disabled: engine.state !== 'ready' || !supportingEngines.includes(engine.id) }))]}
                  disabled={!source || controlsDisabled || checkingCapabilities || !targetSupported || !!capabilityError} aria-describedby="conversion-options-help" />
              </Form.Item>
            </div>
            <p id="conversion-options-help" className={styles.helpText}>{checkingCapabilities ? '正在查询可用格式和转换引擎…' : !source ? '选择文件后，会显示当前可转换的格式。' : !targetFormat ? '请选择目标格式，随后可使用自动推荐或手动选择引擎。' : uploadReady ? '更换目标格式或引擎会复用这个源文件，不会重复上传。' : '自动推荐会选择支持当前格式的可用引擎，也可以手动选择。'}</p>
            {capabilityError && <Alert type="error" showIcon title="暂时无法查询转换能力" description={capabilityError} action={<Button onClick={() => setCapabilityEpoch((old) => old + 1)} disabled={sessionExpired}>重新查询</Button>} />}
            {capabilities && readyEngineCount === 0 && <Alert type="warning" showIcon title="当前没有可用的转换引擎" description="可稍后重新查询；如果持续不可用，请联系管理员检查转换服务。已选文件会保留在本页。" />}
            {source && capabilities && readyEngineCount > 0 && !formatOptions.length && <Alert type="info" showIcon title="当前引擎不支持这个文件类型" description="请核对文件扩展名，或选择其他文件。可以查看下方引擎状态并重新查询。" />}
            {source && capabilities && targetFormat && formatOptions.length > 0 && (!targetSupported || !engineSupported) && <Alert type="warning" showIcon title="所选格式或引擎当前不可用" description={`请重新选择可用的目标格式或转换引擎。${uploadReady ? '源文件无需重新上传。' : '当前页面会保留已选本地文件。'}`} />}
            {fileTooLarge && <Alert type="warning" showIcon title={`文件超过 ${bytesText(capabilities!.maxInputBytes)} 的单文件限制`} description="请选择较小的文件。" />}
            {sourceExpired && <Alert type="warning" showIcon title="这个源文件已到期" description="请重新选择本地文件上传，或选用列表中仍有效的文件。" />}
            {queueFull && <Alert type="info" showIcon title="待处理任务已达到上限" description={`当前最多同时保留 ${capabilities!.maxPendingJobs} 个排队或处理中的任务，请等待完成后再提交。`} />}
            {formNotice && <Alert type="success" showIcon title={formNotice} />}
            <div className={styles.submitRow}>
              <Button type="primary" htmlType="submit" loading={!!submitStage} disabled={!canSubmit}>{uploadReady ? '开始转换' : '上传并转换'}</Button>
              {(submitStage === 'uploading' || submitStage === 'confirming') && <Button onClick={() => uploadRequest.current?.abort()}>停止上传</Button>}
              <span role="status">{submitStage ? stageLabels[submitStage] : capabilities ? `单文件不超过 ${bytesText(capabilities.maxInputBytes)}` : '正在读取上传限制'}</span>
            </div>
          </Form>
          <details className={styles.engineDetails}>
            <summary>查看转换引擎状态</summary>
            {checkingCapabilities ? <p role="status">正在查询…</p> : capabilities ? <ul>{capabilities.engines.map((engine) => <li key={engine.id}><div><strong>{engine.label}</strong><Tag color={engine.state === 'ready' ? 'success' : undefined}>{engine.state === 'ready' ? '可用' : engine.state === 'unconfigured' ? '未启用' : '暂不可用'}</Tag></div><p>{engine.message}</p></li>)}</ul> : <p>尚未获取引擎状态。</p>}
            <Button icon={<ReloadOutlined />} loading={checkingCapabilities} disabled={sessionExpired || !!submitStage} onClick={() => setCapabilityEpoch((old) => old + 1)}>重新查询引擎</Button>
          </details>
        </Card>

        <aside className={styles.sidebar} aria-label="源文件记录与保留说明">
          <Card className={styles.card} title={<h2>源文件记录{snapshot ? ` · ${snapshot.uploads.length}` : ''}</h2>}>
            <p className={styles.helpText}>已完成上传的文件可直接复用。未完成上传的记录也可在这里清理，释放临时空间。</p>
            {!snapshot && !listError ? <Skeleton active paragraph={{ rows: 3 }} /> : !snapshot ? <p>记录尚未读取，请使用上方“重试读取”。</p> : !snapshot.uploads.length ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有源文件记录" /> : <ul className={styles.uploadList}>
              {visibleUploads?.map((upload) => {
                const selected = source?.upload?.id === upload.id;
                const working = snapshot.jobs.some((job) => job.uploadId === upload.id && isPending(job));
                return <li key={upload.id} className={selected ? styles.selectedUpload : undefined}>
                  <strong>{upload.name}</strong>
                  <p>{bytesText(upload.bytes)} · {upload.extension.toUpperCase()}</p>
                  <p><Tag color={upload.state === 'ready' ? 'success' : 'warning'}>{upload.state === 'ready' ? '已上传，可复用' : '未完成上传'}</Tag></p>
                  <p>到期 {dateText(upload.expiresAt, true)}</p>
                  {upload.state === 'uploading' && <p>未完成上传，请重新选择本地文件。若本页仍保留原文件，可直接重新上传。</p>}
                  <div className={styles.fileActions}>
                    {upload.state === 'ready' && <Button type={selected ? 'default' : 'link'} disabled={controlsDisabled || selected || isExpired(upload.expiresAt)} onClick={() => { chooseSource({ key: ++sourceSequence.current, file: null, upload }); focusForm(); }}>{selected ? '已选用' : '选用文件'}</Button>}
                    <Button danger type="text" icon={<DeleteOutlined />} aria-label={upload.state === 'ready' ? `清理 ${upload.name} 及关联结果` : `清理 ${upload.name} 的未完成上传`} disabled={controlsDisabled || working} loading={pendingAction === `upload:${upload.id}`} onClick={() => deleteUpload(upload)}>清理</Button>
                  </div>
                  {working && <p className={styles.helpText}>有待处理任务，完成或取消后可清理。</p>}
                </li>;
              })}
            </ul>}
            {!!snapshot && snapshot.uploads.length > 5 && <Button type="link" onClick={() => setShowAllUploads((old) => !old)}>{showAllUploads ? '收起文件列表' : `查看全部 ${snapshot.uploads.length} 个文件`}</Button>}
          </Card>
          <Card className={styles.card} title={<h2>临时保留 {retentionHours} 小时</h2>}>
            <p className={styles.retentionText}>源文件和转换结果会在到期后自动清理。请按列表中的到期时间，及时下载需要保留的结果。</p>
            <p className={styles.helpText}>文件与任务仅当前账号可见。创建任务后，离开本页不会中断后台转换。</p>
          </Card>
        </aside>
      </div>

      <Card className={`${styles.card} ${styles.history}`} title={<h2>最近任务</h2>} extra={<Button icon={<ReloadOutlined />} loading={refreshing} disabled={sessionExpired} onClick={refreshRecords}>刷新记录</Button>}>
        <p className={styles.helpText} role="status">{snapshot ? `共 ${snapshot.jobs.length} 个任务${pendingCount ? `，${pendingCount} 个等待或处理中，状态自动更新。` : '。'}` : '正在读取任务记录…'}</p>
        {!snapshot && !listError ? <Skeleton active paragraph={{ rows: 4 }} /> : !snapshot ? <p>暂时无法读取最近任务，请重试。</p> : !snapshot.jobs.length ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={<><strong>还没有转换任务</strong><p>选择文件和目标格式，开始第一次转换。</p></>} /> : <ul className={styles.jobList}>
          {snapshot.jobs.map((job) => {
            const uploadAvailable = snapshot.uploads.some((upload) => upload.id === job.uploadId && upload.state === 'ready' && !isExpired(upload.expiresAt));
            return <li key={job.id} aria-labelledby={`conversion-job-${job.id}`}>
              <div className={styles.jobHeading}><h3 id={`conversion-job-${job.id}`}>{job.inputName}</h3><Tag color={job.state === 'succeeded' ? 'success' : job.state === 'failed' ? 'error' : isPending(job) ? 'processing' : undefined}>{stateLabels[job.state]}</Tag></div>
              <div className={styles.jobMeta}><span>{job.inputExtension.toUpperCase()} → {jobFormatLabel(job)}</span><span>{CONVERSION_ENGINE_LABELS[job.engine ?? job.requestedEngine]}</span><span>创建 {dateText(job.createdAt, true)}</span></div>
              <p className={styles.jobStage}>{job.stage || stateLabels[job.state]}</p>
              {job.state === 'running' && <p className={styles.helpText}>后台处理中，可以离开本页；完成后在此下载。处理时间取决于文件和所选引擎。</p>}
              {job.state === 'failed' && <Alert type="error" showIcon title="这次转换未完成" description={job.error || '可以更换引擎后使用同一个源文件重试。'} />}
              {job.state === 'succeeded' && job.outputs.length > 0 && <ul className={styles.outputList}>{job.outputs.map((output) => <li key={output.id}><div><strong>{output.name}</strong><span>{bytesText(output.bytes)}</span></div><Button icon={<DownloadOutlined />} loading={downloading === output.id} disabled={sessionExpired || !!downloading && downloading !== output.id} aria-label={`下载 ${output.name}`} onClick={() => void downloadOutput(output)}>下载</Button></li>)}</ul>}
              {job.state === 'succeeded' && !job.outputs.length && <Alert type="warning" showIcon title="尚未读取到可下载结果" description="请刷新任务记录；如果结果已到期，需要重新转换。" />}
              <div className={styles.jobFooter}>
                <span>到期 {dateText(job.expiresAt, true)}</span>
                <div className={styles.jobActions}>
                  {job.state === 'queued' && <Button disabled={controlsDisabled} loading={pendingAction === `job:${job.id}`} onClick={() => cancelJob(job)}>取消排队</Button>}
                  {!isPending(job) && <><Button disabled={controlsDisabled || !uploadAvailable} onClick={() => retryJob(job)}>{job.state === 'failed' ? '换引擎重试' : '再次转换'}</Button><Button danger icon={<DeleteOutlined />} disabled={controlsDisabled} loading={pendingAction === `job:${job.id}`} onClick={() => deleteJob(job)}>删除任务</Button></>}
                </div>
              </div>
              {!isPending(job) && !uploadAvailable && <p className={styles.helpText}>源文件已到期或不在当前列表；重试前请刷新记录或重新上传原文件。</p>}
            </li>;
          })}
        </ul>}
      </Card>
    </div>
    <Modal open={showHelp} title="格式转换使用说明" onCancel={() => setShowHelp(false)} footer={<Button type="primary" onClick={() => setShowHelp(false)}>知道了</Button>}>
      <ol className={styles.instructions}>
        <li>选择本地文件，或选用已上传的文件。可转换格式会根据文件类型和当前可用引擎显示。</li>
        <li>选择目标格式，使用“自动推荐”或手动选择引擎。更换引擎不会清空已选文件，也不会重复上传。</li>
        <li>点击“上传并转换”或“开始转换”。上传时请保持页面打开；任务创建成功后可以离开，后台继续处理。</li>
        <li>在“最近任务”查看真实处理阶段，完成后下载结果。失败时可以换引擎重试同一份源文件。</li>
      </ol>
      <p>文件与结果默认保留 {retentionHours} 小时，请以具体到期时间为准。清理源文件会同时清理它关联的任务和结果，删除单个任务则保留源文件。</p>
      <p>NCM 转换提取原始音频，输出为原文件对应的 MP3 或 FLAC；其他转换只显示当前引擎实际提供的格式。</p>
    </Modal>
  </main>;
}
