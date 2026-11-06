import type { ConversionProvider } from '../provider-types';
import { EngineClient, ResultWriter, discard, invalidResponse, readJson, responseExtension, resultName, unsupported, uploadBody } from './common';

export function ncmdumpProvider(url: string | undefined): ConversionProvider {
  const client = new EngineClient(url);
  return {
    id: 'ncmdump', configured: client.configured,
    async health(signal) {
      if ((await readJson(await client.request('/health', signal))).status !== 'ok') throw invalidResponse();
    },
    async options(extension) {
      return extension.toLowerCase() === 'ncm' ? [{ engine: 'ncmdump', format: 'audio', label: '原始音频（MP3 / FLAC）' }] : [];
    },
    async convert(input, format, outputDirectory, context) {
      if (input.extension.toLowerCase() !== 'ncm' || format !== 'audio') unsupported();
      await context.onStage('正在提取 NCM 原始音频');
      const response = await client.request('/convert', context.signal, { method: 'POST', body: await uploadBody(input) });
      let extension: string;
      try {
        const mime = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
        if (mime !== 'audio/flac' && mime !== 'audio/mpeg') throw invalidResponse();
        const expected = mime === 'audio/flac' ? 'flac' : 'mp3';
        extension = responseExtension(response, expected, [expected]);
      } catch (error) { await discard(response); throw error; }
      try {
        await context.onStage('正在保存原始音频');
        return [await new ResultWriter(outputDirectory, context).write(response, resultName(input, extension), extension)];
      } finally { await discard(response); }
    },
  };
}
