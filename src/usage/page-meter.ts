import { send } from '../platform/messages';
import type { PageCounter } from './usage';

export class PageMeter {
  private pending: Partial<Record<PageCounter, number>> = {};
  private timer?: ReturnType<typeof setTimeout>;

  count(counter: PageCounter, amount = 1) {
    this.pending[counter] = (this.pending[counter] ?? 0) + amount;
    this.timer ??= setTimeout(() => { void this.flush(); }, 1200);
  }

  async flush() {
    clearTimeout(this.timer);
    this.timer = undefined;
    const sample = this.pending;
    this.pending = {};
    if (Object.keys(sample).length) await send('usage', sample).catch(() => undefined);
  }
}
