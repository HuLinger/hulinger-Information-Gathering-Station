import type { ConversionProvider } from '../provider-types';
import { safeCall } from './common';
import { convertxProvider } from './convertx';
import { ncmdumpProvider } from './ncmdump';
import { stirlingProvider } from './stirling';
import { transmuteProvider } from './transmute';

export function getConversionProviders(env: Readonly<Record<string, string | undefined>> = process.env): ConversionProvider[] {
  return [convertxProvider(env.CONVERTX_URL), transmuteProvider(env.TRANSMUTE_URL, env.TRANSMUTE_API_KEY), stirlingProvider(env.STIRLING_PDF_URL), ncmdumpProvider(env.NCMDUMP_URL)].map((provider) => ({
    id: provider.id,
    configured: provider.configured,
    health: (signal) => safeCall(signal, () => provider.health(signal)),
    options: (extension, signal) => safeCall(signal, () => provider.options(extension, signal)),
    convert: (input, format, outputDirectory, context) => safeCall(context.signal, () => provider.convert(input, format, outputDirectory, context)),
  }));
}
