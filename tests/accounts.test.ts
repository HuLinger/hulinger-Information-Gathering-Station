import assert from 'node:assert/strict';
import test from 'node:test';
import { loginMetadata } from '../src/server/accounts';

test('login audit metadata stores network prefixes and device families only', () => {
  assert.deepEqual(loginMetadata(new Headers({
    'x-forwarded-for': '203.0.113.159',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/142.0.1 Safari/537.36 Edg/142.0.1 PrivateDeviceName',
  })), { ipPrefix: '203.0.113.0/24', userAgent: 'Edge / Windows' });
  assert.deepEqual(loginMetadata(new Headers({ 'x-forwarded-for': '2001:db8:abcd:1234:5678:1234:abcd:1234', 'user-agent': 'Firefox/140.0 (Linux)' })),
    { ipPrefix: '2001:db8:abcd::/48', userAgent: 'Firefox / Linux' });
  assert.equal(loginMetadata(new Headers({ 'x-forwarded-for': '::ffff:203.0.113.159' })).ipPrefix, '203.0.113.0/24');
  for (const input of ['not-an-address', '203.0.113.1, 203.0.113.2', '203.0.113.1:3456']) {
    assert.equal(loginMetadata(new Headers({ 'x-forwarded-for': input })).ipPrefix, null);
  }
  assert.deepEqual(loginMetadata(new Headers()), { ipPrefix: null, userAgent: 'Other / Other' });
});
