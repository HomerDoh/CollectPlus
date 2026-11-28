/**
 * Chrome `declarativeNetRequest` 会话级（Session）防盗链请求头规则管理器。
 *
 * 规则 ID 分段（完全隔离、零硬编码平台表）：
 * - `1000..29999`：已注册站点适配器与声明式 Recipe 的静态会话级规则（按注册序确定性分配）
 * - `30000..49999`：下载任务级动态按需防盗链规则池（支持任意第三方网站，任务结束立即释放）
 * - `50000..50999`：远程存储插件媒体流式播放临时鉴权规则段
 *
 * 安全铁律：所有规则均严格限定 `initiatorDomains: [chrome.runtime.id]`，
 * 绝不干扰用户正常浏览任何网页。
 */

import type { DnrHeaderRuleSpec } from '../types/adapter.ts';
import {
  sanitizeAssetRequestHeaders,
  type MediaAsset,
  type PlatformId,
} from '../types/schema.ts';

/** 静态适配器规则段起始 ID（范围：1000..29999） */
export const STATIC_ADAPTER_DNR_RULE_BASE = 1000;

/** 任务级动态防盗链规则池起始 ID（范围：30000..49999） */
export const TASK_DYNAMIC_DNR_RULE_BASE = 30000;
const TASK_DYNAMIC_DNR_RULE_LIMIT = 49999;

/** 远程存储插件媒体流式播放临时 Session DNR 规则 ID 起始段（与平台/任务规则段完全隔离） */
export const STORAGE_MEDIA_DNR_RULE_BASE = 50000;

/** 缺省生效的资源类型集合 */
const DEFAULT_DNR_RESOURCE_TYPES: readonly `${chrome.declarativeNetRequest.ResourceType}`[] =
  ['xmlhttprequest', 'media', 'image', 'other'];

/** 单个平台注册到 DNR 管理器的规则集合描述 */
export interface PlatformDnrSpec {
  platform: PlatformId;
  rules: readonly DnrHeaderRuleSpec[];
}

/** 当前活跃下载任务占用的动态 DNR 规则 ID 索引（key = taskKey） */
const activeTaskRuleIds = new Map<string, number[]>();
const allocatedTaskRuleIds = new Set<number>();
let nextTaskRuleCursor = TASK_DYNAMIC_DNR_RULE_BASE;

function buildSessionRules(
  platformSpecs: readonly PlatformDnrSpec[],
  extensionId: string,
): chrome.declarativeNetRequest.Rule[] {
  const rules: chrome.declarativeNetRequest.Rule[] = [];
  let nextRuleId = STATIC_ADAPTER_DNR_RULE_BASE;

  for (const { platform, rules: specList } of platformSpecs) {
    const seenOffsets = new Set<number>();

    for (const spec of specList) {
      const urlFilter = spec.urlFilter.trim();
      const referer = spec.referer.trim();
      if (!urlFilter || !referer) {
        continue;
      }

      if (
        !Number.isInteger(spec.idOffset) ||
        spec.idOffset < 0 ||
        seenOffsets.has(spec.idOffset)
      ) {
        throw new Error(
          `Invalid or duplicate DNR rule idOffset (${spec.idOffset}) for platform "${platform}".`,
        );
      }
      seenOffsets.add(spec.idOffset);

      if (nextRuleId >= TASK_DYNAMIC_DNR_RULE_BASE) {
        throw new Error(
          `Static DNR session rule capacity exceeded at platform "${platform}".`,
        );
      }

      const ruleId = nextRuleId;
      nextRuleId += 1;

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
 * 原子同步扩展的全部静态适配器会话级 DNR 防盗链请求头规则（仅操作 `1000..29999` 段）。
 *
 * @returns 本次成功生效的静态会话规则数量
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
  const removeRuleIds = existingRules
    .filter((rule) => rule.id < TASK_DYNAMIC_DNR_RULE_BASE)
    .map((rule) => rule.id);

  if (removeRuleIds.length > 0 || addRules.length > 0) {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds,
      addRules,
    });
  }

  return addRules.length;
}

function allocateTaskRuleId(): number | null {
  const poolSize = TASK_DYNAMIC_DNR_RULE_LIMIT - TASK_DYNAMIC_DNR_RULE_BASE + 1;
  for (let i = 0; i < poolSize; i += 1) {
    const candidate = nextTaskRuleCursor;
    nextTaskRuleCursor =
      candidate >= TASK_DYNAMIC_DNR_RULE_LIMIT
        ? TASK_DYNAMIC_DNR_RULE_BASE
        : candidate + 1;
    if (!allocatedTaskRuleIds.has(candidate)) {
      allocatedTaskRuleIds.add(candidate);
      return candidate;
    }
  }
  return null;
}

function extractUrlHostFilter(rawUrl: string): string | null {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    const host = parsed.hostname.toLowerCase();
    return host ? `||${host}/` : null;
  } catch {
    return null;
  }
}

/**
 * 为指定下载任务按资产 URL 域名动态注册临时会话级防盗链规则（`30000..49999` 段）。
 *
 * 严格限定 `initiatorDomains: [chrome.runtime.id]`，且仅写入经过校验的 `Referer` / `Origin`；
 * 任务完成、失败或取消后须调用 `releaseTaskDnrRules(taskKey)` 立即回收。
 */
export async function registerTaskDnrRules(
  taskKey: string,
  assets: readonly MediaAsset[],
): Promise<number[]> {
  if (
    typeof chrome === 'undefined' ||
    !chrome.declarativeNetRequest ||
    typeof chrome.declarativeNetRequest.updateSessionRules !== 'function'
  ) {
    return [];
  }

  const extensionId = chrome.runtime.id;
  if (!extensionId) {
    return [];
  }

  await releaseTaskDnrRules(taskKey);

  // 按目标主机去重聚合规则（同一任务内指向相同 CDN 域名的多个资产共用一条规则）
  const hostRuleMap = new Map<string, { referer?: string; origin?: string }>();
  for (const asset of assets) {
    const headers = sanitizeAssetRequestHeaders(asset.requestHeaders);
    if (!headers || (!headers.referer && !headers.origin)) {
      continue;
    }

    const candidateUrls = [
      asset.sourceUrl,
      ...(asset.fallbackUrls ?? []),
      ...(asset.audioUrl ? [asset.audioUrl] : []),
      ...(asset.audioFallbackUrls ?? []),
    ];

    for (const candidateUrl of candidateUrls) {
      const urlFilter = extractUrlHostFilter(candidateUrl);
      if (!urlFilter || hostRuleMap.has(urlFilter)) {
        continue;
      }
      hostRuleMap.set(urlFilter, headers);
    }
  }

  if (hostRuleMap.size === 0) {
    return [];
  }

  const addRules: chrome.declarativeNetRequest.Rule[] = [];
  const ruleIds: number[] = [];

  for (const [urlFilter, headers] of hostRuleMap.entries()) {
    const ruleId = allocateTaskRuleId();
    if (ruleId === null) {
      break;
    }

    const requestHeaders: chrome.declarativeNetRequest.ModifyHeaderInfo[] = [];
    if (headers.referer) {
      requestHeaders.push({
        header: 'Referer',
        operation: 'set',
        value: headers.referer,
      });
    }
    if (headers.origin) {
      requestHeaders.push({
        header: 'Origin',
        operation: 'set',
        value: headers.origin,
      });
    }

    if (requestHeaders.length === 0) {
      allocatedTaskRuleIds.delete(ruleId);
      continue;
    }

    ruleIds.push(ruleId);
    addRules.push({
      id: ruleId,
      priority: 2,
      action: {
        type: 'modifyHeaders',
        requestHeaders,
      },
      condition: {
        urlFilter,
        initiatorDomains: [extensionId],
        resourceTypes: [...DEFAULT_DNR_RESOURCE_TYPES],
      },
    });
  }

  if (addRules.length === 0) {
    return [];
  }

  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: ruleIds,
      addRules,
    });
    activeTaskRuleIds.set(taskKey, ruleIds);
    return ruleIds;
  } catch (error) {
    for (const id of ruleIds) {
      allocatedTaskRuleIds.delete(id);
    }
    throw error;
  }
}

/** 释放指定下载任务占用的临时动态 DNR 防盗链规则 */
export async function releaseTaskDnrRules(taskKey: string): Promise<void> {
  const ruleIds = activeTaskRuleIds.get(taskKey);
  if (!ruleIds || ruleIds.length === 0) {
    activeTaskRuleIds.delete(taskKey);
    return;
  }
  activeTaskRuleIds.delete(taskKey);
  for (const id of ruleIds) {
    allocatedTaskRuleIds.delete(id);
  }

  if (
    typeof chrome === 'undefined' ||
    !chrome.declarativeNetRequest ||
    typeof chrome.declarativeNetRequest.updateSessionRules !== 'function'
  ) {
    return;
  }

  await chrome.declarativeNetRequest
    .updateSessionRules({
      removeRuleIds: ruleIds,
    })
    .catch(() => undefined);
}

/** 清理 Service Worker 重启后可能残留的任务级动态 DNR 规则（`30000..49999` 段） */
export async function clearAllTaskDnrRules(): Promise<void> {
  activeTaskRuleIds.clear();
  allocatedTaskRuleIds.clear();
  nextTaskRuleCursor = TASK_DYNAMIC_DNR_RULE_BASE;

  if (
    typeof chrome === 'undefined' ||
    !chrome.declarativeNetRequest ||
    typeof chrome.declarativeNetRequest.getSessionRules !== 'function'
  ) {
    return;
  }

  const existingRules = await chrome.declarativeNetRequest.getSessionRules();
  const staleTaskRuleIds = existingRules
    .filter(
      (rule) =>
        rule.id >= TASK_DYNAMIC_DNR_RULE_BASE &&
        rule.id <= TASK_DYNAMIC_DNR_RULE_LIMIT,
    )
    .map((rule) => rule.id);

  if (staleTaskRuleIds.length > 0) {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: staleTaskRuleIds,
    });
  }
}

/**
 * 为远程存储插件的 `<video>` 流式播放设置临时会话级 `Authorization` 请求头规则。
 * 严格限定 `initiatorDomains: [chrome.runtime.id]` 与 `resourceTypes: ['media']`，仅存于内存会话。
 */
export async function setStorageMediaAuthDnrRule(
  ruleIdOffset: number,
  urlFilter: string,
  authorizationValue: string,
): Promise<number> {
  const extensionId = chrome.runtime.id;
  if (!extensionId) {
    throw new Error(
      'Unable to resolve chrome.runtime.id for storage media DNR rule.',
    );
  }
  if (
    !Number.isInteger(ruleIdOffset) ||
    ruleIdOffset < 0 ||
    ruleIdOffset >= 1000
  ) {
    throw new Error(`Invalid storage media DNR rule offset: ${ruleIdOffset}`);
  }
  const ruleId = STORAGE_MEDIA_DNR_RULE_BASE + ruleIdOffset;
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [ruleId],
    addRules: [
      {
        id: ruleId,
        priority: 2,
        action: {
          type: 'modifyHeaders',
          requestHeaders: [
            {
              header: 'Authorization',
              operation: 'set',
              value: authorizationValue,
            },
          ],
        },
        condition: {
          urlFilter,
          initiatorDomains: [extensionId],
          resourceTypes: ['media'],
        },
      },
    ],
  });
  return ruleId;
}

/** 移除指定远程存储插件临时会话级播放鉴权 DNR 规则 */
export async function clearStorageMediaAuthDnrRule(
  ruleId: number,
): Promise<void> {
  if (
    typeof chrome === 'undefined' ||
    !chrome.declarativeNetRequest ||
    typeof chrome.declarativeNetRequest.updateSessionRules !== 'function'
  ) {
    return;
  }
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [ruleId],
  });
}

/**
 * 清除扩展当前全部会话级 DNR 规则。
 */
export async function clearSessionDnrRules(): Promise<void> {
  activeTaskRuleIds.clear();
  allocatedTaskRuleIds.clear();
  const existingRules = await chrome.declarativeNetRequest.getSessionRules();
  if (existingRules.length === 0) {
    return;
  }

  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: existingRules.map((rule) => rule.id),
  });
}
