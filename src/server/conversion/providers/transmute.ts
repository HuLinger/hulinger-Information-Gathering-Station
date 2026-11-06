import { ConversionProviderError, type ConversionProvider } from '../provider-types';
import { EngineClient, ResultWriter, discard, fileFormat, formatKey, invalidResponse, jsonBody, optionsFor, pollDelay, readJson, record, requireFormat, responseExtension, resultName, unsupported, uploadBody, upstreamId } from './common';

type Job = { id: string; status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'; output: string | null };

function jobFrom(value: Record<string, unknown>): Job {
  const status = value.status;
  if (status !== 'queued' && status !== 'running' && status !== 'completed' && status !== 'failed' && status !== 'cancelled') throw invalidResponse();
  return { id: upstreamId(value.id), status, output: value.output_file_id === null || value.output_file_id === undefined ? null : upstreamId(value.output_file_id) };
}

export function transmuteProvider(url: string | undefined, apiKey: string | undefined): ConversionProvider {
  const client = new EngineClient(apiKey?.trim() ? url : undefined, apiKey?.trim() ? { Authorization: `Bearer ${apiKey.trim()}` } : {});
  return {
    id: 'transmute', configured: client.configured,
    async health(signal) { await discard(await client.request('/api/health/ready', signal)); },
    async options(extension, signal) {
      const input = fileFormat(extension);
      if (!input) return [];
      const data = await readJson(await client.request('/api/converters', signal));
      if (!Array.isArray(data.converters)) throw invalidResponse();
      const formats = new Set<string>();
      for (const item of data.converters) {
        const converter = record(item);
        if (!Array.isArray(converter.supported_input_formats) || !Array.isArray(converter.supported_output_formats)) throw invalidResponse();
        if (!converter.supported_input_formats.some((value) => {
          const supported = fileFormat(value);
          return supported && formatKey(supported) === formatKey(input);
        })) continue;
        for (const output of converter.supported_output_formats) {
          const format = fileFormat(output);
          if (format) formats.add(format);
        }
      }
      return optionsFor('transmute', formats);
    },
    async convert(input, format, outputDirectory, context) {
      const requested = formatKey(requireFormat(format));
      let source: string | undefined;
      let job: Job | undefined;
      let jobRequested = false;
      const writer = new ResultWriter(outputDirectory, context);
      try {
        await context.onStage('正在上传到 Transmute');
        const uploaded = await readJson(await client.request('/api/files', context.signal, { method: 'POST', body: await uploadBody(input) }));
        const metadata = record(uploaded.metadata);
        source = upstreamId(metadata.id);
        const formats = record(metadata.compatible_formats);
        // The actual uploaded file's detected media type wins over its extension.
        const target = Object.keys(formats).find((candidate) => fileFormat(candidate) && formatKey(candidate) === requested);
        if (!target || !Array.isArray(formats[target])) unsupported();
        jobRequested = true;
        job = jobFrom(await readJson(await client.request('/api/jobs', context.signal, jsonBody({ id: source, output_format: target }))));
        const jobId = job.id;
        let lastStage = '';
        while (job.status === 'queued' || job.status === 'running') {
          const stage = job.status === 'queued' ? '等待 Transmute 处理' : 'Transmute 正在转换';
          if (stage !== lastStage) { await context.onStage(stage); lastStage = stage; }
          const update = jobFrom(await readJson(await client.request(`/api/jobs/${jobId}`, context.signal)));
          if (update.id !== jobId) throw invalidResponse();
          job = update;
          if (job.status === 'queued' || job.status === 'running') await pollDelay(context.signal);
        }
        if (job.status !== 'completed') throw new ConversionProviderError('Transmute 无法转换此文件，请检查文件或更换引擎。', 'CONVERSION_FAILED');
        if (!job.output) throw invalidResponse();
        await context.onStage('正在保存转换结果');
        const response = await client.request(`/api/files/${job.output}`, context.signal);
        let extension: string;
        try { extension = responseExtension(response, target, requested === 'jpeg' ? ['jpg', 'jpeg', 'zip'] : requested === 'tiff' ? ['tif', 'tiff', 'zip'] : [target, 'zip']); }
        catch (error) { await discard(response); throw error; }
        return [await writer.write(response, resultName(input, extension), extension)];
      } catch (error) {
        await writer.removeAll();
        throw error;
      } finally {
        const cleanupSignal = AbortSignal.timeout(5000);
        try {
          if (job && (job.status === 'queued' || job.status === 'running')) {
            await discard(await client.request(`/api/jobs/${job.id}/cancel`, cleanupSignal, { method: 'POST' }, [409]));
            const update = jobFrom(await readJson(await client.request(`/api/jobs/${job.id}`, cleanupSignal)));
            if (update.id !== job.id) throw invalidResponse();
            job = update;
          }
          if (job?.status === 'completed' && job.output) await discard(await client.request(`/api/conversions/${job.output}`, cleanupSignal, { method: 'DELETE' }, [404]));
          if (job?.status === 'failed' || job?.status === 'cancelled') await discard(await client.request(`/api/jobs/${job.id}`, cleanupSignal, { method: 'DELETE' }, [404]));
          // Active/unknown submissions expire using the engine's configured retention policy.
          if (source && (!jobRequested || job && ['completed', 'failed', 'cancelled'].includes(job.status))) await discard(await client.request(`/api/files/${source}`, cleanupSignal, { method: 'DELETE' }, [404]));
        } catch { console.warn('conversion_cleanup_deferred:transmute'); }
      }
    },
  };
}
