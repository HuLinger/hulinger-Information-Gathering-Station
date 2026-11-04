import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import { authConfiguration } from '../src/server/auth';

const environment = (): NodeJS.ProcessEnv => ({
  APP_URL: 'https://hub.example.test',
  DATABASE_URL: 'postgresql://test:synthetic@localhost/hulinger_test',
  BETTER_AUTH_SECRET: randomBytes(32).toString('hex'),
  NODE_ENV: 'production',
});

test('production auth fails closed for missing or insecure configuration', () => {
  for (const key of ['APP_URL', 'DATABASE_URL', 'BETTER_AUTH_SECRET']) {
    const env = environment();
    delete env[key];
    assert.throws(() => authConfiguration(env));
  }
  for (const APP_URL of ['http://hub.example.test', 'http://127.0.0.1:3000', 'https://hub.example.test/path', 'https://user:pass@hub.example.test']) {
    assert.throws(() => authConfiguration({ ...environment(), APP_URL }));
  }
  assert.throws(() => authConfiguration({ ...environment(), BETTER_AUTH_SECRET: 'replace-with-a-real-secret-of-sufficient-length' }));
  assert.throws(() => authConfiguration({ ...environment(), DATABASE_URL: 'postgresql://test@localhost/test' }));
});

test('only loopback development allows insecure cookies', () => {
  const result = authConfiguration({ ...environment(), NODE_ENV: 'development', APP_URL: 'http://127.0.0.1:3000' });
  assert.equal(result.secureCookies, false);
  assert.equal(result.origin, 'http://127.0.0.1:3000');
  assert.throws(() => authConfiguration({ ...environment(), NODE_ENV: 'development', APP_URL: 'http://0.0.0.0:3000' }));
  assert.equal(authConfiguration(environment()).secureCookies, true);
});
