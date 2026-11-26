import assert from 'node:assert/strict';
import test from 'node:test';
import { alignTranslations, createTasks } from '../../src/models/tasks';
import { taskInstructions, wordingPreference } from '../../src/models/prompts';
import { generateDraft } from '../../src/agent/tasks/draft';
import { defaults, parseEndpoint, parseRegistry, readingLanguage } from '../../src/platform/config';
import { normalizeLanguage } from '../../src/rooms/language-input';
import { effectiveScope, scopeOptions, scopeValue } from '../../src/platform/translation-scope';
import { parseCommand } from '../../src/platform/messages';
import { decideRule, resolveRules, stageRules } from '../../src/rules/resolver';
import { ruleIndex, type ChatRule } from '../../src/rules/schema';
import { updateUsage } from '../../src/usage/usage';
import { Scheduler } from '../../src/translation/scheduler';

const seed: ChatRule = {
  schemaVersion: 1, id: 'chat', version: 1, host: 'www.youtube.com',
  framePathPrefix: '/live_chat', container: '#chat', message: '.row', body: '.text',
};
const state = { active: [seed], staged: [], rejected: {} };
const page = new URL('https://www.youtube.com/watch?v=fixture');
const frame = new URL('https://www.youtube.com/live_chat?v=fixture');

test('reading language follows Chrome unless the user overrides it', () => {
  assert.equal(readingLanguage('', 'pt_BR'), 'pt-BR');
  assert.equal(readingLanguage('ja', 'pt-BR'), 'ja');
  assert.equal(readingLanguage('', ''), 'en');
});

test('prompt templates follow the interface locale while preserving custom instructions', () => {
  const prefs = { ...defaults, readingLanguage: 'ja', uiLanguage: 'zh-CN' };
  assert.match(taskInstructions('translation', prefs), /把每条弹幕翻译成 targetLanguage/);
  assert.match(taskInstructions('translation', { ...prefs, uiLanguage: 'fr-FR' }), /Translate each item into targetLanguage/);
  assert.match(taskInstructions('translation', { ...prefs, systemPrompts: { translation: 'Keep proper names' } }), /^Keep proper names/);
  assert.equal(wordingPreference('Use polite Korean', 'zh-CN'), 'Use polite Korean');
});

test('room language accepts native names and common aliases', () => {
  for (const input of ['日语', '日本語', 'Japanese', 'jp', 'ja']) assert.equal(normalizeLanguage(input), 'ja');
  assert.equal(normalizeLanguage('zh_tw'), 'zh-TW');
  assert.equal(normalizeLanguage('the language the host is using'), undefined);
});

test('two scopes follow the YouTube livestream ID while preserving a legacy page switch until edited', async () => {
  const watch = new URL('https://www.youtube.com/watch?v=stream-a');
  const direct = new URL('https://www.youtube.com/live/stream-a');
  const another = new URL('https://www.youtube.com/watch?v=stream-b');
  const initial = await scopeOptions(watch, [], {});
  const room = initial.find(option => option.scope === 'room')!.key;
  const page = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('page|' + watch.href))).toString('hex');
  assert.deepEqual(initial.map(option => option.scope), ['room', 'site']);
  const legacy = await scopeOptions(watch, [watch.origin], { [page]: false });
  assert.equal(effectiveScope(legacy)?.value, false);
  assert.equal(effectiveScope(legacy)?.usesLegacyPageSetting, true);
  const overrides = { [room]: true, [page]: false };
  assert.equal(effectiveScope(await scopeOptions(watch, [], overrides))?.value, true);
  assert.equal(effectiveScope(await scopeOptions(direct, [], overrides))?.value, true);
  assert.equal(effectiveScope(await scopeOptions(another, [], overrides))?.value, false);
  assert.equal(scopeValue(await scopeOptions(watch, [], overrides), 'room'), true);
  const reset = await scopeOptions(watch, [watch.origin], { ...overrides, [room]: null });
  assert.equal(effectiveScope(reset)?.scope, 'site');
  const generic = await scopeOptions(new URL('https://stream.example/view/demo'), [], {});
  assert.deepEqual(generic.map(option => option.scope), ['room', 'site']);
  assert.equal(generic[0]?.usesPageLink, true);
});

test('local rules outrank staged, active and bundled rules', () => {
  const second = { ...seed, version: 2, body: '.new-body' };
  const staged = stageRules(state, [second]);
  const local = { ...seed, id: 'personal' };
  assert.deepEqual(resolveRules(page, frame, [local], staged).map(result => result.rule.id),
    ['personal', 'chat', 'chat', 'youtube-live']);
  assert.equal(resolveRules(page, new URL('https://example.net/live_chat'), [local], staged).length, 0);
  const otherRoom = { ...local, pathPrefix: '/live/another' };
  assert.equal(resolveRules(page, frame, [otherRoom], staged)[0]?.sameSiteFallback, true);
  assert.ok(!resolveRules(page, page, [otherRoom], staged).some(result => result.sameSiteFallback));
});

test('failed community candidate rolls back and is not downloaded as pending again', () => {
  const second = { ...seed, version: 2 };
  const third = { ...seed, version: 3 };
  const rejected = decideRule(stageRules(state, [second]), seed.id, 2, false);
  assert.deepEqual(rejected.active, [seed]);
  assert.deepEqual(stageRules(rejected, [second]).staged, []);
  assert.deepEqual(decideRule(stageRules(rejected, [third]), seed.id, 3, true).active, [third]);
});

test('remote rules and messages are bounded and declarative', () => {
  assert.equal(ruleIndex.safeParse({ schemaVersion: 1, rules: [seed, seed] }).success, false);
  assert.equal(ruleIndex.safeParse({ schemaVersion: 1, rules: [{ ...seed, script: 'invalid' }] }).success, false);
  assert.equal(parseCommand({ kind: 'translate', payload: { revision: 0, items: [{ id: 'item', text: 'x'.repeat(601) }] } }), undefined);
  assert.equal(parseCommand({ kind: 'toString' }), undefined);
});

test('model and registry URLs keep credentials out of arbitrary HTTP or redirected origins', () => {
  for (const url of ['file:///tmp/key', 'https://test:pass@example.org', 'http://example.org', 'https://example.org/?secret=1']) {
    assert.throws(() => parseEndpoint(url));
  }
  assert.equal(parseEndpoint('http://127.0.0.1:9000/v1').pathname, '/v1');
  assert.throws(() => parseRegistry('https://github.com/example/rules/blob/main/rules/index.json'));
  assert.equal(parseRegistry('https://raw.githubusercontent.com/example/rules/main/rules/index.json').hostname, 'raw.githubusercontent.com');
});

test('structured results use IDs, reject unknown and duplicate IDs, and allow partial batches', () => {
  const input = [{ id: 'a', text: 'one' }, { id: 'b', text: 'two' }];
  const format = (...ids: string[]) => ({ translations: ids.map(id => ({ id, text: id + '译文' })) });
  assert.deepEqual(alignTranslations(input, format('b', 'a')).map(item => item.id), ['a', 'b']);
  assert.deepEqual(alignTranslations(input, format('b')).map(item => item.id), ['b']);
  assert.throws(() => alignTranslations(input, format('a', 'a')));
  assert.throws(() => alignTranslations(input, format('z')));
});

test('provider retries empty output once and records tokens for both attempts', async () => {
  const events: Array<{ success: boolean; inputTokens: number }> = [];
  const bodies: object[] = [];
  const request: typeof fetch = async (url, options) => {
    assert.equal(url, 'https://api.deepseek.com/chat/completions');
    assert.equal(options?.redirect, 'error');
    bodies.push(JSON.parse(String(options?.body)));
    const content = bodies.length === 1 ? ' ' : '{"translations":[{"id":"a","text":"好的"}]}';
    return Response.json({ choices: [{ message: { content } }], usage: { prompt_tokens: 42 } });
  };
  const tasks = createTasks(async (_task, success, _elapsed, usage) => { events.push({ success, ...usage }); }, request);
  assert.deepEqual(await tasks.translate(defaults, [{ id: 'a', text: 'OK' }]), [{ id: 'a', text: '好的' }]);
  assert.deepEqual(events.map(event => [event.success, event.inputTokens]), [[false, 42], [true, 42]]);
});

test('an empty visual result spends at most one request', async () => {
  let calls = 0;
  const tasks = createTasks(async () => undefined, async () => {
    calls++;
    return Response.json({ choices: [{ message: { content: ' ' } }] });
  });
  await assert.rejects(tasks.vision(defaults, 'data:image/png;base64,fixture', {}), /empty answer/);
  assert.equal(calls, 1);
});

test('JSON mode is automatic and a provider rejecting the format uses validated prompt output', async () => {
  const formats: unknown[] = [];
  const tasks = createTasks(async () => undefined, async (_url, options) => {
    const body = JSON.parse(String(options?.body));
    formats.push(body.response_format);
    if (body.response_format) {
      return Response.json({ error: { message: 'Unknown parameter: response_format' } }, { status: 400 });
    }
    return Response.json({ choices: [{ message: { content: '{"translations":[{"id":"a","text":"text"}]}' } }] });
  });
  const input = [{ id: 'a', text: 'OK' }];
  const settings = { ...defaults, model: { ...defaults.model, jsonMode: false } };
  assert.deepEqual(await tasks.translate(settings, input), [{ id: 'a', text: 'text' }]);
  assert.deepEqual(await tasks.translate(settings, input), [{ id: 'a', text: 'text' }]);
  assert.deepEqual(formats, [{ type: 'json_object' }, undefined, undefined]);
});

test('scheduler invalidates stale results and reuses identical text within a batch and in its cache', async () => {
  const calls: Array<Array<{ id: string; text: string }>> = [];
  const received: string[] = [];
  const counted: string[] = [];
  let release!: () => void;
  const started = new Promise<void>(resolve => { release = resolve; });
  let finish!: () => void;
  const input = new Promise<void>(resolve => { finish = resolve; });
  const scheduler = new Scheduler(async items => {
    calls.push(items);
    release();
    await input;
    return items.map(item => ({ ...item, text: '中文' }));
  }, 'batch', kind => counted.push(kind), assert.fail);
  const job = (id: string, available = () => true) => ({
    id, text: 'same', available, visible: () => true, accept: () => received.push(id),
  });
  let valid = true;
  scheduler.add(job('a', () => valid));
  scheduler.add(job('b'));
  await started;
  valid = false;
  finish();
  await new Promise(resolve => setTimeout(resolve, 30));
  scheduler.add(job('c'));
  scheduler.close();
  assert.deepEqual(calls, [[{ id: 'a', text: 'same' }]]);
  assert.deepEqual(received, ['b', 'c']);
  assert.deepEqual(counted, ['expired', 'cached', 'cached']);
});

test('local usage retains at most the last 30 days and Agent drafts use remembered language', async () => {
  const start = updateUsage([], day => { day.page.sessions = 1; }, new Date(2026, 8, 1));
  const latest = updateUsage(start, day => { day.page.rendered = 3; }, new Date(2026, 10, 26));
  assert.deepEqual(latest, [{ date: '2026-11-26', page: { rendered: 3 }, models: {} }]);
  const output = await generateDraft({ draft: async (_settings, context, intent, language) => {
    assert.equal(language, 'ja');
    assert.equal(intent, '问问主播');
    assert.deepEqual(context, { title: 'live', streamer: null, category: null, recentChat: ['nice'] });
    return { draft: 'どうでしたか？', backTranslation: '刚才感觉如何？' };
  } }, defaults, {
    room: { title: 'live', streamer: null, category: null, replyLanguage: 'ja' },
    messages: [{ observedAt: 0, text: 'nice' }],
  }, ' 问问主播 ');
  assert.match(output.draft, /？/);
});
