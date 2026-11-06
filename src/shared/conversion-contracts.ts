export const CONVERSION_ENGINES = ['convertx', 'transmute', 'stirling', 'ncmdump'] as const;
export type ConversionEngine = typeof CONVERSION_ENGINES[number];
export type ConversionEngineChoice = ConversionEngine | 'auto';
export type ConversionState = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export const CONVERSION_ENGINE_LABELS: Record<ConversionEngineChoice, string> = {
  auto: '自动推荐', convertx: 'ConvertX', transmute: 'Transmute',
  stirling: 'Stirling-PDF', ncmdump: 'NCM 音乐转换',
};

export type ConversionEngineStatus = {
  id: ConversionEngine;
  label: string;
  state: 'ready' | 'unavailable' | 'unconfigured';
  message: string;
};
export type ConversionOption = {
  format: string;
  label: string;
  engine: ConversionEngine;
};
export type ConversionCapabilities = {
  engines: ConversionEngineStatus[];
  options: ConversionOption[];
  maxInputBytes: number;
  retentionHours: number;
  maxPendingJobs: number;
};
export type ConversionUpload = {
  id: string;
  name: string;
  extension: string;
  bytes: number;
  state: 'uploading' | 'ready';
  createdAt: string;
  expiresAt: string;
};
export type ConversionOutput = {
  id: string;
  name: string;
  bytes: number;
  mime: string;
};
export type ConversionJob = {
  id: string;
  uploadId: string;
  inputName: string;
  inputExtension: string;
  targetFormat: string;
  requestedEngine: ConversionEngineChoice;
  engine: ConversionEngine | null;
  state: ConversionState;
  stage: string;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  expiresAt: string;
  outputs: ConversionOutput[];
};
