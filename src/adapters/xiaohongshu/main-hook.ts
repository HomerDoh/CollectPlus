/**
 * 小红书 Main World 独立被动拦截器与桥接模块。
 *
 * 运行于页面 `world: 'MAIN'` 上下文：
 * - 严禁引用任何 `chrome.*` API、Dexie 或 React 运行时；
 * - 仅通过 `window.postMessage` + `PAGE_BRIDGE_CHANNEL` 与 Isolated Content Script 通信；
 * - 对 `window.fetch` 与 `XMLHttpRequest` 做只读旁路监听，不修改请求参数、不延迟或吞掉页面响应；
 * - 严禁将 `xsec_token` 等临时鉴权参数写入元数据或对外持久化，仅在内存缓存中辅助评论读取。
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

const INSTALL_LOCK_KEY = Symbol.for(
  'collect-plus:xiaohongshu-main-hook-installed',
);
const LRU_CAPACITY = 200;
const COMMENT_CACHE_CAPACITY = 30;
const MAX_HARVEST_DEPTH = 7;
const MAX_HARVEST_NODES = 3000;
const DEFAULT_COMMENT_LIMIT = 100;
const MAX_COMMENT_FETCH_PAGES = 8;
const COMMENT_PAGE_MIN_DELAY_MS = 350;
const COMMENT_PAGE_JITTER_MS = 250;
const FULL_SYNC_PAGE_SIZE = 30;
const MAX_FULL_SYNC_PAGES = 150;
const FULL_SYNC_MIN_DELAY_MS = 1500;
const FULL_SYNC_JITTER_MS = 700;

const XHS_API_MARKERS: readonly string[] = [
  '/api/sns/web/',
  '/api/sns/v',
];

interface GlobalWithXhsHook {
  [INSTALL_LOCK_KEY]?: boolean;
  __INITIAL_STATE__?: unknown;
}

interface DetectedAccount {
  accountId: string;
  accountName?: string;
}

interface CachedComments {
  comments: UnknownRecord[];
  seenIds: Set<string>;
  nextCursor: string;
  hasMore: boolean;
}

interface XhrMeta {
  method: string;
  url: string;
  isApi: boolean;
  bodyText: string;
}

let detectedAccount: DetectedAccount | null = null;
let lastEmittedAccountId: string | null = null;
let activeSyncId: string | null = null;
let activeSyncAbortController: AbortController | null = null;
let internalSyncFetchInFlight = 0;
let internalCommentFetchInFlight = 0;
let internalUncollectFetchInFlight = 0;

/** 仅存内存的 noteId -> xsec_token 映射（不落盘、不随元数据发送） */
const memoryXsecTokens = new Map<string, string>();

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(record: UnknownRecord, key: string): string | undefined {
  const value = record[key];
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  return undefined;
}

function readIdString(record: UnknownRecord, key: string): string | undefined {
  const value = record[key];
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return String(Math.trunc(value));
  }
  return undefined;
}

function readFirstId(
  record: UnknownRecord,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const v = readIdString(record, key);
    if (v !== undefined) {
      return v;
    }
  }
  return undefined;
}

function rememberXsecToken(noteId: string, token: unknown): void {
  if (typeof token !== 'string') {
    return;
  }
  const trimmed = token.trim();
  if (!trimmed || !noteId) {
    return;
  }
  if (memoryXsecTokens.size >= LRU_CAPACITY) {
    const oldest = memoryXsecTokens.keys().next().value;
    if (oldest !== undefined) {
      memoryXsecTokens.delete(oldest);
    }
  }
  memoryXsecTokens.delete(noteId);
  memoryXsecTokens.set(noteId, trimmed);
}

function getNoteRichnessScore(record: UnknownRecord): number {
  const card =
    (isRecord(record.note_card) ? record.note_card : undefined) ??
    (isRecord(record.noteCard) ? record.noteCard : undefined) ??
    (isRecord(record.note) ? record.note : undefined) ??
    record;

  let score = 0;
  if (isRecord(card.video)) {
    score += 2;
    if (isRecord(card.video.media) && isRecord(card.video.media.stream)) {
      score += 5;
    }
  }
  const imageList = card.image_list ?? card.imageList;
  if (Array.isArray(imageList) && imageList.length > 0) {
    score += 4 + Math.min(3, imageList.length);
  }
  if (isRecord(card.cover)) {
    score += 1;
  }
  if (typeof card.desc === 'string' && card.desc.trim().length > 0) {
    score += 2;
  }
  if (typeof card.title === 'string' && card.title.trim().length > 0) {
    score += 1;
  }
  if (isRecord(card.user)) {
    score += 1;
  }
  return score;
}

function extractNoteIdAndRecord(
  node: UnknownRecord,
): { noteId: string; record: UnknownRecord } | null {
  const outerId = readFirstId(node, ['note_id', 'noteId', 'id']);
  const noteCard =
    (isRecord(node.note_card) ? node.note_card : undefined) ??
    (isRecord(node.noteCard) ? node.noteCard : undefined) ??
    (isRecord(node.note) ? node.note : undefined);

  if (noteCard) {
    const innerId =
      readFirstId(noteCard, ['note_id', 'noteId', 'id']) ?? outerId;
    if (!innerId) {
      return null;
    }
    const hasMedia =
      Array.isArray(noteCard.image_list ?? noteCard.imageList) ||
      isRecord(noteCard.video) ||
      isRecord(noteCard.cover);
    if (!hasMedia) {
      return null;
    }
    rememberXsecToken(innerId, node.xsec_token ?? node.xsecToken);
    // 合并外层 id，确保传给 parser 时始终具备完整 noteId
    return {
      noteId: innerId,
      record: { ...noteCard, note_id: innerId },
    };
  }

  if (!outerId) {
    return null;
  }

  const hasMedia =
    Array.isArray(node.image_list ?? node.imageList) ||
    isRecord(node.video) ||
    isRecord(node.cover);
  if (!hasMedia) {
    return null;
  }
  // 排除用户头像对象或其他无关结构：至少需要 title/desc/user/type/image_list/video 之一
  const looksLikeNote =
    typeof node.type === 'string' ||
    typeof node.title === 'string' ||
    typeof node.display_title === 'string' ||
    typeof node.desc === 'string' ||
    Array.isArray(node.image_list ?? node.imageList) ||
    isRecord(node.video);
  if (!looksLikeNote) {
    return null;
  }

  rememberXsecToken(outerId, node.xsec_token ?? node.xsecToken);
  return {
    noteId: outerId,
    record: { ...node, note_id: outerId },
  };
}

class NoteLruCache {
  private readonly capacity: number;
  private readonly store = new Map<string, UnknownRecord>();

  constructor(capacity = LRU_CAPACITY) {
    this.capacity = Math.max(1, capacity);
  }

  set(noteId: string, record: UnknownRecord): void {
    const key = noteId.trim();
    if (!key) {
      return;
    }
    const existing = this.store.get(key);
    let valueToStore = record;
    if (existing) {
      this.store.delete(key);
      if (getNoteRichnessScore(existing) > getNoteRichnessScore(record)) {
        valueToStore = existing;
      }
    }
    this.store.set(key, valueToStore);

    while (this.store.size > this.capacity) {
      const oldest = this.store.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.store.delete(oldest);
    }
  }

  get(noteId: string): UnknownRecord | undefined {
    const key = noteId.trim();
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

class CommentLruCache {
  private readonly capacity: number;
  private readonly store = new Map<string, CachedComments>();

  constructor(capacity = COMMENT_CACHE_CAPACITY) {
    this.capacity = Math.max(1, capacity);
  }

  get(noteId: string): CachedComments | undefined {
    const key = noteId.trim();
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
    noteId: string,
    comments: readonly UnknownRecord[],
    nextCursor: string,
    hasMore: boolean,
  ): CachedComments {
    const key = noteId.trim();
    const existing = this.store.get(key);
    const entry: CachedComments = existing ?? {
      comments: [],
      seenIds: new Set<string>(),
      nextCursor: '',
      hasMore: true,
    };

    for (const comment of comments) {
      if (entry.comments.length >= DEFAULT_COMMENT_LIMIT) {
        break;
      }
      const cid = readFirstId(comment, ['id', 'comment_id', 'commentId']);
      if (cid) {
        if (entry.seenIds.has(cid)) {
          continue;
        }
        entry.seenIds.add(cid);
      }
      entry.comments.push(comment);
    }

    if (nextCursor) {
      entry.nextCursor = nextCursor;
    }
    entry.hasMore = hasMore;

    if (existing) {
      this.store.delete(key);
    }
    this.store.set(key, entry);

    while (this.store.size > this.capacity) {
      const oldest = this.store.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.store.delete(oldest);
    }

    return entry;
  }
}

const noteCache = new NoteLruCache(LRU_CAPACITY);
const commentCache = new CommentLruCache(COMMENT_CACHE_CAPACITY);

function harvestNoteObjects(payload: unknown): number {
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

    const extracted = extractNoteIdAndRecord(node);
    if (extracted) {
      noteCache.set(extracted.noteId, extracted.record);
      harvestedCount += 1;
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
    // 忽略异常
  }
  return '*';
}

function postBridgeMessage(message: PageBridgeMessage): void {
  try {
    window.postMessage(message, getBridgeTargetOrigin());
  } catch {
    // 静默忽略，避免干扰宿主页
  }
}

function resolveRequestUrl(rawUrl: string): URL | null {
  try {
    return new URL(rawUrl, window.location.href);
  } catch {
    return null;
  }
}

function isXhsApiUrl(rawUrl: string): boolean {
  const parsed = resolveRequestUrl(rawUrl);
  if (!parsed) {
    return false;
  }
  return XHS_API_MARKERS.some((marker) => parsed.pathname.includes(marker));
}

function isApiSuccess(payload: unknown): boolean {
  if (!isRecord(payload)) {
    return false;
  }
  if (payload.success === true) {
    return true;
  }
  if (payload.code === 0 || payload.code === '0') {
    return true;
  }
  return false;
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

function extractAccountFromUserRecord(
  userObj: UnknownRecord,
): DetectedAccount | null {
  if (userObj.guest === true || userObj.loggedIn === false) {
    return null;
  }
  const accountId =
    normalizeValidAccountId(userObj.user_id) ??
    normalizeValidAccountId(userObj.userId) ??
    normalizeValidAccountId(userObj.id);
  if (!accountId) {
    return null;
  }
  const accountName =
    readString(userObj, 'nickname') ??
    readString(userObj, 'nickName') ??
    readString(userObj, 'name');
  return accountName !== undefined ? { accountId, accountName } : { accountId };
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
    platform: 'xiaohongshu',
    accountId: account.accountId,
    ...(account.accountName !== undefined
      ? { accountName: account.accountName }
      : {}),
  };
  postBridgeMessage(message);
}

function harvestInitialState(): void {
  const globalObj = window as unknown as GlobalWithXhsHook;
  const state = globalObj.__INITIAL_STATE__;
  if (!isRecord(state)) {
    return;
  }

  if (isRecord(state.note)) {
    const detailMap = state.note.noteDetailMap;
    if (isRecord(detailMap)) {
      for (const [key, entry] of Object.entries(detailMap)) {
        if (!isRecord(entry)) {
          continue;
        }
        const noteObj = isRecord(entry.note) ? entry.note : entry;
        const noteId =
          readFirstId(noteObj, ['note_id', 'noteId', 'id']) ?? key.trim();
        if (noteId) {
          noteCache.set(noteId, { ...noteObj, note_id: noteId });
        }
      }
    }
    harvestNoteObjects(state.note);
  }

  if (isRecord(state.user)) {
    const userInfo = state.user.userInfo;
    if (isRecord(userInfo)) {
      const account = extractAccountFromUserRecord(userInfo);
      if (account) {
        notifyLoginState(account);
      }
    }
  }
}

function extractNoteIdFromUrl(urlStr: string): string | null {
  const parsed = resolveRequestUrl(urlStr);
  if (!parsed) {
    return null;
  }
  const patterns = [
    /\/explore\/([a-zA-Z0-9]+)/,
    /\/discovery\/item\/([a-zA-Z0-9]+)/,
    /\/user\/profile\/[^/]+\/([a-zA-Z0-9]+)/,
  ];
  for (const regex of patterns) {
    const match = regex.exec(parsed.pathname);
    if (match?.[1]) {
      const token = parsed.searchParams.get('xsec_token');
      if (token) {
        rememberXsecToken(match[1], token);
      }
      return match[1];
    }
  }
  return null;
}

function extractNoteIdFromDom(): string | null {
  const selectors = [
    '#noteContainer[data-note-id]',
    '.note-detail-mask [data-note-id]',
    '[data-note-id]',
  ];
  for (const selector of selectors) {
    const el = document.querySelector(selector);
    const id = el?.getAttribute('data-note-id')?.trim();
    if (id) {
      return id;
    }
  }

  const modalLink = document.querySelector<HTMLAnchorElement>(
    '.note-detail-mask a[href*="/explore/"], #noteContainer a[href*="/explore/"]',
  );
  if (modalLink?.href) {
    const fromLink = extractNoteIdFromUrl(modalLink.href);
    if (fromLink) {
      return fromLink;
    }
  }
  return null;
}

/** DOM 兜底组装：当 SSR 与接口缓存均未命中时，直接读取详情页 DOM */
function buildFallbackRawNoteFromDom(noteId: string): UnknownRecord | null {
  const root =
    document.querySelector('#noteContainer') ??
    document.querySelector('.note-detail-mask') ??
    document.body;
  if (!root) {
    return null;
  }

  const titleEl = root.querySelector('#detail-title, .title');
  const descEl = root.querySelector('#detail-desc, .desc, .note-text');
  const authorEl = root.querySelector('.author-wrapper .username, .username');

  const title = titleEl?.textContent?.trim() ?? '';
  const desc = descEl?.textContent?.trim() ?? '';
  const nickname = authorEl?.textContent?.trim() || '未知作者';

  const videoEl = root.querySelector<HTMLVideoElement>('video');
  const videoSrc = videoEl?.currentSrc || videoEl?.src || '';
  if (videoSrc && /^https?:\/\//i.test(videoSrc)) {
    const poster = videoEl?.poster || '';
    return {
      note_id: noteId,
      type: 'video',
      title,
      desc,
      user: { nickname },
      ...(poster && /^https?:\/\//i.test(poster)
        ? { cover: { url_default: poster } }
        : {}),
      video: {
        url: videoSrc,
      },
    };
  }

  const imgNodes = root.querySelectorAll<HTMLImageElement>(
    '.swiper-slide img, .note-slider-img, .img-container img',
  );
  const imageList: UnknownRecord[] = [];
  const seenSrc = new Set<string>();
  for (const img of imgNodes) {
    const src = img.currentSrc || img.src || '';
    if (!src || !/^https?:\/\//i.test(src) || seenSrc.has(src)) {
      continue;
    }
    seenSrc.add(src);
    imageList.push({
      url_default: src,
      ...(img.naturalWidth > 0 ? { width: img.naturalWidth } : {}),
      ...(img.naturalHeight > 0 ? { height: img.naturalHeight } : {}),
    });
  }

  if (imageList.length === 0) {
    return null;
  }

  return {
    note_id: noteId,
    type: 'normal',
    title,
    desc,
    user: { nickname },
    image_list: imageList,
  };
}

function resolveActiveNote(): UnknownRecord | null {
  harvestInitialState();

  const noteIdFromUrl = extractNoteIdFromUrl(window.location.href);
  if (noteIdFromUrl) {
    const cached = noteCache.get(noteIdFromUrl);
    if (cached) {
      return cached;
    }
    const domFallback = buildFallbackRawNoteFromDom(noteIdFromUrl);
    if (domFallback) {
      return domFallback;
    }
  }

  const noteIdFromDom = extractNoteIdFromDom();
  if (noteIdFromDom) {
    const cached = noteCache.get(noteIdFromDom);
    if (cached) {
      return cached;
    }
    const domFallback = buildFallbackRawNoteFromDom(noteIdFromDom);
    if (domFallback) {
      return domFallback;
    }
  }

  return noteCache.getLatest() ?? null;
}

function parseRequestBodyJson(bodyText: string): UnknownRecord | null {
  const trimmed = bodyText.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return isRecord(parsed) ? parsed : null;
  } catch {
    const params = new URLSearchParams(trimmed);
    const out: UnknownRecord = {};
    for (const [k, v] of params.entries()) {
      out[k] = v;
    }
    return Object.keys(out).length > 0 ? out : null;
  }
}

function extractBodyTextFromFetchInit(init?: RequestInit): string {
  const body = init?.body;
  if (typeof body === 'string') {
    return body;
  }
  if (body instanceof URLSearchParams) {
    return body.toString();
  }
  return '';
}

function extractCommentPageFromPayload(payload: unknown): {
  comments: UnknownRecord[];
  hasMore: boolean;
  nextCursor: string;
} | null {
  if (!isRecord(payload) || !isApiSuccess(payload)) {
    return null;
  }
  const dataObj = isRecord(payload.data) ? payload.data : payload;
  const rawList = Array.isArray(dataObj.comments) ? dataObj.comments : null;
  if (!rawList) {
    return null;
  }

  const comments: UnknownRecord[] = [];
  for (const entry of rawList) {
    if (isRecord(entry)) {
      comments.push(entry);
    }
  }
  const hasMore =
    dataObj.has_more === true ||
    dataObj.hasMore === true ||
    dataObj.has_more === 1;
  const cursorRaw = dataObj.cursor;
  const nextCursor =
    typeof cursorRaw === 'string'
      ? cursorRaw.trim()
      : typeof cursorRaw === 'number' && Number.isFinite(cursorRaw)
        ? String(cursorRaw)
        : '';

  return { comments, hasMore, nextCursor };
}

function extractCollectionPageFromPayload(payload: unknown): {
  items: UnknownRecord[];
  hasMore: boolean;
  nextCursor: string;
} | null {
  if (!isRecord(payload) || !isApiSuccess(payload)) {
    return null;
  }
  const dataObj = isRecord(payload.data) ? payload.data : payload;
  const rawList = Array.isArray(dataObj.notes)
    ? dataObj.notes
    : Array.isArray(dataObj.items)
      ? dataObj.items
      : null;
  if (!rawList) {
    return null;
  }

  const items: UnknownRecord[] = [];
  for (const entry of rawList) {
    if (!isRecord(entry)) {
      continue;
    }
    const extracted = extractNoteIdAndRecord(entry);
    if (extracted) {
      noteCache.set(extracted.noteId, extracted.record);
      items.push(extracted.record);
    }
  }

  const hasMore =
    dataObj.has_more === true ||
    dataObj.hasMore === true ||
    dataObj.has_more === 1;
  const cursorRaw = dataObj.cursor;
  const nextCursor =
    typeof cursorRaw === 'string'
      ? cursorRaw.trim()
      : typeof cursorRaw === 'number' && Number.isFinite(cursorRaw)
        ? String(cursorRaw)
        : '';

  return { items, hasMore, nextCursor };
}

function handleInterceptedApiResponse(
  rawUrl: string,
  method: string,
  bodyText: string,
  payload: unknown,
): void {
  const parsedUrl = resolveRequestUrl(rawUrl);
  if (!parsedUrl) {
    return;
  }
  const pathname = parsedUrl.pathname;

  // 1. 登录态识别
  if (/\/api\/sns\/web\/v2\/user\/me(?:\/|$)/.test(pathname)) {
    if (isRecord(payload) && isApiSuccess(payload) && isRecord(payload.data)) {
      const account = extractAccountFromUserRecord(payload.data);
      if (account) {
        notifyLoginState(account);
      }
    }
    return;
  }

  // 2. 原生收藏
  if (/\/api\/sns\/web\/v1\/note\/collect(?:\/|$)/.test(pathname)) {
    if (method.toUpperCase() === 'POST' && isApiSuccess(payload)) {
      const bodyObj = parseRequestBodyJson(bodyText);
      const noteId =
        (bodyObj ? readFirstId(bodyObj, ['note_id', 'noteId']) : undefined) ??
        parsedUrl.searchParams.get('note_id')?.trim() ??
        extractNoteIdFromUrl(window.location.href) ??
        undefined;
      const rawData =
        (noteId ? noteCache.get(noteId) : undefined) ??
        (noteId ? buildFallbackRawNoteFromDom(noteId) : undefined) ??
        resolveActiveNote();

      if (rawData) {
        const msg: NativeCollectCapturedMessage = {
          channel: PAGE_BRIDGE_CHANNEL,
          direction: 'main-to-content',
          type: 'NATIVE_COLLECT_CAPTURED',
          platform: 'xiaohongshu',
          rawData,
          ...(noteId ? { sourceId: noteId } : {}),
        };
        postBridgeMessage(msg);
      }
    }
    return;
  }

  // 3. 原生取消收藏
  if (/\/api\/sns\/web\/v1\/note\/uncollect(?:\/|$)/.test(pathname)) {
    if (
      internalUncollectFetchInFlight === 0 &&
      method.toUpperCase() === 'POST' &&
      isApiSuccess(payload)
    ) {
      const bodyObj = parseRequestBodyJson(bodyText);
      const sourceIds: string[] = [];
      if (bodyObj) {
        const rawIds = bodyObj.note_ids ?? bodyObj.noteIds;
        if (Array.isArray(rawIds)) {
          for (const id of rawIds) {
            if (typeof id === 'string' && id.trim()) {
              sourceIds.push(id.trim());
            }
          }
        } else if (typeof rawIds === 'string' && rawIds.trim()) {
          sourceIds.push(
            ...rawIds
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean),
          );
        }
        const single = readFirstId(bodyObj, ['note_id', 'noteId']);
        if (single) {
          sourceIds.push(single);
        }
      }
      const queryNoteId = parsedUrl.searchParams.get('note_id')?.trim();
      if (queryNoteId) {
        sourceIds.push(queryNoteId);
      }

      const uniqueIds = Array.from(new Set(sourceIds));
      if (uniqueIds.length > 0) {
        const msg: NativeUncollectCapturedMessage = {
          channel: PAGE_BRIDGE_CHANNEL,
          direction: 'main-to-content',
          type: 'NATIVE_UNCOLLECT_CAPTURED',
          platform: 'xiaohongshu',
          sourceIds: uniqueIds,
        };
        postBridgeMessage(msg);
      }
    }
    return;
  }

  // 4. 评论列表响应旁路缓存
  if (/\/api\/sns\/web\/v2\/comment\/page(?:\/|$)/.test(pathname)) {
    if (internalCommentFetchInFlight === 0) {
      const noteId = parsedUrl.searchParams.get('note_id')?.trim();
      const page = extractCommentPageFromPayload(payload);
      if (noteId && page) {
        commentCache.mergePage(
          noteId,
          page.comments,
          page.nextCursor,
          page.hasMore,
        );
      }
    }
    return;
  }

  // 5. 被动旁路收藏列表捕获
  if (/\/api\/sns\/web\/v2\/note\/collect\/page(?:\/|$)/.test(pathname)) {
    const page = extractCollectionPageFromPayload(payload);
    if (page && internalSyncFetchInFlight === 0 && page.items.length > 0) {
      const msg: PassiveCollectionListCapturedMessage = {
        channel: PAGE_BRIDGE_CHANNEL,
        direction: 'main-to-content',
        type: 'PASSIVE_COLLECTION_LIST_CAPTURED',
        platform: 'xiaohongshu',
        rawItems: page.items,
        hasMore: page.hasMore,
      };
      postBridgeMessage(msg);
    }
    return;
  }

  // 6. 其他小红书 Feed / 详情接口通用收割
  harvestNoteObjects(payload);
}

function sleepAbortable(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(new DOMException('Aborted', 'AbortError'));
  }
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function fetchCommentsForNote(
  noteId: string,
  limit = DEFAULT_COMMENT_LIMIT,
): Promise<{ rawComments: UnknownRecord[]; error?: string }> {
  const trimmedId = noteId.trim();
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
      const cid = readFirstId(item, ['id', 'comment_id', 'commentId']);
      if (cid) {
        if (seenIds.has(cid)) {
          continue;
        }
        seenIds.add(cid);
      }
      collected.push(item);
    }
  };

  let cursor = '';
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
  const xsecToken = memoryXsecTokens.get(trimmedId);

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

    const params = new URLSearchParams({
      note_id: trimmedId,
      cursor,
      top_comment_id: '',
      image_formats: 'jpg,webp,avif',
    });
    if (xsecToken) {
      params.set('xsec_token', xsecToken);
    }
    const endpoint = `/api/sns/web/v2/comment/page?${params.toString()}`;

    let parsedJson: unknown;
    internalCommentFetchInFlight += 1;
    try {
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
      internalCommentFetchInFlight = Math.max(
        0,
        internalCommentFetchInFlight - 1,
      );
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
      !page.nextCursor ||
      page.nextCursor === cursor
    ) {
      hasMore = false;
      break;
    }
    cursor = page.nextCursor;
  }

  return { rawComments: collected };
}

async function runFullCollectionSync(syncId: string): Promise<void> {
  activeSyncAbortController?.abort();
  const controller = new AbortController();
  activeSyncId = syncId;
  activeSyncAbortController = controller;

  const accountId = detectedAccount?.accountId;
  const fallbackUrl = accountId
    ? `https://www.xiaohongshu.com/user/profile/${encodeURIComponent(accountId)}?tab=collect`
    : 'https://www.xiaohongshu.com/';

  const emitDone = (
    status: CollectionSyncDoneMessage['status'],
    totalFetched: number,
    error?: string,
  ): void => {
    if (activeSyncId === syncId) {
      activeSyncId = null;
      activeSyncAbortController = null;
    }
    const msg: CollectionSyncDoneMessage = {
      channel: PAGE_BRIDGE_CHANNEL,
      direction: 'main-to-content',
      type: 'COLLECTION_SYNC_DONE',
      syncId,
      platform: 'xiaohongshu',
      totalFetched,
      status,
      ...(error !== undefined ? { error } : {}),
      ...(status === 'fallback_needed' ? { fallbackUrl } : {}),
    };
    postBridgeMessage(msg);
  };

  if (!accountId) {
    emitDone('fallback_needed', 0, '尚未识别当前登录账号 ID，请前往「我的收藏」页被动同步。');
    return;
  }

  let cursor = '';
  let totalFetched = 0;

  try {
    for (let pageIndex = 0; pageIndex < MAX_FULL_SYNC_PAGES; pageIndex += 1) {
      if (controller.signal.aborted || activeSyncId !== syncId) {
        emitDone('cancelled', totalFetched);
        return;
      }

      if (pageIndex > 0) {
        const delayMs =
          FULL_SYNC_MIN_DELAY_MS +
          Math.floor(Math.random() * FULL_SYNC_JITTER_MS);
        await sleepAbortable(delayMs, controller.signal);
      }

      const params = new URLSearchParams({
        num: String(FULL_SYNC_PAGE_SIZE),
        cursor,
        user_id: accountId,
        image_formats: 'jpg,webp,avif',
      });
      const endpoint = `/api/sns/web/v2/note/collect/page?${params.toString()}`;

      let parsedJson: unknown;
      internalSyncFetchInFlight += 1;
      try {
        const response = await window.fetch(endpoint, {
          method: 'GET',
          credentials: 'include',
          signal: controller.signal,
        });

        if (
          response.status === 403 ||
          response.status === 406 ||
          response.status === 429 ||
          response.status === 461
        ) {
          emitDone(
            'fallback_needed',
            totalFetched,
            `小红书收藏列表主动分页触发风控限制（HTTP ${response.status}），已切换为被动旁路模式。`,
          );
          return;
        }

        if (!response.ok) {
          emitDone(
            'fallback_needed',
            totalFetched,
            `收藏列表接口返回 HTTP ${response.status}，请前往「我的收藏」页滚动被动同步。`,
          );
          return;
        }

        const text = await response.text();
        parsedJson = text ? JSON.parse(text) : null;
      } finally {
        internalSyncFetchInFlight = Math.max(0, internalSyncFetchInFlight - 1);
      }

      const page = extractCollectionPageFromPayload(parsedJson);
      if (!page) {
        emitDone(
          'fallback_needed',
          totalFetched,
          '收藏列表响应需要签名验证，已切换为被动旁路模式。',
        );
        return;
      }

      totalFetched += page.items.length;
      if (page.items.length > 0) {
        const batchMsg: CollectionSyncBatchMessage = {
          channel: PAGE_BRIDGE_CHANNEL,
          direction: 'main-to-content',
          type: 'COLLECTION_SYNC_BATCH',
          syncId,
          platform: 'xiaohongshu',
          rawItems: page.items,
          pageIndex,
          hasMore: page.hasMore,
        };
        postBridgeMessage(batchMsg);
      }

      if (
        !page.hasMore ||
        page.items.length === 0 ||
        !page.nextCursor ||
        page.nextCursor === cursor
      ) {
        emitDone('completed', totalFetched);
        return;
      }
      cursor = page.nextCursor;
    }

    emitDone('completed', totalFetched);
  } catch (error) {
    if (
      controller.signal.aborted ||
      (error instanceof DOMException && error.name === 'AbortError')
    ) {
      emitDone('cancelled', totalFetched);
      return;
    }
    emitDone(
      'error',
      totalFetched,
      error instanceof Error ? error.message : String(error),
    );
  }
}

function patchFetch(): void {
  const originalFetch = window.fetch;
  if (typeof originalFetch !== 'function') {
    return;
  }

  window.fetch = function patchedFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const rawUrl =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const method =
      init?.method ??
      (typeof input === 'object' && !(input instanceof URL)
        ? input.method
        : 'GET') ??
      'GET';
    const isApi = isXhsApiUrl(rawUrl);
    const bodyText = isApi ? extractBodyTextFromFetchInit(init) : '';

    const promise = originalFetch.call(this, input, init);
    if (!isApi) {
      return promise;
    }

    promise
      .then((response) => {
        if (!response || response.status < 200 || response.status >= 300) {
          return;
        }
        const cloned = response.clone();
        return cloned
          .text()
          .then((text) => {
            if (!text) {
              return;
            }
            const parsed: unknown = JSON.parse(text);
            handleInterceptedApiResponse(rawUrl, method, bodyText, parsed);
          })
          .catch(() => undefined);
      })
      .catch(() => undefined);

    return promise;
  };
}

function patchXmlHttpRequest(): void {
  const XhrProto = XMLHttpRequest.prototype;
  const originalOpen = XhrProto.open;
  const originalSend = XhrProto.send;
  const metaMap = new WeakMap<XMLHttpRequest, XhrMeta>();

  XhrProto.open = function patchedOpen(
    this: XMLHttpRequest,
    method: string,
    url: string | URL,
    async?: boolean,
    username?: string | null,
    password?: string | null,
  ): void {
    const rawUrl = typeof url === 'string' ? url : url.href;
    metaMap.set(this, {
      method: method || 'GET',
      url: rawUrl,
      isApi: isXhsApiUrl(rawUrl),
      bodyText: '',
    });
    originalOpen.call(
      this,
      method,
      url,
      async ?? true,
      username ?? undefined,
      password ?? undefined,
    );
  };

  XhrProto.send = function patchedSend(
    this: XMLHttpRequest,
    body?: Document | XMLHttpRequestBodyInit | null,
  ): void {
    const meta = metaMap.get(this);
    if (meta?.isApi) {
      if (typeof body === 'string') {
        meta.bodyText = body;
      } else if (body instanceof URLSearchParams) {
        meta.bodyText = body.toString();
      }

      this.addEventListener(
        'load',
        () => {
          try {
            if (this.status < 200 || this.status >= 300) {
              return;
            }
            let parsed: unknown;
            if (this.responseType === '' || this.responseType === 'text') {
              if (!this.responseText) {
                return;
              }
              parsed = JSON.parse(this.responseText);
            } else if (this.responseType === 'json') {
              parsed = this.response;
            } else {
              return;
            }
            handleInterceptedApiResponse(
              meta.url,
              meta.method,
              meta.bodyText,
              parsed,
            );
          } catch {
            // 静默忽略非 JSON 响应
          }
        },
        { once: true },
      );
    }

    originalSend.call(this, body ?? null);
  };
}

function handleBridgeRequest(message: PageBridgeMessage): void {
  if (message.direction !== 'content-to-main') {
    return;
  }

  switch (message.type) {
    case 'REQUEST_CURRENT_ITEM': {
      const req: RequestCurrentItemMessage = message;
      const rawData = resolveActiveNote();
      const response: CurrentItemResponseMessage = {
        channel: PAGE_BRIDGE_CHANNEL,
        direction: 'main-to-content',
        type: 'CURRENT_ITEM_RESPONSE',
        requestId: req.requestId,
        platform: 'xiaohongshu',
        rawData,
        triggerSource: req.triggerSource,
        ...(rawData === null
          ? { error: '未在当前页面检测到可采集的小红书笔记，请打开具体笔记详情后重试。' }
          : {}),
      };
      postBridgeMessage(response);
      break;
    }

    case 'REQUEST_LOGIN_STATE': {
      harvestInitialState();
      if (detectedAccount) {
        notifyLoginState(detectedAccount, true);
      }
      break;
    }

    case 'REQUEST_FULL_COLLECTION_SYNC': {
      void runFullCollectionSync(message.syncId);
      break;
    }

    case 'CANCEL_FULL_COLLECTION_SYNC': {
      if (activeSyncId === message.syncId) {
        activeSyncAbortController?.abort();
      }
      break;
    }

    case 'REQUEST_ITEM_COMMENTS': {
      const req: RequestItemCommentsMessage = message;
      void fetchCommentsForNote(req.sourceId, req.limit).then((result) => {
        const response: ItemCommentsResponseMessage = {
          channel: PAGE_BRIDGE_CHANNEL,
          direction: 'main-to-content',
          type: 'ITEM_COMMENTS_RESPONSE',
          requestId: req.requestId,
          platform: 'xiaohongshu',
          sourceId: req.sourceId,
          rawComments: result.rawComments,
          ...(result.error !== undefined ? { error: result.error } : {}),
        };
        postBridgeMessage(response);
      });
      break;
    }

    case 'REQUEST_REMOTE_UNCOLLECT': {
      const req: RequestRemoteUncollectMessage = message;
      void runRemoteUncollectItems(req.items).then((results) => {
        const response: RemoteUncollectResponseMessage = {
          channel: PAGE_BRIDGE_CHANNEL,
          direction: 'main-to-content',
          type: 'REMOTE_UNCOLLECT_RESPONSE',
          requestId: req.requestId,
          platform: 'xiaohongshu',
          results,
        };
        postBridgeMessage(response);
      });
      break;
    }
  }
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
    const noteId = target.sourceId.trim();
    if (!noteId) {
      results.push({ sourceId: target.sourceId, ok: false, reason: '无效笔记 ID' });
      continue;
    }
    if (i > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, 300));
    }

    internalUncollectFetchInFlight += 1;
    try {
      const response = await window.fetch(
        'https://edith.xiaohongshu.com/api/sns/web/v1/note/uncollect',
        {
          method: 'POST',
          credentials: 'include',
          headers: {
            'content-type': 'application/json;charset=UTF-8',
          },
          body: JSON.stringify({ note_id: noteId }),
        },
      );
      if (
        response.status === 401 ||
        response.status === 403 ||
        response.status === 406 ||
        response.status === 461
      ) {
        results.push({
          sourceId: noteId,
          ok: false,
          reason: `小红书未登录或触发校验（HTTP ${response.status}）`,
        });
        continue;
      }
      if (!response.ok) {
        results.push({
          sourceId: noteId,
          ok: false,
          reason: `小红书接口返回 HTTP ${response.status}`,
        });
        continue;
      }
      const text = await response.text();
      if (text) {
        try {
          const parsed: unknown = JSON.parse(text);
          if (!isApiSuccess(parsed)) {
            results.push({
              sourceId: noteId,
              ok: false,
              reason: '小红书取消收藏未通过校验',
            });
            continue;
          }
        } catch {
          // 忽略非 JSON 响应
        }
      }
      results.push({ sourceId: noteId, ok: true });
    } catch (error) {
      results.push({
        sourceId: noteId,
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

/** 安装小红书 Main World 被动拦截器与桥接监听器（幂等） */
export function installXiaohongshuMainHook(): void {
  const globalObj = window as unknown as GlobalWithXhsHook;
  if (globalObj[INSTALL_LOCK_KEY]) {
    return;
  }
  globalObj[INSTALL_LOCK_KEY] = true;

  patchFetch();
  patchXmlHttpRequest();

  window.addEventListener('message', (event: MessageEvent<unknown>) => {
    if (event.source !== window) {
      return;
    }
    if (!isPageBridgeMessage(event.data)) {
      return;
    }
    handleBridgeRequest(event.data);
  });

  if (document.readyState === 'loading') {
    document.addEventListener(
      'DOMContentLoaded',
      () => {
        harvestInitialState();
      },
      { once: true },
    );
  } else {
    harvestInitialState();
  }

  const readyMessage: BridgeReadyMessage = {
    channel: PAGE_BRIDGE_CHANNEL,
    direction: 'main-to-content',
    type: 'BRIDGE_READY',
    platform: 'xiaohongshu',
  };
  postBridgeMessage(readyMessage);
}
