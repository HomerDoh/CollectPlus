/**
 * 抖音 Main World 被动拦截器与桥接模块。
 *
 * 运行于页面 `world: 'MAIN'` 上下文：
 * - 禁止引用任何 `chrome.*` API 或 React 运行时；
 * - 仅通过 `window.postMessage` + `PAGE_BRIDGE_CHANNEL` 与 Isolated Content Script 通信；
 * - 对 `window.fetch` 与 `XMLHttpRequest` 做只读旁路监听，不修改请求参数、不延迟或吞掉页面响应。
 */

import {
  isPageBridgeMessage,
  PAGE_BRIDGE_CHANNEL,
  type BridgeReadyMessage,
  type CollectionSyncBatchMessage,
  type CollectionSyncDoneMessage,
  type CurrentItemResponseMessage,
  type ItemCommentsResponseMessage,
  type LoginStateDetectedMessage,
  type NativeCollectCapturedMessage,
  type NativeUncollectCapturedMessage,
  type PageBridgeMessage,
  type PassiveCollectionListCapturedMessage,
  type RemoteUncollectResponseMessage,
  type RemoteUncollectTargetInput,
  type RemoteUncollectTargetOutcome,
  type RequestCurrentItemMessage,
  type RequestItemCommentsMessage,
  type RequestRemoteUncollectMessage,
} from '../../types/adapter.ts';

type UnknownRecord = Record<string, unknown>;

const INSTALL_LOCK_KEY = Symbol.for('collect-plus:douyin-main-hook-installed');
const LRU_DEFAULT_CAPACITY = 200;
const MAX_HARVEST_DEPTH = 8;
const MAX_HARVEST_NODES = 4000;
const MAX_FIBER_ASCENT_DEPTH = 35;
const MAX_DOM_PARENT_ASCENT = 16;
const FULL_SYNC_PAGE_SIZE = 20;
const MAX_FULL_SYNC_PAGES = 200;
const FULL_SYNC_MIN_DELAY_MS = 1500;
const FULL_SYNC_JITTER_MS = 700;
const DOUYIN_LIST_COLLECTION_ENDPOINT =
  '/aweme/v1/web/aweme/listcollection/?device_platform=webapp&aid=6383&channel=channel_pc_web&publish_video_strategy_type=2';
const DOUYIN_COMMENT_LIST_BASE =
  '/aweme/v1/web/comment/list/?device_platform=webapp&aid=6383&channel=channel_pc_web&item_type=0';
const COMMENT_CACHE_CAPACITY = 30;
const DEFAULT_COMMENT_LIMIT = 100;
const COMMENT_PAGE_SIZE = 20;
const MAX_COMMENT_FETCH_PAGES = 8;
const COMMENT_PAGE_MIN_DELAY_MS = 300;
const COMMENT_PAGE_JITTER_MS = 250;
const DOUYIN_FALLBACK_COLLECTION_URL =
  'https://www.douyin.com/user/self?showTab=favorite_collection';

const DOUYIN_API_MARKERS: readonly string[] = [
  '/aweme/v1/web/',
  '/aweme/v2/web/',
  '/web/api/',
  '/passport/web/account/info',
];

const FIBER_PROP_CHILD_KEYS: readonly string[] = [
  'awemeInfo',
  'aweme',
  'awemeDetail',
  'aweme_info',
  'aweme_detail',
  'data',
  'item',
  'videoInfo',
];

const ACTIVE_CONTAINER_SELECTORS: readonly string[] = [
  '[data-e2e="feed-active-video"]',
  '[data-e2e="detail-video-item"]',
  '.swiper-slide-active',
];

type CollectEndpointKind = 'aweme_collect' | 'collects_add';

interface GlobalWithDouyinHook {
  [INSTALL_LOCK_KEY]?: boolean;
  _ROUTER_DATA?: unknown;
}

interface XhrRequestMeta {
  method: string;
  url: string;
  isApi: boolean;
  collectKind: CollectEndpointKind | null;
  bodyParams: Map<string, string>;
}

interface DetectedAccount {
  accountId: string;
  accountName?: string;
}

let detectedAccount: DetectedAccount | null = null;
let lastEmittedAccountId: string | null = null;
let activeSyncId: string | null = null;
let activeSyncAbortController: AbortController | null = null;
let internalSyncFetchInFlight = 0;
let internalCommentFetchInFlight = 0;
let internalUncollectFetchInFlight = 0;

interface CachedAwemeComments {
  comments: UnknownRecord[];
  seenIds: Set<string>;
  nextCursor: string | number;
  hasMore: boolean;
}

class CommentLruCache {
  private readonly capacity: number;
  private readonly store = new Map<string, CachedAwemeComments>();

  constructor(capacity = COMMENT_CACHE_CAPACITY) {
    this.capacity = Math.max(1, capacity);
  }

  get(awemeId: string): CachedAwemeComments | undefined {
    const key = awemeId.trim();
    if (!key) {
      return undefined;
    }
    const found = this.store.get(key);
    if (!found) {
      return undefined;
    }
    this.store.delete(key);
    this.store.set(key, found);
    return found;
  }

  mergePage(
    awemeId: string,
    pageComments: readonly UnknownRecord[],
    nextCursor: string | number | null,
    hasMore: boolean,
  ): CachedAwemeComments {
    const key = awemeId.trim();
    const existing = this.store.get(key);
    const entry: CachedAwemeComments = existing ?? {
      comments: [],
      seenIds: new Set<string>(),
      nextCursor: 0,
      hasMore: true,
    };

    for (const comment of pageComments) {
      if (entry.comments.length >= DEFAULT_COMMENT_LIMIT) {
        break;
      }
      const cid = extractCommentId(comment);
      if (cid) {
        if (entry.seenIds.has(cid)) {
          continue;
        }
        entry.seenIds.add(cid);
      }
      entry.comments.push(comment);
    }

    if (nextCursor !== null) {
      entry.nextCursor = nextCursor;
    }
    entry.hasMore = hasMore;

    if (existing) {
      this.store.delete(key);
    }
    this.store.set(key, entry);

    while (this.store.size > this.capacity) {
      const oldestKey = this.store.keys().next().value;
      if (oldestKey === undefined) {
        break;
      }
      this.store.delete(oldestKey);
    }

    return entry;
  }
}

const commentCache = new CommentLruCache(COMMENT_CACHE_CAPACITY);

function extractCommentId(record: UnknownRecord): string | null {
  const raw = record.cid ?? record.comment_id ?? record.commentId;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
    return String(Math.trunc(raw));
  }
  return null;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function extractAwemeId(record: UnknownRecord): string | null {
  const raw = record.aweme_id ?? record.awemeId;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
    return String(Math.trunc(raw));
  }
  return null;
}

function isHarvestableAweme(value: unknown): value is UnknownRecord {
  if (!isRecord(value)) {
    return false;
  }
  const id = extractAwemeId(value);
  if (!id) {
    return false;
  }
  const hasVideo = isRecord(value.video);
  const hasImages = Array.isArray(value.images) && value.images.length > 0;
  return hasVideo || hasImages;
}

function getAwemeRichnessScore(record: UnknownRecord): number {
  let score = 0;
  if (isRecord(record.video)) {
    score += 1;
    const bitRate = record.video.bit_rate ?? record.video.bitRateList;
    if (Array.isArray(bitRate) && bitRate.length > 0) {
      score += 4;
    }
    if (isRecord(record.video.play_addr ?? record.video.playAddr)) {
      score += 2;
    }
  }
  if (Array.isArray(record.images) && record.images.length > 0) {
    score += 3;
  }
  if (isRecord(record.author ?? record.authorInfo)) {
    score += 1;
  }
  if (typeof record.desc === 'string' && record.desc.length > 0) {
    score += 1;
  }
  return score;
}

/** 固定容量的抖音 `aweme` 原始数据 LRU 缓存 */
export class AwemeLruCache {
  private readonly capacity: number;
  private readonly store = new Map<string, UnknownRecord>();

  constructor(capacity = LRU_DEFAULT_CAPACITY) {
    this.capacity = Math.max(1, capacity);
  }

  get size(): number {
    return this.store.size;
  }

  set(id: string, raw: UnknownRecord): void {
    const key = id.trim();
    if (!key) {
      return;
    }

    const existing = this.store.get(key);
    let valueToStore = raw;
    if (existing) {
      this.store.delete(key);
      // 避免用字段残缺的摘要对象覆盖已经截获到的完整详情对象
      if (getAwemeRichnessScore(existing) > getAwemeRichnessScore(raw)) {
        valueToStore = existing;
      }
    }

    this.store.set(key, valueToStore);

    while (this.store.size > this.capacity) {
      const oldestKey = this.store.keys().next().value;
      if (oldestKey === undefined) {
        break;
      }
      this.store.delete(oldestKey);
    }
  }

  get(id: string): UnknownRecord | undefined {
    const key = id.trim();
    if (!key) {
      return undefined;
    }
    const found = this.store.get(key);
    if (!found) {
      return undefined;
    }
    this.store.delete(key);
    this.store.set(key, found);
    return found;
  }

  getLatest(): UnknownRecord | undefined {
    let latest: UnknownRecord | undefined;
    for (const value of this.store.values()) {
      latest = value;
    }
    return latest;
  }
}

const awemeCache = new AwemeLruCache(LRU_DEFAULT_CAPACITY);

/**
 * 限深度、限节点预算地递归收割响应 JSON 中的所有合法 `aweme` 条目并写入 LRU 缓存。
 */
export function harvestAwemeObjects(payload: unknown): number {
  if (typeof payload !== 'object' || payload === null) {
    return 0;
  }

  const visited = new WeakSet<object>();
  let visitedCount = 0;
  let harvestedCount = 0;

  const walk = (node: unknown, depth: number): void => {
    if (
      depth > MAX_HARVEST_DEPTH ||
      visitedCount >= MAX_HARVEST_NODES ||
      typeof node !== 'object' ||
      node === null
    ) {
      return;
    }

    if (visited.has(node)) {
      return;
    }
    visited.add(node);
    visitedCount += 1;

    if (Array.isArray(node)) {
      for (const item of node) {
        if (visitedCount >= MAX_HARVEST_NODES) {
          break;
        }
        walk(item, depth + 1);
      }
      return;
    }

    if (!isRecord(node)) {
      return;
    }

    if (isHarvestableAweme(node)) {
      const id = extractAwemeId(node);
      if (id) {
        awemeCache.set(id, node);
        harvestedCount += 1;
      }
      // 已命中完整 aweme 对象，无需深入其 video/author/music 子树消耗遍历预算
      return;
    }

    for (const value of Object.values(node)) {
      if (visitedCount >= MAX_HARVEST_NODES) {
        break;
      }
      if (typeof value === 'object' && value !== null) {
        walk(value, depth + 1);
      }
    }
  };

  walk(payload, 0);
  return harvestedCount;
}

function getBridgeTargetOrigin(): string {
  try {
    const origin = window.location.origin;
    if (origin && origin !== 'null') {
      return origin;
    }
  } catch {
    // 忽略异常并回退到通配 origin
  }
  return '*';
}

function postBridgeMessage(message: PageBridgeMessage): void {
  try {
    window.postMessage(message, getBridgeTargetOrigin());
  } catch {
    // 静默忽略，避免影响宿主页面
  }
}

function resolveRequestUrl(rawUrl: string): URL | null {
  try {
    return new URL(rawUrl, window.location.href);
  } catch {
    return null;
  }
}

function isDouyinApiUrl(rawUrl: string): boolean {
  const parsed = resolveRequestUrl(rawUrl);
  if (!parsed) {
    return false;
  }
  const pathname = parsed.pathname;
  for (const marker of DOUYIN_API_MARKERS) {
    if (pathname.includes(marker)) {
      return true;
    }
  }
  return false;
}

function classifyCollectEndpoint(rawUrl: string): CollectEndpointKind | null {
  const parsed = resolveRequestUrl(rawUrl);
  if (!parsed) {
    return null;
  }
  const pathname = parsed.pathname;
  if (/\/aweme\/v1\/web\/aweme\/collect(?:\/|$)/.test(pathname)) {
    return 'aweme_collect';
  }
  if (/\/aweme\/v1\/web\/collects\/video\/(?:add|move)(?:\/|$)/.test(pathname)) {
    return 'collects_add';
  }
  return null;
}

function isUserProfileSelfUrl(rawUrl: string): boolean {
  const parsed = resolveRequestUrl(rawUrl);
  if (!parsed) {
    return false;
  }
  const pathname = parsed.pathname;
  return (
    /\/aweme\/v1\/web\/user\/profile\/self(?:\/|$)/.test(pathname) ||
    /\/passport\/web\/account\/info(?:\/|$)/.test(pathname)
  );
}

function isCollectionListUrl(rawUrl: string): boolean {
  const parsed = resolveRequestUrl(rawUrl);
  if (!parsed) {
    return false;
  }
  const pathname = parsed.pathname;
  return (
    /\/aweme\/v1\/web\/aweme\/listcollection(?:\/|$)/.test(pathname) ||
    /\/aweme\/v1\/web\/collects\/video\/list(?:\/|$)/.test(pathname)
  );
}

function isCommentListUrl(rawUrl: string): boolean {
  const parsed = resolveRequestUrl(rawUrl);
  if (!parsed) {
    return false;
  }
  return /\/aweme\/v1\/web\/comment\/list(?:\/|$)/.test(parsed.pathname);
}

function extractCommentPageFromPayload(payload: unknown): {
  comments: UnknownRecord[];
  hasMore: boolean;
  nextCursor: string | number | null;
} | null {
  if (!isRecord(payload)) {
    return null;
  }
  if (!isResponseStatusSuccess(payload)) {
    return null;
  }

  const rawList = Array.isArray(payload.comments) ? payload.comments : null;
  if (rawList === null) {
    return null;
  }

  const comments: UnknownRecord[] = [];
  for (const entry of rawList) {
    if (isRecord(entry)) {
      comments.push(entry);
    }
  }

  const hasMoreRaw = payload.has_more ?? payload.hasMore;
  const hasMore =
    hasMoreRaw === 1 || hasMoreRaw === true || hasMoreRaw === '1';

  const cursorRaw = payload.cursor;
  const nextCursor =
    typeof cursorRaw === 'string' ||
    (typeof cursorRaw === 'number' && Number.isFinite(cursorRaw))
      ? cursorRaw
      : null;

  return { comments, hasMore, nextCursor };
}

function harvestCommentListResponse(rawUrl: string, payload: unknown): void {
  const parsedUrl = resolveRequestUrl(rawUrl);
  const awemeId =
    parsedUrl?.searchParams.get('aweme_id')?.trim() ||
    parsedUrl?.searchParams.get('awemeId')?.trim();
  if (!awemeId) {
    return;
  }
  const page = extractCommentPageFromPayload(payload);
  if (!page) {
    return;
  }
  commentCache.mergePage(awemeId, page.comments, page.nextCursor, page.hasMore);
}

async function fetchCommentsForAweme(
  awemeId: string,
  limit = DEFAULT_COMMENT_LIMIT,
): Promise<{ rawComments: UnknownRecord[]; error?: string }> {
  const trimmedId = awemeId.trim();
  const safeLimit = Math.max(
    1,
    Math.min(DEFAULT_COMMENT_LIMIT, Math.floor(limit || DEFAULT_COMMENT_LIMIT)),
  );
  if (!trimmedId) {
    return { rawComments: [] };
  }

  const collected: UnknownRecord[] = [];
  const seenIds = new Set<string>();
  const appendUnique = (items: readonly UnknownRecord[]): void => {
    for (const item of items) {
      if (collected.length >= safeLimit) {
        break;
      }
      const cid = extractCommentId(item);
      if (cid) {
        if (seenIds.has(cid)) {
          continue;
        }
        seenIds.add(cid);
      }
      collected.push(item);
    }
  };

  let cursor: string | number = 0;
  let hasMore = true;

  const cached = commentCache.get(trimmedId);
  if (cached) {
    appendUnique(cached.comments);
    cursor = cached.nextCursor;
    hasMore = cached.hasMore;
  }

  if (collected.length >= safeLimit || !hasMore) {
    return { rawComments: collected };
  }

  const controller = new AbortController();
  for (let pageIndex = 0; pageIndex < MAX_COMMENT_FETCH_PAGES; pageIndex += 1) {
    if (collected.length >= safeLimit || !hasMore) {
      break;
    }

    if (pageIndex > 0) {
      const delayMs =
        COMMENT_PAGE_MIN_DELAY_MS +
        Math.floor(Math.random() * COMMENT_PAGE_JITTER_MS);
      await sleepAbortable(delayMs, controller.signal);
    }

    const remaining = safeLimit - collected.length;
    const count = Math.min(COMMENT_PAGE_SIZE, remaining);
    const endpoint = `${DOUYIN_COMMENT_LIST_BASE}&aweme_id=${encodeURIComponent(trimmedId)}&cursor=${encodeURIComponent(String(cursor))}&count=${count}`;

    let parsedJson: unknown;
    internalCommentFetchInFlight += 1;
    try {
      // 复用宿主页 window.fetch 与已挂载的签名拦截/登录态，不逆向私有签名算法
      const response = await window.fetch(endpoint, {
        method: 'GET',
        credentials: 'include',
        signal: controller.signal,
      });

      if (response.status < 200 || response.status >= 300) {
        return {
          rawComments: collected,
          error: `评论接口返回 HTTP ${response.status}，已保留已获取的 ${collected.length} 条评论。`,
        };
      }

      const text = await response.text();
      if (!text) {
        return {
          rawComments: collected,
          error: '评论接口返回空响应，已安全中止后续分页。',
        };
      }
      parsedJson = JSON.parse(text);
    } catch (error) {
      return {
        rawComments: collected,
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      internalCommentFetchInFlight = Math.max(0, internalCommentFetchInFlight - 1);
    }

    const page = extractCommentPageFromPayload(parsedJson);
    if (!page) {
      return {
        rawComments: collected,
        error: '评论接口响应未通过校验，已安全中止后续分页。',
      };
    }

    commentCache.mergePage(trimmedId, page.comments, page.nextCursor, page.hasMore);
    appendUnique(page.comments);

    if (
      !page.hasMore ||
      page.comments.length === 0 ||
      page.nextCursor === null ||
      String(page.nextCursor) === String(cursor)
    ) {
      hasMore = false;
      break;
    }

    cursor = page.nextCursor;
  }

  return { rawComments: collected };
}

function normalizeValidAccountId(value: unknown): string | null {
  let raw = '';
  if (typeof value === 'string') {
    raw = value.trim();
  } else if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    raw = String(Math.trunc(value));
  }
  if (
    !raw ||
    raw === '0' ||
    raw.toLowerCase() === 'null' ||
    raw.toLowerCase() === 'undefined'
  ) {
    return null;
  }
  return raw;
}

function extractAccountFromUserObject(
  userObj: UnknownRecord,
): DetectedAccount | null {
  const accountId =
    normalizeValidAccountId(userObj.uid) ??
    normalizeValidAccountId(userObj.user_id_str) ??
    normalizeValidAccountId(userObj.user_id) ??
    normalizeValidAccountId(userObj.sec_uid) ??
    normalizeValidAccountId(userObj.secUid);

  if (!accountId) {
    return null;
  }

  const rawName = userObj.nickname ?? userObj.screen_name ?? userObj.name;
  const accountName =
    typeof rawName === 'string' && rawName.trim().length > 0
      ? rawName.trim()
      : undefined;

  return accountName !== undefined ? { accountId, accountName } : { accountId };
}

function extractAccountFromProfileResponse(
  payload: unknown,
): DetectedAccount | null {
  if (!isRecord(payload)) {
    return null;
  }
  if (!isResponseStatusSuccess(payload)) {
    return null;
  }

  if (isRecord(payload.user)) {
    const found = extractAccountFromUserObject(payload.user);
    if (found) {
      return found;
    }
  }

  if (isRecord(payload.data)) {
    if (isRecord(payload.data.user)) {
      const found = extractAccountFromUserObject(payload.data.user);
      if (found) {
        return found;
      }
    }
    const found = extractAccountFromUserObject(payload.data);
    if (found) {
      return found;
    }
  }

  return null;
}

function extractLoggedInAccountFromSsrTree(
  payload: unknown,
): DetectedAccount | null {
  if (typeof payload !== 'object' || payload === null) {
    return null;
  }

  const visited = new WeakSet<object>();
  let visitedCount = 0;

  const walk = (node: unknown, depth: number): DetectedAccount | null => {
    if (
      depth > 6 ||
      visitedCount >= 1200 ||
      typeof node !== 'object' ||
      node === null
    ) {
      return null;
    }
    if (visited.has(node)) {
      return null;
    }
    visited.add(node);
    visitedCount += 1;

    if (Array.isArray(node)) {
      for (const item of node) {
        const found = walk(item, depth + 1);
        if (found) {
          return found;
        }
      }
      return null;
    }

    if (!isRecord(node)) {
      return null;
    }

    // 仅当 SSR 状态显式声明 isLogin === true 时提取，避免误将作品作者 uid 识别为当前登录账号
    if (node.isLogin === true) {
      const candidates = [node.info, node.userInfo, node.user, node];
      for (const candidate of candidates) {
        if (isRecord(candidate)) {
          const found = extractAccountFromUserObject(candidate);
          if (found) {
            return found;
          }
        }
      }
    }

    for (const value of Object.values(node)) {
      if (typeof value === 'object' && value !== null) {
        const found = walk(value, depth + 1);
        if (found) {
          return found;
        }
      }
    }

    return null;
  };

  return walk(payload, 0);
}

function notifyLoginState(account: DetectedAccount, force = false): void {
  detectedAccount = account;
  if (!force && lastEmittedAccountId === account.accountId) {
    return;
  }
  lastEmittedAccountId = account.accountId;

  const message: LoginStateDetectedMessage = {
    channel: PAGE_BRIDGE_CHANNEL,
    direction: 'main-to-content',
    type: 'LOGIN_STATE_DETECTED',
    platform: 'douyin',
    accountId: account.accountId,
    ...(account.accountName !== undefined
      ? { accountName: account.accountName }
      : {}),
  };
  postBridgeMessage(message);
}

function extractAwemeListFromCollectionPayload(
  payload: unknown,
): { rawItems: UnknownRecord[]; hasMore: boolean; nextCursor: string | number | null } | null {
  if (!isRecord(payload)) {
    return null;
  }
  if (!isResponseStatusSuccess(payload)) {
    return null;
  }

  const rawList = Array.isArray(payload.aweme_list)
    ? payload.aweme_list
    : Array.isArray(payload.awemeList)
      ? payload.awemeList
      : null;

  if (rawList === null) {
    return null;
  }

  const rawItems: UnknownRecord[] = [];
  for (const entry of rawList) {
    if (isHarvestableAweme(entry)) {
      rawItems.push(entry);
    }
  }

  const hasMoreRaw = payload.has_more ?? payload.hasMore;
  const hasMore =
    hasMoreRaw === 1 || hasMoreRaw === true || hasMoreRaw === '1';

  const cursorRaw = payload.cursor;
  const nextCursor =
    typeof cursorRaw === 'string' ||
    (typeof cursorRaw === 'number' && Number.isFinite(cursorRaw))
      ? cursorRaw
      : null;

  return { rawItems, hasMore, nextCursor };
}

function handlePassiveCollectionListResponse(payload: unknown): void {
  const extracted = extractAwemeListFromCollectionPayload(payload);
  if (!extracted || extracted.rawItems.length === 0) {
    return;
  }

  const message: PassiveCollectionListCapturedMessage = {
    channel: PAGE_BRIDGE_CHANNEL,
    direction: 'main-to-content',
    type: 'PASSIVE_COLLECTION_LIST_CAPTURED',
    platform: 'douyin',
    rawItems: extracted.rawItems,
    hasMore: extracted.hasMore,
  };
  postBridgeMessage(message);
}

function sleepAbortable(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = window.setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      window.clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function runFullCollectionSync(syncId: string): Promise<void> {
  if (activeSyncId !== null) {
    return;
  }

  const controller = new AbortController();
  activeSyncId = syncId;
  activeSyncAbortController = controller;

  let cursor: string | number = 0;
  let totalFetched = 0;

  const emitDone = (
    status: CollectionSyncDoneMessage['status'],
    extra?: { error?: string; fallbackUrl?: string },
  ): void => {
    const doneMessage: CollectionSyncDoneMessage = {
      channel: PAGE_BRIDGE_CHANNEL,
      direction: 'main-to-content',
      type: 'COLLECTION_SYNC_DONE',
      syncId,
      platform: 'douyin',
      totalFetched,
      status,
      ...(extra?.error !== undefined ? { error: extra.error } : {}),
      ...(extra?.fallbackUrl !== undefined
        ? { fallbackUrl: extra.fallbackUrl }
        : {}),
    };
    postBridgeMessage(doneMessage);
  };

  try {
    for (let pageIndex = 0; pageIndex < MAX_FULL_SYNC_PAGES; pageIndex += 1) {
      if (controller.signal.aborted || activeSyncId !== syncId) {
        emitDone('cancelled');
        return;
      }

      if (pageIndex > 0) {
        const delayMs =
          FULL_SYNC_MIN_DELAY_MS +
          Math.floor(Math.random() * FULL_SYNC_JITTER_MS);
        await sleepAbortable(delayMs, controller.signal);
      }

      let parsedJson: unknown;
      internalSyncFetchInFlight += 1;
      try {
        // 使用页面当前 window.fetch，复用宿主页已挂载的登录态与签名拦截，不逆向签名算法
        const response = await window.fetch(DOUYIN_LIST_COLLECTION_ENDPOINT, {
          method: 'POST',
          credentials: 'include',
          headers: {
            'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
          },
          body: `count=${FULL_SYNC_PAGE_SIZE}&cursor=${encodeURIComponent(String(cursor))}`,
          signal: controller.signal,
        });

        if (response.status < 200 || response.status >= 300) {
          emitDone('fallback_needed', {
            error: `收藏列表接口返回异常状态（HTTP ${response.status}），已安全中止主动拉取。`,
            fallbackUrl: DOUYIN_FALLBACK_COLLECTION_URL,
          });
          return;
        }

        const text = await response.text();
        if (!text) {
          emitDone('fallback_needed', {
            error: '收藏列表接口返回空响应（可能触发风控校验），已安全中止主动拉取。',
            fallbackUrl: DOUYIN_FALLBACK_COLLECTION_URL,
          });
          return;
        }
        parsedJson = JSON.parse(text);
      } catch (error) {
        if (controller.signal.aborted || activeSyncId !== syncId) {
          emitDone('cancelled');
          return;
        }
        emitDone('fallback_needed', {
          error:
            error instanceof Error && error.message
              ? `主动拉取收藏列表受阻（${error.message}），已安全中止。`
              : '主动拉取收藏列表受阻，已安全中止。',
          fallbackUrl: DOUYIN_FALLBACK_COLLECTION_URL,
        });
        return;
      } finally {
        internalSyncFetchInFlight = Math.max(0, internalSyncFetchInFlight - 1);
      }

      const extracted = extractAwemeListFromCollectionPayload(parsedJson);
      if (!extracted) {
        emitDone('fallback_needed', {
          error: '接口返回未通过校验或数据结构受限，已停止主动拉取。',
          fallbackUrl: DOUYIN_FALLBACK_COLLECTION_URL,
        });
        return;
      }

      harvestAwemeObjects(parsedJson);

      if (extracted.rawItems.length > 0) {
        totalFetched += extracted.rawItems.length;
        const batchMessage: CollectionSyncBatchMessage = {
          channel: PAGE_BRIDGE_CHANNEL,
          direction: 'main-to-content',
          type: 'COLLECTION_SYNC_BATCH',
          syncId,
          platform: 'douyin',
          rawItems: extracted.rawItems,
          pageIndex,
          hasMore: extracted.hasMore,
        };
        postBridgeMessage(batchMessage);
      }

      if (
        !extracted.hasMore ||
        extracted.nextCursor === null ||
        String(extracted.nextCursor) === String(cursor)
      ) {
        break;
      }
      cursor = extracted.nextCursor;
    }

    emitDone('completed');
  } catch (error) {
    if (controller.signal.aborted || activeSyncId !== syncId) {
      emitDone('cancelled');
    } else {
      emitDone('error', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  } finally {
    if (activeSyncId === syncId) {
      activeSyncId = null;
      activeSyncAbortController = null;
    }
  }
}

function parseParamsFromString(rawText: string): Map<string, string> {
  const map = new Map<string, string>();
  const trimmed = rawText.trim();
  if (!trimmed) {
    return map;
  }

  if (trimmed.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isRecord(parsed)) {
        for (const [key, value] of Object.entries(parsed)) {
          if (typeof value === 'string') {
            map.set(key, value);
          } else if (typeof value === 'number' || typeof value === 'boolean') {
            map.set(key, String(value));
          } else if (Array.isArray(value)) {
            const parts: string[] = [];
            for (const entry of value) {
              if (typeof entry === 'string' || typeof entry === 'number') {
                parts.push(String(entry));
              }
            }
            if (parts.length > 0) {
              map.set(key, parts.join(','));
            }
          }
        }
        return map;
      }
    } catch {
      // 不是合法 JSON，继续按 query string 解析
    }
  }

  try {
    const params = new URLSearchParams(trimmed);
    params.forEach((value, key) => {
      map.set(key, value);
    });
  } catch {
    // 忽略格式异常的请求体
  }

  return map;
}

function extractBodyParams(body: unknown): Map<string, string> {
  const map = new Map<string, string>();
  if (body === null || body === undefined) {
    return map;
  }

  if (typeof body === 'string') {
    return parseParamsFromString(body);
  }

  if (body instanceof URLSearchParams) {
    body.forEach((value, key) => {
      map.set(key, value);
    });
    return map;
  }

  if (typeof FormData !== 'undefined' && body instanceof FormData) {
    body.forEach((value, key) => {
      if (typeof value === 'string') {
        map.set(key, value);
      }
    });
    return map;
  }

  return map;
}

function mergeRequestParams(
  rawUrl: string,
  bodyParams: Map<string, string>,
): Map<string, string> {
  const merged = new Map<string, string>();
  const parsed = resolveRequestUrl(rawUrl);
  if (parsed) {
    parsed.searchParams.forEach((value, key) => {
      merged.set(key, value);
    });
  }
  bodyParams.forEach((value, key) => {
    merged.set(key, value);
  });
  return merged;
}

function parseIdList(raw: string | undefined): string[] {
  if (!raw) {
    return [];
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return [];
  }

  if (trimmed.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        const ids: string[] = [];
        for (const item of parsed) {
          if (typeof item === 'string' && /^\d+$/.test(item.trim())) {
            ids.push(item.trim());
          } else if (typeof item === 'number' && Number.isFinite(item)) {
            ids.push(String(Math.trunc(item)));
          }
        }
        return ids;
      }
    } catch {
      // 回退正则提取
    }
  }

  const matches = trimmed.match(/\d{6,}/g);
  return matches ? Array.from(new Set(matches)) : [];
}

function extractAwemeIdsFromParams(params: Map<string, string>): string[] {
  const ids = new Set<string>();
  const singleId =
    params.get('aweme_id') ??
    params.get('awemeId') ??
    params.get('item_id') ??
    params.get('itemId');
  for (const id of parseIdList(singleId)) {
    ids.add(id);
  }

  const multiIds = params.get('item_ids') ?? params.get('itemIds');
  for (const id of parseIdList(multiIds)) {
    ids.add(id);
  }

  return Array.from(ids);
}

function extractCollectedAwemeIds(
  collectKind: CollectEndpointKind,
  params: Map<string, string>,
): string[] {
  if (collectKind === 'aweme_collect') {
    const action = params.get('action');
    if (action !== '1') {
      return [];
    }
  }

  return extractAwemeIdsFromParams(params);
}

function isResponseStatusSuccess(payload: unknown): boolean {
  if (!isRecord(payload)) {
    return true;
  }
  const statusCode = payload.status_code;
  if (statusCode === undefined || statusCode === null) {
    return true;
  }
  if (typeof statusCode === 'number') {
    return statusCode === 0;
  }
  if (typeof statusCode === 'string') {
    return statusCode === '0';
  }
  return false;
}

function extractAwemeFromPropsObject(
  props: unknown,
  targetAwemeId?: string,
  depth = 0,
): UnknownRecord | null {
  if (depth > 2 || !isRecord(props)) {
    return null;
  }

  if (isHarvestableAweme(props)) {
    const id = extractAwemeId(props);
    if (id) {
      awemeCache.set(id, props);
      if (!targetAwemeId || id === targetAwemeId) {
        return props;
      }
    }
  }

  for (const key of FIBER_PROP_CHILD_KEYS) {
    const child = props[key];
    if (!isRecord(child)) {
      continue;
    }

    if (isHarvestableAweme(child)) {
      const id = extractAwemeId(child);
      if (id) {
        awemeCache.set(id, child);
        if (!targetAwemeId || id === targetAwemeId) {
          return child;
        }
      }
      continue;
    }

    // 处理 data.awemeInfo / item.aweme 等二层包装结构
    const nested = extractAwemeFromPropsObject(child, targetAwemeId, depth + 1);
    if (nested) {
      return nested;
    }
  }

  return null;
}

function findAwemeOnDomNodeReactMeta(
  node: Element,
  targetAwemeId?: string,
): UnknownRecord | null {
  const hostObj = node as unknown as UnknownRecord;
  let keys: string[];
  try {
    keys = Object.keys(hostObj);
  } catch {
    return null;
  }

  for (const key of keys) {
    if (key.startsWith('__reactProps$')) {
      const found = extractAwemeFromPropsObject(hostObj[key], targetAwemeId);
      if (found) {
        return found;
      }
    }
  }

  for (const key of keys) {
    if (!key.startsWith('__reactFiber$')) {
      continue;
    }
    let fiber: unknown = hostObj[key];
    let step = 0;

    while (isRecord(fiber) && step < MAX_FIBER_ASCENT_DEPTH) {
      const fromMemoized = extractAwemeFromPropsObject(
        fiber.memoizedProps,
        targetAwemeId,
      );
      if (fromMemoized) {
        return fromMemoized;
      }

      if (
        fiber.pendingProps !== undefined &&
        fiber.pendingProps !== fiber.memoizedProps
      ) {
        const fromPending = extractAwemeFromPropsObject(
          fiber.pendingProps,
          targetAwemeId,
        );
        if (fromPending) {
          return fromPending;
        }
      }

      fiber = fiber.return;
      step += 1;
    }
  }

  return null;
}

function findAwemeViaReactFiberFromElements(
  elements: readonly Element[],
  targetAwemeId?: string,
): UnknownRecord | null {
  const visitedElements = new WeakSet<Element>();

  for (const startEl of elements) {
    let current: Element | null = startEl;
    let depth = 0;

    while (current && depth < MAX_DOM_PARENT_ASCENT) {
      if (!visitedElements.has(current)) {
        visitedElements.add(current);
        const found = findAwemeOnDomNodeReactMeta(current, targetAwemeId);
        if (found) {
          return found;
        }
      }
      current = current.parentElement;
      depth += 1;
    }
  }

  return null;
}

function findAwemeAcrossDocumentFiber(
  targetAwemeId?: string,
): UnknownRecord | null {
  const candidates: Element[] = [];
  const seen = new Set<Element>();

  const pushUnique = (el: Element | null): void => {
    if (el && !seen.has(el)) {
      seen.add(el);
      candidates.push(el);
    }
  };

  if (targetAwemeId) {
    const exactVidEls = document.querySelectorAll(
      `[data-e2e-vid="${CSS.escape(targetAwemeId)}"], [data-aweme-id="${CSS.escape(targetAwemeId)}"]`,
    );
    exactVidEls.forEach((el) => pushUnique(el));
  }

  for (const el of collectViewportActiveElements()) {
    pushUnique(el);
  }

  const broadSelectors = [
    '[data-e2e-vid]',
    '[data-aweme-id]',
    'video',
    '[data-e2e*="video"]',
    '[data-e2e*="note"]',
    'main',
    '#douyin-right-container',
    '#root',
  ];

  for (const selector of broadSelectors) {
    const matched = document.querySelectorAll(selector);
    let count = 0;
    for (const el of matched) {
      pushUnique(el);
      count += 1;
      // 限制单类选择器采样上限，防止超大 DOM 卡顿
      if (count >= 24) {
        break;
      }
    }
  }

  return findAwemeViaReactFiberFromElements(candidates, targetAwemeId);
}

function getViewportOverlapScore(rect: DOMRect): number {
  const vw = window.innerWidth || document.documentElement.clientWidth || 0;
  const vh = window.innerHeight || document.documentElement.clientHeight || 0;
  if (vw <= 0 || vh <= 0 || rect.width <= 0 || rect.height <= 0) {
    return 0;
  }

  const overlapWidth = Math.max(
    0,
    Math.min(rect.right, vw) - Math.max(rect.left, 0),
  );
  const overlapHeight = Math.max(
    0,
    Math.min(rect.bottom, vh) - Math.max(rect.top, 0),
  );
  const overlapArea = overlapWidth * overlapHeight;
  if (overlapArea <= 0) {
    return 0;
  }

  const centerX = rect.left + rect.width / 2;
  const centerY = rect.top + rect.height / 2;
  const distFromCenter = Math.hypot(centerX - vw / 2, centerY - vh / 2);
  const maxDist = Math.hypot(vw / 2, vh / 2) || 1;
  const centerBonus = 1 + Math.max(0, 1 - distFromCenter / maxDist);

  return overlapArea * centerBonus;
}

function collectViewportActiveElements(): Element[] {
  const scored: Array<{ element: Element; score: number }> = [];
  const seen = new Set<Element>();

  const videos = document.querySelectorAll('video');
  for (const video of videos) {
    const rect = video.getBoundingClientRect();
    const overlap = getViewportOverlapScore(rect);
    if (overlap <= 0) {
      continue;
    }
    const isActivelyPlaying =
      !video.paused && !video.ended && video.readyState >= 2;
    const playingMultiplier = isActivelyPlaying ? 3.5 : 1.0;
    scored.push({
      element: video,
      score: overlap * playingMultiplier,
    });
    seen.add(video);
  }

  for (const selector of ACTIVE_CONTAINER_SELECTORS) {
    const containers = document.querySelectorAll(selector);
    for (const container of containers) {
      if (seen.has(container)) {
        continue;
      }
      const rect = container.getBoundingClientRect();
      const overlap = getViewportOverlapScore(rect);
      if (overlap > 0) {
        scored.push({
          element: container,
          score: overlap * 1.8,
        });
        seen.add(container);
      }
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.map((entry) => entry.element);
}

function extractAwemeIdFromUrl(href: string): string | null {
  try {
    const parsed = new URL(href);
    const pathMatch = /\/(?:video|note)\/(\d+)/.exec(parsed.pathname);
    if (pathMatch?.[1]) {
      return pathMatch[1];
    }

    const modalId = parsed.searchParams.get('modal_id');
    if (modalId && /^\d+$/.test(modalId.trim())) {
      return modalId.trim();
    }
  } catch {
    // URL 解析异常时静默返回 null
  }
  return null;
}

function extractAwemeIdFromAncestors(elements: readonly Element[]): string | null {
  for (const startEl of elements) {
    let current: Element | null = startEl;
    let depth = 0;

    while (current && depth < MAX_DOM_PARENT_ASCENT) {
      const vid =
        current.getAttribute('data-e2e-vid') ??
        current.getAttribute('data-aweme-id');
      if (vid && /^\d+$/.test(vid.trim())) {
        return vid.trim();
      }
      current = current.parentElement;
      depth += 1;
    }
  }
  return null;
}

function handleNativeCollectSuccess(
  collectKind: CollectEndpointKind,
  rawUrl: string,
  bodyParams: Map<string, string>,
  responsePayload: unknown,
): void {
  if (!isResponseStatusSuccess(responsePayload)) {
    return;
  }

  const mergedParams = mergeRequestParams(rawUrl, bodyParams);

  // 原站取消收藏（action=0）直接上报 sourceIds，不依赖 LRU 缓存命中
  if (collectKind === 'aweme_collect' && mergedParams.get('action') === '0') {
    const uncollectedIds = extractAwemeIdsFromParams(mergedParams);
    if (uncollectedIds.length > 0) {
      const uncollectMessage: NativeUncollectCapturedMessage = {
        channel: PAGE_BRIDGE_CHANNEL,
        direction: 'main-to-content',
        type: 'NATIVE_UNCOLLECT_CAPTURED',
        platform: 'douyin',
        sourceIds: uncollectedIds,
      };
      postBridgeMessage(uncollectMessage);
    }
    return;
  }

  const awemeIds = extractCollectedAwemeIds(collectKind, mergedParams);
  if (awemeIds.length === 0) {
    return;
  }

  for (const awemeId of awemeIds) {
    let rawData = awemeCache.get(awemeId);
    if (!rawData) {
      rawData = findAwemeAcrossDocumentFiber(awemeId) ?? undefined;
    }
    if (!rawData) {
      continue;
    }

    const message: NativeCollectCapturedMessage = {
      channel: PAGE_BRIDGE_CHANNEL,
      direction: 'main-to-content',
      type: 'NATIVE_COLLECT_CAPTURED',
      platform: 'douyin',
      rawData,
      sourceId: awemeId,
    };
    postBridgeMessage(message);
  }
}

function resolveCurrentItemRawData(): {
  rawData: UnknownRecord | null;
  error?: string;
} {
  // 1. 优先从当前页面 URL（/video/:id、/note/:id、?modal_id=:id）解析并查 LRU
  const urlAwemeId = extractAwemeIdFromUrl(window.location.href);
  if (urlAwemeId) {
    const cachedByUrl = awemeCache.get(urlAwemeId);
    if (cachedByUrl) {
      return { rawData: cachedByUrl };
    }
  }

  // 2. 扫描视口中最活跃的视频/作品 DOM 容器，提取 data-e2e-vid / data-aweme-id 查 LRU
  const activeElements = collectViewportActiveElements();
  const domAwemeId = extractAwemeIdFromAncestors(activeElements);
  if (domAwemeId) {
    const cachedByDom = awemeCache.get(domAwemeId);
    if (cachedByDom) {
      return { rawData: cachedByDom };
    }
  }

  const targetAwemeId = urlAwemeId ?? domAwemeId ?? undefined;

  // 3. React Fiber 遍历兜底（从活跃元素向上回溯）
  if (activeElements.length > 0) {
    const fromActiveFiber = findAwemeViaReactFiberFromElements(
      activeElements,
      targetAwemeId,
    );
    if (fromActiveFiber) {
      return { rawData: fromActiveFiber };
    }
  }

  // 4. 若已知目标 ID 但缓存未命中，或活跃元素未找到，再做一次全页受控 Fiber 扫描
  const fromDocumentFiber = findAwemeAcrossDocumentFiber(targetAwemeId);
  if (fromDocumentFiber) {
    return { rawData: fromDocumentFiber };
  }

  return {
    rawData: null,
    error: targetAwemeId
      ? `未能获取到当前抖音作品（${targetAwemeId}）的媒体数据，请稍候或刷新页面后重试。`
      : '未能在当前页面定位到正在浏览的抖音视频或图集，请进入具体作品或播放视频后重试。',
  };
}

function scanInitialPageData(): void {
  try {
    const renderDataEl = document.getElementById('RENDER_DATA');
    const rawText = renderDataEl?.textContent?.trim();
    if (rawText) {
      const decoded = decodeURIComponent(rawText);
      const parsed: unknown = JSON.parse(decoded);
      harvestAwemeObjects(parsed);
      const account = extractLoggedInAccountFromSsrTree(parsed);
      if (account) {
        notifyLoginState(account);
      }
    }
  } catch {
    // 忽略首屏 RENDER_DATA 解码异常
  }

  try {
    const hostGlobal = globalThis as unknown as GlobalWithDouyinHook;
    if (hostGlobal._ROUTER_DATA !== undefined) {
      harvestAwemeObjects(hostGlobal._ROUTER_DATA);
      const account = extractLoggedInAccountFromSsrTree(hostGlobal._ROUTER_DATA);
      if (account) {
        notifyLoginState(account);
      }
    }
  } catch {
    // 忽略 _ROUTER_DATA 扫描异常
  }
}

function getFetchRequestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') {
    return input;
  }
  if (input instanceof URL) {
    return input.href;
  }
  return input.url;
}

function installFetchHook(): void {
  if (typeof window.fetch !== 'function') {
    return;
  }

  const originalFetch = window.fetch;

  window.fetch = function collectPlusDouyinFetch(
    this: unknown,
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const requestUrl = getFetchRequestUrl(input);
    const isApi = isDouyinApiUrl(requestUrl);
    const collectKind =
      isApi && internalUncollectFetchInFlight === 0
        ? classifyCollectEndpoint(requestUrl)
        : null;
    const isProfileSelf = isApi && isUserProfileSelfUrl(requestUrl);
    const isCollectionList =
      isApi && internalSyncFetchInFlight === 0 && isCollectionListUrl(requestUrl);
    const isCommentList =
      isApi && internalCommentFetchInFlight === 0 && isCommentListUrl(requestUrl);

    let bodyParamsPromise: Promise<Map<string, string>> | null = null;
    if (collectKind !== null) {
      if (init?.body !== undefined) {
        bodyParamsPromise = Promise.resolve(extractBodyParams(init.body));
      } else if (input instanceof Request && !input.bodyUsed) {
        try {
          const clonedReq = input.clone();
          bodyParamsPromise = clonedReq
            .text()
            .then((text) => parseParamsFromString(text))
            .catch(() => new Map<string, string>());
        } catch {
          bodyParamsPromise = Promise.resolve(new Map<string, string>());
        }
      } else {
        bodyParamsPromise = Promise.resolve(new Map<string, string>());
      }
    }

    const fetchPromise = originalFetch.call(window, input, init);

    if (isApi) {
      void fetchPromise
        .then(async (response) => {
          if (response.status < 200 || response.status >= 300) {
            return;
          }

          let parsedJson: unknown;
          try {
            const text = await response.clone().text();
            if (!text) {
              return;
            }
            parsedJson = JSON.parse(text);
          } catch {
            return;
          }

          try {
            harvestAwemeObjects(parsedJson);
          } catch {
            // 静默吞掉解析异常
          }

          if (isProfileSelf) {
            try {
              const account = extractAccountFromProfileResponse(parsedJson);
              if (account) {
                notifyLoginState(account);
              }
            } catch {
              // 静默吞掉登录态解析异常
            }
          }

          if (isCollectionList && internalSyncFetchInFlight === 0) {
            try {
              handlePassiveCollectionListResponse(parsedJson);
            } catch {
              // 静默吞掉被动收藏列表解析异常
            }
          }

          if (isCommentList && internalCommentFetchInFlight === 0) {
            try {
              harvestCommentListResponse(requestUrl, parsedJson);
            } catch {
              // 静默吞掉被动评论列表解析异常
            }
          }

          if (collectKind !== null) {
            try {
              const bodyParams = bodyParamsPromise
                ? await bodyParamsPromise
                : new Map<string, string>();
              handleNativeCollectSuccess(
                collectKind,
                requestUrl,
                bodyParams,
                parsedJson,
              );
            } catch {
              // 静默吞掉收藏检测异常
            }
          }
        })
        .catch(() => {
          // 绝不向外抛出未捕获 Promise 异常
        });
    }

    return fetchPromise;
  };
}

function installXhrHook(): void {
  if (typeof XMLHttpRequest === 'undefined') {
    return;
  }

  const xhrProto = XMLHttpRequest.prototype;
  const originalOpen = xhrProto.open;
  const originalSend = xhrProto.send;
  const metaMap = new WeakMap<XMLHttpRequest, XhrRequestMeta>();

  xhrProto.open = function collectPlusDouyinXhrOpen(
    this: XMLHttpRequest,
    method: string,
    url: string | URL,
    async?: boolean,
    username?: string | null,
    password?: string | null,
  ): void {
    try {
      const urlString = typeof url === 'string' ? url : url.href;
      const isApi = isDouyinApiUrl(urlString);
      const collectKind = isApi ? classifyCollectEndpoint(urlString) : null;
      metaMap.set(this, {
        method,
        url: urlString,
        isApi,
        collectKind,
        bodyParams: new Map<string, string>(),
      });
    } catch {
      // 静默忽略，确保原 open 正常执行
    }

    if (async === undefined) {
      originalOpen.call(this, method, url, true);
      return;
    }
    originalOpen.call(
      this,
      method,
      url,
      async,
      username ?? null,
      password ?? null,
    );
  };

  xhrProto.send = function collectPlusDouyinXhrSend(
    this: XMLHttpRequest,
    body?: Document | XMLHttpRequestBodyInit | null,
  ): void {
    try {
      const meta = metaMap.get(this);
      if (meta?.isApi) {
        if (meta.collectKind !== null) {
          meta.bodyParams = extractBodyParams(body);
        }

        const xhrInstance = this;
        xhrInstance.addEventListener(
          'load',
          () => {
            try {
              if (xhrInstance.status < 200 || xhrInstance.status >= 300) {
                return;
              }

              let parsedJson: unknown;
              if (
                xhrInstance.responseType === '' ||
                xhrInstance.responseType === 'text'
              ) {
                const text = xhrInstance.responseText;
                if (!text) {
                  return;
                }
                parsedJson = JSON.parse(text);
              } else if (xhrInstance.responseType === 'json') {
                parsedJson = xhrInstance.response;
              } else {
                return;
              }

              harvestAwemeObjects(parsedJson);

              if (isUserProfileSelfUrl(meta.url)) {
                const account = extractAccountFromProfileResponse(parsedJson);
                if (account) {
                  notifyLoginState(account);
                }
              }

              if (
                internalSyncFetchInFlight === 0 &&
                isCollectionListUrl(meta.url)
              ) {
                handlePassiveCollectionListResponse(parsedJson);
              }

              if (
                internalCommentFetchInFlight === 0 &&
                isCommentListUrl(meta.url)
              ) {
                harvestCommentListResponse(meta.url, parsedJson);
              }

              if (meta.collectKind !== null) {
                handleNativeCollectSuccess(
                  meta.collectKind,
                  meta.url,
                  meta.bodyParams,
                  parsedJson,
                );
              }
            } catch {
              // 静默吞掉旁路解析异常
            }
          },
          { once: true },
        );
      }
    } catch {
      // 静默忽略，确保原 send 正常执行
    }

    originalSend.call(this, body);
  };
}

async function runRemoteUncollectItems(
  items: readonly RemoteUncollectTargetInput[],
): Promise<RemoteUncollectTargetOutcome[]> {
  const results: RemoteUncollectTargetOutcome[] = [];

  for (let i = 0; i < items.length; i += 1) {
    const target = items[i];
    if (!target) {
      continue;
    }
    const awemeId = target.sourceId.trim();
    if (!awemeId) {
      results.push({ sourceId: target.sourceId, ok: false, reason: '无效作品 ID' });
      continue;
    }
    if (i > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, 260));
    }

    internalUncollectFetchInFlight += 1;
    try {
      const endpoint = `/aweme/v1/web/aweme/collect/?aweme_id=${encodeURIComponent(awemeId)}&action=0`;
      const response = await window.fetch(endpoint, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
        },
        body: `aweme_id=${encodeURIComponent(awemeId)}&action=0`,
      });
      if (response.status === 401 || response.status === 403) {
        results.push({
          sourceId: awemeId,
          ok: false,
          reason: `抖音未登录或触发校验（HTTP ${response.status}）`,
        });
        continue;
      }
      if (!response.ok) {
        results.push({
          sourceId: awemeId,
          ok: false,
          reason: `抖音接口返回 HTTP ${response.status}`,
        });
        continue;
      }
      const text = await response.text();
      if (text) {
        try {
          const parsed: unknown = JSON.parse(text);
          if (!isResponseStatusSuccess(parsed)) {
            results.push({
              sourceId: awemeId,
              ok: false,
              reason: '抖音取消收藏未通过状态校验（可能需要重新登录）',
            });
            continue;
          }
        } catch {
          // 非 JSON 2xx 响应按成功处理
        }
      }
      results.push({ sourceId: awemeId, ok: true });
    } catch (error) {
      results.push({
        sourceId: awemeId,
        ok: false,
        reason: error instanceof Error ? error.message : String(error),
      });
    } finally {
      internalUncollectFetchInFlight = Math.max(
        0,
        internalUncollectFetchInFlight - 1,
      );
    }
  }

  return results;
}

function installBridgeMessageListener(): void {
  window.addEventListener('message', (event: MessageEvent<unknown>) => {
    if (event.source !== window) {
      return;
    }
    if (!isPageBridgeMessage(event.data)) {
      return;
    }
    if (event.data.direction !== 'content-to-main') {
      return;
    }

    switch (event.data.type) {
      case 'REQUEST_CURRENT_ITEM': {
        const request: RequestCurrentItemMessage = event.data;
        const { rawData, error } = resolveCurrentItemRawData();

        const response: CurrentItemResponseMessage = {
          channel: PAGE_BRIDGE_CHANNEL,
          direction: 'main-to-content',
          type: 'CURRENT_ITEM_RESPONSE',
          requestId: request.requestId,
          platform: 'douyin',
          rawData,
          triggerSource: request.triggerSource,
        };
        if (error !== undefined) {
          response.error = error;
        }

        postBridgeMessage(response);
        break;
      }

      case 'REQUEST_LOGIN_STATE': {
        if (!detectedAccount) {
          scanInitialPageData();
        }
        if (detectedAccount) {
          notifyLoginState(detectedAccount, true);
        }
        break;
      }

      case 'REQUEST_FULL_COLLECTION_SYNC': {
        void runFullCollectionSync(event.data.syncId);
        break;
      }

      case 'CANCEL_FULL_COLLECTION_SYNC': {
        if (activeSyncId === event.data.syncId && activeSyncAbortController) {
          activeSyncAbortController.abort();
        }
        break;
      }

      case 'REQUEST_REMOTE_UNCOLLECT': {
        const request: RequestRemoteUncollectMessage = event.data;
        void runRemoteUncollectItems(request.items).then((results) => {
          const response: RemoteUncollectResponseMessage = {
            channel: PAGE_BRIDGE_CHANNEL,
            direction: 'main-to-content',
            type: 'REMOTE_UNCOLLECT_RESPONSE',
            requestId: request.requestId,
            platform: 'douyin',
            results,
          };
          postBridgeMessage(response);
        });
        break;
      }

      case 'REQUEST_ITEM_COMMENTS': {
        const request: RequestItemCommentsMessage = event.data;
        void fetchCommentsForAweme(request.sourceId, request.limit).then(
          ({ rawComments, error }) => {
            const response: ItemCommentsResponseMessage = {
              channel: PAGE_BRIDGE_CHANNEL,
              direction: 'main-to-content',
              type: 'ITEM_COMMENTS_RESPONSE',
              requestId: request.requestId,
              platform: 'douyin',
              sourceId: request.sourceId,
              rawComments,
              ...(error !== undefined ? { error } : {}),
            };
            postBridgeMessage(response);
          },
        );
        break;
      }
    }
  });
}

/**
 * 幂等安装抖音 Main World 被动拦截器与页面桥接监听器。
 */
export function installDouyinMainHook(): void {
  const hostGlobal = globalThis as unknown as GlobalWithDouyinHook;
  if (hostGlobal[INSTALL_LOCK_KEY]) {
    return;
  }
  hostGlobal[INSTALL_LOCK_KEY] = true;

  installFetchHook();
  installXhrHook();
  installBridgeMessageListener();

  // 立即扫描首屏数据；若当前处于 document_start，在 DOMContentLoaded 后再补扫一次 #RENDER_DATA
  scanInitialPageData();
  if (document.readyState === 'loading') {
    document.addEventListener(
      'DOMContentLoaded',
      () => {
        scanInitialPageData();
      },
      { once: true },
    );
  }

  const readyMessage: BridgeReadyMessage = {
    channel: PAGE_BRIDGE_CHANNEL,
    direction: 'main-to-content',
    type: 'BRIDGE_READY',
    platform: 'douyin',
  };
  postBridgeMessage(readyMessage);
}
