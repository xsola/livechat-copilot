function comparable(code: string) {
  try {
    const locale = new Intl.Locale(code);
    if (locale.language === 'zh') return 'zh-' + locale.maximize().script;
    return locale.language;
  } catch { return ''; }
}

export async function alreadyInReadingLanguage(text: string, target: string) {
  if ((text.match(/\p{L}/gu)?.length ?? 0) < 8) return false;
  try {
    const result = await chrome.i18n.detectLanguage(text);
    const main = result.languages[0];
    return Boolean(result.isReliable && main && main.percentage >= 90 &&
      main.language !== 'und' && comparable(main.language) === comparable(target));
  } catch { return false; }
}
