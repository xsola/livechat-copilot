import { analysisContext, type AgentContext } from '../context';
import type { ModelSettings } from '../../models/prompts';
import type { createTasks } from '../../models/tasks';
import type { AssistantTaskResult } from '../../platform/assistant';

export async function analyzeChat(
  tasks: Pick<ReturnType<typeof createTasks>, 'analyze'>, settings: ModelSettings, context: AgentContext,
  question: string,
): Promise<AssistantTaskResult> {
  const { from, to, ...sample } = analysisContext(context);
  const messageCount = sample.messages.length;
  if (messageCount < 5) throw new Error('notEnoughChat');
  const analysis = await tasks.analyze(settings, sample, question);
  return { kind: 'analysis', analysis, excerpts: sample.messages.map(item => item.text), messageCount, from, to };
}
