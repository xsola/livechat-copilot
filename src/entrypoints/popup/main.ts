import '../../platform/ui.css';
import { hostPattern } from '../../platform/config';
import { send, type SiteState } from '../../platform/messages';

const siteLabel = document.querySelector<HTMLParagraphElement>('#site')!;
const enabled = document.querySelector<HTMLInputElement>('#enabled')!;
const emoji = document.querySelector<HTMLInputElement>('#translate-emoji')!;
const status = document.querySelector<HTMLParagraphElement>('#status')!;
const actions = ['detect', 'pick', 'room'] as const;
let tabId: number;
let site: SiteState;

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
  await prepareSite();
  let received = await send('pageCommand', { tabId, action: pageAction });
  if (!received) {
    await send('attach', tabId);
    received = await send('pageCommand', { tabId, action: pageAction });
  }
  if (!received) throw new Error('没有找到活动的聊天页面，请打开或展开直播聊天。');
  window.close();
}

void run(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id === undefined) throw new Error('请先打开直播页面。');
  tabId = tab.id;
  site = await send('site', tabId);
  siteLabel.textContent = new URL(site.origin).hostname;
  enabled.checked = site.enabled;
  enabled.disabled = false;
  emoji.checked = site.translateEmoji;
  emoji.disabled = false;
  for (const action of actions) {
    const button = document.querySelector<HTMLButtonElement>('#' + action)!;
    button.disabled = false;
    button.addEventListener('click', () => { void run(() => command(action)); });
  }
});

enabled.addEventListener('change', () => {
  const checked = enabled.checked;
  enabled.disabled = true;
  void run(async () => {
    if (checked) await prepareSite();
    site = await send('setSite', { tabId, enabled: checked, origin: site.origin });
    status.textContent = checked ? '已启用。请在设置中配置并授权模型。' : '已暂停本站翻译。';
    if (checked) void send('pageCommand', { tabId, action: 'initial-review' }).catch(() => undefined);
  }).finally(() => {
    enabled.checked = site.enabled;
    enabled.disabled = false;
  });
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
