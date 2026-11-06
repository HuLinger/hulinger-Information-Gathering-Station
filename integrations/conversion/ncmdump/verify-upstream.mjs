import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const manifest = JSON.parse(await readFile(new URL('./upstream.json', import.meta.url), 'utf8'));
for (const [path, expected] of Object.entries(manifest.sha256)) {
  const bytes = await readFile(new URL(`./vendor/${path}`, import.meta.url));
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== expected) throw new Error(`Upstream checksum mismatch: ${path}`);
}
for (const [path, source] of Object.entries(manifest.additionalOriginalFiles ?? {})) {
  const bytes = await readFile(new URL(`./${path}`, import.meta.url));
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== source.sha256) throw new Error(`Original license checksum mismatch: ${path}`);
}
console.log(`Verified ${Object.keys(manifest.sha256).length} original files at ${manifest.commit}.`);
