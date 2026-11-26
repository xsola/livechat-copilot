import type { CaptureRect } from '../../platform/messages';

export function visibleBounds(node: Element) {
  const view = node.ownerDocument.defaultView!;
  const rect = node.getBoundingClientRect();
  let left = Math.max(0, rect.left);
  let top = Math.max(0, rect.top);
  let right = Math.min(view.innerWidth, rect.right);
  let bottom = Math.min(view.innerHeight, rect.bottom);
  for (let parent = node.parentElement; parent && parent !== node.ownerDocument.documentElement; parent = parent.parentElement) {
    const style = view.getComputedStyle(parent);
    if (style.overflowX === 'visible' && style.overflowY === 'visible') continue;
    const clip = parent.getBoundingClientRect();
    if (style.overflowX !== 'visible') { left = Math.max(left, clip.left); right = Math.min(right, clip.right); }
    if (style.overflowY !== 'visible') { top = Math.max(top, clip.top); bottom = Math.min(bottom, clip.bottom); }
  }
  return new DOMRect(left, top, Math.max(0, right - left), Math.max(0, bottom - top));
}

export function captureRect(node: Element): CaptureRect {
  const rect = visibleBounds(node);
  let x = rect.x;
  let y = rect.y;
  let right = rect.right;
  let bottom = rect.bottom;
  let view: Window = node.ownerDocument.defaultView!;
  for (;;) {
    x = Math.max(0, x);
    y = Math.max(0, y);
    right = Math.min(view.innerWidth, right);
    bottom = Math.min(view.innerHeight, bottom);
    if (right - x < 8 || bottom - y < 8) throw new Error('Scroll the candidate into view and try again.');
    if (view === view.top) {
      if (view.visualViewport && (view.visualViewport.scale !== 1 ||
        view.visualViewport.offsetLeft !== 0 || view.visualViewport.offsetTop !== 0)) {
        throw new Error('Reset page pinch zoom before running image verification.');
      }
      return { x, y, width: right - x, height: bottom - y, viewportWidth: view.innerWidth, viewportHeight: view.innerHeight };
    }
    const frame = view.frameElement as HTMLElement | null;
    if (!frame || !frame.offsetWidth || !frame.offsetHeight) throw new Error('Image verification requires a visible same-origin frame.');
    const bounds = frame.getBoundingClientRect();
    const sx = bounds.width / frame.offsetWidth;
    const sy = bounds.height / frame.offsetHeight;
    const left = bounds.left + frame.clientLeft * sx;
    const top = bounds.top + frame.clientTop * sy;
    x = left + x * sx;
    y = top + y * sy;
    right = left + right * sx;
    bottom = top + bottom * sy;
    view = view.parent;
  }
}
