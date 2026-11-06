import { Pool } from 'pg';
import { DomainError } from '../domain';

// Slow request bodies must not reserve the pool used by login and ordinary
// queries. Bound active uploads globally and fail excess admission promptly.
const runtime = globalThis as typeof globalThis & { hubConversionLocks?: Pool };
export async function conversionLockConnection() {
  if (!runtime.hubConversionLocks) {
    runtime.hubConversionLocks = new Pool({ connectionString: process.env.DATABASE_URL, application_name: 'hulinger-conversion-upload-lock', max: 4, connectionTimeoutMillis: 1000, idleTimeoutMillis: 1000, allowExitOnIdle: true });
    // pg removes failed idle clients; do not turn that event into a process exit
    // or expose database diagnostics. Checked-out streams have their own handler.
    runtime.hubConversionLocks.on('error', () => { console.error('Conversion upload database connection closed.'); });
  }
  try { return await runtime.hubConversionLocks.connect(); }
  catch { throw new DomainError('当前上传较多，请稍后重试。', 429, 'UPLOAD_BUSY'); }
}
export async function closeConversionConnections() { await runtime.hubConversionLocks?.end(); runtime.hubConversionLocks = undefined; }
