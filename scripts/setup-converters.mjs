import { randomBytes } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv, promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const composeFile = resolve(repositoryRoot, 'integrations/conversion/compose.yml');
const runtimeKeys = ['CONVERTX_URL', 'TRANSMUTE_URL', 'TRANSMUTE_API_KEY', 'STIRLING_PDF_URL', 'NCMDUMP_URL'];
const defaultUrls = {
  CONVERTX_URL: 'http://127.0.0.1:8091',
  TRANSMUTE_URL: 'http://127.0.0.1:8092',
  STIRLING_PDF_URL: 'http://127.0.0.1:8093',
  NCMDUMP_URL: 'http://127.0.0.1:8094',
};

class SetupError extends Error {}

export function parseArguments(args) {
  const options = {
    envFile: resolve(repositoryRoot, '.env.conversion'),
    runtimeEnvFile: undefined,
    start: false,
    initialize: false,
    buildEngines: [],
    waitSeconds: 300,
    help: false,
  };
  const takeValue = (index, name) => {
    const value = args[index + 1];
    if (!value || value.startsWith('--')) throw new SetupError(`缺少 ${name} 的值。`);
    return value;
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    switch (argument) {
      case '--env-file': options.envFile = resolve(takeValue(index++, argument)); break;
      case '--runtime-env-file': options.runtimeEnvFile = resolve(takeValue(index++, argument)); break;
      case '--start': options.start = true; options.initialize = true; break;
      case '--initialize': options.initialize = true; break;
      case '--build': options.buildEngines.push('gateway', 'stirling', 'ncmdump'); break;
      case '--build-engine': {
        const engine = takeValue(index++, argument);
        if (!['gateway', 'stirling', 'ncmdump'].includes(engine)) {
          throw new SetupError('--build-engine 只接受 gateway、stirling 或 ncmdump。');
        }
        options.buildEngines.push(engine);
        break;
      }
      case '--wait-seconds': {
        const value = takeValue(index++, argument);
        if (!/^[1-9][0-9]{0,3}$/u.test(value) || Number(value) > 3600) {
          throw new SetupError('--wait-seconds 必须是 1 至 3600。');
        }
        options.waitSeconds = Number(value);
        break;
      }
      case '--help': options.help = true; break;
      default: throw new SetupError(`未知参数：${argument.split('=')[0]}。运行 --help 查看用法。`);
    }
  }
  options.buildEngines = [...new Set(options.buildEngines)];
  options.runtimeEnvFile ??= `${options.envFile}.runtime`;
  if (options.envFile === options.runtimeEnvFile) {
    throw new SetupError('凭据文件和运行配置文件必须使用不同路径。');
  }
  return options;
}

export function parseConfiguration(content) {
  const values = parseEnv(content);
  const seen = new Set();
  for (const line of content.split(/\r?\n/u)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/u);
    if (!match) continue;
    if (seen.has(match[1])) throw new SetupError(`配置包含重复键 ${match[1]}，请先消除歧义。`);
    seen.add(match[1]);
  }
  for (const [key, value] of Object.entries(values)) {
    if (/[\r\n\0]/u.test(value)) throw new SetupError(`配置 ${key} 不允许换行或 NUL。`);
  }
  return values;
}

function quoteValue(value) {
  if (/[\r\n\0']/u.test(value)) throw new SetupError('生成的配置值包含不支持的字符。');
  return `'${value}'`;
}

export function addConfiguration(content, additions) {
  const current = parseConfiguration(content);
  let next = content.replace(/\r\n/gu, '\n');
  for (const [key, value] of Object.entries(additions)) {
    if (current[key] && current[key] !== value) {
      throw new SetupError(`已有 ${key}，不会自动替换。`);
    }
    if (current[key] === value) continue;
    const replacement = `${key}=${quoteValue(value)}`;
    const line = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=.*$`, 'mu');
    if (Object.hasOwn(current, key)) next = next.replace(line, () => replacement);
    else next = `${next.trimEnd()}\n${replacement}\n`;
  }
  return next.endsWith('\n') ? next : `${next}\n`;
}

async function readOptionalFile(path) {
  try {
    const stat = await fs.lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new SetupError('配置路径必须是普通文件，不能是符号链接。');
    return await fs.readFile(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return '';
    throw error;
  }
}

async function requireUntrackedSecretPath(path) {
  const child = relative(repositoryRoot, path);
  if (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child)) {
    try {
      await execFileAsync('git', ['check-ignore', '--quiet', '--', child], { cwd: repositoryRoot });
    } catch {
      throw new SetupError('仓库内凭据文件必须匹配 .gitignore；请使用 .env.conversion 或仓库外路径。');
    }
  }
}

async function restrictPermissions(path) {
  if (process.platform !== 'win32') {
    await fs.chmod(path, 0o600);
    return;
  }
  const { stdout } = await execFileAsync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { windowsHide: true });
  const sid = stdout.match(/S-1-\d+(?:-\d+)+/u)?.[0];
  if (!sid) throw new SetupError('无法确认当前 Windows 用户，未保存凭据文件。');
  await execFileAsync('icacls.exe', [path, '/inheritance:r', '/grant:r', `*${sid}:(F)`], { windowsHide: true });
}

async function writePrivateFile(path, content, expectedContent) {
  await requireUntrackedSecretPath(path);
  await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await fs.writeFile(temporary, content, { flag: 'wx', mode: 0o600 });
    await restrictPermissions(temporary);
    if (await readOptionalFile(path) !== expectedContent) {
      throw new SetupError('配置文件在操作期间被其他程序修改，未覆盖。');
    }
    await fs.rename(temporary, path);
  } finally {
    await fs.unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  }
}

function validateBaseUrl(raw, name) {
  let url;
  try { url = new URL(raw); } catch { throw new SetupError(`${name} 不是有效 URL。`); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash
      || !['', '/'].includes(url.pathname)) {
    throw new SetupError(`${name} 必须是无凭据、查询参数和子路径的 HTTP(S) 地址。`);
  }
  return url.origin;
}

function transmuteBootstrapUrl(raw) {
  const url = new URL(validateBaseUrl(raw, 'TRANSMUTE_URL'));
  if (!['127.0.0.1', '[::1]', 'localhost', 'transmute', 'conversion-transmute'].includes(url.hostname)) {
    throw new SetupError('初始化只允许回环地址或专用 Docker 服务名，未向其他主机发送凭据。');
  }
  return url.origin;
}

async function apiJson(baseUrl, path, { method = 'GET', token, body, timeout = 10000 } = {}) {
  let response;
  try {
    response = await fetch(new URL(path, baseUrl), {
      method,
      headers: {
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      redirect: 'error',
      signal: AbortSignal.timeout(timeout),
    });
  } catch {
    throw new SetupError('Transmute 请求未完成；请检查回环端口、容器健康和网络。');
  }
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new SetupError(`Transmute 拒绝认证或权限不足（HTTP ${response.status}）；请恢复现有账号凭据/API key，不会重置账号。`);
    }
    throw new SetupError(`Transmute 初始化接口返回 HTTP ${response.status}；未输出上游响应内容。`);
  }
  const text = await response.text();
  if (text.length > 1024 * 1024) throw new SetupError('Transmute 初始化响应超出预期大小。');
  try { return text ? JSON.parse(text) : {}; }
  catch { throw new SetupError('Transmute 初始化接口未返回预期 JSON。'); }
}

async function waitForTransmute(baseUrl, seconds) {
  const deadline = Date.now() + seconds * 1000;
  do {
    try {
      await apiJson(baseUrl, '/api/health/ready', { timeout: 5000 });
      return;
    } catch {
      if (Date.now() >= deadline) break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 2000));
    }
  } while (Date.now() < deadline);
  throw new SetupError('等待 Transmute 就绪超时；配置已保留，未重置账号。');
}

export async function initializeTransmute(values, persistApiKey, { waitSeconds = 300 } = {}) {
  const baseUrl = transmuteBootstrapUrl(values.TRANSMUTE_URL);
  await waitForTransmute(baseUrl, waitSeconds);
  const bootstrap = await apiJson(baseUrl, '/api/users/bootstrap-status');
  if (typeof bootstrap.requires_setup !== 'boolean') {
    throw new SetupError('Transmute bootstrap-status 响应与固定版本契约不符。');
  }
  if (bootstrap.requires_setup) {
    if (values.TRANSMUTE_API_KEY) {
      throw new SetupError('Transmute 数据库为空但已有 API key；请恢复成对的数据库和凭据，不会自动重建账号。');
    }
    if (!values.TRANSMUTE_ADMIN_USERNAME || !values.TRANSMUTE_ADMIN_PASSWORD) {
      throw new SetupError('首次初始化缺少专用账号凭据。');
    }
    await apiJson(baseUrl, '/api/users', {
      method: 'POST',
      body: { username: values.TRANSMUTE_ADMIN_USERNAME, password: values.TRANSMUTE_ADMIN_PASSWORD },
    });
  }

  let administrationToken = values.TRANSMUTE_API_KEY;
  if (values.TRANSMUTE_ADMIN_USERNAME && values.TRANSMUTE_ADMIN_PASSWORD) {
    const session = await apiJson(baseUrl, '/api/users/authenticate', {
      method: 'POST',
      body: { username: values.TRANSMUTE_ADMIN_USERNAME, password: values.TRANSMUTE_ADMIN_PASSWORD },
    });
    if (typeof session.access_token !== 'string' || session.user?.role !== 'admin') {
      throw new SetupError('保存的 Transmute 账号不是可管理清理设置的管理员。');
    }
    administrationToken = session.access_token;
  }
  if (!administrationToken) throw new SetupError('现有 Transmute 缺少可用凭据；请恢复专用账号或管理员 API key。');

  if (values.TRANSMUTE_API_KEY) {
    await apiJson(baseUrl, '/api/api-keys', { token: values.TRANSMUTE_API_KEY });
  } else {
    const existing = await apiJson(baseUrl, '/api/api-keys', { token: administrationToken });
    if (!Array.isArray(existing.api_keys)) throw new SetupError('Transmute API key 列表响应与固定版本契约不符。');
    if (existing.api_keys.some((key) => key.name === 'hulinger-worker')) {
      throw new SetupError('上游已有 hulinger-worker key，但本地原始 key 丢失；请恢复凭据或明确撤销后重建，不会自动增发。');
    }
    const created = await apiJson(baseUrl, '/api/api-keys', {
      method: 'POST', token: administrationToken, body: { name: 'hulinger-worker' },
    });
    if (typeof created.raw_key !== 'string' || !created.raw_key || /[\r\n\0]/u.test(created.raw_key)) {
      throw new SetupError('Transmute 未返回可保存的原始 API key。');
    }
    await persistApiKey(created.raw_key);
    values.TRANSMUTE_API_KEY = created.raw_key;
  }

  const configured = await apiJson(baseUrl, '/api/settings', {
    method: 'PATCH', token: administrationToken,
    body: { cleanup_enabled: true, cleanup_ttl_minutes: 1440, keep_originals: true },
  });
  if (configured.cleanup_enabled !== true || configured.cleanup_ttl_minutes !== 1440 || configured.keep_originals !== true) {
    throw new SetupError('Transmute 未确认 24 小时清理设置；凭据已保留，请检查固定版本。');
  }
}

function runDocker(args, values) {
  return new Promise((resolveRun, reject) => {
    const child = spawn('docker', [
      'compose', '--project-name', 'hulinger-conversion', '--env-file', values.envFile, '-f', composeFile, ...args,
    ], {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        CONVERTX_JWT_SECRET: values.configuration.CONVERTX_JWT_SECRET,
        TRANSMUTE_AUTH_SECRET_KEY: values.configuration.TRANSMUTE_AUTH_SECRET_KEY,
      },
      stdio: 'inherit', windowsHide: true, shell: false,
    });
    child.once('error', () => reject(new SetupError('无法运行 Docker Compose，请先安装并启动 Docker Desktop/WSL2 Linux 引擎。')));
    child.once('exit', (code) => code === 0
      ? resolveRun()
      : reject(new SetupError('Docker Compose 操作失败；配置已保留，未删除容器或数据卷。')));
  });
}

async function saveRuntimeFile(path, values) {
  const original = await readOptionalFile(path);
  const current = parseConfiguration(original);
  if (current.TRANSMUTE_API_KEY && current.TRANSMUTE_API_KEY !== values.TRANSMUTE_API_KEY) {
    throw new SetupError('运行配置中的 API key 与凭据文件不一致，未覆盖；请恢复匹配文件。');
  }
  const text = '# Generated runtime variables. Merge only these into the existing web and worker environment.\n'
    + '# Private: do not commit, print, or share this file.\n'
    + runtimeKeys.map((key) => `${key}=${quoteValue(values[key] ?? '')}`).join('\n') + '\n';
  if (text !== original) await writePrivateFile(path, text, original);
}

export async function main(args = process.argv.slice(2)) {
  const options = parseArguments(args);
  if (options.help) {
    console.log(`用法：node scripts/setup-converters.mjs [选项]
默认只准备独立引擎配置，不启动 Docker 或修改现有 web/worker。
  --env-file PATH          凭据文件（默认仓库根 .env.conversion）
  --runtime-env-file PATH  主站变量文件（默认凭据路径加 .runtime）
  --build                 构建本地网关、Stirling、NCM 镜像
  --build-engine NAME     只构建 gateway、stirling 或 ncmdump，可重复
  --start                 启动四引擎并初始化 Transmute（需要先构建本地镜像）
  --initialize            只初始化已经运行的 Transmute
  --wait-seconds N        就绪等待秒数，默认 300，最大 3600
  --help                  显示帮助`);
    return;
  }

  await requireUntrackedSecretPath(options.envFile);
  await requireUntrackedSecretPath(options.runtimeEnvFile);
  await fs.mkdir(dirname(options.envFile), { recursive: true, mode: 0o700 });
  const lockPath = `${options.envFile}.lock`;
  let lock;
  try { lock = await fs.open(lockPath, 'wx', 0o600); }
  catch (error) {
    if (error.code === 'EEXIST') throw new SetupError('初始化锁已存在；确认没有其他初始化进程后再移除该 .lock 文件。');
    throw error;
  }
  try {
    let document = await readOptionalFile(options.envFile);
    const current = parseConfiguration(document);
    const existingRuntime = parseConfiguration(await readOptionalFile(options.runtimeEnvFile));
    if (existingRuntime.TRANSMUTE_API_KEY && !current.TRANSMUTE_API_KEY) {
      throw new SetupError('运行配置保留着 API key，但凭据文件中缺失；请先恢复匹配的凭据文件，未生成替代密钥。');
    }
    const additions = {};
    for (const [key, value] of Object.entries(defaultUrls)) {
      if (!current[key]) additions[key] = value;
      else validateBaseUrl(current[key], key);
    }
    for (const key of ['CONVERTX_JWT_SECRET', 'TRANSMUTE_AUTH_SECRET_KEY']) {
      if (!current[key]) {
        if (current.TRANSMUTE_API_KEY && key === 'TRANSMUTE_AUTH_SECRET_KEY') {
          throw new SetupError('已有 Transmute API key 但缺少固定 AUTH_SECRET_KEY，请恢复凭据文件，未生成替代密钥。');
        }
        additions[key] = randomBytes(48).toString('base64url');
      } else if (current[key].length < 32) {
        throw new SetupError(`${key} 少于 32 字符；请明确更新现有部署的密钥，不会自动覆盖。`);
      }
    }
    if (!current.TRANSMUTE_API_KEY) {
      if (!current.TRANSMUTE_ADMIN_USERNAME) additions.TRANSMUTE_ADMIN_USERNAME = 'hulinger-conversion-admin';
      if (!current.TRANSMUTE_ADMIN_PASSWORD) additions.TRANSMUTE_ADMIN_PASSWORD = randomBytes(36).toString('base64url');
    }
    const updated = addConfiguration(document || '# Private conversion engine credentials. Do not commit or print.\n', additions);
    if (updated !== document) {
      await writePrivateFile(options.envFile, updated, document);
      document = updated;
    }
    const values = parseConfiguration(document);
    if (values.TRANSMUTE_ADMIN_PASSWORD && values.TRANSMUTE_ADMIN_PASSWORD.length < 8) {
      throw new SetupError('已保存的 Transmute 密码不足 8 字符，不会自动覆盖。');
    }
    const dockerValues = { envFile: options.envFile, configuration: values };
    if (options.buildEngines.length || options.start) {
      await runDocker(['config', '--quiet'], dockerValues);
    }
    if (options.buildEngines.length) {
      await runDocker(['build', ...options.buildEngines], dockerValues);
    }
    if (options.start) {
      await runDocker(['up', '--detach', '--no-build', '--wait', '--wait-timeout', String(options.waitSeconds)], dockerValues);
    }
    if (options.initialize) {
      console.log('正在检查 Transmute 初始化状态；不会输出密码、令牌或 API key。');
      await initializeTransmute(values, async (key) => {
        const next = addConfiguration(document, { TRANSMUTE_API_KEY: key });
        await writePrivateFile(options.envFile, next, document);
        document = next;
      }, { waitSeconds: options.waitSeconds });
      console.log('Transmute 认证及 24 小时清理设置已确认。');
    }
    await saveRuntimeFile(options.runtimeEnvFile, values);
    console.log('配置已保存，现有密钥已保留。运行变量另存至指定 .runtime 文件，请仅将其中五项并入现有 web/worker 配置。');
    if (!values.TRANSMUTE_API_KEY) {
      console.log('Transmute API key 尚未初始化；运行 --build --start 或对已运行的引擎使用 --initialize。');
    }
  } finally {
    await lock.close();
    await fs.unlink(lockPath);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof SetupError ? error.message : '转换引擎配置失败；请检查文件权限和本地环境。未输出私密错误详情。');
    process.exitCode = 1;
  });
}
