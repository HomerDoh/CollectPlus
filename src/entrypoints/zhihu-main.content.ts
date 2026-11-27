import { installZhihuMainHook } from '../adapters/zhihu/main-hook.ts';

export default defineContentScript({
  matches: [
    'https://www.zhihu.com/*',
    'https://zhihu.com/*',
    'https://zhuanlan.zhihu.com/*',
  ],
  world: 'MAIN',
  runAt: 'document_start',
  main() {
    installZhihuMainHook();
  },
});
