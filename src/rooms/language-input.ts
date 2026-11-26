import { languageCode } from '../platform/config';

const aliases: Record<string, string> = {
  jp: 'ja', 日语: 'ja', 日語: 'ja', 日文: 'ja', 日本语: 'ja', 日本語: 'ja', japanese: 'ja',
  中文: 'zh', 汉语: 'zh', 漢語: 'zh', 简体中文: 'zh-CN', 簡體中文: 'zh-CN', 繁体中文: 'zh-TW', 繁體中文: 'zh-TW',
  英语: 'en', 英語: 'en', 英文: 'en', english: 'en', 韩语: 'ko', 韓語: 'ko', 韩文: 'ko', 한국어: 'ko',
};
const names = new Intl.DisplayNames('zh-CN', { type: 'language', fallback: 'none' });
const englishNames = new Intl.DisplayNames('en', { type: 'language', fallback: 'none' });
const common = ['es', 'fr', 'de', 'ru', 'pt', 'it', 'ar', 'vi', 'th', 'id', 'hi', 'nl', 'tr'];

export function normalizeLanguage(input: string) {
  const value = input.trim().toLowerCase();
  if (Object.hasOwn(aliases, value)) return aliases[value];
  const named = common.find(language => names.of(language)?.toLowerCase() === value ||
    englishNames.of(language)?.toLowerCase() === value);
  if (named) return named;
  try {
    const [code] = Intl.getCanonicalLocales(value.replaceAll('_', '-'));
    if (code && code !== 'und' && languageCode.safeParse(code).success && names.of(new Intl.Locale(code).language)) return code;
  } catch { /* The input may be a natural-language description. */ }
}

export function languageName(code: string) {
  try { return names.of(code) ?? code; } catch { return code; }
}
