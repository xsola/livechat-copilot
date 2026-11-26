export function message(key: string, ...values: string[]) {
  return chrome.i18n.getMessage(key, values.length ? values : undefined);
}

export function localizePage(document: Document) {
  document.documentElement.lang = message('uiLocale');
  for (const element of document.querySelectorAll<HTMLElement>('[data-i18n]')) {
    const text = message(element.dataset.i18n!);
    if (text) element.textContent = text;
  }
}
