/**
 * 知乎平台独立适配器与多形态内容（回答 / 专栏文章 / 想法 / 视频）及评论归一化解析器。
 *
 * 严格零 `any`：全部字段经 `unknown` 与运行时类型守卫安全收窄；
 * 使用 `${type}_${rawId}` 作为跨形态防冲突 `sourceId`，与其他平台插件完全解耦。
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

export type ZhihuContentKind = 'answer' | 'article' | 'pin' | 'zvideo';

const ZHIHU_REFERER = 'https://www.zhihu.com/';
const ZHIHU_ORIGIN = 'https://www.zhihu.com';

const ZHIHU_HOST_PATTERNS: readonly string[] = [
  'https://www.zhihu.com/*',
  'https://zhihu.com/*',
  'https://zhuanlan.zhihu.com/*',
];

const ZHIHU_DNR_RULES: readonly DnrHeaderRuleSpec[] = [
  {
    idOffset: 1,
    urlFilter: '||zhimg.com/',
    referer: ZHIHU_REFERER,
    origin: ZHIHU_ORIGIN,
  },
  {
    idOffset: 2,
    urlFilter: '||vzuu.com/',
    referer: ZHIHU_REFERER,
    origin: ZHIHU_ORIGIN,
  },
  {
    idOffset: 3,
    urlFilter: '||lens.zhihu.com/',
    referer: ZHIHU_REFERER,
    origin: ZHIHU_ORIGIN,
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
    const trimmed = value.trim();
    if (!trimmed) {
      return undefined;
    }
    const parsed = Number(trimmed);
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
  if (!candidate || candidate.startsWith('data:')) {
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

function inferImageMimeType(url: string): string {
  let pathname = url.toLowerCase();
  try {
    pathname = new URL(url).pathname.toLowerCase();
  } catch {
    // 兜底使用原始小写 URL
  }
  if (pathname.endsWith('.png')) {
    return 'image/png';
  }
  if (pathname.endsWith('.webp')) {
    return 'image/webp';
  }
  if (pathname.endsWith('.gif')) {
    return 'image/gif';
  }
  return 'image/jpeg';
}

function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex: string) => {
      const cp = Number.parseInt(hex, 16);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff
        ? String.fromCodePoint(cp)
        : '';
    })
    .replace(/&#(\d+);/g, (_m, dec: string) => {
      const cp = Number.parseInt(dec, 10);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff
        ? String.fromCodePoint(cp)
        : '';
    });
}

/** 将知乎富文本 HTML 安全清洗为结构化分段纯文本 */
export function htmlToStructuredText(html: string): string {
  if (!html) {
    return '';
  }

  const withoutIgnored = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, '');

  const withBreaks = withoutIgnored
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|section|article|blockquote|pre|h[1-6]|tr)>/gi, '\n\n')
    .replace(/<li\b[^>]*>/gi, '• ')
    .replace(/<\/li>/gi, '\n')
    .replace(/<hr\s*\/?>/gi, '\n---\n');

  const stripped = decodeHtmlEntities(withBreaks.replace(/<[^>]+>/g, ''));

  return stripped
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function readAttrFromTag(tag: string, attrName: string): string | undefined {
  const regex = new RegExp(
    `(?:^|\\s)${attrName}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`,
    'i',
  );
  const match = regex.exec(tag);
  const value = match?.[1] ?? match?.[2] ?? match?.[3];
  return value ? decodeHtmlEntities(value).trim() : undefined;
}

/** 从知乎正文 HTML 中提取全部高清原图 URL（优先 data-original > data-actualsrc > src） */
function extractImageUrlsFromHtml(html: string): string[] {
  if (!html) {
    return [];
  }
  const urls: string[] = [];
  const imgTagRegex = /<img\b[^>]*>/gi;
  let match = imgTagRegex.exec(html);
  while (match !== null) {
    const tag = match[0];
    const candidates = [
      readAttrFromTag(tag, 'data-original'),
      readAttrFromTag(tag, 'data-actualsrc'),
      readAttrFromTag(tag, 'src'),
    ];
    for (const raw of candidates) {
      if (!raw) {
        continue;
      }
      const normalized = normalizeMediaUrl(raw);
      if (normalized) {
        urls.push(normalized);
        break;
      }
    }
    match = imgTagRegex.exec(html);
  }
  return dedupeUrls(urls);
}

function normalizeZhihuType(rawType: string | undefined): ZhihuContentKind | null {
  if (!rawType) {
    return null;
  }
  const lower = rawType.trim().toLowerCase();
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

function inferContentKind(record: UnknownRecord): ZhihuContentKind | null {
  const explicit = normalizeZhihuType(
    readFirstString(record, ['type', 'content_type', 'contentType', '__zhihuType']),
  );
  if (explicit) {
    return explicit;
  }
  if (isRecord(record.question)) {
    return 'answer';
  }
  if (isRecord(record.video) && isRecord(record.video.playlist ?? record.video.playlist_v2)) {
    return 'zvideo';
  }
  if (Array.isArray(record.content) && record.content.length > 0) {
    return 'pin';
  }
  if (readFirstString(record, ['title_image', 'titleImage', 'column']) !== undefined) {
    return 'article';
  }
  return null;
}

function unwrapZhihuRecord(
  raw: unknown,
  depth = 0,
): { kind: ZhihuContentKind; rawId: string; record: UnknownRecord } | null {
  if (depth > 4 || !isRecord(raw)) {
    return null;
  }

  // 兼容收藏夹项包裹层：{ content: { type: 'answer', id: ... } } 或 { target: { ... } }
  const wrapped = readRecord(raw, ['content', 'target', 'item', 'data']);
  if (wrapped) {
    const found = unwrapZhihuRecord(wrapped, depth + 1);
    if (found) {
      return found;
    }
  }

  const kind = inferContentKind(raw);
  const rawId = readFirstIdString(raw, ['id', 'token', 'zvideo_id', 'pin_id']);
  if (kind && rawId) {
    return { kind, rawId, record: raw };
  }

  return null;
}

function extractAuthorInfo(record: UnknownRecord): AuthorInfo {
  const authorObj = readRecord(record, ['author', 'creator']);
  if (!authorObj) {
    return {
      id: 'unknown',
      name: '知乎用户',
    };
  }

  const id =
    readFirstIdString(authorObj, ['id', 'url_token', 'urlToken']) ?? 'unknown';
  const name =
    readFirstString(authorObj, ['name', 'nickname']) ?? '知乎用户';
  const urlToken = readFirstString(authorObj, ['url_token', 'urlToken']);
  const rawAvatar = readFirstString(authorObj, [
    'avatar_url',
    'avatarUrl',
    'avatar',
  ]);
  const avatarUrl = rawAvatar
    ? (normalizeMediaUrl(rawAvatar) ?? undefined)
    : undefined;
  const profileUrl = urlToken
    ? `https://www.zhihu.com/people/${encodeURIComponent(urlToken)}`
    : undefined;

  return {
    id,
    name,
    ...(urlToken !== undefined ? { handle: urlToken } : {}),
    ...(avatarUrl !== undefined ? { avatarUrl } : {}),
    ...(profileUrl !== undefined ? { profileUrl } : {}),
  };
}

function extractPublishedAt(record: UnknownRecord): number | undefined {
  const rawTime = readFirstNumber(record, [
    'created_time',
    'createdTime',
    'created',
    'published_at',
    'publishedAt',
    'updated_time',
    'updatedTime',
  ]);
  if (rawTime === undefined || rawTime <= 0) {
    return undefined;
  }
  return rawTime >= 1_000_000_000_000
    ? Math.trunc(rawTime)
    : Math.trunc(rawTime * 1000);
}

function extractHashtags(record: UnknownRecord): string[] {
  const seen = new Set<string>();
  const tags: string[] = [];

  const pushTag = (raw: string): void => {
    const cleaned = raw.replace(/^#+/, '').trim();
    if (cleaned && !seen.has(cleaned)) {
      seen.add(cleaned);
      tags.push(cleaned);
    }
  };

  const topics = readArray(record, ['topics', 'tags']);
  if (topics) {
    for (const item of topics) {
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

  const questionObj = readRecord(record, ['question']);
  const questionTopics = questionObj
    ? readArray(questionObj, ['topics'])
    : undefined;
  if (questionTopics) {
    for (const item of questionTopics) {
      if (isRecord(item)) {
        const name = readFirstString(item, ['name', 'title']);
        if (name) {
          pushTag(name);
        }
      }
    }
  }

  return tags;
}

function buildImageAssetsFromUrls(urls: readonly string[]): CapturedAssetInput[] {
  return dedupeUrls(urls).map((url, idx) => ({
    id: `img-${String(idx + 1).padStart(2, '0')}`,
    kind: 'image',
    strategy: 'direct',
    sourceUrl: url,
    mimeType: inferImageMimeType(url),
  }));
}

interface ZVideoCandidate {
  url: string;
  qualityRank: number;
  pixelArea: number;
  isMp4: boolean;
  width?: number;
  height?: number;
  durationSec?: number;
}

function extractZVideoAsset(record: UnknownRecord): CapturedAssetInput | null {
  const videoObj = readRecord(record, ['video']) ?? record;
  const playlist =
    readRecord(videoObj, ['playlist', 'playlist_v2']) ??
    readRecord(record, ['playlist', 'playlist_v2']);

  const qualityOrder: readonly string[] = ['uhd', 'fhd', 'hd', 'ld', 'sd'];
  const candidates: ZVideoCandidate[] = [];

  if (playlist) {
    for (const [key, entry] of Object.entries(playlist)) {
      if (!isRecord(entry)) {
        continue;
      }
      const rawUrl = readFirstString(entry, ['play_url', 'playUrl', 'url']);
      if (!rawUrl) {
        continue;
      }
      const url = normalizeMediaUrl(rawUrl);
      if (!url) {
        continue;
      }
      const format = (readFirstString(entry, ['format']) ?? '').toLowerCase();
      const isMp4 = format === 'mp4' || !url.toLowerCase().includes('.m3u8');
      const idx = qualityOrder.indexOf(key.toLowerCase());
      const qualityRank = idx === -1 ? qualityOrder.length : idx;
      const width = readPositiveInt(entry, ['width']);
      const height = readPositiveInt(entry, ['height']);
      const pixelArea =
        width !== undefined && height !== undefined ? width * height : 0;
      const rawDuration =
        readFirstNumber(entry, ['duration']) ??
        readFirstNumber(videoObj, ['duration']);
      const durationSec =
        rawDuration !== undefined && rawDuration > 0
          ? Math.round(rawDuration * 100) / 100
          : undefined;

      candidates.push({
        url,
        qualityRank,
        pixelArea,
        isMp4,
        ...(width !== undefined ? { width } : {}),
        ...(height !== undefined ? { height } : {}),
        ...(durationSec !== undefined ? { durationSec } : {}),
      });
    }
  }

  // 兼容直接 play_url 兜底
  const directPlayUrl = readFirstString(videoObj, [
    'play_url',
    'playUrl',
    'video_play_url',
    'url',
  ]);
  if (directPlayUrl) {
    const normalized = normalizeMediaUrl(directPlayUrl);
    if (normalized) {
      candidates.push({
        url: normalized,
        qualityRank: qualityOrder.length + 1,
        pixelArea: 0,
        isMp4: !normalized.toLowerCase().includes('.m3u8'),
      });
    }
  }

  if (candidates.length === 0) {
    return null;
  }

  // 优先 MP4 直链，其次画质档位与像素面积
  candidates.sort((a, b) => {
    if (a.isMp4 !== b.isMp4) {
      return a.isMp4 ? -1 : 1;
    }
    if (a.qualityRank !== b.qualityRank) {
      return a.qualityRank - b.qualityRank;
    }
    return b.pixelArea - a.pixelArea;
  });

  const best = candidates[0];
  if (!best) {
    return null;
  }
  const mergedUrls = dedupeUrls(candidates.map((c) => c.url));
  const fallbackUrls = mergedUrls.slice(1);

  return {
    id: 'video',
    kind: 'video',
    strategy: best.isMp4 ? 'direct' : 'hls_mux',
    sourceUrl: best.url,
    mimeType: 'video/mp4',
    ...(fallbackUrls.length > 0 ? { fallbackUrls } : {}),
    ...(best.width !== undefined ? { width: best.width } : {}),
    ...(best.height !== undefined ? { height: best.height } : {}),
    ...(best.durationSec !== undefined ? { durationSec: best.durationSec } : {}),
  };
}

function extractPinContent(record: UnknownRecord): {
  text: string;
  imageUrls: string[];
} {
  const textParts: string[] = [];
  const imageUrls: string[] = [];

  const contentBlocks = readArray(record, ['content']);
  if (contentBlocks) {
    for (const block of contentBlocks) {
      if (!isRecord(block)) {
        continue;
      }
      const blockType = (readFirstString(block, ['type']) ?? '').toLowerCase();
      if (blockType === 'text') {
        const html = readFirstString(block, ['content', 'own_text']) ?? '';
        const cleaned = htmlToStructuredText(html);
        if (cleaned) {
          textParts.push(cleaned);
        }
      } else if (blockType === 'image') {
        const rawUrl = readFirstString(block, [
          'original_url',
          'originalUrl',
          'url',
        ]);
        if (rawUrl) {
          const normalized = normalizeMediaUrl(rawUrl);
          if (normalized) {
            imageUrls.push(normalized);
          }
        }
      }
    }
  }

  const contentHtml = readFirstString(record, ['content_html', 'contentHtml']);
  if (textParts.length === 0 && contentHtml) {
    const cleaned = htmlToStructuredText(contentHtml);
    if (cleaned) {
      textParts.push(cleaned);
    }
  }
  if (contentHtml) {
    imageUrls.push(...extractImageUrlsFromHtml(contentHtml));
  }

  const excerptTitle = readFirstString(record, ['excerpt_title', 'excerptTitle']);
  if (textParts.length === 0 && excerptTitle) {
    textParts.push(excerptTitle);
  }

  return {
    text: textParts.join('\n\n').trim(),
    imageUrls: dedupeUrls(imageUrls),
  };
}

function extractPlatformExtra(
  kind: ZhihuContentKind,
  record: UnknownRecord,
): Record<string, PlatformExtraValue> | undefined {
  const extra: Record<string, PlatformExtraValue> = {
    contentType: kind,
  };

  const voteup = readFirstNumber(record, [
    'voteup_count',
    'voteupCount',
    'like_count',
    'likeCount',
  ]);
  if (voteup !== undefined) {
    extra.voteupCount = Math.trunc(voteup);
  }

  const commentCount = readFirstNumber(record, [
    'comment_count',
    'commentCount',
  ]);
  if (commentCount !== undefined) {
    extra.commentCount = Math.trunc(commentCount);
  }

  const questionObj = readRecord(record, ['question']);
  const questionId = questionObj
    ? readFirstIdString(questionObj, ['id'])
    : undefined;
  if (questionId) {
    extra.questionId = questionId;
  }

  return extra;
}

/**
 * 将知乎原始实体（回答 / 专栏文章 / 想法 / 视频）归一化为统一 `CapturedPayload`。
 */
export function parseZhihuItem(
  raw: unknown,
  triggerSource: CaptureTriggerSource,
): CapturedPayload | null {
  const unwrapped = unwrapZhihuRecord(raw);
  if (!unwrapped) {
    return null;
  }

  const { kind: zhihuKind, rawId, record } = unwrapped;
  const sourceId = `${zhihuKind}_${rawId}`;
  const author = extractAuthorInfo(record);
  const publishedAt = extractPublishedAt(record);
  const hashtags = extractHashtags(record);
  const platformExtra = extractPlatformExtra(zhihuKind, record);

  if (zhihuKind === 'zvideo') {
    const videoAsset = extractZVideoAsset(record);
    if (!videoAsset) {
      return null;
    }
    const title =
      readFirstString(record, ['title']) ?? `知乎视频_${rawId}`;
    const rawDesc = readFirstString(record, ['description', 'excerpt']) ?? '';
    const description = htmlToStructuredText(rawDesc) || title;
    const videoObj = readRecord(record, ['video']);
    const rawCover =
      readFirstString(record, ['image_url', 'imageUrl', 'thumbnail']) ??
      (videoObj ? readFirstString(videoObj, ['thumbnail', 'cover']) : undefined);
    const coverUrl = rawCover
      ? (normalizeMediaUrl(rawCover) ?? undefined)
      : undefined;

    return {
      platform: 'zhihu',
      sourceId,
      sourceUrl: `https://www.zhihu.com/zvideo/${encodeURIComponent(rawId)}`,
      kind: 'video',
      title,
      description,
      author,
      hashtags,
      assets: [videoAsset],
      triggerSource,
      ...(publishedAt !== undefined ? { publishedAt } : {}),
      ...(coverUrl !== undefined ? { coverUrl } : {}),
      ...(platformExtra !== undefined ? { platformExtra } : {}),
    };
  }

  if (zhihuKind === 'pin') {
    const { text, imageUrls } = extractPinContent(record);
    const imageAssets = buildImageAssetsFromUrls(imageUrls);
    if (!text && imageAssets.length === 0) {
      return null;
    }
    const firstLine = text.split('\n')[0]?.trim() ?? '';
    const title = firstLine
      ? firstLine.slice(0, 60)
      : `知乎想法_${rawId}`;
    const coverUrl = imageAssets[0]?.sourceUrl;
    const mediaKind: CapturedPayload['kind'] =
      imageAssets.length > 1
        ? 'gallery'
        : imageAssets.length === 1
          ? 'image'
          : 'article';

    return {
      platform: 'zhihu',
      sourceId,
      sourceUrl: `https://www.zhihu.com/pin/${encodeURIComponent(rawId)}`,
      kind: mediaKind,
      title,
      description: text || title,
      author,
      hashtags,
      assets: imageAssets,
      triggerSource,
      ...(publishedAt !== undefined ? { publishedAt } : {}),
      ...(coverUrl !== undefined ? { coverUrl } : {}),
      ...(platformExtra !== undefined ? { platformExtra } : {}),
    };
  }

  // 回答（answer）与专栏文章（article）
  const contentHtml = readFirstString(record, ['content']) ?? '';
  const excerpt =
    readFirstString(record, ['excerpt', 'excerpt_new', 'excerptNew']) ?? '';
  const description =
    htmlToStructuredText(contentHtml) || htmlToStructuredText(excerpt);

  const inlineImageUrls = extractImageUrlsFromHtml(contentHtml);
  const explicitImages = readArray(record, ['images']);
  if (explicitImages) {
    for (const entry of explicitImages) {
      if (typeof entry === 'string') {
        const normalized = normalizeMediaUrl(entry);
        if (normalized) {
          inlineImageUrls.push(normalized);
        }
      }
    }
  }
  const imageAssets = buildImageAssetsFromUrls(inlineImageUrls);

  if (zhihuKind === 'article') {
    const title =
      readFirstString(record, ['title']) ?? `知乎专栏_${rawId}`;
    if (!description && imageAssets.length === 0 && !readFirstString(record, ['title'])) {
      return null;
    }
    const rawHeaderImg = readFirstString(record, [
      'title_image',
      'titleImage',
      'image_url',
      'imageUrl',
      'thumbnail',
    ]);
    const coverUrl =
      (rawHeaderImg ? normalizeMediaUrl(rawHeaderImg) : null) ??
      imageAssets[0]?.sourceUrl;

    return {
      platform: 'zhihu',
      sourceId,
      sourceUrl: `https://zhuanlan.zhihu.com/p/${encodeURIComponent(rawId)}`,
      kind: 'article',
      title,
      description: description || title,
      author,
      hashtags,
      assets: imageAssets,
      triggerSource,
      ...(publishedAt !== undefined ? { publishedAt } : {}),
      ...(coverUrl !== undefined ? { coverUrl } : {}),
      ...(platformExtra !== undefined ? { platformExtra } : {}),
    };
  }

  // answer
  const questionObj = readRecord(record, ['question']);
  const questionId = questionObj
    ? readFirstIdString(questionObj, ['id'])
    : undefined;
  const questionTitle = questionObj
    ? readFirstString(questionObj, ['title'])
    : undefined;
  const title =
    questionTitle ??
    readFirstString(record, ['title']) ??
    `知乎回答_${rawId}`;

  if (!description && imageAssets.length === 0 && !questionTitle) {
    return null;
  }

  const rawThumb = readFirstString(record, ['thumbnail']);
  const coverUrl =
    (rawThumb ? normalizeMediaUrl(rawThumb) : null) ??
    imageAssets[0]?.sourceUrl;
  const sourceUrl = questionId
    ? `https://www.zhihu.com/question/${encodeURIComponent(questionId)}/answer/${encodeURIComponent(rawId)}`
    : `https://www.zhihu.com/answer/${encodeURIComponent(rawId)}`;

  return {
    platform: 'zhihu',
    sourceId,
    sourceUrl,
    kind: 'article',
    title,
    description: description || title,
    author,
    hashtags,
    assets: imageAssets,
    triggerSource,
    ...(publishedAt !== undefined ? { publishedAt } : {}),
    ...(coverUrl !== undefined ? { coverUrl } : {}),
    ...(platformExtra !== undefined ? { platformExtra } : {}),
  };
}

/**
 * 将知乎 `/api/v4/comment_v5/.../root_comment` 返回的原始评论数组归一化为标准 `CapturedCommentInput[]`。
 */
export function parseZhihuComments(
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
      readFirstIdString(raw, ['id', 'comment_id']) ?? `zh-comment-${i + 1}`;
    if (seenIds.has(id)) {
      continue;
    }

    const rawContent = readFirstString(raw, ['content']) ?? '';
    const content = htmlToStructuredText(rawContent);
    if (!content) {
      continue;
    }

    const authorWrapper = readRecord(raw, ['author']);
    const memberObj =
      (authorWrapper ? readRecord(authorWrapper, ['member']) : undefined) ??
      authorWrapper;
    const authorId = memberObj
      ? readFirstIdString(memberObj, ['id', 'url_token', 'urlToken'])
      : undefined;
    const authorName =
      (memberObj ? readFirstString(memberObj, ['name', 'nickname']) : undefined) ??
      '知乎用户';
    const rawAvatar = memberObj
      ? readFirstString(memberObj, ['avatar_url', 'avatarUrl', 'avatar'])
      : undefined;
    const avatarUrl = rawAvatar
      ? (normalizeMediaUrl(rawAvatar) ?? undefined)
      : undefined;

    const rawLike = readFirstNumber(raw, [
      'like_count',
      'likeCount',
      'vote_count',
      'voteCount',
    ]);
    const likeCount =
      rawLike !== undefined && rawLike > 0 ? Math.trunc(rawLike) : 0;

    const rawCreated = readFirstNumber(raw, ['created_time', 'createdTime']);
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

/** 校验给定 URL 是否属于知乎主站或专栏页面 */
export function matchesZhihuUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === 'https:' &&
      (parsed.hostname === 'www.zhihu.com' ||
        parsed.hostname === 'zhihu.com' ||
        parsed.hostname === 'zhuanlan.zhihu.com')
    );
  } catch {
    return false;
  }
}

/** 知乎平台标准适配器实现 */
export const zhihuAdapter: PlatformAdapter = {
  id: 'zhihu',
  displayName: '知乎',
  hostPatterns: ZHIHU_HOST_PATTERNS,
  matchesUrl: matchesZhihuUrl,
  getDnrRules(): readonly DnrHeaderRuleSpec[] {
    return ZHIHU_DNR_RULES;
  },
  normalizeRawData(
    raw: unknown,
    triggerSource: CaptureTriggerSource,
  ): CapturedPayload | null {
    return parseZhihuItem(raw, triggerSource);
  },
};
