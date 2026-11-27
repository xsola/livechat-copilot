import type { ChatRule } from '../../rules/schema';
import type { ComposerBinding, ComposerState } from '../../platform/assistant';
import { insidePlayer, rankComposers } from '../detection/candidates';
import { queryAll } from '../dom';

export const editableSelector = 'textarea, input[type="text"], input:not([type]), [contenteditable="true"], [contenteditable="plaintext-only"]';
export type Editor = HTMLInputElement | HTMLTextAreaElement | HTMLElement;

export function permittedEditor(element: Element | null): element is Editor {
  return element instanceof HTMLElement && element.matches(editableSelector) &&
    !element.closest('[data-livechat-copilot], [role="search"], header, nav, [hidden]') &&
    !insidePlayer(element) && Boolean(element.getClientRects().length) &&
    getComputedStyle(element).visibility === 'visible';
}

export function canWrite(element: Editor) {
  return element.isConnected && permittedEditor(element) &&
    !element.closest('[inert], [aria-disabled="true"], [aria-readonly="true"]') &&
    !element.matches(':disabled, [readonly]') &&
    (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element.isContentEditable);
}

function fromSelector(selector: string) {
  const elements = new Set<Editor>();
  for (const area of queryAll(document, selector)) {
    if (permittedEditor(area)) elements.add(area);
    else for (const element of queryAll(area, editableSelector)) {
      if (permittedEditor(element)) elements.add(element);
    }
  }
  return [...elements];
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
  if (binding?.path === location.pathname) return summarize(fromSelector(binding.selector), 'manual');
  if (rule?.composer) {
    const editors = fromSelector(rule.composer);
    if (editors.length) return summarize(editors, 'rule');
    const blocked = queryAll(document, rule.composer).find((element): element is HTMLElement => element instanceof HTMLElement &&
      Boolean(element.getClientRects().length) && getComputedStyle(element).visibility === 'visible' &&
      element.matches('[role="textbox"], [aria-disabled="true"]'));
    if (blocked) return { state: 'unavailable', source: 'rule', editor: blocked };
  }
  if (!region || !rule) return { state: 'missing' };
  const [first, second] = rankComposers(document, region, rule);
  if (!first?.corroborated || first.score < 8 || !first.rule.composer) return { state: 'missing' };
  if (second && first.score - second.score < 3) return { state: 'ambiguous' };
  return summarize(fromSelector(first.rule.composer), 'automatic');
}
