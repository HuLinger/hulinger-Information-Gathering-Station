import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('production file download survives consumer cancellation during buffered backpressure', { timeout: 30_000 }, (context) => {
  const helper = fileURLToPath(new URL('./helpers/drive-download-cancellation-probe.ts', import.meta.url));
  const probe = spawnSync(process.execPath, ['--import', 'tsx', helper], { encoding: 'utf8', windowsHide: true, timeout: 25_000 });
  assert.ifError(probe.error);
  assert.equal(probe.status, 0, probe.stderr || probe.stdout);
  const result = JSON.parse(probe.stdout.trim()) as { node: string; results: { mode: string; iterations: number; uncaught: number; openHandles: number }[] };
  const actual = result.results.find((item) => item.mode === 'actual');
  assert.deepEqual(actual, { mode: 'actual', iterations: 40, uncaught: 0, openHandles: 0 });
  context.diagnostic(`${result.node}: ${JSON.stringify(result.results)}`);
});
