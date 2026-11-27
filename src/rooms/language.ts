import { send } from '../platform/messages';
import type { RoomProfile } from '../models/tasks';
import type { RoomPreference } from '../platform/store';
import { roomMetadata } from './metadata';

export class RoomLanguage {
  private key?: string;
  private cached?: RoomPreference | null;
  private attempted = false;
  private nextAttempt = 0;
  private nextIdentityCheck = 0;
  private running?: Promise<void>;
  private resolvedProfile?: RoomProfile;

  constructor(private readonly page: URL, private readonly frame: URL) {}

  private identity() {
    const current = roomMetadata(this.page, this.frame);
    if (current.key !== this.key) {
      this.key = current.key;
      this.cached = undefined;
      this.attempted = false;
      this.nextAttempt = 0;
      this.resolvedProfile = undefined;
    }
    return current;
  }

  maybeIdentify(sample: string[]) {
    const now = Date.now();
    if (this.running || now < this.nextAttempt || now < this.nextIdentityCheck) return;
    this.nextIdentityCheck = now + 1200;
    const lines = [...new Set(sample.filter(text => /\p{L}/u.test(text)).map(text => text.slice(0, 180)))];
    if (lines.length < 12) return;
    const current = this.identity();
    if (this.attempted) return;
    this.running = this.identify(current, lines.slice(-32)).finally(() => { this.running = undefined; });
  }

  private async identify(current: ReturnType<typeof roomMetadata>, lines: string[]) {
    try {
      const existing = await send('getRoom', current.key);
      if (this.key !== current.key) return;
      if (existing) { this.cached = existing; this.attempted = true; return; }
      const { title, streamer, category } = current.profile;
      const { preference, profile } = await send('identifyRoom', {
        key: current.key,
        hints: {
          title: title ?? undefined, streamer: streamer ?? undefined,
          category: category ?? undefined, language: current.languageHint,
        },
        lines,
      });
      if (this.key !== current.key) return;
      this.cached = preference;
      this.resolvedProfile = profile;
      this.attempted = true;
    } catch {
      this.nextAttempt = Date.now() + 60_000;
    }
  }

  async read(): Promise<RoomPreference | null> {
    const { key } = this.identity();
    return this.cached = await send('getRoom', key);
  }

  async set(language: string | null) {
    const { key } = this.identity();
    this.cached = await send('setRoom', { key, language });
    this.attempted = Boolean(this.cached);
    this.nextAttempt = 0;
    return this.cached;
  }

  context() {
    const current = this.identity();
    const { title, streamer, category } = this.cached?.profile ?? this.resolvedProfile ?? {};
    return {
      key: current.key,
      hint: current.languageHint,
      title: current.profile.title ?? title ?? null,
      streamer: current.profile.streamer ?? streamer ?? null,
      category: current.profile.category ?? category ?? null,
      replyLanguage: this.cached?.language ?? null,
    };
  }
}
