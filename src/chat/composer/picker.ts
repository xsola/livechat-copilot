import { selectorPath } from '../dom';
import { editableSelector, permittedEditor, type Editor } from './locate';

export class ComposerPicker {
  private cleanup?: () => void;

  highlight(editor?: Editor, duration = 0) {
    this.close();
    if (!editor) return;
    editor.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const overlay = this.outline();
    const update = () => this.position(overlay, editor);
    update();
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    const timer = window.setTimeout(() => this.close(), duration || 4500);
    this.cleanup = () => {
      clearTimeout(timer);
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
      overlay.remove();
    };
  }

  pick(onPick: (selector: string) => void, onCancel: () => void) {
    this.close();
    const overlay = this.outline();
    const controller = new AbortController();
    const { signal } = controller;
    const options = { signal, capture: true };
    const find = (target: EventTarget | null) => {
      const node = target instanceof Element ? target.closest(editableSelector) : null;
      return permittedEditor(node) ? node : undefined;
    };
    document.addEventListener('pointerover', event => this.position(overlay, find(event.target)), options);
    document.addEventListener('click', event => {
      const editor = find(event.target);
      if (!editor) return;
      const selector = selectorPath(document, editor);
      if (!selector || selector.length > 500) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      this.close();
      onPick(selector);
    }, options);
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      this.close();
      onCancel();
    };
    document.addEventListener('keydown', escape, options);
    if (window !== window.top) window.top?.document.addEventListener('keydown', escape, options);
    const timer = window.setTimeout(() => { this.close(); onCancel(); }, 45_000);
    this.cleanup = () => { clearTimeout(timer); controller.abort(); overlay.remove(); };
  }

  close() {
    this.cleanup?.();
    this.cleanup = undefined;
  }

  private outline() {
    const overlay = document.createElement('div');
    overlay.dataset.livechatCopilot = 'composer';
    overlay.setAttribute('aria-hidden', 'true');
    Object.assign(overlay.style, {
      position: 'fixed', zIndex: '2147483647', pointerEvents: 'none', display: 'none', boxSizing: 'border-box',
      border: '3px solid #2563eb', borderRadius: '4px', background: 'rgba(37, 99, 235, .17)',
    });
    document.documentElement.append(overlay);
    return overlay;
  }

  private position(overlay: HTMLElement, editor?: Editor) {
    if (!editor?.isConnected) { overlay.style.display = 'none'; return; }
    const box = editor.getBoundingClientRect();
    Object.assign(overlay.style, {
      display: 'block', left: box.left + 'px', top: box.top + 'px',
      width: box.width + 'px', height: box.height + 'px',
    });
  }
}
