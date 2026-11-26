import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { chromium } from 'playwright';

const fixture = name => readFile(new URL('../fixtures/' + name, import.meta.url), 'utf8');

async function boot(t) {
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
    if (items.some(item => item.text === 'Slow original')) await new Promise(resolve => setTimeout(resolve, 900));
    const output = command.test === 'image-capability' ? { color: 'blue' }
      : Array.isArray(content) ? { verdict: 'likely-chat', reason: 'Synthetic region confirmed.',
        composerVerdict: command.sample.editorImage ? 'likely-composer' : undefined }
      : items.length ? { translations: items.map(({ id, text }) => ({ id, text: '译：' + text })) }
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
    channel: 'chromium', headless: true, viewport: { width: 1050, height: 900 },
    args: ['--disable-extensions-except=' + unpacked, '--load-extension=' + unpacked],
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
  const options = await context.newPage();
  await options.goto(origin + '/options.html');
  await options.locator('#model').waitFor();
  await options.locator('#model').fill('test-model');
  await options.locator('#endpoint').fill('http://127.0.0.1:' + server.address().port + '/v1');
  await options.getByRole('button', { name: '保存并授权' }).click();
  await options.getByText('已保存。', { exact: true }).waitFor();
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
  await popup.getByRole('button', { name: '选择弹幕区域' }).click();
  await chat.getByText('移动鼠标高亮元素', { exact: false }).waitFor();
  await chat.getByText('New tournament', { exact: true }).hover();
  await live.keyboard.press('ArrowUp');
  await live.keyboard.press('ArrowUp');
  await live.keyboard.press('Enter');
  await chat.getByRole('button', { name: '保存并启用规则' }).waitFor();
  await chat.getByRole('button', { name: '选择正文', exact: true }).click();
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
  await chat.locator('input[placeholder="ja / en / zh-CN"]').fill('jp');
  await chat.getByRole('button', { name: '保存语言' }).click();
  await chat.getByText('已保存。日语（ja）', { exact: true }).waitFor();
  await live.reload();
  await chat.getByText('译：New tournament').waitFor();
  await action(options, tab, 'room');
  await until(() => chat.locator('input[placeholder="ja / en / zh-CN"]').inputValue({ timeout: 1500 }).then(value => value === 'ja'));
  assert.equal(await live.frameLocator('#duplicate-chat').getByText('当前直播间', { exact: true }).count(), 0);
  await live.evaluate(() => {
    history.pushState(null, '', '/watch?v=two');
    document.querySelector('#channel-name a').setAttribute('href', '/@another-channel');
    document.querySelector('iframe').contentDocument.querySelector('#alternate .message-body').textContent = 'Second room';
  });
  await chat.getByText('译：Second room').waitFor();
  assert.equal(await chat.getByText('译：New tournament').count(), 0);
  await action(options, tab, 'room');
  assert.equal(await chat.locator('input[placeholder="ja / en / zh-CN"]').inputValue(), '');
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
  const { context, worker, options, local } = await boot(t);
  const live = await context.newPage();
  await live.goto(local + '/live/demo');
  const tab = await tabId(options, live.url());
  await command(options, 'attach', tab);
  await action(options, tab, 'detect');
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
  assert.match(await options.locator('#system-preview').inputValue(), /targetLanguage/);
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
  await options.getByRole('button', { name: '恢复继承设置' }).click();
  await options.getByText('已恢复。').waitFor();
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
