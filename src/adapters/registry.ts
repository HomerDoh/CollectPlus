/**
 * 多平台适配器全局注册中心。
 *
 * 已注册抖音（`douyinAdapter`）、B站（`bilibiliAdapter`）、V2EX（`v2exAdapter`）、
 * 小红书（`xiaohongshuAdapter`）与知乎（`zhihuAdapter`）独立适配器，
 * 结构保持开放以支持平滑接入更多内容平台。
 */

import type { PlatformDnrSpec } from '../download/dnr.ts';
import type { PlatformAdapter } from '../types/adapter.ts';
import type { PlatformId } from '../types/schema.ts';
import { bilibiliAdapter } from './bilibili/parser.ts';
import { douyinAdapter } from './douyin/parser.ts';
import { v2exAdapter } from './v2ex/parser.ts';
import { xiaohongshuAdapter } from './xiaohongshu/parser.ts';
import { zhihuAdapter } from './zhihu/parser.ts';

const REGISTERED_ADAPTERS: readonly PlatformAdapter[] = [
  douyinAdapter,
  bilibiliAdapter,
  v2exAdapter,
  xiaohongshuAdapter,
  zhihuAdapter,
];

const ADAPTER_BY_ID: ReadonlyMap<PlatformId, PlatformAdapter> = new Map(
  REGISTERED_ADAPTERS.map((adapter) => [adapter.id, adapter]),
);

/** 返回所有已注册的平台适配器列表 */
export function getAllAdapters(): readonly PlatformAdapter[] {
  return REGISTERED_ADAPTERS;
}

/** 按平台 ID 查找对应的适配器实例 */
export function getAdapterById(id: PlatformId): PlatformAdapter | undefined {
  return ADAPTER_BY_ID.get(id);
}

/** 按页面 URL 匹配对应的平台适配器 */
export function matchAdapterByUrl(url: string): PlatformAdapter | undefined {
  for (const adapter of REGISTERED_ADAPTERS) {
    if (adapter.matchesUrl(url)) {
      return adapter;
    }
  }
  return undefined;
}

/** 汇总所有已注册平台所需的 Session DNR 防盗链请求头规则 */
export function collectAllPlatformDnrSpecs(): PlatformDnrSpec[] {
  return REGISTERED_ADAPTERS.map((adapter) => ({
    platform: adapter.id,
    rules: adapter.getDnrRules(),
  }));
}
