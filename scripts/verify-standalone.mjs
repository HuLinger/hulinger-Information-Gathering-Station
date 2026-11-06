import assert from 'node:assert/strict';
import { lstat, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve('.next/standalone');
assert((await lstat(root)).isDirectory(), 'Standalone build is missing');
for (const entry of await readdir(root)) {
  assert(!['data', '.tmp', 'backups', 'uploads', 'exports', '.deploy'].includes(entry), `Private runtime directory in application artifact: ${entry}`);
  assert(!/^\.env(?:\.|$)/u.test(entry), 'Environment file in application artifact');
}
console.log('Standalone artifact excludes private runtime storage and environment files.');
