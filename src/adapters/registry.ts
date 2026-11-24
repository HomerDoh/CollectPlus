/**
 * 多平台适配器全局注册中心。
 *
 * 当前注册一期抖音适配器（`douyinAdapter`），
 * 结构保持开放以支持二期平滑接入 B 站、小红书、X、Instagram 等平台适配器。
 */

import type { PlatformDnrSpec } from '../download/dnr.ts';
import type { PlatformAdapter } from '../types/adapter.ts';
import type { PlatformId } from '../types/schema.ts';
import { douyinAdapter } from './douyin/parser.ts';

const REGISTERED_ADAPTERS: readonly PlatformAdapter[] = [douyinAdapter];

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
