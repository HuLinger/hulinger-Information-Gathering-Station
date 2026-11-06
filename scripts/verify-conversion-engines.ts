import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import sharp from 'sharp';
import { getConversionProviders } from '../src/server/conversion/providers';
import { ConversionProviderError, type ConversionProvider } from '../src/server/conversion/provider-types';
import { audioFixtures, bitmapFixture, chinesePdfFixture, expectedPixels, ncmFixture } from './lib/conversion-fixtures';

// This explicitly invoked check requires real engines. It never substitutes
// mocks when an engine is missing or unhealthy and never prints configuration.
if (process.env.CONVERSION_SMOKE_ENV_FILE) process.loadEnvFile(process.env.CONVERSION_SMOKE_ENV_FILE);
const requested = process.argv.slice(2);
const providers = getConversionProviders().filter(provider => !requested.length || requested.includes(provider.id));
assert(providers.length === (requested.length || 4), 'Unknown or duplicate engine selection');
const directory = await mkdtemp(join(tmpdir(), 'hulinger-engine-smoke-'));
let serial = 0;
async function convert(provider: ConversionProvider, bytes: Buffer, extension: string, target: string) {
  const work = join(directory, String(++serial)); await mkdir(work);
  const input = join(work, `input.${extension}`); await writeFile(input, bytes);
  assert((await provider.options(extension, AbortSignal.timeout(10_000))).some(option => option.format === target), `${provider.id}: target unavailable`);
  const outputs = await provider.convert({ path: input, name: `中文转换验证.${extension}`, extension, bytes: bytes.length }, target, work, {
    signal: AbortSignal.timeout(180_000), maxOutputBytes: 16 * 1024 ** 2, maxOutputFiles: 10, onStage: async () => {},
  });
  assert.equal(outputs.length, 1); assert.match(outputs[0].name, /^中文转换验证/);
  assert.match(outputs[0].storageName, /^[a-f0-9-]{36}$/);
  const result = await readFile(join(work, outputs[0].storageName)); assert.equal(result.length, outputs[0].bytes);
  return { bytes: result, name: outputs[0].name };
}

try {
  for (const provider of providers) {
    assert(provider.configured, `${provider.id} is not configured`);
    await provider.health(AbortSignal.timeout(10_000));
    if (provider.id === 'convertx' || provider.id === 'transmute') {
      const result = await convert(provider, bitmapFixture(), 'bmp', 'png');
      const image = sharp(result.bytes); const metadata = await image.metadata();
      assert.equal(metadata.format, 'png'); assert.equal(metadata.width, 2); assert.equal(metadata.height, 2);
      assert.deepEqual(await image.removeAlpha().raw().toBuffer(), expectedPixels);
      console.log(`PASS ${provider.id}: real BMP → PNG, exact decoded pixels, Chinese output name`);
      await assert.rejects(() => convert(provider, Buffer.from('invalid image'), 'bmp', 'png'), error => error instanceof ConversionProviderError && error.code !== 'CONVERSION_ABORTED');
      console.log(`PASS ${provider.id}: corrupt image fails explicitly`);
    } else if (provider.id === 'stirling') {
      const png = await sharp(expectedPixels, { raw: { width: 2, height: 2, channels: 3 } }).png().toBuffer();
      assert.equal((await convert(provider, png, 'png', 'pdf')).bytes.subarray(0, 5).toString(), '%PDF-');
      const text = await convert(provider, chinesePdfFixture(), 'pdf', 'txt');
      assert.match(text.bytes.toString('utf8').replace(/\s/g, ''), /中文测试/);
      const zip = await convert(provider, chinesePdfFixture(), 'pdf', 'png');
      assert.match(zip.name, /\.zip$/); assert.equal(zip.bytes.subarray(0, 2).toString(), 'PK');
      console.log('PASS stirling: real PNG → PDF, Chinese PDF → UTF-8 text, PDF → image ZIP');
    } else {
      for (const sample of audioFixtures()) {
        const output = await convert(provider, ncmFixture(sample.bytes), 'ncm', 'audio');
        assert(output.name.endsWith(`.${sample.extension}`)); assert.deepEqual(output.bytes, sample.bytes);
        console.log(`PASS ncmdump: real synthetic NCM → ${sample.extension}, exact original bytes`);
      }
      await assert.rejects(() => convert(provider, Buffer.from('invalid ncm'), 'ncm', 'audio'), error => error instanceof ConversionProviderError && error.code !== 'CONVERSION_ABORTED');
      console.log('PASS ncmdump: corrupt NCM fails explicitly');
    }
  }
} finally {
  assert.equal(dirname(resolve(directory)).toLowerCase(), resolve(tmpdir()).toLowerCase());
  await rm(directory, { force: true, recursive: true });
}
