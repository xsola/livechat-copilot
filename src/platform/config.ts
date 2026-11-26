import { z } from 'zod';

export const defaultPrompt = 'Use natural, concise wording. Preserve game terms, links, emojis and placeholders. Do not add explanations.';
export const languageCode = z.string().regex(/^[a-z]{2,8}(?:-[a-z0-9]{2,8})*$/i).max(48);
export const modelConfig = z.strictObject({
  endpoint: z.string().max(500),
  model: z.string().trim().min(1).max(150),
  apiKey: z.string().max(2048),
  imageInput: z.boolean(),
  jsonMode: z.boolean(),
});
export type ModelConfig = z.infer<typeof modelConfig>;

export const settingsSchema = z.strictObject({
  model: modelConfig,
  readingLanguage: z.union([languageCode, z.literal('')]),
  mode: z.enum(['batch', 'single', 'manual']),
  prompt: z.string().max(2000),
  registryUrl: z.string().max(500),
  autoVision: z.boolean().default(false),
});
export type Settings = z.infer<typeof settingsSchema>;
export type PageSettings = Pick<Settings, 'readingLanguage' | 'mode'> & {
  enabled: boolean;
  modelConfigured: boolean;
  imageInput: boolean;
  autoVision: boolean;
  revision: number;
};

export const defaults: Settings = {
  model: {
    endpoint: 'https://api.deepseek.com',
    model: 'deepseek-flash',
    apiKey: '',
    imageInput: true,
    jsonMode: true,
  },
  readingLanguage: '',
  mode: 'batch',
  prompt: defaultPrompt,
  registryUrl: '',
  autoVision: false,
};

export function readingLanguage(preference: string, browserLocale: string) {
  if (preference) return preference;
  try {
    const [locale] = Intl.getCanonicalLocales(browserLocale.replaceAll('_', '-'));
    if (locale && languageCode.safeParse(locale).success) return locale;
  } catch {
    // Fall back if Chrome does not return a usable UI locale.
  }
  return 'en';
}

export function isTextOnlyModel(model: Pick<ModelConfig, 'endpoint' | 'model'>) {
  try {
    return new URL(model.endpoint).origin === 'https://api.deepseek.com' &&
      model.model.toLowerCase() === 'deepseek-v4-pro';
  } catch {
    return false;
  }
}

export function parseEndpoint(value: string) {
  const url = new URL(value);
  const local = /^(localhost|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)$/i.test(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) ||
      url.username || url.password || url.search || url.hash) {
    throw new Error('Use an HTTPS endpoint or an HTTP loopback/private IPv4 endpoint, without credentials or a query.');
  }
  return url;
}

export function hostPattern(url: URL) {
  return url.protocol + '//' + url.hostname + '/*';
}

export function parseRegistry(value: string) {
  const url = new URL(value);
  if (url.origin !== 'https://raw.githubusercontent.com' || url.username || url.password ||
      url.search || url.hash || url.pathname.split('/').length < 5) {
    throw new Error('Use a raw.githubusercontent.com URL for the registry index JSON.');
  }
  return url;
}

export function isYouTube(host: string) {
  return host === 'www.youtube.com' || host === 'youtube.com';
}
