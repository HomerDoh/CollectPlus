/**
 * 小红书平台独立适配器与原始笔记 / 评论数据归一化解析器。
 *
 * 严格零 `any`：全部字段通过 `unknown` 与运行时类型守卫安全读取，
 * 兼容 Web API（snake_case）与 `__INITIAL_STATE__`（camelCase）结构差异，
 * 与其他平台插件完全解耦。
 */

import type {
  CapturedAssetInput,
  CapturedCommentInput,
  CapturedPayload,
  CaptureTriggerSource,
  DnrHeaderRuleSpec,
  PlatformAdapter,
} from '../../types/adapter.ts';
import type { AuthorInfo, PlatformExtraValue } from '../../types/schema.ts';

type UnknownRecord = Record<string, unknown>;

const XHS_REFERER = 'https://www.xiaohongshu.com/';
const XHS_ORIGIN = 'https://www.xiaohongshu.com';

const XHS_HOST_PATTERNS: readonly string[] = [
  'https://www.xiaohongshu.com/*',
  'https://xiaohongshu.com/*',
];

const XHS_DNR_RULES: readonly DnrHeaderRuleSpec[] = [
  {
    idOffset: 1,
    urlFilter: '||xhscdn.com/',
    referer: XHS_REFERER,
    origin: XHS_ORIGIN,
  },
  {
    idOffset: 2,
    urlFilter: '||xhscdn.net/',
    referer: XHS_REFERER,
    origin: XHS_ORIGIN,
  },
];

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

function readFirstString(
  record: UnknownRecord,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = readString(record, key);
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

function readFirstIdString(
  record: UnknownRecord,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = readIdString(record, key);
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

function readNumber(record: UnknownRecord, key: string): number | undefined {
  const value = record[key];
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim().replace(/,/g, '');
    if (!trimmed) {
      return undefined;
    }
    const wanMatch = /^(\d+(?:\.\d+)?)\s*(?:万|w|W)\+?$/.exec(trimmed);
    if (wanMatch?.[1]) {
      const base = Number(wanMatch[1]);
      if (Number.isFinite(base)) {
        return Math.round(base * 10_000);
      }
    }
    const cleaned = trimmed.replace(/\+$/, '');
    const parsed = Number(cleaned);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function readFirstNumber(
  record: UnknownRecord,
  keys: readonly string[],
): number | undefined {
  for (const key of keys) {
    const value = readNumber(record, key);
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

function readPositiveInt(
  record: UnknownRecord,
  keys: readonly string[],
): number | undefined {
  const value = readFirstNumber(record, keys);
  if (value !== undefined && value > 0) {
    return Math.round(value);
  }
  return undefined;
}

function readRecord(
  record: UnknownRecord,
  keys: readonly string[],
): UnknownRecord | undefined {
  for (const key of keys) {
    const value = record[key];
    if (isRecord(value)) {
      return value;
    }
  }
  return undefined;
}

function readArray(
  record: UnknownRecord,
  keys: readonly string[],
): readonly unknown[] | undefined {
  for (const key of keys) {
    const value = record[key];
    if (Array.isArray(value)) {
      return value;
    }
  }
  return undefined;
}

function normalizeMediaUrl(rawUrl: string): string | null {
  let candidate = rawUrl.trim();
  if (!candidate) {
    return null;
  }

  if (candidate.startsWith('//')) {
    candidate = `https:${candidate}`;
  } else if (candidate.startsWith('http://')) {
    candidate = `https://${candidate.slice('http://'.length)}`;
  }

  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'https:') {
      return null;
    }
    return parsed.href;
  } catch {
    return null;
  }
}

function dedupeUrls(urls: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const url of urls) {
    if (!seen.has(url)) {
      seen.add(url);
      result.push(url);
    }
  }
  return result;
}

function getImageUrlPriority(url: string): number {
  let pathname = url.toLowerCase();
  let search = '';
  try {
    const parsed = new URL(url);
    pathname = parsed.pathname.toLowerCase();
    search = parsed.search.toLowerCase();
  } catch {
    // 兜底使用原始小写 URL
  }

  if (
    /\.(?:heic|heif)$/i.test(pathname) ||
    pathname.includes('.heic') ||
    /(?:^|[?&])format=heic(?:&|$)/i.test(search)
  ) {
    return 3;
  }
  if (/\.(?:jpe?g|png)$/i.test(pathname)) {
    return 0;
  }
  if (/\.(?:webp|gif)$/i.test(pathname) || pathname.includes('_webp')) {
    return 1;
  }
  return 2;
}

function rankImageUrls(urls: readonly string[]): string[] {
  const unique = dedupeUrls(urls);
  return unique
    .map((url, index) => ({
      url,
      index,
      priority: getImageUrlPriority(url),
    }))
    .sort((a, b) => a.priority - b.priority || a.index - b.index)
    .map((entry) => entry.url);
}

function inferImageMimeType(url: string): string {
  let pathname = url.toLowerCase();
  try {
    pathname = new URL(url).pathname.toLowerCase();
  } catch {
    // 兜底使用原始小写 URL
  }

  if (pathname.endsWith('.png') || pathname.includes('_png')) {
    return 'image/png';
  }
  if (pathname.endsWith('.webp') || pathname.includes('_webp')) {
    return 'image/webp';
  }
  if (pathname.endsWith('.gif')) {
    return 'image/gif';
  }
  if (pathname.endsWith('.heic') || pathname.endsWith('.heif')) {
    return 'image/heic';
  }
  return 'image/jpeg';
}

function extractImageEntryUrls(entry: UnknownRecord): string[] {
  const candidates: string[] = [];

  const appendRaw = (raw: string | undefined): void => {
    if (!raw) {
      return;
    }
    const normalized = normalizeMediaUrl(raw);
    if (normalized) {
      candidates.push(normalized);
    }
  };

  // 1. 优先原图 / 默认高清图
  appendRaw(readFirstString(entry, ['url_default', 'urlDefault']));

  // 2. info_list / infoList 中优先 WB_DFT（默认高清），其次 WB_PRV
  const infoList = readArray(entry, ['info_list', 'infoList']);
  if (infoList) {
    const dftUrls: string[] = [];
    const otherUrls: string[] = [];
    for (const item of infoList) {
      if (!isRecord(item)) {
        continue;
      }
      const url = readFirstString(item, ['url', 'src']);
      if (!url) {
        continue;
      }
      const scene = (
        readFirstString(item, ['image_scene', 'imageScene']) ?? ''
      ).toUpperCase();
      if (scene === 'WB_DFT' || scene === 'CRD_WM_WEBP') {
        dftUrls.push(url);
      } else {
        otherUrls.push(url);
      }
    }
    for (const url of [...dftUrls, ...otherUrls]) {
      appendRaw(url);
    }
  }

  // 3. 备选预览图与直链字段
  appendRaw(readFirstString(entry, ['url_pre', 'urlPre', 'url', 'src']));

  return rankImageUrls(candidates);
}

interface UnwrappedNote {
  noteId: string;
  note: UnknownRecord;
}

function unwrapNoteRecord(raw: unknown, depth = 0): UnwrappedNote | null {
  if (depth > 4 || !isRecord(raw)) {
    return null;
  }

  const outerId = readFirstIdString(raw, ['note_id', 'noteId', 'id']);
  const noteCard = readRecord(raw, ['note_card', 'noteCard', 'note']);
  if (noteCard) {
    const innerId =
      readFirstIdString(noteCard, ['note_id', 'noteId', 'id']) ?? outerId;
    if (innerId) {
      return { noteId: innerId, note: noteCard };
    }
  }

  const hasMediaOrText =
    readArray(raw, ['image_list', 'imageList']) !== undefined ||
    readRecord(raw, ['video']) !== undefined ||
    readRecord(raw, ['cover']) !== undefined ||
    readFirstString(raw, ['title', 'desc']) !== undefined;
  if (outerId && hasMediaOrText) {
    return { noteId: outerId, note: raw };
  }

  const items = readArray(raw, ['items', 'notes']);
  if (items && items.length > 0) {
    const found = unwrapNoteRecord(items[0], depth + 1);
    if (found) {
      return found;
    }
  }

  const nestedData = readRecord(raw, ['data']);
  if (nestedData) {
    const found = unwrapNoteRecord(nestedData, depth + 1);
    if (found) {
      return found;
    }
  }

  return null;
}

interface VideoStreamCandidate {
  urls: string[];
  codecRank: number; // 0 = h264, 1 = h265, 2 = av1 / other
  pixelArea: number;
  bitRate: number;
  width?: number;
  height?: number;
  durationSec?: number;
  sizeBytes?: number;
}

function collectStreamCandidates(
  streamList: readonly unknown[] | undefined,
  codecRank: number,
  out: VideoStreamCandidate[],
): void {
  if (!streamList) {
    return;
  }
  for (const item of streamList) {
    if (!isRecord(item)) {
      continue;
    }
    const rawUrls: string[] = [];
    const masterUrl = readFirstString(item, ['master_url', 'masterUrl', 'url']);
    if (masterUrl) {
      const normalized = normalizeMediaUrl(masterUrl);
      if (normalized) {
        rawUrls.push(normalized);
      }
    }
    const backupList = readArray(item, ['backup_urls', 'backupUrls']);
    if (backupList) {
      for (const entry of backupList) {
        if (typeof entry === 'string') {
          const normalized = normalizeMediaUrl(entry);
          if (normalized) {
            rawUrls.push(normalized);
          }
        }
      }
    }

    const urls = dedupeUrls(rawUrls);
    if (urls.length === 0) {
      continue;
    }

    const width = readPositiveInt(item, ['width']);
    const height = readPositiveInt(item, ['height']);
    const pixelArea =
      width !== undefined && height !== undefined ? width * height : 0;
    const bitRate =
      readFirstNumber(item, ['video_bitrate', 'videoBitrate', 'avg_bitrate', 'avgBitrate']) ??
      0;
    const rawDuration = readFirstNumber(item, ['duration']);
    const durationSec =
      rawDuration !== undefined && rawDuration > 0
        ? rawDuration > 1000
          ? Math.round((rawDuration / 1000) * 100) / 100
          : Math.round(rawDuration * 100) / 100
        : undefined;
    const rawSize = readFirstNumber(item, ['size', 'file_size', 'fileSize']);
    const sizeBytes =
      rawSize !== undefined && rawSize > 0 ? Math.round(rawSize) : undefined;

    out.push({
      urls,
      codecRank,
      pixelArea,
      bitRate,
      ...(width !== undefined ? { width } : {}),
      ...(height !== undefined ? { height } : {}),
      ...(durationSec !== undefined ? { durationSec } : {}),
      ...(sizeBytes !== undefined ? { sizeBytes } : {}),
    });
  }
}

function extractVideoAsset(note: UnknownRecord): CapturedAssetInput | null {
  const videoObj = readRecord(note, ['video']);
  if (!videoObj) {
    return null;
  }

  const mediaObj = readRecord(videoObj, ['media']);
  const streamObj = mediaObj ? readRecord(mediaObj, ['stream']) : undefined;
  const mediaVideoMeta = mediaObj ? readRecord(mediaObj, ['video']) : undefined;
  const capaObj = readRecord(videoObj, ['capa']);

  const capaDuration = capaObj
    ? readFirstNumber(capaObj, ['duration'])
    : undefined;
  const metaDuration = mediaVideoMeta
    ? readFirstNumber(mediaVideoMeta, ['duration'])
    : undefined;
  const fallbackDurationSec =
    capaDuration !== undefined && capaDuration > 0
      ? Math.round(capaDuration * 100) / 100
      : metaDuration !== undefined && metaDuration > 0
        ? metaDuration > 1000
          ? Math.round((metaDuration / 1000) * 100) / 100
          : Math.round(metaDuration * 100) / 100
        : undefined;

  const candidates: VideoStreamCandidate[] = [];
  if (streamObj) {
    collectStreamCandidates(readArray(streamObj, ['h264']), 0, candidates);
    collectStreamCandidates(readArray(streamObj, ['h265']), 1, candidates);
    collectStreamCandidates(readArray(streamObj, ['av1']), 2, candidates);
  }

  candidates.sort((a, b) => {
    if (a.codecRank !== b.codecRank) {
      return a.codecRank - b.codecRank;
    }
    if (a.pixelArea !== b.pixelArea) {
      return b.pixelArea - a.pixelArea;
    }
    return b.bitRate - a.bitRate;
  });

  const allUrls: string[] = [];
  for (const candidate of candidates) {
    allUrls.push(...candidate.urls);
  }

  // 兜底：consumer.origin_video_key 或 DOM 兜底直链
  const consumerObj = readRecord(videoObj, ['consumer']);
  const originKey = consumerObj
    ? readFirstString(consumerObj, ['origin_video_key', 'originVideoKey'])
    : undefined;
  if (originKey) {
    const cleanKey = originKey.replace(/^\/+/, '');
    const normalized = normalizeMediaUrl(
      `https://sns-video-bd.xhscdn.com/${cleanKey}`,
    );
    if (normalized) {
      allUrls.push(normalized);
    }
  }

  const directUrl = readFirstString(videoObj, ['url', 'playUrl', 'play_url']);
  if (directUrl) {
    const normalized = normalizeMediaUrl(directUrl);
    if (normalized) {
      allUrls.push(normalized);
    }
  }

  const mergedUrls = dedupeUrls(allUrls);
  const primaryUrl = mergedUrls[0];
  if (!primaryUrl) {
    return null;
  }

  const best = candidates[0];
  const width =
    best?.width ??
    (mediaVideoMeta ? readPositiveInt(mediaVideoMeta, ['width']) : undefined) ??
    readPositiveInt(videoObj, ['width']);
  const height =
    best?.height ??
    (mediaVideoMeta ? readPositiveInt(mediaVideoMeta, ['height']) : undefined) ??
    readPositiveInt(videoObj, ['height']);
  const durationSec = best?.durationSec ?? fallbackDurationSec;
  const sizeBytes =
    best && best.urls[0] === primaryUrl ? best.sizeBytes : undefined;
  const fallbackUrls = mergedUrls.slice(1);

  return {
    id: 'video',
    kind: 'video',
    strategy: primaryUrl.toLowerCase().includes('.m3u8') ? 'hls_mux' : 'direct',
    sourceUrl: primaryUrl,
    mimeType: 'video/mp4',
    ...(fallbackUrls.length > 0 ? { fallbackUrls } : {}),
    ...(width !== undefined ? { width } : {}),
    ...(height !== undefined ? { height } : {}),
    ...(durationSec !== undefined ? { durationSec } : {}),
    ...(sizeBytes !== undefined ? { sizeBytes } : {}),
  };
}

function extractImageAssets(note: UnknownRecord): CapturedAssetInput[] {
  const rawImages = readArray(note, ['image_list', 'imageList']);
  if (!rawImages || rawImages.length === 0) {
    return [];
  }

  const assets: CapturedAssetInput[] = [];
  let imageIndex = 0;

  for (const item of rawImages) {
    if (!isRecord(item)) {
      continue;
    }
    const rankedUrls = extractImageEntryUrls(item);
    const primaryUrl = rankedUrls[0];
    if (!primaryUrl) {
      continue;
    }

    imageIndex += 1;
    const width = readPositiveInt(item, ['width']);
    const height = readPositiveInt(item, ['height']);
    const fallbackUrls = rankedUrls.slice(1);

    assets.push({
      id: `img-${String(imageIndex).padStart(2, '0')}`,
      kind: 'image',
      strategy: 'direct',
      sourceUrl: primaryUrl,
      mimeType: inferImageMimeType(primaryUrl),
      ...(fallbackUrls.length > 0 ? { fallbackUrls } : {}),
      ...(width !== undefined ? { width } : {}),
      ...(height !== undefined ? { height } : {}),
    });
  }

  return assets;
}

function extractCoverUrls(
  note: UnknownRecord,
  imageAssets: readonly CapturedAssetInput[],
): { coverUrl?: string; coverFallbackUrls?: string[] } {
  const collected: string[] = [];

  const coverObj = readRecord(note, ['cover']);
  if (coverObj) {
    collected.push(...extractImageEntryUrls(coverObj));
  }

  const firstImage = imageAssets[0];
  if (firstImage) {
    collected.push(firstImage.sourceUrl, ...(firstImage.fallbackUrls ?? []));
  }

  const ranked = rankImageUrls(collected);
  const coverUrl = ranked[0];
  if (!coverUrl) {
    return {};
  }
  const coverFallbackUrls = ranked.slice(1);
  return {
    coverUrl,
    ...(coverFallbackUrls.length > 0 ? { coverFallbackUrls } : {}),
  };
}

function cleanXhsDesc(rawDesc: string): string {
  // 将小红书正文中的 `#标签[话题]#` 转为更易读的 `#标签`
  return rawDesc.replace(/#([^#\r\n[\]]+)\[话题\]#/g, '#$1').trim();
}

function buildTitleAndDescription(
  note: UnknownRecord,
  sourceId: string,
): { title: string; description: string } {
  const rawTitle =
    readFirstString(note, ['title', 'display_title', 'displayTitle']) ?? '';
  const rawDesc = readFirstString(note, ['desc', 'description']) ?? '';
  const description = cleanXhsDesc(rawDesc) || rawTitle;

  const titleCandidate = rawTitle || description;
  const singleLine = titleCandidate
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const strippedTitle = singleLine
    .replace(/(?:\s*#[^\s#@]+)+\s*$/g, '')
    .trim();

  const title = strippedTitle || singleLine || `小红书笔记_${sourceId}`;
  return { title, description };
}

function extractHashtags(note: UnknownRecord, rawDesc: string): string[] {
  const seen = new Set<string>();
  const hashtags: string[] = [];

  const pushTag = (rawTag: string): void => {
    const cleaned = rawTag
      .replace(/^#+/, '')
      .replace(/\[话题\]#?$/g, '')
      .trim();
    if (cleaned.length > 0 && !seen.has(cleaned)) {
      seen.add(cleaned);
      hashtags.push(cleaned);
    }
  };

  const tagList = readArray(note, ['tag_list', 'tagList']);
  if (tagList) {
    for (const item of tagList) {
      if (isRecord(item)) {
        const name = readFirstString(item, ['name', 'title']);
        if (name) {
          pushTag(name);
        }
      } else if (typeof item === 'string') {
        pushTag(item);
      }
    }
  }

  if (rawDesc) {
    const topicRegex = /#([^#\r\n[\]]+)\[话题\]#/g;
    let match = topicRegex.exec(rawDesc);
    while (match !== null) {
      if (match[1]) {
        pushTag(match[1]);
      }
      match = topicRegex.exec(rawDesc);
    }

    const hashRegex = /#([^\s#@[\]]+)/g;
    let hashMatch = hashRegex.exec(cleanXhsDesc(rawDesc));
    while (hashMatch !== null) {
      if (hashMatch[1]) {
        pushTag(hashMatch[1]);
      }
      hashMatch = hashRegex.exec(cleanXhsDesc(rawDesc));
    }
  }

  return hashtags;
}

function extractAuthorInfo(note: UnknownRecord): AuthorInfo {
  const userObj = readRecord(note, ['user', 'author']);
  if (!userObj) {
    return {
      id: 'unknown',
      name: '未知作者',
    };
  }

  const userId = readFirstIdString(userObj, ['user_id', 'userId', 'id']);
  const name =
    readFirstString(userObj, ['nickname', 'nick_name', 'nickName', 'name']) ??
    '未知作者';
  const rawAvatar = readFirstString(userObj, ['avatar', 'image', 'avatarUrl']);
  const avatarUrl = rawAvatar
    ? (normalizeMediaUrl(rawAvatar) ?? undefined)
    : undefined;
  const profileUrl = userId
    ? `https://www.xiaohongshu.com/user/profile/${encodeURIComponent(userId)}`
    : undefined;

  return {
    id: userId ?? 'unknown',
    name,
    ...(avatarUrl !== undefined ? { avatarUrl } : {}),
    ...(profileUrl !== undefined ? { profileUrl } : {}),
  };
}

function extractPublishedAt(note: UnknownRecord): number | undefined {
  const rawTime = readFirstNumber(note, [
    'time',
    'create_time',
    'createTime',
    'last_update_time',
    'lastUpdateTime',
  ]);
  if (rawTime === undefined || rawTime <= 0) {
    return undefined;
  }
  return rawTime >= 1_000_000_000_000
    ? Math.trunc(rawTime)
    : Math.trunc(rawTime * 1000);
}

function extractPlatformExtra(
  note: UnknownRecord,
): Record<string, PlatformExtraValue> | undefined {
  const extra: Record<string, PlatformExtraValue> = {};

  const interact = readRecord(note, ['interact_info', 'interactInfo']);
  if (interact) {
    const likedCount = readFirstNumber(interact, ['liked_count', 'likedCount']);
    if (likedCount !== undefined) {
      extra.likedCount = Math.trunc(likedCount);
    }
    const collectedCount = readFirstNumber(interact, [
      'collected_count',
      'collectedCount',
    ]);
    if (collectedCount !== undefined) {
      extra.collectedCount = Math.trunc(collectedCount);
    }
    const commentCount = readFirstNumber(interact, [
      'comment_count',
      'commentCount',
    ]);
    if (commentCount !== undefined) {
      extra.commentCount = Math.trunc(commentCount);
    }
    const shareCount = readFirstNumber(interact, ['share_count', 'shareCount']);
    if (shareCount !== undefined) {
      extra.shareCount = Math.trunc(shareCount);
    }
  }

  const noteType = readFirstString(note, ['type']);
  if (noteType) {
    extra.noteType = noteType;
  }

  const ipLocation = readFirstString(note, ['ip_location', 'ipLocation']);
  if (ipLocation) {
    extra.ipLocation = ipLocation;
  }

  return Object.keys(extra).length > 0 ? extra : undefined;
}

/**
 * 将小红书原始笔记对象归一化为跨平台统一采集载荷 `CapturedPayload`。
 */
export function parseXiaohongshuNote(
  raw: unknown,
  triggerSource: CaptureTriggerSource,
): CapturedPayload | null {
  const unwrapped = unwrapNoteRecord(raw);
  if (!unwrapped) {
    return null;
  }

  const { noteId, note } = unwrapped;
  const noteType = (readFirstString(note, ['type']) ?? '').toLowerCase();
  const videoAsset = extractVideoAsset(note);
  const imageAssets = extractImageAssets(note);
  const { coverUrl, coverFallbackUrls } = extractCoverUrls(note, imageAssets);

  let kind: CapturedPayload['kind'];
  let assets: CapturedAssetInput[];

  if (videoAsset && (noteType === 'video' || imageAssets.length === 0)) {
    kind = 'video';
    assets = [videoAsset];
  } else if (imageAssets.length > 0) {
    kind = imageAssets.length > 1 ? 'gallery' : 'image';
    assets = imageAssets;
  } else if (coverUrl) {
    // 列表摘要卡片可能仅有封面图，作为单图资产降级保存
    kind = 'image';
    assets = [
      {
        id: 'img-01',
        kind: 'image',
        strategy: 'direct',
        sourceUrl: coverUrl,
        mimeType: inferImageMimeType(coverUrl),
        ...(coverFallbackUrls && coverFallbackUrls.length > 0
          ? { fallbackUrls: coverFallbackUrls }
          : {}),
      },
    ];
  } else {
    return null;
  }

  const rawDesc = readFirstString(note, ['desc', 'description']) ?? '';
  const { title, description } = buildTitleAndDescription(note, noteId);
  const hashtags = extractHashtags(note, rawDesc);
  const author = extractAuthorInfo(note);
  const publishedAt = extractPublishedAt(note);
  const platformExtra = extractPlatformExtra(note);

  return {
    platform: 'xiaohongshu',
    sourceId: noteId,
    sourceUrl: `https://www.xiaohongshu.com/explore/${encodeURIComponent(noteId)}`,
    kind,
    title,
    description,
    author,
    hashtags,
    assets,
    triggerSource,
    ...(publishedAt !== undefined ? { publishedAt } : {}),
    ...(coverUrl !== undefined ? { coverUrl } : {}),
    ...(coverFallbackUrls !== undefined ? { coverFallbackUrls } : {}),
    ...(platformExtra !== undefined ? { platformExtra } : {}),
  };
}

/**
 * 将小红书 `/api/sns/web/v2/comment/page` 返回的原始评论数组归一化为标准 `CapturedCommentInput[]`。
 */
export function parseXiaohongshuComments(
  rawComments: readonly unknown[],
  limit = 100,
): CapturedCommentInput[] {
  const safeLimit =
    Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 100;
  const seenIds = new Set<string>();
  const normalized: CapturedCommentInput[] = [];

  for (let i = 0; i < rawComments.length; i += 1) {
    if (normalized.length >= safeLimit) {
      break;
    }
    const raw = rawComments[i];
    if (!isRecord(raw)) {
      continue;
    }

    const id =
      readFirstIdString(raw, ['id', 'comment_id', 'commentId']) ??
      `xhs-comment-${i + 1}`;
    if (seenIds.has(id)) {
      continue;
    }

    const rawText = readFirstString(raw, ['content', 'text']) ?? '';
    const hasPictures =
      (readArray(raw, ['pictures', 'image_list', 'imageList'])?.length ?? 0) >
      0;
    const content = rawText || (hasPictures ? '[图片评论]' : '');
    if (!content) {
      continue;
    }

    const userObj = readRecord(raw, ['user_info', 'userInfo', 'user']);
    const authorId = userObj
      ? readFirstIdString(userObj, ['user_id', 'userId', 'id'])
      : undefined;
    const authorName =
      (userObj
        ? readFirstString(userObj, ['nickname', 'nick_name', 'nickName', 'name'])
        : undefined) ?? '小红薯用户';
    const rawAvatar = userObj
      ? readFirstString(userObj, ['image', 'avatar', 'avatarUrl'])
      : undefined;
    const avatarUrl = rawAvatar
      ? (normalizeMediaUrl(rawAvatar) ?? undefined)
      : undefined;

    const rawLike = readFirstNumber(raw, ['like_count', 'likeCount']);
    const likeCount =
      rawLike !== undefined && rawLike > 0 ? Math.trunc(rawLike) : 0;

    const rawCreated = readFirstNumber(raw, ['create_time', 'createTime']);
    const createdAt =
      rawCreated !== undefined && rawCreated > 0
        ? rawCreated >= 1_000_000_000_000
          ? Math.trunc(rawCreated)
          : Math.trunc(rawCreated * 1000)
        : undefined;

    seenIds.add(id);
    normalized.push({
      id,
      ...(authorId !== undefined ? { authorId } : {}),
      authorName,
      ...(avatarUrl !== undefined ? { avatarUrl } : {}),
      content,
      likeCount,
      ...(createdAt !== undefined ? { createdAt } : {}),
    });
  }

  return normalized;
}

/** 校验给定 URL 是否属于小红书主站页面 */
export function matchesXiaohongshuUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === 'https:' &&
      (parsed.hostname === 'www.xiaohongshu.com' ||
        parsed.hostname === 'xiaohongshu.com')
    );
  } catch {
    return false;
  }
}

/** 小红书平台标准适配器实现 */
export const xiaohongshuAdapter: PlatformAdapter = {
  id: 'xiaohongshu',
  displayName: '小红书',
  hostPatterns: XHS_HOST_PATTERNS,
  matchesUrl: matchesXiaohongshuUrl,
  getDnrRules(): readonly DnrHeaderRuleSpec[] {
    return XHS_DNR_RULES;
  },
  normalizeRawData(
    raw: unknown,
    triggerSource: CaptureTriggerSource,
  ): CapturedPayload | null {
    return parseXiaohongshuNote(raw, triggerSource);
  },
};
