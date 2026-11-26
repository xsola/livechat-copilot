import type { ChatRule } from './schema';

export const builtins: ChatRule[] = ['www.youtube.com', 'youtube.com'].map((host, index) => ({
  schemaVersion: 1,
  id: index === 0 ? 'youtube-live' : 'youtube-live-root',
  version: 1,
  host,
  framePathPrefix: '/live_chat',
  container: 'yt-live-chat-item-list-renderer #items',
  message: 'yt-live-chat-text-message-renderer, yt-live-chat-paid-message-renderer, yt-live-chat-membership-item-renderer',
  body: '#message',
  composer: 'yt-live-chat-message-input-renderer #input, yt-live-chat-message-input-renderer [role="textbox"]',
  sendButton: 'yt-live-chat-message-input-renderer #send-button button',
}));
