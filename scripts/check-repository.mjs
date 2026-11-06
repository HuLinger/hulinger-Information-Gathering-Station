import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, posix, resolve } from 'node:path';
import { assertRepositoryRoot, git, root } from './repository.mjs';

const staged = process.argv.includes('--staged');
const errors = [];
const required = [
  'AGENTS.md', 'README.md', 'CHANGELOG.md', 'SECURITY.md',
  '.editorconfig', '.gitattributes', '.gitignore', '.node-version', 'package.json',
  'docs/project-charter.md', 'docs/engineering.md', 'docs/git-workflow.md',
  'docs/ui-standard.md', 'docs/production-readiness.md', 'docs/adr/0001-project-baseline.md',
  'design/tokens.json', '.github/workflows/quality.yml', '.github/pull_request_template.md',
  '.githooks/pre-commit', '.githooks/commit-msg',
  'scripts/repository.mjs', 'scripts/setup-git.mjs', 'scripts/check-repository.mjs',
  'scripts/check-branch.mjs', 'scripts/check-commit-message.mjs',
];

function forbiddenPath(file) {
  const name = basename(file).toLowerCase();
  const isEnvExample = /^\.env(?:\.[a-z0-9_-]+)*\.example$/u.test(name);
  return ((name === '.env' || name.startsWith('.env.')) && !isEnvExample)
    || name === '.npmrc'
    || /\.(pem|key|p12|pfx|db|sqlite3?)(?:-.*)?$/iu.test(name)
    || /\.(dump|sql\.gz)$/iu.test(name)
    || /^(credentials|service-account).*\.json$/iu.test(name)
    || /^(data|uploads|backups|exports)\//iu.test(file);
}

function textFile(file) {
  return /\.(md|json|ya?ml|m?[jt]sx?|css|html|sh|txt|toml)$/iu.test(file)
    || /^\.githooks\//u.test(file)
    || ['.editorconfig', '.gitattributes', '.gitignore', '.node-version'].includes(file);
}

function luminance(hex) {
  if (!/^#[0-9a-f]{6}$/iu.test(hex)) throw new Error(`Invalid opaque hex color: ${hex}`);
  const values = hex.slice(1).match(/../gu).map((pair) => {
    const channel = Number.parseInt(pair, 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return values[0] * 0.2126 + values[1] * 0.7152 + values[2] * 0.0722;
}

try {
  assertRepositoryRoot();
  const args = staged ? ['ls-files', '--cached', '-z'] : ['ls-files', '--cached', '--others', '--exclude-standard', '-z'];
  const files = [...new Set(git(args).split('\0').filter(Boolean))]
    .filter((file) => staged || existsSync(resolve(root, file)));
  const fileSet = new Set(files);
  const readBytes = (file) => staged ? git(['show', `:${file}`], null) : readFileSync(resolve(root,file));
  const upstreamFiles = new Set();
  const vendor = 'third_party/shattered-pixel-dungeon-web';
  // Vendored upstream has its own formats (including libGDX JSON) and original
  // line endings. Verify those bytes instead of rewriting a third-party source.
  if (fileSet.has(`${vendor}/UPSTREAM.json`)) {
    try {
      const upstream = JSON.parse(readBytes(`${vendor}/UPSTREAM.json`));
      const manifest = JSON.parse(readBytes(`${vendor}/UPSTREAM-files.json`));
      const modified = new Set(upstream.localModifiedFiles);
      if (manifest.commit !== upstream.commit || manifest.files.length !== upstream.originalTrackedFiles || !Array.isArray(upstream.localModifiedFiles)) throw new Error('Upstream manifest does not match import metadata');
      for (const entry of manifest.files) {
        const file = `${vendor}/${entry.path}`;
        if (!fileSet.has(file) || entry.path.split('/').some(part=>!part||part==='..'||part==='.') || upstreamFiles.has(file)) throw new Error(`Missing or invalid upstream file: ${entry.path}`);
        upstreamFiles.add(file);
        if (!modified.has(entry.path) && createHash('sha256').update(readBytes(file)).digest('hex') !== entry.sha256) errors.push(`Unrecorded upstream modification: ${file}`);
      }
      for (const file of modified) if (!upstreamFiles.has(`${vendor}/${file}`)) throw new Error(`Modified upstream file not in manifest: ${file}`);
    } catch (error) { errors.push(`Invalid upstream provenance: ${error.message}`); }
  }
  const ncm = 'integrations/conversion/ncmdump';
  if (fileSet.has(`${ncm}/upstream.json`)) {
    try {
      const manifest = JSON.parse(readBytes(`${ncm}/upstream.json`));
      if (manifest.commit !== '8ccdd3534d5006d3f604d3790ada8778e8973e6f' || manifest.localModifications.length) throw new Error('Unexpected LibNCM source version or modifications');
      const originals = [...Object.entries(manifest.sha256).map(([file, sha256]) => [`vendor/${file}`, sha256]),
        ...Object.entries(manifest.additionalOriginalFiles).map(([file, source]) => [file, source.sha256])];
      for (const [path, sha256] of originals) {
        const file = `${ncm}/${path}`;
        if (path.split('/').some(part => !part || part === '.' || part === '..') || !fileSet.has(file) || !/^[a-f0-9]{64}$/.test(sha256)) throw new Error(`Missing or invalid original file: ${path}`);
        if (createHash('sha256').update(readBytes(file)).digest('hex') !== sha256) errors.push(`Unrecorded upstream modification: ${file}`);
        upstreamFiles.add(file);
      }
    } catch (error) { errors.push(`Invalid NCM provenance: ${error.message}`); }
  }
  const texts = new Map();
  const indexEntries = git(['ls-files', '--stage', '-z']).split('\0').filter(Boolean);
  for (const entry of indexEntries) {
    if (entry.startsWith('120000 ')) errors.push(`Indexed symlinks need an explicit repository policy: ${entry.split('\t')[1]}`);
  }
  for (const file of required) {
    if (!fileSet.has(file)) errors.push(`Required file missing: ${file}`);
  }

  for (const file of files) {
    if (forbiddenPath(file)) errors.push(`Private data / credential file must not be committed: ${file}`);
    if (!staged && lstatSync(resolve(root, file)).isSymbolicLink()) {
      errors.push(`Symlinks need an explicit repository policy: ${file}`);
      continue;
    }
    if (!textFile(file) || upstreamFiles.has(file)) continue;
    const bytes = staged ? git(['show', `:${file}`], null) : readFileSync(resolve(root, file));
    const content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    texts.set(file, content);
    if (content.startsWith('\uFEFF')) errors.push(`Remove UTF-8 BOM: ${file}`);
    if (content.includes('\r')) errors.push(`Use LF line endings: ${file}`);
    if (!content.endsWith('\n')) errors.push(`Missing final newline: ${file}`);
    if (/^[\t ]+$/mu.test(content) || /\S[\t ]+$/mu.test(content)) errors.push(`Trailing whitespace: ${file}`);
    if (/^(<{7}|={7}|>{7})(?: |$)/mu.test(content)) errors.push(`Possible unresolved merge conflict: ${file}`);
    if (file.endsWith('.json')) {
      try { JSON.parse(content); } catch { errors.push(`Invalid JSON: ${file}`); }
    }
  }

  // Check inline local file targets, not remote availability or heading fragments.
  for (const [file, content] of texts) {
    if (!file.endsWith('.md')) continue;
    const prose = content.replace(/```[^\n]*\n[\s\S]*?```/gu, '');
    for (const match of prose.matchAll(/\[[^\]]*\]\(([^)]+)\)/gu)) {
      const href = match[1].replace(/^<|>$/gu, '').split(/\s+"/u)[0];
      if (/^(?:[a-z][a-z0-9+.-]*:|#|\/\/)/iu.test(href)) continue;
      const target = posix.normalize(posix.join(posix.dirname(file), decodeURIComponent(href.split(/[?#]/u)[0])));
      if (target.startsWith('../') || (!fileSet.has(target) && !files.some((item) => item.startsWith(`${target}/`)))) {
        errors.push(`Broken local link in ${file}: ${href}`);
      }
    }
  }

  let contrastCount = 0;
  if (texts.has('design/tokens.json')) {
    try {
      const tokens = JSON.parse(texts.get('design/tokens.json'));
      if (!tokens.themes?.light || !tokens.themes?.dark || !Array.isArray(tokens.contrastPairs) || !tokens.contrastPairs.length) {
        throw new Error('Both themes and a nonempty contrastPairs array are required.');
      }
      for (const [themeName, theme] of Object.entries(tokens.themes)) {
        for (const pair of tokens.contrastPairs) {
          if (![3, 4.5, 7].includes(pair.minRatio)) throw new Error('Contrast minimum must be 3, 4.5 or 7.');
          const foreground = luminance(theme[pair.foreground]);
          const background = luminance(theme[pair.background]);
          const ratio = (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05);
          contrastCount += 1;
          if (ratio < pair.minRatio) errors.push(`${themeName}: ${pair.foreground}/${pair.background} contrast ${ratio.toFixed(2)} < ${pair.minRatio}`);
        }
      }
    } catch (error) {
      errors.push(`Design token validation: ${error.message}`);
    }
  }

  if (errors.length) {
    console.error(errors.join('\n'));
    process.exitCode = 1;
  } else {
    console.log(`Repository baseline passed (${staged ? 'staged snapshot' : 'working tree'}): ${files.length} files, ${contrastCount} contrast pairs.`);
    console.log('This is not an application build, security audit or rendered UI accessibility certification.');
  }
} catch (error) {
  console.error(`Repository check failed: ${error.message}`);
  process.exitCode = 1;
}
