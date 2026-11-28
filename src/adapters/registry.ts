/**
 * 三层多平台适配器全局注册中心（单点真相源）。
 *
 * 匹配优先级由专到泛：
 * 1. Tier 3 深度站点适配器（抖音、B站、V2EX、小红书、知乎、YouTube、X）；
 * 2. Tier 2 声明式站点规则编译适配器（XVideos、Pornhub 及后续内置/声明式站点）；
 * 3. Tier 1 通用全网网页适配器（`universalWebAdapter`，兜底任意 `http://`/`https://` 网页）。
 */

import type { PlatformDnrSpec } from '../download/dnr.ts';
import type { PlatformAdapter } from '../types/adapter.ts';
import type { PlatformId } from '../types/schema.ts';
import { bilibiliAdapter } from './bilibili/parser.ts';
import { douyinAdapter } from './douyin/parser.ts';
import { BUILTIN_RECIPE_ADAPTERS } from './recipes/index.ts';
import { twitterAdapter } from './twitter/parser.ts';
import {
  isUniversalCapturableUrl,
  universalWebAdapter,
} from './universal/parser.ts';
import { v2exAdapter } from './v2ex/parser.ts';
import { xiaohongshuAdapter } from './xiaohongshu/parser.ts';
import { youtubeAdapter } from './youtube/parser.ts';
import { zhihuAdapter } from './zhihu/parser.ts';

/** Tier 3 深度站点适配器列表 */
const DEEP_SITE_ADAPTERS: readonly PlatformAdapter[] = [
  douyinAdapter,
  bilibiliAdapter,
  v2exAdapter,
  xiaohongshuAdapter,
  zhihuAdapter,
  youtubeAdapter,
  twitterAdapter,
];

/** 全部专属站点适配器（Tier 3 深度站点 + Tier 2 声明式 Recipe 站点，不含通用兜底 `'web'`） */
const REGISTERED_SITE_ADAPTERS: readonly PlatformAdapter[] = [
  ...DEEP_SITE_ADAPTERS,
  ...BUILTIN_RECIPE_ADAPTERS,
];

/** 全部适配器（含 Tier 1 通用全网适配器 `'web'`） */
const ALL_ADAPTERS: readonly PlatformAdapter[] = [
  ...REGISTERED_SITE_ADAPTERS,
  universalWebAdapter,
];

const ADAPTER_BY_ID: ReadonlyMap<PlatformId, PlatformAdapter> = new Map(
  ALL_ADAPTERS.map((adapter) => [adapter.id, adapter]),
);

/** 返回所有已注册的专属站点适配器（Tier 3 + Tier 2，不含通用 `'web'`） */
export function getAllSiteAdapters(): readonly PlatformAdapter[] {
  return REGISTERED_SITE_ADAPTERS;
}

/** 返回所有已注册的平台适配器列表（含通用 `'web'`） */
export function getAllAdapters(): readonly PlatformAdapter[] {
  return ALL_ADAPTERS;
}

/** 按平台 ID 查找对应的适配器实例 */
export function getAdapterById(id: PlatformId): PlatformAdapter | undefined {
  return ADAPTER_BY_ID.get(id);
}

/** 仅按页面 URL 匹配专属站点适配器（Tier 3 / Tier 2）；未命中时返回 `undefined` */
export function matchSiteAdapterByUrl(url: string): PlatformAdapter | undefined {
  for (const adapter of REGISTERED_SITE_ADAPTERS) {
    if (adapter.matchesUrl(url)) {
      return adapter;
    }
  }
  return undefined;
}

/** 兼容旧名：匹配专属站点适配器（Tier 3 / Tier 2） */
export function matchAdapterByUrl(url: string): PlatformAdapter | undefined {
  return matchSiteAdapterByUrl(url);
}

/** 由专到泛匹配任意页面 URL：先查 Tier 3/2 专属适配器，未命中且为 HTTP(S) 网页时回退 Tier 1 通用适配器 */
export function matchAdapterOrUniversalByUrl(
  url: string,
): PlatformAdapter | undefined {
  const siteAdapter = matchSiteAdapterByUrl(url);
  if (siteAdapter) {
    return siteAdapter;
  }
  return isUniversalCapturableUrl(url) ? universalWebAdapter : undefined;
}

/** 返回支持后台静默取消原站收藏的入口 URL（未支持时返回 `undefined`） */
export function getRemoteUncollectEntryUrl(
  platform: PlatformId,
): string | undefined {
  return ADAPTER_BY_ID.get(platform)?.remoteUncollectEntryUrl;
}

/** 汇总所有已注册专属站点所需的静态 Session DNR 防盗链请求头规则 */
export function collectAllPlatformDnrSpecs(): PlatformDnrSpec[] {
  return REGISTERED_SITE_ADAPTERS.map((adapter) => ({
    platform: adapter.id,
    rules: adapter.getDnrRules(),
  }));
}
