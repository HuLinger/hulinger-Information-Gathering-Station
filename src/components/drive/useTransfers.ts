'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { DriveFile, DriveUpload } from '../../shared/drive-contracts';
import { ApiError, errorMessage, requestJson } from '../api';
import { createDriveUpload, getDriveUpload, parseDriveFile } from './api';
import { abortError, downloadParts, fileFingerprint, isAbort, uploadParts, type TransferProgress } from './transfer';

export type UploadStatus = 'queued' | 'preparing' | 'checking' | 'uploading' | 'finishing' | 'pausing' | 'paused' | 'needs-file' | 'error' | 'complete' | 'canceling';
export interface UploadTask {
  key: string; name: string; size: number; local?: File; remote?: DriveFile;
  status: UploadStatus; error?: string; progress: TransferProgress;
}
export const initialProgress = (size: number, bytes = 0): TransferProgress => ({ phase: 'checking', bytes, committedBytes: bytes, total: size, bytesPerSecond: 0, remainingSeconds: null });
export const uploadRunning = (task: UploadTask) => ['preparing', 'checking', 'uploading', 'finishing'].includes(task.status);

export function useUploadQueue({ parallel, maxFileBytes, onChange, onSessionExpired }: {
  parallel: number; maxFileBytes: number; onChange: () => void; onSessionExpired: () => void;
}) {
  const [tasks, setTasks] = useState<UploadTask[]>([]);
  const tasksRef = useRef<UploadTask[]>([]);
  const mounted = useRef(true);
  const active = useRef<{ key: string; controller: AbortController; done: Promise<void> } | null>(null);
  const update = useCallback((transform: (old: UploadTask[]) => UploadTask[]) => {
    const next = transform(tasksRef.current); tasksRef.current = next;
    if (mounted.current) setTasks(next);
  }, []);
  const patch = useCallback((key: string, value: Partial<UploadTask>) => update((old) => old.map((task) => task.key === key ? { ...task, ...value } : task)), [update]);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; active.current?.controller.abort(); };
  }, []);

  const run = useCallback(async (task: UploadTask, controller: AbortController) => {
    const { signal } = controller;
    patch(task.key, { status: 'preparing', error: undefined, progress: initialProgress(task.size, task.remote?.uploadedBytes ?? 0) });
    try {
      const local = task.local;
      if (!local) throw new Error('请选择原文件后继续。');
      if (local.size > maxFileBytes) throw new Error('文件超过服务器允许的单文件上限，请调整服务器配置后重试。');
      const fingerprint = await fileFingerprint(local, signal);
      const upload = task.remote
        ? await getDriveUpload(task.remote.id, signal)
        : await createDriveUpload({ name: local.name, size: local.size, lastModified: local.lastModified, fingerprint });
      update((old) => old.filter((other) => other.key === task.key || other.remote?.id !== upload.file.id).map((other) => other.key === task.key ? { ...other, remote: upload.file } : other));
      if (signal.aborted) throw abortError();
      if (upload.file.fingerprint !== fingerprint) throw new ApiError('所选文件与原上传任务不一致，请选择原文件。', 409, 'RESUME_MISMATCH');
      if (upload.file.status !== 'ready') {
        if (upload.file.status !== 'uploading') throw new Error('此上传任务已变更或清理，请刷新云盘后重新上传。');
        await uploadParts({ local, upload, parallel, signal, onProgress: (progress) => {
          if (!signal.aborted) patch(task.key, { status: progress.phase === 'checking' ? 'checking' : progress.phase === 'finishing' ? 'finishing' : 'uploading', progress });
        } });
        const response = await requestJson<{ file: unknown }>(`/api/drive/uploads/${encodeURIComponent(upload.file.id)}/complete`, { method: 'POST', body: '{}', signal });
        const ready = parseDriveFile(response.file);
        if (ready.status !== 'ready') throw new Error('服务器尚未完成文件确认，请重试。');
        patch(task.key, { remote: ready });
      }
      patch(task.key, { status: 'complete', local: undefined, progress: { ...initialProgress(task.size, task.size), phase: 'finishing' } });
      onChange();
    } catch (error) {
      const current = tasksRef.current.find((other) => other.key === task.key);
      if (current?.status !== 'canceling') {
        patch(task.key, signal.aborted ? { status: 'paused', progress: { ...(current?.progress ?? initialProgress(task.size)), bytes: current?.progress.committedBytes ?? 0, bytesPerSecond: 0, remainingSeconds: null } } : { status: 'error', error: errorMessage(error) });
      }
      if (error instanceof ApiError && error.status === 401) {
        update((old) => old.map((other) => other.status === 'queued' ? { ...other, status: 'paused', error: '登录已失效，请重新登录后继续。' } : other));
        onSessionExpired();
      }
    }
  }, [maxFileBytes, onChange, onSessionExpired, parallel, patch, update]);

  useEffect(() => {
    if (active.current) return;
    const next = tasks.find((task) => task.status === 'queued' && task.local);
    if (!next) return;
    const current = { key: next.key, controller: new AbortController(), done: Promise.resolve() };
    active.current = current;
    current.done = run(next, current.controller).finally(() => {
      if (active.current === current) active.current = null;
      update((old) => [...old]);
    });
  }, [tasks, run, update]);

  const mergePending = useCallback((files: DriveFile[]) => update((old) => {
    const known = new Set(old.map((task) => task.remote?.id));
    const missing: UploadTask[] = files.filter((file) => !known.has(file.id)).map((file) => ({ key: `server-${file.id}`, name: file.name, size: file.size, remote: file, status: 'needs-file', progress: initialProgress(file.size, file.uploadedBytes) }));
    return missing.length ? [...old, ...missing] : old;
  }), [update]);

  function addFiles(files: File[]) {
    update((old) => {
      const next = [...old];
      for (const file of files) {
        if (next.some((task) => task.local && task.status !== 'complete' && task.local.name === file.name && task.local.size === file.size && task.local.lastModified === file.lastModified)) continue;
        next.push({ key: crypto.randomUUID(), name: file.name, size: file.size, local: file, status: file.size > maxFileBytes ? 'error' : 'queued', error: file.size > maxFileBytes ? '文件超过服务器允许的单文件上限。' : undefined, progress: initialProgress(file.size) });
      }
      return next;
    });
  }
  function resume(key: string, file?: File) {
    const task = tasksRef.current.find((item) => item.key === key);
    if (!task || uploadRunning(task) || task.status === 'canceling' || task.status === 'pausing') return;
    if (!file && !task.local) return;
    patch(key, { ...(file ? { local: file } : {}), status: 'queued', error: undefined });
  }
  function pause(key: string) {
    if (active.current?.key === key) { active.current.controller.abort(); patch(key, { status: 'pausing' }); }
    else patch(key, { status: 'paused' });
  }
  async function cancel(key: string) {
    patch(key, { status: 'canceling' });
    const current = active.current;
    if (current?.key === key) { current.controller.abort(); await current.done; }
    const task = tasksRef.current.find((item) => item.key === key);
    try {
      if (task?.remote) await requestJson(`/api/drive/files/${encodeURIComponent(task.remote.id)}`, { method: 'POST', body: JSON.stringify({ action: 'cancel', confirm: true }) });
      update((old) => old.filter((item) => item.key !== key)); onChange();
    } catch (error) {
      if (error instanceof ApiError && (error.status === 404 || error.status === 410)) { update((old) => old.filter((item) => item.key !== key)); onChange(); return; }
      patch(key, { status: 'error', error: errorMessage(error) }); throw error;
    }
  }
  function dismiss(key: string) { update((old) => old.filter((item) => item.key !== key || item.status !== 'complete')); }
  return { tasks, mergePending, addFiles, resume, pause, cancel, dismiss };
}

type DownloadStatus = 'preparing' | 'downloading' | 'finishing' | 'paused' | 'error' | 'complete' | 'canceling';
export interface DownloadTask { file: DriveFile; status: DownloadStatus; progress: TransferProgress; error?: string; canResume: boolean }
interface SavePicker {
  (options: { suggestedName: string }): Promise<{ createWritable(): Promise<FileSystemWritableFileStream> }>;
}
interface DownloadRuntime { upload: DriveUpload; sink: FileSystemWritableFileStream; completed: Set<number>; controller: AbortController; done: Promise<void>; running: boolean }
export function savePicker(): SavePicker | undefined { return typeof window !== 'undefined' ? (window as Window & { showSaveFilePicker?: SavePicker }).showSaveFilePicker?.bind(window) : undefined; }

export function useDriveDownload(parallel: number, onSessionExpired: () => void) {
  const [task, setTask] = useState<DownloadTask | null>(null);
  const runtime = useRef<DownloadRuntime | null>(null);
  const preparing = useRef(false);
  const mounted = useRef(true);
  const patch = useCallback((value: Partial<DownloadTask>) => { if (mounted.current) setTask((old) => old ? { ...old, ...value } : old); }, []);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      const current = runtime.current;
      if (current) { current.controller.abort(); void current.done.finally(() => current.sink.abort().catch(() => {})); }
    };
  }, []);

  function run(current: DownloadRuntime) {
    if (current.running) return;
    current.running = true;
    const signal = current.controller.signal;
    patch({ status: 'downloading', error: undefined, canResume: true });
    current.done = (async () => {
      let finalizing = false;
      try {
        await downloadParts({ upload: current.upload, sink: current.sink, completed: current.completed, parallel, signal, onProgress: (progress) => {
          if (!signal.aborted) patch({ progress, status: progress.phase === 'finishing' ? 'finishing' : 'downloading' });
        } });
        if (signal.aborted) throw abortError();
        finalizing = true;
        await current.sink.truncate(current.upload.file.size);
        await current.sink.close();
        runtime.current = null;
        patch({ status: 'complete', canResume: false, progress: { ...initialProgress(current.upload.file.size, current.upload.file.size), phase: 'finishing' } });
      } catch (error) {
        if (signal.aborted && !finalizing) {
          patch({ status: 'paused', progress: { ...initialProgress(current.upload.file.size, [...current.completed].reduce((sum, index) => sum + Math.min(current.upload.file.chunkSize, current.upload.file.size - index * current.upload.file.chunkSize), 0)), phase: 'transferring' } });
        } else {
          const writeFailed = finalizing || error instanceof ApiError && error.code === 'LOCAL_WRITE_FAILED';
          if (writeFailed) { await current.sink.abort().catch(() => {}); runtime.current = null; }
          patch({ status: 'error', canResume: !writeFailed, error: finalizing ? '文件保存未完成，请检查磁盘空间与权限，然后重新选择保存位置。' : errorMessage(error) });
          if (error instanceof ApiError && error.status === 401) onSessionExpired();
        }
      } finally { current.running = false; }
    })();
  }
  async function start(file: DriveFile) {
    const picker = savePicker();
    if (!picker || runtime.current || preparing.current) return;
    preparing.current = true;
    setTask({ file, status: 'preparing', progress: initialProgress(file.size), canResume: false });
    try {
      // The picker must run in the click's activation, before any request or awaited work.
      const handle = await picker({ suggestedName: file.name });
      const upload = await getDriveUpload(file.id, AbortSignal.timeout(60_000));
      if (upload.file.status !== 'ready') throw new Error('文件已变更，请刷新列表后再下载。');
      if (!mounted.current) return;
      const sink = await handle.createWritable();
      if (!mounted.current) { await sink.abort(); return; }
      const current = { upload, sink, completed: new Set<number>(), controller: new AbortController(), done: Promise.resolve(), running: false };
      runtime.current = current;
      run(current);
    } catch (error) {
      if (isAbort(error)) { if (mounted.current) setTask(null); }
      else { patch({ status: 'error', error: errorMessage(error), canResume: false }); if (error instanceof ApiError && error.status === 401) onSessionExpired(); }
    } finally { preparing.current = false; }
  }
  function pause() { runtime.current?.controller.abort(); }
  async function resume() {
    const current = runtime.current;
    if (!current) return;
    await current.done;
    if (runtime.current !== current || current.running) return;
    current.controller = new AbortController(); run(current);
  }
  async function cancel() {
    const current = runtime.current;
    if (current) {
      current.controller.abort(); patch({ status: 'canceling' });
      await current.done;
      if (runtime.current === current) { await current.sink.abort(); runtime.current = null; }
    }
    if (mounted.current) setTask(null);
  }
  return { task, start, pause, resume, cancel };
}
