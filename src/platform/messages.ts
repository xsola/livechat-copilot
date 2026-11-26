import { z } from 'zod';
import { languageCode, modelConfig, settingsSchema, type PageSettings, type Settings } from './config';
import { chatRule, type ChatRule, type RuleMatch } from '../rules/schema';
import { pageCounter, type DailyUsage } from '../usage/usage';
import type { RoomPreference } from './store';
import type { ChatLocation, ModelProbe, RoomProfile, TranslationItem, VisionAdvice } from '../models/tasks';
import { promptTasks, type PromptTask } from '../models/prompts';
import { scopeType, type ScopeOption, type TranslationScope } from './translation-scope';

const id = z.string().min(1).max(100);
const roomKey = z.string().min(1).max(300);
const rect = z.strictObject({
  x: z.number().min(0).max(20000),
  y: z.number().min(0).max(20000),
  width: z.number().min(8).max(20000),
  height: z.number().min(8).max(20000),
  viewportWidth: z.number().min(8).max(20000),
  viewportHeight: z.number().min(8).max(20000),
});
export type CaptureRect = z.infer<typeof rect>;

const payloads = {
  snapshot: z.undefined(),
  saveRule: chatRule,
  decideRule: z.object({ id, version: z.number().int().positive(), passed: z.boolean() }),
  translate: z.object({
    revision: z.number().int().nonnegative(),
    items: z.array(z.object({ id, text: z.string().min(1).max(600) })).min(1).max(12),
  }),
  verify: z.object({
    rect,
    editorRect: rect.optional(),
    sendRect: rect.optional(),
    html: z.string().min(1).max(12000),
    samples: z.array(z.string().max(300)).min(1).max(10),
  }),
  locateChat: z.array(z.object({
    id, rect, editorRect: rect.optional(), html: z.string().min(1).max(12000), samples: z.array(z.string().max(300)).min(2).max(6),
  })).min(1).max(3),
  usage: z.partialRecord(pageCounter, z.number().int().positive().max(10000)),
  getSettings: z.undefined(),
  saveSettings: settingsSchema,
  saveModelSettings: settingsSchema.pick({ model: true, autoVision: true }),
  saveReadingSettings: settingsSchema.pick({ readingLanguage: true, mode: true, prompt: true }),
  probeModel: z.object({ model: modelConfig, readingLanguage: z.union([languageCode, z.literal('')]) }),
  syncRegistry: z.undefined(),
  usageSummary: z.undefined(),
  clearUsage: z.undefined(),
  removeRule: id,
  setRuleSelection: z.object({ tabId: z.number().int().nonnegative(), roomKey, ruleId: id.nullable() }),
  site: z.number().int().nonnegative(),
  pageCommand: z.object({
    tabId: z.number().int().nonnegative(),
    action: z.enum(['ping', 'pick', 'detect', 'room', 'initial-review']),
  }),
  setTranslateEmoji: z.boolean(),
  setSkipReadingLanguage: z.boolean(),
  setTargetLanguage: settingsSchema.shape.readingLanguage,
  setPreferredScope: z.object({ tabId: z.number().int().nonnegative(), origin: z.string().max(350), scope: scopeType }),
  promptContext: z.number().int().nonnegative().optional(),
  savePrompt: z.object({
    tabId: z.number().int().nonnegative().optional(),
    origin: z.string().max(350).nullable(),
    task: z.enum(promptTasks),
    value: z.string().trim().min(1).max(4000).nullable(),
  }),
  setSite: z.object({
    tabId: z.number().int().nonnegative(), enabled: z.boolean().nullable(), origin: z.string().max(350),
    scope: scopeType.default('site'), key: z.string().max(350).optional(),
  }),
  attach: z.number().int().nonnegative(),
  getRoom: roomKey,
  setRoom: z.object({ key: roomKey, language: languageCode.nullable() }),
  resolveRoomLanguage: z.string().trim().min(1).max(80),
  identifyRoom: z.object({
    key: roomKey,
    hints: z.object({
      language: languageCode.optional(),
      title: z.string().max(200).optional(),
      streamer: z.string().max(120).optional(),
      category: z.string().max(100).optional(),
    }),
    lines: z.array(z.string().min(1).max(180)).min(5).max(40),
  }),
};

export interface PageSnapshot { settings: PageSettings; rules: RuleMatch[]; selectedRuleId?: string }
export interface SiteState {
  origin: string;
  youtube: boolean;
  translateEmoji: boolean;
  skipReadingLanguage: boolean;
  readingLanguage: string;
  targetLanguage: string;
  browserLanguage: string;
  preferredScope: TranslationScope | null;
  scopes: ScopeOption[];
  localRules: LocalRuleDetails[];
  selectedRuleId: string | null;
}
export interface LocalRuleDetails { rule: ChatRule; addedAt: number | null }
export interface RuleSummary { local: LocalRuleDetails[]; active: number; staged: number }
export interface PromptContext {
  origin: string | null;
  title?: string;
  readingLanguage: string;
  model: string;
  prompts: Record<PromptTask, { instruction: string; system: string }>;
}

interface Results {
  snapshot: PageSnapshot;
  saveRule: void;
  decideRule: void;
  translate: TranslationItem[];
  verify: VisionAdvice;
  locateChat: ChatLocation;
  usage: void;
  getSettings: { settings: Settings; browserLanguage: string; rules: RuleSummary; imageUnavailable: boolean };
  saveSettings: void;
  saveModelSettings: void;
  saveReadingSettings: void;
  probeModel: ModelProbe;
  syncRegistry: RuleSummary;
  usageSummary: DailyUsage[];
  clearUsage: void;
  removeRule: void;
  setRuleSelection: SiteState;
  site: SiteState;
  pageCommand: boolean;
  setTranslateEmoji: void;
  setSkipReadingLanguage: void;
  setTargetLanguage: string;
  setPreferredScope: void;
  promptContext: PromptContext;
  savePrompt: PromptContext;
  setSite: SiteState;
  attach: void;
  getRoom: RoomPreference | null;
  setRoom: RoomPreference | null;
  resolveRoomLanguage: string | null;
  identifyRoom: { preference: RoomPreference; profile?: RoomProfile };
}

type Operation = keyof typeof payloads;
type Input<K extends Operation> = z.infer<(typeof payloads)[K]>;
type Command = { [K in Operation]: { kind: K; payload: Input<K> } }[Operation];
type Reply<T> = { ok: true; value: T } | { ok: false; error: string };

export function parseCommand(message: unknown): Command | undefined {
  const envelope = z.object({ kind: z.string(), payload: z.unknown().optional() }).safeParse(message);
  if (!envelope.success || !Object.hasOwn(payloads, envelope.data.kind)) return;
  const kind = envelope.data.kind as Operation;
  const parsed = payloads[kind].safeParse(envelope.data.payload);
  if (parsed.success) return { kind, payload: parsed.data } as Command;
}

export async function send<K extends Operation>(kind: K, payload: Input<K>): Promise<Results[K]> {
  const reply = await chrome.runtime.sendMessage({ kind, payload }) as Reply<Results[K]> | undefined;
  if (!reply) throw new Error('Extension background is unavailable. Reload the page if the extension was updated.');
  if (!reply.ok) throw new Error(reply.error);
  return reply.value;
}
