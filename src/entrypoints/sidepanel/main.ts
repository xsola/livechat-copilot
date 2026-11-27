import '../../platform/ui.css';
import './style.css';
import type { AssistantOperation, AssistantPageInfo, AssistantPageResult, AssistantTask, AssistantTaskResult, ComposerPickStatus } from '../../platform/assistant';
import { hostPattern } from '../../platform/config';
import { localizePage, message } from '../../platform/i18n';
import { send } from '../../platform/messages';
import { languageName, normalizeLanguage } from '../../rooms/language-input';

localizePage(document);
const locale = document.documentElement.lang;
const get = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const button = (id: string) => get<HTMLButtonElement>(id);
const source = get<HTMLTextAreaElement>('source');
const output = get<HTMLTextAreaElement>('result');
const language = get<HTMLInputElement>('reply-language');
const tone = get<HTMLSelectElement>('tone');
const modeButtons = document.querySelectorAll<HTMLButtonElement>('#tasks button');
const suggestions = document.querySelectorAll<HTMLButtonElement>('[data-suggestion]');
const tabParam = new URLSearchParams(location.search).get('tabId');
const panelTab = tabParam && /^\d+$/.test(tabParam) ? Number(tabParam) : undefined;

type Mode = 'translate' | 'draft' | 'analysis';
type BoundPage = { tabId: number; frameId: number; page: AssistantPageInfo; chat?: { frameId: number; pageToken: string } };
type Guard = { ticket: string; hasDraft: boolean };
type Preview = { text: string; comparison: string; language: string; mode: 'translate' | 'draft'; guard?: Guard; filled?: boolean };
let mode: Mode = 'translate';
let active: BoundPage | undefined;
let pendingOrigin: string | undefined;
let currentTab: number | undefined;
let currentWindow: number | undefined;
let epoch = 0;
let languageDirty = false;
let busy = false;
let picking = false;
let selection: string | undefined;
let selectedEditor: { frameId: number; pageToken: string; status: ComposerPickStatus } | undefined;
let suggestion: { mode: 'topics' | 'sentiment'; text: string } | undefined;
let preview: Preview | undefined;
let sourceGuard: Guard | undefined;
let sourceWasRead = false;

function status(id: string, key: string, ...values: string[]) {
  get(id).textContent = key ? message(key, ...values) : '';
}

function describeError(error: unknown) {
  const detail = error instanceof Error ? error.message : String(error);
  return /^\w+$/.test(detail) && message(detail) || detail || message('genericError');
}

function setLanguage(code: string | null) {
  language.value = code ? languageName(code, locale) : '';
  languageDirty = false;
}

function guard(page: AssistantPageInfo): Guard | undefined {
  const { ticket, hasDraft } = page.composer;
  return ticket ? { ticket, hasDraft: Boolean(hasDraft) } : undefined;
}

function updateControls() {
  get('composer-bar').hidden = !active;
  for (const element of modeButtons) element.disabled = busy || !active && element.dataset.mode !== 'analysis';
  for (const element of suggestions) element.disabled = busy || !active?.chat;
  button('run-task').disabled = busy || picking || currentTab === undefined;
  source.readOnly = busy;
  if (!active) return;
  const { composer, undoTicket } = active.page;
  const ready = composer.state === 'ready';
  const states = { ready: composer.source === 'manual' ? 'assistantEditorManual' : 'assistantEditorReady',
    missing: 'assistantEditorMissing', ambiguous: 'assistantEditorAmbiguous', unavailable: 'assistantEditorUnavailable' };
  status('composer-status', states[composer.state]);
  button('show-composer').hidden = !ready && composer.state !== 'unavailable';
  button('show-composer').disabled = busy || picking;
  button('re-detect').hidden = picking;
  button('re-detect').disabled = busy;
  button('pick-composer').hidden = picking;
  button('pick-composer').disabled = busy;
  button('reset-composer').hidden = composer.source !== 'manual' || picking;
  button('reset-composer').disabled = busy;
  button('cancel-pick').hidden = !picking;
  button('cancel-pick').disabled = busy;
  button('confirm-pick').hidden = !picking || selectedEditor?.status !== 'ready';
  button('confirm-pick').disabled = busy;
  button('read-draft').hidden = mode !== 'translate';
  button('read-draft').disabled = busy || picking || !ready;
  button('undo').hidden = !undoTicket;
  button('undo').disabled = busy || picking;
  button('save-language').disabled = busy || picking;
  button('infer-language').disabled = busy || picking;
  language.readOnly = busy;
  tone.disabled = busy;

  const canFill = ready && preview?.guard && composer.ticket === preview.guard.ticket;
  button('apply').disabled = busy || picking || !canFill || !output.value.trim();
  button('apply').textContent = message(preview?.guard?.hasDraft ? 'assistantReplace' : 'assistantApply');
  button('copy').disabled = !output.value.trim();
  button('recheck').hidden = Boolean(canFill) || !ready || !preview || Boolean(preview.filled);
  button('recheck').disabled = busy || picking;
  status('apply-note', !preview ? '' : preview.filled ? 'assistantFilled' : !ready ? 'assistantCopyFallback' :
    !canFill ? 'assistantCheckBeforeFill' : 'assistantReviewBeforeSend');
}

function clearResults() {
  preview = undefined;
  output.value = '';
  get('preview').hidden = true;
  get('analysis-result').hidden = true;
  get('answer').hidden = true;
  get('evidence').replaceChildren();
}

function renderMode() {
  for (const element of modeButtons) element.setAttribute('aria-pressed', String(element.dataset.mode === mode));
  get('language-controls').hidden = mode === 'analysis';
  get('tone-controls').hidden = mode !== 'draft';
  get('analysis-controls').hidden = mode !== 'analysis';
  get('source-controls').hidden = false;
  source.maxLength = mode === 'translate' ? 600 : 500;
  status('source-label', mode === 'translate' ? 'assistantSource' : mode === 'draft' ? 'assistantIntent' : 'assistantYourQuestion');
  source.placeholder = message(mode === 'translate' ? 'assistantSourcePlaceholder' :
    mode === 'draft' ? 'assistantIntentPlaceholder' : 'assistantQuestionPlaceholder');
  status('source-note', '');
  button('run-task').textContent = message(mode === 'translate' ? 'assistantTranslate' : mode === 'draft' ? 'assistantGenerate' : 'assistantAsk');
  status('privacy-note', mode === 'translate' ? 'assistantTranslationPrivacy' : mode === 'draft' ? 'assistantContextPrivacy' : 'assistantAskPrivacy');
  updateControls();
}

function showPage(tabId: number, result: Extract<AssistantPageResult, { kind: 'page' }>) {
  const previous = active?.page;
  if (previous && previous.pageToken !== result.page.pageToken) {
    sourceGuard = undefined;
  }
  active = { tabId, frameId: result.frameId, page: result.page, chat: Object.hasOwn(result, 'chat') ? result.chat : active?.chat };
  const { room } = result.page;
  get('room').textContent = [...new Set([room.title, room.streamer, result.page.host].filter(Boolean))].join(' · ');
  if (!languageDirty) setLanguage(room.replyLanguage);
  status('language-note', room.replyLanguage ? 'assistantLanguageRemembered' : 'assistantLanguageHelp',
    room.replyLanguage ? languageName(room.replyLanguage, locale) : '');
  get('workspace').hidden = false;
  get('connection').hidden = true;
  updateControls();
}

function stopPicking(bound = active, exceptFrame?: number) {
  const id = selection;
  selection = undefined;
  selectedEditor = undefined;
  picking = false;
  if (!bound || !id) return Promise.resolve();
  return send('assistantPage', { tabId: bound.tabId, frameId: bound.frameId,
    operation: { action: 'cancelPick', pageToken: bound.page.pageToken, selection: id, exceptFrame },
  }).catch(() => undefined);
}

function showQuestionOnly() {
  active = undefined;
  if (mode !== 'analysis') {
    mode = 'analysis';
    source.value = '';
    renderMode();
  }
  get('workspace').hidden = false;
  updateControls();
}

async function connect(reset = false) {
  const current = ++epoch;
  const previous = active;
  if (reset) {
    void stopPicking(previous);
    active = undefined;
    picking = false;
    busy = false;
    sourceGuard = undefined;
    sourceWasRead = false;
    source.value = '';
    suggestion = undefined;
    clearResults();
    setLanguage(null);
    status('picker-status', '');
    status('language-note', '');
    status('task-status', '');
  }
  get('workspace').hidden = true;
  get('connection').hidden = false;
  get('room').textContent = '';
  status('connection-status', 'connecting');
  button('connect').hidden = true;
  button('retry').hidden = true;
  try {
    const tab = panelTab === undefined ? (await chrome.tabs.query({ active: true, currentWindow: true }))[0] :
      await chrome.tabs.get(panelTab);
    if (current !== epoch) return;
    if (tab?.id === undefined) throw new Error('openStreamFirst');
    currentTab = tab.id;
    currentWindow = tab.windowId;
    const result = await send('assistantPage', { tabId: tab.id, operation: { action: 'inspect' } });
    if (current !== epoch) return;
    if (result.kind === 'page') showPage(tab.id, result);
    else if (result.kind === 'permission') {
      pendingOrigin = result.origin;
      button('connect').hidden = false;
      status('connection-status', 'assistantAccess', new URL(result.origin).hostname);
      showQuestionOnly();
    } else throw new Error('assistantUnavailable');
  } catch (error) {
    if (current !== epoch) return;
    get('connection-status').textContent = describeError(error);
    button('retry').hidden = false;
    if (currentTab !== undefined) showQuestionOnly();
  }
}

type BoundOperation = Extract<AssistantOperation, { pageToken: string }>;
type PageAction<T = BoundOperation> = T extends BoundOperation ? Omit<T, 'pageToken'> : never;
type TaskInput<T = AssistantTask> = T extends AssistantTask ? Omit<T, 'tabId' | 'frameId' | 'pageToken'> : never;

function requireActive() {
  if (!active) throw new Error('assistantPageChanged');
  return active;
}

async function pageAction(operation: PageAction, target?: { frameId: number; pageToken: string }) {
  const bound = requireActive();
  const current = epoch;
  const result = await send('assistantPage', { tabId: bound.tabId, frameId: target?.frameId ?? bound.frameId,
    operation: { ...operation, pageToken: target?.pageToken ?? bound.page.pageToken } });
  if (current !== epoch) throw new Error('assistantPageChanged');
  if (result.kind === 'page') showPage(bound.tabId, result);
  return result;
}

async function refreshBound() {
  const bound = requireActive();
  const current = epoch;
  const result = await send('assistantPage', { tabId: bound.tabId, frameId: bound.frameId, operation: { action: 'inspect' } });
  if (current !== epoch || result.kind !== 'page' || result.page.pageToken !== bound.page.pageToken) {
    throw new Error('assistantPageChanged');
  }
  showPage(bound.tabId, result);
  return result.page;
}

async function task(input: TaskInput) {
  const current = epoch;
  if (input.task === 'ask') {
    if (currentTab === undefined) throw new Error('assistantPageChanged');
    const result = await send('assistantTask', { ...input, tabId: currentTab, chat: active?.chat });
    if (current !== epoch) throw new Error('assistantPageChanged');
    return result;
  }
  const { tabId, frameId, page, chat } = requireActive();
  if ((input.task === 'analysis' || input.task === 'inferLanguage') && !chat) throw new Error('notEnoughChat');
  const context = input.task !== 'translate' && chat ? chat : { frameId, pageToken: page.pageToken };
  const result = await send('assistantTask', input.task === 'resolveLanguage'
    ? { ...input, tabId }
    : { ...input, tabId, ...context });
  if (current !== epoch) throw new Error('assistantPageChanged');
  return result;
}

async function run(progress: string, operation: () => Promise<void>, channel = 'task-status') {
  if (busy) return;
  const current = epoch;
  busy = true;
  status(channel, progress);
  updateControls();
  try {
    await operation();
  } catch (error) {
    if (current === epoch) get(channel).textContent = describeError(error);
  } finally {
    if (current === epoch) {
      busy = false;
      updateControls();
    }
  }
}

async function replyLanguage() {
  const value = language.value.trim();
  if (!value) throw new Error('assistantNeedLanguage');
  const code = normalizeLanguage(value, locale);
  if (code) return code;
  const result = await task({ task: 'resolveLanguage', text: value });
  if (result.kind !== 'language' || !result.language) throw new Error('assistantNeedLanguage');
  return result.language;
}

function showPreview(next: Preview, messageCount?: number) {
  preview = next;
  output.value = next.text;
  get('edited-note').hidden = true;
  status('preview-label', messageCount === undefined ? '' :
    messageCount ? 'assistantDraftCoverage' : 'assistantDraftNoContext', String(messageCount ?? 0));
  status('result-label', 'assistantResultLanguage', languageName(next.language, locale));
  status('comparison-label', next.mode === 'translate' ? 'assistantOriginal' : 'assistantBackTranslation');
  get('comparison').textContent = next.comparison;
  get('preview').hidden = false;
  updateControls();
}

function showAnalysis(result: Extract<AssistantTaskResult, { kind: 'analysis' }>) {
  const time = new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit', second: '2-digit' });
  status('coverage', 'assistantCoverage', String(result.messageCount), time.format(result.from), time.format(result.to));
  get('summary').textContent = result.analysis.summary;
  const points = result.analysis.points.map(point => {
    const item = document.createElement('li');
    const text = document.createElement('span');
    text.textContent = point.text;
    const details = document.createElement('details');
    const label = document.createElement('summary');
    label.textContent = message('assistantEvidence');
    details.append(label);
    for (const id of new Set(point.evidence)) {
      const quote = document.createElement('blockquote');
      quote.dir = 'auto';
      quote.textContent = result.excerpts[id - 1] ?? '';
      details.append(quote);
    }
    item.append(text, details);
    return item;
  });
  get('evidence').replaceChildren(...points);
  get('analysis-result').hidden = false;
}

for (const element of modeButtons) element.addEventListener('click', () => {
  if (element.dataset.mode === mode) return;
  mode = element.dataset.mode as Mode;
  source.value = '';
  suggestion = undefined;
  sourceGuard = undefined;
  sourceWasRead = false;
  clearResults();
  status('task-status', '');
  renderMode();
});
for (const element of suggestions) element.addEventListener('click', () => {
  const mode = element.dataset.suggestion as 'topics' | 'sentiment';
  const text = message(mode === 'topics' ? 'assistantTopics' : 'assistantSentiment');
  suggestion = { mode, text };
  source.value = text;
  source.focus();
});
source.addEventListener('input', () => { if (suggestion?.text !== source.value) suggestion = undefined; });
language.addEventListener('input', () => { languageDirty = true; });
output.addEventListener('input', () => {
  if (preview) preview.filled = false;
  get('edited-note').hidden = preview?.mode !== 'draft' || output.value === preview.text;
  updateControls();
});

get<HTMLFormElement>('task-form').addEventListener('submit', event => {
  event.preventDefault();
  if (picking) return;
  void run('assistantWorking', async () => {
    const text = source.value;
    const maximum = mode === 'translate' ? 600 : 500;
    if (!text.trim()) throw new Error(mode === 'analysis' ? 'needQuestion' : 'assistantNeedText');
    if (text.length > maximum) throw new Error('assistantTextTooLong');
    clearResults();
    if (mode === 'analysis') {
      const result = suggestion && suggestion.text === text
        ? await task({ task: 'analysis', mode: suggestion.mode, question: '' })
        : await task({ task: 'ask', question: text.trim() });
      if (result.kind === 'analysis') showAnalysis(result);
      if (result.kind === 'answer') { get('answer-text').textContent = result.answer; get('answer').hidden = false; }
    } else {
      const page = await refreshBound();
      const target = await replyLanguage();
      const fillGuard = mode === 'translate' && sourceWasRead ? sourceGuard : guard(page);
      const result = mode === 'translate'
        ? await task({ task: 'translate', text, language: target })
        : await task({ task: 'draft', text: text.trim(), language: target, tone: tone.value === 'polite' ? 'polite' : 'casual' });
      if (result.kind === 'translate') showPreview({ text: result.translation, comparison: text, language: target, mode, guard: fillGuard });
      if (result.kind === 'draft') showPreview({ text: result.draft.draft, comparison: result.draft.backTranslation,
        language: target, mode, guard: fillGuard }, result.messageCount);
    }
    status('task-status', '');
  });
});

button('read-draft').addEventListener('click', () => { void run('', async () => {
  const result = await pageAction({ action: 'readDraft' });
  if (result.kind !== 'page' || result.page.composer.draft === undefined) throw new Error('assistantCannotRead');
  source.value = result.page.composer.draft;
  sourceWasRead = true;
  sourceGuard = guard(result.page);
  status('source-note', source.value ? 'assistantReadSuccess' : 'assistantInputEmpty');
}); });
button('show-composer').addEventListener('click', () => { void run('', async () => {
  const result = await pageAction({ action: 'highlight' });
  if (result.kind !== 'page') throw new Error('assistantPageChanged');
}); });
button('re-detect').addEventListener('click', () => { void run('assistantSearchingInput', async () => {
  const bound = requireActive();
  const current = epoch;
  const result = await send('assistantPage', { tabId: bound.tabId, operation: { action: 'detect' } });
  if (current !== epoch || result.kind !== 'page') throw new Error('assistantPageChanged');
  showPage(bound.tabId, result);
  const states = { ready: 'assistantEditorReady', unavailable: 'assistantEditorUnavailable',
    ambiguous: 'assistantEditorAmbiguous', missing: result.chat ? 'assistantEditorMissing' : 'assistantChatLoading' };
  status('picker-status', states[result.page.composer.state]);
}, 'picker-status'); });
button('reset-composer').addEventListener('click', () => { void run('', async () => {
  if ((await pageAction({ action: 'resetComposer' })).kind !== 'page') throw new Error('assistantPageChanged');
  status('picker-status', 'assistantEditorReset');
}, 'picker-status'); });
button('pick-composer').addEventListener('click', () => { void run('assistantClickInput', async () => {
  const id = selection = crypto.randomUUID();
  picking = true;
  const result = await pageAction({ action: 'pick', selection: id });
  if (result.kind !== 'picked') {
    await stopPicking();
    throw new Error('assistantPageChanged');
  }
}, 'picker-status'); });
button('cancel-pick').addEventListener('click', () => { void run('', async () => {
  await stopPicking();
}, 'picker-status'); });
button('confirm-pick').addEventListener('click', () => { void run('', async () => {
  if (!selection || selectedEditor?.status !== 'ready') return;
  const frameId = selectedEditor.frameId;
  const result = await pageAction({ action: 'confirmPick', selection }, selectedEditor);
  if (result.kind !== 'page') throw new Error('assistantPickFailed');
  await stopPicking(active, frameId);
  status('picker-status', 'assistantEditorSaved');
}, 'picker-status'); });
button('save-language').addEventListener('click', () => { void run('assistantSavingLanguage', async () => {
  const code = await replyLanguage();
  if ((await pageAction({ action: 'setLanguage', language: code })).kind !== 'page') throw new Error('assistantPageChanged');
  setLanguage(code);
  status('task-status', 'assistantLanguageRemembered', languageName(code, locale));
}); });
button('infer-language').addEventListener('click', () => { void run('assistantInferringLanguage', async () => {
  const result = await task({ task: 'inferLanguage' });
  if (result.kind !== 'language' || !result.language) throw new Error('assistantLanguageUncertain');
  await refreshBound();
  setLanguage(result.language);
  status('task-status', 'assistantLanguageRemembered', languageName(result.language, locale));
}); });
button('apply').addEventListener('click', () => { void run('', async () => {
  if (!preview?.guard) return;
  const result = await pageAction({ action: 'apply', ticket: preview.guard.ticket, text: output.value });
  if (result.kind !== 'page') {
    preview.guard = undefined;
    await refreshBound();
    throw new Error('assistantFillConflict');
  }
  preview.guard = undefined;
  preview.filled = true;
}); });
button('undo').addEventListener('click', () => { void run('', async () => {
  const ticket = active?.page.undoTicket;
  if (!ticket) return;
  const result = await pageAction({ action: 'undo', ticket });
  if (result.kind !== 'page') {
    await refreshBound();
    throw new Error('assistantUndoConflict');
  }
  if (preview?.filled) {
    preview.filled = false;
    preview.guard = guard(result.page);
  }
  status('task-status', 'assistantUndone');
}); });
button('copy').addEventListener('click', () => {
  void navigator.clipboard.writeText(output.value).then(() => status('task-status', 'assistantCopied'),
    error => { get('task-status').textContent = describeError(error); });
});
button('recheck').addEventListener('click', () => { void run('', async () => {
  if (preview) preview.guard = guard(await refreshBound());
  status('task-status', 'assistantInputChecked');
}); });

button('connect').addEventListener('click', () => {
  if (!pendingOrigin) return;
  void chrome.permissions.request({ origins: [hostPattern(new URL(pendingOrigin))] }).then(allowed => {
    if (allowed) return connect();
    status('connection-status', 'needsAccess');
  }, error => { get('connection-status').textContent = describeError(error); });
});
button('retry').addEventListener('click', () => { void connect(); });
chrome.runtime.onMessage.addListener((event, sender) => {
  if (sender.id !== chrome.runtime.id || !active || sender.tab?.id !== active.tabId || sender.frameId === undefined ||
    !selection || event?.selection !== selection || typeof event?.pageToken !== 'string') return;
  const feedback = { ready: 'assistantPickedReady', unavailable: 'assistantPickedUnavailable', unusable: 'assistantPickedUnusable',
    'no-editor': 'assistantPickedMissing', cancelled: 'assistantPickCancelled' } as const;
  if (!Object.hasOwn(feedback, event.composerPicked)) return;
  const outcome = event.composerPicked as ComposerPickStatus;
  if (outcome === 'cancelled') void stopPicking();
  else {
    const previous = selectedEditor;
    selectedEditor = { frameId: sender.frameId, pageToken: event.pageToken, status: outcome };
    if (previous && previous.frameId !== sender.frameId) void pageAction({ action: 'unlockPick', selection }, previous).catch(() => undefined);
  }
  status('picker-status', feedback[outcome]);
  updateControls();
});
chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  if (panelTab === undefined) {
    if (currentWindow === undefined || windowId === currentWindow) void connect(true);
  } else if (tabId !== panelTab && windowId === currentWindow && picking) {
    void stopPicking();
    status('picker-status', '');
    updateControls();
  } else if (tabId === panelTab && !active) void connect();
});
window.addEventListener('pagehide', () => {
  if (picking) void stopPicking();
});
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (tabId !== currentTab) return;
  if (change.url || change.status === 'loading') void connect(true);
  else if (change.status === 'complete' && !active) void connect();
});
renderMode();
void connect();
