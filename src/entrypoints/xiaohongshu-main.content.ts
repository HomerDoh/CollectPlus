import { installXiaohongshuMainHook } from '../adapters/xiaohongshu/main-hook.ts';

export default defineContentScript({
  matches: ['https://www.xiaohongshu.com/*', 'https://xiaohongshu.com/*'],
  world: 'MAIN',
  runAt: 'document_start',
  main() {
    installXiaohongshuMainHook();
  },
});
