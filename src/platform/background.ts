import { createTasks } from '../models/tasks';
import { ImageInputUnsupportedError } from '../models/openai-compatible';
import { modelSystemPrompt, promptTasks, taskInstruction, taskInstructions } from '../models/prompts';
import { resolveRules, decideRule } from '../rules/resolver';
import { summarizeRules, syncRegistry } from '../rules/registry';
import { ruleMatches } from '../rules/schema';
import { updateUsage } from '../usage/usage';
import { hostPattern, isTextOnlyModel, isYouTube, parseEndpoint, parseRegistry, readingLanguage, type Settings } from './config';
import { editState, readState, type State } from './store';
import type { RoomPreference } from './store';
import { captureCandidate } from './capture';
import { parseCommand, type PromptContext, type SiteState } from './messages';
import { effectiveScope, scopeOptions, type TranslationScope } from './translation-scope';
import { alreadyInReadingLanguage } from './reading-language';

type Command = NonNullable<ReturnType<typeof parseCommand>>;
const uiOnly = new Set<Command['kind']>([
  'getSettings', 'saveSettings', 'saveModelSettings', 'saveReadingSettings', 'probeModel', 'syncRegistry', 'usageSummary',
  'clearUsage', 'removeRule', 'site', 'setSite', 'attach', 'pageCommand', 'setTranslateEmoji', 'setSkipReadingLanguage',
  'setPreferredScope', 'setTargetLanguage', 'promptContext', 'savePrompt',
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

function pageSettings(state: State, origin: string | null) {
  return {
    ...state.settings,
    systemPrompts: { ...state.settings.systemPrompts, ...(origin ? state.sitePrompts[origin] : undefined) },
  };
}

async function promptPage(tabId?: number) {
  if (tabId === undefined) return { origin: null };
  const tab = await chrome.tabs.get(tabId);
  return { origin: webUrl(tab.url).origin, title: tab.title };
}

async function promptContext(page: Awaited<ReturnType<typeof promptPage>>): Promise<PromptContext> {
  const settings = modelLanguages(pageSettings(await readState(), page.origin));
  const prompts = Object.fromEntries(promptTasks.map(task => {
    const instruction = taskInstruction(task, settings);
    return [task, { instruction, system: modelSystemPrompt(taskInstructions(task, settings, instruction), settings.uiLanguage) }];
  })) as PromptContext['prompts'];
  return {
    ...page, prompts, model: settings.model.model,
    readingLanguage: settings.readingLanguage,
  };
}

function modelLanguages(settings: Settings) {
  const uiLanguage = readingLanguage('', chrome.i18n.getUILanguage());
  return { ...settings, uiLanguage, readingLanguage: readingLanguage(settings.readingLanguage, uiLanguage) };
}

function imageUnavailable(state: State) {
  return isTextOnlyModel(state.settings.model) || state.rejectedVisionModel === imageModelKey(state.settings);
}

async function authorizedModel(settings: Settings) {
  const url = parseEndpoint(settings.model.endpoint);
  if (!await chrome.permissions.contains({ origins: [hostPattern(url)] })) {
    throw new Error('Grant access to your model endpoint in Settings.');
  }
  return modelLanguages(settings);
}

function refreshPages() {
  void chrome.tabs.query({}).then(tabs => Promise.all(tabs.map(tab =>
    tab.id === undefined ? undefined : chrome.tabs.sendMessage(tab.id, { pageAction: 'refresh' }).catch(() => undefined),
  ))).catch(() => undefined);
}

async function captureForReview(tab: chrome.tabs.Tab, frameId: number | undefined, regions: Parameters<typeof captureCandidate>[1], compare = false) {
  try {
    return await captureCandidate(tab, regions, compare);
  } finally {
    if (tab.id !== undefined) {
      void chrome.tabs.sendMessage(tab.id, { pageAction: 'capture-complete' }, { frameId }).catch(() => undefined);
    }
  }
}

async function routePageCommand(tabId: number, action: string) {
  const frames = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true }, func: () => true,
  }).then(results => results.map(result => result.frameId)).catch(() => [0]);
  const available = await Promise.all(frames.map(async frameId => ({
    frameId,
    rank: Number(await chrome.tabs.sendMessage(tabId, { pageAction: 'rank' }, { frameId }).catch(() => 0)),
  })));
  const target = available.filter(frame => frame.rank > 0).sort((a, b) => b.rank - a.rank)[0];
  return Boolean(target && (action === 'ping' || await chrome.tabs.sendMessage(tabId, { pageAction: action },
    { frameId: target.frameId }).catch(() => false)));
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
  const enabled = async () => effectiveScope(await scopeOptions(page, state.enabledSites, state.scopeOverrides))?.value === true;
  const requireRoom = (key: string) => {
    if (!key.startsWith(page.origin + '|')) throw new Error('Room does not belong to this site.');
  };
  switch (cmd.kind) {
    case 'snapshot': {
      const granted = await chrome.permissions.contains({ origins: [hostPattern(parseEndpoint(state.settings.model.endpoint))] });
      return {
        settings: {
          enabled: await enabled(), modelConfigured: granted, imageInput: imageUnavailable(state) ? false : state.settings.model.imageInput,
          translateEmoji: state.settings.translateEmoji,
          autoVision: state.settings.autoVision, revision: state.revision,
          readingLanguage: readingLanguage(state.settings.readingLanguage, chrome.i18n.getUILanguage()), mode: state.settings.mode,
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
      if (state.revision !== cmd.payload.revision || !await enabled()) throw new Error('Translation settings changed. Try again.');
      const settings = await authorizedModel(pageSettings(state, page.origin));
      let items = cmd.payload.items;
      if (settings.skipReadingLanguage && settings.mode !== 'manual') {
        const skip = await Promise.all(items.map(({ text }) => alreadyInReadingLanguage(text, settings.readingLanguage)));
        items = items.filter((_item, index) => !skip[index]);
      }
      if (!items.length) return [];
      if ((await readState()).revision !== state.revision) throw new Error('Translation settings changed. Try again.');
      if (translations >= 3) throw new Error('The translation provider is busy. New messages will be prioritized.');
      translations++;
      try {
        return await tasks.translate(settings, items);
      } finally {
        translations--;
      }
    }
    case 'verify':
    case 'locateChat': {
      const key = 'vision:' + tab.id;
      if (checksInFlight.has(key)) throw new Error('Image verification is already running for this tab.');
      if (!state.settings.autoVision) throw new Error('截图核验未开启。');
      if (!state.settings.model.imageInput || imageUnavailable(state)) {
        throw new ImageInputUnsupportedError();
      }
      checksInFlight.add(key);
      try {
        const settings = await authorizedModel(pageSettings(state, page.origin));
        if (cmd.kind === 'locateChat') {
          const image = await captureForReview(tab, sender.frameId,
            cmd.payload.flatMap(({ rect, editorRect }) => editorRect ? [rect, editorRect] : [rect]), true);
          if ((await readState()).revision !== state.revision) throw new Error('模型设置已变化，已跳过截图查找。');
          return await tasks.locateChat(settings, image,
            cmd.payload.map(({ id, html, samples, editorRect }) => ({ id, html, samples, editorImage: Boolean(editorRect) })));
        }
        const { rect, editorRect, sendRect, html, samples } = cmd.payload;
        const image = await captureForReview(tab, sender.frameId, [rect, editorRect, sendRect].filter(r => r !== undefined));
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
    case 'resolveRoomLanguage':
      return tasks.resolveRoomLanguage(await authorizedModel(state.settings), cmd.payload);
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
      if (!await enabled()) throw new Error('Enable this page or room before sending room samples to your model.');
      if (checksInFlight.has(key)) throw new Error('Language identification is already running.');
      checksInFlight.add(key);
      try {
        const profile = await tasks.roomProfile(await authorizedModel(pageSettings(state, page.origin)), hints, lines);
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
      return {
        settings: state.settings, browserLanguage: readingLanguage('', chrome.i18n.getUILanguage()),
        rules: summarizeRules(state), imageUnavailable: imageUnavailable(state),
      };
    }
    case 'pageCommand':
      return routePageCommand(cmd.payload.tabId, cmd.payload.action);
    case 'setPreferredScope': {
      const { tabId, origin, scope } = cmd.payload;
      if (webUrl((await chrome.tabs.get(tabId)).url).origin !== origin) {
        throw new Error('页面已切换，请关闭并重新打开工具栏。');
      }
      return editState(state => ({
        changes: { preferredScopes: rememberScope(state.preferredScopes, origin, scope) }, result: undefined,
      }));
    }
    case 'promptContext':
      return promptContext(await promptPage(cmd.payload));
    case 'savePrompt': {
      const { tabId, origin, task, value } = cmd.payload;
      const page = await promptPage(tabId);
      if (page.origin !== origin) throw new Error('直播页面已切换，请从该页重新打开设置。');
      await editState(state => {
        const prompts = { ...(origin ? state.sitePrompts[origin] : state.settings.systemPrompts) };
        if (value === null) delete prompts[task];
        else prompts[task] = value;
        if (!origin) return {
          changes: { settings: { ...state.settings, systemPrompts: prompts }, revision: state.revision + 1 }, result: undefined,
        };
        const sitePrompts = { ...state.sitePrompts };
        if (Object.keys(prompts).length) sitePrompts[origin] = prompts;
        else delete sitePrompts[origin];
        return { changes: { sitePrompts, revision: state.revision + 1 }, result: undefined };
      });
      refreshPages();
      return promptContext(page);
    }
    case 'setTranslateEmoji':
    case 'setSkipReadingLanguage':
      await editState(state => ({
        changes: { settings: { ...state.settings,
          [cmd.kind === 'setTranslateEmoji' ? 'translateEmoji' : 'skipReadingLanguage']: cmd.payload,
        }, revision: state.revision + 1 },
        result: undefined,
      }));
      refreshPages();
      return;
    case 'setTargetLanguage':
      await editState(state => ({
        changes: { settings: { ...state.settings, readingLanguage: cmd.payload }, revision: state.revision + 1 },
        result: undefined,
      }));
      refreshPages();
      return readingLanguage(cmd.payload, chrome.i18n.getUILanguage());
    case 'saveSettings':
    case 'saveModelSettings':
    case 'saveReadingSettings': {
      await editState(state => {
        const settings = { ...state.settings, ...cmd.payload };
        parseEndpoint(settings.model.endpoint);
        if (settings.registryUrl) parseRegistry(settings.registryUrl);
        return {
          changes: {
            settings,
            revision: state.revision + 1,
            ...(!state.settings.model.imageInput && settings.model.imageInput ? { rejectedVisionModel: null } : {}),
            ...(state.settings.registryUrl === settings.registryUrl ? {} :
              { community: { active: [], staged: [], rejected: {} } }),
          },
          result: undefined,
        };
      });
      refreshPages();
      return;
    }
    case 'removeRule':
      await editState(state => ({ changes: { localRules: state.localRules.filter(rule => rule.id !== cmd.payload) }, result: undefined }));
      refreshPages();
      return;
    case 'probeModel': {
      const { settings } = await readState();
      const probeSettings = await authorizedModel({ ...settings, ...cmd.payload });
      const result = await tasks.probe(probeSettings);
      if (result.image === 'supported' || result.image === 'unsupported') {
        const supportsImages = result.image === 'supported';
        const updated = await editState(state => {
          const model = state.settings.model;
          const tested = probeSettings.model;
          const matchesSaved = model.endpoint === tested.endpoint && model.model === tested.model &&
            model.apiKey === tested.apiKey;
          if (!matchesSaved) return { changes: {}, result: false };
          return {
            changes: {
              settings: { ...state.settings, model: { ...model, imageInput: supportsImages } },
              rejectedVisionModel: supportsImages ? null : imageModelKey(probeSettings),
            },
            result: true,
          };
        });
        if (updated) refreshPages();
      }
      return result;
    }
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
      if (cmd.kind === 'attach') return attach(tabId, page);
      if (cmd.kind === 'setSite') {
        const { scope, key, enabled } = cmd.payload;
        const state = await readState();
        const target = (await scopeOptions(page, state.enabledSites, state.scopeOverrides)).find(option => option.scope === scope);
        if (cmd.payload.origin !== origin || !target || (scope !== 'site' && target.key !== key)) {
          throw new Error('页面已切换，请关闭并重新打开工具栏。');
        }
        await editState(latest => {
          const preferredScopes = rememberScope(latest.preferredScopes, origin, scope);
          if (scope === 'site') {
            const enabledSites = latest.enabledSites.filter(site => site !== origin);
            if (enabled) enabledSites.push(origin);
            return { changes: { enabledSites, preferredScopes, revision: latest.revision + 1 }, result: undefined };
          }
          const overrides = { ...latest.scopeOverrides };
          delete overrides[target.key];
          if (enabled !== null || !target.usesPageLink) overrides[target.key] = enabled;
          return { changes: { scopeOverrides: Object.fromEntries(Object.entries(overrides).slice(-500)),
            preferredScopes, revision: latest.revision + 1 }, result: undefined };
        });
        refreshPages();
      }
      const state = await readState();
      return {
        origin, youtube: isYouTube(page.hostname) && page.protocol === 'https:',
        translateEmoji: state.settings.translateEmoji, skipReadingLanguage: state.settings.skipReadingLanguage,
        readingLanguage: readingLanguage(state.settings.readingLanguage, chrome.i18n.getUILanguage()),
        targetLanguage: state.settings.readingLanguage,
        browserLanguage: readingLanguage('', chrome.i18n.getUILanguage()),
        preferredScope: state.preferredScopes[origin] ?? state.settings.preferredScope,
        scopes: await scopeOptions(page, state.enabledSites, state.scopeOverrides),
      } satisfies SiteState;
    }
  }
  throw new Error('Unsupported settings command.');
}

function rememberScope(prefs: State['preferredScopes'], origin: string, scope: TranslationScope): State['preferredScopes'] {
  const other = Object.entries(prefs).filter(([site]) => site !== origin);
  other.push([origin, scope]);
  return Object.fromEntries(other.slice(-500));
}
