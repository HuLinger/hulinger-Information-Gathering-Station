import type { ConversionProvider } from '../provider-types';
import { EngineClient, ResultWriter, discard, fileFormat, invalidResponse, optionsFor, responseExtension, resultName, unsupported, uploadBody } from './common';

const OFFICE_INPUTS = new Set('doc docx xls xlsx ppt pptx odt ods odp rtf txt csv'.split(' '));
const IMAGE_INPUTS = new Set(['png', 'jpg', 'jpeg']);
const PDF_OUTPUTS = ['docx', 'pptx', 'txt', 'png', 'jpeg'];

export function stirlingProvider(url: string | undefined): ConversionProvider {
  const client = new EngineClient(url);
  function available(extension: string): string[] {
    const input = fileFormat(extension);
    if (input === 'pdf') return PDF_OUTPUTS;
    return input && (OFFICE_INPUTS.has(input) || IMAGE_INPUTS.has(input)) ? ['pdf'] : [];
  }
  return {
    id: 'stirling', configured: client.configured,
    async health(signal) { await discard(await client.request('/api/v1/info/status', signal)); },
    async options(extension) {
      return optionsFor('stirling', available(extension)).map((option) => ['png', 'jpeg'].includes(option.format) ? { ...option, label: `${option.label} 图片（ZIP）` } : option);
    },
    async convert(input, format, outputDirectory, context) {
      if (!available(input.extension).includes(format)) unsupported();
      const form = await uploadBody(input, 'fileInput');
      let endpoint: string;
      let expected = format;
      if (IMAGE_INPUTS.has(input.extension.toLowerCase())) {
        endpoint = '/img/pdf';
        form.set('fitOption', 'fitDocumentToImage'); form.set('colorType', 'color'); form.set('autoRotate', 'false');
      } else if (format === 'pdf') {
        endpoint = '/file/pdf';
        form.set('useStirlingOfficeConvert', 'false');
      } else if (format === 'png' || format === 'jpeg') {
        endpoint = '/pdf/img'; expected = 'zip';
        form.set('imageFormat', format); form.set('singleOrMultiple', 'multiple'); form.set('colorType', 'color');
        form.set('dpi', '150'); form.set('pageNumbers', 'all'); form.set('includeAnnotations', 'false');
      } else {
        endpoint = format === 'docx' ? '/pdf/word' : format === 'pptx' ? '/pdf/presentation' : '/pdf/text';
        form.set('outputFormat', format); form.set('useStirlingOfficeConvert', 'false');
      }
      await context.onStage('Stirling-PDF 正在转换');
      const response = await client.request(`/api/v1/convert${endpoint}`, context.signal, { method: 'POST', body: form });
      let extension: string;
      try {
        extension = responseExtension(response, expected, expected === 'pdf' ? ['pdf'] : [expected, 'zip']);
        if (expected === 'zip' && extension !== 'zip') throw invalidResponse();
      } catch (error) { await discard(response); throw error; }
      try {
        await context.onStage('正在保存转换结果');
        return [await new ResultWriter(outputDirectory, context).write(response, resultName(input, extension, expected === 'zip' ? `-${format}` : ''), extension)];
      } finally { await discard(response); }
    },
  };
}
