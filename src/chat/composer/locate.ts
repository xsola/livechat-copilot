import type { ChatRule } from '../../rules/schema';
import type { ComposerBinding, ComposerState } from '../../platform/assistant';
import { insidePlayer } from '../detection/candidates';
import { queryAll } from '../dom';

const editableSelector = 'textarea, input[type="text"], input:not([type]), [contenteditable]';
const youtubeComposer = 'yt-live-chat-message-input-renderer, yt-live-chat-renderer #input-panel';
const fieldContainer = '[role="textbox"], label, form, [data-chat-composer], ' + youtubeComposer;
const chatName = /chat|danmaku|message|comment|弹幕|彈幕|聊天|发言|發言|コメント|チャット|채팅/i;
const unrelatedName = /search|filter|reply to comment|搜索|搜尋|筛选|篩選|検索/i;
export type Editor = HTMLInputElement | HTMLTextAreaElement | HTMLElement;

function visibleField(element: Element | null): element is HTMLElement {
  return element instanceof HTMLElement &&
    !element.closest('[data-livechat-copilot], [role="search"], header, nav, [hidden]') &&
    !insidePlayer(element) && Boolean(element.getClientRects().length) &&
    getComputedStyle(element).visibility === 'visible';
}

export function permittedEditor(element: Element | null): element is Editor {
  if (!visibleField(element)) return false;
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) return element.matches(editableSelector) &&
    !element.matches('[autocomplete="username"], [autocomplete="email"], [autocomplete$="password"]');
  return element.isContentEditable && !element.parentElement?.isContentEditable;
}

export function canWrite(element: Editor) {
  return element.isConnected && permittedEditor(element) &&
    !element.closest('[inert], [aria-disabled="true"], [aria-readonly="true"]') &&
    !element.matches(':disabled, [readonly]') &&
    (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element.isContentEditable);
}

function inArea(area: ParentNode) {
  return queryAll(area, editableSelector).filter(permittedEditor);
}

function editableAt(node: HTMLElement): Editor | undefined {
  return permittedEditor(node) ? node : undefined;
}

function fromSelector(selector: string) {
  const elements = new Set<Editor>();
  for (const area of queryAll(document, selector)) {
    if (permittedEditor(area)) elements.add(area);
    else for (const element of inArea(area)) elements.add(element);
  }
  return [...elements];
}

export function editorAt(path: EventTarget[]) {
  for (const node of path) {
    if (!(node instanceof HTMLElement)) continue;
    const direct = editableAt(node);
    if (direct) return direct;
    if (!node.matches(fieldContainer) || !visibleField(node)) continue;
    const editors = inArea(node);
    if (editors.length === 1) return editors[0];
    if (!editors.length && node.matches('[role="textbox"], ' + youtubeComposer)) return node;
  }
}

function describeField(editor: Editor) {
  return ['aria-label', 'placeholder', 'data-placeholder', 'data-a-target', 'id', 'class']
    .map(name => editor.getAttribute(name)).filter(Boolean).join(' ');
}

function rankEditors(region?: Element) {
  const bounds = region?.getBoundingClientRect();
  return inArea(document).flatMap(editor => {
    const name = describeField(editor);
    if (unrelatedName.test(name)) return [];
    const box = editor.getBoundingClientRect();
    const overlap = bounds ? Math.min(bounds.right, box.right) - Math.max(bounds.left, box.left) : 0;
    const delta = bounds ? box.top - bounds.bottom : Infinity;
    const aligned = Boolean(bounds && delta >= -64 && delta <= 240 && overlap >= Math.min(box.width, bounds.width) * 0.55);
    const controls = editor.closest('form, [data-chat-composer], ' + youtubeComposer) ?? editor.parentElement?.parentElement;
    const send = controls && queryAll(controls, 'button, [role="button"], input[type="submit"]').some(button =>
      /send|submit|发送|發送|送信|전송/i.test([button.id, button.getAttribute('aria-label'), button.textContent].join(' ')) ||
      button.matches('[type="submit"]'));
    const named = chatName.test(name);
    if (!aligned && !(named && send)) return [];
    return [{ editor, score: (aligned ? 9 + (Math.abs(delta) < 60 ? 3 : 0) : 0) + (named ? 5 : 0) + (send ? 3 : 0) }];
  }).sort((a, b) => b.score - a.score);
}

export function locateComposer(binding?: ComposerBinding, region?: Element, rule?: ChatRule):
  { state: ComposerState['state']; source?: ComposerState['source']; editor?: Editor } {
  function summarize(editors: Editor[], source: ComposerState['source']) {
    const [editor] = editors;
    if (editors.length > 1) return { state: 'ambiguous', source } as const;
    if (!editor) return { state: 'missing', source } as const;
    if (!canWrite(editor)) return { state: 'unavailable', source, editor } as const;
    return { state: 'ready', source, editor } as const;
  }
  const manual = binding?.path === location.pathname;
  if (manual) {
    const editors = fromSelector(binding.selector);
    if (editors.length) return summarize(editors, 'manual');
  }
  if (rule?.composer) {
    const editors = fromSelector(rule.composer);
    if (editors.length) return summarize(editors, 'rule');
    const blocked = queryAll(document, rule.composer).find((element): element is HTMLElement => element instanceof HTMLElement &&
      Boolean(element.getClientRects().length) && getComputedStyle(element).visibility === 'visible' &&
      element.matches('[role="textbox"], [aria-disabled="true"]'));
    if (blocked) return { state: 'unavailable', source: 'rule', editor: blocked };
  }
  const youtube = /(?:^|\.)youtube\.com$/i.test(location.hostname);
  if (youtube) {
    const editors = fromSelector(youtubeComposer);
    if (editors.length) return summarize(editors, 'rule');
    const placeholder = queryAll(document, youtubeComposer).find(visibleField);
    if (placeholder) return { state: 'unavailable', source: 'rule', editor: placeholder };
  }
  const logs = queryAll(document, '[role="log"], iframe#chatframe, ytd-live-chat-frame iframe').filter(visibleField);
  const [first, second] = rankEditors(region ?? (logs.length === 1 ? logs[0] : undefined));
  if (!first) return { state: 'missing', source: manual ? 'manual' : undefined };
  if (second && first.score - second.score < 3) return { state: 'ambiguous' };
  return summarize([first.editor], 'automatic');
}
