/**
 * YouTube 平台适配器与原始视频数据归一化解析器。
 *
 * 严格零 `any`：全部字段通过 `unknown` 与运行时类型守卫安全读取。
 * 优先选择 H.264/AVC MP4 自适应视频轨 + AAC/MP4A 音轨交由 Mediabunny 无损混流（`dash_mux`），
 * 缺失分离流时自动回退 progressive MP4（`direct`）或 HLS 清单（`hls_mux`）。
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

const YOUTUBE_REFERER = 'https://www.youtube.com/';
const YOUTUBE_ORIGIN = 'https://www.youtube.com';

const YOUTUBE_HOST_PATTERNS: readonly string[] = [
  'https://www.youtube.com/*',
  'https://m.youtube.com/*',
  'https://youtube.com/*',
];

const YOUTUBE_DNR_RULES: readonly DnrHeaderRuleSpec[] = [
  {
    idOffset: 1,
    urlFilter: '||googlevideo.com/',
    referer: YOUTUBE_REFERER,
    origin: YOUTUBE_ORIGIN,
  },
  {
    idOffset: 2,
    urlFilter: '||ytimg.com/',
    referer: YOUTUBE_REFERER,
    origin: YOUTUBE_ORIGIN,
  },
  {
    idOffset: 3,
    urlFilter: '||ggpht.com/',
    referer: YOUTUBE_REFERER,
    origin: YOUTUBE_ORIGIN,
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
    return Number.isFinite(parsed) ? parsed : undefined;
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
  const normalized = trimmed.startsWith('//') ? `https:${trimmed}` : trimmed;
  try {
    const parsed = new URL(normalized);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return parsed.href;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function dedupeUrls(urls: readonly (string | undefined)[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of urls) {
    const safe = sanitizeHttpUrl(raw);
    if (safe && !seen.has(safe)) {
      seen.add(safe);
      out.push(safe);
    }
  }
  return out;
}

function extractHashtags(text: string): string[] {
  const seen = new Set<string>();
  const tags: string[] = [];
  const regex = /#([\p{L}\p{N}_-]{1,40})/gu;
  let match = regex.exec(text);
  while (match !== null) {
    const tag = match[1]?.trim();
    if (tag && !seen.has(tag.toLowerCase())) {
      seen.add(tag.toLowerCase());
      tags.push(tag);
    }
    match = regex.exec(text);
  }
  return tags;
}

interface ParsedFormat {
  url: string;
  mimeType: string;
  isAvc: boolean;
  isMp4Video: boolean;
  isMp4Audio: boolean;
  isAac: boolean;
  width?: number;
  height?: number;
  bitrate: number;
  contentLength?: number;
}

function parseStreamingFormat(entry: unknown): ParsedFormat | null {
  if (!isRecord(entry)) {
    return null;
  }
  const url = sanitizeHttpUrl(readString(entry, 'url'));
  if (!url) {
    return null;
  }
  const mimeTypeRaw = readString(entry, 'mimeType') ?? '';
  const mimeLower = mimeTypeRaw.toLowerCase();
  const baseMime = mimeTypeRaw.split(';')[0]?.trim() || 'video/mp4';

  const isVideo = mimeLower.startsWith('video/');
  const isAudio = mimeLower.startsWith('audio/');
  const isMp4Video = isVideo && mimeLower.includes('mp4');
  const isAvc = isMp4Video && mimeLower.includes('avc1');
  const isMp4Audio = isAudio && mimeLower.includes('mp4');
  const isAac = isMp4Audio && mimeLower.includes('mp4a');

  const width = readNumber(entry, 'width');
  const height = readNumber(entry, 'height');
  const bitrate = readNumber(entry, 'bitrate') ?? 0;
  const contentLength = readNumber(entry, 'contentLength');

  return {
    url,
    mimeType: baseMime,
    isAvc,
    isMp4Video,
    isMp4Audio,
    isAac,
    ...(width && width > 0 ? { width: Math.round(width) } : {}),
    ...(height && height > 0 ? { height: Math.round(height) } : {}),
    bitrate,
    ...(contentLength && contentLength > 0
      ? { contentLength: Math.round(contentLength) }
      : {}),
  };
}

function pickBestAdaptiveVideo(formats: readonly ParsedFormat[]): ParsedFormat[] {
  const videos = formats.filter((f) => f.mimeType.startsWith('video/'));
  return [...videos].sort((a, b) => {
    if (a.isAvc !== b.isAvc) {
      return a.isAvc ? -1 : 1;
    }
    if (a.isMp4Video !== b.isMp4Video) {
      return a.isMp4Video ? -1 : 1;
    }
    const heightDiff = (b.height ?? 0) - (a.height ?? 0);
    if (heightDiff !== 0) {
      return heightDiff;
    }
    return b.bitrate - a.bitrate;
  });
}

function pickBestAdaptiveAudio(formats: readonly ParsedFormat[]): ParsedFormat[] {
  const audios = formats.filter((f) => f.mimeType.startsWith('audio/'));
  return [...audios].sort((a, b) => {
    if (a.isAac !== b.isAac) {
      return a.isAac ? -1 : 1;
    }
    if (a.isMp4Audio !== b.isMp4Audio) {
      return a.isMp4Audio ? -1 : 1;
    }
    return b.bitrate - a.bitrate;
  });
}

function extractThumbnails(videoDetails: UnknownRecord, videoId: string): string[] {
  const candidates: Array<{ url: string; area: number }> = [];
  const thumbObj = videoDetails.thumbnail;
  if (isRecord(thumbObj) && Array.isArray(thumbObj.thumbnails)) {
    for (const item of thumbObj.thumbnails) {
      if (!isRecord(item)) {
        continue;
      }
      const url = sanitizeHttpUrl(readString(item, 'url'));
      if (!url) {
        continue;
      }
      const w = readNumber(item, 'width') ?? 0;
      const h = readNumber(item, 'height') ?? 0;
      candidates.push({ url, area: w * h });
    }
  }
  candidates.sort((a, b) => b.area - a.area);
  return dedupeUrls([
    ...candidates.map((c) => c.url),
    `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`,
    `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
  ]);
}

function parsePublishedAt(raw: UnknownRecord): number | undefined {
  const microformat = raw.microformat;
  if (isRecord(microformat) && isRecord(microformat.playerMicroformatRenderer)) {
    const renderer = microformat.playerMicroformatRenderer;
    const dateStr =
      readString(renderer, 'publishDate') ?? readString(renderer, 'uploadDate');
    if (dateStr) {
      const ts = Date.parse(dateStr);
      if (Number.isFinite(ts) && ts > 0) {
        return ts;
      }
    }
  }
  const direct = readNumber(raw, 'publishedAt');
  return direct && direct > 0 ? direct : undefined;
}

export function extractYoutubeVideoIdFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    if (
      host !== 'www.youtube.com' &&
      host !== 'youtube.com' &&
      host !== 'm.youtube.com' &&
      host !== 'youtu.be'
    ) {
      return null;
    }
    if (host === 'youtu.be') {
      const seg = parsed.pathname.split('/').filter(Boolean)[0];
      return seg && /^[A-Za-z0-9_-]{11}$/.test(seg) ? seg : null;
    }
    const vParam = parsed.searchParams.get('v')?.trim();
    if (vParam && /^[A-Za-z0-9_-]{6,32}$/.test(vParam)) {
      return vParam;
    }
    const pathMatch = /^\/(?:shorts|embed|live)\/([A-Za-z0-9_-]{6,32})/.exec(
      parsed.pathname,
    );
    return pathMatch?.[1] ?? null;
  } catch {
    return null;
  }
}

export const youtubeAdapter: PlatformAdapter = {
  id: 'youtube',
  tier: 'deep',
  displayName: 'YouTube',
  hostPatterns: YOUTUBE_HOST_PATTERNS,
  uiMeta: {
    entryUrl: 'https://www.youtube.com/',
    badgeClass: 'bg-red-600/85 text-white backdrop-blur-xs',
  },

  matchesUrl(url: string): boolean {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        return false;
      }
      const host = parsed.hostname.toLowerCase();
      return (
        host === 'www.youtube.com' ||
        host === 'm.youtube.com' ||
        host === 'youtube.com'
      );
    } catch {
      return false;
    }
  },

  getDnrRules(): readonly DnrHeaderRuleSpec[] {
    return YOUTUBE_DNR_RULES;
  },

  normalizeRawData(
    raw: unknown,
    triggerSource: CaptureTriggerSource,
  ): CapturedPayload | null {
    if (!isRecord(raw)) {
      return null;
    }

    const videoDetails = isRecord(raw.videoDetails) ? raw.videoDetails : raw;
    const videoId =
      readString(videoDetails, 'videoId') ?? readString(raw, 'videoId');
    if (!videoId) {
      return null;
    }

    const title =
      readString(videoDetails, 'title') ??
      readString(raw, 'title') ??
      `YouTube Video ${videoId}`;
    const description =
      readString(videoDetails, 'shortDescription') ??
      readString(raw, 'description') ??
      '';
    const durationSec = readNumber(videoDetails, 'lengthSeconds');
    const channelId =
      readString(videoDetails, 'channelId') ??
      readString(raw, 'channelId') ??
      'unknown';
    const authorName =
      readString(videoDetails, 'author') ??
      readString(raw, 'authorName') ??
      'YouTube Creator';
    const author: AuthorInfo = {
      id: channelId,
      name: authorName,
      ...(channelId !== 'unknown'
        ? { profileUrl: `https://www.youtube.com/channel/${channelId}` }
        : {}),
    };

    const coverUrls = extractThumbnails(videoDetails, videoId);
    const streamingData = isRecord(raw.streamingData)
      ? raw.streamingData
      : undefined;

    const adaptiveParsed: ParsedFormat[] = [];
    if (streamingData && Array.isArray(streamingData.adaptiveFormats)) {
      for (const entry of streamingData.adaptiveFormats) {
        const parsed = parseStreamingFormat(entry);
        if (parsed) {
          adaptiveParsed.push(parsed);
        }
      }
    }

    const progressiveParsed: ParsedFormat[] = [];
    if (streamingData && Array.isArray(streamingData.formats)) {
      for (const entry of streamingData.formats) {
        const parsed = parseStreamingFormat(entry);
        if (parsed) {
          progressiveParsed.push(parsed);
        }
      }
    }

    const hlsManifestUrl = streamingData
      ? sanitizeHttpUrl(readString(streamingData, 'hlsManifestUrl'))
      : undefined;

    const assets: CapturedAssetInput[] = [];
    const sortedVideos = pickBestAdaptiveVideo(adaptiveParsed);
    const sortedAudios = pickBestAdaptiveAudio(adaptiveParsed);
    const bestAdaptiveVideo = sortedVideos[0];
    const bestAdaptiveAudio = sortedAudios[0];

    if (bestAdaptiveVideo && bestAdaptiveAudio) {
      const videoFallbacks = dedupeUrls(
        sortedVideos.slice(1, 4).map((v) => v.url),
      );
      const audioFallbacks = dedupeUrls(
        sortedAudios.slice(1, 4).map((a) => a.url),
      );
      const combinedSize =
        bestAdaptiveVideo.contentLength && bestAdaptiveAudio.contentLength
          ? bestAdaptiveVideo.contentLength + bestAdaptiveAudio.contentLength
          : undefined;
      assets.push({
        id: 'video',
        kind: 'video',
        strategy: 'dash_mux',
        sourceUrl: bestAdaptiveVideo.url,
        ...(videoFallbacks.length > 0 ? { fallbackUrls: videoFallbacks } : {}),
        audioUrl: bestAdaptiveAudio.url,
        ...(audioFallbacks.length > 0
          ? { audioFallbackUrls: audioFallbacks }
          : {}),
        mimeType: 'video/mp4',
        ...(bestAdaptiveVideo.width ? { width: bestAdaptiveVideo.width } : {}),
        ...(bestAdaptiveVideo.height
          ? { height: bestAdaptiveVideo.height }
          : {}),
        ...(durationSec && durationSec > 0
          ? { durationSec: Math.round(durationSec) }
          : {}),
        ...(combinedSize ? { sizeBytes: combinedSize } : {}),
        filenameHint: 'video.mp4',
      });
    } else if (progressiveParsed.length > 0) {
      const sortedProg = [...progressiveParsed].sort((a, b) => {
        const hDiff = (b.height ?? 0) - (a.height ?? 0);
        return hDiff !== 0 ? hDiff : b.bitrate - a.bitrate;
      });
      const best = sortedProg[0];
      if (best) {
        const fallbacks = dedupeUrls(sortedProg.slice(1, 4).map((f) => f.url));
        assets.push({
          id: 'video',
          kind: 'video',
          strategy: 'direct',
          sourceUrl: best.url,
          ...(fallbacks.length > 0 ? { fallbackUrls: fallbacks } : {}),
          mimeType: best.mimeType,
          ...(best.width ? { width: best.width } : {}),
          ...(best.height ? { height: best.height } : {}),
          ...(durationSec && durationSec > 0
            ? { durationSec: Math.round(durationSec) }
            : {}),
          ...(best.contentLength ? { sizeBytes: best.contentLength } : {}),
          filenameHint: 'video.mp4',
        });
      }
    } else if (hlsManifestUrl) {
      assets.push({
        id: 'video',
        kind: 'video',
        strategy: 'hls_mux',
        sourceUrl: hlsManifestUrl,
        mimeType: 'video/mp4',
        ...(durationSec && durationSec > 0
          ? { durationSec: Math.round(durationSec) }
          : {}),
        filenameHint: 'video.mp4',
      });
    }

    if (assets.length === 0) {
      return null;
    }

    const viewCount = readNumber(videoDetails, 'viewCount');
    const platformExtra: Record<string, PlatformExtraValue> = {
      videoId,
      ...(channelId !== 'unknown' ? { channelId } : {}),
      ...(viewCount !== undefined ? { viewCount: Math.trunc(viewCount) } : {}),
    };

    const sourceUrl =
      sanitizeHttpUrl(readString(raw, 'sourceUrl')) ??
      `https://www.youtube.com/watch?v=${videoId}`;
    const publishedAt = parsePublishedAt(raw);

    return {
      platform: 'youtube',
      sourceId: videoId,
      sourceUrl,
      kind: 'video',
      title,
      description,
      author,
      ...(publishedAt ? { publishedAt } : {}),
      hashtags: extractHashtags(`${title}\n${description}`),
      ...(coverUrls[0] ? { coverUrl: coverUrls[0] } : {}),
      ...(coverUrls.length > 1
        ? { coverFallbackUrls: coverUrls.slice(1) }
        : {}),
      assets,
      platformExtra,
      triggerSource,
    };
  },
};
