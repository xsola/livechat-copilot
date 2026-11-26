import { isYouTube } from '../platform/config';
import { send, type PageSnapshot } from '../platform/messages';
import { RoomLanguage } from '../rooms/language';
import { roomLocation } from '../rooms/metadata';
import { languageName, normalizeLanguage } from '../rooms/language-input';
import type { ChatRule, RuleMatch } from '../rules/schema';
import { PageMeter } from '../usage/page-meter';
import { testRule, invalidateSelector, queryAll, type RuleTest } from './dom';
import { findCandidates, insidePlayer } from './detection/candidates';
import { isTwitch, twitchChannel } from './twitch';
import { Picker } from './detection/picker';
import { PagePanel } from './page-panel';
import { ChatSession } from './session';

function localId(rule: ChatRule) {
  let hash = 2166136261;
  for (const char of JSON.stringify([rule.host, rule.pathPrefix, rule.framePathPrefix, rule.container, rule.message, rule.body, rule.bodyAfter])) {
    hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  }
  return 'local-' + (hash >>> 0).toString(16);
}

function relevantFrame(page: URL, frame: URL) {
  if (isTwitch(page.hostname)) return Boolean(twitchChannel(page)) && window === window.top;
  if (!isYouTube(page.hostname)) return true;
  if (window === window.top && frame.pathname === '/live_chat') return true;
  const candidates = Array.from(window.top!.document.querySelectorAll<HTMLIFrameElement>(
    'iframe#chatframe, ytd-live-chat-frame iframe, iframe[src*="/live_chat"]'));
  const visible = candidates.find(candidate => candidate.getClientRects().length &&
    candidate.clientWidth > 10 && candidate.clientHeight > 10 && getComputedStyle(candidate).visibility !== 'hidden');
  if (window !== window.top) return frame.pathname === '/live_chat' && (!visible || window.frameElement === visible);
  return ['/watch', '/live'].some(path => page.pathname.startsWith(path)) && !visible;
}

export function startLiveChat(signal: AbortSignal) {
  const marker = '__liveChatCopilotActive';
  const context = globalThis as typeof globalThis & Record<string, unknown>;
  if (context[marker] || !roomLocation()) return;
  context[marker] = true;
  const meter = new PageMeter();
  const activity = new Map<Element, number>();
  const attempted = new Map<string, number>();
  let activityObserver: MutationObserver | undefined;
  let page: URL;
  let frame: URL;
  let currentUrl = '';
  let snapshot: PageSnapshot | undefined;
  let language: RoomLanguage | undefined;
  let panel: PagePanel | undefined;
  let picker: Picker | undefined;
  let session: ChatSession | undefined;
  let sessionSignature = '';
  let lastError = '';
  let counted = false;
  let searchNumber = 0;
  let nextScan = 0;
  let nextSync = 0;
  let refreshing: Promise<void> | undefined;
  let generation = 0;
  let suggestedOnNavigation = false;
  let observeUntil = 0;

  function trackActivity() {
    if (activityObserver) return;
    activityObserver = new MutationObserver(records => {
      for (const record of records.slice(-100)) {
        if (record.type === 'childList' && !record.addedNodes.length) continue;
        let node = record.target instanceof Element ? record.target : record.target.parentElement;
        if (node?.closest('[data-livechat-copilot]')) continue;
        for (let level = 0; node && level < 3; level++, node = node.parentElement) {
          const changes = activity.get(node) ?? 0;
          activity.delete(node);
          activity.set(node, Math.min(5, 1 + changes));
          if (activity.size > 80) activity.delete(activity.keys().next().value!);
        }
      }
    });
    activityObserver.observe(document.documentElement, { childList: true, characterData: true, subtree: true });
  }

  function stopTracking() {
    activityObserver?.disconnect();
    activityObserver = undefined;
  }

  function preparePicker() {
    if (picker) return picker;
    panel = new PagePanel(document);
    picker = new Picker(panel, page, frame,
      () => snapshot?.settings,
      async candidate => {
        if (!candidate.container.isConnected || !testRule(document, candidate.rule)?.messages.length) {
          throw new Error('候选区域已变化，请重新选择。');
        }
        await send('saveRule', { ...candidate.rule, id: localId(candidate.rule) });
        await refresh(true);
      });
    return picker;
  }

  function reset() {
    generation++;
    session?.close();
    picker?.close();
    panel?.host.remove();
    stopTracking();
    panel = undefined;
    picker = undefined;
    session = undefined;
    sessionSignature = '';
    snapshot = undefined;
    language = undefined;
    counted = false;
    suggestedOnNavigation = false;
    observeUntil = 0;
    searchNumber++;
    lastError = '';
    nextScan = 0;
    nextSync = 0;
    attempted.clear();
    activity.clear();
  }

  function synchronize() {
    const location = roomLocation();
    const next = location && relevantFrame(location.page, location.frame) ? location.page.href + '|' + location.frame.href : '';
    if (next !== currentUrl) {
      currentUrl = next;
      reset();
      if (next && location) {
        ({ page, frame } = location);
        language = new RoomLanguage(page, frame);
      }
    }
    return Boolean(next);
  }

  async function refresh(force = false) {
    if (!synchronize()) return;
    if (refreshing) {
      if (!force) return refreshing;
      await refreshing;
      if (!synchronize()) return;
    }
    const current = generation;
    nextSync = Date.now() + 20_000;
    refreshing = (async () => {
      try {
        const latest = await send('snapshot', undefined);
        if (current === generation && !signal.aborted) {
          snapshot = latest;
          nextScan = 0;
          scan();
        }
      } catch {
        // A navigation or an extension update can invalidate the frame while requesting state.
      }
    })();
    const active = refreshing;
    await active;
    if (refreshing === active) refreshing = undefined;
  }

  function decide(match: RuleMatch, passed: boolean) {
    match.staged = false;
    void send('decideRule', { id: match.rule.id, version: match.rule.version, passed }).catch(() => undefined);
  }

  function scan() {
    if (!snapshot || !language || Date.now() < nextScan) return;
    nextScan = Date.now() + 1800;
    if (observeUntil && Date.now() >= observeUntil && !picker?.isSearching()) stopTracking();
    let selected: { match: RuleMatch; result: RuleTest } | undefined;
    let empty: typeof selected;
    const lacking: RuleMatch[] = [];
    for (const match of snapshot.rules) {
      if (invalidateSelector(match.rule)) {
        if (match.staged) {
          decide(match, false);
          snapshot.rules = snapshot.rules.filter(candidate => candidate !== match);
        }
        continue;
      }
      const tested = testRule(document, match.rule);
      const result = tested && !insidePlayer(tested.container) ? tested : undefined;
      if (match.staged) {
        if (result && !result.rejected && result.messages.length >= 2) {
          decide(match, true);
          selected = { match, result };
          break;
        }
        lacking.push(match);
        continue;
      }
      if (!result || result.rejected) continue;
      if (match.sameSiteFallback && (queryAll(document, match.rule.container).length !== 1 ||
        !result.container.getClientRects().length ||
        (session?.match.rule.id !== match.rule.id || session?.container !== result.container) &&
          new Set(result.messages.map(message => message.text).filter(Boolean)).size < 2)) continue;
      if (result.messages.length || match.sameSiteFallback) { selected = { match, result }; break; }
      empty ??= { match, result };
    }
    if (selected?.result.messages && selected.result.messages.length >= 2) {
      for (const missing of lacking) {
        const key = missing.rule.id + '@' + missing.rule.version;
        if (Date.now() - (attempted.get(key) ?? Infinity) > 3000) {
          void send('decideRule', { id: missing.rule.id, version: missing.rule.version, passed: false }).catch(() => undefined);
          snapshot.rules = snapshot.rules.filter(match => match !== missing);
        } else if (!attempted.has(key)) {
          attempted.set(key, Date.now());
        }
      }
    }
    if (!selected) {
      if (!picker && !suggestedOnNavigation && !snapshot.selectedRuleId && snapshot.settings.enabled && page.pathname !== '/' &&
        snapshot.rules.some(match => match.source === 'local')) {
        if (!observeUntil) {
          observeUntil = Date.now() + 5500;
          trackActivity();
        }
        const { candidates: [best, next] } = findCandidates(document, page, frame, activity);
        if (best && !best.alternativeBody && best.score >= 12 && (!next || best.score - next.score > 2) &&
          (/^\/(?:live|room|channel)\//i.test(page.pathname) || best.container.getAttribute('role') === 'log' ||
            (activity.get(best.container) ?? 0) >= 2)) {
          suggestedOnNavigation = true;
          stopTracking();
          preparePicker().showSuggested(best);
        }
      }
      if (!empty) {
        if (session) { session.close(); session = undefined; }
        return;
      }
      selected = empty;
    }
    const { match, result } = selected;
    if (result.messages.length) stopTracking();
    const { enabled, modelConfigured, mode, readingLanguage, revision, translateEmoji } = snapshot.settings;
    const signature = JSON.stringify([match.rule, enabled, modelConfigured, mode, readingLanguage, revision, translateEmoji]);
    if (session?.container === result.container && sessionSignature === signature) return;
    session?.close();
    if (snapshot.settings.enabled) {
      if (!counted) { meter.count('sessions'); counted = true; }
      if (sessionSignature !== signature) meter.count(match.source);
    }
    sessionSignature = signature;
    const activeUrl = currentUrl;
    session = new ChatSession(match, result.container, snapshot.settings, language, meter,
      message => { lastError = message; }, result.messages, () => {
        const location = roomLocation();
        return Boolean(location && location.page.href + '|' + location.frame.href === activeUrl);
      });
  }

  function tick() {
    if (!synchronize()) return;
    if (!snapshot || Date.now() >= nextSync) {
      void refresh();
    } else {
      scan();
    }
  }

  function activate(action: string) {
    if (!synchronize()) return;
    if (action === 'capture-complete') { panel?.captureVisibility(true); return; }
    if (action === 'refresh') { void refresh(true); return; }
    if (action === 'pick') {
      searchNumber++;
      stopTracking();
      meter.count('manualPicker');
      preparePicker().start();
      void refresh();
    }
    if (action === 'initial-review') {
      void refresh(true).then(() => {
        if (!picker && session && snapshot?.settings.autoVision) {
          const current = session.match.rule;
          const existing = testRule(document, current);
          if (existing) preparePicker().showMatched({ ...existing, rule: current, score: 0 }, session.match.source);
        }
      });
    }
    if (action === 'detect') {
      const active = preparePicker();
      const currentSearch = ++searchNumber;
      active.beginSearch();
      trackActivity();
      void (async () => {
        await new Promise<void>(resolve => {
          const timer = setTimeout(resolve, 80);
          requestAnimationFrame(() => { clearTimeout(timer); setTimeout(resolve, 0); });
        });
        if (currentSearch !== searchNumber || !active.isSearching()) return;
        await refresh(true);
        if (currentSearch !== searchNumber || !active.isSearching()) return;
        const matched = () => {
          if (!session) return false;
          const existing = testRule(document, session.match.rule);
          if (!existing?.messages.length) return false;
          active.showMatched({ ...existing, rule: session.match.rule, score: 0 },
            session.match.sameSiteFallback ? 'same-site' : session.match.source);
          return true;
        };
        if (matched()) return;
        if (snapshot?.selectedRuleId) {
          active.noCandidate('指定的本地规则暂未读到弹幕。可在工具栏切换规则，或点「纠正规则」重新标注。');
          return;
        }
        active.searchProgress('正在检查页面结构和重复出现的消息…');
        let { candidates, unresolvedRegion } = findCandidates(document, page, frame, activity);
        if (!candidates[0] || candidates[0].score < 9) {
          active.searchProgress('正在等待新弹幕，确认哪个区域持续更新…');
          await new Promise(resolve => setTimeout(resolve, candidates.length ? 1100 : 1800));
          if (currentSearch !== searchNumber || !active.isSearching()) return;
          nextScan = 0;
          scan();
          if (matched()) return;
          ({ candidates, unresolvedRegion } = findCandidates(document, page, frame, activity));
        }
        const [best, runnerUp] = candidates;
        const canCompare = snapshot?.settings.autoVision && snapshot.settings.imageInput && snapshot.settings.modelConfigured;
        if (best && canCompare && ((runnerUp && best.score - runnerUp.score <= 2) || best.alternativeComposer || best.alternativeBody)) {
          await active.locate(candidates, unresolvedRegion);
        } else if (best?.alternativeBody) {
          active.noCandidate(undefined, best.container);
        } else if (best && best.score >= 9) {
          if (active.suggest(best)) meter.count('automatic');
        } else {
          await active.locate(candidates, unresolvedRegion);
        }
      })().catch(error => active.noCandidate(error instanceof Error ? error.message + ' ' : undefined)).finally(() => {
        if (currentSearch !== searchNumber) return;
        stopTracking();
      });
    }
    if (action === 'room' && language) {
      const current = language;
      void current.read().then(preference => {
        if (language !== current) return;
        preparePicker().close();
        const info = current.context();
        const format = (code: string | null) => code ? languageName(code) + '（' + code + '）' : '回复语言尚未设置';
        panel!.show('当前直播间', [info.title, info.streamer, lastError, format(preference?.language ?? null)].filter(Boolean).join(' · '));
        const value = panel!.languageInput(preference?.language ?? null);
        panel!.button('保存语言', button => {
          const input = value.value.trim();
          if (!input) {
            panel!.note('请输入语言名称，例如日语。');
            return;
          }
          button.disabled = true;
          void (async () => {
            let code = normalizeLanguage(input);
            if (!code) {
              panel!.note('正在让模型识别你输入的语言名称…');
              code = (await send('resolveRoomLanguage', input)) ?? undefined;
            }
            if (!value.isConnected || language !== current) return;
            if (!code) { panel?.note('未能确认语言，请填写语言名称，例如日语。'); return; }
            await current.set(code);
            value.value = code;
            if (value.isConnected) panel?.note('已保存。' + format(code));
          })().catch(error => {
            if (value.isConnected) panel?.note('无法确认语言。可直接填写常用名称，例如日语或英语。' +
              (error instanceof Error ? ' ' + error.message : ''));
          }).finally(() => { button.disabled = false; });
        });
        panel!.button('清除记忆', () => { void current.set(null).then(() => { value.value = ''; panel?.note('已清除。'); }); });
        panel!.button('关闭', () => picker!.close());
      }).catch(() => undefined);
    }
  }

  const listener = (message: { pageAction?: string }, sender: chrome.runtime.MessageSender, respond: (value: boolean | number) => void) => {
    if (sender.id !== chrome.runtime.id || typeof message?.pageAction !== 'string' || !synchronize()) return;
    if (message.pageAction === 'rank') {
      respond((session ? 100 : 0) + (frame.pathname === '/live_chat' ? 20 : 0) + (window === window.top ? 2 : 1));
      return;
    }
    if (message.pageAction !== 'ping') activate(message.pageAction);
    respond(true);
  };
  chrome.runtime.onMessage.addListener(listener);
  const timer = setInterval(tick, 850);
  window.navigation?.addEventListener('currententrychange', tick, { signal });
  window.addEventListener('pagehide', () => { picker?.close(); session?.close(); session = undefined; void meter.flush(); }, { signal });
  signal.addEventListener('abort', () => {
    clearInterval(timer);
    chrome.runtime.onMessage.removeListener(listener);
    delete context[marker];
    reset();
  }, { once: true });
  tick();
}
