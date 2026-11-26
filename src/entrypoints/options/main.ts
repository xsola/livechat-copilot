import '../../platform/ui.css';
import { defaultPrompt, hostPattern, isTextOnlyModel, parseEndpoint, parseRegistry, settingsSchema } from '../../platform/config';
import { send, type RuleSummary } from '../../platform/messages';
import type { DailyUsage, ModelTask, PageCounter, TaskUsage } from '../../usage/usage';

const field = (id: string) => document.querySelector<HTMLInputElement>('#' + id)!;
const element = (id: string) => document.getElementById(id)!;
const status = element('status');
const usageStatus = element('usage-status');
const diagnostic = document.querySelector<HTMLTextAreaElement>('#diagnostic')!;
let keyOrigin = '';
let refusedImageKey = '';

function selectedImageKey() {
  return JSON.stringify([field('endpoint').value.trim(), field('model').value.trim()]);
}

function updateVisionFields() {
  const textOnly = isTextOnlyModel({ endpoint: field('endpoint').value.trim(), model: field('model').value.trim() });
  const unavailable = refusedImageKey === selectedImageKey();
  field('image').disabled = textOnly;
  if (textOnly) field('image').checked = false;
  field('auto-vision').disabled = textOnly || unavailable || !field('image').checked;
  if (field('auto-vision').disabled) field('auto-vision').checked = false;
  element('image-status').textContent = unavailable || textOnly
    ? '当前模型接口不支持图片输入，已禁用自动图像复核。'
    : field('image').checked ? '' : '图片输入未启用，已禁用自动图像复核。';
}

async function run(target: HTMLElement, operation: () => Promise<void>) {
  target.textContent = '';
  try { await operation(); }
  catch (error) { target.textContent = error instanceof Error ? error.message : '操作失败。'; }
}

function showRules(rules: RuleSummary) {
  element('rules-summary').textContent = '社区规则：' + rules.active + ' 条已验证，' + rules.staged + ' 条待验证。';
  const list = element('local-rules');
  list.replaceChildren();
  for (const rule of rules.local) {
    const row = document.createElement('li');
    row.append(rule.host + (rule.path ?? '') + ' ');
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = '删除本地规则';
    remove.addEventListener('click', () => {
      void run(status, async () => { await send('removeRule', rule.id); showRules((await send('getSettings', undefined)).rules); });
    });
    row.append(remove);
    list.append(row);
  }
}

function totals(days: DailyUsage[], range: number) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - range + 1);
  const before = [cutoff.getFullYear(), String(cutoff.getMonth() + 1).padStart(2, '0'),
    String(cutoff.getDate()).padStart(2, '0')].join('-');
  const page: Partial<Record<PageCounter, number>> = {};
  const models: Partial<Record<ModelTask, TaskUsage>> = {};
  for (const day of days.filter(day => day.date >= before)) {
    for (const key of Object.keys(day.page) as PageCounter[]) page[key] = (page[key] ?? 0) + (day.page[key] ?? 0);
    for (const key of Object.keys(day.models) as ModelTask[]) {
      const source = day.models[key];
      if (!source) continue;
      const target = models[key] ??= { requests: 0, failed: 0, inputTokens: 0, outputTokens: 0, totalMs: 0 };
      for (const field of Object.keys(target) as (keyof TaskUsage)[]) target[field] += source[field];
    }
  }
  return { page, models };
}

async function showUsage() {
  const days = Number(field('usage-range').value);
  const { page, models } = totals(await send('usageSummary', undefined), days);
  const view = element('usage');
  view.replaceChildren();
  const summary = document.createElement('p');
  summary.textContent = '翻译会话 ' + (page.sessions ?? 0) + ' · 已显示 ' + (page.rendered ?? 0) +
    ' · 缓存命中 ' + (page.cached ?? 0) + ' · 过期丢弃 ' + (page.expired ?? 0);
  const rules = document.createElement('p');
  rules.textContent = '内置规则 ' + (page.builtin ?? 0) + ' · 本地 ' + (page.local ?? 0) +
    ' · 社区 ' + (page.community ?? 0) + ' · 自动识别 ' + (page.automatic ?? 0) + ' · 手动选区 ' + (page.manualPicker ?? 0);
  view.append(summary, rules);
  const names: Record<ModelTask, string> = {
    translation: '弹幕翻译', connection: '连接测试', vision: '图像复核', roomProfile: '房间信息', agent: 'Agent',
  };
  for (const key of Object.keys(models) as ModelTask[]) {
    const row = models[key]!;
    const item = document.createElement('p');
    item.textContent = names[key] + '：' + row.requests + ' 次，失败 ' + row.failed +
      '，平均 ' + Math.round(row.totalMs / row.requests) + ' ms，token 输入 ' + row.inputTokens + ' / 输出 ' + row.outputTokens;
    view.append(item);
  }
}

void run(status, async () => {
  const { settings, rules, imageUnavailable } = await send('getSettings', undefined);
  field('endpoint').value = settings.model.endpoint;
  keyOrigin = parseEndpoint(settings.model.endpoint).origin;
  field('model').value = settings.model.model;
  field('key').value = settings.model.apiKey;
  field('image').checked = settings.model.imageInput;
  field('auto-vision').checked = settings.autoVision;
  field('json').checked = settings.model.jsonMode;
  field('language').value = settings.readingLanguage;
  field('mode').value = settings.mode;
  field('prompt').value = settings.prompt;
  field('registry').value = settings.registryUrl;
  if (imageUnavailable) refusedImageKey = selectedImageKey();
  updateVisionFields();
  showRules(rules);
});
field('endpoint').addEventListener('change', () => {
  try {
    const origin = parseEndpoint(field('endpoint').value.trim()).origin;
    if (keyOrigin && origin !== keyOrigin) field('key').value = '';
    keyOrigin = origin;
  } catch {
    // The form validates the completed endpoint before saving.
  }
});
for (const id of ['image', 'endpoint', 'model']) field(id).addEventListener('input', updateVisionFields);
window.addEventListener('focus', () => {
  void send('getSettings', undefined).then(({ settings, imageUnavailable }) => {
    refusedImageKey = imageUnavailable ? JSON.stringify([settings.model.endpoint, settings.model.model]) : '';
    updateVisionFields();
  }).catch(() => undefined);
});
void run(usageStatus, showUsage);

element('settings').addEventListener('submit', event => {
  event.preventDefault();
  void run(status, async () => {
    const settings = settingsSchema.parse({
      model: {
        endpoint: field('endpoint').value.trim(), model: field('model').value.trim(), apiKey: field('key').value.trim(),
        imageInput: field('image').checked, jsonMode: field('json').checked,
      },
      readingLanguage: field('language').value.trim(), mode: field('mode').value,
      prompt: field('prompt').value, registryUrl: field('registry').value.trim(),
      autoVision: field('auto-vision').checked && !field('auto-vision').disabled,
    });
    const origins = [hostPattern(parseEndpoint(settings.model.endpoint))];
    if (settings.registryUrl) origins.push(hostPattern(parseRegistry(settings.registryUrl)));
    if (!await chrome.permissions.request({ origins: [...new Set(origins)] })) throw new Error('未获得访问所需服务的权限。');
    await send('saveSettings', settings);
    const { imageUnavailable } = await send('getSettings', undefined);
    refusedImageKey = imageUnavailable ? selectedImageKey() : '';
    updateVisionFields();
    status.textContent = '已保存。';
    if (settings.registryUrl) showRules(await send('syncRegistry', undefined));
  });
});

element('reset-prompt').addEventListener('click', () => { field('prompt').value = defaultPrompt; });
element('sync').addEventListener('click', () => {
  void run(status, async () => { showRules(await send('syncRegistry', undefined)); status.textContent = '已检查社区规则更新。'; });
});
element('test').addEventListener('click', () => {
  void run(status, async () => {
    status.textContent = '请求模型…';
    await send('connection', undefined);
    status.textContent = '连接正常。';
    await showUsage();
  });
});
element('usage-range').addEventListener('change', () => { void run(usageStatus, showUsage); });
element('refresh-usage').addEventListener('click', () => { void run(usageStatus, showUsage); });
element('clear').addEventListener('click', () => {
  if (!window.confirm('清空本地用量统计？')) return;
  void run(usageStatus, async () => {
    await send('clearUsage', undefined);
    diagnostic.value = '';
    element('diagnostic-preview').hidden = true;
    await showUsage();
    usageStatus.textContent = '已清空。';
  });
});
element('export').addEventListener('click', () => {
  void run(usageStatus, async () => {
    diagnostic.value = JSON.stringify({
      schemaVersion: 1, extensionVersion: chrome.runtime.getManifest().version,
      ...totals(await send('usageSummary', undefined), Number(field('usage-range').value)),
    }, null, 2);
    element('diagnostic-preview').hidden = false;
  });
});
element('copy').addEventListener('click', () => {
  void run(usageStatus, async () => { await navigator.clipboard.writeText(diagnostic.value); usageStatus.textContent = '已复制。'; });
});
