import { Pool, type PoolClient, type QueryResultRow } from 'pg';

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
