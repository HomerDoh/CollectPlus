import { installBilibiliMainHook } from '../adapters/bilibili/main-hook.ts';

export default defineContentScript({
  matches: [
    'https://www.bilibili.com/*',
    'https://bilibili.com/*',
    'https://space.bilibili.com/*',
  ],
  world: 'MAIN',
  runAt: 'document_start',
  main() {
    installBilibiliMainHook();
  },
});
