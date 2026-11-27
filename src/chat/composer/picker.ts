import { queryAll, selectorPath } from '../dom';
import { canWrite, editorAt, type Editor } from './locate';
import type { ComposerPickStatus } from '../../platform/assistant';

export class ComposerPicker {
  private cleanup?: () => void;
  private candidate?: { editor: Editor; selector: string };
  private clearCandidate?: () => void;

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

  pick(onPick: (status: ComposerPickStatus) => void) {
    this.close();
    const overlay = this.outline();
    const controller = new AbortController();
    const { signal } = controller;
    const options = { signal, capture: true };
    let locked: Editor | undefined;
    let hovered: Editor | undefined;
    const update = () => this.position(overlay, locked ?? hovered);
    this.clearCandidate = () => {
      locked = undefined;
      hovered = undefined;
      this.candidate = undefined;
      update();
    };
    document.addEventListener('pointerover', event => {
      hovered = editorAt(event.composedPath());
      update();
    }, options);
    document.addEventListener('pointerout', event => {
      if (!event.relatedTarget) { hovered = undefined; update(); }
    }, options);
    window.addEventListener('scroll', update, options);
    window.addEventListener('resize', update, options);
    document.addEventListener('click', event => {
      const editor = editorAt(event.composedPath());
      const target = event.target;
      if (target instanceof Element && target.closest('[data-livechat-copilot]')) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      locked = editor;
      this.candidate = undefined;
      update();
      if (!editor) { onPick('no-editor'); return; }
      if (!canWrite(editor)) { onPick('unavailable'); return; }
      const selector = editor.getRootNode() === document ? selectorPath(document, editor) : undefined;
      if (!selector || selector.length > 500 || queryAll(document, selector).length !== 1) { onPick('unusable'); return; }
      this.candidate = { editor, selector };
      onPick('ready');
    }, options);
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      this.close();
      onPick('cancelled');
    };
    document.addEventListener('keydown', escape, options);
    if (window !== window.top) window.top?.document.addEventListener('keydown', escape, options);
    const timer = window.setTimeout(() => { this.close(); onPick('cancelled'); }, 60_000);
    this.cleanup = () => { clearTimeout(timer); controller.abort(); overlay.remove(); };
  }

  selected() {
    const candidate = this.candidate;
    if (!candidate || !canWrite(candidate.editor)) return;
    const matches = queryAll(document, candidate.selector);
    if (matches.length === 1 && matches[0] === candidate.editor) return candidate.selector;
  }

  unlock() {
    this.clearCandidate?.();
  }

  close() {
    this.cleanup?.();
    this.cleanup = undefined;
    this.candidate = undefined;
    this.clearCandidate = undefined;
  }

  private outline() {
    const overlay = document.createElement('div');
    overlay.dataset.livechatCopilot = 'composer';
    overlay.setAttribute('aria-hidden', 'true');
    Object.assign(overlay.style, {
      position: 'fixed', zIndex: '2147483647', pointerEvents: 'none', display: 'none', boxSizing: 'border-box',
      border: '3px solid #15803d', borderRadius: '4px', background: 'rgba(34, 197, 94, .23)',
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
