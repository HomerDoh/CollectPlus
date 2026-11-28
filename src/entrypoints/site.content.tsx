/**
 * CollectPlus 统一 Isolated World 内容脚本入口。
 *
 * 替代原 9 个分散的 `<platform>.content.tsx` 文件（消除 5,500+ 行重复代码并将 React 打包副本从 9 份降为 1 份）：
 * 1. 按当前页面 URL 从注册中心匹配对应的 Tier 3 Deep Adapter 或 Tier 2 SiteRecipe；
 * 2. 按站点能力声明（全量同步 / 评论采集 / 远端取消收藏 / 纯 Isolated Driver）初始化统一运行时；
 * 3. 通过 WXT `createShadowRootUi` 挂载样式隔离的 `CaptureOverlay`。
 */

import { createRoot, type Root } from 'react-dom/client';
import { parseBilibiliComments } from '../adapters/bilibili/parser.ts';
import { parseDouyinComments } from '../adapters/douyin/parser.ts';
import { matchSiteAdapterByUrl } from '../adapters/registry.ts';
import { createV2exIsolatedDriver } from '../adapters/v2ex/isolated-driver.ts';
import { parseXiaohongshuComments } from '../adapters/xiaohongshu/parser.ts';
import { parseZhihuComments } from '../adapters/zhihu/parser.ts';
import {
  createBridgeContentRuntime,
  type BridgeRuntimeCapabilities,
} from '../components/bridge-content-runtime.ts';
import '../components/capture-overlay.css';
import { CaptureOverlay } from '../components/CaptureOverlay.tsx';
import type { PlatformId } from '../types/schema.ts';

function resolveSiteCapabilities(
  platform: PlatformId,
): BridgeRuntimeCapabilities {
  switch (platform) {
    case 'douyin':
      return {
        fullSync: {
          platformLabelKey: 'platform.douyin',
          passiveSyncedKey: 'content.douyinPassiveSynced',
        },
        comments: {
          limit: 100,
          shouldCapture: (payload) => payload.kind === 'video',
          parseComments: parseDouyinComments,
        },
        remoteUncollect: {
          timeoutMessageKey: 'content.douyinBridgeTimeout',
        },
        errorMessageKeys: {
          readTimeout: 'content.douyinReadTimeout',
          bridgeNotReady: 'content.douyinBridgeNotReady',
          noActiveItem: 'content.douyinNoActiveItem',
          parseFailed: 'content.douyinParseFailed',
        },
      };

    case 'bilibili':
      return {
        fullSync: {
          platformLabelKey: 'platform.bilibili',
          passiveSyncedKey: 'content.bilibiliPassiveSynced',
        },
        comments: {
          limit: 100,
          shouldCapture: (payload) => payload.kind === 'video',
          parseComments: parseBilibiliComments,
        },
        remoteUncollect: {
          timeoutMessageKey: 'content.bilibiliBridgeTimeout',
        },
        errorMessageKeys: {
          readTimeout: 'content.bilibiliReadTimeout',
          bridgeNotReady: 'content.bilibiliBridgeNotReady',
          noActiveItem: 'content.bilibiliNoActiveItem',
          parseFailed: 'content.bilibiliParseFailed',
        },
      };

    case 'xiaohongshu':
      return {
        fullSync: {
          platformLabelKey: 'platform.xiaohongshu',
          passiveSyncedKey: 'content.xhsPassiveSynced',
        },
        comments: {
          limit: 100,
          parseComments: parseXiaohongshuComments,
        },
        remoteUncollect: {
          timeoutMessageKey: 'content.xhsBridgeTimeout',
        },
        errorMessageKeys: {
          readTimeout: 'content.xhsReadTimeout',
          bridgeNotReady: 'content.xhsBridgeNotReady',
          noActiveItem: 'content.xhsNoActiveItem',
          parseFailed: 'content.xhsParseFailed',
        },
      };

    case 'zhihu':
      return {
        fullSync: {
          platformLabelKey: 'platform.zhihu',
          passiveSyncedKey: 'content.zhihuPassiveSynced',
        },
        comments: {
          limit: 100,
          parseComments: parseZhihuComments,
        },
        remoteUncollect: {
          timeoutMessageKey: 'content.zhihuBridgeTimeout',
        },
        errorMessageKeys: {
          readTimeout: 'content.zhihuReadTimeout',
          bridgeNotReady: 'content.zhihuBridgeNotReady',
          noActiveItem: 'content.zhihuNoActiveItem',
          parseFailed: 'content.zhihuParseFailed',
        },
      };

    case 'v2ex':
      return {
        fullSync: {
          platformLabelKey: 'platform.v2ex',
          passiveSyncedKey: 'content.v2exPassiveSynced',
        },
        isolatedDriver: createV2exIsolatedDriver(),
      };

    default:
      // YouTube / X / Tier 2 Recipe 站点（如 XVideos / Pornhub）使用标准桥接核心能力
      return {};
  }
}

export default defineContentScript({
  matches: [
    'https://www.douyin.com/*',
    'https://douyin.com/*',
    'https://www.bilibili.com/*',
    'https://bilibili.com/*',
    'https://space.bilibili.com/*',
    'https://www.v2ex.com/*',
    'https://v2ex.com/*',
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
  cssInjectionMode: 'ui',
  runAt: 'document_idle',

  async main(ctx) {
    const adapter = matchSiteAdapterByUrl(window.location.href);
    if (!adapter) {
      return;
    }

    const capabilities = resolveSiteCapabilities(adapter.id);
    const runtime = await createBridgeContentRuntime(
      ctx,
      adapter,
      capabilities,
    );

    const ui = await createShadowRootUi<Root>(ctx, {
      name: 'collect-plus-overlay',
      position: 'overlay',
      zIndex: 2147483647,
      anchor: 'body',
      onMount(container) {
        const appMount = document.createElement('div');
        container.append(appMount);
        const root = createRoot(appMount);
        root.render(
          <CaptureOverlay store={runtime.store} actions={runtime.actions} />,
        );
        return root;
      },
      onRemove(root?: Root) {
        root?.unmount();
      },
    });

    ui.mount();
    ctx.onInvalidated(() => {
      ui.remove();
    });
  },
});
