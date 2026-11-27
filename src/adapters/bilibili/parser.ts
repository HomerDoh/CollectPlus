/**
 * Bilibili 平台适配器与原始视频/评论数据归一化解析器。
 *
 * 严格零 `any`：全部字段通过 `unknown` 与运行时类型守卫安全读取，
 * 优先选择 AVC/H.264 DASH 视频轨 + AAC 音轨交由 Mediabunny 无损混流，
 * 缺失 DASH 时自动回退 `durl` 直链 MP4。
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

const BILIBILI_REFERER = 'https://www.bilibili.com/';
const BILIBILI_ORIGIN = 'https://www.bilibili.com';

const BILIBILI_HOST_PATTERNS: readonly string[] = [
  'https://www.bilibili.com/*',
  'https://bilibili.com/*',
  'https://space.bilibili.com/*',
];

const BILIBILI_DNR_RULES: readonly DnrHeaderRuleSpec[] = [
  {
    idOffset: 1,
    urlFilter: '||bilivideo.com/',
    referer: BILIBILI_REFERER,
    origin: BILIBILI_ORIGIN,
  },
  {
    idOffset: 2,
    urlFilter: '||bilivideo.cn/',
    referer: BILIBILI_REFERER,
    origin: BILIBILI_ORIGIN,
  },
  {
    idOffset: 3,
    urlFilter: '||hdslb.com/',
    referer: BILIBILI_REFERER,
    origin: BILIBILI_ORIGIN,
  },
  {
    idOffset: 4,
    urlFilter: '||akamaized.net/',
    referer: BILIBILI_REFERER,
    origin: BILIBILI_ORIGIN,
  },
];

const STANDARD_AAC_AUDIO_IDS: ReadonlySet<number> = new Set([
  30280, 30232, 30216,
]);

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
  const out: string[] = [];
  for (const url of urls) {
    if (!seen.has(url)) {
      seen.add(url);
      out.push(url);
    }
  }
  return out;
}

function extractStreamUrls(stream: UnknownRecord): string[] {
  const collected: string[] = [];
  const primary = readFirstString(stream, ['baseUrl', 'base_url', 'url']);
  if (primary) {
    const normalized = normalizeMediaUrl(primary);
    if (normalized) {
      collected.push(normalized);
    }
  }

  const backups = readArray(stream, ['backupUrl', 'backup_url']);
  if (backups) {
    for (const entry of backups) {
      if (typeof entry === 'string') {
        const normalized = normalizeMediaUrl(entry);
        if (normalized) {
          collected.push(normalized);
        }
      }
    }
  }

  return dedupeUrls(collected);
}

interface UnwrappedBilibiliRaw {
  videoData: UnknownRecord;
  playinfo?: UnknownRecord;
  rawTags?: readonly unknown[];
  currentP: number;
}

function unwrapBilibiliRaw(raw: unknown): UnwrappedBilibiliRaw | null {
  if (!isRecord(raw)) {
    return null;
  }

  const videoData =
    readRecord(raw, ['videoData', 'View', 'view', 'video']) ??
    (readFirstString(raw, ['bvid']) || readFirstIdString(raw, ['aid', 'id'])
      ? raw
      : undefined);

  if (!videoData) {
    return null;
  }

  const playinfo =
    readRecord(raw, ['playinfo', 'playInfo', 'playurl', 'playUrl']) ??
    readRecord(videoData, ['playinfo', 'playInfo']);

  const rawTags = readArray(raw, ['tags', 'Tags']) ?? readArray(videoData, ['tags']);
  const rawP =
    readPositiveInt(raw, ['currentP', 'p', 'page']) ??
    readPositiveInt(videoData, ['currentP', 'p']) ??
    1;

  return {
    videoData,
    ...(playinfo ? { playinfo } : {}),
    ...(rawTags ? { rawTags } : {}),
    currentP: Math.max(1, rawP),
  };
}

function unwrapPlayinfoData(playinfo: UnknownRecord | undefined): UnknownRecord | undefined {
  if (!playinfo) {
    return undefined;
  }
  if (isRecord(playinfo.dash) || Array.isArray(playinfo.durl)) {
    return playinfo;
  }
  const nested = readRecord(playinfo, ['data', 'result']);
  if (nested && (isRecord(nested.dash) || Array.isArray(nested.durl))) {
    return nested;
  }
  return undefined;
}

interface DashVideoCandidate {
  urls: string[];
  isAvc: boolean;
  qualityId: number;
  pixelArea: number;
  bandwidth: number;
  width?: number;
  height?: number;
}

interface DashAudioCandidate {
  urls: string[];
  isAac: boolean;
  bandwidth: number;
}

function extractVideoAsset(
  videoData: UnknownRecord,
  playinfo: UnknownRecord | undefined,
  activePage: UnknownRecord | undefined,
): CapturedAssetInput | null {
  const playData = unwrapPlayinfoData(playinfo);
  if (!playData) {
    return null;
  }

  const fallbackDurationSec =
    readFirstNumber(activePage ?? {}, ['duration']) ??
    readFirstNumber(videoData, ['duration']);

  const dash = readRecord(playData, ['dash']);
  if (dash) {
    const rawVideos = readArray(dash, ['video']) ?? [];
    const videoCandidates: DashVideoCandidate[] = [];

    for (const entry of rawVideos) {
      if (!isRecord(entry)) {
        continue;
      }
      const urls = extractStreamUrls(entry);
      if (urls.length === 0) {
        continue;
      }
      const codecs = (readFirstString(entry, ['codecs']) ?? '').toLowerCase();
      const codecId = readFirstNumber(entry, ['codecid', 'codecId']);
      const isAvc = codecId === 7 || codecs.startsWith('avc1');
      const width = readPositiveInt(entry, ['width']);
      const height = readPositiveInt(entry, ['height']);
      const pixelArea =
        width !== undefined && height !== undefined ? width * height : 0;
      const qualityId = readFirstNumber(entry, ['id']) ?? 0;
      const bandwidth = readFirstNumber(entry, ['bandwidth']) ?? 0;

      videoCandidates.push({
        urls,
        isAvc,
        qualityId,
        pixelArea,
        bandwidth,
        ...(width !== undefined ? { width } : {}),
        ...(height !== undefined ? { height } : {}),
      });
    }

    if (videoCandidates.length > 0) {
      // 优先 AVC/H.264 保障全浏览器与 Mediabunny MP4 无损封装兼容性，同类按画质/分辨率/码率降序
      videoCandidates.sort((a, b) => {
        if (a.isAvc !== b.isAvc) {
          return a.isAvc ? -1 : 1;
        }
        if (a.qualityId !== b.qualityId) {
          return b.qualityId - a.qualityId;
        }
        if (a.pixelArea !== b.pixelArea) {
          return b.pixelArea - a.pixelArea;
        }
        return b.bandwidth - a.bandwidth;
      });

      const bestVideo = videoCandidates[0];
      if (bestVideo) {
        const allVideoUrls = dedupeUrls(
          videoCandidates.flatMap((candidate) => candidate.urls),
        );
        const primaryVideoUrl = allVideoUrls[0];
        if (primaryVideoUrl) {
          const rawAudios: unknown[] = [...(readArray(dash, ['audio']) ?? [])];
          const dolby = readRecord(dash, ['dolby']);
          const dolbyAudios = dolby ? readArray(dolby, ['audio']) : undefined;
          if (dolbyAudios) {
            rawAudios.push(...dolbyAudios);
          }

          const audioCandidates: DashAudioCandidate[] = [];
          for (const entry of rawAudios) {
            if (!isRecord(entry)) {
              continue;
            }
            const urls = extractStreamUrls(entry);
            if (urls.length === 0) {
              continue;
            }
            const codecs = (readFirstString(entry, ['codecs']) ?? '').toLowerCase();
            const audioId = readFirstNumber(entry, ['id']) ?? 0;
            const isAac =
              codecs.startsWith('mp4a') || STANDARD_AAC_AUDIO_IDS.has(audioId);
            const bandwidth = readFirstNumber(entry, ['bandwidth']) ?? 0;
            audioCandidates.push({ urls, isAac, bandwidth });
          }

          audioCandidates.sort((a, b) => {
            if (a.isAac !== b.isAac) {
              return a.isAac ? -1 : 1;
            }
            return b.bandwidth - a.bandwidth;
          });

          const allAudioUrls = dedupeUrls(
            audioCandidates.flatMap((candidate) => candidate.urls),
          );
          const primaryAudioUrl = allAudioUrls[0];
          const audioFallbackUrls = allAudioUrls.slice(1);
          const fallbackUrls = allVideoUrls.slice(1);
          const dashDuration = readFirstNumber(dash, ['duration']);
          const durationSec =
            dashDuration !== undefined && dashDuration > 0
              ? Math.round(dashDuration * 100) / 100
              : fallbackDurationSec !== undefined && fallbackDurationSec > 0
                ? Math.round(fallbackDurationSec * 100) / 100
                : undefined;

          return {
            id: 'video',
            kind: 'video',
            strategy: 'dash_mux',
            sourceUrl: primaryVideoUrl,
            mimeType: 'video/mp4',
            ...(fallbackUrls.length > 0 ? { fallbackUrls } : {}),
            ...(primaryAudioUrl ? { audioUrl: primaryAudioUrl } : {}),
            ...(audioFallbackUrls.length > 0 ? { audioFallbackUrls } : {}),
            ...(bestVideo.width !== undefined ? { width: bestVideo.width } : {}),
            ...(bestVideo.height !== undefined ? { height: bestVideo.height } : {}),
            ...(durationSec !== undefined ? { durationSec } : {}),
          };
        }
      }
    }
  }

  // 无 DASH 时回退到 durl 单文件直链
  const durlList = readArray(playData, ['durl']);
  if (durlList && durlList.length > 0) {
    const first = durlList[0];
    if (isRecord(first)) {
      const urls = extractStreamUrls(first);
      const primaryUrl = urls[0];
      if (primaryUrl) {
        const durlLengthMs = readFirstNumber(first, ['length']);
        const durationSec =
          durlLengthMs !== undefined && durlLengthMs > 0
            ? Math.round((durlLengthMs / 1000) * 100) / 100
            : fallbackDurationSec !== undefined && fallbackDurationSec > 0
              ? Math.round(fallbackDurationSec * 100) / 100
              : undefined;
        const dimension =
          readRecord(activePage ?? {}, ['dimension']) ??
          readRecord(videoData, ['dimension']);
        const width = dimension ? readPositiveInt(dimension, ['width']) : undefined;
        const height = dimension ? readPositiveInt(dimension, ['height']) : undefined;
        const durlSize = readFirstNumber(first, ['size']);
        const sizeBytes =
          durlSize !== undefined && durlSize > 0
            ? Math.round(durlSize)
            : undefined;
        const fallbackUrls = urls.slice(1);

        return {
          id: 'video',
          kind: 'video',
          strategy: 'direct',
          sourceUrl: primaryUrl,
          mimeType: 'video/mp4',
          ...(fallbackUrls.length > 0 ? { fallbackUrls } : {}),
          ...(width !== undefined ? { width } : {}),
          ...(height !== undefined ? { height } : {}),
          ...(durationSec !== undefined ? { durationSec } : {}),
          ...(sizeBytes !== undefined ? { sizeBytes } : {}),
        };
      }
    }
  }

  return null;
}

function extractAuthorInfo(videoData: UnknownRecord): AuthorInfo {
  const owner = readRecord(videoData, ['owner', 'upper']);
  if (!owner) {
    return {
      id: 'unknown',
      name: '未知UP主',
    };
  }

  const mid = readFirstIdString(owner, ['mid', 'id']) ?? 'unknown';
  const name = readFirstString(owner, ['name', 'uname']) ?? '未知UP主';
  const rawFace = readFirstString(owner, ['face', 'avatar']);
  const avatarUrl = rawFace ? (normalizeMediaUrl(rawFace) ?? undefined) : undefined;
  const profileUrl =
    mid !== 'unknown'
      ? `https://space.bilibili.com/${encodeURIComponent(mid)}`
      : undefined;

  return {
    id: mid,
    name,
    ...(avatarUrl ? { avatarUrl } : {}),
    ...(profileUrl ? { profileUrl } : {}),
  };
}

function extractPublishedAt(videoData: UnknownRecord): number | undefined {
  const rawTime = readFirstNumber(videoData, ['pubdate', 'pubtime', 'ctime']);
  if (rawTime === undefined || rawTime <= 0) {
    return undefined;
  }
  return rawTime >= 1_000_000_000_000
    ? Math.trunc(rawTime)
    : Math.trunc(rawTime * 1000);
}

function extractHashtags(
  videoData: UnknownRecord,
  rawTags: readonly unknown[] | undefined,
): string[] {
  const seen = new Set<string>();
  const tags: string[] = [];

  const push = (raw: string | undefined): void => {
    if (!raw) {
      return;
    }
    const cleaned = raw.replace(/^#+/, '').trim();
    if (cleaned.length > 0 && !seen.has(cleaned)) {
      seen.add(cleaned);
      tags.push(cleaned);
    }
  };

  if (rawTags) {
    for (const entry of rawTags) {
      if (typeof entry === 'string') {
        push(entry);
      } else if (isRecord(entry)) {
        push(readFirstString(entry, ['tag_name', 'tagName', 'name']));
      }
    }
  }

  push(readFirstString(videoData, ['tname']));
  return tags;
}

function extractPlatformExtra(
  videoData: UnknownRecord,
  bvid: string | undefined,
  aid: string | undefined,
  cid: string | undefined,
  currentP: number,
): Record<string, PlatformExtraValue> | undefined {
  const extra: Record<string, PlatformExtraValue> = {};
  if (bvid) {
    extra.bvid = bvid;
  }
  if (aid) {
    extra.aid = aid;
  }
  if (cid) {
    extra.cid = cid;
  }
  if (currentP > 1) {
    extra.part = currentP;
  }

  const stat = readRecord(videoData, ['stat', 'cnt_info']);
  if (stat) {
    const viewCount = readFirstNumber(stat, ['view', 'play']);
    const likeCount = readFirstNumber(stat, ['like']);
    const coinCount = readFirstNumber(stat, ['coin']);
    const favoriteCount = readFirstNumber(stat, ['favorite', 'collect']);
    const danmakuCount = readFirstNumber(stat, ['danmaku']);
    const replyCount = readFirstNumber(stat, ['reply']);

    if (viewCount !== undefined) {
      extra.viewCount = Math.trunc(viewCount);
    }
    if (likeCount !== undefined) {
      extra.likeCount = Math.trunc(likeCount);
    }
    if (coinCount !== undefined) {
      extra.coinCount = Math.trunc(coinCount);
    }
    if (favoriteCount !== undefined) {
      extra.favoriteCount = Math.trunc(favoriteCount);
    }
    if (danmakuCount !== undefined) {
      extra.danmakuCount = Math.trunc(danmakuCount);
    }
    if (replyCount !== undefined) {
      extra.replyCount = Math.trunc(replyCount);
    }
  }

  return Object.keys(extra).length > 0 ? extra : undefined;
}

/**
 * 将 B 站 `/x/v2/reply*` 原始评论数组归一化为跨平台 `CapturedCommentInput[]`。
 */
export function parseBilibiliComments(
  rawComments: readonly unknown[],
  limit = 100,
): CapturedCommentInput[] {
  const safeLimit =
    Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 100;
  const result: CapturedCommentInput[] = [];
  const seenIds = new Set<string>();

  for (const raw of rawComments) {
    if (result.length >= safeLimit) {
      break;
    }
    if (!isRecord(raw)) {
      continue;
    }

    const id = readFirstIdString(raw, ['rpid_str', 'rpid', 'id']);
    if (!id || seenIds.has(id)) {
      continue;
    }

    const contentObj = readRecord(raw, ['content']);
    const content =
      (contentObj ? readFirstString(contentObj, ['message', 'text']) : undefined) ??
      readFirstString(raw, ['content', 'message']);
    if (!content) {
      continue;
    }

    seenIds.add(id);

    const member = readRecord(raw, ['member']);
    const authorId = member
      ? readFirstIdString(member, ['mid', 'id'])
      : undefined;
    const authorName =
      (member ? readFirstString(member, ['uname', 'name']) : undefined) ??
      '匿名用户';
    const rawAvatar = member
      ? readFirstString(member, ['avatar', 'face'])
      : undefined;
    const avatarUrl = rawAvatar
      ? (normalizeMediaUrl(rawAvatar) ?? undefined)
      : undefined;

    const rawLike = readFirstNumber(raw, ['like', 'like_count']) ?? 0;
    const likeCount = rawLike > 0 ? Math.trunc(rawLike) : 0;

    const rawCtime = readFirstNumber(raw, ['ctime', 'create_time']);
    const createdAt =
      rawCtime !== undefined && rawCtime > 0
        ? rawCtime >= 1_000_000_000_000
          ? Math.trunc(rawCtime)
          : Math.trunc(rawCtime * 1000)
        : undefined;

    result.push({
      id,
      ...(authorId ? { authorId } : {}),
      authorName,
      ...(avatarUrl ? { avatarUrl } : {}),
      content,
      likeCount,
      ...(createdAt !== undefined ? { createdAt } : {}),
    });
  }

  return result;
}

/** Bilibili 平台适配器实例 */
export const bilibiliAdapter: PlatformAdapter = {
  id: 'bilibili',
  displayName: 'B站',
  hostPatterns: BILIBILI_HOST_PATTERNS,

  matchesUrl(url: string): boolean {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        return false;
      }
      const host = parsed.hostname.toLowerCase();
      return (
        host === 'bilibili.com' ||
        host === 'www.bilibili.com' ||
        host === 'space.bilibili.com'
      );
    } catch {
      return false;
    }
  },

  getDnrRules(): readonly DnrHeaderRuleSpec[] {
    return BILIBILI_DNR_RULES;
  },

  normalizeRawData(
    raw: unknown,
    triggerSource: CaptureTriggerSource,
  ): CapturedPayload | null {
    const unwrapped = unwrapBilibiliRaw(raw);
    if (!unwrapped) {
      return null;
    }

    const { videoData, playinfo, rawTags, currentP } = unwrapped;
    const bvid = readFirstString(videoData, ['bvid']);
    const aid = readFirstIdString(videoData, ['aid', 'id']);
    if (!bvid && !aid) {
      return null;
    }

    const pages = readArray(videoData, ['pages']);
    const hasMultiPages = Array.isArray(pages) && pages.length > 1;
    const pageIndex = Math.max(0, currentP - 1);
    const activePageCandidate =
      pages && pageIndex < pages.length ? pages[pageIndex] : undefined;
    const activePage = isRecord(activePageCandidate)
      ? activePageCandidate
      : undefined;

    const cid =
      readFirstIdString(activePage ?? {}, ['cid']) ??
      readFirstIdString(videoData, ['cid']);

    const videoAsset = extractVideoAsset(videoData, playinfo, activePage);
    if (!videoAsset) {
      return null;
    }

    const canonicalId = bvid ?? `av${aid}`;
    const sourceId =
      hasMultiPages && currentP > 1
        ? `${canonicalId}_p${currentP}`
        : canonicalId;
    const sourceUrl =
      hasMultiPages && currentP > 1
        ? `https://www.bilibili.com/video/${canonicalId}?p=${currentP}`
        : `https://www.bilibili.com/video/${canonicalId}`;

    const baseTitle =
      readFirstString(videoData, ['title']) ?? `B站视频_${canonicalId}`;
    const partTitle = activePage ? readFirstString(activePage, ['part']) : undefined;
    const title =
      hasMultiPages &&
      currentP > 1 &&
      partTitle &&
      partTitle !== baseTitle
        ? `${baseTitle} - P${currentP} ${partTitle}`
        : baseTitle;

    const description =
      readFirstString(videoData, ['desc', 'intro']) ?? '';

    const rawCover = readFirstString(videoData, ['pic', 'cover']);
    const coverUrl = rawCover
      ? (normalizeMediaUrl(rawCover) ?? undefined)
      : undefined;

    const author = extractAuthorInfo(videoData);
    const publishedAt = extractPublishedAt(videoData);
    const hashtags = extractHashtags(videoData, rawTags);
    const platformExtra = extractPlatformExtra(
      videoData,
      bvid,
      aid,
      cid,
      currentP,
    );

    return {
      platform: 'bilibili',
      sourceId,
      sourceUrl,
      kind: 'video',
      title,
      description,
      author,
      ...(publishedAt !== undefined ? { publishedAt } : {}),
      hashtags,
      ...(coverUrl ? { coverUrl } : {}),
      assets: [videoAsset],
      ...(platformExtra ? { platformExtra } : {}),
      triggerSource,
    };
  },
};
