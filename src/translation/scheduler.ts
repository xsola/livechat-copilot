import type { TranslateBatch } from './provider';

export interface TranslationJob {
  id: string;
  text: string;
  available: () => boolean;
  visible: () => boolean;
  accept: (text: string) => void;
  manual?: boolean;
}

type Pending = TranslationJob & { queuedAt: number };
type Count = (event: 'expired' | 'cached') => void;
const ttl = 10_000;
const limit = 100;
const batchDelay = 650;
const maxBatch = 12;

export class Scheduler {
  private pending = new Map<string, Pending>();
  private cache = new Map<string, string>();
  private active = new Set<string>();
  private timer?: ReturnType<typeof setTimeout>;
  private inFlight = 0;
  private closed = false;

  constructor(
    private readonly translate: TranslateBatch,
    private readonly mode: 'batch' | 'single' | 'manual',
    private readonly count: Count,
    private readonly error: (message: string) => void,
  ) {}

  add(job: TranslationJob) {
    if (this.closed || this.active.has(job.id) || this.pending.has(job.id)) return;
    const text = this.cache.get(job.text);
    if (text !== undefined) {
      this.cache.delete(job.text);
      this.cache.set(job.text, text);
      this.count('cached');
      job.accept(text);
      return;
    }
    this.pending.set(job.id, { ...job, queuedAt: Date.now() });
    if (this.pending.size > limit) {
      const discard = [...this.pending.values()].find(item => !item.manual && !item.visible()) ?? this.pending.values().next().value;
      if (discard) this.pending.delete(discard.id);
      this.count('expired');
    }
    this.schedule();
  }

  private schedule() {
    if (this.closed || !this.pending.size || this.inFlight >= 2) return;
    const first = this.pending.values().next().value!;
    const wait = this.mode === 'batch' && this.pending.size < maxBatch && !first.manual
      ? Math.max(0, batchDelay - (Date.now() - first.queuedAt))
      : 0;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { void this.flush(); }, wait);
  }

  private async flush() {
    if (this.closed || this.inFlight >= 2) return;
    const now = Date.now();
    for (const item of this.pending.values()) {
      if (!item.available() || now - item.queuedAt >= ttl) {
        this.pending.delete(item.id);
        this.count('expired');
      }
    }
    const ready = [...this.pending.values()].sort((a, b) =>
      Number(Boolean(b.manual)) - Number(Boolean(a.manual)) || Number(b.visible()) - Number(a.visible()));
    const batch: Pending[] = [];
    let chars = 0;
    const max = this.mode === 'batch' ? maxBatch : 1;
    for (const item of ready) {
      if (batch.length >= max || chars + item.text.length > 2200) break;
      chars += item.text.length;
      batch.push(item);
    }
    if (!batch.length) return;
    for (const item of batch) {
      this.pending.delete(item.id);
      this.active.add(item.id);
    }
    this.inFlight++;
    this.schedule();
    try {
      const byText = Map.groupBy(batch, item => item.text);
      const representatives = [...byText.values()].map(([first]) => ({ id: first!.id, text: first!.text }));
      const results = new Map((await this.translate(representatives)).map(item => [item.id, item.text]));
      if (this.closed) return;
      for (const group of byText.values()) {
        const first = group[0]!;
        const translated = results.get(first.id);
        if (!translated) continue;
        this.cache.set(first.text, translated);
        if (this.cache.size > 200) this.cache.delete(this.cache.keys().next().value!);
        for (const [index, item] of group.entries()) {
          if (item.available() && Date.now() - item.queuedAt < ttl) {
            if (index > 0) this.count('cached');
            item.accept(translated);
          } else {
            this.count('expired');
          }
        }
      }
    } catch (error) {
      if (!this.closed) this.error(error instanceof Error ? error.message : 'Translation failed.');
    } finally {
      this.inFlight--;
      for (const item of batch) this.active.delete(item.id);
      this.schedule();
    }
  }

  close() {
    this.closed = true;
    clearTimeout(this.timer);
    this.pending.clear();
    this.cache.clear();
    this.active.clear();
  }
}
