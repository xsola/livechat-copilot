import '../../platform/ui.css';
import { defaultPrompt, hostPattern, isTextOnlyModel, languageCode, modelConfig, parseEndpoint, type Settings } from '../../platform/config';
import { send, type RuleSummary } from '../../platform/messages';
import type { DailyUsage, ModelTask, PageCounter, TaskUsage } from '../../usage/usage';

const field = (id: string) => document.querySelector<HTMLInputElement>('#' + id)!;
const element = (id: string) => document.getElementById(id)!;
const status = element('status');
const usageStatus = element('usage-status');
const diagnostic = document.querySelector<HTMLTextAreaElement>('#diagnostic')!;
let keyOrigin = '';
let refusedImageKey = '';
let browserLanguage = '';

const modeHelp: Record<Settings['mode'], string> = {
  batch: '短暂等候，把几条弹幕合并成一次请求，减少请求次数。',
  single: '每条弹幕单独发起请求，适合弹幕较少、希望尽快看到译文的直播间。',
  manual: '弹幕旁会显示翻译按钮，只翻译你点击的消息。',
};

function updateReadingHelp() {
  element('mode-help').textContent = modeHelp[field('mode').value as Settings['mode']];
  element('language-help').textContent = browserLanguage
    ? '留空时跟随浏览器界面语言（' + browserLanguage + '）。'
    : '留空时跟随浏览器界面语言。';
}

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
  element('local-rule-panel').hidden = rules.local.length === 0;
  const list = element('local-rules');
  list.replaceChildren();
  for (const rule of rules.local) {
    const row = document.createElement('li');
    row.append(rule.host + (rule.path ?? '') + ' ');
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = '删除本地规则';
    remove.addEventListener('click', () => {
      void run(element('local-rule-status'), async () => {
        await send('removeRule', rule.id);
        showRules((await send('getSettings', undefined)).rules);
      });
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
    ' · 自动识别 ' + (page.automatic ?? 0) + ' · 手动选区 ' + (page.manualPicker ?? 0);
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
  const { settings, rules, imageUnavailable, browserLanguage: locale } = await send('getSettings', undefined);
  browserLanguage = locale;
  field('endpoint').value = settings.model.endpoint;
  keyOrigin = parseEndpoint(settings.model.endpoint).origin;
  field('model').value = settings.model.model;
  field('key').value = settings.model.apiKey;
  field('image').checked = settings.model.imageInput;
  field('auto-vision').checked = settings.autoVision;
  field('json').checked = settings.model.jsonMode;
  field('language').value = settings.readingLanguage;
  field('language').placeholder = locale;
  field('mode').value = settings.mode;
  field('prompt').value = settings.prompt;
  if (imageUnavailable) refusedImageKey = selectedImageKey();
  updateVisionFields();
  updateReadingHelp();
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
for (const id of ['endpoint', 'model', 'key', 'json', 'language']) {
  field(id).addEventListener('input', () => renderProbe('待测试', '待测试', '—', '测试使用一条示例弹幕和一张合成图片。'));
}
field('mode').addEventListener('change', updateReadingHelp);
window.addEventListener('focus', () => {
  void send('getSettings', undefined).then(({ settings, imageUnavailable, rules }) => {
    refusedImageKey = imageUnavailable ? JSON.stringify([settings.model.endpoint, settings.model.model]) : '';
    updateVisionFields();
    showRules(rules);
  }).catch(() => undefined);
});
void run(usageStatus, showUsage);

function currentModel() {
  return modelConfig.parse({
    endpoint: field('endpoint').value.trim(), model: field('model').value.trim(), apiKey: field('key').value.trim(),
    imageInput: field('image').checked, jsonMode: field('json').checked,
  });
}

function currentLanguage() {
  const value = field('language').value.trim();
  if (value && !languageCode.safeParse(value).success) throw new Error('请填写语言代码，例如 ja 或 zh-CN，也可以留空跟随浏览器。');
  return value;
}

function renderProbe(connection: string, image: string, latency: string, detail: string) {
  element('test-connection').textContent = connection;
  element('test-image').textContent = image;
  element('test-latency').textContent = latency;
  element('test-detail').textContent = detail;
}

document.querySelector<HTMLFormElement>('#settings')!.addEventListener('submit', event => {
  event.preventDefault();
  if (event.submitter?.id === 'save-preferences') {
    const target = element('preferences-status');
    void run(target, async () => {
      await send('saveReadingSettings', {
        readingLanguage: currentLanguage(), mode: field('mode').value as Settings['mode'], prompt: field('prompt').value,
      });
      target.textContent = '翻译偏好已保存。';
    });
    return;
  }
  void run(status, async () => {
    const model = currentModel();
    const autoVision = field('auto-vision').checked && !field('auto-vision').disabled;
    if (!await chrome.permissions.request({ origins: [hostPattern(parseEndpoint(model.endpoint))] })) {
      throw new Error('未获得访问模型服务的权限。');
    }
    await send('saveModelSettings', { model, autoVision });
    const { imageUnavailable } = await send('getSettings', undefined);
    refusedImageKey = imageUnavailable ? selectedImageKey() : '';
    updateVisionFields();
    status.textContent = '已保存。';
  });
});

element('reset-prompt').addEventListener('click', () => { field('prompt').value = defaultPrompt; });
const testButton = document.querySelector<HTMLButtonElement>('#test')!;
testButton.addEventListener('click', () => {
  testButton.disabled = true;
  void (async () => {
    try {
      const model = currentModel();
      const language = currentLanguage();
      renderProbe('测试中…', '等待连接', '—', '正在用当前填写的信息请求模型。');
      if (!await chrome.permissions.request({ origins: [hostPattern(parseEndpoint(model.endpoint))] })) {
        throw new Error('未获得访问模型服务的权限。');
      }
      const result = await send('probeModel', { model, readingLanguage: language });
      if (JSON.stringify(model) !== JSON.stringify(currentModel()) || language !== currentLanguage()) return;
      const image = { supported: '支持', unsupported: '不支持', unverified: '未确认', skipped: '未测试' }[result.image];
      renderProbe(result.translationMs === null ? '测试失败' : '连接正常', image,
        result.translationMs === null ? '—' : result.translationMs + ' ms',
        result.connectionError ?? (result.image === 'unverified'
          ? '文字翻译可用，但图片测试未返回可验证的结果。'
          : '单条示例请求耗时，不含弹幕排队。'));
      if (result.image === 'supported') {
        refusedImageKey = '';
        field('image').checked = true;
      } else if (result.image === 'unsupported') {
        refusedImageKey = selectedImageKey();
        field('image').checked = false;
      }
      updateVisionFields();
      void showUsage().catch(() => undefined);
    } catch (error) {
      renderProbe('测试失败', '未测试', '—', error instanceof Error ? error.message : '操作失败。');
    } finally {
      testButton.disabled = false;
    }
  })();
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
