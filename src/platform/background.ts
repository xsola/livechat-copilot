import { createTasks } from '../models/tasks';
import { ImageInputUnsupportedError } from '../models/openai-compatible';
import { resolveRules, decideRule } from '../rules/resolver';
import { summarizeRules, syncRegistry } from '../rules/registry';
import { ruleMatches } from '../rules/schema';
import { updateUsage } from '../usage/usage';
import { hostPattern, isTextOnlyModel, isYouTube, parseEndpoint, parseRegistry, type Settings } from './config';
import { editState, readState, type State } from './store';
import type { RoomPreference } from './store';
import { captureCandidate } from './capture';
import { parseCommand, type SiteState } from './messages';

type Command = NonNullable<ReturnType<typeof parseCommand>>;
const uiOnly = new Set<Command['kind']>([
  'getSettings', 'saveSettings', 'connection', 'syncRegistry', 'usageSummary',
  'clearUsage', 'removeRule', 'site', 'setSite', 'attach',
]);
const registryAlarm = 'refresh-community-rules';
const checksInFlight = new Set<string>();
let translations = 0;

const tasks = createTasks((task, success, elapsed, usage) => editState(state => ({
  changes: { usage: updateUsage(state.usage, day => {
    const row = day.models[task] ??= { requests: 0, failed: 0, inputTokens: 0, outputTokens: 0, totalMs: 0 };
    row.requests++;
    if (!success) row.failed++;
    row.totalMs += elapsed;
    row.inputTokens += usage.inputTokens;
    row.outputTokens += usage.outputTokens;
  }) },
  result: undefined,
})));

export function setupBackground() {
  const restrictedStorage = chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  chrome.runtime.onMessage.addListener((message: unknown, sender, reply) => {
    const cmd = parseCommand(message);
    if (!cmd || sender.id !== chrome.runtime.id) return;
    void restrictedStorage.then(() => dispatch(cmd, sender)).then(
      value => reply({ ok: true, value }),
      error => reply({ ok: false, error: error instanceof Error ? error.message : 'Extension operation failed.' }),
    );
    return true;
  });
  chrome.alarms.onAlarm.addListener(alarm => {
    if (alarm.name === registryAlarm) void syncRegistry().catch(() => undefined);
  });
  chrome.runtime.onStartup.addListener(() => { void ensureAlarm(); });
  chrome.runtime.onInstalled.addListener(() => { void ensureAlarm(); });
}

async function ensureAlarm() {
  if (!await chrome.alarms.get(registryAlarm)) {
    await chrome.alarms.create(registryAlarm, { periodInMinutes: 360 });
  }
}

function webUrl(value?: string) {
  if (!value) throw new Error('Open an HTTP or HTTPS live-stream page first.');
  const url = new URL(value);
  if (!['https:', 'http:'].includes(url.protocol)) throw new Error('This page does not support live chat detection.');
  return url;
}

function imageModelKey(settings: Settings) {
  return JSON.stringify([settings.model.endpoint, settings.model.model]);
}

function imageUnavailable(state: State) {
  return isTextOnlyModel(state.settings.model) || state.rejectedVisionModel === imageModelKey(state.settings);
}

async function authorizedModel(settings: Settings) {
  const url = parseEndpoint(settings.model.endpoint);
  if (!await chrome.permissions.contains({ origins: [hostPattern(url)] })) {
    throw new Error('Grant access to your model endpoint in Settings.');
  }
  return settings;
}

function refreshPages() {
  void chrome.tabs.query({}).then(tabs => Promise.all(tabs.map(tab =>
    tab.id === undefined ? undefined : chrome.tabs.sendMessage(tab.id, { pageAction: 'refresh' }).catch(() => undefined),
  ))).catch(() => undefined);
}

async function attach(tabId: number, page: URL) {
  if (isYouTube(page.hostname) && page.protocol === 'https:') {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true }, files: ['content-scripts/live-chat.js'],
    });
    return;
  }
  const pattern = hostPattern(page);
  if (!await chrome.permissions.contains({ origins: [pattern] })) throw new Error('Allow this site in the extension popup first.');
  const id = 'site-' + page.protocol.slice(0, -1) + '-' + page.hostname.replaceAll('.', '_');
  const existing = (await chrome.scripting.getRegisteredContentScripts({ ids: [id] }))[0];
  if (!existing || existing.matches?.[0] !== pattern) {
    const config = {
      id, matches: [pattern], js: ['content-scripts/live-chat.js'], allFrames: true, runAt: 'document_idle' as const,
    };
    if (existing) await chrome.scripting.updateContentScripts([config]);
    else await chrome.scripting.registerContentScripts([config]);
  }
  await chrome.scripting.executeScript({
    target: { tabId, allFrames: true }, files: ['content-scripts/live-chat.js'],
  });
}

async function dispatch(cmd: Command, sender: chrome.runtime.MessageSender): Promise<unknown> {
  if (uiOnly.has(cmd.kind)) {
    const allowed = ['popup.html', 'options.html'].some(path => sender.url === chrome.runtime.getURL(path) ||
      sender.url?.startsWith(chrome.runtime.getURL(path) + '?'));
    if (!allowed) throw new Error('This action is only available in extension settings or the toolbar.');
    return dispatchUi(cmd);
  }

  const tab = sender.tab;
  if (tab?.id === undefined) throw new Error('Open a live tab first.');
  const page = webUrl(tab.url);
  const frame = webUrl(sender.url);
  if (page.origin !== frame.origin) throw new Error('Cross-origin chat frames are not supported in this release.');
  const state = await readState();
  const enabled = state.enabledSites.includes(page.origin);
  const requireRoom = (key: string) => {
    if (!key.startsWith(page.origin + '|')) throw new Error('Room does not belong to this site.');
  };
  switch (cmd.kind) {
    case 'snapshot': {
      const granted = await chrome.permissions.contains({ origins: [hostPattern(parseEndpoint(state.settings.model.endpoint))] });
      return {
        settings: {
          enabled, modelConfigured: granted, imageInput: state.settings.model.imageInput && !imageUnavailable(state),
          autoVision: state.settings.autoVision, revision: state.revision,
          readingLanguage: state.settings.readingLanguage, mode: state.settings.mode,
        },
        rules: resolveRules(page, frame, state.localRules, state.community),
      };
    }
    case 'saveRule': {
      const rule = cmd.payload;
      if (!ruleMatches(rule, page, frame)) throw new Error('The rule does not match this page and frame.');
      return editState(latest => ({
        changes: { localRules: [...latest.localRules.filter(item => item.id !== rule.id), rule].slice(-250) },
        result: undefined,
      }));
    }
    case 'decideRule': {
      const { id, version, passed } = cmd.payload;
      return editState(latest => {
        const rule = latest.community.staged.find(candidate => candidate.id === id && candidate.version === version);
        if (!rule || !ruleMatches(rule, page, frame)) return { changes: {}, result: undefined };
        return { changes: { community: decideRule(latest.community, id, version, passed) }, result: undefined };
      });
    }
    case 'translate': {
      if (!enabled || state.revision !== cmd.payload.revision) throw new Error('Translation settings changed. Try again.');
      if (translations >= 3) throw new Error('The translation provider is busy. New messages will be prioritized.');
      translations++;
      try {
        return await tasks.translate(await authorizedModel(state.settings), cmd.payload.items);
      } finally {
        translations--;
      }
    }
    case 'verify': {
      const key = 'vision:' + tab.id;
      if (checksInFlight.has(key)) throw new Error('Image verification is already running for this tab.');
      if (!state.settings.autoVision) throw new Error('自动图像复核未开启。');
      if (!state.settings.model.imageInput || imageUnavailable(state)) {
        throw new ImageInputUnsupportedError();
      }
      checksInFlight.add(key);
      try {
        const settings = await authorizedModel(state.settings);
        const { rect, editorRect, sendRect, html, samples } = cmd.payload;
        const image = await captureCandidate(tab, [rect, editorRect, sendRect].filter(r => r !== undefined));
        if ((await readState()).revision !== state.revision) throw new Error('模型设置已变化，已跳过复核。');
        return await tasks.vision(settings, image, { html, samples, editorImage: Boolean(editorRect), sendImage: Boolean(sendRect) });
      } catch (error) {
        if (error instanceof ImageInputUnsupportedError) {
          await editState(latest => ({
            changes: imageModelKey(latest.settings) === imageModelKey(state.settings)
              ? { rejectedVisionModel: imageModelKey(state.settings) } : {},
            result: undefined,
          }));
          refreshPages();
        }
        throw error;
      } finally {
        checksInFlight.delete(key);
      }
    }
    case 'getRoom':
      requireRoom(cmd.payload);
      return state.roomPreferences[cmd.payload] ?? null;
    case 'setRoom': {
      const { key, language } = cmd.payload;
      requireRoom(key);
      return saveRoom(key, language ? { language, source: 'user' } : null);
    }
    case 'identifyRoom': {
      const { key, hints, lines } = cmd.payload;
      requireRoom(key);
      const existing = state.roomPreferences[key];
      if (existing) return { preference: existing };
      if (!enabled) throw new Error('Enable this site before sending room samples to your model.');
      if (checksInFlight.has(key)) throw new Error('Language identification is already running.');
      checksInFlight.add(key);
      try {
        const profile = await tasks.roomProfile(await authorizedModel(state.settings), hints, lines);
        const preference = await saveRoom(key, { language: profile.language, source: 'inferred' }, true);
        return { preference, profile };
      } finally {
        checksInFlight.delete(key);
      }
    }
    case 'usage':
      return editState(latest => ({
        changes: { usage: updateUsage(latest.usage, day => {
          for (const [kind, count] of Object.entries(cmd.payload)) {
            const counter = kind as keyof typeof day.page;
            day.page[counter] = (day.page[counter] ?? 0) + count;
          }
        }) },
        result: undefined,
      }));
  }
  throw new Error('Unsupported page command.');
}

function saveRoom(key: string, value: RoomPreference | null, ifMissing = false) {
  return editState(state => {
    if (ifMissing && state.roomPreferences[key]) {
      return { changes: {}, result: state.roomPreferences[key] };
    }
    const roomPreferences = { ...state.roomPreferences };
    delete roomPreferences[key];
    if (value) roomPreferences[key] = value;
    return { changes: { roomPreferences: Object.fromEntries(Object.entries(roomPreferences).slice(-500)) }, result: value };
  });
}

async function dispatchUi(cmd: Command): Promise<unknown> {
  switch (cmd.kind) {
    case 'getSettings': {
      const state = await readState();
      return { settings: state.settings, rules: summarizeRules(state), imageUnavailable: imageUnavailable(state) };
    }
    case 'saveSettings': {
      parseEndpoint(cmd.payload.model.endpoint);
      if (cmd.payload.registryUrl) parseRegistry(cmd.payload.registryUrl);
      await editState(state => ({
        changes: {
          settings: cmd.payload,
          revision: state.revision + 1,
          ...(!state.settings.model.imageInput && cmd.payload.model.imageInput ? { rejectedVisionModel: null } : {}),
          ...(state.settings.registryUrl === cmd.payload.registryUrl ? {} :
            { community: { active: [], staged: [], rejected: {} } }),
        },
        result: undefined,
      }));
      refreshPages();
      return;
    }
    case 'removeRule':
      await editState(state => ({ changes: { localRules: state.localRules.filter(rule => rule.id !== cmd.payload) }, result: undefined }));
      refreshPages();
      return;
    case 'connection':
      await tasks.check(await authorizedModel((await readState()).settings));
      return;
    case 'syncRegistry': {
      const result = await syncRegistry();
      return result;
    }
    case 'usageSummary':
      return (await readState()).usage;
    case 'clearUsage':
      return editState(() => ({ changes: { usage: [] }, result: undefined }));
    case 'site':
    case 'setSite':
    case 'attach': {
      const tabId = cmd.kind === 'setSite' ? cmd.payload.tabId : cmd.payload;
      const page = webUrl((await chrome.tabs.get(tabId)).url);
      const origin = page.origin;
      const youtube = isYouTube(page.hostname) && page.protocol === 'https:';
      if (cmd.kind === 'attach') return attach(tabId, page);
      if (cmd.kind === 'setSite') {
        if (cmd.payload.origin !== origin) throw new Error('The site changed. Reopen the toolbar menu before enabling translation.');
        const enabled = cmd.payload.enabled;
        await editState(state => ({
          changes: { enabledSites: [...new Set(enabled ? [...state.enabledSites, origin] : state.enabledSites.filter(site => site !== origin))] },
          result: undefined,
        }));
        refreshPages();
        return { origin, enabled, youtube } satisfies SiteState;
      }
      return { origin, enabled: (await readState()).enabledSites.includes(origin), youtube } satisfies SiteState;
    }
  }
  throw new Error('Unsupported settings command.');
}
