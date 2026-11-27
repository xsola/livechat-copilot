import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { chromium } from 'playwright';

const fixture = name => readFile(new URL('../fixtures/' + name, import.meta.url), 'utf8');

async function boot(t, locale = 'zh-CN') {
  const requestLog = [];
  const server = createServer(async (request, response) => {
    if (request.method === 'GET') {
      response.writeHead(200, { 'Content-Type': 'text/html' }).end(await fixture('youtube-chat.html'));
      return;
    }
    let body = '';
    for await (const chunk of request) body += chunk;
    const value = JSON.parse(body);
    requestLog.push(value);
    const content = value.messages[1].content;
    const command = JSON.parse(Array.isArray(content) ? content[0].text : content);
    if (Array.isArray(content) && (value.model === 'test-text-only' ||
      (value.model === 'test-runtime-image-rejection' && command.test !== 'image-capability'))) {
      response.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({
        error: { message: 'This model does not support image input.', code: 'image_input_unsupported' },
      }));
      return;
    }
    const items = command.items ?? [];
    if (command.draft === 'Slow original' || items.some(item => item.text === 'Slow original')) {
      await new Promise(resolve => setTimeout(resolve, 900));
    }
    if (command.candidates || (command.sample && value.model === 'test-review-mixed')) {
      await new Promise(resolve => setTimeout(resolve, 650));
    }
    const output = command.candidates ? {
      candidateId: command.candidates[/^test-paired-(input|body)$/.test(value.model) ? 1 : 0].id,
      useComposer: true, bodyVerdict: 'clean', reason: 'Image matches the sample rows.',
    }
      : command.test === 'image-capability' ? { color: 'blue' }
      : Array.isArray(content) ? { verdict: 'likely-chat',
        reason: value.model === 'test-review-mixed' && command.language.startsWith('zh') ? '测试：已确认是弹幕列表。' : 'Synthetic region confirmed.',
        bodyVerdict: value.model === 'test-review-mixed' ? 'mixed-metadata' : 'clean',
        composerVerdict: command.sample.editorImage ? 'likely-composer' : 'unlikely-composer' }
      : items.length ? { translations: items.map(({ id, text }) => ({ id, text: '译：' + text })) }
      : command.languageInput ? { language: 'ja' }
      : command.draft ? { translation: '訳: ' + command.draft }
      : command.intent ? { draft: 'すごい逆転！', backTranslation: '好精彩的逆转！' }
      : command.mode ? { summary: '大家在讨论最后一波。', points: [{ text: '有人称赞逆转。', evidence: [1] }] }
      : command.question ? command.question.includes('at the end') ? { intent: 'live' }
        : { intent: 'general', answer: '「お疲れさま」是一种常用说法。' }
      : command.check ? { ok: true } : { language: 'en', title: null, streamer: null, category: null };
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
      choices: [{ message: { content: JSON.stringify(output) } }],
      usage: { prompt_tokens: 11, completion_tokens: 5 },
    }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const root = await mkdtemp(path.join(tmpdir(), 'livechat-copilot-e2e-'));
  let context;
  t.after(async () => {
    try {
      await context?.close();
      await new Promise(resolve => server.close(resolve));
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  });
  const built = path.resolve('dist/chrome-mv3');
  const unpacked = path.join(root, 'extension');
  await cp(built, unpacked, { recursive: true });
  const manifestPath = path.join(unpacked, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  // Pre-grant test-only origins so browser permission prompts don't affect the fixtures.
  manifest.host_permissions.push('http://127.0.0.1/*', 'https://raw.githubusercontent.com/*');
  manifest.host_permissions.push('<all_urls>');
  await writeFile(manifestPath, JSON.stringify(manifest));
  context = await chromium.launchPersistentContext(path.join(root, 'profile'), {
    channel: 'chromium', headless: true, viewport: { width: 1050, height: 900 }, locale,
    args: ['--disable-extensions-except=' + unpacked, '--load-extension=' + unpacked, '--lang=' + locale],
  });
  const [starting] = context.serviceWorkers();
  const worker = starting ?? await context.waitForEvent('serviceworker', { timeout: 15_000 });
  const origin = 'chrome-extension://' + new URL(worker.url()).hostname;
  const program = await fixture('youtube-watch.html');
  const messages = await fixture('youtube-chat.html');
  await context.route('https://www.youtube.com/**', route => route.fulfill({
    contentType: 'text/html',
    body: route.request().url().includes('/live_chat?') ? messages : program,
  }));
  const twitch = await fixture('twitch-chat.html');
  await context.route('https://www.twitch.tv/**', route => {
    const { pathname } = new URL(route.request().url());
    return route.fulfill({ contentType: 'text/html', body: pathname === '/demochannel' ? twitch : '<main>Browse Twitch</main>' });
  });
  const options = await context.newPage();
  await options.goto(origin + '/options.html');
  await options.locator('#model').waitFor();
  await options.locator('#model').fill('test-model');
  await options.locator('#endpoint').fill('http://127.0.0.1:' + server.address().port + '/v1');
  await options.getByRole('button', { name: '保存并授权' }).click();
  await options.getByText('已保存。', { exact: true }).waitFor();
  await command(options, 'setSkipReadingLanguage', false);
  return { context, worker, origin, options, requestLog, local: 'http://127.0.0.1:' + server.address().port };
}

function command(options, kind, payload) {
  return options.evaluate(async args => {
    const result = await chrome.runtime.sendMessage(args);
    if (!result.ok) throw new Error(result.error);
    return result.value;
  }, { kind, payload });
}

function tabId(options, url) {
  return options.evaluate(async url => {
    const tab = (await chrome.tabs.query({})).find(tab => tab.url === url);
    if (!tab) throw new Error('Fixture tab is missing.');
    return tab.id;
  }, url);
}

function action(options, tab, pageAction) {
  if (pageAction !== 'refresh') return command(options, 'pageCommand', { tabId: tab, action: pageAction });
  return options.evaluate(({ tab, pageAction }) => chrome.tabs.sendMessage(tab, { pageAction }), { tab, pageAction });
}

async function until(check) {
  for (let i = 0; i < 55; i++) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  assert.fail('Expected asynchronous state was not reached.');
}

test('the visible dist directory loads without modifying the manifest', { timeout: 25_000 }, async t => {
  const unpacked = path.resolve('dist/chrome-mv3');
  const manifest = JSON.parse(await readFile(path.join(unpacked, 'manifest.json'), 'utf8'));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.default_locale, 'en');
  assert.equal(manifest.side_panel, undefined);
  assert.ok(manifest.permissions.includes('sidePanel'));
  assert.equal(manifest.host_permissions.includes('<all_urls>'), false);
  assert.equal(manifest.action.default_icon['16'], 'icons/icon-16.png');
  assert.equal((await readFile(path.join(unpacked, manifest.icons['128']))).readUInt32BE(16), 128);
  const root = await mkdtemp(path.join(tmpdir(), 'livechat-copilot-install-'));
  let context;
  t.after(async () => {
    try { await context?.close(); }
    finally { await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
  });
  context = await chromium.launchPersistentContext(root, {
    channel: 'chromium', headless: true,
    args: ['--disable-extensions-except=' + unpacked, '--load-extension=' + unpacked],
  });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker', { timeout: 12_000 });
  assert.equal(await worker.evaluate(() => chrome.runtime.getManifest().name), 'LiveChat Copilot');
});

test('YouTube restricted input is recognized without inferring a send-area mismatch', { timeout: 40_000 }, async t => {
  const { context, options, requestLog } = await boot(t);
  await options.getByRole('button', { name: '测试当前模型' }).click();
  await options.getByText('支持', { exact: true }).waitFor();
  await options.locator('#auto-vision').check();
  await options.getByRole('button', { name: '保存并授权' }).click();
  const live = await context.newPage();
  await live.goto('https://www.youtube.com/watch?v=restricted');
  await live.bringToFront();
  const chat = live.frameLocator('#chatframe');
  await chat.locator('body').evaluate(body => {
    const area = document.createElement('yt-live-chat-message-input-renderer');
    area.innerHTML = '<div id="input" role="textbox" aria-disabled="true">以订阅者的身份聊天</div>';
    body.prepend(area);
  });
  const tab = await tabId(options, live.url());
  await action(options, tab, 'detect');
  await chat.getByText('已找到输入区，当前无法编辑。', { exact: false }).waitFor();
  await chat.getByText('可能是弹幕区', { exact: true }).waitFor();
  assert.equal(await chat.getByText('发送区可能不匹配', { exact: false }).count(), 0);
  const payloads = () => requestLog.flatMap(body => {
    const content = body.messages[1].content;
    return Array.isArray(content) ? [JSON.parse(content[0].text).sample].filter(Boolean) : [];
  });
  assert.equal(payloads()[0].editorImage, false);
  await chat.locator('yt-live-chat-message-input-renderer').evaluate(area => {
    area.innerHTML = '<div id="input" contenteditable="true" style="height:28px"></div><div id="send-button"><button>Send</button></div>';
  });
  await action(options, tab, 'detect');
  await chat.getByText('已找到输入区和发送按钮。', { exact: false }).waitFor();
  await chat.getByText('发送区可能匹配', { exact: false }).waitFor();
  assert.equal(payloads()[1].editorImage, true);
  assert.equal(payloads()[1].sendImage, true);
});

test('YouTube assistant previews, fills and restores native drafts, handles stale input and runs on-demand Agent tasks',
  { timeout: 45_000 }, async t => {
    const { context, options, origin, requestLog } = await boot(t);
    const live = await context.newPage();
    await live.goto('https://www.youtube.com/watch?v=assistant');
    const chat = live.frameLocator('#chatframe');
    await chat.locator('body').evaluate(body => {
      const area = document.createElement('yt-live-chat-message-input-renderer');
      area.innerHTML = '<div id="input" contenteditable="" style="min-height:28px">Good game!</div>' +
        '<div id="send-button"><button>Send</button></div>';
      body.querySelector('yt-live-chat-item-list-renderer').after(area);
      body.dataset.sent = '0';
      area.querySelector('button').addEventListener('click', () => { body.dataset.sent = '1'; });
      const list = body.querySelector('#items');
      for (const text of ['That comeback!', 'A close final', 'Great play at the end', 'What a tournament']) {
        const row = document.createElement('yt-live-chat-text-message-renderer');
        row.innerHTML = '<span id="author-name">Test metadata</span><span id="message"></span>';
        row.querySelector('#message').textContent = text;
        list.append(row);
      }
    });
    const panel = await context.newPage();
    await panel.setViewportSize({ width: 340, height: 780 });
    await panel.goto(origin + '/sidepanel.html');
    await live.bringToFront();
    await panel.getByText('已找到直播输入框', { exact: true }).waitFor();
    await panel.locator('#re-detect').click();
    await chat.locator('[data-livechat-copilot="composer"]').waitFor();
    assert.equal(await chat.locator('[data-livechat-copilot="composer"]').evaluate(el => getComputedStyle(el).borderTopColor), 'rgb(21, 128, 61)');
    await panel.locator('#read-draft').click();
    await until(async () => await panel.locator('#source').inputValue() === 'Good game!');
    await panel.locator('#reply-language').fill('jp');
    await panel.locator('#save-language').click();
    await panel.locator('#language-note').getByText('日语', { exact: false }).waitFor();
    await panel.locator('#run-task').click();
    await until(async () => await panel.locator('#result').inputValue() === '訳: Good game!');
    assert.equal(await panel.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.equal(await chat.locator('#input').innerText(), 'Good game!');
    await panel.locator('#apply').click();
    await until(async () => await chat.locator('#input').innerText() === '訳: Good game!');
    assert.equal(await chat.locator('body').getAttribute('data-sent'), '0');
    await panel.locator('#undo').click();
    await until(async () => await chat.locator('#input').innerText() === 'Good game!');

    await chat.locator('#input').fill('Slow original');
    await panel.locator('#read-draft').click();
    await until(async () => await panel.locator('#source').inputValue() === 'Slow original');
    await panel.locator('#run-task').click();
    await until(() => requestLog.some(body => JSON.parse(body.messages[1].content).draft === 'Slow original'));
    await chat.locator('#input').fill('I edited my draft');
    await until(async () => await panel.locator('#result').inputValue() === '訳: Slow original');
    await panel.locator('#apply').click();
    await panel.getByText('输入内容已变化', { exact: false }).waitFor();
    assert.equal(await chat.locator('#input').innerText(), 'I edited my draft');
    assert.equal(await panel.locator('#apply').isDisabled(), true);

    await panel.locator('#pick-composer').click();
    await panel.getByText('请到直播页面点击实际输入框', { exact: false }).waitFor();
    await chat.locator('#chat-editor').hover();
    await chat.locator('[data-livechat-copilot="composer"]').waitFor({ state: 'visible' });
    await chat.locator('#chat-editor').click();
    await panel.getByText('已选中可编辑的输入框', { exact: false }).waitFor();
    assert.equal(Object.keys((await options.evaluate(() => chrome.storage.local.get('composerBindings'))).composerBindings ?? {}).length, 0);
    await panel.locator('#confirm-pick').click();
    await panel.getByText('正在使用你确认的输入框', { exact: true }).waitFor();
    const saved = await options.evaluate(() => chrome.storage.local.get(['composerBindings', 'localRules']));
    assert.equal(Object.values(saved.composerBindings)[0].selector, '#chat-editor');
    assert.equal(saved.localRules?.length ?? 0, 0);

    await panel.locator('[data-mode="draft"]').click();
    await panel.locator('#source').fill('Praise the comeback');
    await panel.locator('#tone').selectOption('polite');
    await panel.locator('#run-task').click();
    await until(async () => await panel.locator('#result').inputValue() === 'すごい逆転！');
    assert.equal(await panel.locator('#comparison').textContent(), '好精彩的逆转！');
    await panel.locator('#apply').click();
    await until(async () => await chat.locator('#chat-editor').inputValue() === 'すごい逆転！');
    await panel.locator('#undo').click();
    await until(async () => await chat.locator('#chat-editor').inputValue() === '');
    await panel.locator('[data-mode="analysis"]').click();
    await panel.locator('#source').fill('What happened at the end?');
    await panel.locator('#run-task').click();
    await panel.getByText('大家在讨论最后一波。', { exact: true }).waitFor();
    await panel.locator('#evidence summary').click();
    assert.match(await panel.locator('#evidence blockquote').textContent(), /Amazing comeback/);
    const calls = requestLog.map(body => JSON.parse(body.messages[1].content));
    const draftCall = calls.find(call => call.intent);
    assert.equal(draftCall.replyLanguage, 'ja');
    assert.equal(draftCall.tone, 'polite');
    assert.match(draftCall.context.recentChat.join(' '), /A close final/);
    assert.doesNotMatch(JSON.stringify(draftCall), /Test metadata|OriginalAuthor/);
    assert.equal(calls.find(call => call.draft === 'Good game!').context, undefined);
    assert.equal(calls.find(call => call.mode === 'question').context.messages.length, 6);
    assert.equal(calls.find(call => !call.mode && call.question === 'What happened at the end?').context, undefined);
    await panel.locator('[data-suggestion="topics"]').click();
    assert.match(await panel.locator('#source').inputValue(), /刚才在聊什么/);
    await panel.locator('#run-task').click();
    await until(() => requestLog.some(({ messages }) => JSON.parse(messages[1].content).mode === 'topics'));
    await panel.locator('#reset-composer').click();
    await panel.getByText('已找到直播输入框', { exact: true }).waitFor();
    const tab = await tabId(options, live.url());
    const ready = await command(panel, 'assistantPage', { tabId: tab, operation: { action: 'inspect' } });
    await chat.locator('#input').dispatchEvent('compositionstart');
    const composing = await command(panel, 'assistantPage', { tabId: tab, frameId: ready.frameId, operation: {
      action: 'apply', pageToken: ready.page.pageToken, ticket: ready.page.composer.ticket, text: 'During composition',
    } });
    assert.equal(composing.kind, 'conflict');
    assert.equal(await chat.locator('#input').innerText(), 'I edited my draft');
    await chat.locator('#input').dispatchEvent('compositionend');
    await chat.locator('#input').evaluate(node => node.setAttribute('aria-readonly', 'true'));
    const before = await command(panel, 'assistantPage', { tabId: tab, operation: { action: 'inspect' } });
    assert.equal(before.page.composer.state, 'unavailable');
    await live.goto('https://www.youtube.com/watch?v=next-room');
    const stale = await command(panel, 'assistantPage', { tabId: tab, frameId: before.frameId, operation: {
      action: 'apply', pageToken: before.page.pageToken, ticket: before.page.pageToken, text: 'An old reply',
    } });
    assert.equal(stale.kind, 'conflict');
  });

test('a question outside a stream uses no page context', { timeout: 30_000 }, async t => {
  const { context, origin, requestLog } = await boot(t);
  const page = await context.newPage();
  await page.goto('about:blank');
  const panel = await context.newPage();
  await panel.goto(origin + '/sidepanel.html');
  await page.bringToFront();
  await panel.locator('#source').fill('How do you say good work in Japanese?');
  await panel.locator('#run-task').click();
  await panel.getByText('「お疲れさま」是一种常用说法。', { exact: true }).waitFor();
  const requests = requestLog.map(body => JSON.parse(body.messages[1].content));
  assert.equal(requests.length, 1);
  assert.deepEqual(Object.keys(requests[0]).sort(), ['question', 'readingLanguage']);
});

test('YouTube can locate an input outside the live chat frame and keep the chat route', { timeout: 30_000 }, async t => {
  const { context, options } = await boot(t);
  const live = await context.newPage();
  await live.goto('https://www.youtube.com/watch?v=split-frames');
  await live.bringToFront();
  await live.locator('#chatframe').evaluate(chat => {
    const area = document.createElement('yt-live-chat-message-input-renderer');
    area.innerHTML = '<label><span>Chat placeholder</span><textarea aria-label="Chat input"></textarea></label>';
    chat.after(area);
  });
  const tab = await tabId(options, live.url());
  const result = await command(options, 'assistantPage', { tabId: tab, operation: { action: 'detect' } });
  assert.equal(result.frameId, 0);
  assert.equal(result.page.composer.state, 'ready');
  assert.ok(result.chat.frameId > 0);
  await live.locator('[data-livechat-copilot="composer"]').waitFor({ state: 'visible' });
});

test('toolbar preferences keep A and B separate for both the panel and translation language', { timeout: 40_000 }, async t => {
  const { context, options, origin } = await boot(t);
  const a = await context.newPage();
  await a.goto('https://www.youtube.com/watch?v=one');
  const b = await context.newPage();
  await b.goto('https://www.youtube.com/watch?v=two');
  const aId = await tabId(options, a.url());
  const bId = await tabId(options, b.url());
  const popup = await context.newPage();
  await a.bringToFront();
  await popup.goto(origin + '/popup.html');
  await until(() => popup.locator('#assistant').isEnabled());
  const enabled = id => options.evaluate(tabId => chrome.sidePanel.getOptions({ tabId }), id);
  assert.equal((await enabled(aId)).path, 'sidepanel.html?tabId=' + aId);
  assert.equal((await enabled(bId)).path, undefined);
  await popup.locator('#target-language').fill('日本語');
  await popup.locator('#save-target-language').click();
  await popup.getByText('已保存此直播间的译文语言。', { exact: true }).waitFor();
  await b.bringToFront();
  await popup.reload();
  await until(() => popup.locator('#assistant').isEnabled());
  assert.equal(await popup.locator('#target-language').inputValue(), '');
  await popup.locator('#target-language').fill('English');
  await popup.locator('#save-target-language').click();
  await popup.getByText('已保存此直播间的译文语言。', { exact: true }).waitFor();
  assert.equal((await command(options, 'site', aId)).targetLanguage, 'ja');
  assert.equal((await command(options, 'site', bId)).targetLanguage, 'en');
  assert.equal((await command(options, 'getSettings')).settings.readingLanguage, '');
  await popup.locator('#reset-target-language').click();
  await until(async () => (await command(options, 'site', bId)).targetLanguage === '');
  assert.equal((await command(options, 'site', aId)).targetLanguage, 'ja');
});

test('automatic review shows a body warning separately from a successful region match', { timeout: 35_000 }, async t => {
  const { context, options, requestLog } = await boot(t);
  const { browserLanguage, settings } = await command(options, 'getSettings');
  await command(options, 'saveReadingSettings', { readingLanguage: 'ja', mode: settings.mode, prompt: settings.prompt });
  await options.locator('#model').fill('test-review-mixed');
  await options.getByRole('button', { name: '测试当前模型' }).click();
  await options.getByText('支持', { exact: true }).waitFor();
  await options.locator('#auto-vision').check();
  await options.getByRole('button', { name: '保存并授权' }).click();
  await options.getByText('已保存。', { exact: true }).waitFor();
  const live = await context.newPage();
  await live.goto('https://www.youtube.com/watch?v=review');
  await live.bringToFront();
  const tab = await tabId(options, live.url());
  await command(options, 'setSite', { tabId: tab, enabled: true, origin: 'https://www.youtube.com' });
  await live.frameLocator('#chatframe').getByText('译：Amazing comeback', { exact: true }).waitFor();
  await action(options, tab, 'detect');
  const panel = live.frameLocator('#chatframe').getByRole('region', { name: 'LiveChat Copilot' });
  await panel.getByText('截图核验 · 正在核验', { exact: true }).waitFor();
  await panel.getByText('截图核验 · 请核对', { exact: true }).waitFor();
  await panel.getByText('可能是弹幕区', { exact: true }).waitFor();
  await panel.getByText(/提取样本可能带有昵称/).waitFor();
  const review = requestLog.find(({ messages }) => Array.isArray(messages[1].content) && JSON.parse(messages[1].content[0].text).sample);
  assert.equal(JSON.parse(review.messages[1].content[0].text).language, browserLanguage);
  assert.match(review.messages[0].content, /分别判断区域和正文/);
  assert.ok(requestLog.some(({ messages }) => typeof messages[1].content === 'string' &&
    JSON.parse(messages[1].content).targetLanguage === 'ja' && messages[1].content.includes('Amazing comeback')));
  const explanation = panel.getByText('测试：已确认是弹幕列表。', { exact: true });
  assert.equal(await explanation.isVisible(), false);
  await panel.getByText('查看模型说明', { exact: true }).click();
  await explanation.waitFor();
  await live.reload();
  await action(options, tab, 'detect');
  await panel.getByRole('button', { name: '跳过核验' }).click();
  await panel.getByText('已跳过核验。请自行确认当前规则。', { exact: true }).waitFor();
});

test('YouTube iframe translates incrementally, saves a manual override, and reuses it after reload', { timeout: 65_000 }, async t => {
  const { context, options, origin, requestLog } = await boot(t);
  const live = await context.newPage();
  const pageErrors = [];
  live.on('pageerror', error => pageErrors.push(error.message));
  live.on('console', message => { if (message.type() === 'error') pageErrors.push(message.text()); });
  await live.goto('https://www.youtube.com/watch?v=one');
  const chat = live.frameLocator('#chatframe');
  await chat.getByText('Amazing comeback').waitFor();
  const tab = await tabId(options, live.url());
  assert.equal(requestLog.length, 0);
  const popup = await context.newPage();
  await live.bringToFront();
  await popup.goto(origin + '/popup.html');
  await popup.locator('#enabled').check();
  await popup.getByText('已启用。').waitFor();
  await chat.getByText('译：Amazing comeback', { exact: true }).waitFor({ timeout: 7500 }).catch(async error => {
    const contents = await chat.locator('#items').innerText();
    const usage = await command(options, 'usageSummary');
    throw new Error(JSON.stringify({ contents, usage, requestLog, pageErrors }), { cause: error });
  });
  assert.ok(requestLog.some(body => JSON.stringify(body).includes('Amazing comeback')));
  assert.ok(requestLog.every(body => !JSON.stringify(body).includes('OriginalAuthor')));

  const rows = chat.locator('#items yt-live-chat-text-message-renderer');
  assert.ok(requestLog.every(body => !/🎉|ファイトー|🇯🇵/u.test(JSON.stringify(body))));
  assert.equal(await rows.nth(2).locator('[data-lcc-kind="translation"]').count(), 0);
  const alignment = await rows.first().evaluate(row => {
    const original = row.querySelector('#message').getClientRects()[0];
    const translated = row.querySelector('[data-lcc-kind="translation"]').getBoundingClientRect();
    return { offset: Math.abs(original.left - translated.left), below: translated.top > original.top };
  });
  assert.ok(alignment.offset < 1 && alignment.below, JSON.stringify(alignment));
  await popup.getByRole('checkbox', { name: '翻译表情（所有直播间）' }).check();
  await chat.getByText('译：Amazing comeback 🎉', { exact: true }).waitFor();
  await chat.getByText('译：ファイトー 🇯🇵', { exact: true }).waitFor();
  await popup.getByRole('checkbox', { name: '翻译表情（所有直播间）' }).uncheck();
  await chat.getByText('译：Amazing comeback', { exact: true }).waitFor();
  await rows.first().locator('#message').evaluate(node => { node.textContent = 'Slow original'; });
  await until(() => requestLog.some(body => JSON.stringify(body).includes('Slow original')));
  await rows.first().locator('#message').evaluate(node => { node.textContent = 'Fresh content'; });
  await chat.getByText('译：Fresh content').waitFor();
  assert.equal(await chat.getByText('译：Slow original').count(), 0);

  await options.getByRole('button', { name: '测试当前模型' }).click();
  await options.getByText('支持', { exact: true }).waitFor();
  await options.locator('#auto-vision').check();
  await options.getByRole('button', { name: '保存并授权' }).click();
  await options.getByText('已保存。', { exact: true }).waitFor();
  await live.bringToFront();
  await popup.getByRole('button', { name: '手动选择弹幕区' }).click();
  await chat.getByText('点击或按 Enter 确认', { exact: false }).waitFor();
  await chat.getByText('New tournament', { exact: true }).hover();
  await live.keyboard.press('ArrowUp');
  await live.keyboard.press('ArrowUp');
  await live.keyboard.press('Enter');
  await chat.getByRole('button', { name: '保存并启用规则' }).waitFor();
  await chat.getByRole('button', { name: '点一条弹幕正文', exact: true }).click();
  await chat.getByText('New tournament', { exact: true }).hover();
  await chat.getByText('New tournament', { exact: true }).click();
  await chat.getByRole('button', { name: '保存并启用规则' }).waitFor();
  await chat.getByText('Synthetic region confirmed.', { exact: false }).waitFor();
  await chat.getByText('发送区可能匹配', { exact: false }).waitFor();
  assert.ok(requestLog.some(body => JSON.stringify(body).includes('data:image/jpeg;base64,')));
  assert.equal(await chat.getByRole('button', { name: 'AI 复核一次' }).count(), 0);
  await chat.getByRole('button', { name: '保存并启用规则' }).click();
  await chat.getByText('译：New tournament').waitFor();
  await live.reload();
  await chat.getByText('译：New tournament').waitFor();
  assert.equal(await chat.getByText('译：Amazing comeback', { exact: true }).count(), 0);

  await action(options, tab, 'room');
  await chat.locator('input[placeholder="例如日语、Japanese、jp"]').fill('日语');
  await chat.getByRole('button', { name: '保存语言' }).click();
  await chat.getByText('已保存。日语（ja）', { exact: true }).waitFor();
  await live.reload();
  await chat.getByText('译：New tournament').waitFor();
  await action(options, tab, 'room');
  await until(() => chat.locator('input[placeholder="例如日语、Japanese、jp"]').inputValue({ timeout: 1500 }).then(value => value === 'ja'));
  assert.equal(await live.frameLocator('#duplicate-chat').getByText('当前直播间', { exact: true }).count(), 0);
  await live.evaluate(() => {
    history.pushState(null, '', '/watch?v=two');
    document.querySelector('#channel-name a').setAttribute('href', '/@another-channel');
    document.querySelector('iframe').contentDocument.querySelector('#alternate .message-body').textContent = 'Second room';
  });
  await chat.getByText('译：Second room').waitFor();
  assert.equal(await chat.getByText('译：New tournament').count(), 0);
  await action(options, tab, 'room');
  assert.equal(await chat.locator('input[placeholder="例如日语、Japanese、jp"]').inputValue(), '');
  await until(async () => (await command(options, 'usageSummary')).some(day => day.page.manualPicker && day.page.rendered));
  await options.locator('#export').click();
  await until(async () => Boolean(await options.locator('#diagnostic').inputValue()));
  const summary = await options.locator('#diagnostic').inputValue();
  assert.match(summary, /"vision"/);
  assert.doesNotMatch(summary, /Fresh content|OriginalAuthor|youtube\.com|127\.0\.0\.1/);
  await options.getByRole('button', { name: '收起诊断摘要' }).click();
  assert.equal(await options.locator('#diagnostic').isVisible(), false);
  await options.getByRole('button', { name: '预览诊断摘要' }).click();
  assert.equal(await options.locator('#diagnostic').isVisible(), true);
});

test('new site candidates and a staged community rule roll back to the last usable version', { timeout: 65_000 }, async t => {
  const { context, worker, options, local, origin } = await boot(t);
  const live = await context.newPage();
  await live.goto(local + '/live/demo');
  const tab = await tabId(options, live.url());
  const popup = await context.newPage();
  await live.bringToFront();
  await popup.goto(origin + '/popup.html');
  const detect = popup.getByRole('button', { name: '自动识别弹幕区' });
  await detect.waitFor();
  await popup.locator('#scope option').first().waitFor({ state: 'attached' });
  assert.deepEqual(await popup.locator('#scope option').allTextContents(), ['当前直播间', '本站所有直播间']);
  await detect.click();
  await live.getByRole('button', { name: '保存并启用规则' }).waitFor();
  await live.getByRole('button', { name: '关闭', exact: true }).click();

  await worker.evaluate(() => {
    const original = globalThis.fetch;
    globalThis.fixtureVersion = 1;
    globalThis.fetch = (input, init) => {
      if (new URL(input).hostname !== 'raw.githubusercontent.com') return original(input, init);
      const version = globalThis.fixtureVersion;
      return Promise.resolve(Response.json({ schemaVersion: 1, rules: [{
        schemaVersion: 1, id: 'fixture-live', version, host: '127.0.0.1', pathPrefix: '/live/',
        container: '#alternate', message: ':scope > .chat-row', body: version === 1 ? '.message-body' : '.missing',
      }] }));
    };
  });
  const { settings } = await command(options, 'getSettings');
  await command(options, 'saveSettings', { ...settings, registryUrl: 'https://raw.githubusercontent.com/fixture/rules/main/rules/index.json' });
  assert.equal((await command(options, 'syncRegistry')).staged, 1);
  await command(options, 'setSite', { tabId: tab, enabled: true, origin: local });
  await live.getByText('译：New tournament', { exact: true }).waitFor();
  await until(async () => (await command(options, 'getSettings')).rules.active === 1);
  await worker.evaluate(() => { globalThis.fixtureVersion = 2; });
  assert.equal((await command(options, 'syncRegistry')).staged, 1);
  await action(options, tab, 'refresh');
  await until(async () => (await command(options, 'getSettings')).rules.staged === 0);
  assert.equal((await command(options, 'syncRegistry')).staged, 0);
  await live.reload();
  await live.getByText('译：New tournament', { exact: true }).waitFor();
});

test('Twitch finds nested chat, keeps the chosen scope, and leaves no picker on the homepage', { timeout: 45_000 }, async t => {
  const { context, options, origin } = await boot(t);
  const live = await context.newPage();
  let popup;
  const openPopup = async () => {
    if (!popup || popup.isClosed()) popup = await context.newPage();
    await live.bringToFront();
    await popup.goto(origin + '/popup.html');
    await popup.locator('#scope option').first().waitFor({ state: 'attached' });
  };
  await live.goto('https://www.twitch.tv/emptychannel');
  await openPopup();
  await popup.locator('#scope').selectOption('room');
  await popup.getByRole('button', { name: '自动识别弹幕区' }).click();
  await live.getByText('正在识别弹幕区', { exact: true }).waitFor();
  await live.locator('[data-lcc-kind="panel"] .panel.busy').waitFor();
  await live.getByText('正在等待新弹幕，确认哪个区域持续更新…', { exact: true }).waitFor();
  await live.getByText('未找到弹幕区', { exact: true }).waitFor();
  await live.getByText('本地还没有找到可核验的候选，没有发送 HTML 或截图。', { exact: true }).waitFor();
  assert.equal(await live.getByRole('button', { name: '点一条弹幕正文' }).count(), 0);
  await openPopup();
  assert.equal(await popup.locator('#scope').inputValue(), 'room');
  assert.equal(await popup.locator('#enabled').isChecked(), false);
  const otherSite = await context.newPage();
  await otherSite.goto('https://www.youtube.com/watch?v=one');
  const otherPopup = await context.newPage();
  await otherSite.bringToFront();
  await otherPopup.goto(origin + '/popup.html');
  await otherPopup.locator('#scope').selectOption('room');
  await otherPopup.locator('#scope').selectOption('site');
  await until(async () => (await command(options, 'site', await tabId(options, otherSite.url()))).preferredScope === 'site');
  await otherPopup.close();
  await live.goto('https://www.twitch.tv/demochannel');
  await openPopup();
  assert.equal(await popup.locator('#scope').inputValue(), 'room');
  assert.equal(await popup.locator('#enabled').isChecked(), false);
  await popup.locator('#enabled').check();
  await popup.getByText('已启用。', { exact: true }).waitFor();
  await live.getByText('译：Fantastic comeback!', { exact: true }).waitFor();
  const tab = await tabId(options, live.url());
  await popup.getByRole('button', { name: '自动识别弹幕区' }).click();
  const panel = live.getByRole('region', { name: 'LiveChat Copilot' });
  await panel.getByText('已识别弹幕区', { exact: true }).waitFor();
  assert.equal(await panel.getByRole('list').count(), 0);
  assert.equal(await panel.getByRole('button', { name: '点一条弹幕正文' }).count(), 0);
  assert.equal(await panel.getByRole('button', { name: '手动选整个弹幕区' }).count(), 0);
  const outline = live.locator('[data-lcc-kind="panel"] .hover.detected');
  const chatList = live.locator('.chat-scrollable-area__message-container');
  await outline.waitFor();
  assert.deepEqual(await outline.boundingBox(), await chatList.boundingBox());
  assert.equal(await outline.evaluate(node => getComputedStyle(node).backgroundColor), 'rgba(34, 197, 94, 0.16)');
  const initialCard = await panel.boundingBox();
  assert.ok(initialCard.x + initialCard.width < (await chatList.boundingBox()).x);
  await live.evaluate(() => {
    document.body.style.minHeight = '1200px';
    document.querySelector('main').style.marginTop = '140px';
    window.scrollTo(0, 110);
  });
  await until(async () => {
    const box = await chatList.boundingBox();
    return (await outline.boundingBox())?.y === box.y && (await panel.boundingBox())?.y === box.y;
  });
  await live.setViewportSize({ width: 520, height: 700 });
  await until(async () => {
    const box = await chatList.boundingBox();
    return (await panel.boundingBox())?.y >= box.y + box.height;
  });
  await live.setViewportSize({ width: 1050, height: 900 });
  await live.evaluate(() => {
    document.body.style.removeProperty('min-height');
    document.querySelector('main').style.removeProperty('margin-top');
    window.scrollTo(0, 0);
  });
  await panel.getByRole('button', { name: '调整框选范围', exact: true }).click();
  await panel.getByRole('button', { name: '确认调整' }).waitFor();
  await live.keyboard.press('ArrowUp');
  assert.deepEqual(await outline.boundingBox(), await live.locator('aside').boundingBox());
  await panel.getByText(/^已扩大一层/).waitFor();
  await live.keyboard.press('ArrowDown');
  assert.deepEqual(await outline.boundingBox(), await chatList.boundingBox());
  await live.keyboard.press('ArrowDown');
  assert.deepEqual(await outline.boundingBox(), await live.locator('.message-wrapper').first().boundingBox());
  await live.keyboard.press('Enter');
  await panel.getByText('当前框内没有提取到多条弹幕。请按 ↑ 或 ↓ 继续调整。').waitFor();
  await live.keyboard.press('ArrowUp');
  await live.keyboard.press('Enter');
  await panel.getByText('核对弹幕样本', { exact: true }).waitFor();
  assert.equal(await outline.evaluate(node => getComputedStyle(node).backgroundColor), 'rgba(34, 197, 94, 0.16)');
  assert.equal(await panel.getByRole('button', { name: '点一条弹幕正文' }).count(), 0);
  await panel.getByRole('button', { name: '关闭', exact: true }).click();
  await action(options, tab, 'detect');
  await outline.waitFor();
  await live.keyboard.press('Escape');
  await panel.waitFor({ state: 'hidden' });
  await outline.waitFor({ state: 'hidden' });
  await action(options, tab, 'pick');
  await panel.getByRole('button', { name: '改为点一条弹幕正文' }).click();
  const word = live.getByText('Fantastic', { exact: true });
  await word.hover();
  await outline.waitFor();
  assert.deepEqual(await outline.boundingBox(), await word.boundingBox());
  assert.equal(await outline.evaluate(node => getComputedStyle(node).backgroundColor), 'rgba(34, 197, 94, 0.16)');
  await word.click();
  await panel.getByText('核对弹幕样本', { exact: true }).waitFor();
  await panel.getByText('What a game!', { exact: true }).waitFor();
  assert.deepEqual(await outline.boundingBox(), await chatList.boundingBox());
  await panel.getByRole('button', { name: '关闭', exact: true }).click();
  await panel.waitFor({ state: 'hidden' });
  await live.locator('[data-lcc-kind="panel"] .hover').waitFor({ state: 'hidden' });

  await action(options, tab, 'pick');
  const outsideChat = live.getByText('LIVE', { exact: true });
  await outsideChat.click();
  await panel.getByText('暂时无法用这个选区提取弹幕').waitFor();
  assert.deepEqual(await outline.boundingBox(), await outsideChat.boundingBox());
  await live.keyboard.press('Escape');
  await outline.waitFor({ state: 'hidden' });

  await action(options, tab, 'pick');
  await live.getByText('Fantastic', { exact: true }).hover();
  await live.locator('[data-lcc-kind="panel"] .hover').waitFor();
  await live.evaluate(() => history.pushState(null, '', '/'));
  await live.locator('[data-lcc-kind="panel"]').waitFor({ state: 'detached' });
  assert.equal(await action(options, tab, 'pick'), false);
  assert.equal(await live.locator('[data-lcc-kind="panel"]').count(), 0);
  await openPopup();
  assert.equal(await popup.locator('#enabled').isChecked(), false);
});

test('Bilibili isolates the chat list and body and skips parents that shrink the visible selection', { timeout: 35_000 }, async t => {
  const { context, options, requestLog } = await boot(t);
  const url = 'https://live.bilibili.com/12345';
  const body = await fixture('bilibili-chat.html');
  await context.route(url, route => route.fulfill({ contentType: 'text/html', body }));
  await options.evaluate(() => chrome.storage.local.set({ localRules: [{
    schemaVersion: 1, id: 'old-bilibili-local', version: 1, host: 'live.bilibili.com', pathPrefix: '/12345',
    container: '#chat-shell', message: '.chat-item', body: '.legacy-message-body',
  }] }));
  const live = await context.newPage();
  await live.goto(url);
  const tab = await tabId(options, url);
  await command(options, 'attach', tab);
  await command(options, 'setSite', { tabId: tab, enabled: true, origin: new URL(url).origin });
  await live.locator('.danmaku-item-right + [data-lcc-kind="translation"]')
    .filter({ hasText: /^译：这局打得很精彩$/ }).waitFor();
  assert.ok(requestLog.some(message => JSON.stringify(message).includes('下一局继续加油')));
  assert.ok(requestLog.every(message => !/用户[甲乙]|徽章[甲乙]|粉丝榜提示|欢迎提示|挥手表情/u.test(JSON.stringify(message))));
  await action(options, tab, 'detect');
  const panel = live.getByRole('region', { name: 'LiveChat Copilot' });
  await panel.getByText(/内置规则/).waitFor();
  const outline = live.locator('[data-lcc-kind="panel"] .hover.detected');
  assert.deepEqual(await outline.boundingBox(), await live.locator('#chat-history-list').boundingBox());
  await panel.getByRole('button', { name: '调整框选范围' }).click();
  await live.keyboard.press('ArrowUp');
  assert.deepEqual(await outline.boundingBox(), await live.locator('#chat-shell').boundingBox());
  await live.keyboard.press('ArrowDown');
  assert.deepEqual(await outline.boundingBox(), await live.locator('#chat-history-list').boundingBox());
  await live.keyboard.press('Enter');
  await panel.getByText('核对弹幕样本', { exact: true }).waitFor();
  await panel.getByText('这局打得很精彩', { exact: true }).waitFor();
  await panel.getByRole('button', { name: '保存并启用规则' }).click();
  await panel.waitFor({ state: 'hidden' });
});

test('Douyu identifies sparse chat and shows the selected sample independently of its list', { timeout: 35_000 }, async t => {
  const { context, options, requestLog } = await boot(t);
  const url = 'https://www.douyu.com/12345';
  const row = (name, text) => `<li class="Barrage-listItem"><span class="chat-row-inner">
    <span class="chat-badge">Synthetic badge</span><span class="Barrage-nickName js-nick">${name}</span>
    <span class="Barrage-nickName is-colon">：</span><span class="Barrage-content">${text}</span></span></li>`;
  await context.route(url, route => route.fulfill({ contentType: 'text/html', body: `<ul class="Barrage-list">
    <li class="Barrage-listItem"><span class="Barrage-content">System banner</span></li></ul>
    <aside style="width:350px;margin:180px 0 0 auto">
    <ul id="active-chat" class="Barrage-list" style="height:200px;overflow:auto;padding-left:8px">${row('OpaqueUser123', 'Good first round')}
    <li class="Barrage-listItem"><span class="Barrage-line"><span class="Barrage-content">System banner</span></span></li></ul></aside>` }));
  await options.evaluate(() => chrome.storage.local.set({ localRules: [{ schemaVersion: 1, id: 'old-douyu', version: 1,
    host: 'www.douyu.com', pathPrefix: '/12345', container: '.Barrage-list', message: '.Barrage-listItem', body: '.chat-row-inner' }] }));
  const live = await context.newPage();
  await live.goto(url);
  const tab = await tabId(options, url);
  await command(options, 'attach', tab);
  await command(options, 'setSite', { tabId: tab, enabled: true, origin: new URL(url).origin });
  await action(options, tab, 'detect');
  const panel = live.getByRole('region', { name: 'LiveChat Copilot' });
  await panel.getByText(/内置规则/).waitFor();
  await live.getByText('译：Good first round', { exact: true }).waitFor();
  const chatList = live.locator('#active-chat');
  await chatList.evaluate((list, html) => list.insertAdjacentHTML('beforeend', html), row('OpaqueUser456', 'Ready for the next round'));
  await live.getByText('译：Ready for the next round', { exact: true }).waitFor();
  assert.ok(requestLog.every(request => !/OpaqueUser|Synthetic badge|System banner/.test(JSON.stringify(request))));
  await action(options, tab, 'pick');
  await panel.getByText('手动选择弹幕区', { exact: true }).waitFor();
  const box = await panel.boundingBox();
  assert.ok(box.y < 40 && Math.abs(box.x + box.width / 2 - (await live.evaluate(() => innerWidth)) / 2) < 2);
  const sample = chatList.getByText('Good first round', { exact: true });
  await sample.click();
  await panel.getByText(/蓝框标出你点选的正文样例/).waitFor();
  assert.deepEqual(await live.locator('[data-lcc-kind="panel"] .sample-outline').boundingBox(), await sample.boundingBox());
  assert.deepEqual(await live.locator('[data-lcc-kind="panel"] .hover.detected').boundingBox(), await chatList.boundingBox());
});

test('generic rule correction validates independent rows and leaves their authors out of live translations', { timeout: 40_000 }, async t => {
  const { context, options, requestLog } = await boot(t);
  await options.getByRole('button', { name: '测试当前模型' }).click();
  await options.getByText('支持', { exact: true }).waitFor();
  await options.locator('#auto-vision').check();
  await options.getByRole('button', { name: '保存并授权' }).click();
  await options.getByText('已保存。', { exact: true }).waitFor();
  const url = 'https://www.huya.com/fixture-room';
  const row = (name, content, badge = '', tail = '') => `<li class="J_msg"><p>${badge}<span class="name J_userMenu">${name}</span><span class="colon">:</span><span class="msg">${content}</span>${tail}</p></li>`;
  await context.route(url, route => route.fulfill({ contentType: 'text/html', body: `<div style="margin:180px 0 0 58%">
    <ul id="chat-room__list">${row('SampleAuthor', 'First body')}${row('OtherAuthor', 'Second body', '<i>Badge label</i>', ' <small>Extra label</small>')}</ul></div>` }));
  const live = await context.newPage();
  await live.goto(url);
  await live.bringToFront();
  const tab = await tabId(options, url);
  await command(options, 'attach', tab);
  await action(options, tab, 'pick');
  const panel = live.getByRole('region', { name: 'LiveChat Copilot' });
  await panel.getByRole('button', { name: '改为点一条弹幕正文' }).click();
  const list = live.locator('#chat-room__list');
  await list.locator('.msg').first().click();
  await panel.getByText('核对弹幕样本', { exact: true }).waitFor();
  assert.deepEqual(await panel.getByRole('listitem').allTextContents(), ['First body', 'Second body']);
  await panel.getByRole('button', { name: '纠正规则' }).click();
  await list.locator('.msg').first().hover();
  await live.keyboard.press('Enter');
  await panel.getByText(/选另一条消息/).waitFor();
  await list.locator('.msg').first().click();
  await panel.getByText(/这次点击未能与第一条组成两行/).waitFor();
  await list.locator('.msg').nth(1).click();
  await panel.getByText(/标记正文/).waitFor();
  await list.locator('.msg').first().click();
  await panel.getByText(/^4\/4 · 标记昵称$/).waitFor();
  await list.locator('.name').first().click();
  await panel.getByText('核对弹幕样本', { exact: true }).waitFor();
  assert.deepEqual(await panel.getByRole('listitem').allTextContents(), ['First body', 'Second body']);
  await panel.getByRole('button', { name: '让模型比较候选规则' }).click();
  await panel.getByText('已用截图比对候选位置。', { exact: true }).waitFor();
  assert.deepEqual(await panel.getByRole('listitem').allTextContents(), ['First body', 'Second body']);
  const choice = requestLog.find(({ messages }) => Array.isArray(messages[1].content) && JSON.parse(messages[1].content[0].text).candidates);
  const candidates = JSON.parse(choice.messages[1].content[0].text).candidates;
  assert.equal(candidates.length, 2);
  assert.ok(candidates.every(candidate => candidate.html.includes('data-user-marked-author-tag')));
  await panel.getByRole('button', { name: '保存并启用规则' }).click();
  await panel.waitFor({ state: 'hidden' });
  const saved = (await command(options, 'getSettings')).rules.local.find(item => item.rule.host === 'www.huya.com');
  assert.ok(Number.isFinite(saved.addedAt));
  await command(options, 'setSite', { tabId: tab, enabled: true, origin: new URL(url).origin });
  await live.getByText('译：First body', { exact: true }).waitFor();
  await list.evaluate((area, html) => area.insertAdjacentHTML('beforeend', html), row('ThirdAuthor', 'Third body'));
  await live.getByText('译：Third body', { exact: true }).waitFor();
  assert.ok(requestLog.every(request => !/SampleAuthor|OtherAuthor|ThirdAuthor|Badge label/.test(JSON.stringify(request))));
});

test('local rule details show saved dates and switching changes the active chat container', { timeout: 45_000 }, async t => {
  const { context, options, origin } = await boot(t);
  await options.evaluate(() => chrome.storage.local.set({
    localRules: [
      { schemaVersion: 1, id: 'old-main', version: 1, host: 'www.youtube.com', pathPrefix: '/watch', framePathPrefix: '/live_chat',
        container: '#items', message: 'yt-live-chat-text-message-renderer', body: '#message' },
      { schemaVersion: 1, id: 'new-alt', version: 1, host: 'www.youtube.com', pathPrefix: '/watch', framePathPrefix: '/live_chat',
        container: '#alternate', message: '.chat-row', body: '.message-body' },
      { schemaVersion: 1, id: 'other-site', version: 1, host: 'example.com', container: '#messages', message: 'li' },
    ],
    localRuleAddedAt: { 'new-alt': 1700000000000 },
  }));
  await options.reload();
  const groups = options.locator('#local-rules .local-rule-group');
  const youtube = groups.filter({ has: options.getByText('www.youtube.com（2 条规则）', { exact: true }) });
  const old = youtube.locator('.local-rule-entry').filter({ hasText: 'old-main' });
  const newer = youtube.locator('.local-rule-entry').filter({ hasText: 'new-alt' });
  await youtube.locator(':scope > summary').waitFor();
  assert.equal(await groups.count(), 2);
  assert.equal(await groups.evaluateAll(nodes => nodes.every(node => !node.open)), true);
  assert.equal(await old.isVisible(), false);
  await youtube.locator(':scope > summary').click();
  await old.locator('summary').click();
  await old.getByText('旧规则，添加时间未记录。').waitFor();
  await newer.locator('summary').click();
  await newer.getByText(/^添加于 /).waitFor();
  assert.match(await newer.locator('pre').textContent(), /"container": "#alternate"/);
  const live = await context.newPage();
  await live.goto('https://www.youtube.com/watch?v=one');
  const tab = await tabId(options, live.url());
  await command(options, 'setSite', { tabId: tab, enabled: true, origin: 'https://www.youtube.com' });
  const chat = live.frameLocator('#chatframe');
  await chat.getByText('译：New tournament', { exact: true }).waitFor();
  const popup = await context.newPage();
  await live.bringToFront();
  await popup.goto(origin + '/popup.html');
  const select = popup.locator('#local-rule');
  await select.selectOption('old-main');
  await popup.getByText('已应用到当前直播间。', { exact: true }).waitFor();
  await chat.getByText('译：Amazing comeback', { exact: true }).waitFor();
  await chat.getByText('译：New tournament', { exact: true }).waitFor({ state: 'detached' });
  assert.equal((await command(options, 'site', tab)).selectedRuleId, 'old-main');
  await select.selectOption('');
  await chat.getByText('译：New tournament', { exact: true }).waitFor();
  await old.getByRole('button', { name: '删除本地规则' }).click();
  const updatedGroup = groups.filter({ has: options.getByText('www.youtube.com（1 条规则）', { exact: true }) });
  await updatedGroup.locator(':scope > summary').waitFor();
  assert.equal(await updatedGroup.evaluate(node => node.open), true);
  assert.equal(await updatedGroup.locator('pre').isVisible(), true);
});

test('generic rules isolate nested lists and extract marked or inline bodies without metadata', { timeout: 45_000 }, async t => {
  const { context, options, local, requestLog } = await boot(t);
  const metadata = '<span data-role="badge">Private badge</span><span class="chat-badge">Badge level</span><span class="username">Sender Alias</span>';
  const clip = (content, row) => `<div data-message-id="${row}">${content}</div>`;
  function sample(text, id, kind) {
    if (kind === 'nested') return clip(`${metadata}<span class="message-content">${text}</span>`, id);
    if (kind === 'uncertain') return clip(`<em>${text}</em>${metadata}`, id);
    return clip(`<span>${metadata}</span>: ${text} <time>09:45</time>`, id);
  }
  const mentions = '<a class="username" data-mention>@buddy</a>: nice round';
  for (const kind of ['nested', 'inline', 'uncertain']) {
    const url = local + '/' + kind;
    await context.route(url, route => route.fulfill({ contentType: 'text/html', body:
      `<main><section id="chat-panel" role="log"><header>Static leaderboard</header>
        <div id="chat-list" style="height:130px;overflow:auto">
          ${sample('First message ' + kind, 1, kind)}${sample(mentions, 2, kind)}
        </div></section></main>`,
    }));
    const live = await context.newPage();
    await live.goto(url);
    const tab = await tabId(options, url);
    await command(options, 'attach', tab);
    await action(options, tab, 'detect');
    const panel = live.getByRole('region', { name: 'LiveChat Copilot' });
    if (kind === 'uncertain') {
      await panel.getByText('找到疑似弹幕列表').waitFor();
      assert.equal(await panel.getByRole('button', { name: '保存并启用规则' }).count(), 0);
      await action(options, tab, 'pick');
      await panel.getByRole('button', { name: '改为点一条弹幕正文' }).click();
      await live.locator('#chat-list em').first().click();
      await panel.getByText('核对弹幕样本').waitFor();
      assert.deepEqual(await live.locator('[data-lcc-kind="panel"] .hover.detected').boundingBox(),
        await live.locator('#chat-list').boundingBox());
    } else {
      await panel.getByText('已识别弹幕区').waitFor();
      const outline = live.locator('[data-lcc-kind="panel"] .hover.detected');
      assert.deepEqual(await outline.boundingBox(), await live.locator('#chat-list').boundingBox());
    }
    await panel.getByRole('button', { name: '保存并启用规则' }).click();
    await panel.waitFor({ state: 'hidden' });
    await command(options, 'setSite', { tabId: tab, enabled: true, origin: local });
    await live.getByText('译：First message ' + kind, { exact: true }).waitFor();
    await live.locator('#chat-list').evaluate((list, html) => list.insertAdjacentHTML('beforeend', html), sample('Next message ' + kind, 3, kind));
    await live.getByText('译：Next message ' + kind, { exact: true }).waitFor();
    await live.close();
  }
  assert.ok(requestLog.some(message => JSON.stringify(message).includes('@buddy: nice round')));
  assert.ok(requestLog.every(message => !/Private badge|Badge level|Sender Alias|Static leaderboard|09:45/.test(JSON.stringify(message))));
});

test('vision can compare distinct body candidates from the same list', { timeout: 35_000 }, async t => {
  const { context, options, requestLog, local } = await boot(t);
  await options.locator('#model').fill('test-paired-body');
  await options.getByRole('button', { name: '测试当前模型' }).click();
  await options.getByText('支持', { exact: true }).waitFor();
  await options.locator('#auto-vision').check();
  await options.getByRole('button', { name: '保存并授权' }).click();
  await options.getByText('已保存。', { exact: true }).waitFor();
  const url = local + '/body-variants';
  await context.route(url, route => route.fulfill({ contentType: 'text/html', body: `<section role="log" id="chat-list">
    <div data-message-id="one"><span class="message-body">First label</span><span class="message-content">First full message</span></div>
    <div data-message-id="two"><span class="message-body">Second label</span><span class="message-content">Second full message</span></div>
  </section>` }));
  const live = await context.newPage();
  await live.goto(url);
  await live.bringToFront();
  const tab = await tabId(options, url);
  await command(options, 'attach', tab);
  await action(options, tab, 'detect');
  await live.getByText('已用截图比对候选位置。').waitFor();
  const request = requestLog.find(({ messages }) => Array.isArray(messages[1].content) && JSON.parse(messages[1].content[0].text).candidates);
  const { candidates } = JSON.parse(request.messages[1].content[0].text);
  assert.deepEqual(candidates.map(candidate => candidate.samples[0]), ['First label', 'First full message']);
  await live.getByRole('button', { name: '保存并启用规则' }).click();
  await live.getByRole('region', { name: 'LiveChat Copilot' }).waitFor({ state: 'hidden' });
  const saved = await options.evaluate(async () => (await chrome.storage.local.get('localRules')).localRules);
  assert.equal(saved.find(rule => rule.pathPrefix === '/body-variants').body, '.message-content');
});

test('the vision model sees bounded candidate samples while automatic detection displays progress', { timeout: 45_000 }, async t => {
  const { context, options, requestLog, origin, local } = await boot(t);
  await options.getByRole('button', { name: '测试当前模型' }).click();
  await options.getByText('支持', { exact: true }).waitFor();
  await options.locator('#auto-vision').check();
  await options.getByRole('button', { name: '保存并授权' }).click();
  await options.getByText('已保存。', { exact: true }).waitFor();
  const url = local + '/live/ambiguous';
  await context.route(url, route => route.fulfill({ contentType: 'text/html', body:
    '<section class="video-player"><ol><li>LIVE</li><li>Volume</li><li>Clip</li><li>Settings</li></ol></section>' +
    '<ol><li>That was close!</li><li>Look at that move</li><li>Great round</li><li>Here we go again</li></ol>' +
    '<ol><li>One match remaining</li><li>Two stages complete</li><li>Three matches played</li><li>Four teams advance</li></ol>',
  }));
  const live = await context.newPage();
  await live.goto(url);
  const popup = await context.newPage();
  await live.bringToFront();
  await popup.goto(origin + '/popup.html');
  await popup.getByRole('button', { name: '自动识别弹幕区' }).click();
  await live.getByText('正在识别弹幕区', { exact: true }).waitFor();
  await live.getByText('正在让模型对照候选区域截图和弹幕样本…', { exact: true }).waitFor();
  await live.getByText('已用截图比对候选位置。', { exact: true }).waitFor();
  await live.locator('[data-lcc-kind="panel"] .hover.detected').waitFor();
  assert.equal(await live.getByRole('region', { name: 'LiveChat Copilot' }).getByRole('list').count(), 0);
  const request = requestLog.find(({ messages }) => Array.isArray(messages[1].content) && JSON.parse(messages[1].content[0].text).candidates);
  assert.ok(request);
  const [prompt, image] = request.messages[1].content;
  assert.equal(request.messages[1].content.filter(part => part.type === 'image_url').length, 1);
  const { candidates } = JSON.parse(prompt.text);
  assert.equal(candidates.length, 2);
  assert.match(candidates[0].html, /That was close!/);
  assert.match(candidates[1].html, /One match remaining/);
  assert.doesNotMatch(prompt.text, /LIVE|Volume/);
  assert.match(image.image_url.url, /^data:image\/jpeg;base64,/);
});

test('rooms on one site reuse a verified local rule and suggest a different layout when it fails', { timeout: 40_000 }, async t => {
  const { context, options, local } = await boot(t);
  await context.route(url => url.origin === local && /^\/(alice|bob|alice\/carol)$/.test(url.pathname), route => {
    const room = new URL(route.request().url()).pathname.split('/').at(-1);
    const standard = room !== 'carol';
    const list = standard ? 'chat-log' : 'new-message-list';
    return route.fulfill({ contentType: 'text/html', body: `<main><section id="${list}" role="log">
      <div data-message-id="first"><span class="message-body">Opening line ${room}</span></div>
      <div data-message-id="second"><span class="message-body">Reply from ${room}</span></div></section></main>` });
  });
  const live = await context.newPage();
  await live.goto(local + '/alice');
  const tab = await tabId(options, live.url());
  await command(options, 'attach', tab);
  await action(options, tab, 'detect');
  await live.getByRole('button', { name: '保存并启用规则' }).click();
  await live.getByRole('region', { name: 'LiveChat Copilot' }).waitFor({ state: 'hidden' });
  await command(options, 'setSite', { tabId: tab, enabled: true, origin: local });
  await live.goto(local + '/bob');
  await live.getByText('译：Opening line bob', { exact: true }).waitFor();
  await action(options, tab, 'detect');
  await live.getByText('同站直播间已保存的规则', { exact: false }).waitFor();
  await live.goto(local + '/alice/carol');
  await live.getByRole('button', { name: '保存并启用规则' }).waitFor();
  assert.equal(await live.getByText('译：Opening line carol', { exact: true }).count(), 0);
  await live.getByRole('button', { name: '保存并启用规则' }).click();
  await live.getByText('译：Opening line carol', { exact: true }).waitFor();
  assert.equal((await command(options, 'getSettings')).rules.local.length, 2);
  await live.goto(local + '/alice');
  await live.getByText('译：Opening line alice', { exact: true }).waitFor();
});

test('vision can distinguish two editor candidates paired with the same message list', { timeout: 35_000 }, async t => {
  const { context, options, requestLog, local } = await boot(t);
  await options.locator('#model').fill('test-paired-input');
  await options.getByRole('button', { name: '测试当前模型' }).click();
  await options.getByText('支持', { exact: true }).waitFor();
  await options.locator('#auto-vision').check();
  await options.getByRole('button', { name: '保存并授权' }).click();
  await options.getByText('已保存。', { exact: true }).waitFor();
  const url = local + '/paired';
  await context.route(url, route => route.fulfill({ contentType: 'text/html', body: `<main>
    <section role="log" id="chat-room">
      <div data-message-id="first"><span class="message-body">Opening discussion</span></div>
      <div data-message-id="second"><span class="message-body">Continuing discussion</span></div>
    </section>
    <form><textarea id="extra" aria-label="Chat"></textarea><button type="submit">Send</button></form>
    <form><textarea id="actual" aria-label="Chat"></textarea><button type="submit">Send</button></form>
  </main>` }));
  const live = await context.newPage();
  await live.goto(url);
  await live.bringToFront();
  const tab = await tabId(options, live.url());
  await command(options, 'attach', tab);
  await action(options, tab, 'detect');
  await live.getByText('已用截图比对候选位置。', { exact: true }).waitFor();
  const request = requestLog.find(({ messages }) => Array.isArray(messages[1].content) && JSON.parse(messages[1].content[0].text).candidates);
  assert.ok(request);
  const { candidates } = JSON.parse(request.messages[1].content[0].text);
  assert.equal(candidates.length, 2);
  assert.ok(candidates.every(candidate => candidate.editorImage));
  assert.equal(candidates[0].html, candidates[1].html);
  await live.getByRole('button', { name: '保存并启用规则' }).click();
  const saved = await options.evaluate(async () => (await chrome.storage.local.get('localRules')).localRules);
  assert.equal(saved.find(rule => rule.host === '127.0.0.1').composer, '#actual');
});

test('an endpoint that rejects images disables later visual checks while text translation still works', { timeout: 45_000 }, async t => {
  const { context, options, requestLog } = await boot(t);
  await options.locator('#model').fill('test-runtime-image-rejection');
  await options.getByRole('button', { name: '测试当前模型' }).click();
  await options.getByText('支持', { exact: true }).waitFor();
  await options.locator('#auto-vision').check();
  await options.getByRole('button', { name: '保存并授权' }).click();
  await options.getByText('已保存。', { exact: true }).waitFor();
  const live = await context.newPage();
  await live.goto('https://www.youtube.com/watch?v=one');
  await live.bringToFront();
  const chat = live.frameLocator('#chatframe');
  await chat.getByText('Amazing comeback').waitFor();
  const tab = await tabId(options, live.url());
  await action(options, tab, 'detect');
  await chat.getByText('当前模型接口不支持图片输入，已停用截图核验。').waitFor();
  assert.equal((await command(options, 'getSettings')).imageUnavailable, true);
  await live.reload();
  await action(options, tab, 'detect');
  await chat.getByText('当前模型不支持图片输入，已跳过截图核验。').waitFor();
  assert.equal(requestLog.filter(body => Array.isArray(body.messages[1].content) &&
    JSON.parse(body.messages[1].content[0].text).test !== 'image-capability').length, 1);
  await command(options, 'setSite', { tabId: tab, enabled: true, origin: 'https://www.youtube.com' });
  await chat.getByText('译：Amazing comeback', { exact: true }).waitFor();
  await options.reload();
  await options.getByText('当前模型不支持图片输入', { exact: false }).waitFor();
  assert.equal(await options.locator('#auto-vision').isDisabled(), true);
});

test('advanced prompts show the real system message and apply a website override to translation', { timeout: 35_000 }, async t => {
  const { context, origin, options, requestLog } = await boot(t);
  const live = await context.newPage();
  await live.goto('https://www.youtube.com/watch?v=one');
  const tab = await tabId(options, live.url());
  await options.goto(origin + '/options.html?fromTab=' + tab);
  await options.getByText('高级设置 · 模型提示词').click();
  await options.getByText('当前网站 https://www.youtube.com', { exact: false }).waitFor();
  const instructions = options.locator('#system-instruction');
  assert.equal(await instructions.getAttribute('readonly'), '');
  assert.match(await instructions.inputValue(), /把每条弹幕翻译成/);
  assert.match(await options.locator('#system-preview').inputValue(), /targetLanguage/);
  assert.match(await options.locator('#system-preview').inputValue(), /用词自然、简洁/);
  await options.getByRole('button', { name: '解锁编辑' }).click();
  await instructions.fill('Use the custom website terminology.');
  await options.getByRole('button', { name: '保存任务指令' }).click();
  await options.getByText('任务指令已保存。').waitFor();
  const expected = await options.locator('#system-preview').inputValue();
  assert.match(expected, /Use the custom website terminology/);
  await command(options, 'setSite', { tabId: tab, enabled: true, origin: 'https://www.youtube.com' });
  const chat = live.frameLocator('#chatframe');
  await chat.getByText('译：Amazing comeback', { exact: true }).waitFor();
  assert.ok(requestLog.some(body => body.messages[0].content === expected));
  const global = await command(options, 'promptContext');
  assert.doesNotMatch(global.prompts.translation.system, /custom website terminology/);
  await options.getByText('重置后，当前网站的这项任务会使用全局提示词。').waitFor();
  await options.getByRole('button', { name: '重置提示词' }).click();
  await options.getByText('提示词已重置。').waitFor();
  assert.equal(await options.locator('#system-preview').inputValue(), global.prompts.translation.system);
});

test('settings test unsaved model fields and keep the browser language as the default', { timeout: 40_000 }, async t => {
  const { options, requestLog } = await boot(t);
  const { settings, browserLanguage } = await command(options, 'getSettings');
  assert.equal(settings.readingLanguage, '');
  const locale = await options.evaluate(() => Intl.getCanonicalLocales(chrome.i18n.getUILanguage().replaceAll('_', '-'))[0]);
  assert.equal(browserLanguage, locale);
  assert.equal(await options.locator('#language').getAttribute('placeholder'), locale);
  assert.equal(await options.getByRole('heading', { name: '社区规则' }).count(), 0);
  assert.equal(await options.getByRole('checkbox').count(), 1);
  assert.equal(await options.locator('#auto-vision').isDisabled(), true);
  await options.locator('#model').fill('unsaved-draft-model');
  await options.getByRole('button', { name: '测试当前模型' }).click();
  await options.getByText('连接正常', { exact: true }).waitFor();
  assert.equal(await options.locator('#test-image').innerText(), '支持');
  assert.equal(await options.locator('#auto-vision').isEnabled(), true);
  assert.match(await options.locator('#test-latency').innerText(), /^\d+ ms$/);
  assert.equal((await command(options, 'getSettings')).settings.model.model, 'test-model');
  assert.equal(requestLog.length, 2);
  assert.ok(requestLog.every(body => body.model === 'unsaved-draft-model'));
  assert.equal(JSON.parse(requestLog[0].messages[1].content).targetLanguage, locale);
  await options.locator('#model').fill('test-text-only');
  await options.getByRole('button', { name: '测试当前模型' }).click();
  await options.getByText('不支持', { exact: true }).waitFor();
  assert.equal(await options.locator('#auto-vision').isDisabled(), true);
  assert.equal(await options.locator('#test-connection').innerText(), '连接正常');
  await options.locator('#language').fill('ja');
  await options.locator('#mode').selectOption('single');
  await options.getByText('每条弹幕单独发起请求', { exact: false }).waitFor();
  await options.getByRole('button', { name: '保存翻译偏好' }).click();
  await options.getByText('翻译偏好已保存。', { exact: true }).waitFor();
  const updated = (await command(options, 'getSettings')).settings;
  assert.equal(updated.readingLanguage, 'ja');
  assert.equal(updated.model.model, 'test-model');
});

test('the popup offers only room and site scopes and skips matching languages', { timeout: 45_000 }, async t => {
  const { context, options, origin, requestLog } = await boot(t);
  const { settings } = await command(options, 'getSettings');
  await command(options, 'saveReadingSettings', { readingLanguage: 'en', mode: 'batch', prompt: settings.prompt });
  const live = await context.newPage();
  await live.goto('https://www.youtube.com/watch?v=one');
  const popup = await context.newPage();
  await live.bringToFront();
  await popup.goto(origin + '/popup.html');
  await popup.locator('#skip-reading').check();
  assert.deepEqual(await popup.locator('#scope option').allTextContents(), ['当前直播间', '本站所有直播间']);
  assert.equal(await popup.getByRole('button', { name: '设置直播间回复语言' }).count(), 0);
  await popup.locator('#scope').selectOption('room');
  await popup.locator('#enabled').check();
  await popup.getByText('当前页面按「当前直播间」设置启用翻译。', { exact: true }).waitFor();

  const english = 'Thank you for streaming today. I hope you enjoy the game and have a wonderful evening.';
  const japanese = '今日の配信ありがとうございます。また一緒にゲームをしましょう。';
  const chat = live.frameLocator('#chatframe');
  await chat.locator('#items').evaluate((area, texts) => {
    for (const text of texts) {
      const row = document.createElement('yt-live-chat-text-message-renderer');
      const body = document.createElement('span');
      body.id = 'message';
      body.textContent = text;
      row.append(body);
      area.append(row);
    }
  }, [english, japanese]);
  await chat.getByText('译：' + japanese, { exact: true }).waitFor();
  assert.equal(requestLog.some(request => JSON.stringify(request.messages[1].content).includes(english)), false);

  const target = popup.locator('#target-language');
  assert.equal(await target.inputValue(), '');
  assert.match(await target.getAttribute('placeholder'), /默认.*英语/);
  await target.fill('日本語');
  await target.press('Enter');
  await popup.getByText('自动翻译时跳过已是日语的弹幕', { exact: true }).waitFor();
  await chat.getByText('译：' + english, { exact: true }).waitFor();
  await chat.getByText('译：' + japanese, { exact: true }).waitFor({ state: 'detached' });
  assert.ok(requestLog.some(({ messages }) => typeof messages[1].content === 'string' &&
    JSON.parse(messages[1].content).targetLanguage === 'ja' && messages[1].content.includes(english)));
  await popup.locator('#skip-reading').uncheck();
  await chat.getByText('译：' + japanese, { exact: true }).waitFor();
  await popup.locator('#reset-target-language').click();
  await until(async () => await target.inputValue() === '');
  assert.equal((await command(options, 'getSettings')).settings.readingLanguage, 'en');
  await target.fill('en');
  await target.press('Enter');
  await until(async () => (await command(options, 'site', await tabId(options, live.url()))).targetLanguage === 'en');
  await popup.locator('#skip-reading').check();

  await popup.locator('#scope').selectOption('site');
  await popup.locator('#enabled').check();
  await popup.getByText('已启用。', { exact: true }).waitFor();
  await popup.locator('#scope').selectOption('room');
  assert.equal(await popup.locator('#enabled').isChecked(), true);
  await popup.locator('#enabled').uncheck();
  await popup.getByText('当前页面按「当前直播间」设置关闭翻译。', { exact: true }).waitFor();
  await chat.getByText('译：' + japanese, { exact: true }).waitFor({ state: 'detached' });
  await popup.getByRole('button', { name: '跟随全站设置' }).click();
  await popup.getByText('当前页面按「本站所有直播间」设置启用翻译。', { exact: true }).waitFor();

  await chat.locator('#items').evaluate(area => {
    for (let i = 0; i < 12; i++) {
      const row = document.createElement('yt-live-chat-text-message-renderer');
      const body = document.createElement('span');
      body.id = 'message';
      body.textContent = '楽しい配信をありがとうございます！ ' + i;
      row.append(body);
      area.append(row);
    }
  });
  await chat.getByText('译：楽しい配信をありがとうございます！ 11', { exact: true }).waitFor();
  assert.equal(requestLog.some(({ messages }) => typeof messages[1].content === 'string' &&
    Object.hasOwn(JSON.parse(messages[1].content), 'lines')), false);

  const tab = await tabId(options, live.url());
  await command(options, 'saveReadingSettings', { readingLanguage: 'en', mode: 'manual', prompt: settings.prompt });
  await chat.locator('yt-live-chat-text-message-renderer').filter({ hasText: english })
    .getByRole('button', { name: '翻译', exact: true }).click();
  await chat.getByText('译：' + english, { exact: true }).waitFor();
  await action(options, tab, 'room');
  await chat.getByPlaceholder('例如日语、Japanese、jp').fill('我想用日本主播们直播常用的那门语言');
  await chat.getByRole('button', { name: '保存语言' }).click();
  await chat.getByText('已保存。日语（ja）', { exact: true }).waitFor();
  assert.ok(requestLog.some(request => JSON.stringify(request.messages[1].content).includes('我想用日本主播们直播常用的那门语言')));
});

test('the popup uses English fallback and accepts language names and codes outside a menu', { timeout: 30_000 }, async t => {
  const { context, options, origin } = await boot(t, 'fr-FR');
  const live = await context.newPage();
  await live.goto('https://www.youtube.com/watch?v=one');
  const popup = await context.newPage();
  await live.bringToFront();
  await popup.goto(origin + '/popup.html');
  const target = popup.getByRole('textbox', { name: 'Chat translation language for this room' });
  await target.waitFor();
  assert.equal(await popup.locator('html').getAttribute('lang'), 'en');
  assert.equal(await target.inputValue(), '');
  assert.match(await target.getAttribute('placeholder'), /^Default: .+$/);
  await target.fill('not a language');
  await target.press('Enter');
  assert.equal(await target.getAttribute('aria-invalid'), 'true');
  await target.fill('Ελληνικά');
  await target.press('Enter');
  await popup.getByText('Translation language saved for this room.', { exact: true }).waitFor();
  const liveTab = await tabId(options, live.url());
  assert.equal((await command(options, 'site', liveTab)).targetLanguage, 'el');
  assert.equal(await target.inputValue(), 'Greek');
  await target.fill('pt-BR');
  await popup.getByRole('button', { name: 'Save', exact: true }).click();
  await until(async () => (await command(options, 'site', liveTab)).targetLanguage === 'pt-BR');
});
