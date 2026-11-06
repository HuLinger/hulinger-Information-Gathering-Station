import { betterAuth } from 'better-auth';
import { twoFactor, username } from 'better-auth/plugins';
import type { Pool } from 'pg';
import { pool } from './db';

export const SESSION_MAX_AGE_SECONDS = 24 * 60 * 60;
export const SESSION_IDLE_SECONDS = 2 * 60 * 60;

export function authConfiguration(env: NodeJS.ProcessEnv = process.env) {
  if (!env.APP_URL) throw new Error('APP_URL is required.');
  const url = new URL(env.APP_URL);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('APP_URL must be an origin without credentials, query, or path.');
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local && env.NODE_ENV !== 'production')) {
    throw new Error('APP_URL must use HTTPS; HTTP is allowed only for local development.');
  }
  const secret = env.BETTER_AUTH_SECRET;
  if (!secret || secret.length < 32 || /replace|change.?me|example|placeholder/i.test(secret)) {
    throw new Error('BETTER_AUTH_SECRET must be a randomly generated secret of at least 32 characters.');
  }
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
  const database = new URL(env.DATABASE_URL);
  if (!['postgres:', 'postgresql:'].includes(database.protocol) || !database.hostname || !database.pathname.slice(1)) {
    throw new Error('DATABASE_URL must identify a PostgreSQL database.');
  }
  if (env.NODE_ENV === 'production' && !database.password) throw new Error('Production database credentials are required.');
  return { origin: url.origin, secret, secureCookies: url.protocol === 'https:' };
}

export function createAuth(database: Pool = pool, env: NodeJS.ProcessEnv = process.env) {
  const config = authConfiguration(env);
  return betterAuth({
    appName: 'Hulinger AI 资讯中心',
    baseURL: config.origin,
    basePath: '/api/auth',
    secret: config.secret,
    database,
    trustedOrigins: [config.origin],
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      minPasswordLength: 14,
      maxPasswordLength: 128,
      autoSignIn: false,
      revokeSessionsOnPasswordReset: true,
    },
    session: {
      expiresIn: SESSION_MAX_AGE_SECONDS,
      disableSessionRefresh: true,
      cookieCache: { enabled: false },
    },
    rateLimit: {
      enabled: true,
      storage: 'database',
      window: 60,
      max: 60,
      customRules: {
        '/sign-in/email': { window: 60, max: 5 },
        '/sign-in/username': { window: 60, max: 5 },
        '/two-factor/*': { window: 60, max: 10 },
      },
    },
    advanced: {
      useSecureCookies: config.secureCookies,
      cookiePrefix: 'hulinger',
      defaultCookieAttributes: { httpOnly: true, sameSite: 'lax', path: '/' },
      ipAddress: { ipAddressHeaders: ['x-forwarded-for'] },
    },
    plugins: [username({
      displayUsername: false,
      minUsernameLength: 3,
      maxUsernameLength: 32,
      usernameValidator: (value) => /^[a-zA-Z0-9][a-zA-Z0-9_.-]{2,31}$/.test(value),
    }), twoFactor({
      issuer: 'Hulinger',
      skipVerificationOnEnable: false,
      accountLockout: { enabled: true, maxFailedAttempts: 5, durationSeconds: 900 },
      backupCodeOptions: { storeBackupCodes: 'encrypted' },
    })],
    logger: { disabled: true },
  });
}

let instance: ReturnType<typeof createAuth> | undefined;

// Keep configuration lazy: a static production build does not need live secrets or a database.
export function getAuth() {
  instance ??= createAuth();
  return instance;
}
