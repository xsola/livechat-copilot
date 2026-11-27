import '../../platform/ui.css';
import { hostPattern } from '../../platform/config';
import { localizePage, message } from '../../platform/i18n';
import { send, type SiteState } from '../../platform/messages';
import { effectiveScope, scopeValue, type TranslationScope } from '../../platform/translation-scope';
import { languageName, normalizeLanguage } from '../../rooms/language-input';

localizePage(document);
const uiLocale = document.documentElement.lang;

const siteLabel = document.querySelector<HTMLParagraphElement>('#site')!;
const enabled = document.querySelector<HTMLInputElement>('#enabled')!;
const emoji = document.querySelector<HTMLInputElement>('#translate-emoji')!;
const skipReading = document.querySelector<HTMLInputElement>('#skip-reading')!;
const targetLanguage = document.querySelector<HTMLInputElement>('#target-language')!;
const targetForm = document.querySelector<HTMLFormElement>('#target-language-form')!;
const saveTarget = document.querySelector<HTMLButtonElement>('#save-target-language')!;
const resetTarget = document.querySelector<HTMLButtonElement>('#reset-target-language')!;
const skipLabel = document.getElementById('skip-label')!;
const scope = document.querySelector<HTMLSelectElement>('#scope')!;
const resetScope = document.querySelector<HTMLButtonElement>('#reset-scope')!;
const scopeHelp = document.getElementById('scope-help')!;
const status = document.querySelector<HTMLParagraphElement>('#status')!;
const actions = ['detect', 'pick'] as const;
const actionButtons = actions.map(id => document.querySelector<HTMLButtonElement>('#' + id)!);
const assistant = document.querySelector<HTMLButtonElement>('#assistant')!;
let tabId: number;
let site: SiteState;
const scopeNames: Record<TranslationScope, string> = { room: message('roomScope'), site: message('siteScope') };

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
  const active = current ? message(current.value ? 'enabledHere' : 'disabledHere', scopeNames[current.scope]) : '';
  const detail = target.usesLegacyPageSetting
    ? message('legacyScope') : target.usesPageLink ? message('pageScope') : '';
  scopeHelp.textContent = [active, detail].filter(Boolean).join(' ');
}

async function run(operation: () => Promise<void>) {
  status.textContent = '';
  try {
    await operation();
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : message('genericError');
  }
}

async function prepareSite() {
  if (!site.youtube) {
    const allowed = await chrome.permissions.request({ origins: [hostPattern(new URL(site.origin))] });
    if (!allowed) throw new Error(message('needsAccess'));
    if (!await send('pageCommand', { tabId, action: 'ping' }).catch(() => false)) {
      await send('attach', tabId);
    }
  }
}

async function command(pageAction: typeof actions[number]) {
  for (const button of actionButtons) button.disabled = true;
  status.classList.add('busy');
  status.textContent = message('connecting');
  try {
    await prepareSite();
    status.textContent = message(pageAction === 'detect' ? 'startingDetection' : 'startingPicker');
    let received = await send('pageCommand', { tabId, action: pageAction });
    if (!received) {
      await send('attach', tabId);
      received = await send('pageCommand', { tabId, action: pageAction });
    }
    if (!received) throw new Error(message('noChatPage'));
    window.close();
  } finally {
    status.classList.remove('busy');
    for (const button of actionButtons) button.disabled = false;
  }
}

function showTargetLanguage() {
  skipLabel.textContent = message('skipLanguage', languageName(site.readingLanguage, uiLocale));
  targetLanguage.value = site.targetLanguage ? languageName(site.targetLanguage, uiLocale) : '';
  resetTarget.hidden = !site.targetLanguage;
}

const rulePicker = document.getElementById('local-rule-picker')!;
const localRule = document.querySelector<HTMLSelectElement>('#local-rule')!;
function showLocalRules() {
  rulePicker.hidden = !site.localRules.length;
  localRule.replaceChildren(new Option(message('autoRule'), ''));
  for (const { rule, addedAt } of site.localRules) {
    const date = addedAt === null ? message('unknownRuleDate') : new Date(addedAt).toLocaleString(uiLocale);
    const description = rule.body ?? rule.bodyAfter?.anchor ?? rule.container;
    localRule.add(new Option(`${rule.pathPrefix ?? '/'} · ${description} · ${date} · ${rule.id}`, rule.id));
  }
  localRule.value = site.selectedRuleId ?? '';
  localRule.disabled = false;
}

localRule.addEventListener('change', () => {
  const room = site.scopes.find(item => item.scope === 'room');
  if (!room) return;
  const ruleId = localRule.value || null;
  localRule.disabled = true;
  void run(async () => {
    site = await send('setRuleSelection', { tabId, roomKey: room.key, ruleId });
    status.textContent = message('ruleSelectionSaved');
  }).finally(showLocalRules);
});

void run(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id === undefined) throw new Error(message('openStreamFirst'));
  tabId = tab.id;
  await chrome.sidePanel.setOptions({ tabId, path: 'sidepanel.html?tabId=' + tabId, enabled: true });
  assistant.disabled = false;
  site = await send('site', tabId);
  siteLabel.textContent = new URL(site.origin).hostname;
  for (const key of ['room', 'site'] as const) {
    if (site.scopes.some(item => item.scope === key)) scope.add(new Option(scopeNames[key], key));
  }
  scope.value = site.preferredScope ?? effectiveScope(site.scopes)?.scope ?? 'site';
  showScope();
  showLocalRules();
  emoji.checked = site.translateEmoji;
  emoji.disabled = false;
  skipReading.checked = site.skipReadingLanguage;
  skipReading.disabled = false;
  targetLanguage.placeholder = message('defaultRoomTarget', languageName(site.defaultTargetLanguage, uiLocale));
  targetLanguage.disabled = false;
  saveTarget.disabled = false;
  showTargetLanguage();
  for (const action of actions) {
    const button = document.querySelector<HTMLButtonElement>('#' + action)!;
    button.disabled = false;
    button.addEventListener('click', () => { void run(() => command(action)); });
  }
});

assistant.addEventListener('click', () => {
  // Chrome requires this call to run directly from the toolbar gesture.
  void chrome.sidePanel.open({ tabId }).then(() => window.close(), error => {
    status.textContent = error instanceof Error ? error.message : message('genericError');
  });
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
    status.textContent = message(checked === null ? 'scopeFollowed' : checked ? 'scopeEnabled' : 'scopeDisabled');
    if (checked && effectiveScope(site.scopes)?.value) {
      void send('pageCommand', { tabId, action: 'initial-review' }).catch(() => undefined);
    }
  }).finally(showScope);
}

enabled.addEventListener('change', () => setScope(enabled.checked));
resetScope.addEventListener('click', () => setScope(null));

targetLanguage.addEventListener('input', () => targetLanguage.removeAttribute('aria-invalid'));

async function saveRoomTarget(preference: string) {
  const room = site.scopes.find(item => item.scope === 'room');
  if (!room) return;
  targetLanguage.disabled = true;
  saveTarget.disabled = true;
  resetTarget.disabled = true;
  try {
    if (preference !== site.targetLanguage) {
      site.readingLanguage = await send('setTargetLanguage', { tabId, roomKey: room.key, language: preference });
      site.targetLanguage = preference;
    }
    showTargetLanguage();
    status.textContent = message(preference ? 'targetSaved' : 'resetRoomTarget');
  } finally {
    targetLanguage.disabled = false;
    saveTarget.disabled = false;
    resetTarget.disabled = false;
  }
}

resetTarget.addEventListener('click', () => { void run(() => saveRoomTarget('')); });

targetForm.addEventListener('submit', event => {
  event.preventDefault();
  const input = targetLanguage.value.trim();
  const current = site.targetLanguage ? languageName(site.targetLanguage, uiLocale) : '';
  const preference = input === current ? site.targetLanguage : input ? normalizeLanguage(input, site.browserLanguage) : '';
  if (preference === undefined) {
    status.textContent = message('targetInvalid');
    targetLanguage.setAttribute('aria-invalid', 'true');
    targetLanguage.focus();
    return;
  }
  void run(() => saveRoomTarget(preference));
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
