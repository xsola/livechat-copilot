import { isYouTube } from '../platform/config';
import { send, type PageSnapshot } from '../platform/messages';
import { RoomLanguage } from '../rooms/language';
import { roomLocation } from '../rooms/metadata';
import type { ChatRule, RuleMatch } from '../rules/schema';
import { PageMeter } from '../usage/page-meter';
import { testRule, invalidateSelector, type RuleTest } from './dom';
import { findCandidate } from './detection/candidates';
import { Picker } from './detection/picker';
import { PagePanel } from './page-panel';
import { ChatSession } from './session';

function localId(rule: ChatRule) {
  let hash = 2166136261;
  for (const char of [rule.host, rule.pathPrefix, rule.framePathPrefix].join('|')) {
    hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  }
  return 'local-' + (hash >>> 0).toString(16);
}

function relevantFrame(page: URL, frame: URL) {
  if (!isYouTube(page.hostname)) return true;
  if (frame.pathname === '/live_chat') return true;
  return window === window.top && ['/watch', '/live'].some(path => page.pathname.startsWith(path)) &&
    !document.querySelector('iframe[src*="/live_chat"]');
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
  let explicitDetection = false;
  let nextScan = 0;
  let nextSync = 0;
  let refreshing: Promise<void> | undefined;
  let generation = 0;

  function trackActivity() {
    if (activityObserver) return;
    activityObserver = new MutationObserver(records => {
      for (const record of records.slice(-100)) {
        if (!record.addedNodes.length) continue;
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
    activityObserver.observe(document.documentElement, { childList: true, subtree: true });
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
    activityObserver?.disconnect();
    activityObserver = undefined;
    panel = undefined;
    picker = undefined;
    session = undefined;
    sessionSignature = '';
    snapshot = undefined;
    language = undefined;
    counted = false;
    explicitDetection = false;
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
    let selected: { match: RuleMatch; result: RuleTest } | undefined;
    const lacking: RuleMatch[] = [];
    for (const match of snapshot.rules) {
      if (invalidateSelector(match.rule)) {
        if (match.staged) {
          decide(match, false);
          snapshot.rules = snapshot.rules.filter(candidate => candidate !== match);
        }
        continue;
      }
      const result = testRule(document, match.rule);
      if (match.staged) {
        if (result && !result.rejected && result.messages.length >= 2) {
          decide(match, true);
          selected = { match, result };
          break;
        }
        lacking.push(match);
        continue;
      }
      if (result && !result.rejected) {
        selected = { match, result };
        break;
      }
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
      if (session) { session.close(); session = undefined; }
      if (snapshot.settings.enabled || explicitDetection) {
        trackActivity();
        const candidate = findCandidate(document, page, frame, activity);
        if (candidate) {
          if (preparePicker().suggest(candidate)) meter.count('automatic');
        } else if (explicitDetection && !picker) {
          preparePicker();
          panel!.show('正在查找弹幕', '还没有找到结构稳定的弹幕。可以等待新消息，也可以直接手动选区。');
          panel!.button('选择弹幕区域', () => picker!.start());
          panel!.button('关闭', () => { explicitDetection = false; picker!.close(); });
        }
      }
      return;
    }
    activityObserver?.disconnect();
    activityObserver = undefined;
    const { match, result } = selected;
    const { enabled, modelConfigured, mode, readingLanguage, revision } = snapshot.settings;
    const signature = JSON.stringify([match.rule, enabled, modelConfigured, mode, readingLanguage, revision]);
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
    if (action === 'refresh') { void refresh(true); return; }
    if (action === 'pick') {
      meter.count('manualPicker');
      preparePicker().start();
      void refresh();
    }
    if (action === 'detect' || action === 'initial-review') {
      explicitDetection = true;
      if (picker) picker.resumeSuggestions();
      void refresh(true).then(() => {
        if (!explicitDetection) return;
        if (session && (action === 'detect' || snapshot?.settings.autoVision)) {
          const current = session.match.rule;
          const existing = testRule(document, current);
          if (existing) preparePicker().showMatched({ ...existing, rule: current, score: 0 }, session.match.source);
        }
      });
    }
    if (action === 'room' && language) {
      const current = language;
      void current.read().then(preference => {
        if (language !== current) return;
        preparePicker();
        const info = current.context();
        panel!.show('当前直播间', [info.title, info.streamer, lastError].filter(Boolean).join(' · ') ||
          '设置未来生成回复时默认用的语言。');
        const value = panel!.languageInput(preference?.language ?? null);
        panel!.button('保存语言', () => {
          const raw = value.value.trim();
          if (!/^[a-z]{2,8}(?:-[a-z0-9]{2,8})*$/i.test(raw) || raw.length > 48) {
            panel!.note('请填写语言代码，例如 ja 或 zh-CN。');
            return;
          }
          void current.set(raw).then(() => panel?.note('已保存。'), error => panel?.note(String(error.message)));
        });
        panel!.button('清除记忆', () => { void current.set(null).then(() => { value.value = ''; panel?.note('已清除。'); }); });
        panel!.button('关闭', () => picker!.close());
      }).catch(() => undefined);
    }
  }

  const listener = (message: { pageAction?: string }, sender: chrome.runtime.MessageSender, respond: (value: boolean) => void) => {
    if (sender.id !== chrome.runtime.id || typeof message?.pageAction !== 'string' || !synchronize()) return;
    if (message.pageAction !== 'ping') activate(message.pageAction);
    respond(true);
  };
  chrome.runtime.onMessage.addListener(listener);
  const timer = setInterval(tick, 850);
  window.addEventListener('pagehide', () => { session?.close(); session = undefined; void meter.flush(); }, { signal });
  signal.addEventListener('abort', () => {
    clearInterval(timer);
    chrome.runtime.onMessage.removeListener(listener);
    delete context[marker];
    reset();
  }, { once: true });
  tick();
}
