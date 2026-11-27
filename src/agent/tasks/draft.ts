import type { Settings } from '../../platform/config';
import type { createTasks } from '../../models/tasks';
import { draftContext, type AgentContext } from '../context';

export function generateDraft(
  tasks: Pick<ReturnType<typeof createTasks>, 'draft'>,
  settings: Settings,
  context: AgentContext,
  intent: string,
  override?: string,
  tone: 'casual' | 'polite' = 'casual',
) {
  const language = override ?? context.room.replyLanguage;
  if (!language) throw new Error('Choose a reply language for this room first.');
  const request = intent.trim();
  if (!request || request.length > 500) throw new Error('Enter a reply intent of up to 500 characters.');
  return tasks.draft(settings, draftContext(context), request, language, tone);
}
