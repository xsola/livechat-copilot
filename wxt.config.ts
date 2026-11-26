import { defineConfig } from 'wxt';

const icons = { 16: 'icons/icon-16.png', 32: 'icons/icon-32.png', 48: 'icons/icon-48.png', 128: 'icons/icon-128.png' };

export default defineConfig({
  srcDir: 'src',
  outDir: 'dist',
  manifestVersion: 3,
  manifest: {
    name: 'LiveChat Copilot',
    default_locale: 'en',
    description: 'Translate live chat in place and adapt new sites with a visual rule picker.',
    minimum_chrome_version: '120',
    icons,
    action: { default_icon: icons },
    permissions: ['storage', 'activeTab', 'scripting', 'alarms'],
    host_permissions: ['https://www.youtube.com/*', 'https://youtube.com/*'],
    optional_host_permissions: ['https://*/*', 'http://*/*'],
  },
});
