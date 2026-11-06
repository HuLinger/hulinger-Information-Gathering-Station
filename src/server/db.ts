import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { AsyncLocalStorage } from 'node:async_hooks';

const globalDb = globalThis as typeof globalThis & { hubPool?: Pool };
export const pool = globalDb.hubPool ?? new Pool({ connectionString: process.env.DATABASE_URL, max: 10, connectionTimeoutMillis: 5000 });
if (process.env.NODE_ENV !== 'production') globalDb.hubPool = pool;
export async function query<T extends QueryResultRow = QueryResultRow>(sql: string, values: unknown[] = []): Promise<T[]> {
  return (await pool.query<T>(sql, values)).rows;
}
export async function transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try { await client.query('BEGIN'); const result = await fn(client); await client.query('COMMIT'); return result; }
  catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

// Only authenticated HTTP handlers and validated worker jobs establish this scope.
// It carries an identity, never a pooled connection or a session-wide SQL setting.
const accountScope = new AsyncLocalStorage<string>();
export function withAccountScope<T>(accountId: string, fn: () => Promise<T>): Promise<T> {
  if (!accountId || accountId.length > 150) throw new Error('Account context is required');
  const current = accountScope.getStore();
  if (current && current !== accountId) throw new Error('Cannot switch accounts inside an operation');
  return accountScope.run(accountId, fn);
}
export function currentAccountId(): string {
  const accountId = accountScope.getStore();
  if (!accountId) throw new Error('Account context is required');
  return accountId;
}
export async function accountTransaction<T>(fn: (client: PoolClient) => Promise<T>, repeatableRead = false): Promise<T> {
  const accountId = currentAccountId();
  return transaction(async (client) => {
    if (repeatableRead) await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await client.query("SELECT set_config('hub.account_id', $1, true)", [accountId]);
    return fn(client);
  });
}
export async function accountQuery<T extends QueryResultRow = QueryResultRow>(sql: string, values: unknown[] = []): Promise<T[]> {
  return accountTransaction(async (client) => (await client.query<T>(sql, values)).rows);
}

export async function activeAccountIds(): Promise<string[]> {
  const rows = await query<{ id: string }>(`SELECT value->>'id' AS id FROM app_settings WHERE key='owner'
    UNION SELECT user_id AS id FROM member_accounts WHERE disabled=false`);
  return rows.map((row) => row.id).filter(Boolean);
}
export async function allAccountIds(): Promise<string[]> {
  const rows = await query<{ id: string }>(`SELECT value->>'id' AS id FROM app_settings WHERE key='owner'
    UNION SELECT user_id AS id FROM member_accounts`);
  return rows.map((row) => row.id).filter(Boolean);
}
