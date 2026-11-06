import { randomUUID } from 'node:crypto';
import { hashPassword } from 'better-auth/crypto';
import ipaddr from 'ipaddr.js';
import { Pool, type PoolClient } from 'pg';
import { z } from 'zod';
import type { LoginEvent, LoginEventPage, MemberAccount } from '../shared/accounts-contracts';
import { AuthError } from './authorize';
import { pool, query, transaction } from './db';

const username = z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9_.-]{2,31}$/)
  .refine((value) => value !== 'admin', 'admin 为主账号保留');
const password = z.string().min(14).max(128);
const displayName = z.string().trim().min(1).max(80);
const createInput = z.object({ username, password, name: displayName.optional() }).strict();
const updateInput = z.object({ name: displayName.optional(), disabled: z.boolean().optional() }).strict()
  .refine((value) => value.name !== undefined || value.disabled !== undefined);

// A separate small pool prevents waiting authentication locks from exhausting the auth query pool.
let lockPool: Pool | undefined;
function accountLockPool() {
  return lockPool ??= new Pool({ connectionString: process.env.DATABASE_URL, max: 4, connectionTimeoutMillis: 5000, idleTimeoutMillis: 1000, allowExitOnIdle: true });
}
export async function closeAccountConnections() { await lockPool?.end(); lockPool = undefined; }

export async function withAccountLock<T>(id: string, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await accountLockPool().connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query('SELECT pg_advisory_xact_lock(746104205, hashtext($1))', [id]);
    const value = await work(client);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

const accountSelect = `SELECT u.id, u.username, u.name,
  CASE WHEN u.id = (SELECT value->>'id' FROM app_settings WHERE key='owner') THEN 'owner' ELSE 'member' END AS role,
  COALESCE(m.disabled, false) AS disabled, u."createdAt" AS "createdAt",
  (SELECT max(occurred_at) FROM login_events WHERE user_id=u.id AND outcome='success') AS "lastLoginAt"
  FROM "user" u LEFT JOIN member_accounts m ON m.user_id=u.id
  WHERE (m.user_id IS NOT NULL OR u.id=(SELECT value->>'id' FROM app_settings WHERE key='owner'))`;

export async function listAccounts(): Promise<MemberAccount[]> {
  return query<MemberAccount>(`${accountSelect} ORDER BY CASE WHEN m.user_id IS NULL THEN 0 ELSE 1 END, u."createdAt", u.id`);
}

async function getAccount(id: string): Promise<MemberAccount> {
  const [account] = await query<MemberAccount>(`${accountSelect} AND u.id=$1`, [id]);
  if (!account) throw new AuthError(404, 'ACCOUNT_NOT_FOUND', '账号不存在。');
  return account;
}

async function auditManagement(client: PoolClient, actorId: string, id: string, action: string) {
  await client.query('INSERT INTO account_management_events(id, actor_id, user_id, action) VALUES($1,$2,$3,$4)', [randomUUID(), actorId, id, action]);
}

export async function createMember(actorId: string, input: unknown): Promise<MemberAccount> {
  const values = createInput.parse(input);
  const id = randomUUID();
  const hashed = await hashPassword(values.password);
  try {
    await transaction(async (client) => {
      await client.query(`INSERT INTO "user"(id, username, name, email, "emailVerified", "twoFactorEnabled", "createdAt", "updatedAt")
        VALUES($1,$2,$3,$4,true,false,now(),now())`, [id, values.username, values.name ?? values.username, `${id}@members.invalid`]);
      await client.query(`INSERT INTO account(id,"accountId","providerId","userId",password,"createdAt","updatedAt")
        VALUES($1,$2,'credential',$2,$3,now(),now())`, [randomUUID(), id, hashed]);
      await client.query('INSERT INTO member_accounts(user_id,created_by) VALUES($1,$2)', [id, actorId]);
      await auditManagement(client, actorId, id, 'member_created');
    });
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === '23505') {
      throw new AuthError(409, 'USERNAME_TAKEN', '此用户名已被使用，请换一个。');
    }
    throw error;
  }
  return getAccount(id);
}

async function requireManagedMember(client: PoolClient, id: string) {
  const owner = (await client.query<{ id: string }>("SELECT value->>'id' AS id FROM app_settings WHERE key='owner'")).rows[0]?.id;
  if (id === owner) throw new AuthError(403, 'OWNER_PROTECTED', '主账号的凭证和身份恢复请使用服务器管理流程。');
  const member = (await client.query<{ disabled: boolean }>('SELECT disabled FROM member_accounts WHERE user_id=$1 FOR UPDATE', [id])).rows[0];
  if (!member) throw new AuthError(404, 'ACCOUNT_NOT_FOUND', '成员账号不存在。');
  return member;
}

export async function updateMember(actorId: string, id: string, input: unknown): Promise<MemberAccount> {
  const values = updateInput.parse(input);
  await withAccountLock(id, async (client) => {
    const member = await requireManagedMember(client, id);
    if (values.name !== undefined) await client.query('UPDATE "user" SET name=$2,"updatedAt"=now() WHERE id=$1', [id, values.name]);
    if (values.disabled !== undefined) {
      await client.query('UPDATE member_accounts SET disabled=$2,updated_at=now() WHERE user_id=$1', [id, values.disabled]);
      if (values.disabled) await client.query('DELETE FROM "session" WHERE "userId"=$1', [id]);
    }
    const action = values.disabled !== undefined && values.disabled !== member.disabled
      ? values.disabled ? 'member_disabled' : 'member_enabled' : 'member_updated';
    await auditManagement(client, actorId, id, action);
  });
  return getAccount(id);
}

export async function resetMemberPassword(actorId: string, id: string, input: unknown) {
  const values = z.object({ password }).strict().parse(input);
  const hashed = await hashPassword(values.password);
  await withAccountLock(id, async (client) => {
    await requireManagedMember(client, id);
    const changed = await client.query(`UPDATE account SET password=$2,"updatedAt"=now() WHERE "userId"=$1 AND "providerId"='credential'`, [id, hashed]);
    if (changed.rowCount !== 1) throw new AuthError(409, 'CREDENTIAL_UNAVAILABLE', '账号凭证不完整，重置已停止。');
    await client.query('DELETE FROM "session" WHERE "userId"=$1', [id]);
    await auditManagement(client, actorId, id, 'password_reset');
  });
}

export async function revokeMemberSessions(actorId: string, id: string) {
  await withAccountLock(id, async (client) => {
    await requireManagedMember(client, id);
    await client.query('DELETE FROM "session" WHERE "userId"=$1', [id]);
    await auditManagement(client, actorId, id, 'sessions_revoked');
  });
}

export function loginMetadata(headers: Headers): { ipPrefix: string | null; userAgent: string } {
  let ipPrefix: string | null = null;
  const forwarded = headers.get('x-forwarded-for')?.trim() ?? '';
  // Caddy replaces this header with the peer address. Ambiguous proxy chains are not guessed.
  if (forwarded.length <= 64 && !forwarded.includes(',') && ipaddr.isValid(forwarded)) {
    const address = ipaddr.process(forwarded);
    const bytes = address.toByteArray();
    if (address.kind() === 'ipv4') { bytes[3] = 0; ipPrefix = `${ipaddr.fromByteArray(bytes).toString()}/24`; }
    else { bytes.fill(0, 6); ipPrefix = `${ipaddr.fromByteArray(bytes).toString()}/48`; }
  }
  const raw = (headers.get('user-agent') ?? '').slice(0, 1024);
  const browser = /Edg\//i.test(raw) ? 'Edge' : /Firefox\//i.test(raw) ? 'Firefox' : /(?:Chrome|CriOS)\//i.test(raw) ? 'Chrome' : /Safari\//i.test(raw) ? 'Safari' : 'Other';
  const system = /Android/i.test(raw) ? 'Android' : /(?:iPhone|iPad|iPod)/i.test(raw) ? 'iOS' : /Windows/i.test(raw) ? 'Windows' : /Macintosh|Mac OS X/i.test(raw) ? 'macOS' : /Linux/i.test(raw) ? 'Linux' : 'Other';
  return { ipPrefix, userAgent: `${browser} / ${system}` };
}

export async function recordLogin(headers: Headers, userId: string | null, outcome: LoginEvent['outcome'], method: LoginEvent['method']) {
  const metadata = loginMetadata(headers);
  await query(`INSERT INTO login_events(id,user_id,username,outcome,method,ip_prefix,user_agent)
    SELECT $1,u.id,COALESCE(u.username, CASE WHEN u.id=(SELECT value->>'id' FROM app_settings WHERE key='owner') THEN 'admin' END),$3,$4,$5,$6
    FROM (SELECT $2::text AS id) target LEFT JOIN "user" u ON u.id=target.id`, [randomUUID(), userId, outcome, method, metadata.ipPrefix, metadata.userAgent]);
}

export async function listLoginEvents(parameters: URLSearchParams): Promise<LoginEventPage> {
  const page = z.coerce.number().int().min(1).max(100_000).parse(parameters.get('page') ?? 1);
  const accountId = z.string().min(1).max(128).nullable().parse(parameters.get('accountId'));
  const where = 'WHERE ($1::text IS NULL OR user_id=$1) AND occurred_at > now() - interval \'30 days\'';
  const [{ total }] = await query<{ total: number }>(`SELECT count(*)::int AS total FROM login_events ${where}`, [accountId]);
  const events = await query<LoginEvent>(`SELECT id,user_id AS "userId",username,outcome,method,ip_prefix AS "ipPrefix",user_agent AS "userAgent",occurred_at AS "occurredAt"
    FROM login_events ${where} ORDER BY occurred_at DESC,id DESC LIMIT 50 OFFSET $2`, [accountId, (page - 1) * 50]);
  return { events, page, pageSize: 50, total };
}

export async function cleanupLoginEvents(database: Pick<Pool, 'query'> = pool) {
  await database.query("DELETE FROM login_events WHERE occurred_at < now() - interval '30 days'");
  await database.query("DELETE FROM account_management_events WHERE occurred_at < now() - interval '30 days'");
}
