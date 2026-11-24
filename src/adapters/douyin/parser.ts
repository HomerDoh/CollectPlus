/**
 * 抖音平台适配器与原始 `aweme` 数据归一化解析器。
 *
 * 严格零 `any`：全部字段通过 `unknown` 与运行时类型守卫安全读取，
 * 兼容抖音 Web API（snake_case）与 React Fiber（camelCase）常见结构差异。
 */

import type {
  CapturedAssetInput,
  CapturedPayload,
  CaptureTriggerSource,
  DnrHeaderRuleSpec,
  PlatformAdapter,
} from '../../types/adapter.ts';
import type { AuthorInfo, PlatformExtraValue } from '../../types/schema.ts';

type UnknownRecord = Record<string, unknown>;

const DOUYIN_REFERER = 'https://www.douyin.com/';
const DOUYIN_ORIGIN = 'https://www.douyin.com';

const DOUYIN_HOST_PATTERNS: readonly string[] = [
  'https://www.douyin.com/*',
  'https://douyin.com/*',
];

const DOUYIN_DNR_RULES: readonly DnrHeaderRuleSpec[] = [
  {
    idOffset: 1,
    urlFilter: '||douyinvod.com/',
    referer: DOUYIN_REFERER,
    origin: DOUYIN_ORIGIN,
  },
  {
    idOffset: 2,
    urlFilter: '||byteimg.com/',
    referer: DOUYIN_REFERER,
    origin: DOUYIN_ORIGIN,
  },
  {
    idOffset: 3,
    urlFilter: '||douyinpic.com/',
    referer: DOUYIN_REFERER,
    origin: DOUYIN_ORIGIN,
  },
  {
    idOffset: 4,
    urlFilter: '||snssdk.com/',
    referer: DOUYIN_REFERER,
    origin: DOUYIN_ORIGIN,
  },
  {
    idOffset: 5,
    urlFilter: '||pstatp.com/',
    referer: DOUYIN_REFERER,
    origin: DOUYIN_ORIGIN,
  },
  {
    idOffset: 6,
    urlFilter: '||zjcdn.com/',
    referer: DOUYIN_REFERER,
    origin: DOUYIN_ORIGIN,
  },
  {
    idOffset: 7,
    urlFilter: '||ibytedtos.com/',
    referer: DOUYIN_REFERER,
    origin: DOUYIN_ORIGIN,
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
    if (trimmed.length === 0) {
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

function readStringArray(
  record: UnknownRecord,
  keys: readonly string[],
): string[] {
  const rawList = readArray(record, keys);
  if (!rawList) {
    return [];
  }
  const result: string[] = [];
  for (const item of rawList) {
    if (typeof item === 'string') {
      const trimmed = item.trim();
      if (trimmed.length > 0) {
        result.push(trimmed);
      }
    }
  }
  return result;
}

function normalizeMediaUrl(
  rawUrl: string,
  options?: { stripWatermark?: boolean },
): string | null {
  let candidate = rawUrl.trim();
  if (!candidate) {
    return null;
  }

  if (candidate.startsWith('//')) {
    candidate = `https:${candidate}`;
  } else if (candidate.startsWith('http://')) {
    candidate = `https://${candidate.slice('http://'.length)}`;
  }

  if (options?.stripWatermark) {
    candidate = candidate.replace(/\/playwm\//gi, '/play/');
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

function extractUrlListFromObject(
  obj: UnknownRecord | undefined,
  options?: { stripWatermark?: boolean; preferDownloadList?: boolean },
): string[] {
  if (!obj) {
    return [];
  }

  const keyGroups = options?.preferDownloadList
    ? [
        ['download_url_list', 'downloadUrlList'],
        ['url_list', 'urlList'],
      ]
    : [['url_list', 'urlList']];

  const normalized: string[] = [];
  for (const keys of keyGroups) {
    const rawUrls = readStringArray(obj, keys);
    for (const rawUrl of rawUrls) {
      const url = normalizeMediaUrl(rawUrl, {
        stripWatermark: options?.stripWatermark,
      });
      if (url) {
        normalized.push(url);
      }
    }
  }

  const singleUrl = readFirstString(obj, ['url', 'src', 'playApi']);
  if (singleUrl) {
    const url = normalizeMediaUrl(singleUrl, {
      stripWatermark: options?.stripWatermark,
    });
    if (url) {
      normalized.push(url);
    }
  }

  return dedupeUrls(normalized);
}

/**
 * 为图片 URL 计算解码优先级（数字越小优先级越高）：
 * - 0: JPEG / PNG
 * - 1: WebP / GIF
 * - 2: 未显式标明扩展名（如 `.image` 或无扩展名，浏览器通常可直接解码）
 * - 3: HEIC / HEIF（排在末尾作为 fallback）
 */
function getImageUrlPriority(url: string): number {
  let pathname = url;
  let search = '';
  try {
    const parsed = new URL(url);
    pathname = parsed.pathname.toLowerCase();
    search = parsed.search.toLowerCase();
  } catch {
    pathname = url.toLowerCase();
  }

  if (
    /\.(?:heic|heif)$/i.test(pathname) ||
    /(?:^|[?&])format=heic(?:&|$)/i.test(search) ||
    pathname.includes('.heic')
  ) {
    return 3;
  }

  if (/\.(?:jpe?g|png)$/i.test(pathname)) {
    return 0;
  }

  if (/\.(?:webp|gif)$/i.test(pathname)) {
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
    // 使用原始小写字符串兜底判断
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
  if (pathname.endsWith('.heic') || pathname.endsWith('.heif')) {
    return 'image/heic';
  }
  return 'image/jpeg';
}

function unwrapAwemeRecord(raw: unknown, depth = 0): UnknownRecord | null {
  if (depth > 3 || !isRecord(raw)) {
    return null;
  }

  if (readFirstIdString(raw, ['aweme_id', 'awemeId']) !== undefined) {
    return raw;
  }

  const wrapperKeys = [
    'aweme_detail',
    'aweme_info',
    'awemeDetail',
    'awemeInfo',
    'aweme',
    'item',
    'data',
  ];
  for (const key of wrapperKeys) {
    const nested = raw[key];
    if (isRecord(nested)) {
      const found = unwrapAwemeRecord(nested, depth + 1);
      if (found) {
        return found;
      }
    }
  }

  return null;
}

function buildTitleAndDescription(
  aweme: UnknownRecord,
  sourceId: string,
): { title: string; description: string } {
  const desc = readString(aweme, 'desc') ?? '';
  const itemTitle = readFirstString(aweme, ['item_title', 'itemTitle']) ?? '';
  const previewTitle =
    readFirstString(aweme, ['preview_title', 'previewTitle']) ?? '';

  const description = desc || itemTitle || previewTitle;
  const titleCandidate = itemTitle || previewTitle || desc;

  const singleLineCandidate = titleCandidate
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // 去掉末尾密集的 #话题标签（如 "xxx #美食 #日常"）
  const strippedTitle = singleLineCandidate
    .replace(/(?:\s*#[^\s#@]+)+\s*$/g, '')
    .trim();

  const collapsedDesc = description
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const title = strippedTitle || collapsedDesc || `抖音作品_${sourceId}`;
  return { title, description };
}

function extractHashtags(aweme: UnknownRecord, description: string): string[] {
  const seen = new Set<string>();
  const hashtags: string[] = [];

  const pushTag = (rawTag: string): void => {
    const cleaned = rawTag.replace(/^#+/, '').trim();
    if (cleaned.length > 0 && !seen.has(cleaned)) {
      seen.add(cleaned);
      hashtags.push(cleaned);
    }
  };

  const textExtra = readArray(aweme, ['text_extra', 'textExtra']);
  if (textExtra) {
    for (const item of textExtra) {
      if (!isRecord(item)) {
        continue;
      }
      const hashtagName = readFirstString(item, [
        'hashtag_name',
        'hashtagName',
      ]);
      if (hashtagName) {
        pushTag(hashtagName);
      }
    }
  }

  if (description) {
    const regex = /#([^\s#@]+)/g;
    let match = regex.exec(description);
    while (match !== null) {
      const captured = match[1];
      if (captured) {
        pushTag(captured);
      }
      match = regex.exec(description);
    }
  }

  return hashtags;
}

function extractAuthorInfo(aweme: UnknownRecord): AuthorInfo {
  const authorObj = readRecord(aweme, ['author', 'authorInfo']);
  if (!authorObj) {
    return {
      id: 'unknown',
      name: '未知作者',
    };
  }

  const uid = readFirstIdString(authorObj, ['uid', 'id']);
  const secUid = readFirstString(authorObj, ['sec_uid', 'secUid']);
  const name =
    readFirstString(authorObj, ['nickname', 'name']) ?? '未知作者';
  const handle = readFirstString(authorObj, [
    'unique_id',
    'uniqueId',
    'short_id',
    'shortId',
  ]);

  const avatarThumbObj = readRecord(authorObj, [
    'avatar_thumb',
    'avatarThumb',
    'avatar_medium',
    'avatarMedium',
    'avatar_larger',
    'avatarLarger',
  ]);
  const avatarUrls = rankImageUrls(extractUrlListFromObject(avatarThumbObj));
  let avatarUrl = avatarUrls[0];
  if (!avatarUrl) {
    const rawAvatarStr = readFirstString(authorObj, [
      'avatar_thumb',
      'avatarUrl',
      'avatarUri',
    ]);
    if (rawAvatarStr) {
      avatarUrl = normalizeMediaUrl(rawAvatarStr) ?? undefined;
    }
  }

  const profileUrl = secUid
    ? `https://www.douyin.com/user/${encodeURIComponent(secUid)}`
    : undefined;

  const author: AuthorInfo = {
    id: uid ?? secUid ?? 'unknown',
    name,
  };
  if (handle) {
    author.handle = handle;
  }
  if (avatarUrl) {
    author.avatarUrl = avatarUrl;
  }
  if (profileUrl) {
    author.profileUrl = profileUrl;
  }

  return author;
}

function extractPublishedAt(aweme: UnknownRecord): number | undefined {
  const rawTime = readFirstNumber(aweme, ['create_time', 'createTime']);
  if (rawTime === undefined || rawTime <= 0) {
    return undefined;
  }
  // 13 位及以上视为毫秒，否则按秒级时间戳转为毫秒
  return rawTime >= 1_000_000_000_000
    ? Math.trunc(rawTime)
    : Math.trunc(rawTime * 1000);
}

function extractGalleryAssets(aweme: UnknownRecord): CapturedAssetInput[] {
  const rawImages = readArray(aweme, ['images']);
  if (!rawImages || rawImages.length === 0) {
    return [];
  }

  const assets: CapturedAssetInput[] = [];
  let imageIndex = 0;

  for (const item of rawImages) {
    if (!isRecord(item)) {
      continue;
    }

    const rawUrls = extractUrlListFromObject(item, {
      preferDownloadList: true,
    });
    const rankedUrls = rankImageUrls(rawUrls);
    const primaryUrl = rankedUrls[0];
    if (!primaryUrl) {
      continue;
    }

    imageIndex += 1;
    const width = readPositiveInt(item, ['width']);
    const height = readPositiveInt(item, ['height']);
    const fallbackUrls = rankedUrls.slice(1);

    const asset: CapturedAssetInput = {
      id: `img-${String(imageIndex).padStart(2, '0')}`,
      kind: 'image',
      strategy: 'direct',
      sourceUrl: primaryUrl,
      mimeType: inferImageMimeType(primaryUrl),
    };
    if (fallbackUrls.length > 0) {
      asset.fallbackUrls = fallbackUrls;
    }
    if (width !== undefined) {
      asset.width = width;
    }
    if (height !== undefined) {
      asset.height = height;
    }

    assets.push(asset);
  }

  return assets;
}

interface VideoBitRateCandidate {
  urls: string[];
  isHevc: boolean;
  pixelArea: number;
  bitRate: number;
  dataSize: number;
  width?: number;
  height?: number;
}

function isHevcEntry(entry: UnknownRecord): boolean {
  const isH265Raw = entry.is_h265 ?? entry.isH265;
  if (isH265Raw === 1 || isH265Raw === true || isH265Raw === '1') {
    return true;
  }

  const gearName = (
    readFirstString(entry, ['gear_name', 'gearName']) ?? ''
  ).toLowerCase();
  if (
    gearName.includes('hevc') ||
    gearName.includes('h265') ||
    gearName.includes('bytevc1')
  ) {
    return true;
  }

  const codecType = (
    readFirstString(entry, ['codec_type', 'codecType']) ?? ''
  ).toLowerCase();
  if (
    codecType.includes('hevc') ||
    codecType.includes('h265') ||
    codecType.includes('bytevc1')
  ) {
    return true;
  }

  if (isH265Raw === 0 || isH265Raw === false || isH265Raw === '0') {
    return false;
  }

  return false;
}

function extractVideoAsset(aweme: UnknownRecord): CapturedAssetInput | null {
  const videoObj = readRecord(aweme, ['video']);
  if (!videoObj) {
    return null;
  }

  const defaultWidth = readPositiveInt(videoObj, ['width']);
  const defaultHeight = readPositiveInt(videoObj, ['height']);

  const rawDurationMs =
    readFirstNumber(videoObj, ['duration']) ??
    readFirstNumber(aweme, ['duration']);
  const durationSec =
    rawDurationMs !== undefined && rawDurationMs > 0
      ? Math.round((rawDurationMs / 1000) * 100) / 100
      : undefined;

  const bitRateList = readArray(videoObj, ['bit_rate', 'bitRateList']);
  const candidates: VideoBitRateCandidate[] = [];

  if (bitRateList) {
    for (const rawEntry of bitRateList) {
      if (!isRecord(rawEntry)) {
        continue;
      }

      const playAddr = readRecord(rawEntry, ['play_addr', 'playAddr']);
      const urls = extractUrlListFromObject(playAddr, {
        stripWatermark: true,
      });
      if (urls.length === 0) {
        continue;
      }

      const width =
        readPositiveInt(playAddr ?? {}, ['width']) ?? defaultWidth;
      const height =
        readPositiveInt(playAddr ?? {}, ['height']) ?? defaultHeight;
      const pixelArea =
        width !== undefined && height !== undefined ? width * height : 0;
      const bitRate = readFirstNumber(rawEntry, ['bit_rate', 'bitRate']) ?? 0;
      const dataSize =
        readFirstNumber(playAddr ?? {}, ['data_size', 'dataSize']) ??
        readFirstNumber(rawEntry, ['data_size', 'dataSize']) ??
        0;

      candidates.push({
        urls,
        isHevc: isHevcEntry(rawEntry),
        pixelArea,
        bitRate,
        dataSize,
        width,
        height,
      });
    }
  }

  let selectedUrls: string[] = [];
  let selectedWidth = defaultWidth;
  let selectedHeight = defaultHeight;

  if (candidates.length > 0) {
    // 优先非 HEVC（H.264 兼容性最佳），同类内按分辨率、码率、体积降序
    candidates.sort((a, b) => {
      if (a.isHevc !== b.isHevc) {
        return a.isHevc ? 1 : -1;
      }
      if (a.pixelArea !== b.pixelArea) {
        return b.pixelArea - a.pixelArea;
      }
      if (a.bitRate !== b.bitRate) {
        return b.bitRate - a.bitRate;
      }
      return b.dataSize - a.dataSize;
    });

    const best = candidates[0];
    if (best) {
      selectedWidth = best.width ?? defaultWidth;
      selectedHeight = best.height ?? defaultHeight;

      const allCandidateUrls: string[] = [];
      for (const candidate of candidates) {
        allCandidateUrls.push(...candidate.urls);
      }
      selectedUrls = dedupeUrls(allCandidateUrls);
    }
  }

  // 收集 play_addr -> play_addr_h264 -> download_addr 作为兜底或补充备用源
  const fallbackAddrKeys: readonly (readonly string[])[] = [
    ['play_addr', 'playAddr'],
    ['play_addr_h264', 'playAddrH264'],
    ['download_addr', 'downloadAddr'],
  ];
  const directFallbackUrls: string[] = [];
  for (const keys of fallbackAddrKeys) {
    const addrObj = readRecord(videoObj, keys);
    directFallbackUrls.push(
      ...extractUrlListFromObject(addrObj, { stripWatermark: true }),
    );
  }

  // 兼容 Fiber 中可能直接提供的 playApi 字段
  const rawPlayApi = readFirstString(videoObj, ['playApi', 'play_api']);
  if (rawPlayApi) {
    const normalizedPlayApi = normalizeMediaUrl(rawPlayApi, {
      stripWatermark: true,
    });
    if (normalizedPlayApi) {
      directFallbackUrls.push(normalizedPlayApi);
    }
  }

  const mergedUrls = dedupeUrls([...selectedUrls, ...directFallbackUrls]);
  const primaryUrl = mergedUrls[0];
  if (!primaryUrl) {
    return null;
  }

  const fallbackUrls = mergedUrls.slice(1);
  const asset: CapturedAssetInput = {
    id: 'video',
    kind: 'video',
    strategy: 'direct',
    sourceUrl: primaryUrl,
    mimeType: 'video/mp4',
  };
  if (fallbackUrls.length > 0) {
    asset.fallbackUrls = fallbackUrls;
  }
  if (selectedWidth !== undefined) {
    asset.width = selectedWidth;
  }
  if (selectedHeight !== undefined) {
    asset.height = selectedHeight;
  }
  if (durationSec !== undefined) {
    asset.durationSec = durationSec;
  }

  return asset;
}

function extractCoverUrls(
  aweme: UnknownRecord,
  galleryAssets: readonly CapturedAssetInput[],
): { coverUrl?: string; coverFallbackUrls?: string[] } {
  const videoObj = readRecord(aweme, ['video']);
  const primaryGroupUrls: string[] = [];
  const heicFallbackUrls: string[] = [];

  const appendRankedGroup = (urls: readonly string[]): void => {
    for (const url of rankImageUrls(urls)) {
      if (getImageUrlPriority(url) >= 3) {
        heicFallbackUrls.push(url);
      } else {
        primaryGroupUrls.push(url);
      }
    }
  };

  if (videoObj) {
    const coverKeyGroups: readonly (readonly string[])[] = [
      ['origin_cover', 'originCover'],
      ['cover'],
      ['dynamic_cover', 'dynamicCover'],
    ];

    for (const keys of coverKeyGroups) {
      const coverObj = readRecord(videoObj, keys);
      appendRankedGroup(extractUrlListFromObject(coverObj));
    }
  }

  const firstGalleryAsset = galleryAssets[0];
  if (firstGalleryAsset) {
    const galleryFirstUrls = [
      firstGalleryAsset.sourceUrl,
      ...(firstGalleryAsset.fallbackUrls ?? []),
    ];
    appendRankedGroup(galleryFirstUrls);
  }

  const ordered = dedupeUrls([...primaryGroupUrls, ...heicFallbackUrls]);
  const coverUrl = ordered[0];
  if (!coverUrl) {
    return {};
  }

  const coverFallbackUrls = ordered.slice(1);
  return {
    coverUrl,
    coverFallbackUrls:
      coverFallbackUrls.length > 0 ? coverFallbackUrls : undefined,
  };
}

function extractPlatformExtra(
  aweme: UnknownRecord,
  awemeType: number | undefined,
): Record<string, PlatformExtraValue> | undefined {
  const extra: Record<string, PlatformExtraValue> = {};

  const stats = readRecord(aweme, ['statistics', 'stats']);
  if (stats) {
    const diggCount = readFirstNumber(stats, ['digg_count', 'diggCount']);
    if (diggCount !== undefined) {
      extra.diggCount = Math.trunc(diggCount);
    }
    const collectCount = readFirstNumber(stats, [
      'collect_count',
      'collectCount',
    ]);
    if (collectCount !== undefined) {
      extra.collectCount = Math.trunc(collectCount);
    }
    const commentCount = readFirstNumber(stats, [
      'comment_count',
      'commentCount',
    ]);
    if (commentCount !== undefined) {
      extra.commentCount = Math.trunc(commentCount);
    }
    const shareCount = readFirstNumber(stats, ['share_count', 'shareCount']);
    if (shareCount !== undefined) {
      extra.shareCount = Math.trunc(shareCount);
    }
  }

  const music = readRecord(aweme, ['music']);
  if (music) {
    const musicTitle = readFirstString(music, ['title']);
    if (musicTitle) {
      extra.musicTitle = musicTitle;
    }
  }

  if (awemeType !== undefined) {
    extra.awemeType = Math.trunc(awemeType);
  }

  return Object.keys(extra).length > 0 ? extra : undefined;
}

/**
 * 将抖音原始 `aweme` 对象归一化为跨平台统一采集载荷 `CapturedPayload`。
 * 若无法解析出 `aweme_id` 或任何有效的视频/图集媒体资产，返回 `null`。
 */
export function parseDouyinAweme(
  raw: unknown,
  triggerSource: CaptureTriggerSource,
): CapturedPayload | null {
  const aweme = unwrapAwemeRecord(raw);
  if (!aweme) {
    return null;
  }

  const sourceId = readFirstIdString(aweme, ['aweme_id', 'awemeId']);
  if (!sourceId) {
    return null;
  }

  const awemeType = readFirstNumber(aweme, ['aweme_type', 'awemeType']);
  const galleryAssets = extractGalleryAssets(aweme);
  const isGalleryCandidate =
    awemeType === 68 || awemeType === 2 || galleryAssets.length > 0;

  let kind: CapturedPayload['kind'];
  let sourceUrl: string;
  let assets: CapturedAssetInput[];

  if (isGalleryCandidate && galleryAssets.length > 0) {
    kind = 'gallery';
    sourceUrl = `https://www.douyin.com/note/${sourceId}`;
    assets = galleryAssets;
  } else {
    const videoAsset = extractVideoAsset(aweme);
    if (!videoAsset) {
      return null;
    }
    kind = 'video';
    sourceUrl = `https://www.douyin.com/video/${sourceId}`;
    assets = [videoAsset];
  }

  const { title, description } = buildTitleAndDescription(aweme, sourceId);
  const hashtags = extractHashtags(aweme, description);
  const author = extractAuthorInfo(aweme);
  const publishedAt = extractPublishedAt(aweme);
  const { coverUrl, coverFallbackUrls } = extractCoverUrls(
    aweme,
    galleryAssets,
  );
  const platformExtra = extractPlatformExtra(aweme, awemeType);

  const payload: CapturedPayload = {
    platform: 'douyin',
    sourceId,
    sourceUrl,
    kind,
    title,
    description,
    author,
    hashtags,
    assets,
    triggerSource,
  };

  if (publishedAt !== undefined) {
    payload.publishedAt = publishedAt;
  }
  if (coverUrl !== undefined) {
    payload.coverUrl = coverUrl;
  }
  if (coverFallbackUrls !== undefined) {
    payload.coverFallbackUrls = coverFallbackUrls;
  }
  if (platformExtra !== undefined) {
    payload.platformExtra = platformExtra;
  }

  return payload;
}

/** 校验给定 URL 是否属于抖音主站页面 */
export function matchesDouyinUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === 'https:' &&
      (parsed.hostname === 'www.douyin.com' ||
        parsed.hostname === 'douyin.com')
    );
  } catch {
    return false;
  }
}

/** 抖音平台标准适配器实现 */
export const douyinAdapter: PlatformAdapter = {
  id: 'douyin',
  displayName: '抖音',
  hostPatterns: DOUYIN_HOST_PATTERNS,
  matchesUrl: matchesDouyinUrl,
  getDnrRules(): readonly DnrHeaderRuleSpec[] {
    return DOUYIN_DNR_RULES;
  },
  normalizeRawData(
    raw: unknown,
    triggerSource: CaptureTriggerSource,
  ): CapturedPayload | null {
    return parseDouyinAweme(raw, triggerSource);
  },
};
