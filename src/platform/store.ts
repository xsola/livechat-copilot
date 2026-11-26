import { defaults, settingsSchema, type Settings } from './config';
import type { ChatRule } from '../rules/schema';
import type { CommunityRules } from '../rules/resolver';
import type { DailyUsage } from '../usage/usage';

export interface RoomPreference {
  language: string | null;
  source: 'inferred' | 'user';
}

export interface State {
  settings: Settings;
  revision: number;
  enabledSites: string[];
  localRules: ChatRule[];
  community: CommunityRules;
  roomPreferences: Record<string, RoomPreference>;
  usage: DailyUsage[];
  rejectedVisionModel: string | null;
}

const initial: State = {
  settings: defaults,
  revision: 0,
  enabledSites: [],
  localRules: [],
  community: { active: [], staged: [], rejected: {} },
  roomPreferences: {},
  usage: [],
  rejectedVisionModel: null,
};

let pendingWrites: Promise<unknown> = Promise.resolve();

export async function readState(): Promise<State> {
  const stored = await chrome.storage.local.get(Object.keys(initial));
  const settings = settingsSchema.safeParse(stored.settings);
  return { ...structuredClone(initial), ...stored, settings: settings.success ? settings.data : structuredClone(defaults) };
}

export function editState<T>(edit: (state: State) => { changes: Partial<State>; result: T }): Promise<T> {
  const operation = pendingWrites.then(async () => {
    const { changes, result } = edit(await readState());
    if (Object.keys(changes).length) await chrome.storage.local.set(changes);
    return result;
  });
  pendingWrites = operation.catch(() => undefined);
  return operation;
}
