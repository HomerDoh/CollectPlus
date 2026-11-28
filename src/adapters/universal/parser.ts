/**
 * Tier 1 通用全网网页适配器（`platform: 'web'`）。
 *
 * 将 `extractUniversalPageData` 输出的原始网页数据归一化为标准 `CapturedPayload`，
 * 支持文章、图集、单图与 HTML5/HLS/DASH 视频，并自动附带页面 `Referer` 交由任务级动态 DNR 处理防盗链。
 */

import type {
  CapturedAssetInput,
  CapturedPayload,
  CaptureTriggerSource,
  DnrHeaderRuleSpec,
  PlatformAdapter,
} from '../../types/adapter.ts';
import type {
  AuthorInfo,
  MediaKind,
  PlatformExtraValue,
} from '../../types/schema.ts';
import { buildUniversalSourceId, canonicalizePageUrl } from './extractor.ts';

type UnknownRecord = Record<string, unknown>;

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

function readNumber(record: UnknownRecord, key: string): number | undefined {
  const val = record[key];
  if (typeof val === 'number' && Number.isFinite(val)) {
    return val;
  }
  return undefined;
}

function sanitizeHttpUrl(raw: string | undefined): string | undefined {
  if (!raw) {
    return undefined;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return parsed.href;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function inferImageMimeType(url: string): string {
  let pathname = url.toLowerCase();
  try {
    pathname = new URL(url).pathname.toLowerCase();
  } catch {
    // 忽略解析异常
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
  if (pathname.endsWith('.avif')) {
    return 'image/avif';
  }
  return 'image/jpeg';
}

interface ParsedVideoCandidate {
  url: string;
  strategy: 'direct' | 'hls_mux' | 'dash_mux';
  mimeType: string;
  width?: number;
  height?: number;
  durationSec?: number;
}

function parseVideos(raw: unknown): ParsedVideoCandidate[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: ParsedVideoCandidate[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (!isRecord(entry)) {
      continue;
    }
    const url = sanitizeHttpUrl(readString(entry, 'url'));
    const strategy = readString(entry, 'strategy');
    if (
      !url ||
      seen.has(url) ||
      (strategy !== 'direct' &&
        strategy !== 'hls_mux' &&
        strategy !== 'dash_mux')
    ) {
      continue;
    }
    seen.add(url);
    const mimeType = readString(entry, 'mimeType') ?? 'video/mp4';
    const width = readNumber(entry, 'width');
    const height = readNumber(entry, 'height');
    const durationSec = readNumber(entry, 'durationSec');
    out.push({
      url,
      strategy,
      mimeType,
      ...(width && width > 0 ? { width: Math.round(width) } : {}),
      ...(height && height > 0 ? { height: Math.round(height) } : {}),
      ...(durationSec && durationSec > 0
        ? { durationSec: Math.round(durationSec) }
        : {}),
    });
  }
  return out;
}

/** 判断给定 URL 是否为可由通用网页引擎采集的 HTTP/HTTPS 页面 */
export function isUniversalCapturableUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

export const universalWebAdapter: PlatformAdapter = {
  id: 'web',
  tier: 'universal',
  displayName: 'Web',
  hostPatterns: ['https://*/*', 'http://*/*'],
  uiMeta: {
    badgeClass: 'bg-slate-700/85 text-white backdrop-blur-xs',
  },

  matchesUrl(url: string): boolean {
    return isUniversalCapturableUrl(url);
  },

  getDnrRules(): readonly DnrHeaderRuleSpec[] {
    // 通用全网站点不写死静态 CDN 域名，下载时自动经由任务级动态 Session DNR 注入 Referer
    return [];
  },

  normalizeRawData(
    raw: unknown,
    triggerSource: CaptureTriggerSource,
  ): CapturedPayload | null {
    if (!isRecord(raw)) {
      return null;
    }

    const rawSourceUrl = sanitizeHttpUrl(readString(raw, 'sourceUrl'));
    if (!rawSourceUrl) {
      return null;
    }
    const sourceUrl = canonicalizePageUrl(rawSourceUrl);
    const sourceId =
      readString(raw, 'sourceId') ?? buildUniversalSourceId(sourceUrl);

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(sourceUrl);
    } catch {
      return null;
    }

    const siteHost =
      readString(raw, 'siteHost') ??
      parsedUrl.hostname.toLowerCase().replace(/^www\./, '');
    const siteName = readString(raw, 'siteName');
    const pageOrigin =
      sanitizeHttpUrl(readString(raw, 'pageOrigin')) ?? parsedUrl.origin;

    const title = readString(raw, 'title') ?? siteName ?? siteHost;
    const metaDesc = readString(raw, 'description') ?? '';
    const bodyText = readString(raw, 'bodyText') ?? '';
    const ogType = (readString(raw, 'ogType') ?? '').toLowerCase();
    const isDirectImageDocument = raw.isDirectImageDocument === true;

    const authorName =
      readString(raw, 'authorName') ?? siteName ?? siteHost;
    const authorUrl = sanitizeHttpUrl(readString(raw, 'authorUrl'));
    const author: AuthorInfo = {
      id: `${siteHost}:${authorName.toLowerCase()}`,
      name: authorName,
      ...(authorUrl ? { profileUrl: authorUrl } : {}),
    };

    const publishedAt = readNumber(raw, 'publishedAt');

    const rawTags = Array.isArray(raw.tags) ? raw.tags : [];
    const hashtags: string[] = [];
    const seenTags = new Set<string>();
    for (const t of rawTags) {
      if (typeof t === 'string') {
        const cleaned = t.trim().replace(/^#+/, '');
        if (cleaned && !seenTags.has(cleaned.toLowerCase())) {
          seenTags.add(cleaned.toLowerCase());
          hashtags.push(cleaned);
        }
      }
    }

    const videos = parseVideos(raw.videos);
    const rawImages = Array.isArray(raw.imageUrls) ? raw.imageUrls : [];
    const imageUrls: string[] = [];
    const seenImgs = new Set<string>();
    for (const img of rawImages) {
      if (typeof img !== 'string') {
        continue;
      }
      const safe = sanitizeHttpUrl(img);
      if (safe && !seenImgs.has(safe)) {
        seenImgs.add(safe);
        imageUrls.push(safe);
      }
    }

    const coverUrl =
      sanitizeHttpUrl(readString(raw, 'coverUrl')) ?? imageUrls[0];

    // 判定最佳媒体形态：视频页优先 video，直开图片/少文多图走 image/gallery，其余归档为 article
    const primaryVideo = videos[0];
    const isVideoPage =
      Boolean(primaryVideo) &&
      (ogType.startsWith('video') || bodyText.length < 1500);

    let kind: MediaKind;
    const assets: CapturedAssetInput[] = [];

    if (isVideoPage && primaryVideo) {
      kind = 'video';
      const fallbackUrls = videos
        .slice(1, 4)
        .filter((v) => v.strategy === primaryVideo.strategy)
        .map((v) => v.url);
      assets.push({
        id: 'video',
        kind: 'video',
        strategy: primaryVideo.strategy,
        sourceUrl: primaryVideo.url,
        ...(fallbackUrls.length > 0 ? { fallbackUrls } : {}),
        mimeType: primaryVideo.mimeType,
        ...(primaryVideo.width ? { width: primaryVideo.width } : {}),
        ...(primaryVideo.height ? { height: primaryVideo.height } : {}),
        ...(primaryVideo.durationSec
          ? { durationSec: primaryVideo.durationSec }
          : {}),
        filenameHint:
          primaryVideo.mimeType === 'video/webm' ? 'video.webm' : 'video.mp4',
      });
    } else if (
      isDirectImageDocument ||
      (imageUrls.length === 1 &&
        bodyText.length < 30 &&
        !ogType.startsWith('article'))
    ) {
      kind = 'image';
      const imgUrl = imageUrls[0] ?? coverUrl;
      if (imgUrl) {
        assets.push({
          id: 'img-01',
          kind: 'image',
          strategy: 'direct',
          sourceUrl: imgUrl,
          mimeType: inferImageMimeType(imgUrl),
        });
      }
    } else if (
      imageUrls.length >= 2 &&
      bodyText.length < 80 &&
      !ogType.startsWith('article')
    ) {
      kind = 'gallery';
      imageUrls.forEach((imgUrl, idx) => {
        assets.push({
          id: `img-${String(idx + 1).padStart(2, '0')}`,
          kind: 'image',
          strategy: 'direct',
          sourceUrl: imgUrl,
          mimeType: inferImageMimeType(imgUrl),
        });
      });
    } else {
      kind = 'article';
      imageUrls.forEach((imgUrl, idx) => {
        assets.push({
          id: `img-${String(idx + 1).padStart(2, '0')}`,
          kind: 'image',
          strategy: 'direct',
          sourceUrl: imgUrl,
          mimeType: inferImageMimeType(imgUrl),
        });
      });
    }

    const description =
      kind === 'article'
        ? bodyText || metaDesc
        : metaDesc || bodyText.slice(0, 1200);

    const platformExtra: Record<string, PlatformExtraValue> = {
      siteHost,
      extractorTier: 'universal',
      ...(siteName ? { siteName } : {}),
    };

    const normalizedOrigin = (() => {
      try {
        return new URL(pageOrigin).origin;
      } catch {
        return parsedUrl.origin;
      }
    })();

    return {
      platform: 'web',
      sourceId,
      sourceUrl,
      kind,
      title,
      description,
      author,
      ...(publishedAt !== undefined && publishedAt > 0
        ? { publishedAt: Math.trunc(publishedAt) }
        : {}),
      hashtags,
      ...(coverUrl ? { coverUrl } : {}),
      assets,
      defaultRequestHeaders: {
        referer: `${normalizedOrigin}/`,
      },
      platformExtra,
      triggerSource,
    };
  },
};
