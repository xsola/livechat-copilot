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
    const items = command.items ?? [];
    if (items.some(item => item.text === 'Slow original')) await new Promise(resolve => setTimeout(resolve, 900));
    const output = Array.isArray(content) ? { verdict: 'likely-chat', reason: 'Synthetic region confirmed.' }
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
  const built = path.resolve('.output/chrome-mv3');
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
  return options.evaluate(({ tab, pageAction }) => chrome.tabs.sendMessage(tab, { pageAction }), { tab, pageAction });
}

async function until(check) {
  for (let i = 0; i < 55; i++) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  assert.fail('Expected asynchronous state was not reached.');
}

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
  await chat.getByText('译：Amazing comeback 🎉').waitFor({ timeout: 7500 }).catch(async error => {
    const contents = await chat.locator('#items').innerText();
    const usage = await command(options, 'usageSummary');
    throw new Error(JSON.stringify({ contents, usage, requestLog, pageErrors }), { cause: error });
  });
  assert.ok(requestLog.some(body => JSON.stringify(body).includes('Amazing comeback')));
  assert.ok(requestLog.every(body => !JSON.stringify(body).includes('OriginalAuthor')));

  const rows = chat.locator('#items yt-live-chat-text-message-renderer');
  await rows.first().locator('#message').evaluate(node => { node.textContent = 'Slow original'; });
  await until(() => requestLog.some(body => JSON.stringify(body).includes('Slow original')));
  await rows.first().locator('#message').evaluate(node => { node.textContent = 'Fresh content'; });
  await chat.getByText('译：Fresh content').waitFor();
  assert.equal(await chat.getByText('译：Slow original').count(), 0);

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
  await live.bringToFront();
  await chat.getByRole('button', { name: 'AI 复核一次' }).click();
  await chat.getByText('Synthetic region confirmed.', { exact: false }).waitFor();
  assert.ok(requestLog.some(body => JSON.stringify(body).includes('data:image/jpeg;base64,')));
  await chat.getByRole('button', { name: '保存并启用规则' }).click();
  await chat.getByText('译：New tournament').waitFor();
  await live.reload();
  await chat.getByText('译：New tournament').waitFor();
  assert.equal(await chat.getByText('译：Amazing comeback 🎉').count(), 0);

  await action(options, tab, 'room');
  await chat.locator('input[placeholder="ja / en / zh-CN"]').fill('ja');
  await chat.getByRole('button', { name: '保存语言' }).click();
  await chat.getByText('已保存。', { exact: true }).waitFor();
  await live.reload();
  await chat.getByText('译：New tournament').waitFor();
  await action(options, tab, 'room');
  await until(() => chat.locator('input[placeholder="ja / en / zh-CN"]').inputValue({ timeout: 1500 }).then(value => value === 'ja'));
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
  await options.locator('#diagnostic').waitFor();
  const summary = await options.locator('#diagnostic').inputValue();
  assert.match(summary, /"vision"/);
  assert.doesNotMatch(summary, /Fresh content|OriginalAuthor|youtube\.com|127\.0\.0\.1/);
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
  await options.locator('#registry').fill('https://raw.githubusercontent.com/fixture/rules/main/rules/index.json');
  await options.getByRole('button', { name: '保存并授权' }).click();
  await options.getByText('社区规则：0 条已验证，1 条待验证。').waitFor();
  await command(options, 'setSite', { tabId: tab, enabled: true, origin: local });
  await live.getByText('译：New tournament', { exact: true }).waitFor();
  await until(async () => (await command(options, 'getSettings')).rules.active === 1);
  await worker.evaluate(() => { globalThis.fixtureVersion = 2; });
  await options.locator('#sync').click();
  await options.getByText('社区规则：1 条已验证，1 条待验证。').waitFor();
  await action(options, tab, 'refresh');
  await until(async () => (await command(options, 'getSettings')).rules.staged === 0);
  await options.locator('#sync').click();
  await options.getByText('社区规则：1 条已验证，0 条待验证。').waitFor();
  await live.reload();
  await live.getByText('译：New tournament', { exact: true }).waitFor();
});
