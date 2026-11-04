import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { hashPassword } from 'better-auth/crypto';
import { Pool } from 'pg';

function validatePassword(password: string) {
  if (password.length < 14 || password.length > 128) throw new Error('密码长度必须为 14–128 个字符。');
}

export async function createOwnerAccount(database: Pool, email: string, password: string, name = 'Hulinger') {
  validatePassword(password);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) throw new Error('请提供有效邮箱作为登录标识。');
  if (!name.trim() || name.length > 80) throw new Error('显示名称应为 1–80 个字符。');
  const hashed = await hashPassword(password);
  const client = await database.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(746104204)');
    if ((await client.query('SELECT 1 FROM "user" LIMIT 1')).rowCount) throw new Error('已存在拥有者；不会覆盖账号。');
    const id = randomUUID();
    await client.query(`INSERT INTO "user" (id, name, email, "emailVerified", "twoFactorEnabled", "createdAt", "updatedAt")
      VALUES ($1, $2, $3, true, false, now(), now())`, [id, name.trim(), email.trim().toLowerCase()]);
    await client.query(`INSERT INTO account (id, "accountId", "providerId", "userId", password, "createdAt", "updatedAt")
      VALUES ($1, $2, 'credential', $2, $3, now(), now())`, [randomUUID(), id, hashed]);
    await client.query("INSERT INTO app_settings(key, value) VALUES ('owner', $1::jsonb)", [JSON.stringify({ id })]);
    await client.query("INSERT INTO auth_admin_audit(id, action, user_id) VALUES ($1, 'owner_created', $2)", [randomUUID(), id]);
    await client.query('COMMIT');
    return id;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function recoverOwnerAccount(database: Pool, password: string) {
  validatePassword(password);
  const hashed = await hashPassword(password);
  const client = await database.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(746104204)');
    const { rows } = await client.query<{ id: string }>("SELECT value->>'id' AS id FROM app_settings WHERE key = 'owner' FOR UPDATE");
    const id = rows[0]?.id;
    if (!id) throw new Error('没有已配置的拥有者，请先执行 create。');
    const result = await client.query(`UPDATE account SET password = $1, "updatedAt" = now()
      WHERE "userId" = $2 AND "providerId" = 'credential'`, [hashed, id]);
    if (result.rowCount !== 1) throw new Error('拥有者凭证不完整，恢复已停止。');
    await client.query('DELETE FROM "session" WHERE "userId" = $1', [id]);
    await client.query('DELETE FROM "twoFactor" WHERE "userId" = $1', [id]);
    await client.query('DELETE FROM verification');
    await client.query('DELETE FROM "rateLimit"');
    await client.query('UPDATE "user" SET "twoFactorEnabled" = false, "updatedAt" = now() WHERE id = $1', [id]);
    await client.query("INSERT INTO auth_admin_audit(id, action, user_id) VALUES ($1, 'owner_recovered', $2)", [randomUUID(), id]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function passwordInput() {
  const file = process.env.OWNER_PASSWORD_FILE;
  if (file) {
    const metadata = await stat(file);
    if (!metadata.isFile() || metadata.size > 1024) throw new Error('密码文件不符合要求。');
    if (process.platform !== 'win32' && (metadata.mode & 0o077) !== 0) throw new Error('密码文件权限必须为 600 或更严格。');
    return (await readFile(file, 'utf8')).replace(/\r?\n$/, '');
  }
  if (!process.stdin.isTTY) throw new Error('请使用交互终端（Docker 加 -it），或通过 OWNER_PASSWORD_FILE 指定 600 权限文件。');
  const muted = new Writable({ write(_chunk, _encoding, done) { done(); } });
  const input = createInterface({ input: process.stdin, output: muted, terminal: true });
  try {
    process.stdout.write('新密码（14–128 字符，输入不显示）：');
    const password = await input.question('');
    process.stdout.write('\n再次输入新密码：');
    const confirmation = await input.question('');
    process.stdout.write('\n');
    if (password !== confirmation) throw new Error('两次密码不一致。');
    return password;
  } finally {
    input.close();
  }
}

async function main() {
  if (existsSync('.env')) process.loadEnvFile('.env');
  const [action, ...args] = process.argv.slice(2);
  if (!['create', 'recover'].includes(action)) throw new Error('用法：npm run owner:create -- --email 你的邮箱；或 npm run owner:recover -- --confirm-recovery');
  const connectionString = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!connectionString) throw new Error('缺少管理员 DATABASE_URL。');
  if (action === 'recover' && !args.includes('--confirm-recovery')) throw new Error('恢复会撤销所有会话并要求重绑 MFA；确认后添加 --confirm-recovery。');
  const emailIndex = args.indexOf('--email');
  const email = emailIndex >= 0 ? args[emailIndex + 1] : undefined;
  if (action === 'create' && !email) throw new Error('创建时必须提供 --email。');
  const password = await passwordInput();
  const database = new Pool({ connectionString, max: 2, connectionTimeoutMillis: 5000 });
  try {
    if (action === 'create') await createOwnerAccount(database, email!, password);
    else await recoverOwnerAccount(database, password);
    process.stdout.write(action === 'create'
      ? '拥有者已创建。请登录并完成身份验证器绑定，再访问业务内容。\n'
      : '密码已重设，旧会话与恢复码已撤销。请重新登录并绑定身份验证器。\n');
  } finally {
    await database.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    // Only validation errors created here are safe to display; database errors may include parameter values.
    const known = error instanceof Error && !('code' in error) ? error.message : '数据库操作失败，请检查迁移和管理员权限。';
    process.stderr.write(`${known}\n`);
    process.exitCode = 1;
  });
}
