import type { ChatRule } from './schema';
import { bilibiliBody, bilibiliHost, bilibiliRow } from '../chat/bilibili';

const youtube: ChatRule[] = ['www.youtube.com', 'youtube.com'].map((host, index) => ({
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

const twitch: ChatRule[] = ['www.twitch.tv', 'twitch.tv'].map((host, index) => ({
  schemaVersion: 1, id: index ? 'twitch-live-root' : 'twitch-live', version: 1, host,
  container: '.chat-scrollable-area__message-container, [data-test-selector="chat-scrollable-area__message-container"]',
  message: ':is(.chat-line__message, [data-a-target="chat-line-message"], [data-test-selector="chat-line-message"])' +
    ':not(:is(.chat-line__message, [data-a-target="chat-line-message"], [data-test-selector="chat-line-message"]) *)',
  body: '[data-a-target="chat-line-message-body"], [data-test-selector="chat-line-message-body"], .chat-line__message--message',
  composer: '[data-a-target="chat-input"]',
  sendButton: '[data-a-target="chat-send-button"]',
}));

const bilibiliList = ':is(#chat-history-list, .chat-history-list, .room-history-list)';
const bilibili: ChatRule = {
  schemaVersion: 1, id: 'bilibili-live', version: 1, host: bilibiliHost,
  container: bilibiliList + ':has(' + bilibiliRow + '):not(:has(' + bilibiliList + ' ' + bilibiliRow + '))',
  message: bilibiliRow,
  body: bilibiliBody,
};

export const builtins = [...youtube, ...twitch, bilibili];
