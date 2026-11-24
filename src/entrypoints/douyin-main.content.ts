import { installDouyinMainHook } from '../adapters/douyin/main-hook.ts';

export default defineContentScript({
  matches: ['https://www.douyin.com/*', 'https://douyin.com/*'],
  world: 'MAIN',
  runAt: 'document_start',
  main() {
    installDouyinMainHook();
  },
});
