import { resolve } from 'node:path';

export function conversionConfig(env: NodeJS.ProcessEnv = process.env) {
  const number = (key: string, fallback: number, min: number, max: number) => {
    const value = env[key];
    if (!value) return fallback;
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < min || Number(value) > max) {
      throw new Error(`Invalid ${key} configuration.`);
    }
    return Number(value);
  };
  return {
    root: env.CONVERSION_STORAGE_PATH || resolve(/* turbopackIgnore: true */ 'data/conversion'),
    maxInputBytes: number('CONVERSION_MAX_INPUT_BYTES', 512 * 1024 ** 2, 1, 2 * 1024 ** 3),
    maxOutputBytes: number('CONVERSION_MAX_OUTPUT_BYTES', 1024 ** 3, 1, 4 * 1024 ** 3),
    accountQuotaBytes: number('CONVERSION_ACCOUNT_QUOTA_BYTES', 5 * 1024 ** 3, 1, Number.MAX_SAFE_INTEGER),
    reserveBytes: number('CONVERSION_RESERVE_BYTES', 1024 ** 3, 0, Number.MAX_SAFE_INTEGER),
    timeoutSeconds: number('CONVERSION_TIMEOUT_SECONDS', 900, 10, 3600),
    maxPendingJobs: 5,
    maxUploads: 30,
    maxOutputFiles: 100,
    retentionHours: 24,
  };
}
