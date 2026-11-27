import type { ComposerState } from '../../platform/assistant';
import { canWrite, type Editor } from './locate';

function textField(editor: Editor): editor is HTMLInputElement | HTMLTextAreaElement {
  return editor instanceof HTMLInputElement || editor instanceof HTMLTextAreaElement;
}

function read(editor: Editor) {
  return textField(editor) ? editor.value : editor.textContent ? editor.innerText : '';
}

function plainEditor(editor: Editor) {
  return textField(editor) || !editor.querySelector('img, video, svg, a, button, [contenteditable="false"]');
}

function write(editor: Editor, value: string, expected: string) {
  if (!canWrite(editor) || !plainEditor(editor)) return false;
  if (textField(editor)) {
    if (editor.maxLength >= 0 && value.length > editor.maxLength ||
      editor instanceof HTMLInputElement && /[\r\n]/.test(value)) return false;
    const prototype = editor instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const set = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
    if (!set) return false;
    editor.focus({ preventScroll: true });
    if (!canWrite(editor) || read(editor) !== expected) return false;
    set.call(editor, value);
    editor.setSelectionRange(value.length, value.length);
    editor.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertReplacementText', data: value }));
    return read(editor) === value;
  }
  editor.focus({ preventScroll: true });
  if (!canWrite(editor) || !plainEditor(editor) || read(editor) !== expected) return false;
  const selection = editor.ownerDocument.getSelection();
  if (!selection) return false;
  const range = editor.ownerDocument.createRange();
  range.selectNodeContents(editor);
  selection.removeAllRanges();
  selection.addRange(range);
  // Use Chromium's editing command so the site's editor receives normal editing events.
  editor.ownerDocument.execCommand(value ? 'insertText' : 'delete', false, value);
  return read(editor) === value;
}

export class ComposerEditor {
  private watched?: Editor;
  private snapshot?: { ticket: string; text: string };
  private undo?: { ticket: string; before: string; after: string };
  private composing = false;
  private writing = false;
  private events?: AbortController;

  inspect(editor: Editor, includeDraft: boolean): Partial<ComposerState> {
    this.watch(editor);
    if (this.composing || !plainEditor(editor)) return { state: 'unavailable' };
    const text = read(editor);
    if (text.length > 3000) return { state: 'unavailable' };
    if (this.undo && this.undo.after !== text) this.undo = undefined;
    if (this.snapshot?.text !== text) this.snapshot = { ticket: crypto.randomUUID(), text };
    return {
      ticket: this.snapshot.ticket, hasDraft: Boolean(text.trim()), draftLength: text.length,
      draft: includeDraft ? text : undefined,
    };
  }

  apply(editor: Editor, ticket: string, text: string) {
    const snapshot = this.snapshot;
    if (this.watched !== editor || snapshot?.ticket !== ticket || snapshot.text !== read(editor) || this.composing) return false;
    if (text === snapshot.text) return false;
    if (!this.replace(editor, text, snapshot.text)) return false;
    this.undo = { ticket: crypto.randomUUID(), before: snapshot.text, after: text };
    return true;
  }

  restore(editor: Editor, ticket: string) {
    const undo = this.undo;
    if (this.watched !== editor || undo?.ticket !== ticket || undo.after !== read(editor) || this.composing) return false;
    if (!this.replace(editor, undo.before, undo.after)) return false;
    this.undo = undefined;
    return true;
  }

  undoTicket(editor?: Editor) {
    return editor === this.watched && !this.composing ? this.undo?.ticket : undefined;
  }

  close() {
    this.events?.abort();
    this.watched = undefined;
    this.snapshot = undefined;
    this.undo = undefined;
    this.composing = false;
  }

  private watch(editor: Editor) {
    if (editor === this.watched) return;
    this.close();
    this.watched = editor;
    const { signal } = this.events = new AbortController();
    const invalidate = () => {
      if (this.writing) return;
      this.snapshot = undefined;
      this.undo = undefined;
    };
    editor.addEventListener('input', invalidate, { capture: true, signal });
    editor.addEventListener('compositionstart', () => { this.composing = true; invalidate(); }, { signal });
    editor.addEventListener('compositionend', () => { this.composing = false; invalidate(); }, { signal });
  }

  private replace(editor: Editor, value: string, expected: string) {
    this.writing = true;
    try {
      return write(editor, value, expected);
    } finally {
      this.writing = false;
      this.snapshot = undefined;
    }
  }
}
