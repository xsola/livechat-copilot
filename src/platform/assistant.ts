import { z } from 'zod';
import { languageCode } from './config';
import type { AgentContext } from '../agent/context';
import type { ChatAnalysis, ReplyDraft } from '../models/tasks';

const token = z.string().uuid();
const tab = z.object({ tabId: z.number().int().nonnegative() });
const boundTab = tab.extend({ frameId: z.number().int().nonnegative(), pageToken: token });
const bound = z.object({ pageToken: token });
const ticket = z.object({ ticket: token });
const text = z.string().min(1).max(3000).refine(value => Boolean(value.trim()));
export const analysisModes = ['topics', 'sentiment', 'question'] as const;
export const composerBinding = z.object({ path: z.string().max(500), selector: z.string().min(1).max(500) });
export type ComposerBinding = z.infer<typeof composerBinding>;

export const assistantOperation = z.discriminatedUnion('action', [
  z.object({ action: z.literal('inspect') }),
  bound.extend({ action: z.literal('context') }),
  bound.extend({ action: z.literal('readDraft') }),
  bound.extend({ action: z.literal('highlight') }),
  bound.extend({ action: z.literal('pick') }),
  bound.extend({ action: z.literal('cancelPick') }),
  bound.extend({ action: z.literal('resetComposer') }),
  bound.extend({ action: z.literal('setLanguage'), language: languageCode }),
  bound.extend({ action: z.literal('apply'), ...ticket.shape, text }),
  bound.extend({ action: z.literal('undo'), ...ticket.shape }),
]);
export type AssistantOperation = z.infer<typeof assistantOperation>;
export const assistantPage = tab.extend({ frameId: z.number().int().nonnegative().optional(), operation: assistantOperation });

export const assistantTask = z.discriminatedUnion('task', [
  boundTab.extend({ task: z.literal('translate'), text: text.max(600), language: languageCode }),
  boundTab.extend({ task: z.literal('draft'), text: text.max(500), language: languageCode, tone: z.enum(['casual', 'polite']) }),
  boundTab.extend({ task: z.literal('analysis'), mode: z.enum(analysisModes), question: z.string().trim().max(500) }),
  boundTab.extend({ task: z.literal('inferLanguage') }),
  tab.extend({ task: z.literal('resolveLanguage'), text: z.string().trim().min(1).max(80) }),
]);
export type AssistantTask = z.infer<typeof assistantTask>;

export interface ComposerState {
  state: 'missing' | 'unavailable' | 'ambiguous' | 'ready';
  ticket?: string;
  hasDraft?: boolean;
  draftLength?: number;
  draft?: string;
  source?: 'rule' | 'automatic' | 'manual';
}

export interface AssistantPageInfo {
  pageToken: string;
  host: string;
  room: AgentContext['room'];
  messageCount: number;
  composer: ComposerState;
  undoTicket?: string;
}

export type AssistantPageResult =
  | { kind: 'page'; frameId: number; page: AssistantPageInfo }
  | { kind: 'permission'; origin: string }
  | { kind: 'missing' }
  | { kind: 'picked' }
  | { kind: 'conflict' };

export type AssistantTaskResult =
  | { kind: 'translate'; translation: string }
  | { kind: 'draft'; draft: ReplyDraft; messageCount: number }
  | { kind: 'analysis'; analysis: ChatAnalysis; excerpts: string[]; messageCount: number; from: number; to: number }
  | { kind: 'language'; language: string | null };
