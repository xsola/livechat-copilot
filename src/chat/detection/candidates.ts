import { matches, messageText, query, selectorPath, stableSelector, testRule, type RuleTest } from '../dom';
import type { ChatRule } from '../../rules/schema';

export interface Candidate extends RuleTest { rule: ChatRule; score: number }

const chatNames = /chat|comment|message|danmaku/i;
const messageBodies = [
  '#message', '[data-message-body]', '[data-testid*="message-text"]', '[data-testid*="message-content"]',
  '[data-role="message-body"]', '.message-body', '.message-content', '.message-text', '.chat-text', '.comment-text', '.body', '.text',
];
const author = '[rel="author"], [class*="author" i], [class*="username" i], [data-testid*="username" i], #author-name';
const excluded = 'nav, header, footer, form, video, canvas, [data-livechat-copilot]';

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
  const container = selectorPath(document, region);
  if (!container || container.length > 500) return;
  const children = Array.from(region.children).slice(-30).filter(child => !matches(child, excluded));
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
  const [shape, rows] = top;
  const fit = messageBodies.find(selector => rows.filter(row => query(row, selector)).length >= Math.ceil(rows.length * 0.65));
  const body = sampleRow && example !== sampleRow ? sharedBody(sampleRow, example!) : fit;
  if (sampleRow && example !== sampleRow && !body) return;
  if (!body && rows.some(row => query(row, author))) return;
  const framePathPrefix = page.pathname === frame.pathname ? undefined : frame.pathname.slice(0, 250);
  const pathPrefix = page.pathname === '/' ? '/' : '/' + page.pathname.split('/')[1];
  const rule: ChatRule = {
    schemaVersion: 1, id: 'candidate', version: 1, host: page.hostname,
    pathPrefix: pathPrefix.slice(0, 250), framePathPrefix,
    container, message: ':scope > ' + shape, body,
  };
  const preview = testRule(document, rule, region);
  if (!preview?.messages.length) return;
  const names = [region.id, region.getAttribute('class'), region.getAttribute('aria-label')].join(' ');
  const semantic = region.getAttribute('role') === 'log' ? 8 : chatNames.test(names) ? 4 : 0;
  const score = semantic + Math.min(6, rows.length) + (body ? 4 : 0) + (fit ? 2 : 0);
  return { ...preview, rule, score };
}

export function findCandidate(document: Document, page: URL, frame: URL, activity: ReadonlyMap<Element, number>) {
  const named = Array.from(document.querySelectorAll(
    '[role="log"], [aria-live], [id*="chat" i], [class*="chat" i], [id*="comment" i], [class*="comment" i], [role="feed"]',
  )).slice(0, 80);
  const shortlists = new Set(named.flatMap(node => [node, ...Array.from(node.children).slice(0, 8)]));
  for (const [element, changes] of activity) if (changes >= 2 && element.isConnected) shortlists.add(element);
  if (shortlists.size < 24) {
    for (const element of Array.from(document.querySelectorAll('ul, ol, [role="list"]')).slice(0, 35)) shortlists.add(element);
  }
  const ranked: Candidate[] = [];
  for (const element of shortlists) {
    if (element === document.body || element === document.documentElement ||
        element.closest(excluded) || element.children.length < 2 ||
        element.clientHeight <= 0 || element.clientWidth <= 0) continue;
    const found = candidateFrom(document, element, page, frame);
    if (!found || found.messages.length < 2) continue;
    const score = found.score + Math.min(5, activity.get(element) ?? 0);
    if (score >= 9) ranked.push({ ...found, score });
  }
  return ranked.sort((a, b) => b.score - a.score)[0];
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
