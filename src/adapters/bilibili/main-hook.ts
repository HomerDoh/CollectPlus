/**
 * Bilibili Main World 被动拦截器与桥接模块。
 *
 * 运行于页面 `world: 'MAIN'` 上下文：
 * - 禁止引用任何 `chrome.*` API、Dexie 或 React 运行时；
 * - 仅通过 `window.postMessage` + `PAGE_BRIDGE_CHANNEL` 与 Isolated Content Script 通信；
 * - 旁路拦截 `window.fetch` / `XMLHttpRequest` 收割视频元数据、DASH/durl 播放流、登录态、
 *   评论列表与原生收藏/取消收藏动作，绝不阻塞或篡改宿主页请求。
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
  type RequestCurrentItemMessage,
  type RequestItemCommentsMessage,
} from '../../types/adapter.ts';

type UnknownRecord = Record<string, unknown>;

const INSTALL_LOCK_KEY = Symbol.for(
  'collect-plus:bilibili-main-hook-installed',
);
const VIDEO_CACHE_CAPACITY = 200;
const COMMENT_CACHE_CAPACITY = 30;
const DEFAULT_COMMENT_LIMIT = 100;
const COMMENT_PAGE_SIZE = 20;
const MAX_COMMENT_FETCH_PAGES = 6;
const COMMENT_PAGE_MIN_DELAY_MS = 300;
const COMMENT_PAGE_JITTER_MS = 250;
const FULL_SYNC_PAGE_SIZE = 20;
const MAX_FULL_SYNC_PAGES_PER_FOLDER = 50;
const FULL_SYNC_PAGE_MIN_DELAY_MS = 1500;
const FULL_SYNC_PAGE_JITTER_MS = 600;
const FULL_SYNC_ITEM_DELAY_MS = 350;
const FULL_SYNC_ITEM_JITTER_MS = 200;

const RATE_LIMIT_HTTP_STATUSES: ReadonlySet<number> = new Set([412, 429]);
const RATE_LIMIT_BILI_CODES: ReadonlySet<number> = new Set([-412, -352, -799]);

interface GlobalWithBilibiliHook {
  [INSTALL_LOCK_KEY]?: boolean;
  __INITIAL_STATE__?: unknown;
  __playinfo__?: unknown;
}

interface DetectedAccount {
  accountId: string;
  accountName?: string;
}

interface BilibiliBundlePayload {
  videoData: UnknownRecord;
  playinfo: UnknownRecord;
  tags?: readonly unknown[];
  currentP: number;
}

interface CachedReplies {
  comments: UnknownRecord[];
  seenIds: Set<string>;
  nextPage: number;
  hasMore: boolean;
}

interface XhrMeta {
  method: string;
  url: string;
  bodyParams: Map<string, string>;
}

class SimpleLruCache<V> {
  private readonly capacity: number;
  private readonly store = new Map<string, V>();

  constructor(capacity: number) {
    this.capacity = Math.max(1, capacity);
  }

  get(key: string): V | undefined {
    const trimmed = key.trim();
    if (!trimmed) {
      return undefined;
    }
    const found = this.store.get(trimmed);
    if (found === undefined) {
      return undefined;
    }
    this.store.delete(trimmed);
    this.store.set(trimmed, found);
    return found;
  }

  set(key: string, value: V): void {
    const trimmed = key.trim();
    if (!trimmed) {
      return;
    }
    if (this.store.has(trimmed)) {
      this.store.delete(trimmed);
    }
    this.store.set(trimmed, value);
    while (this.store.size > this.capacity) {
      const oldest = this.store.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.store.delete(oldest);
    }
  }
}

const videoMetaCache = new SimpleLruCache<UnknownRecord>(VIDEO_CACHE_CAPACITY);
const playinfoCache = new SimpleLruCache<UnknownRecord>(VIDEO_CACHE_CAPACITY);
const tagsCache = new SimpleLruCache<readonly unknown[]>(VIDEO_CACHE_CAPACITY);
const aidToBvidMap = new SimpleLruCache<string>(VIDEO_CACHE_CAPACITY * 2);
const commentCache = new SimpleLruCache<CachedReplies>(COMMENT_CACHE_CAPACITY);

let detectedAccount: DetectedAccount | null = null;
let lastEmittedAccountId: string | null = null;
let activeSyncId: string | null = null;
let activeSyncAbortController: AbortController | null = null;
let internalFetchInFlight = 0;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(record: UnknownRecord, key: string): string | undefined {
  const val = record[key];
  if (typeof val === 'string') {
    const trimmed = val.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  return undefined;
}

function readIdString(record: UnknownRecord, key: string): string | undefined {
  const val = record[key];
  if (typeof val === 'string') {
    const trimmed = val.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (typeof val === 'number' && Number.isFinite(val) && val > 0) {
    return String(Math.trunc(val));
  }
  return undefined;
}

function readNumber(record: UnknownRecord, key: string): number | undefined {
  const val = record[key];
  if (typeof val === 'number' && Number.isFinite(val)) {
    return val;
  }
  if (typeof val === 'string' && val.trim()) {
    const parsed = Number(val.trim());
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function getBridgeTargetOrigin(): string {
  try {
    const origin = window.location.origin;
    if (origin && origin !== 'null') {
      return origin;
    }
  } catch {
    // 忽略异常并回退通配 origin
  }
  return '*';
}

function postBridgeMessage(message: PageBridgeMessage): void {
  try {
    window.postMessage(message, getBridgeTargetOrigin());
  } catch {
    // 静默忽略，避免影响宿主页
  }
}

function resolveUrl(rawUrl: string): URL | null {
  try {
    return new URL(rawUrl, window.location.href);
  } catch {
    return null;
  }
}

function parseFormBodyParams(body: unknown): Map<string, string> {
  const params = new Map<string, string>();
  if (typeof body === 'string') {
    const trimmed = body.trim();
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (isRecord(parsed)) {
          for (const [k, v] of Object.entries(parsed)) {
            if (typeof v === 'string' || typeof v === 'number') {
              params.set(k, String(v));
            }
          }
        }
        return params;
      } catch {
        // 回退按查询串解析
      }
    }
    const search = new URLSearchParams(trimmed);
    for (const [k, v] of search.entries()) {
      params.set(k, v);
    }
    return params;
  }

  if (body instanceof URLSearchParams) {
    for (const [k, v] of body.entries()) {
      params.set(k, v);
    }
    return params;
  }

  if (typeof FormData !== 'undefined' && body instanceof FormData) {
    for (const [k, v] of body.entries()) {
      if (typeof v === 'string') {
        params.set(k, v);
      }
    }
  }

  return params;
}

function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(new DOMException('Aborted', 'AbortError'));
  }
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function extractUrlVideoTarget(): {
  bvid?: string;
  aid?: string;
  currentP: number;
} {
  const loc = resolveUrl(window.location.href);
  if (!loc) {
    return { currentP: 1 };
  }

  const bvMatch = /\/video\/(BV[0-9A-Za-z]+)/i.exec(loc.pathname);
  const avMatch = /\/video\/av(\d+)/i.exec(loc.pathname);
  const queryBvid = loc.searchParams.get('bvid')?.trim() || undefined;
  const queryAid = loc.searchParams.get('aid')?.trim() || undefined;
  const rawP = Number(loc.searchParams.get('p') ?? '1');
  const currentP =
    Number.isFinite(rawP) && rawP >= 1 ? Math.floor(rawP) : 1;

  const bvid = bvMatch?.[1] ?? queryBvid;
  const aid = avMatch?.[1] ?? queryAid;

  return {
    ...(bvid ? { bvid } : {}),
    ...(aid ? { aid } : {}),
    currentP,
  };
}

function recordVideoMeta(
  videoData: UnknownRecord,
  tags?: readonly unknown[],
): void {
  const bvid = readString(videoData, 'bvid');
  const aid = readIdString(videoData, 'aid') ?? readIdString(videoData, 'id');
  if (bvid) {
    videoMetaCache.set(bvid, videoData);
    if (aid) {
      aidToBvidMap.set(aid, bvid);
    }
    if (tags && tags.length > 0) {
      tagsCache.set(bvid, tags);
    }
  } else if (aid) {
    videoMetaCache.set(`av${aid}`, videoData);
    if (tags && tags.length > 0) {
      tagsCache.set(`av${aid}`, tags);
    }
  }
}

function hasPlayableStreams(playinfo: UnknownRecord | undefined): boolean {
  if (!playinfo) {
    return false;
  }
  const target = isRecord(playinfo.data)
    ? playinfo.data
    : isRecord(playinfo.result)
      ? playinfo.result
      : playinfo;
  if (isRecord(target.dash) && Array.isArray(target.dash.video) && target.dash.video.length > 0) {
    return true;
  }
  return Array.isArray(target.durl) && target.durl.length > 0;
}

function recordPlayinfo(
  bvid: string | undefined,
  aid: string | undefined,
  cid: string | undefined,
  playinfo: UnknownRecord,
): void {
  if (!hasPlayableStreams(playinfo)) {
    return;
  }
  const resolvedBvid = bvid ?? (aid ? aidToBvidMap.get(aid) : undefined);
  const keyBase = resolvedBvid ?? (aid ? `av${aid}` : undefined);
  if (!keyBase) {
    return;
  }
  if (cid) {
    playinfoCache.set(`${keyBase}:${cid}`, playinfo);
  }
  playinfoCache.set(keyBase, playinfo);
}

function readSsrState(): {
  videoData?: UnknownRecord;
  tags?: readonly unknown[];
  bvid?: string;
  aid?: string;
  p: number;
  playinfo?: UnknownRecord;
} {
  const hostGlobal = globalThis as unknown as GlobalWithBilibiliHook;
  const initialState = isRecord(hostGlobal.__INITIAL_STATE__)
    ? hostGlobal.__INITIAL_STATE__
    : undefined;
  const rawPlayinfo = isRecord(hostGlobal.__playinfo__)
    ? hostGlobal.__playinfo__
    : undefined;

  const videoData = initialState && isRecord(initialState.videoData)
    ? initialState.videoData
    : undefined;
  const tags =
    initialState && Array.isArray(initialState.tags)
      ? initialState.tags
      : undefined;
  const bvid =
    (videoData ? readString(videoData, 'bvid') : undefined) ??
    (initialState ? readString(initialState, 'bvid') : undefined);
  const aid =
    (videoData ? readIdString(videoData, 'aid') : undefined) ??
    (initialState ? readIdString(initialState, 'aid') : undefined);
  const rawP = initialState ? readNumber(initialState, 'p') : undefined;
  const p = rawP !== undefined && rawP >= 1 ? Math.floor(rawP) : 1;

  if (videoData) {
    recordVideoMeta(videoData, tags);
  }

  return {
    ...(videoData ? { videoData } : {}),
    ...(tags ? { tags } : {}),
    ...(bvid ? { bvid } : {}),
    ...(aid ? { aid } : {}),
    p,
    ...(rawPlayinfo && hasPlayableStreams(rawPlayinfo)
      ? { playinfo: rawPlayinfo }
      : {}),
  };
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
    platform: 'bilibili',
    accountId: account.accountId,
    ...(account.accountName ? { accountName: account.accountName } : {}),
  };
  postBridgeMessage(message);
}

function detectLoginFromNavPayload(payload: unknown): void {
  if (!isRecord(payload) || readNumber(payload, 'code') !== 0) {
    return;
  }
  const data = isRecord(payload.data) ? payload.data : undefined;
  if (!data || data.isLogin !== true) {
    return;
  }
  const mid = readIdString(data, 'mid');
  if (!mid) {
    return;
  }
  const uname = readString(data, 'uname');
  notifyLoginState({
    accountId: mid,
    ...(uname ? { accountName: uname } : {}),
  });
}

function mergeReplyPageIntoCache(
  oid: string,
  replies: readonly UnknownRecord[],
  nextPage: number,
  hasMore: boolean,
): CachedReplies {
  const existing = commentCache.get(oid);
  const entry: CachedReplies = existing ?? {
    comments: [],
    seenIds: new Set<string>(),
    nextPage: 1,
    hasMore: true,
  };

  for (const reply of replies) {
    if (entry.comments.length >= DEFAULT_COMMENT_LIMIT) {
      break;
    }
    const rpid =
      readIdString(reply, 'rpid_str') ?? readIdString(reply, 'rpid');
    if (rpid) {
      if (entry.seenIds.has(rpid)) {
        continue;
      }
      entry.seenIds.add(rpid);
    }
    entry.comments.push(reply);
  }

  entry.nextPage = Math.max(entry.nextPage, nextPage);
  entry.hasMore = hasMore;
  commentCache.set(oid, entry);
  return entry;
}

function extractRepliesFromPayload(payload: unknown): {
  replies: UnknownRecord[];
  hasMore: boolean;
} | null {
  if (!isRecord(payload) || readNumber(payload, 'code') !== 0) {
    return null;
  }
  const data = isRecord(payload.data) ? payload.data : undefined;
  if (!data) {
    return null;
  }

  const collected: UnknownRecord[] = [];
  if (Array.isArray(data.top_replies)) {
    for (const entry of data.top_replies) {
      if (isRecord(entry)) {
        collected.push(entry);
      }
    }
  }
  if (Array.isArray(data.replies)) {
    for (const entry of data.replies) {
      if (isRecord(entry)) {
        collected.push(entry);
      }
    }
  }

  const cursor = isRecord(data.cursor) ? data.cursor : undefined;
  const page = isRecord(data.page) ? data.page : undefined;
  let hasMore = false;
  if (cursor) {
    hasMore = cursor.is_end !== true && collected.length > 0;
  } else if (page) {
    const num = readNumber(page, 'num') ?? 1;
    const size = readNumber(page, 'size') ?? COMMENT_PAGE_SIZE;
    const count = readNumber(page, 'count') ?? 0;
    hasMore = num * size < count && collected.length > 0;
  }

  return { replies: collected, hasMore };
}

function resolveCidForPage(
  videoData: UnknownRecord,
  currentP: number,
): string | undefined {
  const pages = Array.isArray(videoData.pages) ? videoData.pages : undefined;
  if (pages && pages.length > 0) {
    const idx = Math.max(0, Math.min(pages.length - 1, currentP - 1));
    const entry = pages[idx];
    if (isRecord(entry)) {
      const pageCid = readIdString(entry, 'cid');
      if (pageCid) {
        return pageCid;
      }
    }
  }
  return (
    readIdString(videoData, 'cid') ??
    (isRecord(videoData.ugc) ? readIdString(videoData.ugc, 'first_cid') : undefined)
  );
}

async function fetchJsonInternal(
  url: string,
  signal?: AbortSignal,
): Promise<{ status: number; json: unknown | null }> {
  internalFetchInFlight += 1;
  try {
    const response = await window.fetch(url, {
      method: 'GET',
      credentials: 'include',
      signal,
    });
    const text = await response.text();
    if (!text) {
      return { status: response.status, json: null };
    }
    try {
      return { status: response.status, json: JSON.parse(text) };
    } catch {
      return { status: response.status, json: null };
    }
  } finally {
    internalFetchInFlight = Math.max(0, internalFetchInFlight - 1);
  }
}

async function fetchVideoViewMeta(
  query: { bvid?: string; aid?: string },
  signal?: AbortSignal,
): Promise<UnknownRecord | null> {
  const param = query.bvid
    ? `bvid=${encodeURIComponent(query.bvid)}`
    : query.aid
      ? `aid=${encodeURIComponent(query.aid)}`
      : null;
  if (!param) {
    return null;
  }

  const { status, json } = await fetchJsonInternal(
    `https://api.bilibili.com/x/web-interface/view?${param}`,
    signal,
  );
  if (status < 200 || status >= 300 || !isRecord(json)) {
    return null;
  }
  if (readNumber(json, 'code') !== 0 || !isRecord(json.data)) {
    return null;
  }
  recordVideoMeta(json.data);
  return json.data;
}

async function fetchPlayinfoForVideo(
  bvid: string | undefined,
  aid: string | undefined,
  cid: string,
  signal?: AbortSignal,
): Promise<{ playinfo: UnknownRecord | null; rateLimited: boolean }> {
  const idParam = bvid
    ? `bvid=${encodeURIComponent(bvid)}`
    : aid
      ? `avid=${encodeURIComponent(aid)}`
      : null;
  if (!idParam) {
    return { playinfo: null, rateLimited: false };
  }

  const endpoint = `https://api.bilibili.com/x/player/playurl?${idParam}&cid=${encodeURIComponent(cid)}&qn=80&fnval=16&fourk=1`;
  const { status, json } = await fetchJsonInternal(endpoint, signal);
  if (RATE_LIMIT_HTTP_STATUSES.has(status)) {
    return { playinfo: null, rateLimited: true };
  }
  if (status < 200 || status >= 300 || !isRecord(json)) {
    return { playinfo: null, rateLimited: false };
  }
  const code = readNumber(json, 'code');
  if (code !== undefined && RATE_LIMIT_BILI_CODES.has(code)) {
    return { playinfo: null, rateLimited: true };
  }
  if (code !== 0 || !isRecord(json.data) || !hasPlayableStreams(json.data)) {
    return { playinfo: null, rateLimited: false };
  }

  recordPlayinfo(bvid, aid, cid, json.data);
  return { playinfo: json.data, rateLimited: false };
}

async function resolveVideoBundle(
  target: { bvid?: string; aid?: string; currentP?: number },
  signal?: AbortSignal,
): Promise<{ bundle: BilibiliBundlePayload | null; rateLimited: boolean }> {
  const ssr = readSsrState();
  const currentP = Math.max(1, target.currentP ?? 1);
  let bvid = target.bvid ?? (target.aid ? aidToBvidMap.get(target.aid) : undefined);
  let aid = target.aid;

  if (!bvid && !aid) {
    bvid = ssr.bvid;
    aid = ssr.aid;
  }

  let videoData =
    (bvid ? videoMetaCache.get(bvid) : undefined) ??
    (aid ? videoMetaCache.get(`av${aid}`) : undefined);

  if (
    !videoData &&
    ssr.videoData &&
    ((bvid && ssr.bvid === bvid) || (aid && ssr.aid === aid))
  ) {
    videoData = ssr.videoData;
  }

  if (!videoData && (bvid || aid)) {
    videoData = (await fetchVideoViewMeta({ bvid, aid }, signal)) ?? undefined;
  }

  if (!videoData) {
    return { bundle: null, rateLimited: false };
  }

  bvid = readString(videoData, 'bvid') ?? bvid;
  aid = readIdString(videoData, 'aid') ?? readIdString(videoData, 'id') ?? aid;
  const cid = resolveCidForPage(videoData, currentP);
  const cacheKeyBase = bvid ?? (aid ? `av${aid}` : undefined);

  let playinfo =
    (cacheKeyBase && cid
      ? playinfoCache.get(`${cacheKeyBase}:${cid}`)
      : undefined) ??
    (cacheKeyBase ? playinfoCache.get(cacheKeyBase) : undefined);

  // 仅当 SSR 视频与当前目标 bvid/aid 及分 P 一致时才复用 window.__playinfo__，防止 SPA 切页错读旧流
  if (
    !playinfo &&
    ssr.playinfo &&
    ssr.p === currentP &&
    ((bvid && ssr.bvid === bvid) || (aid && ssr.aid === aid))
  ) {
    playinfo = ssr.playinfo;
  }

  if (!playinfo && cid) {
    const fetched = await fetchPlayinfoForVideo(bvid, aid, cid, signal);
    if (fetched.rateLimited) {
      return { bundle: null, rateLimited: true };
    }
    playinfo = fetched.playinfo ?? undefined;
  }

  if (!playinfo) {
    return { bundle: null, rateLimited: false };
  }

  const tags =
    (cacheKeyBase ? tagsCache.get(cacheKeyBase) : undefined) ??
    ((bvid && ssr.bvid === bvid) || (aid && ssr.aid === aid)
      ? ssr.tags
      : undefined);

  return {
    bundle: {
      videoData,
      playinfo,
      ...(tags ? { tags } : {}),
      currentP,
    },
    rateLimited: false,
  };
}

function stripPartSuffix(sourceId: string): string {
  return sourceId.replace(/_p\d+$/i, '').trim();
}

async function fetchCommentsForSource(
  sourceId: string,
  limit = DEFAULT_COMMENT_LIMIT,
): Promise<{ rawComments: UnknownRecord[]; error?: string }> {
  const safeLimit = Math.max(
    1,
    Math.min(DEFAULT_COMMENT_LIMIT, Math.floor(limit || DEFAULT_COMMENT_LIMIT)),
  );
  const baseId = stripPartSuffix(sourceId);
  let aid: string | undefined;

  const avMatch = /^av(\d+)$/i.exec(baseId);
  if (avMatch?.[1]) {
    aid = avMatch[1];
  } else {
    const cachedMeta = videoMetaCache.get(baseId);
    aid = cachedMeta ? readIdString(cachedMeta, 'aid') : undefined;
    if (!aid) {
      const ssr = readSsrState();
      if (ssr.bvid === baseId) {
        aid = ssr.aid;
      }
    }
  }

  if (!aid) {
    return { rawComments: [] };
  }

  const collected: UnknownRecord[] = [];
  const seenIds = new Set<string>();
  const appendUnique = (items: readonly UnknownRecord[]): void => {
    for (const item of items) {
      if (collected.length >= safeLimit) {
        break;
      }
      const rpid = readIdString(item, 'rpid_str') ?? readIdString(item, 'rpid');
      if (rpid) {
        if (seenIds.has(rpid)) {
          continue;
        }
        seenIds.add(rpid);
      }
      collected.push(item);
    }
  };

  let nextPage = 1;
  let hasMore = true;

  const cached = commentCache.get(aid);
  if (cached) {
    appendUnique(cached.comments);
    nextPage = Math.max(2, cached.nextPage);
    hasMore = cached.hasMore;
  }

  if (collected.length >= safeLimit || !hasMore) {
    return { rawComments: collected };
  }

  for (let i = 0; i < MAX_COMMENT_FETCH_PAGES; i += 1) {
    if (collected.length >= safeLimit || !hasMore) {
      break;
    }
    if (i > 0) {
      const delay =
        COMMENT_PAGE_MIN_DELAY_MS +
        Math.floor(Math.random() * COMMENT_PAGE_JITTER_MS);
      await sleepAbortable(delay);
    }

    try {
      const endpoint = `https://api.bilibili.com/x/v2/reply?type=1&oid=${encodeURIComponent(aid)}&pn=${nextPage}&ps=${COMMENT_PAGE_SIZE}&sort=2`;
      const { status, json } = await fetchJsonInternal(endpoint);
      if (status < 200 || status >= 300) {
        return {
          rawComments: collected,
          error: `B站评论接口返回 HTTP ${status}，已保留已获取的 ${collected.length} 条评论。`,
        };
      }
      const parsed = extractRepliesFromPayload(json);
      if (!parsed || parsed.replies.length === 0) {
        break;
      }
      mergeReplyPageIntoCache(aid, parsed.replies, nextPage + 1, parsed.hasMore);
      appendUnique(parsed.replies);
      hasMore = parsed.hasMore;
      nextPage += 1;
    } catch (error) {
      return {
        rawComments: collected,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  return { rawComments: collected };
}

async function runFullCollectionSync(syncId: string): Promise<void> {
  if (activeSyncId !== null) {
    return;
  }
  const mid = detectedAccount?.accountId;
  if (!mid) {
    const done: CollectionSyncDoneMessage = {
      channel: PAGE_BRIDGE_CHANNEL,
      direction: 'main-to-content',
      type: 'COLLECTION_SYNC_DONE',
      syncId,
      platform: 'bilibili',
      totalFetched: 0,
      status: 'error',
      error: '尚未检测到已登录的 B站账号。',
    };
    postBridgeMessage(done);
    return;
  }

  const controller = new AbortController();
  activeSyncId = syncId;
  activeSyncAbortController = controller;
  const fallbackUrl = `https://space.bilibili.com/${encodeURIComponent(mid)}/favlist`;
  let totalFetched = 0;
  let globalPageIndex = 0;

  const emitDone = (
    status: CollectionSyncDoneMessage['status'],
    error?: string,
  ): void => {
    const done: CollectionSyncDoneMessage = {
      channel: PAGE_BRIDGE_CHANNEL,
      direction: 'main-to-content',
      type: 'COLLECTION_SYNC_DONE',
      syncId,
      platform: 'bilibili',
      totalFetched,
      status,
      ...(error ? { error } : {}),
      ...(status === 'fallback_needed' ? { fallbackUrl } : {}),
    };
    postBridgeMessage(done);
  };

  try {
    const folderRes = await fetchJsonInternal(
      `https://api.bilibili.com/x/v3/fav/folder/created/list-all?up_mid=${encodeURIComponent(mid)}`,
      controller.signal,
    );
    if (RATE_LIMIT_HTTP_STATUSES.has(folderRes.status)) {
      emitDone('fallback_needed', 'B站收藏夹列表触发风控限流，已切入被动同步模式。');
      return;
    }
    if (
      folderRes.status < 200 ||
      folderRes.status >= 300 ||
      !isRecord(folderRes.json)
    ) {
      emitDone('error', `无法读取B站收藏夹列表（HTTP ${folderRes.status}）。`);
      return;
    }
    const folderCode = readNumber(folderRes.json, 'code');
    if (folderCode !== undefined && RATE_LIMIT_BILI_CODES.has(folderCode)) {
      emitDone('fallback_needed', 'B站接口返回风控校验码，已安全中止主动拉取。');
      return;
    }
    if (folderCode !== 0) {
      emitDone('error', `B站收藏夹接口返回异常错误码（${String(folderCode)}）。`);
      return;
    }

    const folderData = isRecord(folderRes.json.data)
      ? folderRes.json.data
      : undefined;
    const rawFolders =
      folderData && Array.isArray(folderData.list) ? folderData.list : [];
    const folderIds: string[] = [];
    for (const folder of rawFolders) {
      if (isRecord(folder)) {
        const fid = readIdString(folder, 'id');
        if (fid) {
          folderIds.push(fid);
        }
      }
    }

    const seenBvids = new Set<string>();

    for (const folderId of folderIds) {
      for (let pn = 1; pn <= MAX_FULL_SYNC_PAGES_PER_FOLDER; pn += 1) {
        if (controller.signal.aborted) {
          emitDone('cancelled');
          return;
        }
        if (globalPageIndex > 0) {
          const delay =
            FULL_SYNC_PAGE_MIN_DELAY_MS +
            Math.floor(Math.random() * FULL_SYNC_PAGE_JITTER_MS);
          await sleepAbortable(delay, controller.signal);
        }
        globalPageIndex += 1;

        const listRes = await fetchJsonInternal(
          `https://api.bilibili.com/x/v3/fav/resource/list?media_id=${encodeURIComponent(folderId)}&pn=${pn}&ps=${FULL_SYNC_PAGE_SIZE}&platform=web`,
          controller.signal,
        );
        if (RATE_LIMIT_HTTP_STATUSES.has(listRes.status)) {
          emitDone('fallback_needed', '拉取收藏夹分页触发风控限流，已安全切换至被动模式。');
          return;
        }
        if (
          listRes.status < 200 ||
          listRes.status >= 300 ||
          !isRecord(listRes.json)
        ) {
          emitDone('fallback_needed', `收藏夹分页返回 HTTP ${listRes.status}，已切换被动模式。`);
          return;
        }
        const listCode = readNumber(listRes.json, 'code');
        if (listCode !== undefined && RATE_LIMIT_BILI_CODES.has(listCode)) {
          emitDone('fallback_needed', '收藏夹分页触发风控校验，已切换至被动旁路模式。');
          return;
        }
        if (listCode !== 0 || !isRecord(listRes.json.data)) {
          break;
        }

        const medias = Array.isArray(listRes.json.data.medias)
          ? listRes.json.data.medias
          : [];
        const hasMore = listRes.json.data.has_more === true;
        const rawItems: BilibiliBundlePayload[] = [];

        for (const media of medias) {
          if (controller.signal.aborted) {
            emitDone('cancelled');
            return;
          }
          if (!isRecord(media)) {
            continue;
          }
          // 跳过已失效稿件（attr !== 0）与非视频稿件（type !== 2）
          const attr = readNumber(media, 'attr') ?? 0;
          const mediaType = readNumber(media, 'type') ?? 2;
          if (attr !== 0 || mediaType !== 2) {
            continue;
          }
          const bvid = readString(media, 'bvid');
          const aid = readIdString(media, 'id') ?? readIdString(media, 'aid');
          const uniqueKey = bvid ?? (aid ? `av${aid}` : undefined);
          if (!uniqueKey || seenBvids.has(uniqueKey)) {
            continue;
          }
          seenBvids.add(uniqueKey);

          recordVideoMeta(media);
          const ugc = isRecord(media.ugc) ? media.ugc : undefined;
          const cid =
            (ugc ? readIdString(ugc, 'first_cid') : undefined) ??
            readIdString(media, 'cid');

          let bundle: BilibiliBundlePayload | null = null;
          if (cid) {
            const cachedPlay =
              playinfoCache.get(`${uniqueKey}:${cid}`) ??
              playinfoCache.get(uniqueKey);
            if (cachedPlay) {
              bundle = { videoData: media, playinfo: cachedPlay, currentP: 1 };
            } else {
              const delay =
                FULL_SYNC_ITEM_DELAY_MS +
                Math.floor(Math.random() * FULL_SYNC_ITEM_JITTER_MS);
              await sleepAbortable(delay, controller.signal);
              const fetched = await fetchPlayinfoForVideo(
                bvid,
                aid,
                cid,
                controller.signal,
              );
              if (fetched.rateLimited) {
                emitDone('fallback_needed', '获取视频播放流触发限流，已安全切入被动模式。');
                return;
              }
              if (fetched.playinfo) {
                bundle = {
                  videoData: media,
                  playinfo: fetched.playinfo,
                  currentP: 1,
                };
              }
            }
          } else {
            const resolved = await resolveVideoBundle(
              { bvid, aid, currentP: 1 },
              controller.signal,
            );
            if (resolved.rateLimited) {
              emitDone('fallback_needed', '获取视频详情触发限流，已安全切入被动模式。');
              return;
            }
            bundle = resolved.bundle;
          }

          if (bundle) {
            rawItems.push(bundle);
          }
        }

        if (rawItems.length > 0) {
          totalFetched += rawItems.length;
          const batchMessage: CollectionSyncBatchMessage = {
            channel: PAGE_BRIDGE_CHANNEL,
            direction: 'main-to-content',
            type: 'COLLECTION_SYNC_BATCH',
            syncId,
            platform: 'bilibili',
            rawItems,
            pageIndex: globalPageIndex,
            hasMore,
          };
          postBridgeMessage(batchMessage);
        }

        if (!hasMore || medias.length === 0) {
          break;
        }
      }
    }

    emitDone('completed');
  } catch (error) {
    if (
      controller.signal.aborted ||
      (error instanceof DOMException && error.name === 'AbortError')
    ) {
      emitDone('cancelled');
    } else {
      emitDone('error', error instanceof Error ? error.message : String(error));
    }
  } finally {
    if (activeSyncId === syncId) {
      activeSyncId = null;
      activeSyncAbortController = null;
    }
  }
}

function handleFavDealResponse(
  url: URL,
  bodyParams: Map<string, string>,
  payload: unknown,
): void {
  if (!isRecord(payload) || readNumber(payload, 'code') !== 0) {
    return;
  }

  const readParam = (key: string): string =>
    (bodyParams.get(key) ?? url.searchParams.get(key) ?? '').trim();

  if (url.pathname.includes('/fav/resource/batch-del')) {
    const rawResources = readParam('resources');
    if (!rawResources) {
      return;
    }
    const sourceIds: string[] = [];
    for (const part of rawResources.split(',')) {
      const [aidPart, typePart] = part.trim().split(':');
      if (!aidPart || (typePart && typePart !== '2')) {
        continue;
      }
      const bvid = aidToBvidMap.get(aidPart);
      sourceIds.push(bvid ?? `av${aidPart}`);
    }
    if (sourceIds.length > 0) {
      const uncollectMsg: NativeUncollectCapturedMessage = {
        channel: PAGE_BRIDGE_CHANNEL,
        direction: 'main-to-content',
        type: 'NATIVE_UNCOLLECT_CAPTURED',
        platform: 'bilibili',
        sourceIds,
      };
      postBridgeMessage(uncollectMsg);
    }
    return;
  }

  const resourceType = readParam('type');
  if (resourceType && resourceType !== '2') {
    return;
  }
  const rid = readParam('rid');
  if (!rid) {
    return;
  }

  const addMediaIds = readParam('add_media_ids');
  const delMediaIds = readParam('del_media_ids');
  const urlTarget = extractUrlVideoTarget();

  if (addMediaIds.length > 0) {
    const bvid = aidToBvidMap.get(rid) ?? (urlTarget.aid === rid ? urlTarget.bvid : undefined);
    void resolveVideoBundle({
      bvid,
      aid: rid,
      currentP: urlTarget.currentP,
    }).then(({ bundle }) => {
      if (!bundle) {
        return;
      }
      const resolvedBvid = readString(bundle.videoData, 'bvid') ?? bvid;
      const msg: NativeCollectCapturedMessage = {
        channel: PAGE_BRIDGE_CHANNEL,
        direction: 'main-to-content',
        type: 'NATIVE_COLLECT_CAPTURED',
        platform: 'bilibili',
        rawData: bundle,
        ...(resolvedBvid ? { sourceId: resolvedBvid } : {}),
      };
      postBridgeMessage(msg);
    });
    return;
  }

  if (delMediaIds.length > 0) {
    const ssr = readSsrState();
    const bvid =
      aidToBvidMap.get(rid) ??
      (ssr.aid === rid ? ssr.bvid : undefined) ??
      (urlTarget.aid === rid ? urlTarget.bvid : undefined);
    const uncollectMsg: NativeUncollectCapturedMessage = {
      channel: PAGE_BRIDGE_CHANNEL,
      direction: 'main-to-content',
      type: 'NATIVE_UNCOLLECT_CAPTURED',
      platform: 'bilibili',
      sourceIds: [bvid ?? `av${rid}`],
    };
    postBridgeMessage(uncollectMsg);
  }
}

function handleInterceptedApiResponse(
  rawUrl: string,
  method: string,
  bodyParams: Map<string, string>,
  payload: unknown,
): void {
  const parsed = resolveUrl(rawUrl);
  if (!parsed) {
    return;
  }
  const pathname = parsed.pathname;

  if (pathname.includes('/x/web-interface/nav')) {
    detectLoginFromNavPayload(payload);
    return;
  }

  if (
    pathname.includes('/x/web-interface/view') ||
    pathname.includes('/x/web-interface/wbi/view')
  ) {
    if (isRecord(payload) && readNumber(payload, 'code') === 0 && isRecord(payload.data)) {
      const viewObj = isRecord(payload.data.View) ? payload.data.View : payload.data;
      const tags = Array.isArray(payload.data.Tags) ? payload.data.Tags : undefined;
      recordVideoMeta(viewObj, tags);
    }
    return;
  }

  if (
    pathname.includes('/x/player/playurl') ||
    pathname.includes('/x/player/wbi/playurl')
  ) {
    if (isRecord(payload) && readNumber(payload, 'code') === 0 && isRecord(payload.data)) {
      const bvid = parsed.searchParams.get('bvid')?.trim() || undefined;
      const aid = parsed.searchParams.get('avid')?.trim() || undefined;
      const cid = parsed.searchParams.get('cid')?.trim() || undefined;
      recordPlayinfo(bvid, aid, cid, payload.data);
    }
    return;
  }

  if (
    pathname.includes('/x/v2/reply/wbi/main') ||
    pathname.includes('/x/v2/reply/main') ||
    /\/x\/v2\/reply(?:\/|$)/.test(pathname)
  ) {
    const oid = parsed.searchParams.get('oid')?.trim();
    if (oid) {
      const extracted = extractRepliesFromPayload(payload);
      if (extracted && extracted.replies.length > 0) {
        const pn = Number(parsed.searchParams.get('pn') ?? '1');
        const nextPage = Number.isFinite(pn) && pn >= 1 ? Math.floor(pn) + 1 : 2;
        mergeReplyPageIntoCache(oid, extracted.replies, nextPage, extracted.hasMore);
      }
    }
    return;
  }

  if (
    method.toUpperCase() === 'POST' &&
    (pathname.includes('/x/v3/fav/resource/deal') ||
      pathname.includes('/medialist/gateway/coll/resource/deal') ||
      pathname.includes('/x/v3/fav/resource/batch-del'))
  ) {
    handleFavDealResponse(parsed, bodyParams, payload);
    return;
  }

  if (
    internalFetchInFlight === 0 &&
    pathname.includes('/x/v3/fav/resource/list') &&
    isRecord(payload) &&
    readNumber(payload, 'code') === 0 &&
    isRecord(payload.data) &&
    Array.isArray(payload.data.medias)
  ) {
    const hasMore = payload.data.has_more === true;
    const rawMedias = payload.data.medias;
    void (async () => {
      const bundles: BilibiliBundlePayload[] = [];
      for (const media of rawMedias) {
        if (!isRecord(media)) {
          continue;
        }
        const attr = readNumber(media, 'attr') ?? 0;
        const mediaType = readNumber(media, 'type') ?? 2;
        if (attr !== 0 || mediaType !== 2) {
          continue;
        }
        recordVideoMeta(media);
        const bvid = readString(media, 'bvid');
        const aid = readIdString(media, 'id');
        const ugc = isRecord(media.ugc) ? media.ugc : undefined;
        const cid =
          (ugc ? readIdString(ugc, 'first_cid') : undefined) ??
          readIdString(media, 'cid');
        if (!cid) {
          continue;
        }
        const fetched = await fetchPlayinfoForVideo(bvid, aid, cid);
        if (fetched.rateLimited) {
          break;
        }
        if (fetched.playinfo) {
          bundles.push({ videoData: media, playinfo: fetched.playinfo, currentP: 1 });
        }
      }
      if (bundles.length > 0) {
        const passiveMsg: PassiveCollectionListCapturedMessage = {
          channel: PAGE_BRIDGE_CHANNEL,
          direction: 'main-to-content',
          type: 'PASSIVE_COLLECTION_LIST_CAPTURED',
          platform: 'bilibili',
          rawItems: bundles,
          hasMore,
        };
        postBridgeMessage(passiveMsg);
      }
    })();
  }
}

function isBilibiliInterestingApi(rawUrl: string): boolean {
  const parsed = resolveUrl(rawUrl);
  if (!parsed) {
    return false;
  }
  const host = parsed.hostname.toLowerCase();
  if (!host.endsWith('bilibili.com')) {
    return false;
  }
  const p = parsed.pathname;
  return (
    p.includes('/x/web-interface/view') ||
    p.includes('/x/web-interface/wbi/view') ||
    p.includes('/x/web-interface/nav') ||
    p.includes('/x/player/playurl') ||
    p.includes('/x/player/wbi/playurl') ||
    p.includes('/x/v2/reply') ||
    p.includes('/x/v3/fav/resource/deal') ||
    p.includes('/medialist/gateway/coll/resource/deal') ||
    p.includes('/x/v3/fav/resource/batch-del') ||
    p.includes('/x/v3/fav/resource/list')
  );
}

function patchFetchAndXhr(): void {
  const originalFetch = window.fetch.bind(window);
  window.fetch = function collectPlusBilibiliFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const requestUrl =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const method =
      init?.method ?? (input instanceof Request ? input.method : 'GET');
    const shouldInspect = isBilibiliInterestingApi(requestUrl);
    const bodyParams = shouldInspect
      ? parseFormBodyParams(init?.body)
      : new Map<string, string>();

    const promise = originalFetch(input, init);
    if (shouldInspect) {
      promise
        .then((response) => {
          const cloned = response.clone();
          return cloned.text().then((text) => {
            if (!text) {
              return;
            }
            const json: unknown = JSON.parse(text);
            handleInterceptedApiResponse(requestUrl, method, bodyParams, json);
          });
        })
        .catch(() => undefined);
    }
    return promise;
  };

  const xhrMetaMap = new WeakMap<XMLHttpRequest, XhrMeta>();
  const xhrProto = XMLHttpRequest.prototype;
  const originalOpen = xhrProto.open;
  const originalSend = xhrProto.send;

  xhrProto.open = function collectPlusBilibiliXhrOpen(
    this: XMLHttpRequest,
    method: string,
    url: string | URL,
    async?: boolean,
    username?: string | null,
    password?: string | null,
  ): void {
    const urlString = typeof url === 'string' ? url : url.href;
    if (isBilibiliInterestingApi(urlString)) {
      xhrMetaMap.set(this, {
        method,
        url: urlString,
        bodyParams: new Map<string, string>(),
      });
    } else {
      xhrMetaMap.delete(this);
    }
    if (async === undefined) {
      originalOpen.call(this, method, url, true);
    } else {
      originalOpen.call(this, method, url, async, username ?? null, password ?? null);
    }
  };

  xhrProto.send = function collectPlusBilibiliXhrSend(
    this: XMLHttpRequest,
    body?: Document | XMLHttpRequestBodyInit | null,
  ): void {
    const meta = xhrMetaMap.get(this);
    if (meta) {
      meta.bodyParams = parseFormBodyParams(body);
      this.addEventListener(
        'load',
        () => {
          try {
            let parsed: unknown;
            if (this.responseType === 'json') {
              parsed = this.response;
            } else if (
              this.responseType === '' ||
              this.responseType === 'text'
            ) {
              if (!this.responseText) {
                return;
              }
              parsed = JSON.parse(this.responseText);
            } else {
              return;
            }
            handleInterceptedApiResponse(
              meta.url,
              meta.method,
              meta.bodyParams,
              parsed,
            );
          } catch {
            // 忽略非 JSON 响应
          }
        },
        { once: true },
      );
    }
    originalSend.call(this, body);
  };
}

function handleRequestCurrentItem(message: RequestCurrentItemMessage): void {
  const urlTarget = extractUrlVideoTarget();
  void resolveVideoBundle(urlTarget)
    .then(({ bundle }) => {
      const response: CurrentItemResponseMessage = {
        channel: PAGE_BRIDGE_CHANNEL,
        direction: 'main-to-content',
        type: 'CURRENT_ITEM_RESPONSE',
        requestId: message.requestId,
        platform: 'bilibili',
        rawData: bundle,
        ...(bundle ? {} : { error: '未在当前页面检测到可采集的B站视频或播放流。' }),
        triggerSource: message.triggerSource,
      };
      postBridgeMessage(response);
    })
    .catch((error: unknown) => {
      const response: CurrentItemResponseMessage = {
        channel: PAGE_BRIDGE_CHANNEL,
        direction: 'main-to-content',
        type: 'CURRENT_ITEM_RESPONSE',
        requestId: message.requestId,
        platform: 'bilibili',
        rawData: null,
        error: error instanceof Error ? error.message : String(error),
        triggerSource: message.triggerSource,
      };
      postBridgeMessage(response);
    });
}

function handleRequestItemComments(message: RequestItemCommentsMessage): void {
  void fetchCommentsForSource(message.sourceId, message.limit).then(
    ({ rawComments, error }) => {
      const response: ItemCommentsResponseMessage = {
        channel: PAGE_BRIDGE_CHANNEL,
        direction: 'main-to-content',
        type: 'ITEM_COMMENTS_RESPONSE',
        requestId: message.requestId,
        platform: 'bilibili',
        sourceId: message.sourceId,
        rawComments,
        ...(error ? { error } : {}),
      };
      postBridgeMessage(response);
    },
  );
}

/**
 * 安装 Bilibili Main World 旁路拦截器（幂等防重入）。
 */
export function installBilibiliMainHook(): void {
  const hostGlobal = globalThis as unknown as GlobalWithBilibiliHook;
  if (hostGlobal[INSTALL_LOCK_KEY]) {
    return;
  }
  hostGlobal[INSTALL_LOCK_KEY] = true;

  patchFetchAndXhr();
  readSsrState();

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
      case 'REQUEST_CURRENT_ITEM':
        handleRequestCurrentItem(event.data);
        break;

      case 'REQUEST_ITEM_COMMENTS':
        handleRequestItemComments(event.data);
        break;

      case 'REQUEST_LOGIN_STATE': {
        if (detectedAccount) {
          notifyLoginState(detectedAccount, true);
        } else {
          // 轻探一次同源 nav 状态（宿主页通常也会自动请求），不触发签名风控
          void fetchJsonInternal(
            'https://api.bilibili.com/x/web-interface/nav',
          )
            .then(({ status, json }) => {
              if (status >= 200 && status < 300) {
                detectLoginFromNavPayload(json);
              }
            })
            .catch(() => undefined);
        }
        break;
      }

      case 'REQUEST_FULL_COLLECTION_SYNC':
        void runFullCollectionSync(event.data.syncId);
        break;

      case 'CANCEL_FULL_COLLECTION_SYNC':
        if (activeSyncId === event.data.syncId) {
          activeSyncAbortController?.abort();
        }
        break;
    }
  });

  const readyMessage: BridgeReadyMessage = {
    channel: PAGE_BRIDGE_CHANNEL,
    direction: 'main-to-content',
    type: 'BRIDGE_READY',
    platform: 'bilibili',
  };
  postBridgeMessage(readyMessage);
}
