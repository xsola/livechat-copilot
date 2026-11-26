import { matches, messageText, query, queryAll, selectorPath, stableSelector, testRule, type RuleTest } from '../dom';
import type { ChatRule } from '../../rules/schema';
import { isYouTube } from '../../platform/config';

export interface Candidate extends RuleTest { rule: ChatRule; score: number; alternativeComposer?: ChatRule }

const chatNames = /chat|comment|message|danmaku/i;
const editorNames = /chat|comment|message|danmaku|弹幕|彈幕|聊天|发言|發言|コメント|チャット|채팅/i;
const messageBodies = [
  '#message', '[data-message-body]', '[data-testid*="message-text"]', '[data-testid*="message-content"]',
  '[data-a-target="chat-line-message-body"]', '[data-test-selector="chat-line-message-body"]', '.chat-line__message--message',
  '[data-role="message-body"]', '.message-body', '.message-content', '.message-text', '.chat-text', '.comment-text', '.body', '.text',
];
const author = '[rel="author"], [class*="author" i], [class*="username" i], [data-testid*="username" i], #author-name';
const excluded = 'nav, header, footer, form, video, canvas, [role="toolbar"], [role="menu"], [data-livechat-copilot], ' +
  '[data-a-target^="player"], [data-a-target="video-player"], .video-player, [class*="player-controls" i]';
const messageRow = '[data-a-target="chat-line-message"], [data-test-selector="chat-line-message"], .chat-line__message, ' +
  'yt-live-chat-text-message-renderer, [data-message-id], [data-testid="chat-message"]';
const rowSelector = ':is(' + messageRow + ', [role="listitem"])';
const editors = 'textarea, [contenteditable="true"], [contenteditable="plaintext-only"], [role="textbox"], input[type="text"], input:not([type])';
const sendLabel = /\b(?:send|submit|post|chat.send)\b|发送|發送|送信|전송/i;

export function insidePlayer(element: Element) {
  return Boolean(element.closest('video, canvas, [data-a-target^="player"], [data-a-target="video-player"], ' +
    '.video-player, [class*="player-controls" i]'));
}

function sharedBody(row: Element, example: Element) {
  if (example.id && row.querySelectorAll('#' + CSS.escape(example.id)).length === 1) return '#' + CSS.escape(example.id);
  const selector = stableSelector(example);
  if (row.querySelectorAll(selector).length === 1 && query(row, selector) === example) return selector;
  return selectorPath(row, example);
}

export function candidateFrom(
  document: Document,
  region: Element,
  page: URL,
  frame: URL,
  example?: Element,
): Candidate | undefined {
  if (region.closest(excluded) || query(region, 'video, [data-a-target="video-player"]')) return;
  const container = selectorPath(document, region);
  if (!container || container.length > 500) return;
  const semanticRows = queryAll(region, rowSelector + ':not(' + rowSelector + ' *)');
  const useSemantic = semanticRows.length >= 2 && (!example || semanticRows.some(row => row.contains(example)));
  const children = (useSemantic ? semanticRows : Array.from(region.children)).slice(-40)
    .filter(child => !matches(child, excluded));
  const sampleRow = example && children.find(row => row.contains(example));
  if (example && !sampleRow) return;
  const groups = new Map<string, Element[]>();
  for (const row of children) {
    const shape = stableSelector(row);
    const group = groups.get(shape) ?? [];
    group.push(row);
    groups.set(shape, group);
  }
  const distinct = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
  const top = sampleRow ? distinct.find(([shape]) => matches(sampleRow, shape)) : distinct[0];
  if (!top) return;
  const [shape, group] = top;
  const rows = useSemantic ? children : group;
  if (rows.length < 2) return;
  const fit = messageBodies.find(selector => rows.filter(row => query(row, selector)).length >= Math.ceil(rows.length * 0.65));
  const body = sampleRow && example !== sampleRow
    ? (fit && query(sampleRow, fit)?.contains(example!) ? fit : sharedBody(sampleRow, example!)) : fit;
  if (sampleRow && example !== sampleRow && !body) return;
  if (!body && rows.some(row => query(row, author))) return;
  const framePathPrefix = page.pathname === frame.pathname ? undefined : frame.pathname.slice(0, 250);
  const pathPrefix = page.pathname === '/' ? '/' : '/' + page.pathname.split('/')[1];
  const rule: ChatRule = {
    schemaVersion: 1, id: 'candidate', version: 1, host: page.hostname,
    pathPrefix: pathPrefix.slice(0, 250), framePathPrefix,
    container, message: useSemantic ? rowSelector + ':not(' + rowSelector + ' *)' : ':scope > ' + shape, body,
  };
  const preview = testRule(document, rule, region);
  if (!preview || preview.messages.length < 2 || preview.rejected) return;
  const names = [region.id, region.getAttribute('class'), region.getAttribute('aria-label'),
    region.getAttribute('data-a-target'), region.getAttribute('data-test-selector')].join(' ');
  const semantic = region.getAttribute('role') === 'log' ? 8 : chatNames.test(names) ? 4 : 0;
  const score = semantic + Math.min(6, rows.length) + (body ? 4 : 0) + (fit ? 2 : 0) +
    (rows.some(row => matches(row, messageRow)) ? 5 : 0);
  return { ...preview, rule, score };
}

export function completeCandidateRule(document: Document, region: Element, rule: ChatRule): ChatRule {
  if (rule.composer && query(document, rule.composer)) return rule;
  return rankComposers(document, region, rule)[0]?.rule ?? rule;
}

function rankComposers(document: Document, region: Element, rule: ChatRule) {
  const seen = new Set<Element>();
  const ranked: Array<{ rule: ChatRule; score: number }> = [];
  const bounds = region.getBoundingClientRect();
  for (let parent = region.parentElement, depth = 0; parent && parent !== document.body && depth < 4;
    parent = parent.parentElement, depth++) {
    for (const input of queryAll(parent, editors).slice(0, 40)) {
      if (seen.has(input)) continue;
      seen.add(input);
      if (region.contains(input) || insidePlayer(input) ||
        input.closest('[data-livechat-copilot], [role="search"], nav, header, [hidden]') ||
        !input.getClientRects().length || getComputedStyle(input).visibility !== 'visible') continue;
      const box = input.getBoundingClientRect();
      const overlap = Math.min(bounds.right, box.right) - Math.max(bounds.left, box.left);
      const below = box.top >= bounds.bottom - 16 && box.top <= bounds.bottom + 180 &&
        overlap >= Math.min(box.width, bounds.width) * 0.55;
      const named = editorNames.test([input.getAttribute('aria-label'), input.getAttribute('placeholder'), input.id,
        input.className, input.getAttribute('data-a-target')].join(' '));
      const controls = input.closest('form, yt-live-chat-message-input-renderer, [data-chat-composer]') ?? input.parentElement?.parentElement;
      const send = queryAll(controls ?? parent, 'button, [role="button"], input[type="submit"]').find(button =>
        sendLabel.test([button.getAttribute('aria-label'), button.getAttribute('title'), button.id, button.textContent].join(' ')) ||
        matches(button, 'button[type="submit"], input[type="submit"]'));
      if (!below && !named && !send) continue;
      const composer = selectorPath(document, input);
      if (!composer || composer.length > 500) continue;
      const sendButton = send ? selectorPath(document, send) : undefined;
      const score = 4 - depth + (below ? 5 : 0) + (named ? 4 : 0) + (sendButton ? 2 : 0);
      ranked.push({ rule: { ...rule, composer, sendButton: sendButton && sendButton.length <= 500 ? sendButton : undefined }, score });
    }
  }
  return ranked.sort((a, b) => b.score - a.score);
}

export function composerElements(candidate: Candidate) {
  const root = candidate.container.ownerDocument;
  const visible = (element: Element | null) => Boolean(element?.getClientRects().length &&
    root.defaultView?.getComputedStyle(element).visibility === 'visible');
  const configured = candidate.rule.composer ? query(root, candidate.rule.composer) : null;
  const youtubeArea = isYouTube(candidate.rule.host)
    ? query(root, 'yt-live-chat-message-input-renderer, yt-live-chat-renderer #input-panel [role="textbox"]') : null;
  const area = visible(configured) ? configured : visible(youtubeArea) ? youtubeArea : null;
  if (!area) return { editor: null, button: null, state: 'missing' as const };
  const editor = matches(area, editors) ? area : query(area, editors);
  const blocked = !editor || !visible(editor) || editor.closest('[aria-disabled="true"], [inert]') ||
    matches(editor, ':disabled, [readonly], [aria-readonly="true"]');
  if (blocked || !(editor instanceof HTMLInputElement || editor instanceof HTMLTextAreaElement ||
    (editor instanceof HTMLElement && editor.isContentEditable))) {
    return { editor: null, button: null, state: 'unavailable' as const };
  }
  const button = candidate.rule.sendButton ? query(root, candidate.rule.sendButton) : null;
  return { editor, button: visible(button) ? button : null, state: 'editable' as const };
}

export function candidateFromExample(document: Document, example: Element, page: URL, frame: URL) {
  if (example.closest(excluded)) return;
  const row = example.closest(messageRow);
  const body = example.closest(messageBodies.join(', '));
  const firstAncestor = row ? row.parentElement : body ? body.parentElement?.parentElement : example.parentElement;
  for (let ancestor = firstAncestor, depth = 0; ancestor && ancestor !== document.body && depth < 12;
    ancestor = ancestor.parentElement, depth++) {
    if (ancestor.closest(excluded)) continue;
    const candidate = candidateFrom(document, ancestor, page, frame, example);
    if (candidate) return candidate;
  }
}

export function findCandidates(document: Document, page: URL, frame: URL, activity: ReadonlyMap<Element, number>) {
  const named = Array.from(document.querySelectorAll(
    '[role="log"], [aria-live], [id*="chat" i], [class*="chat" i], [id*="comment" i], [class*="comment" i], [role="feed"], ' +
    '[data-a-target*="chat" i], [data-test-selector*="chat" i]',
  )).slice(0, 100);
  const shortlists = new Set(named.flatMap(node => [node, ...Array.from(node.children).slice(0, 8)]));
  for (const [element, changes] of activity) if (changes >= 2 && element.isConnected) shortlists.add(element);
  if (shortlists.size < 24) {
    for (const element of Array.from(document.querySelectorAll('ul, ol, [role="list"]')).slice(0, 35)) shortlists.add(element);
  }
  const ranked: Candidate[] = [];
  for (const element of shortlists) {
    if (element === document.body || element === document.documentElement ||
        element.closest(excluded) || query(element, 'video, [data-a-target="video-player"]') || !element.children.length ||
        element.clientHeight <= 0 || element.clientWidth <= 0) continue;
    const found = candidateFrom(document, element, page, frame);
    if (!found || found.messages.length < 2) continue;
    const [first, second] = rankComposers(document, element, found.rule);
    const alternativeComposer = first && second && first.score - second.score <= 2 ? second.rule : undefined;
    const score = found.score + Math.min(5, activity.get(element) ?? 0) + (first ? Math.min(4, first.score) : 0);
    if (score >= 4) ranked.push({ ...found, rule: first?.rule ?? found.rule, alternativeComposer, score });
  }
  const unique = new Set<Element>();
  return ranked.sort((a, b) => b.score - a.score).filter(candidate => {
    const first = candidate.messages[0]!.node;
    if (unique.has(first)) return false;
    unique.add(first);
    return true;
  });
}

export function visionSample(candidate: Candidate) {
  const document = candidate.container.ownerDocument;
  const fragment = document.createElement('div');
  fragment.setAttribute('data-container-tag', candidate.container.localName);
  const messages = candidate.messages.slice(-6);
  for (const { node, body } of messages) {
    const sample = document.createElement('div');
    sample.setAttribute('data-row-tag', node.localName);
    const content = document.createElement('span');
    content.setAttribute('data-body-tag', body.localName);
    content.textContent = messageText(body).slice(0, 250);
    sample.append(content);
    fragment.append(sample);
  }
  return { html: fragment.outerHTML.slice(0, 12000), samples: messages.map(({ text }) => text.slice(0, 250)) };
}
