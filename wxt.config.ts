import { defineConfig } from 'wxt';

export default defineConfig({
  srcDir: 'src',
  outDir: 'dist',
  manifestVersion: 3,
  manifest: {
    name: 'LiveChat Copilot',
    description: 'Translate live chat in place and adapt new sites with a visual rule picker.',
    minimum_chrome_version: '120',
    permissions: ['storage', 'activeTab', 'scripting', 'alarms'],
    host_permissions: ['https://www.youtube.com/*', 'https://youtube.com/*'],
    optional_host_permissions: ['https://*/*', 'http://*/*'],
  },
});
