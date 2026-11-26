import { send } from '../platform/messages';
import type { TranslationItem } from '../models/tasks';

export type TranslateBatch = (items: TranslationItem[]) => Promise<TranslationItem[]>;

export function backgroundTranslator(revision: number): TranslateBatch {
  return items => send('translate', { revision, items });
}
