import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const vendor = join(root, 'third_party/shattered-pixel-dungeon-web');
const bridge = join(root, 'src/game/shattered-pixel-dungeon');
const output = join(root, '.games/shattered-pixel-dungeon-web');
const upstream = JSON.parse(readFileSync(join(vendor, 'UPSTREAM.json'), 'utf8'));
const ignored = new Set(['.git', '.gradle', 'build']);

function filesIn(directory) {
  return readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en')).flatMap((entry) => {
    if (ignored.has(entry.name)) return [];
    if (entry.isSymbolicLink()) throw new Error(`Unexpected symbolic link in game source: ${entry.name}`);
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesIn(path) : [path];
  });
}
function sha256(path) { return createHash('sha256').update(readFileSync(path)).digest('hex'); }
const sourceFiles = [...filesIn(vendor), ...filesIn(bridge), fileURLToPath(import.meta.url), join(root, 'docs/development/shattered-pixel-dungeon.md')];
const inputHash = createHash('sha256');
for (const file of sourceFiles) inputHash.update(relative(root, file).split(sep).join('/')).update('\0').update(readFileSync(file)).update('\0');
const sourceSha256 = inputHash.digest('hex');
const manifestPath = join(output, 'manifest.json');
if (!process.argv.includes('--force') && existsSync(manifestPath)) {
  try {
    const previous = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (previous.sourceSha256 === sourceSha256 && Array.isArray(previous.files) && previous.files.length > 100
      && previous.files.every((file) => {
        const path = resolve(output, file.path);
        return path.startsWith(output + sep) && existsSync(path) && sha256(path) === file.sha256;
      })) {
      console.log(`Game build verified from cache: ${previous.files.length} files, source ${sourceSha256.slice(0, 12)}.`);
      process.exit(0);
    }
  } catch { /* A missing or invalid artifact is rebuilt from the retained source. */ }
}

function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Game build command failed (exit ${result.status}): ${command}`);
}
const java = process.env.JAVA_HOME ? join(process.env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'java.exe' : 'java') : 'java';
const version = spawnSync(java, ['-version'], { encoding: 'utf8', windowsHide: true });
const major = Number((version.stderr + version.stdout).match(/version "(?:1\.)?(\d+)/u)?.[1]);
if (version.error || version.status !== 0 || major < 17 || !Number.isFinite(major)) throw new Error('Building the game requires JDK 17 or newer (JAVA_HOME or java on PATH).');
const tar = spawnSync('tar', ['--version'], { encoding: 'utf8', windowsHide: true });
if (tar.error || tar.status !== 0) throw new Error('Building the corresponding-source archive requires tar (included with Windows and standard Linux images).');

console.log(`Building Shattered Pixel Dungeon ${upstream.commit} with Java ${major}.`);
run(java, ['-Dfile.encoding=UTF-8', '-jar', 'gradle/wrapper/gradle-wrapper.jar', '-p', 'web-build', ':web:webBuild', '--no-daemon', '--console=plain'], vendor);
const generated = join(vendor, 'web/build/dist/webapp');
if (!existsSync(join(generated, 'app.js'))) throw new Error('The game build did not produce app.js.');
run(process.execPath, ['--check', join(generated, 'app.js')]);

// This deletion is restricted to the exact generated artifact directory.
// Neither the vendored source nor unrelated workspace paths can be removed.
if (resolve(output) !== resolve(root, '.games', 'shattered-pixel-dungeon-web') || !output.startsWith(root + sep)) throw new Error('Unexpected game output directory.');
rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });
cpSync(generated, output, { recursive: true });
cpSync(bridge, output, { recursive: true });
cpSync(join(vendor, 'LICENSE.txt'), join(output, 'LICENSE.txt'));
cpSync(join(vendor, 'UPSTREAM.json'), join(output, 'UPSTREAM.json'));
run('tar', ['-czf', join(output, 'source.tar.gz'), '--exclude=build', '--exclude=.gradle', '--exclude=.git',
  '-C', root, 'third_party/shattered-pixel-dungeon-web', 'src/game/shattered-pixel-dungeon',
  'scripts/build-game.mjs', 'docs/development/shattered-pixel-dungeon.md']);

const artifacts = filesIn(output).map((file) => ({ path: relative(output, file).split(sep).join('/'), bytes: statSync(file).size, sha256: sha256(file) }));
const manifest = { formatVersion: 1, game: 'shattered-pixel-dungeon', upstreamCommit: upstream.commit, sourceSha256, totalBytes: artifacts.reduce((sum, file) => sum + file.bytes, 0), files: artifacts };
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Game build complete: ${artifacts.length} files, ${manifest.totalBytes} bytes, including corresponding source. Output: ${relative(root, output)}`);
