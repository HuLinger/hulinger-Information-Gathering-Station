import { resolve } from 'node:path';
import { Pool } from 'pg';
import { pool } from '../db';
import { readDriveConfig } from './config';
import { DriveStore } from './store';

const runtime = globalThis as typeof globalThis & { hubDriveStore?: DriveStore; hubDriveUploadPool?: Pool };
export function getDrive(): DriveStore {
  if (!runtime.hubDriveStore) {
    const config = readDriveConfig();
    runtime.hubDriveUploadPool ??= new Pool({ connectionString: process.env.DATABASE_URL, max: config.maxParallel + 2, connectionTimeoutMillis: 5000 });
    runtime.hubDriveStore = new DriveStore({ database: pool, uploadDatabase: runtime.hubDriveUploadPool, root: process.env.DRIVE_STORAGE_PATH ?? resolve('data/drive'), config });
  }
  return runtime.hubDriveStore;
}
export async function closeDrive(): Promise<void> { await runtime.hubDriveUploadPool?.end(); }
