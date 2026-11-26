import type { CaptureRect } from './messages';

export async function captureCandidate(tab: chrome.tabs.Tab, regions: CaptureRect[]) {
  const requireOriginalTab = async () => {
    const [active] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
    if (!active || active.id !== tab.id || (active.url && tab.url && active.url !== tab.url)) {
      throw new Error('直播标签页当前不在前台，已跳过图像复核。');
    }
  };
  await requireOriginalTab();
  const screen = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' }).catch(() => {
    throw new Error('当前页面暂未获得 Chrome 截图权限。可从此标签页的扩展工具栏启动识别。');
  });
  await requireOriginalTab();
  const bitmap = await createImageBitmap(await (await fetch(screen)).blob());
  try {
    const crops = regions.map((rect, index) => {
      const scaleX = bitmap.width / rect.viewportWidth;
      const scaleY = bitmap.height / rect.viewportHeight;
      if (Math.abs(scaleX / scaleY - 1) > 0.08) throw new Error('截图前视口发生变化，已跳过复核。');
      const x = Math.floor(rect.x * scaleX);
      const y = Math.floor(rect.y * scaleY);
      const width = Math.min(bitmap.width - x, Math.floor(rect.width * scaleX));
      const height = Math.min(bitmap.height - y, Math.floor(rect.height * scaleY));
      if (width < 8 || height < 8) throw new Error('候选区域不在可见范围内。');
      const shrink = Math.min(1, 1050 / width, (index === 0 ? 820 : 200) / height);
      return { x, y, width, height, w: Math.round(width * shrink), h: Math.round(height * shrink) };
    });
    const gap = 6;
    const canvas = new OffscreenCanvas(Math.max(...crops.map(crop => crop.w)),
      crops.reduce((sum, crop) => sum + crop.h, gap * (crops.length - 1)));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Image cropping is unavailable.');
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    let top = 0;
    for (const { x, y, width, height, w, h } of crops) {
      context.drawImage(bitmap, x, y, width, height, 0, top, w, h);
      top += h + gap;
    }
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.82 });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return 'data:image/jpeg;base64,' + btoa(binary);
  } finally {
    bitmap.close();
  }
}
