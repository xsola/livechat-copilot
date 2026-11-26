export function isTwitch(host: string) {
  return host === 'www.twitch.tv' || host === 'twitch.tv';
}

const reserved = new Set(['directory', 'downloads', 'following', 'inventory', 'jobs', 'login', 'settings',
  'signup', 'store', 'subscriptions', 'turbo', 'videos', 'wallet']);

export function twitchChannel(page: URL) {
  const path = page.pathname.split('/').filter(Boolean);
  const channel = path[0] === 'popout' && path[2] === 'chat' ? path[1] : path.length === 1 ? path[0] : undefined;
  return channel && /^[a-z0-9_]{1,25}$/i.test(channel) && !reserved.has(channel.toLowerCase())
    ? channel.toLowerCase() : null;
}
