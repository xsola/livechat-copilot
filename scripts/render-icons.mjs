import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const icons = new URL('../public/icons/', import.meta.url);
const svg = await readFile(new URL('logo.svg', icons), 'utf8');
const browser = await chromium.launch({ channel: 'chromium', headless: true });
try {
  const page = await browser.newPage({ deviceScaleFactor: 4 });
  for (const size of [16, 32, 48, 128]) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent('<style>body{margin:0}svg{display:block;width:100vw;height:100vh}</style>' + svg);
    await page.screenshot({
      path: fileURLToPath(new URL('icon-' + size + '.png', icons)),
      omitBackground: true,
      scale: 'css',
    });
  }
} finally {
  await browser.close();
}
