import { z } from 'zod';
import { isYouTube } from './config';

export const scopeType = z.enum(['room', 'page', 'site']);
export type TranslationScope = z.infer<typeof scopeType>;

export interface ScopeOption {
  scope: TranslationScope;
  key: string;
  value: boolean | null;
}

function roomIdentity(page: URL) {
  if (isYouTube(page.hostname)) {
    const video = page.searchParams.get('v') ?? /^\/live\/([\w-]+)/.exec(page.pathname)?.[1];
    return video && /^[\w-]{1,100}$/.test(video) ? 'youtube:' + video : null;
  }
  const room = page.searchParams.get('room') ?? page.searchParams.get('channel') ??
    /^\/(?:live|room|channel)\/([^/]+)\/?$/.exec(page.pathname)?.[1];
  return room && room.length <= 100 ? page.origin + '|' + room : null;
}

async function key(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function scopeOptions(page: URL, enabledSites: string[], overrides: Record<string, boolean>) {
  const canonical = new URL(page);
  canonical.searchParams.sort();
  if (!canonical.hash.startsWith('#/')) canonical.hash = '';
  const room = roomIdentity(page);
  const [pageKey, roomKey] = await Promise.all([
    key('page|' + canonical.href),
    room ? key('room|' + room) : undefined,
  ]);
  const options: ScopeOption[] = [
    { scope: 'page', key: pageKey, value: overrides[pageKey] ?? null },
    { scope: 'site', key: page.origin, value: enabledSites.includes(page.origin) },
  ];
  if (roomKey) options.splice(1, 0, { scope: 'room', key: roomKey, value: overrides[roomKey] ?? null });
  return options;
}

export function effectiveScope(options: ScopeOption[]) {
  return options.find(option => option.value !== null);
}

export function scopeValue(options: ScopeOption[], scope: TranslationScope) {
  const index = options.findIndex(option => option.scope === scope);
  return index >= 0 ? effectiveScope(options.slice(index))?.value ?? false : false;
}
