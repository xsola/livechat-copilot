import type { AgentContext } from '../../agent/context';
import type { AssistantOperation, AssistantPageInfo, ComposerBinding, ComposerState } from '../../platform/assistant';
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

  constructor(
    private readonly language: RoomLanguage, private readonly current: () => boolean,
    private readonly activeChat: () => ChatSession | undefined,
  ) {}

  async handle(operation: AssistantOperation) {
    if ('pageToken' in operation && operation.pageToken !== this.pageToken) return { kind: 'conflict' };
    const room = this.language.context();
    if (operation.action === 'context') {
      const messages = this.activeChat()?.context().messages ?? [];
      return { kind: 'context', context: { room, messages } satisfies AgentContext, roomKey: room.key, pageToken: this.pageToken };
    }
    if (operation.action === 'inspect' || operation.action === 'readDraft') {
      const [binding] = await Promise.all([send('getComposer', room.key), this.language.read()]);
      if (!this.current()) return { kind: 'conflict' };
      this.binding = binding ?? undefined;
    }
    if (operation.action === 'setLanguage') {
      await this.language.set(operation.language);
      if (!this.current()) return { kind: 'conflict' };
    }
    if (operation.action === 'pick') {
      this.picker.pick(selector => {
        if (!this.current()) return;
        const binding = { selector, path: location.pathname };
        void send('saveComposer', { key: room.key, binding }).then(() => {
          if (!this.current()) return;
          this.binding = binding;
          this.editor.close();
          this.picker.highlight(this.locate().editor);
          this.notify('saved');
        }).catch(() => this.notify('failed'));
      }, () => this.notify('cancelled'));
      return { kind: 'picked' };
    }
    if (operation.action === 'cancelPick') this.picker.close();
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
        composer, messageCount: this.activeChat()?.context().messages.length ?? 0,
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

  private notify(status: 'saved' | 'cancelled' | 'failed') {
    if (this.current()) void chrome.runtime.sendMessage({ composerPicked: status, pageToken: this.pageToken }).catch(() => undefined);
  }
}
