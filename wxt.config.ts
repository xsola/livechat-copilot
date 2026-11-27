import { resolve } from 'node:path';
import { defineConfig } from 'wxt';

const icons = { 16: 'icons/icon-16.png', 32: 'icons/icon-32.png', 48: 'icons/icon-48.png', 128: 'icons/icon-128.png' };
const sourceRepo = 'https://github.com/xsola/livechat-copilot';

export default defineConfig({
  srcDir: 'src',
  outDir: 'dist',
  manifestVersion: 3,
  hooks: {
    'build:manifestGenerated': (_wxt, manifest) => { delete manifest.side_panel; },
    'build:publicAssets': (wxt, files) => {
      const { GITHUB_REPOSITORY, GITHUB_SHA } = process.env;
      const source = GITHUB_REPOSITORY === 'xsola/livechat-copilot' && /^[a-f0-9]{40}$/.test(GITHUB_SHA ?? '')
        ? sourceRepo + '/tree/' + GITHUB_SHA
        : sourceRepo;
      files.push(
        { relativeDest: 'LICENSE', absoluteSrc: resolve(wxt.config.root, 'LICENSE') },
        { relativeDest: 'SOURCE.txt', contents: [
          'LiveChat Copilot source code is available under the Mozilla Public License, v. 2.0.',
          'Source: ' + source,
          'See LICENSE and the build instructions in the source repository.',
          'Bundled third-party notices are in the licenses directory.',
          '',
        ].join('\n') },
        { relativeDest: 'licenses/zod.txt', absoluteSrc: resolve(wxt.config.root, 'node_modules/zod/LICENSE') },
        { relativeDest: 'licenses/wxt.txt', absoluteSrc: resolve(wxt.config.root, 'node_modules/@wxt-dev/browser/LICENSE') },
        { relativeDest: 'licenses/webext-core-match-patterns.txt',
          absoluteSrc: resolve(wxt.config.root, 'node_modules/@webext-core/match-patterns/LICENSE') },
      );
    },
  },
  manifest: {
    name: 'LiveChat Copilot',
    default_locale: 'en',
    description: 'Translate live chat in place and adapt new sites with a visual rule picker.',
    minimum_chrome_version: '120',
    icons,
    action: { default_icon: icons },
    permissions: ['storage', 'activeTab', 'scripting', 'alarms', 'webNavigation'],
    host_permissions: ['https://www.youtube.com/*', 'https://youtube.com/*'],
    optional_host_permissions: ['https://*/*', 'http://*/*'],
  },
});
