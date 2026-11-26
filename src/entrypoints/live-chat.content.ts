import { defineContentScript } from 'wxt/utils/define-content-script';
import { startLiveChat } from '../chat/controller';

export default defineContentScript({
  matches: ['https://www.youtube.com/*', 'https://youtube.com/*'],
  allFrames: true,
  runAt: 'document_idle',
  main(ctx) { startLiveChat(ctx.signal); },
});
