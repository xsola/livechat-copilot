import type { DOMMessage } from './dom';

export class Renderer {
  private readonly annotations = new Map<Element, HTMLElement>();

  private display(message: DOMMessage, text: string, action?: () => void) {
    this.remove(message.node);
    if (!message.body.isConnected) return;
    const annotation = message.body.ownerDocument.createElement(action ? 'button' : 'span');
    annotation.setAttribute('data-livechat-copilot', '');
    annotation.setAttribute('data-lcc-kind', action ? 'action' : 'translation');
    annotation.textContent = text;
    annotation.style.cssText = action
      ? 'font:inherit;font-size:.85em;color:#175ab8;background:#edf4ff;border:1px solid #aec7e9;border-radius:4px;padding:0 4px;margin-left:.4em;cursor:pointer'
      : 'display:block;color:inherit;font:inherit;font-size:.92em;opacity:.82;white-space:pre-wrap;overflow-wrap:anywhere';
    if (annotation instanceof HTMLButtonElement) annotation.type = 'button';
    if (action) annotation.addEventListener('click', event => {
      if (!event.isTrusted) return;
      event.preventDefault();
      event.stopPropagation();
      action();
    });
    if (message.body === message.node) message.body.append(annotation);
    else message.body.after(annotation);
    this.annotations.set(message.node, annotation);
  }

  show(message: DOMMessage, text: string) {
    this.display(message, text);
  }

  action(message: DOMMessage, run: () => void) {
    this.display(message, '翻译', run);
  }

  remove(row: Element) {
    this.annotations.get(row)?.remove();
    this.annotations.delete(row);
  }

  clear() {
    for (const node of this.annotations.values()) node.remove();
    this.annotations.clear();
  }
}
