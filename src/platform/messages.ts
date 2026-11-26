import { z } from 'zod';
import { languageCode, modelConfig, settingsSchema, type PageSettings, type Settings } from './config';
import { chatRule, type RuleMatch } from '../rules/schema';
import { pageCounter, type DailyUsage } from '../usage/usage';
import type { RoomPreference } from './store';
import type { ModelProbe, RoomProfile, TranslationItem, VisionAdvice } from '../models/tasks';

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
  site: z.number().int().nonnegative(),
  setSite: z.object({ tabId: z.number().int().nonnegative(), enabled: z.boolean(), origin: z.string().max(350) }),
  attach: z.number().int().nonnegative(),
  getRoom: roomKey,
  setRoom: z.object({ key: roomKey, language: languageCode.nullable() }),
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

export interface PageSnapshot { settings: PageSettings; rules: RuleMatch[] }
export interface SiteState { enabled: boolean; origin: string; youtube: boolean }
export interface RuleSummary { local: Array<{ id: string; host: string; path?: string }>; active: number; staged: number }

interface Results {
  snapshot: PageSnapshot;
  saveRule: void;
  decideRule: void;
  translate: TranslationItem[];
  verify: VisionAdvice;
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
  site: SiteState;
  setSite: SiteState;
  attach: void;
  getRoom: RoomPreference | null;
  setRoom: RoomPreference | null;
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
