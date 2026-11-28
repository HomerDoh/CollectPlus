/**
 * Collect+ 统一 Main World 内容脚本入口（`world: 'MAIN'`, `runAt: 'document_start'`）。
 *
 * 替代原 8 个分散的 `*-main.content.ts` 文件：
 * 按当前宿主域名路由至对应的 Tier 3 深度站点 Main Hook 或 Tier 2 声明式 Recipe Main Hook。
 * 铁律：严禁引入 `chrome.*` API、Dexie、React 或 Parser 归一化代码。
 */

import { installBilibiliMainHook } from '../adapters/bilibili/main-hook.ts';
import { installDouyinMainHook } from '../adapters/douyin/main-hook.ts';
import {
  BUILTIN_SITE_RECIPES,
  installRecipeMainHook,
} from '../adapters/recipes/index.ts';
import { installTwitterMainHook } from '../adapters/twitter/main-hook.ts';
import { installXiaohongshuMainHook } from '../adapters/xiaohongshu/main-hook.ts';
import { installYoutubeMainHook } from '../adapters/youtube/main-hook.ts';
import { installZhihuMainHook } from '../adapters/zhihu/main-hook.ts';

function matchesHost(
  host: string,
  candidates: readonly string[],
  allowSubdomains = false,
): boolean {
  for (const target of candidates) {
    if (host === target) {
      return true;
    }
    if (allowSubdomains && host.endsWith(`.${target}`)) {
      return true;
    }
  }
  return false;
}

export default defineContentScript({
  matches: [
    'https://www.douyin.com/*',
    'https://douyin.com/*',
    'https://www.bilibili.com/*',
    'https://bilibili.com/*',
    'https://space.bilibili.com/*',
    'https://www.xiaohongshu.com/*',
    'https://xiaohongshu.com/*',
    'https://www.zhihu.com/*',
    'https://zhihu.com/*',
    'https://zhuanlan.zhihu.com/*',
    'https://www.youtube.com/*',
    'https://m.youtube.com/*',
    'https://youtube.com/*',
    'https://x.com/*',
    'https://www.x.com/*',
    'https://twitter.com/*',
    'https://www.twitter.com/*',
    'https://www.xvideos.com/*',
    'https://xvideos.com/*',
    'https://www.pornhub.com/*',
    'https://*.pornhub.com/*',
    'https://pornhub.com/*',
  ],
  world: 'MAIN',
  runAt: 'document_start',
  main() {
    const host = window.location.hostname.toLowerCase();

    if (matchesHost(host, ['www.douyin.com', 'douyin.com'])) {
      installDouyinMainHook();
      return;
    }
    if (
      matchesHost(host, [
        'www.bilibili.com',
        'bilibili.com',
        'space.bilibili.com',
      ])
    ) {
      installBilibiliMainHook();
      return;
    }
    if (matchesHost(host, ['www.xiaohongshu.com', 'xiaohongshu.com'])) {
      installXiaohongshuMainHook();
      return;
    }
    if (
      matchesHost(host, ['www.zhihu.com', 'zhihu.com', 'zhuanlan.zhihu.com'])
    ) {
      installZhihuMainHook();
      return;
    }
    if (matchesHost(host, ['www.youtube.com', 'm.youtube.com', 'youtube.com'])) {
      installYoutubeMainHook();
      return;
    }
    if (
      matchesHost(host, ['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'])
    ) {
      installTwitterMainHook();
      return;
    }

    // Tier 2 声明式 Recipe 自动匹配（如 XVideos / Pornhub / 后续声明式站点）
    for (const recipe of BUILTIN_SITE_RECIPES) {
      if (
        recipe.globalSource &&
        matchesHost(
          host,
          recipe.matchHosts.map((h) => h.toLowerCase()),
          Boolean(recipe.matchSubdomains),
        )
      ) {
        installRecipeMainHook(recipe);
        return;
      }
    }
  },
});
