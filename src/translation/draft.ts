import type { ModelSettings } from '../models/prompts';
import type { createTasks } from '../models/tasks';

export async function translateDraft(
  provider: Pick<ReturnType<typeof createTasks>, 'translateComposer'>,
  settings: ModelSettings, text: string, language: string,
) {
  return provider.translateComposer(settings, text, language);
}
