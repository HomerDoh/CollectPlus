/**
 * Chrome `declarativeNetRequest` 会话级（Session）防盗链请求头规则管理器。
 *
 * 所有规则均严格限定 `initiatorDomains: [chrome.runtime.id]`，
 * 仅对扩展自身上下文（Offscreen / Library / Background）发起的媒体下载请求注入
 * `Referer` / `Origin` 请求头，绝不干扰用户正常浏览任何网页。
 */

import type { DnrHeaderRuleSpec } from '../types/adapter.ts';
import type { PlatformId } from '../types/schema.ts';

/** 各平台稳定的 Session DNR 规则 ID 基数（每平台预留 1000 个偏移位） */
export const PLATFORM_DNR_RULE_BASE: Readonly<Record<PlatformId, number>> = {
  douyin: 1000,
  bilibili: 2000,
  xiaohongshu: 3000,
  twitter: 4000,
  instagram: 5000,
  zhihu: 6000,
  youtube: 7000,
  v2ex: 8000,
};

/** 缺省生效的资源类型集合 */
const DEFAULT_DNR_RESOURCE_TYPES: readonly `${chrome.declarativeNetRequest.ResourceType}`[] =
  ['xmlhttprequest', 'media', 'image', 'other'];

/** 单个平台注册到 DNR 管理器的规则集合描述 */
export interface PlatformDnrSpec {
  platform: PlatformId;
  rules: readonly DnrHeaderRuleSpec[];
}

function assertValidRuleId(
  platform: PlatformId,
  idOffset: number,
  computedId: number,
): void {
  if (
    !Number.isInteger(idOffset) ||
    idOffset < 0 ||
    idOffset >= 1000 ||
    !Number.isInteger(computedId) ||
    computedId <= 0
  ) {
    throw new Error(
      `Invalid DNR rule idOffset (${idOffset}) for platform "${platform}". Expected integer in [0, 999].`,
    );
  }
}

function buildSessionRules(
  platformSpecs: readonly PlatformDnrSpec[],
  extensionId: string,
): chrome.declarativeNetRequest.Rule[] {
  const rules: chrome.declarativeNetRequest.Rule[] = [];
  const usedIds = new Set<number>();

  for (const { platform, rules: specList } of platformSpecs) {
    const baseId = PLATFORM_DNR_RULE_BASE[platform];

    for (const spec of specList) {
      const urlFilter = spec.urlFilter.trim();
      const referer = spec.referer.trim();
      if (!urlFilter || !referer) {
        continue;
      }

      const ruleId = baseId + spec.idOffset;
      assertValidRuleId(platform, spec.idOffset, ruleId);

      if (usedIds.has(ruleId)) {
        throw new Error(
          `Duplicate DNR session rule id (${ruleId}) detected for platform "${platform}".`,
        );
      }
      usedIds.add(ruleId);

      const requestHeaders: chrome.declarativeNetRequest.ModifyHeaderInfo[] = [
        {
          header: 'Referer',
          operation: 'set',
          value: referer,
        },
      ];

      const origin = spec.origin?.trim();
      if (origin) {
        requestHeaders.push({
          header: 'Origin',
          operation: 'set',
          value: origin,
        });
      }

      const resourceTypes: `${chrome.declarativeNetRequest.ResourceType}`[] =
        spec.resourceTypes && spec.resourceTypes.length > 0
          ? [...spec.resourceTypes]
          : [...DEFAULT_DNR_RESOURCE_TYPES];

      rules.push({
        id: ruleId,
        priority: 1,
        action: {
          type: 'modifyHeaders',
          requestHeaders,
        },
        condition: {
          urlFilter,
          initiatorDomains: [extensionId],
          resourceTypes,
        },
      });
    }
  }

  return rules;
}

/**
 * 原子同步扩展的全部会话级 DNR 防盗链请求头规则。
 *
 * 先读取当前全部 session rules 并移除，再写入本次计算出的完整规则集，
 * 避免扩展重启或适配器更新后遗留过期规则。
 *
 * @returns 本次成功生效的会话规则数量
 */
export async function syncSessionDnrRules(
  platformSpecs: readonly PlatformDnrSpec[],
): Promise<number> {
  const extensionId = chrome.runtime.id;
  if (!extensionId) {
    throw new Error('Unable to resolve chrome.runtime.id for DNR rules.');
  }

  const addRules = buildSessionRules(platformSpecs, extensionId);
  const existingRules = await chrome.declarativeNetRequest.getSessionRules();
  const removeRuleIds = existingRules.map((rule) => rule.id);

  if (removeRuleIds.length > 0 || addRules.length > 0) {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds,
      addRules,
    });
  }

  return addRules.length;
}

/**
 * 清除扩展当前全部会话级 DNR 规则。
 */
export async function clearSessionDnrRules(): Promise<void> {
  const existingRules = await chrome.declarativeNetRequest.getSessionRules();
  if (existingRules.length === 0) {
    return;
  }

  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: existingRules.map((rule) => rule.id),
  });
}
