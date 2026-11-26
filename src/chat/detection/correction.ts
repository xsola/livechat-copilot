import type { ChatRule } from '../../rules/schema';
import { extractRow, messageTail, queryAll, selectorPath, stableSelector, testRule } from '../dom';
import type { Candidate } from './candidates';

function selectors(root: ParentNode, element: Element) {
  return [...new Set([
    ...Array.from(element.classList, name => element.localName + '.' + CSS.escape(name)),
    stableSelector(element), selectorPath(root, element),
  ].filter((selector): selector is string => Boolean(selector && selector.length <= 500)))];
}

export function correctionRows(first: Element, target: Element) {
  const list = first.parentElement;
  if (!list || list === first.ownerDocument.body) return;
  let second: Element | null = target;
  while (second && second.parentElement !== list) second = second.parentElement;
  if (!second || second === first) return;
  const selector = selectors(list, first).find(selector => second.matches(selector));
  if (!selector || selector.length + ':scope > '.length > 500 || first.localName !== second.localName) return;
  return { first, second, list, message: ':scope > ' + selector };
}

export function correctionCandidates(rows: NonNullable<ReturnType<typeof correctionRows>>, body: Element, author: Element | undefined,
  page: URL, frame: URL): Candidate[] {
  const { first, second, list, message } = rows;
  if (!first.isConnected || !second.isConnected || first.parentElement !== list || second.parentElement !== list || !first.contains(body)) return [];
  const container = selectorPath(first.ownerDocument, list);
  if (!container || container.length > 500) return [];
  const base: ChatRule = {
    schemaVersion: 1, id: 'candidate', version: 1, host: page.hostname,
    pathPrefix: ('/' + page.pathname.split('/')[1]).slice(0, 250),
    framePathPrefix: page.pathname === frame.pathname ? undefined : frame.pathname.slice(0, 250),
    container, message,
  };
  const samples = queryAll(list, message).slice(-20);
  const minimum = Math.max(2, Math.ceil(samples.length * 0.75));
  const unique = (row: Element, selector: string) => {
    const [element, extra] = queryAll(row, selector);
    return !extra ? element : undefined;
  };
  const anchor = author && selectors(first, author).find(selector => unique(first, selector) === author &&
    unique(second, selector) && samples.filter(row => unique(row, selector)).length >= minimum);
  if (author && !anchor) return [];
  const candidates: Candidate[] = [];
  function add(rule: ChatRule) {
    const parsed = testRule(first.ownerDocument, rule, list);
    if (!parsed || parsed.rejected || parsed.messages.length < minimum || !extractRow(first, rule) || !extractRow(second, rule)) return;
    const signature = JSON.stringify(parsed.messages.map(message => message.text));
    if (candidates.some(candidate => JSON.stringify(candidate.messages.map(message => message.text)) === signature)) return;
    candidates.push({ ...parsed, rule, score: 20, userMarking: { bodyTag: body.localName, authorTag: author?.localName } });
  }

  if (body !== first) {
    for (const selector of selectors(first, body)) {
      if (unique(first, selector) !== body || !unique(second, selector)) continue;
      if (samples.filter(row => {
        const content = unique(row, selector);
        const name = anchor && unique(row, anchor);
        return content && (!name || (!content.contains(name) && !name.contains(content)));
      }).length < minimum) continue;
      add({ ...base, body: selector });
      if (candidates.length) break;
    }
  }
  if (anchor) {
    const tails = samples.map(row => messageTail(row, anchor)).filter(tail => tail !== undefined);
    const firstTail = messageTail(first, anchor);
    if (tails.length >= minimum && firstTail && (body === first || firstTail.nodes.some(node => node.contains(body)))) {
      const mark = firstTail.text[0];
      const separator = (mark === ':' || mark === '：') && tails.every(tail => tail.text.startsWith(mark)) ? mark : undefined;
      const rule: ChatRule = { ...base, bodyAfter: { anchor, separator } };
      const selected = body === first ? undefined : selectorPath(first, body);
      const expected = selected && extractRow(first, { ...base, body: selected })?.text;
      if (body === first || (expected && extractRow(first, rule)?.text === expected)) add(rule);
    }
  }
  return candidates;
}
