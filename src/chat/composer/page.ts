import type { AgentContext } from '../../agent/context';
import type { AssistantOperation, AssistantPageInfo, ComposerBinding, ComposerPickStatus, ComposerState } from '../../platform/assistant';
import { send } from '../../platform/messages';
import { RoomLanguage } from '../../rooms/language';
import type { ChatSession } from '../session';
import { ComposerEditor } from './editor';
import { locateComposer } from './locate';
import { ComposerPicker } from './picker';

export class AssistantPage {
  private readonly pageToken = crypto.randomUUID();
  private readonly editor = new ComposerEditor();
  private readonly picker = new ComposerPicker();
  private binding?: ComposerBinding;
  private picking?: string;

  constructor(
    private readonly language: RoomLanguage, private readonly current: () => boolean,
    private readonly activeChat: () => ChatSession | undefined,
  ) {}

  async handle(operation: AssistantOperation) {
    if (!this.current()) return { kind: 'conflict' };
    if ('pageToken' in operation && operation.pageToken !== this.pageToken) return { kind: 'conflict' };
    const room = this.language.context();
    if (operation.action === 'context') {
      const messages = this.activeChat()?.context().messages ?? [];
      return { kind: 'context', context: { room, messages } satisfies AgentContext, roomKey: room.key, pageToken: this.pageToken };
    }
    if (operation.action === 'inspect' || operation.action === 'detect' || operation.action === 'readDraft') {
      const [binding] = await Promise.all([send('getComposer', room.key), this.language.read()]);
      if (!this.current()) return { kind: 'conflict' };
      this.binding = binding ?? undefined;
    }
    if (operation.action === 'setLanguage') {
      await this.language.set(operation.language);
      if (!this.current()) return { kind: 'conflict' };
    }
    if (operation.action === 'pick') {
      const selection = this.picking = operation.selection;
      this.picker.pick(status => this.notify(status, selection));
      return { kind: 'picked' };
    }
    if (operation.action === 'unlockPick' && this.picking === operation.selection) {
      this.picker.unlock();
      return { kind: 'picked' };
    }
    if (operation.action === 'cancelPick') {
      if (this.picking === operation.selection) {
        this.picker.close();
        this.picking = undefined;
      }
      return { kind: 'picked' };
    }
    if (operation.action === 'confirmPick') {
      const selector = this.picker.selected();
      if (!selector || this.picking !== operation.selection) return { kind: 'conflict' };
      const binding = { selector, path: location.pathname };
      await send('saveComposer', { key: room.key, binding });
      if (!this.current()) return { kind: 'conflict' };
      this.picker.close();
      this.picking = undefined;
      this.binding = binding;
      this.editor.close();
      this.picker.highlight(this.locate().editor);
    }
    if (operation.action === 'resetComposer') {
      await send('saveComposer', { key: room.key, binding: null });
      if (!this.current()) return { kind: 'conflict' };
      this.binding = undefined;
      this.picker.close();
      this.editor.close();
    }

    const target = this.locate();
    if (operation.action === 'highlight') this.picker.highlight(target.editor);
    if (operation.action === 'apply' || operation.action === 'undo') {
      if (target.state !== 'ready' || !target.editor || !this.current()) return { kind: 'conflict' };
      const changed = operation.action === 'apply'
        ? this.editor.apply(target.editor, operation.ticket, operation.text)
        : this.editor.restore(target.editor, operation.ticket);
      if (!changed) return { kind: 'conflict' };
    }
    const composer: ComposerState = { state: target.state, source: target.source };
    if (target.state === 'ready' && target.editor) {
      Object.assign(composer, this.editor.inspect(target.editor, operation.action === 'readDraft'));
    } else this.editor.close();
    return {
      kind: 'page',
      page: {
        pageToken: this.pageToken, host: location.hostname, room: this.language.context(),
        composer, messageCount: this.activeChat()?.context().messages.length ?? 0, hasChat: Boolean(this.activeChat()),
        undoTicket: this.editor.undoTicket(target.editor),
      } satisfies AssistantPageInfo,
    };
  }

  close() {
    this.picker.close();
    this.editor.close();
  }

  private locate() {
    const chat = this.activeChat();
    return locateComposer(this.binding, chat?.container, chat?.match.rule);
  }

  private notify(status: ComposerPickStatus, selection: string) {
    if (this.current()) void chrome.runtime.sendMessage({ composerPicked: status, pageToken: this.pageToken, selection }).catch(() => undefined);
  }
}
