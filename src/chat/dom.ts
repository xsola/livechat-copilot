import type { ChatRule } from '../rules/schema';

export interface DOMMessage { node: Element; body: Element; text: string; withoutEmoji: string }
export interface RuleTest { container: Element; messages: DOMMessage[]; rejected: boolean }

export function query(root: ParentNode, selector: string) {
  try {
    return root.querySelector(selector);
  } catch {
    return null;
  }
}

export function queryAll(root: ParentNode, selector: string) {
  try {
    return Array.from(root.querySelectorAll(selector));
  } catch {
    return [];
  }
}

export function matches(node: Element, selector?: string) {
  if (!selector) return false;
  try { return node.matches(selector); } catch { return false; }
}

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const emoji = /[\p{Extended_Pictographic}\p{Regional_Indicator}\u20e3]/u;
const normalizeText = (text: string) => text.replace(/\s+/g, ' ').trim().slice(0, 600);

export function stripEmoji(text: string) {
  if (!emoji.test(text)) return text;
  return Array.from(graphemes.segment(text), ({ segment }) => emoji.test(segment) ? '' : segment).join('');
}

function messageParts(root: Element) {
  let full = '';
  let words = '';
  let hasImage = false;
  const visit = (node: Node) => {
    if (node.nodeType === 3) {
      full += node.nodeValue ?? '';
      words += node.nodeValue ?? '';
      return;
    }
    if (node.nodeType !== 1) return;
    const element = node as Element;
    if (element.matches('[data-livechat-copilot], script, style, [hidden], [aria-hidden="true"]')) return;
    if (element.matches('img, [role="img"][aria-label]')) {
      hasImage = true;
      const label = (element.getAttribute('alt') ?? element.getAttribute('aria-label') ?? '').trim();
      full += ' ' + label.replace(/^:_?([^:\s]{1,120}):$/, '$1') + ' ';
      words += ' ';
      return;
    }
    if (element.localName === 'br') {
      full += ' ';
      words += ' ';
    }
    for (const child of element.childNodes) visit(child);
  };
  visit(root);
  const stripped = stripEmoji(words);
  const remaining = normalizeText(stripped);
  return {
    text: normalizeText(full), hasImage,
    withoutEmoji: (hasImage || stripped !== words) && !/[\p{L}\p{N}]/u.test(remaining) ? '' : remaining,
  };
}

export function messageText(root: Element) {
  return messageParts(root).text;
}

export function extractRow(node: Element, rule: ChatRule): DOMMessage | undefined {
  if (matches(node, rule.ignore) || node.closest('[data-livechat-copilot]')) return;
  const body = rule.body ? query(node, rule.body) : node;
  if (!body) return;
  const { text, withoutEmoji, hasImage } = messageParts(body);
  if (text || hasImage) return { node, body, text, withoutEmoji };
}

export function testRule(root: ParentNode, rule: ChatRule, container?: Element | null): RuleTest | undefined {
  const region = container ?? query(root, rule.container);
  if (!region) return;
  const rows = queryAll(region, rule.message).slice(-30);
  const eligible = rows.filter(row => !matches(row, rule.ignore));
  const messages = eligible.map(row => extractRow(row, rule)).filter(row => row !== undefined);
  return { container: region, messages, rejected: eligible.length >= 2 && messages.length / eligible.length < 0.5 };
}

export function invalidateSelector(rule: ChatRule) {
  try {
    for (const selector of [rule.container, rule.message, rule.body, rule.ignore, rule.composer, rule.sendButton]) {
      if (selector) document.createDocumentFragment().querySelector(selector);
    }
    return false;
  } catch {
    return true;
  }
}

export function stableSelector(node: Element) {
  const tag = node.localName;
  for (const attr of ['data-a-target', 'data-test-selector', 'data-testid', 'data-role', 'role']) {
    const value = node.getAttribute(attr);
    if (value && /^[\w.-]{1,64}$/.test(value)) return tag + '[' + attr + '="' + value + '"]';
  }
  const name = (node.getAttribute('class') ?? '').split(/\s+/).find(part =>
    /^(?:[a-z-]+[-_])?(?:chat|message|comment|text|body|content|line|row|entry|item)(?:[-_][a-z-]+)?$/i.test(part));
  return name ? tag + '.' + CSS.escape(name) : tag;
}

export function selectorPath(root: ParentNode, node: Element) {
  const parts: string[] = [];
  for (let current: Element | null = node; current && current !== root; current = current.parentElement) {
    if (current.id) {
      const id = '#' + CSS.escape(current.id);
      const selector = [id, ...parts].join(' > ');
      const found = queryAll(root, selector);
      if (found.length === 1 && found[0] === node) return selector;
    }
    let part = stableSelector(current);
    const siblings = current.parentElement ? Array.from(current.parentElement.children) : [];
    if (siblings.filter(sibling => matches(sibling, part)).length > 1) {
      const index = siblings.filter(sibling => sibling.localName === current?.localName).indexOf(current);
      part = current.localName + ':nth-of-type(' + (index + 1) + ')';
    }
    parts.unshift(part);
    const selector = parts.join(' > ');
    const found = queryAll(root, selector);
    if (found.length === 1 && found[0] === node) return selector;
    if (parts.length >= 9) break;
  }
  return undefined;
}
