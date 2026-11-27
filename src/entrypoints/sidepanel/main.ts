import '../../platform/ui.css';
import './style.css';
import type { AssistantOperation, AssistantPageInfo, AssistantPageResult, AssistantTask, AssistantTaskResult } from '../../platform/assistant';
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
const analysisMode = get<HTMLSelectElement>('analysis-mode');
const modeButtons = document.querySelectorAll<HTMLButtonElement>('#tasks button');

type Mode = 'translate' | 'draft' | 'analysis';
type BoundPage = { tabId: number; frameId: number; page: AssistantPageInfo };
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
  if (!active) return;
  const { composer, undoTicket } = active.page;
  const ready = composer.state === 'ready';
  const states = { ready: composer.source === 'manual' ? 'assistantEditorManual' : 'assistantEditorReady',
    missing: 'assistantEditorMissing', ambiguous: 'assistantEditorAmbiguous', unavailable: 'assistantEditorUnavailable' };
  status('composer-status', states[composer.state]);
  button('show-composer').hidden = !ready && composer.state !== 'unavailable';
  button('show-composer').disabled = busy || picking;
  button('re-detect').hidden = ready || picking;
  button('re-detect').disabled = busy;
  button('pick-composer').hidden = picking;
  button('pick-composer').disabled = busy;
  button('reset-composer').hidden = composer.source !== 'manual' || picking;
  button('reset-composer').disabled = busy;
  button('cancel-pick').hidden = !picking;
  button('cancel-pick').disabled = busy;
  button('read-draft').hidden = mode !== 'translate';
  button('read-draft').disabled = busy || picking || !ready;
  button('undo').hidden = !undoTicket;
  button('undo').disabled = busy || picking;
  button('run-task').disabled = busy || picking;
  button('save-language').disabled = busy || picking;
  button('infer-language').disabled = busy || picking;
  for (const element of modeButtons) element.disabled = busy;
  source.readOnly = busy;
  language.readOnly = busy;
  tone.disabled = busy;
  analysisMode.disabled = busy;

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
  get('evidence').replaceChildren();
}

function renderMode() {
  const freeQuestion = analysisMode.value === 'question';
  for (const element of modeButtons) element.setAttribute('aria-pressed', String(element.dataset.mode === mode));
  get('language-controls').hidden = mode === 'analysis';
  get('tone-controls').hidden = mode !== 'draft';
  get('analysis-controls').hidden = mode !== 'analysis';
  get('source-controls').hidden = mode === 'analysis' && !freeQuestion;
  source.maxLength = mode === 'translate' ? 600 : 500;
  status('source-label', mode === 'translate' ? 'assistantSource' : mode === 'draft' ? 'assistantIntent' : 'assistantYourQuestion');
  source.placeholder = message(mode === 'translate' ? 'assistantSourcePlaceholder' :
    mode === 'draft' ? 'assistantIntentPlaceholder' : 'assistantQuestionPlaceholder');
  status('source-note', '');
  button('run-task').textContent = message(mode === 'translate' ? 'assistantTranslate' : mode === 'draft' ? 'assistantGenerate' : 'assistantRunAnalysis');
  status('privacy-note', mode === 'translate' ? 'assistantTranslationPrivacy' : 'assistantContextPrivacy');
  updateControls();
}

function showPage(tabId: number, result: Extract<AssistantPageResult, { kind: 'page' }>) {
  const previous = active?.page;
  if (previous && previous.pageToken !== result.page.pageToken) {
    clearResults();
    source.value = '';
    sourceGuard = undefined;
    sourceWasRead = false;
    languageDirty = false;
    picking = false;
  }
  active = { tabId, frameId: result.frameId, page: result.page };
  const { room } = result.page;
  get('room').textContent = [...new Set([room.title, room.streamer, result.page.host].filter(Boolean))].join(' · ');
  if (!languageDirty) setLanguage(room.replyLanguage);
  status('language-note', room.replyLanguage ? 'assistantLanguageRemembered' : 'assistantLanguageHelp',
    room.replyLanguage ? languageName(room.replyLanguage, locale) : '');
  get('workspace').hidden = false;
  get('connection').hidden = true;
  updateControls();
}

async function connect(reset = false) {
  const current = ++epoch;
  const previous = active;
  if (reset) {
    if (previous && picking) {
      void send('assistantPage', {
        tabId: previous.tabId, frameId: previous.frameId, operation: { action: 'cancelPick', pageToken: previous.page.pageToken },
      }).catch(() => undefined);
    }
    active = undefined;
    picking = false;
    busy = false;
    sourceGuard = undefined;
    sourceWasRead = false;
    source.value = '';
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
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
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
    } else throw new Error('assistantUnavailable');
  } catch (error) {
    if (current !== epoch) return;
    get('connection-status').textContent = describeError(error);
    button('retry').hidden = false;
  }
}

type BoundOperation = Exclude<AssistantOperation, { action: 'inspect' }>;
type PageAction<T = BoundOperation> = T extends BoundOperation ? Omit<T, 'pageToken'> : never;
type TaskInput<T = AssistantTask> = T extends AssistantTask ? Omit<T, 'tabId' | 'frameId' | 'pageToken'> : never;

function requireActive() {
  if (!active) throw new Error('assistantPageChanged');
  return active;
}

async function pageAction(operation: PageAction) {
  const bound = requireActive();
  const current = epoch;
  const result = await send('assistantPage', { tabId: bound.tabId, frameId: bound.frameId,
    operation: { ...operation, pageToken: bound.page.pageToken } });
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
  const { tabId, frameId, page } = requireActive();
  const current = epoch;
  const result = await send('assistantTask', input.task === 'resolveLanguage'
    ? { ...input, tabId }
    : { ...input, tabId, frameId, pageToken: page.pageToken });
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
  sourceGuard = undefined;
  sourceWasRead = false;
  clearResults();
  status('task-status', '');
  renderMode();
});
analysisMode.addEventListener('change', renderMode);
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
    if (mode !== 'analysis' && !text.trim()) throw new Error('assistantNeedText');
    if (text.length > maximum) throw new Error('assistantTextTooLong');
    if (mode === 'analysis' && analysisMode.value === 'question' && !text.trim()) throw new Error('needQuestion');
    clearResults();
    if (mode === 'analysis') {
      const selection = analysisMode.value as 'topics' | 'sentiment' | 'question';
      const result = await task({ task: 'analysis', mode: selection, question: selection === 'question' ? text.trim() : '' });
      if (result.kind === 'analysis') showAnalysis(result);
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
button('re-detect').addEventListener('click', () => { void connect(); });
button('reset-composer').addEventListener('click', () => { void run('', async () => {
  if ((await pageAction({ action: 'resetComposer' })).kind !== 'page') throw new Error('assistantPageChanged');
  status('picker-status', 'assistantEditorReset');
}, 'picker-status'); });
button('pick-composer').addEventListener('click', () => { void run('assistantClickInput', async () => {
  const result = await pageAction({ action: 'pick' });
  if (result.kind !== 'picked') throw new Error('assistantPageChanged');
  picking = true;
}, 'picker-status'); });
button('cancel-pick').addEventListener('click', () => { void run('', async () => {
  await pageAction({ action: 'cancelPick' });
  picking = false;
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
  if (sender.id !== chrome.runtime.id || !active || sender.tab?.id !== active.tabId || sender.frameId !== active.frameId ||
    event?.pageToken !== active.page.pageToken) return;
  if (event.composerPicked !== 'saved' && event.composerPicked !== 'failed' && event.composerPicked !== 'cancelled') return;
  picking = false;
  updateControls();
  if (event.composerPicked === 'saved') {
    void run('assistantEditorSaved', async () => { await refreshBound(); }, 'picker-status');
  } else status('picker-status', event.composerPicked === 'failed' ? 'assistantPickFailed' : '');
});
chrome.tabs.onActivated.addListener(({ windowId }) => {
  if (currentWindow === undefined || windowId === currentWindow) void connect(true);
});
window.addEventListener('pagehide', () => {
  if (!active || !picking) return;
  void send('assistantPage', { tabId: active.tabId, frameId: active.frameId,
    operation: { action: 'cancelPick', pageToken: active.page.pageToken } }).catch(() => undefined);
});
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (tabId !== currentTab) return;
  if (change.url || change.status === 'loading') void connect(true);
  else if (change.status === 'complete' && !active) void connect();
});
renderMode();
void connect();
