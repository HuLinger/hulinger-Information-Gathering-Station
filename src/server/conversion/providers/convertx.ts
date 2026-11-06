import { load } from 'cheerio';
import { ConversionProviderError, type ConversionProvider, type ProviderOutput } from '../provider-types';
import { EngineClient, ResultWriter, discard, fileFormat, formatKey, invalidResponse, jsonBody, optionsFor, pollDelay, readJson, readText, record, requireFormat, resultName, unsupported, uploadBody } from './common';

type Session = { cookie: string; jobId: string; userId: string };

function sessionFrom(response: Response): Session {
  const cookies = new Map<string, string>();
  for (const cookie of response.headers.getSetCookie()) {
    const match = /^(auth|jobId)=([^;]*)/.exec(cookie);
    if (match) cookies.set(match[1], match[2]);
  }
  const auth = cookies.get('auth');
  const jobId = cookies.get('jobId');
  if (!auth || !jobId || !/^\d+$/.test(jobId) || auth.length > 16384 || /[\r\n]/.test(auth)) throw invalidResponse();
  let userId: unknown;
  try {
    // Only obtain the expected download namespace; authentication is still verified by ConvertX.
    userId = record(JSON.parse(Buffer.from(decodeURIComponent(auth).split('.')[1], 'base64url').toString())).id;
  } catch { throw invalidResponse(); }
  if (typeof userId !== 'string' || !/^\d+$/.test(userId)) throw invalidResponse();
  return { cookie: `auth=${auth}; jobId=${jobId}`, jobId, userId };
}

export function convertxProvider(url: string | undefined): ConversionProvider {
  const client = new EngineClient(url);

  async function targets(extension: string, signal: AbortSignal): Promise<Map<string, { target: string; converter: string }>> {
    const formats = new Map<string, { target: string; converter: string }>();
    const normalized = fileFormat(extension);
    if (!normalized) return formats;
    const $ = load(await readText(await client.request('/conversions', signal, jsonBody({ fileType: normalized }))));
    $('button.target').each((_index, button) => {
      const format = fileFormat($(button).attr('data-target'));
      const converter = $(button).attr('data-converter');
      if (format && converter && /^[a-zA-Z0-9_-]{1,64}$/.test(converter) && !formats.has(formatKey(format))) formats.set(formatKey(format), { target: format, converter });
    });
    return formats;
  }

  return {
    id: 'convertx', configured: client.configured,
    async health(signal) {
      if ((await readJson(await client.request('/healthcheck', signal))).status !== 'ok') throw invalidResponse();
    },
    async options(extension, signal) { return optionsFor('convertx', (await targets(extension, signal)).keys()); },
    async convert(input, format, outputDirectory, context) {
      const requested = formatKey(requireFormat(format));
      const selected = (await targets(input.extension, context.signal)).get(requested);
      if (!selected) unsupported();
      const { target, converter } = selected;
      let session: Session | undefined;
      let submitted = false;
      let terminal = false;
      const writer = new ResultWriter(outputDirectory, context);
      try {
        await context.onStage('正在上传到 ConvertX');
        const start = await client.request('/', context.signal);
        try { session = sessionFrom(start); } finally { await discard(start); }
        const headers = { Cookie: session.cookie };
        const upload = await readJson(await client.request('/upload', context.signal, { method: 'POST', headers, body: await uploadBody(input) }));
        if (upload.message !== 'Files uploaded successfully.') throw invalidResponse();
        // A request interrupted after sending may already be running upstream.
        submitted = true;
        const conversion = await client.request('/convert', context.signal, {
          ...jsonBody({ convert_to: `${target},${converter}`, file_names: JSON.stringify([`input.${requireFormat(input.extension)}`]) }),
          headers: { ...headers, 'Content-Type': 'application/json' },
        }, [302]);
        const location = conversion.headers.get('location');
        await discard(conversion);
        if (conversion.status !== 302 || !location || new URL(location, client.url('/')).href !== client.url(`/results/${session.jobId}`).href) throw invalidResponse();
        await context.onStage('ConvertX 正在转换');
        let files: { name: string; endpoint: string; extension: string }[] = [];
        while (true) {
          const $ = load(await readText(await client.request(`/progress/${session.jobId}`, context.signal, { method: 'POST', headers })));
          const tableBody = $('table > tbody');
          if (tableBody.length !== 1) throw invalidResponse();
          const rows = tableBody.children('tr');
          if (rows.toArray().some((row) => $(row).children('td').length !== 3)) throw invalidResponse();
          if (rows.length) {
            const statuses = rows.toArray().map((row) => $(row).children('td').eq(1).text().trim());
            if (statuses.some((status) => status.startsWith('Failed') || status === 'File type not supported')) {
              terminal = true;
              throw new ConversionProviderError('ConvertX 无法转换此文件，请检查文件或更换引擎。', 'CONVERSION_FAILED');
            }
            if (statuses.every((status) => status === 'Done')) {
              terminal = true;
              if (rows.length > context.maxOutputFiles) throw new ConversionProviderError('转换结果文件数量超过限制，请减少页数后重试。', 'OUTPUT_LIMIT');
              files = rows.toArray().map((row) => {
                const name = $(row).children('td').eq(0).text().trim();
                const href = $(row).find('a[download]').attr('href');
                const match = /^input(-\d+)?\.([a-z0-9]+)$/i.exec(name);
                const extension = match && fileFormat(match[2]);
                if (!match || !extension || formatKey(extension) !== requested || !href) throw invalidResponse();
                const endpoint = `/download/${session!.userId}/${session!.jobId}/${encodeURIComponent(name)}`;
                if (new URL(href, client.url('/')).href !== client.url(endpoint).href) throw invalidResponse();
                return { name: resultName(input, extension, match[1] ?? ''), endpoint, extension };
              });
              if (new Set(files.map((file) => file.endpoint)).size !== files.length) throw invalidResponse();
              break;
            }
            if (statuses.some((status) => status !== 'Done')) throw invalidResponse();
          }
          await pollDelay(context.signal);
        }
        await context.onStage('正在保存转换结果');
        const outputs: ProviderOutput[] = [];
        for (const file of files) outputs.push(await writer.write(await client.request(file.endpoint, context.signal, { headers }), file.name, file.extension));
        return outputs;
      } catch (error) {
        await writer.removeAll();
        throw error;
      } finally {
        // Running conversions cannot be cancelled safely; their isolated files expire upstream.
        if (session && (!submitted || terminal)) {
          try { await discard(await client.request(`/delete/${session.jobId}`, AbortSignal.timeout(5000), { method: 'POST', headers: { Cookie: session.cookie } }, [302])); }
          catch { console.warn('conversion_cleanup_deferred:convertx'); }
        }
      }
    },
  };
}
