import { extractRow, matches, queryAll, type DOMMessage } from './dom';
import type { ChatRule } from '../rules/schema';

function onlyOwnMutation(record: MutationRecord) {
  const element = record.target.nodeType === 1 ? record.target as Element : record.target.parentElement;
  if (element?.closest('[data-livechat-copilot]')) return true;
  const changed = [...record.addedNodes, ...record.removedNodes];
  return changed.length > 0 && changed.every(node =>
    node.nodeType === 1 && (node as Element).hasAttribute('data-livechat-copilot'));
}

export function observeChat(
  container: Element, rule: ChatRule, onRows: (rows: DOMMessage[]) => void, invalid: (row: Element) => void,
) {
  const current = new Set(queryAll(container, rule.message));
  const observer = new MutationObserver(records => {
    const changed = new Set<Element>();
    for (const record of records) {
      if (onlyOwnMutation(record)) continue;
      let node = record.target.nodeType === 1 ? record.target as Element : record.target.parentElement;
      while (node && node !== container) {
        if (current.has(node) || matches(node, rule.message.replace(/^:scope\s*>\s*/, ''))) changed.add(node);
        node = node.parentElement;
      }
      for (const added of record.addedNodes) {
        if (added.nodeType !== 1) continue;
        const element = added as Element;
        if (matches(element, rule.message.replace(/^:scope\s*>\s*/, ''))) changed.add(element);
        if (!rule.message.startsWith(':scope > ')) {
          for (const row of queryAll(element, rule.message)) changed.add(row);
        }
      }
      for (const removed of record.removedNodes) {
        if (removed.nodeType !== 1) continue;
        const element = removed as Element;
        if (current.has(element)) {
          current.delete(element);
          invalid(element);
        }
        for (const row of current) if (element.contains(row)) {
          current.delete(row);
          invalid(row);
        }
      }
    }
    const output: DOMMessage[] = [];
    for (const row of changed) {
      if (!container.contains(row) || (rule.message.startsWith(':scope > ') && row.parentElement !== container)) continue;
      const result = extractRow(row, rule);
      if (result) {
        current.add(row);
        output.push(result);
      } else {
        current.delete(row);
        invalid(row);
      }
    }
    if (output.length) onRows(output);
  });
  observer.observe(container, {
    childList: true, subtree: true, characterData: true,
    attributeFilter: ['id', 'class', 'data-testid', 'hidden', 'aria-hidden'],
  });
  return () => observer.disconnect();
}
