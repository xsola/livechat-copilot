import { extractRow, type DOMMessage, type RuleTest } from './dom';
import { observeChat } from './observer';
import { Renderer } from './renderer';
import { PageMeter } from '../usage/page-meter';
import { backgroundTranslator } from '../translation/provider';
import { Scheduler } from '../translation/scheduler';
import type { PageSettings } from '../platform/config';
import type { RuleMatch } from '../rules/schema';
import { RoomLanguage } from '../rooms/language';

interface ChatMessage {
  id: string;
  observedAt: number;
  text: string;
}

interface Row extends ChatMessage { dom: DOMMessage }

function isVisible(node: Element, container: Element) {
  const bounds = node.getBoundingClientRect();
  if (!bounds.width || !bounds.height || bounds.bottom <= 0 || bounds.top >= innerHeight ||
    bounds.right <= 0 || bounds.left >= innerWidth) return false;
  for (let parent = node.parentElement; parent && container.contains(parent); parent = parent.parentElement) {
    const overflow = getComputedStyle(parent).overflowY;
    if (['hidden', 'auto', 'scroll', 'clip'].includes(overflow)) {
      const region = parent.getBoundingClientRect();
      if (bounds.bottom <= region.top || bounds.top >= region.bottom) return false;
    }
  }
  return true;
}

export class ChatSession {
  private readonly stamp = crypto.randomUUID();
  private readonly rows = new WeakMap<Element, Row>();
  private readonly recent: ChatMessage[] = [];
  private readonly renderer = new Renderer();
  private readonly scheduler?: Scheduler;
  private readonly stop: () => void;
  private sequence = 0;
  private closed = false;

  constructor(
    readonly match: RuleMatch,
    readonly container: Element,
    settings: PageSettings,
    private readonly language: RoomLanguage,
    private readonly meter: PageMeter,
    private readonly error: (message: string) => void,
    seed: RuleTest['messages'],
    private readonly isCurrent: () => boolean,
  ) {
    if (settings.enabled && settings.modelConfigured) {
      this.scheduler = new Scheduler(backgroundTranslator(settings.revision), settings.mode,
        counter => this.meter.count(counter), error);
    }
    this.stop = observeChat(container, match.rule,
      rows => this.ingest(rows, settings.mode), row => {
        this.rows.delete(row);
        this.renderer.remove(row);
      });
    this.ingest(seed.slice(-20), settings.mode);
  }

  private ingest(messages: DOMMessage[], mode: PageSettings['mode']) {
    for (const dom of messages) {
      const previous = this.rows.get(dom.node);
      if (previous?.text === dom.text && previous.dom.body === dom.body) continue;
      this.renderer.remove(dom.node);
      const row: Row = { id: this.stamp + '-' + ++this.sequence, dom, text: dom.text, observedAt: Date.now() };
      this.rows.set(dom.node, row);
      this.recent.push({ id: row.id, text: row.text, observedAt: row.observedAt });
      if (this.recent.length > 120) this.recent.shift();
      if (!this.scheduler) continue;
      if (mode === 'manual') this.renderer.action(dom, () => this.submit(row, true));
      else this.submit(row);
    }
    if (this.scheduler && this.recent.length >= 12) {
      const cutoff = Date.now() - 120_000;
      this.language.maybeIdentify(this.recent.filter(message => message.observedAt >= cutoff).map(message => message.text));
    }
  }

  private submit(row: Row, manual = false) {
    const { dom } = row;
    const available = () => {
      const latest = extractRow(dom.node, this.match.rule);
      return !this.closed && this.isCurrent() && dom.node.isConnected && this.container.contains(dom.node) &&
        this.rows.get(dom.node) === row && latest?.body === dom.body && latest.text === row.text;
    };
    this.scheduler?.add({
      id: row.id, text: row.text, available, manual,
      visible: () => isVisible(dom.node, this.container),
      accept: text => {
        if (!available()) return;
        this.renderer.show(dom, text);
        this.meter.count('rendered');
        this.error('');
      },
    });
  }

  context() {
    const cutoff = Date.now() - 120_000;
    return { room: this.language.context(), messages: this.recent.filter(item => item.observedAt >= cutoff) };
  }

  close() {
    this.closed = true;
    this.stop();
    this.scheduler?.close();
    this.renderer.clear();
  }
}
