import '../../platform/ui.css';
import { hostPattern } from '../../platform/config';
import { send, type SiteState } from '../../platform/messages';

const siteLabel = document.querySelector<HTMLParagraphElement>('#site')!;
const enabled = document.querySelector<HTMLInputElement>('#enabled')!;
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
    if (!await chrome.tabs.sendMessage(tabId, { pageAction: 'ping' }).catch(() => false)) {
      await send('attach', tabId);
    }
  }
}

async function command(pageAction: typeof actions[number]) {
  await prepareSite();
  let received = await chrome.tabs.sendMessage(tabId, { pageAction }).catch(() => undefined);
  if (!received) {
    await send('attach', tabId);
    received = await chrome.tabs.sendMessage(tabId, { pageAction }).catch(() => undefined);
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
  }).finally(() => {
    enabled.checked = site.enabled;
    enabled.disabled = false;
  });
});

document.querySelector('#options')!.addEventListener('click', () => { void chrome.runtime.openOptionsPage(); });
