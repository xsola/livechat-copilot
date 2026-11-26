import type { CaptureRect } from './messages';

export async function captureCandidate(tab: chrome.tabs.Tab, rect: CaptureRect) {
  const requireOriginalTab = async () => {
    const [active] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
    if (!active || active.id !== tab.id || (active.url && tab.url && active.url !== tab.url)) {
      throw new Error('Open the original live tab before running image verification.');
    }
  };
  await requireOriginalTab();
  const screen = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' }).catch(() => {
    throw new Error('Screenshot access is unavailable. Reopen the extension toolbar popup on this tab and try again.');
  });
  await requireOriginalTab();
  const bitmap = await createImageBitmap(await (await fetch(screen)).blob());
  try {
    const scaleX = bitmap.width / rect.viewportWidth;
    const scaleY = bitmap.height / rect.viewportHeight;
    if (Math.abs(scaleX / scaleY - 1) > 0.08) throw new Error('The viewport changed before capture. Try again.');
    const x = Math.floor(rect.x * scaleX);
    const y = Math.floor(rect.y * scaleY);
    const width = Math.min(bitmap.width - x, Math.floor(rect.width * scaleX));
    const height = Math.min(bitmap.height - y, Math.floor(rect.height * scaleY));
    if (width < 8 || height < 8) throw new Error('The candidate is outside the visible viewport.');
    const shrink = Math.min(1, 1050 / width, 1050 / height);
    const canvas = new OffscreenCanvas(Math.max(1, Math.round(width * shrink)), Math.max(1, Math.round(height * shrink)));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Image cropping is unavailable.');
    context.drawImage(bitmap, x, y, width, height, 0, 0, canvas.width, canvas.height);
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.82 });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return 'data:image/jpeg;base64,' + btoa(binary);
  } finally {
    bitmap.close();
  }
}
