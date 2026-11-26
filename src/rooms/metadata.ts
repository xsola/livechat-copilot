import { isYouTube } from '../platform/config';
import { languageCode } from '../platform/config';
import type { RoomProfile } from '../models/tasks';

export function roomLocation() {
  const frame = new URL(location.href);
  try {
    const page = new URL(window.top!.location.href);
    return page.origin === frame.origin ? { page, frame } : undefined;
  } catch {
    return undefined;
  }
}

export function roomMetadata(page: URL, frame: URL) {
  const root = window.top!.document;
  const meta = (key: string) => root.querySelector('meta[property="' + key + '"],meta[name="' + key + '"]')?.getAttribute('content')?.trim();
  const owner = isYouTube(page.hostname)
    ? root.querySelector<HTMLAnchorElement>('#owner #channel-name a[href], ytd-watch-metadata ytd-channel-name a[href]') : null;
  const channelPath = owner?.pathname.match(/^\/(?:@[^/]+|channel\/[^/]+|c\/[^/]+|user\/[^/]+)/)?.[0];
  const platformId = isYouTube(page.hostname)
    ? page.searchParams.get('v') ?? frame.searchParams.get('v')
    : ['room', 'channel', 'id', 'v'].map(key => page.searchParams.get(key)).find(Boolean);
  const key = (page.origin + '|' + (channelPath || page.pathname + (platformId ? '|' + platformId : ''))).slice(0, 300);
  const hint = languageCode.safeParse(meta('content-language') ?? meta('og:locale')?.replace('_', '-'));
  const profile: Omit<RoomProfile, 'language'> = {
    title: (meta('og:title') ?? root.querySelector('main h1, ytd-watch-metadata h1')?.textContent?.trim() ?? root.title)?.slice(0, 200) || null,
    streamer: (owner?.textContent?.trim() || meta('author'))?.slice(0, 120) || null,
    category: meta('video:tag')?.slice(0, 100) || null,
  };
  return { key, profile, languageHint: hint.data };
}
