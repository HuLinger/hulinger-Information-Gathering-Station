import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Pool, type PoolClient } from 'pg';
import { getMigrations } from 'better-auth/db/migration';
import { createAuth } from '../src/server/auth';

const MIGRATION_LOCK = 746_104_203;
type RuntimeRoles = { appPassword: string; workerPassword: string; appName?: string; workerName?: string };

async function runtimeRoles(client: PoolClient, roles: RuntimeRoles) {
  const appName = roles.appName ?? 'hub_app';
  const workerName = roles.workerName ?? 'hub_worker';
  if (![appName, workerName].every((name) => /^[a-z][a-z0-9_]{0,62}$/.test(name)) || appName === workerName) {
    throw new Error('Runtime roles must have distinct, safe PostgreSQL identifiers.');
  }
  // Identifiers are validated above; tests use isolated roles because PostgreSQL roles are cluster-wide.
  const app = `"${appName}"`;
  const worker = `"${workerName}"`;
  for (const [name, password] of [[appName, roles.appPassword], [workerName, roles.workerPassword]]) {
    if (!/^[A-Za-z0-9_-]{32,128}$/.test(password)) throw new Error('Runtime database passwords must contain 32–128 URL-safe characters.');
    if (!(await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [name])).rowCount) {
      await client.query(`CREATE ROLE "${name}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION`);
    }
    const { rows } = await client.query<{ command: string }>("SELECT format('ALTER ROLE %I PASSWORD %L', $1::text, $2::text) AS command", [name, password]);
    await client.query(rows[0].command);
  }
  await client.query(`
    REVOKE CREATE ON SCHEMA public FROM PUBLIC;
    GRANT USAGE ON SCHEMA public TO ${app}, ${worker};
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${app};
    GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO ${app};
    REVOKE ALL ON hub_migrations, auth_admin_audit FROM ${app};
    GRANT SELECT, INSERT, UPDATE, DELETE ON
      entities, events, sources, source_records, sync_runs, snapshots,
      revisions, merge_operations, app_settings, worker_heartbeats, export_jobs TO ${worker};
    GRANT SELECT ON separate_records TO ${worker};
    ALTER TABLE app_settings ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS web_settings_read ON app_settings;
    DROP POLICY IF EXISTS web_settings_write ON app_settings;
    DROP POLICY IF EXISTS worker_settings ON app_settings;
    CREATE POLICY web_settings_read ON app_settings FOR SELECT TO ${app} USING (true);
    CREATE POLICY web_settings_write ON app_settings FOR ALL TO ${app}
      USING (key <> 'owner') WITH CHECK (key <> 'owner');
    CREATE POLICY worker_settings ON app_settings FOR ALL TO ${worker}
      USING (key <> 'owner') WITH CHECK (key <> 'owner');
    CREATE SCHEMA IF NOT EXISTS pgboss AUTHORIZATION ${worker};
    GRANT USAGE ON SCHEMA pgboss TO ${app};
    GRANT ALL ON SCHEMA pgboss TO ${worker};
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA pgboss TO ${app};
    GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA pgboss TO ${app};
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pgboss TO ${app};
    ALTER DEFAULT PRIVILEGES FOR ROLE ${worker} IN SCHEMA pgboss
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${app};
    ALTER DEFAULT PRIVILEGES FOR ROLE ${worker} IN SCHEMA pgboss
      GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${app};
    ALTER DEFAULT PRIVILEGES FOR ROLE ${worker} IN SCHEMA pgboss
      GRANT EXECUTE ON FUNCTIONS TO ${app};
  `);
}

export async function migrate(database: Pool, options: { roles?: RuntimeRoles; directory?: string } = {}) {
  const client = await database.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK]);
    await client.query(`CREATE TABLE IF NOT EXISTS hub_migrations (
      name text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const directory = options.directory ?? resolve('migrations');
    const files = (await readdir(directory)).filter((name) => /^\d+[-\w]*\.sql$/.test(name)).sort();
    let authMigrated = false;
    for (const name of files) {
      if (name >= '002-auth.sql' && !authMigrated) {
        await (await getMigrations(createAuth(database).options)).runMigrations();
        authMigrated = true;
      }
      const sql = await readFile(resolve(directory, name), 'utf8');
      const sha256 = createHash('sha256').update(sql).digest('hex');
      const { rows } = await client.query<{ sha256: string }>('SELECT sha256 FROM hub_migrations WHERE name = $1', [name]);
      if (rows.length) {
        if (rows[0].sha256 !== sha256) throw new Error(`Applied migration ${name} changed; add a new migration instead.`);
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO hub_migrations(name, sha256) VALUES ($1, $2)', [name, sha256]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
    if (!authMigrated) throw new Error('Authentication migration file is missing.');
    if (options.roles) {
      await client.query('BEGIN');
      try {
        await runtimeRoles(client, options.roles);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK]).catch(() => {});
    client.release();
  }
}

async function main() {
  if (existsSync('.env')) process.loadEnvFile('.env');
  const connectionString = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL or MIGRATION_DATABASE_URL is required.');
  process.env.DATABASE_URL = connectionString;
  const appPassword = process.env.APP_DB_PASSWORD;
  const workerPassword = process.env.WORKER_DB_PASSWORD;
  if ((appPassword && !workerPassword) || (!appPassword && workerPassword) || (process.env.NODE_ENV === 'production' && (!appPassword || !workerPassword))) {
    throw new Error('Both APP_DB_PASSWORD and WORKER_DB_PASSWORD are required for production roles.');
  }
  const database = new Pool({ connectionString, max: 4, connectionTimeoutMillis: 5000 });
  try {
    await migrate(database, { roles: appPassword && workerPassword ? { appPassword, workerPassword } : undefined });
    process.stdout.write('数据库迁移完成。运行角色已按提供的配置设置。\n');
  } finally {
    await database.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => {
    process.stderr.write('迁移失败：检查数据库连通性、管理员权限、配置与迁移文件是否被修改；未继续启动应用。\n');
    process.exitCode = 1;
  });
}
