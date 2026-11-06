import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import type { LoginEventPage, MemberAccount } from '../../src/shared/accounts-contracts';
import { verifyMemberHttpIsolation } from './member-data-http-checks';

type PostAuth = (jar: string, path: string, body: object, origin?: string) => Promise<{ status: number; data: Record<string, unknown>; headers: Headers }>;

export async function verifyMemberAccounts(database: Pool, ownerId: string, cookieHeaders: (jar: string) => Headers, postAuth: PostAuth) {
  const accounts = await import('../../src/app/api/accounts/route');
  const memberRoute = await import('../../src/app/api/accounts/[id]/route');
  const passwordRoute = await import('../../src/app/api/accounts/[id]/password/route');
  const sessionsRoute = await import('../../src/app/api/accounts/[id]/revoke-sessions/route');
  const eventsRoute = await import('../../src/app/api/accounts/login-events/route');
  const { GET: authStatus } = await import('../../src/app/api/auth/status/route');
  const { requireUser, requireOwner } = await import('../../src/server/authorize');
  const request = (path: string, jar = 'a', method = 'GET', body?: unknown, origin = process.env.APP_URL!) => {
    const headers = cookieHeaders(jar);
    headers.set('origin', origin);
    headers.set('content-type', 'application/json');
    return new Request(`${process.env.APP_URL}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  };
  const password = 'Synthetic-member-password-123';
  const nextPassword = 'Synthetic-reset-password-456';
  assert.equal((await accounts.GET(request('/api/accounts', 'anonymous'))).status, 401);
  assert.equal((await accounts.POST(request('/api/accounts', 'b', 'POST', { username: 'test_member', password }))).status, 401);
  assert.equal((await accounts.POST(request('/api/accounts', 'a', 'POST', { username: 'test_member', password }, 'https://attacker.example'))).status, 403);
  for (const username of ['ADMIN', 'a', 'bad name']) {
    assert.equal((await accounts.POST(request('/api/accounts', 'a', 'POST', { username, password }))).status, 400);
  }
  const created = await accounts.POST(request('/api/accounts', 'a', 'POST', { username: 'Test_Member', name: '合成成员', password }));
  assert.equal(created.status, 201, await created.clone().text());
  const member = (await created.json() as { account: MemberAccount }).account;
  assert.equal(member.username, 'test_member');
  assert.equal(member.role, 'member');
  assert.equal(member.disabled, false);
  assert.equal((await accounts.POST(request('/api/accounts', 'a', 'POST', { username: 'TEST_MEMBER', password }))).status, 409);
  const context = { params: Promise.resolve({ id: member.id }) };
  const ownerContext = { params: Promise.resolve({ id: ownerId }) };
  assert.equal((await memberRoute.PATCH(request('/api/accounts/owner', 'a', 'PATCH', { disabled: true }), ownerContext)).status, 403);
  assert.equal((await passwordRoute.POST(request('/api/accounts/owner/password', 'a', 'POST', { password }), ownerContext)).status, 403);
  assert.equal((await sessionsRoute.POST(request('/api/accounts/owner/revoke-sessions', 'a', 'POST', {}), ownerContext)).status, 403);

  const login = await postAuth('member', '/sign-in/username', { username: 'TEST_MEMBER', password });
  assert.equal(login.status, 200, JSON.stringify(login.data));
  assert.equal(login.data.twoFactorRedirect, undefined);
  assert.equal(login.data.token, undefined);
  assert.deepEqual(await requireUser(cookieHeaders('member')), { id: member.id, role: 'member' });
  const status = await authStatus(request('/api/auth/status', 'member'));
  const state = await status.json();
  assert.equal(state.state, 'ready');
  assert.equal(state.user.role, 'member');
  assert.equal(state.user.username, 'test_member');
  await assert.rejects(requireOwner(cookieHeaders('member')), { code: 'FORBIDDEN' });
  assert.equal((await accounts.GET(request('/api/accounts', 'member'))).status, 403);
  assert.equal((await accounts.POST(request('/api/accounts', 'member', 'POST', { username: 'forbidden', password }))).status, 403);
  assert.equal((await eventsRoute.GET(request('/api/accounts/login-events', 'member'))).status, 403);
  assert.equal((await memberRoute.PATCH(request('/api/accounts/member', 'member', 'PATCH', { name: 'Changed' }), context)).status, 403);
  assert.equal((await postAuth('member', '/two-factor/enable', { password })).status, 403);

  assert.equal((await sessionsRoute.POST(request('/api/accounts/member/revoke-sessions', 'a', 'POST', {}), context)).status, 200);
  await assert.rejects(requireUser(cookieHeaders('member')), { status: 401 });
  assert.equal((await postAuth('member', '/sign-in/username', { username: member.username, password })).status, 200);
  assert.equal((await memberRoute.PATCH(request('/api/accounts/member', 'a', 'PATCH', { disabled: true }), context)).status, 200);
  await assert.rejects(requireUser(cookieHeaders('member')), { status: 401 });
  const disabled = await postAuth('disabled', '/sign-in/username', { username: member.username, password });
  assert.equal(disabled.status, 401);
  assert.equal(disabled.headers.getSetCookie().length, 0, 'disabled sign-in must not return a session');
  assert.equal((await memberRoute.PATCH(request('/api/accounts/member', 'a', 'PATCH', { disabled: false, name: '恢复后的成员' }), context)).status, 200);
  await assert.rejects(requireUser(cookieHeaders('member')), { status: 401 });
  await assert.rejects(requireUser(cookieHeaders('disabled')), { status: 401 });
  assert.equal((await postAuth('member', '/sign-in/username', { username: member.username, password })).status, 200);
  assert.equal((await postAuth('second-member-session', '/sign-in/username', { username: member.username, password })).status, 200);
  assert.equal((await passwordRoute.POST(request('/api/accounts/member/password', 'a', 'POST', { password: nextPassword }), context)).status, 200);
  await assert.rejects(requireUser(cookieHeaders('member')), { status: 401 });
  await assert.rejects(requireUser(cookieHeaders('second-member-session')), { status: 401 });
  assert.equal((await postAuth('member', '/sign-in/username', { username: member.username, password })).status, 401);
  assert.equal((await postAuth('member', '/sign-in/username', { username: member.username, password: nextPassword })).status, 200);
  const concurrentPassword = 'Synthetic-concurrent-reset-password-789';
  const [reset, concurrentLogin] = await Promise.all([
    passwordRoute.POST(request('/api/accounts/member/password', 'a', 'POST', { password: concurrentPassword }), context),
    postAuth('racing-login', '/sign-in/username', { username: member.username, password: nextPassword }),
  ]);
  assert.equal(reset.status, 200);
  assert([200, 401].includes(concurrentLogin.status));
  await assert.rejects(requireUser(cookieHeaders('racing-login')), { status: 401 });
  assert.equal((await postAuth('member', '/sign-in/username', { username: member.username, password: concurrentPassword })).status, 200);
  await verifyMemberHttpIsolation(member.id, cookieHeaders, postAuth);
  assert.equal((await postAuth('unknown', '/sign-in/username', { username: 'private_unknown_identifier', password })).status, 401);
  await database.query("UPDATE auth_session_assurance SET last_seen_at=now()-interval '3 hours' WHERE user_id=$1", [member.id]);
  await assert.rejects(requireUser(cookieHeaders('member')), { status: 401 });

  const all = await accounts.GET(request('/api/accounts'));
  const listed = await all.json() as { accounts: MemberAccount[] };
  assert.equal(listed.accounts.find((account) => account.id === ownerId)?.role, 'owner');
  assert(listed.accounts.find((account) => account.id === member.id)?.lastLoginAt);
  const audit = await eventsRoute.GET(request(`/api/accounts/login-events?accountId=${member.id}&page=1`));
  const page = await audit.json() as LoginEventPage;
  assert.equal(page.pageSize, 50);
  assert(page.events.some((event) => event.outcome === 'success' && event.method === 'password'));
  assert(page.events.some((event) => event.outcome === 'failure'));
  assert(page.events.every((event) => event.userId === member.id && event.username === 'test_member'));
  assert(page.events.every((event) => event.ipPrefix === '203.0.113.0/24' && event.userAgent === 'Other / Other'));
  const unknown = (await database.query('SELECT user_id,username FROM login_events WHERE user_id IS NULL')).rows;
  assert(unknown.length > 0);
  assert(unknown.every((event) => event.username === null));
  assert.equal((await database.query('SELECT count(*)::int AS count FROM account_management_events WHERE user_id=$1', [member.id])).rows[0].count, 6);
  // Management audit records cannot be silently changed by the runtime application role.
  const { pool } = await import('../../src/server/db');
  await assert.rejects(pool.query('DELETE FROM login_events'), { code: '42501' });
  await assert.rejects(pool.query('UPDATE account_management_events SET action=action'), { code: '42501' });
  const { POST: authenticate } = await import('../../src/app/api/auth/[...all]/route');
  for (let attempt = 0; attempt < 6; attempt++) {
    const limited = request('/api/auth/sign-in/username', 'rate-test', 'POST', { username: 'missing_account', password });
    limited.headers.set('x-forwarded-for', '198.51.100.159');
    assert.equal((await authenticate(limited)).status, attempt < 5 ? 401 : 429);
  }
}
