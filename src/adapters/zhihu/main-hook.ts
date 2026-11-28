/**
 * 知乎 Main World 独立被动拦截器与桥接模块。
 *
 * 运行于页面 `world: 'MAIN'` 上下文：
 * - 严禁引用任何 `chrome.*` API、Dexie 或 React 运行时；
 * - 仅通过 `window.postMessage` + `PAGE_BRIDGE_CHANNEL` 与 Isolated Content Script 通信；
 * - 旁路监听 `window.fetch` / `XMLHttpRequest` 并解析 SSR `<script id="js-initialData">`，
 *   支持问答回答、专栏文章、想法与知乎视频的采集、原生收藏/取消收藏、全量同步与评论抓取。
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

import {
  isRecord,
  postBridgeMessage,
  sleepAbortable,
  type UnknownRecord,
} from '../shared/main-bridge.ts';
type ZhihuEntityType = 'answer' | 'article' | 'pin' | 'zvideo';

const INSTALL_LOCK_KEY = Symbol.for('collect-plus:zhihu-main-hook-installed');
const LRU_CAPACITY = 200;
const COMMENT_CACHE_CAPACITY = 30;
const MAX_HARVEST_DEPTH = 7;
const MAX_HARVEST_NODES = 3000;
const DEFAULT_COMMENT_LIMIT = 100;
const MAX_COMMENT_FETCH_PAGES = 6;
const COMMENT_PAGE_MIN_DELAY_MS = 350;
const COMMENT_PAGE_JITTER_MS = 250;
const MAX_COLLECTIONS_TO_SYNC = 30;
const MAX_PAGES_PER_COLLECTION = 30;
const FULL_SYNC_MIN_DELAY_MS = 1400;
const FULL_SYNC_JITTER_MS = 600;
const ZHIHU_FALLBACK_COLLECTION_URL = 'https://www.zhihu.com/collections/mine';

const ZHIHU_API_MARKERS: readonly string[] = ['/api/v4/', '/api/v3/'];

interface GlobalWithZhihuHook {
  [INSTALL_LOCK_KEY]?: boolean;
}

interface DetectedAccount {
  accountId: string;
  urlToken?: string;
  accountName?: string;
}

interface CachedComments {
  comments: UnknownRecord[];
  seenIds: Set<string>;
  nextUrl: string | null;
  isEnd: boolean;
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

function normalizeEntityType(value: unknown): ZhihuEntityType | null {
  if (typeof value !== 'string') {
    return null;
  }
  const lower = value.trim().toLowerCase();
  if (lower === 'answer' || lower === 'answers') {
    return 'answer';
  }
  if (lower === 'article' || lower === 'articles' || lower === 'post') {
    return 'article';
  }
  if (lower === 'pin' || lower === 'pins') {
    return 'pin';
  }
  if (lower === 'zvideo' || lower === 'zvideos' || lower === 'video') {
    return 'zvideo';
  }
  return null;
}

function entityTypeToApiResource(type: ZhihuEntityType): string {
  switch (type) {
    case 'answer':
      return 'answers';
    case 'article':
      return 'articles';
    case 'pin':
      return 'pins';
    case 'zvideo':
      return 'zvideos';
  }
}

function buildCompositeKey(type: ZhihuEntityType, rawId: string): string {
  return `${type}_${rawId.trim()}`;
}

function parseCompositeKey(
  sourceId: string,
): { type: ZhihuEntityType; rawId: string } | null {
  const match = /^(answer|article|pin|zvideo)_(.+)$/.exec(sourceId.trim());
  if (!match?.[1] || !match[2]) {
    return null;
  }
  const type = normalizeEntityType(match[1]);
  if (!type) {
    return null;
  }
  return { type, rawId: match[2] };
}

function getEntityRichnessScore(record: UnknownRecord): number {
  let score = 0;
  if (typeof record.content === 'string' && record.content.length > 30) {
    score += 6;
  } else if (Array.isArray(record.content) && record.content.length > 0) {
    score += 5;
  }
  if (typeof record.excerpt === 'string' && record.excerpt.length > 0) {
    score += 1;
  }
  if (isRecord(record.video)) {
    score += 2;
    if (isRecord(record.video.playlist ?? record.video.playlist_v2)) {
      score += 5;
    }
  }
  if (isRecord(record.question) && typeof record.question.title === 'string') {
    score += 2;
  }
  if (typeof record.title === 'string' && record.title.length > 0) {
    score += 1;
  }
  if (isRecord(record.author) && typeof record.author.name === 'string') {
    score += 1;
  }
  return score;
}

class EntityLruCache {
  private readonly capacity: number;
  private readonly store = new Map<string, UnknownRecord>();

  constructor(capacity = LRU_CAPACITY) {
    this.capacity = Math.max(1, capacity);
  }

  set(type: ZhihuEntityType, rawId: string, record: UnknownRecord): void {
    const key = buildCompositeKey(type, rawId);
    const normalizedRecord: UnknownRecord = {
      ...record,
      type,
      id: rawId.trim(),
    };
    const existing = this.store.get(key);
    let valueToStore = normalizedRecord;
    if (existing) {
      this.store.delete(key);
      if (getEntityRichnessScore(existing) > getEntityRichnessScore(normalizedRecord)) {
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

  getByCompositeKey(key: string): UnknownRecord | undefined {
    const found = this.store.get(key);
    if (!found) {
      return undefined;
    }
    this.store.delete(key);
    this.store.set(key, found);
    return found;
  }

  get(type: ZhihuEntityType, rawId: string): UnknownRecord | undefined {
    return this.getByCompositeKey(buildCompositeKey(type, rawId));
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

  get(compositeKey: string): CachedComments | undefined {
    const found = this.store.get(compositeKey);
    if (!found) {
      return undefined;
    }
    this.store.delete(compositeKey);
    this.store.set(compositeKey, found);
    return found;
  }

  mergePage(
    compositeKey: string,
    comments: readonly UnknownRecord[],
    nextUrl: string | null,
    isEnd: boolean,
  ): CachedComments {
    const existing = this.store.get(compositeKey);
    const entry: CachedComments = existing ?? {
      comments: [],
      seenIds: new Set<string>(),
      nextUrl: null,
      isEnd: false,
    };

    for (const comment of comments) {
      if (entry.comments.length >= DEFAULT_COMMENT_LIMIT) {
        break;
      }
      const cid = readFirstId(comment, ['id', 'comment_id']);
      if (cid) {
        if (entry.seenIds.has(cid)) {
          continue;
        }
        entry.seenIds.add(cid);
      }
      entry.comments.push(comment);
    }

    entry.nextUrl = nextUrl;
    entry.isEnd = isEnd;

    if (existing) {
      this.store.delete(compositeKey);
    }
    this.store.set(compositeKey, entry);

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

const entityCache = new EntityLruCache(LRU_CAPACITY);
const commentCache = new CommentLruCache(COMMENT_CACHE_CAPACITY);

function extractHarvestableEntity(
  node: UnknownRecord,
): { type: ZhihuEntityType; rawId: string; record: UnknownRecord } | null {
  const type = normalizeEntityType(node.type);
  if (!type) {
    return null;
  }
  const rawId = readFirstId(node, ['id', 'token', 'zvideo_id', 'pin_id']);
  if (!rawId) {
    return null;
  }

  const hasSubstance =
    typeof node.content === 'string' ||
    Array.isArray(node.content) ||
    typeof node.excerpt === 'string' ||
    typeof node.title === 'string' ||
    isRecord(node.video) ||
    isRecord(node.question);
  if (!hasSubstance) {
    return null;
  }

  return { type, rawId, record: node };
}

function harvestEntities(payload: unknown): number {
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

    const found = extractHarvestableEntity(node);
    if (found) {
      entityCache.set(found.type, found.rawId, found.record);
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



function resolveRequestUrl(rawUrl: string): URL | null {
  try {
    return new URL(rawUrl, window.location.href);
  } catch {
    return null;
  }
}

function isZhihuApiUrl(rawUrl: string): boolean {
  const parsed = resolveRequestUrl(rawUrl);
  if (!parsed) {
    return false;
  }
  return ZHIHU_API_MARKERS.some((marker) => parsed.pathname.includes(marker));
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
    platform: 'zhihu',
    accountId: account.accountId,
    ...(account.accountName !== undefined
      ? { accountName: account.accountName }
      : {}),
  };
  postBridgeMessage(message);
}

function extractAccountFromMePayload(payload: unknown): DetectedAccount | null {
  if (!isRecord(payload)) {
    return null;
  }
  const urlToken = readString(payload, 'url_token') ?? readString(payload, 'urlToken');
  const rawId = readFirstId(payload, ['id', 'uid']);
  const accountId = rawId ?? urlToken;
  if (!accountId || accountId === '0') {
    return null;
  }
  const accountName = readString(payload, 'name');
  return {
    accountId,
    ...(urlToken !== undefined ? { urlToken } : {}),
    ...(accountName !== undefined ? { accountName } : {}),
  };
}

/** 解析知乎 SSR `<script id="js-initialData">` 归一化实体并补全 author / question 引用 */
function harvestInitialDataScript(): void {
  const scriptEl = document.getElementById('js-initialData');
  const rawText = scriptEl?.textContent?.trim();
  if (!rawText) {
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return;
  }
  if (!isRecord(parsed)) {
    return;
  }

  const initialState = isRecord(parsed.initialState)
    ? parsed.initialState
    : parsed;
  const entities = isRecord(initialState.entities)
    ? initialState.entities
    : null;

  if (entities) {
    const usersMap = isRecord(entities.users) ? entities.users : {};
    const questionsMap = isRecord(entities.questions) ? entities.questions : {};

    const resolveAuthor = (authorField: unknown): UnknownRecord | undefined => {
      if (isRecord(authorField)) {
        return authorField;
      }
      if (typeof authorField === 'string' && isRecord(usersMap[authorField])) {
        return usersMap[authorField];
      }
      return undefined;
    };

    const hydrateBucket = (
      bucketKey: 'answers' | 'articles' | 'pins' | 'zvideos',
      entityType: ZhihuEntityType,
    ): void => {
      const bucket = entities[bucketKey];
      if (!isRecord(bucket)) {
        return;
      }
      for (const [idKey, value] of Object.entries(bucket)) {
        if (!isRecord(value)) {
          continue;
        }
        const rawId = readFirstId(value, ['id', 'token']) ?? idKey.trim();
        if (!rawId) {
          continue;
        }
        const hydrated: UnknownRecord = { ...value, type: entityType, id: rawId };
        const resolvedAuthor = resolveAuthor(value.author);
        if (resolvedAuthor) {
          hydrated.author = resolvedAuthor;
        }
        if (entityType === 'answer') {
          const qVal = value.question;
          if (isRecord(qVal)) {
            const qid = readFirstId(qVal, ['id']);
            const fullQ = qid && isRecord(questionsMap[qid]) ? questionsMap[qid] : null;
            if (fullQ && !readString(qVal, 'title')) {
              hydrated.question = { ...fullQ, ...qVal };
            }
          } else if (
            (typeof qVal === 'string' || typeof qVal === 'number') &&
            isRecord(questionsMap[String(qVal)])
          ) {
            hydrated.question = questionsMap[String(qVal)];
          }
        }
        entityCache.set(entityType, rawId, hydrated);
      }
    };

    hydrateBucket('answers', 'answer');
    hydrateBucket('articles', 'article');
    hydrateBucket('pins', 'pin');
    hydrateBucket('zvideos', 'zvideo');

    // 登录态识别
    const currentUserToken =
      typeof initialState.currentUser === 'string'
        ? initialState.currentUser.trim()
        : '';
    if (currentUserToken && isRecord(usersMap[currentUserToken])) {
      const account = extractAccountFromMePayload(usersMap[currentUserToken]);
      if (account) {
        notifyLoginState(account);
      }
    }
  }
}

function parseActiveRefFromUrl(
  urlStr: string,
): { type: ZhihuEntityType; rawId: string; questionId?: string } | null {
  const parsed = resolveRequestUrl(urlStr);
  if (!parsed) {
    return null;
  }

  if (parsed.hostname === 'zhuanlan.zhihu.com') {
    const match = /^\/p\/(\d+)/.exec(parsed.pathname);
    if (match?.[1]) {
      return { type: 'article', rawId: match[1] };
    }
  }

  const qaMatch = /^\/question\/(\d+)\/answer\/(\d+)/.exec(parsed.pathname);
  if (qaMatch?.[1] && qaMatch[2]) {
    return { type: 'answer', rawId: qaMatch[2], questionId: qaMatch[1] };
  }

  const answerMatch = /^\/answer\/(\d+)/.exec(parsed.pathname);
  if (answerMatch?.[1]) {
    return { type: 'answer', rawId: answerMatch[1] };
  }

  const pinMatch = /^\/pin\/(\d+)/.exec(parsed.pathname);
  if (pinMatch?.[1]) {
    return { type: 'pin', rawId: pinMatch[1] };
  }

  const zvideoMatch = /^\/zvideo\/(\d+)/.exec(parsed.pathname);
  if (zvideoMatch?.[1]) {
    return { type: 'zvideo', rawId: zvideoMatch[1] };
  }

  return null;
}

function pickMostVisibleElement(selectors: string): Element | null {
  const elements = document.querySelectorAll(selectors);
  if (elements.length === 0) {
    return null;
  }
  const vh = window.innerHeight || 800;
  let bestEl: Element | null = null;
  let bestScore = -1;

  for (const el of elements) {
    const rect = el.getBoundingClientRect();
    const visibleTop = Math.max(0, rect.top);
    const visibleBottom = Math.min(vh, rect.bottom);
    const visibleHeight = Math.max(0, visibleBottom - visibleTop);
    if (visibleHeight > bestScore) {
      bestScore = visibleHeight;
      bestEl = el;
    }
  }
  return bestEl ?? elements[0] ?? null;
}

function parseDataZop(
  el: Element,
): { type: ZhihuEntityType; rawId: string; title?: string; authorName?: string } | null {
  const rawZop = el.getAttribute('data-zop');
  if (!rawZop) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(rawZop);
    if (!isRecord(parsed)) {
      return null;
    }
    const type = normalizeEntityType(parsed.type);
    const rawId = readFirstId(parsed, ['itemId', 'id']);
    if (!type || !rawId) {
      return null;
    }
    const title = readString(parsed, 'title');
    const authorName = readString(parsed, 'authorName');
    return {
      type,
      rawId,
      ...(title !== undefined ? { title } : {}),
      ...(authorName !== undefined ? { authorName } : {}),
    };
  } catch {
    return null;
  }
}

function buildFallbackEntityFromDom(
  ref: { type: ZhihuEntityType; rawId: string; questionId?: string },
  container?: Element | null,
): UnknownRecord | null {
  const root = container ?? document;
  const richTextEl =
    root.querySelector('.RichContent-inner .RichText, .Post-RichText, .RichText') ??
    document.querySelector('.Post-RichText, .RichContent-inner .RichText, .RichText');
  const contentHtml = richTextEl?.innerHTML?.trim() ?? '';

  const authorEl =
    root.querySelector('.AuthorInfo-name, .UserLink-link') ??
    document.querySelector('.AuthorInfo-name');
  const authorName = authorEl?.textContent?.trim() || '知乎用户';

  if (ref.type === 'article') {
    const titleEl =
      document.querySelector('.Post-Title, h1.Post-Title, h1') ??
      root.querySelector('h1, h2');
    const title = titleEl?.textContent?.trim() || document.title.replace(/\s*-\s*知乎$/, '').trim();
    if (!contentHtml && !title) {
      return null;
    }
    const headerImg = document.querySelector<HTMLImageElement>(
      '.TitleImage, .Post-Header img',
    );
    return {
      type: 'article',
      id: ref.rawId,
      title,
      content: contentHtml,
      author: { name: authorName },
      ...(headerImg?.src ? { title_image: headerImg.src } : {}),
    };
  }

  if (ref.type === 'answer') {
    const qTitleEl =
      document.querySelector('.QuestionHeader-title, h1.QuestionHeader-title') ??
      root.querySelector('.ContentItem-title');
    const qTitle =
      qTitleEl?.textContent?.trim() ||
      document.title.replace(/\s*-\s*知乎$/, '').trim();
    if (!contentHtml && !qTitle) {
      return null;
    }
    return {
      type: 'answer',
      id: ref.rawId,
      content: contentHtml,
      author: { name: authorName },
      question: {
        ...(ref.questionId ? { id: ref.questionId } : {}),
        title: qTitle,
      },
    };
  }

  if (ref.type === 'pin') {
    if (!contentHtml) {
      return null;
    }
    return {
      type: 'pin',
      id: ref.rawId,
      content_html: contentHtml,
      author: { name: authorName },
    };
  }

  return null;
}

function resolveActiveEntity(): UnknownRecord | null {
  harvestInitialDataScript();

  // 1. 优先 URL 精确匹配详情页
  const urlRef = parseActiveRefFromUrl(window.location.href);
  if (urlRef) {
    const cached = entityCache.get(urlRef.type, urlRef.rawId);
    if (cached) {
      return cached;
    }
    const domFallback = buildFallbackEntityFromDom(urlRef);
    if (domFallback) {
      return domFallback;
    }
  }

  // 2. 问题页 / 首页信息流：定位视口内最活跃的带 data-zop 内容卡片
  const activeCard = pickMostVisibleElement(
    '.AnswerItem[data-zop], .ArticleItem[data-zop], .ContentItem[data-zop]',
  );
  if (activeCard) {
    const zop = parseDataZop(activeCard);
    if (zop) {
      const cached = entityCache.get(zop.type, zop.rawId);
      if (cached) {
        return cached;
      }
      const qMatch = /^\/question\/(\d+)/.exec(window.location.pathname);
      const fallback = buildFallbackEntityFromDom(
        {
          type: zop.type,
          rawId: zop.rawId,
          ...(qMatch?.[1] ? { questionId: qMatch[1] } : {}),
        },
        activeCard,
      );
      if (fallback) {
        return fallback;
      }
    }
  }

  return entityCache.getLatest() ?? null;
}

function parseRequestBodyParams(bodyText: string): UnknownRecord | null {
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
  nextUrl: string | null;
  isEnd: boolean;
} | null {
  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    return null;
  }
  const comments: UnknownRecord[] = [];
  for (const item of payload.data) {
    if (isRecord(item)) {
      comments.push(item);
    }
  }

  const paging = isRecord(payload.paging) ? payload.paging : null;
  const isEnd = paging?.is_end === true || comments.length === 0;
  const nextRaw = paging ? readString(paging, 'next') : undefined;
  return {
    comments,
    nextUrl: !isEnd && nextRaw ? nextRaw : null,
    isEnd,
  };
}

function extractCollectionItemsFromPayload(payload: unknown): {
  items: UnknownRecord[];
  nextUrl: string | null;
  isEnd: boolean;
} | null {
  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    return null;
  }
  const items: UnknownRecord[] = [];
  for (const entry of payload.data) {
    if (!isRecord(entry)) {
      continue;
    }
    const contentObj = isRecord(entry.content) ? entry.content : entry;
    const extracted = extractHarvestableEntity(contentObj);
    if (extracted) {
      entityCache.set(extracted.type, extracted.rawId, extracted.record);
      items.push({ ...extracted.record, type: extracted.type, id: extracted.rawId });
    }
  }

  const paging = isRecord(payload.paging) ? payload.paging : null;
  const isEnd = paging?.is_end === true || items.length === 0;
  const nextRaw = paging ? readString(paging, 'next') : undefined;
  return {
    items,
    nextUrl: !isEnd && nextRaw ? nextRaw : null,
    isEnd,
  };
}

function resolveCollectTargetFromRequest(
  parsedUrl: URL,
  bodyText: string,
): { type: ZhihuEntityType; rawId: string } | null {
  const pathname = parsedUrl.pathname;

  // 1. /api/v4/collections/{cid}/contents/{content_id}?content_type=...
  const deletePathMatch =
    /\/api\/v4\/collections\/\d+\/contents\/(\d+)(?:\/|$)/.exec(pathname);
  if (deletePathMatch?.[1]) {
    const type =
      normalizeEntityType(parsedUrl.searchParams.get('content_type')) ??
      'answer';
    return { type, rawId: deletePathMatch[1] };
  }

  // 2. /api/v4/collections/{cid}/contents (POST body or query: content_id + content_type)
  if (/\/api\/v4\/collections\/\d+\/contents(?:\/|$)/.test(pathname)) {
    const bodyObj = parseRequestBodyParams(bodyText);
    const rawId =
      (bodyObj ? readFirstId(bodyObj, ['content_id', 'contentId']) : undefined) ??
      parsedUrl.searchParams.get('content_id')?.trim();
    const type =
      normalizeEntityType(
        (bodyObj ? bodyObj.content_type ?? bodyObj.contentType : undefined) ??
          parsedUrl.searchParams.get('content_type'),
      ) ?? 'answer';
    if (rawId) {
      return { type, rawId };
    }
  }

  // 3. /api/v4/{answers|articles|zvideos|pins}/{id}/collections
  const directMatch =
    /\/api\/v4\/(answers|articles|zvideos|pins)\/(\d+)\/collections(?:\/|$)/.exec(
      pathname,
    );
  if (directMatch?.[1] && directMatch[2]) {
    const type = normalizeEntityType(directMatch[1]);
    if (type) {
      return { type, rawId: directMatch[2] };
    }
  }

  return null;
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
  const upperMethod = method.toUpperCase();

  // 1. 当前登录用户
  if (/\/api\/v4\/me(?:\/|$)/.test(pathname)) {
    const account = extractAccountFromMePayload(payload);
    if (account) {
      notifyLoginState(account);
    }
    return;
  }

  // 2. 原生收藏（POST）与取消收藏（DELETE）
  const collectTarget =
    internalUncollectFetchInFlight === 0
      ? resolveCollectTargetFromRequest(parsedUrl, bodyText)
      : null;
  if (collectTarget) {
    const compositeId = buildCompositeKey(
      collectTarget.type,
      collectTarget.rawId,
    );
    if (upperMethod === 'POST') {
      const rawData =
        entityCache.get(collectTarget.type, collectTarget.rawId) ??
        buildFallbackEntityFromDom(collectTarget) ??
        resolveActiveEntity();
      if (rawData) {
        const msg: NativeCollectCapturedMessage = {
          channel: PAGE_BRIDGE_CHANNEL,
          direction: 'main-to-content',
          type: 'NATIVE_COLLECT_CAPTURED',
          platform: 'zhihu',
          rawData,
          sourceId: compositeId,
        };
        postBridgeMessage(msg);
      }
      return;
    }

    if (upperMethod === 'DELETE') {
      const msg: NativeUncollectCapturedMessage = {
        channel: PAGE_BRIDGE_CHANNEL,
        direction: 'main-to-content',
        type: 'NATIVE_UNCOLLECT_CAPTURED',
        platform: 'zhihu',
        sourceIds: [compositeId],
      };
      postBridgeMessage(msg);
      return;
    }
  }

  // 3. 评论响应旁路缓存
  const commentMatch =
    /\/api\/v4\/comment_v5\/(answers|articles|zvideos|pins)\/(\d+)\/root_comment(?:\/|$)/.exec(
      pathname,
    );
  if (commentMatch?.[1] && commentMatch[2]) {
    if (internalCommentFetchInFlight === 0) {
      const entityType = normalizeEntityType(commentMatch[1]);
      const page = extractCommentPageFromPayload(payload);
      if (entityType && page) {
        commentCache.mergePage(
          buildCompositeKey(entityType, commentMatch[2]),
          page.comments,
          page.nextUrl,
          page.isEnd,
        );
      }
    }
    return;
  }

  // 4. 被动旁路收藏夹内容捕获
  if (/\/api\/v4\/collections\/\d+\/items(?:\/|$)/.test(pathname)) {
    const page = extractCollectionItemsFromPayload(payload);
    if (page && internalSyncFetchInFlight === 0 && page.items.length > 0) {
      const msg: PassiveCollectionListCapturedMessage = {
        channel: PAGE_BRIDGE_CHANNEL,
        direction: 'main-to-content',
        type: 'PASSIVE_COLLECTION_LIST_CAPTURED',
        platform: 'zhihu',
        rawItems: page.items,
        hasMore: !page.isEnd,
      };
      postBridgeMessage(msg);
    }
    return;
  }

  // 5. 常规问答 / 专栏 / 想法 / 视频接口通用收割
  harvestEntities(payload);
}



function toSameOriginEndpoint(nextUrl: string): string {
  try {
    const parsed = new URL(nextUrl, window.location.origin);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return nextUrl;
  }
}

async function fetchCommentsForEntity(
  sourceId: string,
  limit = DEFAULT_COMMENT_LIMIT,
): Promise<{ rawComments: UnknownRecord[]; error?: string }> {
  const parsedRef = parseCompositeKey(sourceId);
  const safeLimit = Math.max(
    1,
    Math.min(DEFAULT_COMMENT_LIMIT, Math.floor(limit || DEFAULT_COMMENT_LIMIT)),
  );
  if (!parsedRef) {
    return { rawComments: [] };
  }

  const compositeKey = buildCompositeKey(parsedRef.type, parsedRef.rawId);
  const collected: UnknownRecord[] = [];
  const seenIds = new Set<string>();
  const appendUnique = (items: readonly UnknownRecord[]): void => {
    for (const item of items) {
      if (collected.length >= safeLimit) {
        break;
      }
      const cid = readFirstId(item, ['id', 'comment_id']);
      if (cid) {
        if (seenIds.has(cid)) {
          continue;
        }
        seenIds.add(cid);
      }
      collected.push(item);
    }
  };

  const resource = entityTypeToApiResource(parsedRef.type);
  let nextEndpoint: string | null =
    `/api/v4/comment_v5/${resource}/${encodeURIComponent(parsedRef.rawId)}/root_comment?order_by=score&limit=20&status=open`;
  let isEnd = false;

  const cached = commentCache.get(compositeKey);
  if (cached) {
    appendUnique(cached.comments);
    nextEndpoint = cached.nextUrl ? toSameOriginEndpoint(cached.nextUrl) : null;
    isEnd = cached.isEnd;
  }

  if (collected.length >= safeLimit || isEnd || !nextEndpoint) {
    return { rawComments: collected };
  }

  const controller = new AbortController();
  for (let pageIndex = 0; pageIndex < MAX_COMMENT_FETCH_PAGES; pageIndex += 1) {
    if (collected.length >= safeLimit || isEnd || !nextEndpoint) {
      break;
    }

    if (pageIndex > 0) {
      const delayMs =
        COMMENT_PAGE_MIN_DELAY_MS +
        Math.floor(Math.random() * COMMENT_PAGE_JITTER_MS);
      await sleepAbortable(delayMs, controller.signal);
    }

    let parsedJson: unknown;
    internalCommentFetchInFlight += 1;
    try {
      const response = await window.fetch(nextEndpoint, {
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
        return { rawComments: collected };
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
        error: '评论响应未通过校验，已安全中止后续分页。',
      };
    }

    commentCache.mergePage(compositeKey, page.comments, page.nextUrl, page.isEnd);
    appendUnique(page.comments);

    if (page.isEnd || !page.nextUrl || page.comments.length === 0) {
      isEnd = true;
      break;
    }
    const candidateNext = toSameOriginEndpoint(page.nextUrl);
    if (candidateNext === nextEndpoint) {
      break;
    }
    nextEndpoint = candidateNext;
  }

  return { rawComments: collected };
}

async function runFullCollectionSync(syncId: string): Promise<void> {
  activeSyncAbortController?.abort();
  const controller = new AbortController();
  activeSyncId = syncId;
  activeSyncAbortController = controller;

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
      platform: 'zhihu',
      totalFetched,
      status,
      ...(error !== undefined ? { error } : {}),
      ...(status === 'fallback_needed'
        ? { fallbackUrl: ZHIHU_FALLBACK_COLLECTION_URL }
        : {}),
    };
    postBridgeMessage(msg);
  };

  const urlToken = detectedAccount?.urlToken;
  if (!urlToken) {
    emitDone(
      'fallback_needed',
      0,
      '未获取知乎账号标识，请前往「我的收藏」页滚动浏览自动旁路同步。',
    );
    return;
  }

  let totalFetched = 0;
  let globalPageIndex = 0;

  try {
    // 1. 拉取用户的收藏夹列表
    let collectionsJson: unknown;
    internalSyncFetchInFlight += 1;
    try {
      const res = await window.fetch(
        `/api/v4/members/${encodeURIComponent(urlToken)}/collections?offset=0&limit=${MAX_COLLECTIONS_TO_SYNC}`,
        {
          method: 'GET',
          credentials: 'include',
          signal: controller.signal,
        },
      );
      if (res.status === 401 || res.status === 403 || res.status === 429) {
        emitDone(
          'fallback_needed',
          0,
          `知乎收藏夹接口触发风控限制（HTTP ${res.status}），已切换为被动旁路模式。`,
        );
        return;
      }
      if (!res.ok) {
        emitDone(
          'fallback_needed',
          0,
          `知乎收藏夹接口返回 HTTP ${res.status}，请前往「我的收藏」页被动同步。`,
        );
        return;
      }
      const text = await res.text();
      collectionsJson = text ? JSON.parse(text) : null;
    } finally {
      internalSyncFetchInFlight = Math.max(0, internalSyncFetchInFlight - 1);
    }

    if (!isRecord(collectionsJson) || !Array.isArray(collectionsJson.data)) {
      emitDone(
        'fallback_needed',
        0,
        '知乎收藏夹响应未通过校验，已切换为被动旁路模式。',
      );
      return;
    }

    const collectionIds: string[] = [];
    for (const col of collectionsJson.data) {
      if (isRecord(col)) {
        const cid = readFirstId(col, ['id']);
        if (cid) {
          collectionIds.push(cid);
        }
      }
    }

    // 2. 逐收藏夹分页拉取内容
    for (const cid of collectionIds) {
      let nextEndpoint: string | null =
        `/api/v4/collections/${encodeURIComponent(cid)}/items?offset=0&limit=20`;

      for (let p = 0; p < MAX_PAGES_PER_COLLECTION && nextEndpoint; p += 1) {
        if (controller.signal.aborted || activeSyncId !== syncId) {
          emitDone('cancelled', totalFetched);
          return;
        }

        if (globalPageIndex > 0) {
          const delayMs =
            FULL_SYNC_MIN_DELAY_MS +
            Math.floor(Math.random() * FULL_SYNC_JITTER_MS);
          await sleepAbortable(delayMs, controller.signal);
        }

        let itemsJson: unknown;
        internalSyncFetchInFlight += 1;
        try {
          const res = await window.fetch(nextEndpoint, {
            method: 'GET',
            credentials: 'include',
            signal: controller.signal,
          });
          if (res.status === 401 || res.status === 403 || res.status === 429) {
            emitDone(
              'fallback_needed',
              totalFetched,
              `知乎收藏内容分页触发风控（HTTP ${res.status}），已切换为被动旁路模式。`,
            );
            return;
          }
          if (!res.ok) {
            emitDone(
              'fallback_needed',
              totalFetched,
              `收藏夹内容返回 HTTP ${res.status}，请前往「我的收藏」页被动同步。`,
            );
            return;
          }
          const text = await res.text();
          itemsJson = text ? JSON.parse(text) : null;
        } finally {
          internalSyncFetchInFlight = Math.max(0, internalSyncFetchInFlight - 1);
        }

        const page = extractCollectionItemsFromPayload(itemsJson);
        if (!page) {
          emitDone(
            'fallback_needed',
            totalFetched,
            '收藏夹内容响应未通过校验，已切换为被动旁路模式。',
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
            platform: 'zhihu',
            rawItems: page.items,
            pageIndex: globalPageIndex,
            hasMore: !page.isEnd,
          };
          postBridgeMessage(batchMsg);
        }
        globalPageIndex += 1;

        if (page.isEnd || !page.nextUrl || page.items.length === 0) {
          break;
        }
        const candidateNext = toSameOriginEndpoint(page.nextUrl);
        if (candidateNext === nextEndpoint) {
          break;
        }
        nextEndpoint = candidateNext;
      }
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
    const isApi = isZhihuApiUrl(rawUrl);
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
        // DELETE 取消收藏可能返回 204 无响应体
        if (response.status === 204) {
          handleInterceptedApiResponse(rawUrl, method, bodyText, null);
          return;
        }
        const cloned = response.clone();
        return cloned
          .text()
          .then((text) => {
            const parsed: unknown = text ? JSON.parse(text) : null;
            handleInterceptedApiResponse(rawUrl, method, bodyText, parsed);
          })
          .catch(() => {
            if (method.toUpperCase() === 'DELETE') {
              handleInterceptedApiResponse(rawUrl, method, bodyText, null);
            }
          });
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
      isApi: isZhihuApiUrl(rawUrl),
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
            if (this.status === 204) {
              handleInterceptedApiResponse(
                meta.url,
                meta.method,
                meta.bodyText,
                null,
              );
              return;
            }
            let parsed: unknown = null;
            if (this.responseType === '' || this.responseType === 'text') {
              if (this.responseText) {
                parsed = JSON.parse(this.responseText);
              }
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
      const rawData = resolveActiveEntity();
      const response: CurrentItemResponseMessage = {
        channel: PAGE_BRIDGE_CHANNEL,
        direction: 'main-to-content',
        type: 'CURRENT_ITEM_RESPONSE',
        requestId: req.requestId,
        platform: 'zhihu',
        rawData,
        triggerSource: req.triggerSource,
        ...(rawData === null
          ? { error: '未在当前页面检测到可采集的知乎回答、文章、想法或视频。' }
          : {}),
      };
      postBridgeMessage(response);
      break;
    }

    case 'REQUEST_LOGIN_STATE': {
      harvestInitialDataScript();
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
      void fetchCommentsForEntity(req.sourceId, req.limit).then((result) => {
        const response: ItemCommentsResponseMessage = {
          channel: PAGE_BRIDGE_CHANNEL,
          direction: 'main-to-content',
          type: 'ITEM_COMMENTS_RESPONSE',
          requestId: req.requestId,
          platform: 'zhihu',
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
          platform: 'zhihu',
          results,
        };
        postBridgeMessage(response);
      });
      break;
    }
  }
}

function readCookieValue(name: string): string | undefined {
  try {
    const rawCookie = document.cookie || '';
    for (const part of rawCookie.split(';')) {
      const idx = part.indexOf('=');
      if (idx === -1) {
        continue;
      }
      if (part.slice(0, idx).trim() === name) {
        const val = part.slice(idx + 1).trim();
        return val ? decodeURIComponent(val) : undefined;
      }
    }
  } catch {
    // 忽略 Cookie 读取异常
  }
  return undefined;
}

async function runRemoteUncollectItems(
  items: readonly RemoteUncollectTargetInput[],
): Promise<RemoteUncollectTargetOutcome[]> {
  const xsrf = readCookieValue('_xsrf');
  const results: RemoteUncollectTargetOutcome[] = [];

  for (let i = 0; i < items.length; i += 1) {
    const target = items[i];
    if (!target) {
      continue;
    }
    const parsedRef = parseCompositeKey(target.sourceId);
    if (!parsedRef) {
      results.push({
        sourceId: target.sourceId,
        ok: false,
        reason: '无效知乎内容标识',
      });
      continue;
    }
    if (i > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, 280));
    }

    internalUncollectFetchInFlight += 1;
    try {
      const listUrl = `/api/v4/favlists?include=data[*].is_favorited&content_id=${encodeURIComponent(parsedRef.rawId)}&content_type=${encodeURIComponent(parsedRef.type)}`;
      const listRes = await window.fetch(listUrl, {
        method: 'GET',
        credentials: 'include',
      });
      if (listRes.status === 401 || listRes.status === 403) {
        results.push({
          sourceId: target.sourceId,
          ok: false,
          reason: `知乎未登录或触发校验（HTTP ${listRes.status}）`,
        });
        continue;
      }
      if (!listRes.ok) {
        results.push({
          sourceId: target.sourceId,
          ok: false,
          reason: `无法查询知乎收藏夹状态（HTTP ${listRes.status}）`,
        });
        continue;
      }

      const listText = await listRes.text();
      const listJson: unknown = listText ? JSON.parse(listText) : null;
      const favIds: string[] = [];
      if (isRecord(listJson) && Array.isArray(listJson.data)) {
        for (const entry of listJson.data) {
          if (isRecord(entry) && entry.is_favorited === true) {
            const cid = readFirstId(entry, ['id']);
            if (cid) {
              favIds.push(cid);
            }
          }
        }
      }

      if (favIds.length === 0) {
        results.push({ sourceId: target.sourceId, ok: true });
        continue;
      }

      let allOk = true;
      let firstError: string | undefined;
      for (const cid of favIds) {
        const delRes = await window.fetch(
          `/api/v4/collections/${encodeURIComponent(cid)}/contents/${encodeURIComponent(parsedRef.rawId)}?content_type=${encodeURIComponent(parsedRef.type)}`,
          {
            method: 'DELETE',
            credentials: 'include',
            headers: {
              ...(xsrf ? { 'x-xsrftoken': xsrf } : {}),
            },
          },
        );
        if (!delRes.ok) {
          allOk = false;
          if (!firstError) {
            firstError = `知乎取消收藏返回 HTTP ${delRes.status}`;
          }
        }
      }
      results.push({
        sourceId: target.sourceId,
        ok: allOk,
        ...(firstError !== undefined ? { reason: firstError } : {}),
      });
    } catch (error) {
      results.push({
        sourceId: target.sourceId,
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

/** 安装知乎 Main World 被动拦截器与桥接监听器（幂等） */
export function installZhihuMainHook(): void {
  const globalObj = window as unknown as GlobalWithZhihuHook;
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
        harvestInitialDataScript();
      },
      { once: true },
    );
  } else {
    harvestInitialDataScript();
  }

  const readyMessage: BridgeReadyMessage = {
    channel: PAGE_BRIDGE_CHANNEL,
    direction: 'main-to-content',
    type: 'BRIDGE_READY',
    platform: 'zhihu',
  };
  postBridgeMessage(readyMessage);
}
