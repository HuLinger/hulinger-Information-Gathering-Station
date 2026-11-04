import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PassThrough } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import type { lookup } from 'node:dns/promises';
import { growth, githubConfig, parseFeed, plainText } from '../src/server/collector/domain';
import { CollectorError, consumeResponse, isPublicAddress, MAX_RESPONSE_BYTES, resolvePublicAddress, retryTime, safeFetch, validateTarget } from '../src/server/collector/network';

test('出站仅允许登记的 HTTPS 域名、路径和参数', () => {
  assert.equal(validateTarget('https://openai.com/news/rss.xml').hostname, 'openai.com');
  assert.equal(validateTarget('https://api.github.com/repos/octocat/Hello-World/releases?per_page=100&page=2').hostname, 'api.github.com');
  for (const url of ['http://openai.com/news/rss.xml', 'https://user:pass@openai.com/news/rss.xml', 'https://openai.com:8443/news/rss.xml', 'https://openai.com.evil.invalid/news/rss.xml', 'https://api.github.com/user', 'https://api.github.com/repos/a/b?redirect=https://127.0.0.1', 'https://127.0.0.1/', 'file:///etc/passwd']) {
    assert.throws(() => validateTarget(url), CollectorError);
  }
});

test('公网地址验证拒绝回环、保留段、IPv6及IPv4映射绕过', () => {
  for (const ip of ['127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '198.18.0.1', '0.0.0.0', '::1', 'fe80::1', 'fc00::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1']) assert.equal(isPublicAddress(ip), false, ip);
  assert.equal(isPublicAddress('1.1.1.1'), true);
  assert.equal(isPublicAddress('2606:4700:4700::1111'), true);
});

test('DNS混合公网和私网答案整体拒绝，不只检查第一个IP', async () => {
  const mixed = (async () => [{ address: '1.1.1.1', family: 4 }, { address: '127.0.0.1', family: 4 }]) as unknown as typeof lookup;
  await assert.rejects(resolvePublicAddress('openai.com', mixed), /非公网/u);
  const publicOnly = (async () => [{ address: '1.1.1.1', family: 4 }]) as unknown as typeof lookup;
  assert.deepEqual(await resolvePublicAddress('openai.com', publicOnly), { address: '1.1.1.1', family: 4 });
});

function response(statusCode = 200, headers: IncomingMessage['headers'] = {}) {
  const stream = new PassThrough() as unknown as IncomingMessage;
  stream.statusCode = statusCode;
  stream.headers = headers;
  return stream;
}

test('不跟随重定向，也不读取重定向响应体', async () => {
  const stream = response(302, { location: 'http://169.254.169.254/latest/meta-data/' });
  await assert.rejects(consumeResponse(stream), /重定向/u);
  assert.equal(stream.destroyed, true);
});

test('内容长度和分块响应均受大小限制，禁止压缩炸弹', async () => {
  await assert.rejects(consumeResponse(response(200, { 'content-length': String(MAX_RESPONSE_BYTES + 1) })), /大小限制/u);
  await assert.rejects(consumeResponse(response(200, { 'content-encoding': 'gzip' })), /压缩/u);
  const stream = response();
  const result = consumeResponse(stream);
  (stream as unknown as PassThrough).end(Buffer.alloc(MAX_RESPONSE_BYTES + 1));
  await assert.rejects(result, /大小限制/u);
});

test('限流遵守Retry-After，不把配额拒绝当空数据', async () => {
  const stream = response(429, { 'retry-after': '120' });
  const before = Date.now();
  await assert.rejects(consumeResponse(stream), (error: unknown) => error instanceof CollectorError && Boolean(error.retryAt && error.retryAt.getTime() >= before + 120_000));
  const now = Date.parse('2026-11-04T00:00:00Z');
  assert.equal(retryTime({ 'x-ratelimit-reset': String((now + 3_600_000) / 1000) }, now).getTime(), now + 3_600_000);
});

test('GitHub配置不允许通过自定义查询或URL扩大采集面', () => {
  assert.deepEqual(githubConfig({ topic: 'llm', includePrereleases: true }), { topic: 'llm', includePrereleases: true });
  assert.throws(() => githubConfig({ url: 'https://example.com' }), /不支持/u);
  assert.throws(() => githubConfig({ topic: 'unreviewed-topic' }), /支持/u);
});

test('增长窗口保留负差、实际端点；中间缺测不补造历史', () => {
  const now = new Date('2026-11-04T12:00:00Z');
  const samples = [{ observed_at: '2026-11-03T10:00:00Z', stars: 120 }, { observed_at: now, stars: 110 }];
  assert.deepEqual(growth(samples, 24, now), { status: 'ok', delta: -10, startAt: '2026-11-03T10:00:00.000Z', endAt: now.toISOString(), hours: 26 });
  assert.equal(growth(samples.slice(1), 24, now).delta, null);
  assert.equal(growth([{ observed_at: '2026-11-03T05:00:00Z', stars: 100 }, samples[1]], 24, now).status, 'insufficient');
  assert.equal(growth(samples, 24, now.getTime() + 13 * 3_600_000).status, 'stale');
});

test('七天增长要求真实合格起点，累计Star不能替代增长', () => {
  const now = new Date('2026-11-04T12:00:00Z');
  assert.equal(growth([{ observed_at: now, stars: 100_000 }], 168, now).delta, null);
  assert.equal(growth([{ observed_at: now, stars: 100_000 }, { observed_at: '2026-10-28T12:00:00Z', stars: 99_000 }], 168, now).delta, 1000);
});

test('RSS保留未知时间、移除可执行内容，缺字段进入需核对', async () => {
  const xml = `<?xml version="1.0"?><rss version="2.0"><channel><title>Synthetic</title><link>https://openai.com</link><description>test</description>
    <item><guid>synthetic-1</guid><title>GPT-9 synthetic test</title><link>https://openai.com/index/synthetic-test</link><description><![CDATA[<p>Useful text</p><script>secret()</script>]]></description></item>
    <item><guid>synthetic-2</guid><title>Missing link</title></item></channel></rss>`;
  const [first, second] = await parseFeed('openai-news', xml);
  assert.equal(first.publishedAt, null);
  assert.equal(first.precision, 'unknown');
  assert.equal(first.summary, 'Useful text');
  assert.equal(first.entity?.name, 'GPT-9');
  assert.match(second.reviewReason ?? '', /缺少/u);
  assert.equal(plainText('<img src=x onerror=alert(1)>hello'), 'hello');
  const [tool] = await parseFeed('claude-platform', xml.replace('GPT-9 synthetic test', 'Claude Code synthetic test'));
  assert.equal(tool.kind, 'tool', 'Claude Code is a tool, not automatically a model entity');
  await assert.rejects(parseFeed('openai-news', '<!DOCTYPE rss [<!ENTITY x SYSTEM "file:///etc/passwd">]><rss/>'), /XML/u);
});

test('明确人事融资与案例宣传进入核对，不因含AI字样自动入站', async () => {
  const makeFeed = (title: string, category = 'Company') => `<rss version="2.0"><channel><title>Synthetic</title><link>https://openai.com</link><description>test</description><item><guid>${title}</guid><title>${title}</title><link>https://openai.com/index/synthetic-test</link><category>${category}</category></item></channel></rss>`;
  for (const title of ['OpenAI appoints Jill as Chief Corporate Affairs Officer', 'New funding to accelerate AI', 'How Example uses AI to help its business', 'AI policy recommendations']) {
    const [item] = await parseFeed('openai-news', makeFeed(title));
    assert.match(item.reviewReason ?? '', /人事、融资、政策或案例/u);
  }
  for (const title of ['Introducing GPT-9', 'New API release for developers', 'Launching a new SDK']) {
    const [item] = await parseFeed('openai-news', makeFeed(title));
    assert.equal(item.reviewReason, undefined);
  }
});

test('真实官方RSS通过同一安全请求层与解析器', { skip: process.env.COLLECTOR_LIVE_TEST !== '1', timeout: 75_000 }, async () => {
  for (const [id, url] of [['openai-news', 'https://openai.com/news/rss.xml'], ['microsoft-ai', 'https://blogs.microsoft.com/blog/tag/ai/feed/']]) {
    const result = await safeFetch(url);
    const items = await parseFeed(id, result.body);
    assert.ok(items.length > 0, `${id}: expected real feed entries`);
    assert.ok(items.some((item) => item.title && item.url));
    console.log(`${id}: ${items.length} real source records parsed; no collection enabled.`);
  }
});

test('真实GitHub Search/Repo/Release链路（外部配额可用时）', { skip: process.env.COLLECTOR_LIVE_TEST !== '1', timeout: 75_000 }, async (context) => {
  try {
    const result = await safeFetch('https://api.github.com/search/repositories?q=topic%3Aartificial-intelligence&sort=stars&per_page=1');
    const json = JSON.parse(result.body) as { items: { id: number; full_name: string; stargazers_count: number }[] };
    assert.ok(json.items[0]?.id && Number.isInteger(json.items[0].stargazers_count));
    const repo = JSON.parse((await safeFetch(`https://api.github.com/repos/${json.items[0].full_name}`)).body) as { id: number };
    assert.equal(repo.id, json.items[0].id);
    const releases = JSON.parse((await safeFetch(`https://api.github.com/repos/${json.items[0].full_name}/releases?per_page=1`)).body);
    assert.ok(Array.isArray(releases));
  } catch (error) {
    if (error instanceof CollectorError && error.retryAt) {
      context.skip(`Live GitHub verification deferred by upstream rate limit until ${error.retryAt.toISOString()}; not counted as API success.`);
      return;
    }
    throw error;
  }
});
