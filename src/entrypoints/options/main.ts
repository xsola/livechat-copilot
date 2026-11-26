import '../../platform/ui.css';
import { hostPattern, isTextOnlyModel, languageCode, modelConfig, parseEndpoint, type ModelConfig, type Settings } from '../../platform/config';
import { send, type PromptContext, type RuleSummary } from '../../platform/messages';
import { followsDefaultWording, wordingPreference, type PromptTask } from '../../models/prompts';
import type { DailyUsage, ModelTask, PageCounter, TaskUsage } from '../../usage/usage';

const field = (id: string) => document.querySelector<HTMLInputElement>('#' + id)!;
const element = (id: string) => document.getElementById(id)!;
const status = element('status');
const usageStatus = element('usage-status');
const diagnostic = document.querySelector<HTMLTextAreaElement>('#diagnostic')!;
let keyOrigin = '';
let browserLanguage = '';
let savedModel: ModelConfig | undefined;
let savedImageUnavailable = false;
let testedImage: { key: string; supported: boolean } | undefined;

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

function modelFields() {
  return { endpoint: field('endpoint').value.trim(), model: field('model').value.trim(), apiKey: field('key').value.trim() };
}

function modelKey({ endpoint, model, apiKey }: ReturnType<typeof modelFields>) {
  return JSON.stringify([endpoint, model, apiKey]);
}

function imageCapability() {
  const fields = modelFields();
  if (isTextOnlyModel(fields)) return false;
  const key = modelKey(fields);
  const matchesSaved = savedModel && key === modelKey(savedModel);
  if (matchesSaved && savedImageUnavailable) return false;
  if (testedImage?.key === key) return testedImage.supported;
  return matchesSaved ? savedModel?.imageInput ?? null : null;
}

function updateVisionFields() {
  const supported = imageCapability();
  field('auto-vision').disabled = supported !== true;
  if (supported !== true) field('auto-vision').checked = false;
  element('image-status').textContent = supported === false
    ? '当前模型不支持图片输入，截图核验不可用。'
    : supported === null ? '请先测试当前模型，确认支持图片后即可开启。' : '';
}

function rememberCapability(model: ModelConfig, imageUnavailable: boolean) {
  savedModel = model;
  savedImageUnavailable = imageUnavailable;
  updateVisionFields();
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
  for (const { rule, addedAt } of rules.local) {
    const row = document.createElement('li');
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = rule.host + (rule.pathPrefix ?? '/') + ' · ' + rule.id;
    const date = document.createElement('span');
    date.className = 'rule-date secondary';
    date.textContent = addedAt === null ? '旧规则，添加时间未记录。' : '添加于 ' + new Date(addedAt).toLocaleString();
    summary.append(date);
    const content = document.createElement('pre');
    content.textContent = JSON.stringify(rule, null, 2);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = '删除本地规则';
    remove.addEventListener('click', () => {
      void run(element('local-rule-status'), async () => {
        await send('removeRule', rule.id);
        showRules((await send('getSettings', undefined)).rules);
      });
    });
    details.append(summary, content, remove);
    row.append(details);
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
  field('auto-vision').checked = settings.autoVision;
  field('language').value = settings.readingLanguage;
  field('language').placeholder = locale;
  field('mode').value = settings.mode;
  field('prompt').value = followsDefaultWording(settings.prompt) ? '' : settings.prompt;
  field('prompt').placeholder = wordingPreference('', browserLanguage);
  rememberCapability(settings.model, imageUnavailable);
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
for (const id of ['endpoint', 'model', 'key']) field(id).addEventListener('input', updateVisionFields);
for (const id of ['endpoint', 'model', 'key', 'language']) {
  field(id).addEventListener('input', () => renderProbe('待测试', '待测试', '—', '测试使用一条示例弹幕和一张合成图片。'));
}
field('mode').addEventListener('change', updateReadingHelp);
window.addEventListener('focus', () => {
  void send('getSettings', undefined).then(({ settings, imageUnavailable, rules }) => {
    rememberCapability(settings.model, imageUnavailable);
    showRules(rules);
  }).catch(() => undefined);
});
void run(usageStatus, showUsage);

const advanced = document.querySelector<HTMLDetailsElement>('#advanced-prompt')!;
const instruction = document.querySelector<HTMLTextAreaElement>('#system-instruction')!;
const systemPreview = document.querySelector<HTMLTextAreaElement>('#system-preview')!;
const systemStatus = element('system-status');
const editSystem = document.querySelector<HTMLButtonElement>('#edit-system')!;
const saveSystem = document.querySelector<HTMLButtonElement>('#save-system')!;
const resetSystem = document.querySelector<HTMLButtonElement>('#reset-system')!;
const fromTab = new URL(location.href).searchParams.get('fromTab');
const sourceTab = fromTab && /^\d+$/.test(fromTab) ? Number(fromTab) : undefined;
const currentTask = () => field('prompt-task').value as PromptTask;
let promptContext: PromptContext | undefined;

function showPrompt() {
  if (!promptContext) return;
  const info = promptContext.prompts[currentTask()];
  instruction.value = info.instruction;
  instruction.readOnly = true;
  systemPreview.value = info.system;
  editSystem.disabled = false;
  saveSystem.disabled = true;
  resetSystem.disabled = false;
  element('reset-system-help').textContent = promptContext.origin
    ? '重置后，当前网站的这项任务会使用全局提示词。'
    : '重置后，这项任务会使用插件内置的默认提示词。';
  element('prompt-context').textContent = [
    promptContext.origin ? '当前网站 ' + promptContext.origin : '全局默认',
    promptContext.title, promptContext.model, '翻译目标语言 ' + promptContext.readingLanguage,
  ].filter(Boolean).join(' · ');
}

async function refreshPrompt() {
  promptContext = await send('promptContext', sourceTab);
  showPrompt();
}

advanced.addEventListener('toggle', () => {
  if (advanced.open) void run(systemStatus, refreshPrompt);
});
field('prompt-task').addEventListener('change', showPrompt);
editSystem.addEventListener('click', () => {
  instruction.readOnly = false;
  saveSystem.disabled = false;
  editSystem.disabled = true;
  instruction.focus();
});
function updatePrompt(value: string | null) {
  void run(systemStatus, async () => {
    if (!promptContext) return;
    if (value === '') throw new Error('请填写指令，或使用恢复按钮。');
    promptContext = await send('savePrompt', { tabId: sourceTab, origin: promptContext.origin, task: currentTask(), value });
    showPrompt();
    systemStatus.textContent = value === null ? '提示词已重置。' : '任务指令已保存。';
  });
}
saveSystem.addEventListener('click', () => updatePrompt(instruction.value.trim()));
resetSystem.addEventListener('click', () => updatePrompt(null));

function currentModel() {
  return modelConfig.parse({ ...modelFields(), imageInput: imageCapability() });
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
      if (advanced.open && instruction.readOnly) await refreshPrompt();
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
    const { settings, imageUnavailable } = await send('getSettings', undefined);
    rememberCapability(settings.model, imageUnavailable);
    status.textContent = '已保存。';
    if (advanced.open && instruction.readOnly) await refreshPrompt();
  });
});

element('reset-prompt').addEventListener('click', () => { field('prompt').value = ''; });
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
      const key = modelKey(model);
      if (key !== modelKey(modelFields()) || language !== field('language').value.trim()) return;
      const image = { supported: '支持', unsupported: '不支持', unverified: '未确认', skipped: '未测试' }[result.image];
      renderProbe(result.translationMs === null ? '测试失败' : '连接正常', image,
        result.translationMs === null ? '—' : result.translationMs + ' ms',
        result.connectionError ?? (result.image === 'unverified'
          ? '文字翻译可用，但图片测试未返回可验证的结果。'
          : '单条示例请求耗时，不含弹幕排队。'));
      if (result.image === 'supported' || result.image === 'unsupported') {
        const supported = result.image === 'supported';
        testedImage = { key, supported };
        if (savedModel && key === modelKey(savedModel)) savedImageUnavailable = !supported;
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
    setDiagnosticOpen(false);
    await showUsage();
    usageStatus.textContent = '已清空。';
  });
});
function setDiagnosticOpen(open: boolean) {
  element('diagnostic-preview').hidden = !open;
  element('export').setAttribute('aria-expanded', String(open));
  element('export').textContent = open ? '收起诊断摘要' : '预览诊断摘要';
}
element('export').addEventListener('click', () => {
  const open = element('diagnostic-preview').hidden === true;
  setDiagnosticOpen(open);
  if (!open) return;
  void run(usageStatus, async () => {
    diagnostic.value = JSON.stringify({
      schemaVersion: 1, extensionVersion: chrome.runtime.getManifest().version,
      ...totals(await send('usageSummary', undefined), Number(field('usage-range').value)),
    }, null, 2);
  });
});
element('copy').addEventListener('click', () => {
  void run(usageStatus, async () => { await navigator.clipboard.writeText(diagnostic.value); usageStatus.textContent = '已复制。'; });
});
