import '../../platform/ui.css';
import { hostPattern } from '../../platform/config';
import { send, type SiteState } from '../../platform/messages';
import { effectiveScope, scopeValue, type TranslationScope } from '../../platform/translation-scope';
import { languageName } from '../../rooms/language-input';

const siteLabel = document.querySelector<HTMLParagraphElement>('#site')!;
const enabled = document.querySelector<HTMLInputElement>('#enabled')!;
const emoji = document.querySelector<HTMLInputElement>('#translate-emoji')!;
const skipReading = document.querySelector<HTMLInputElement>('#skip-reading')!;
const targetLanguage = document.querySelector<HTMLSelectElement>('#target-language')!;
const skipLabel = document.getElementById('skip-label')!;
const scope = document.querySelector<HTMLSelectElement>('#scope')!;
const resetScope = document.querySelector<HTMLButtonElement>('#reset-scope')!;
const scopeHelp = document.getElementById('scope-help')!;
const status = document.querySelector<HTMLParagraphElement>('#status')!;
const actions = ['detect', 'pick'] as const;
const actionButtons = actions.map(id => document.querySelector<HTMLButtonElement>('#' + id)!);
const translationLanguages = ['zh-CN', 'zh-TW', 'en', 'ja', 'ko', 'es', 'fr', 'de', 'pt', 'ru', 'it', 'vi', 'th', 'id', 'ar'];
let tabId: number;
let site: SiteState;
const scopeNames: Record<TranslationScope, string> = { room: '当前直播间', site: '本站所有直播间' };

function showScope() {
  const selected = scope.value as TranslationScope;
  const target = site.scopes.find(item => item.scope === selected);
  if (!target) return;
  enabled.checked = scopeValue(site.scopes, selected);
  enabled.disabled = false;
  scope.disabled = false;
  resetScope.hidden = selected === 'site' || target.value === null;
  resetScope.disabled = false;
  const current = effectiveScope(site.scopes);
  const active = current ? '当前页面按「' + scopeNames[current.scope] + '」设置' +
    (current.value ? '启用翻译。' : '关闭翻译。') : '';
  const detail = target.usesLegacyPageSetting
    ? ' 当前页面沿用旧版保存的翻译开关。修改后将按直播间保存。'
    : target.usesPageLink ? ' 本站当前没有可识别的房间标识，按这条聊天链接保存。' : '';
  scopeHelp.textContent = active + detail;
}

async function run(operation: () => Promise<void>) {
  status.textContent = '';
  try {
    await operation();
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : '操作失败。';
  }
}

async function prepareSite() {
  if (!site.youtube) {
    const allowed = await chrome.permissions.request({ origins: [hostPattern(new URL(site.origin))] });
    if (!allowed) throw new Error('需要访问当前网站才能识别弹幕。');
    if (!await send('pageCommand', { tabId, action: 'ping' }).catch(() => false)) {
      await send('attach', tabId);
    }
  }
}

async function command(pageAction: typeof actions[number]) {
  for (const button of actionButtons) button.disabled = true;
  status.classList.add('busy');
  status.textContent = '正在连接当前直播页面…';
  try {
    await prepareSite();
    status.textContent = pageAction === 'detect' ? '正在启动弹幕识别…' : '正在打开手动选区…';
    let received = await send('pageCommand', { tabId, action: pageAction });
    if (!received) {
      await send('attach', tabId);
      received = await send('pageCommand', { tabId, action: pageAction });
    }
    if (!received) throw new Error('没有找到活动的聊天页面，请打开或展开直播聊天。');
    window.close();
  } finally {
    status.classList.remove('busy');
    for (const button of actionButtons) button.disabled = false;
  }
}

function showTargetLanguage() {
  skipLabel.textContent = '自动翻译时跳过已是' + languageName(site.readingLanguage) + '的弹幕';
  targetLanguage.value = site.targetLanguage;
}

void run(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id === undefined) throw new Error('请先打开直播页面。');
  tabId = tab.id;
  site = await send('site', tabId);
  siteLabel.textContent = new URL(site.origin).hostname;
  for (const key of ['room', 'site'] as const) {
    if (site.scopes.some(item => item.scope === key)) scope.add(new Option(scopeNames[key], key));
  }
  scope.value = site.preferredScope ?? effectiveScope(site.scopes)?.scope ?? 'site';
  showScope();
  emoji.checked = site.translateEmoji;
  emoji.disabled = false;
  skipReading.checked = site.skipReadingLanguage;
  skipReading.disabled = false;
  targetLanguage.add(new Option('跟随浏览器（' + languageName(site.browserLanguage) + '）', ''));
  for (const code of new Set([...translationLanguages, site.targetLanguage].filter(Boolean))) {
    targetLanguage.add(new Option(languageName(code), code));
  }
  targetLanguage.disabled = false;
  showTargetLanguage();
  for (const action of actions) {
    const button = document.querySelector<HTMLButtonElement>('#' + action)!;
    button.disabled = false;
    button.addEventListener('click', () => { void run(() => command(action)); });
  }
});

scope.addEventListener('change', () => {
  showScope();
  void run(() => send('setPreferredScope', { tabId, origin: site.origin, scope: scope.value as TranslationScope }));
});

function setScope(checked: boolean | null) {
  const target = site.scopes.find(item => item.scope === scope.value);
  if (!target) return;
  enabled.disabled = true;
  scope.disabled = true;
  resetScope.disabled = true;
  void run(async () => {
    if (checked) await prepareSite();
    site = await send('setSite', { tabId, enabled: checked, origin: site.origin, scope: target.scope, key: target.key });
    status.textContent = checked === null ? '当前直播间已跟随全站设置。' : checked ? '已启用。' : '已关闭。';
    if (checked && effectiveScope(site.scopes)?.value) {
      void send('pageCommand', { tabId, action: 'initial-review' }).catch(() => undefined);
    }
  }).finally(showScope);
}

enabled.addEventListener('change', () => setScope(enabled.checked));
resetScope.addEventListener('click', () => setScope(null));

targetLanguage.addEventListener('change', () => {
  const preference = targetLanguage.value;
  targetLanguage.disabled = true;
  void run(async () => {
    site.readingLanguage = await send('setTargetLanguage', preference);
    site.targetLanguage = preference;
  }).finally(() => { showTargetLanguage(); targetLanguage.disabled = false; });
});

skipReading.addEventListener('change', () => {
  const checked = skipReading.checked;
  skipReading.disabled = true;
  void run(async () => {
    await send('setSkipReadingLanguage', checked);
    site.skipReadingLanguage = checked;
  }).finally(() => { skipReading.checked = site.skipReadingLanguage; skipReading.disabled = false; });
});

emoji.addEventListener('change', () => {
  const checked = emoji.checked;
  emoji.disabled = true;
  void run(async () => {
    await send('setTranslateEmoji', checked);
    site.translateEmoji = checked;
  }).finally(() => { emoji.checked = site.translateEmoji; emoji.disabled = false; });
});

document.querySelector('#options')!.addEventListener('click', () => {
  if (site) void chrome.tabs.create({ url: chrome.runtime.getURL('options.html') + '?fromTab=' + tabId });
  else void chrome.runtime.openOptionsPage();
});
