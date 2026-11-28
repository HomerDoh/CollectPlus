/**
 * X / Twitter 平台适配器与原始推文数据归一化解析器。
 *
 * 严格零 `any`：全部字段通过 `unknown` 与运行时类型守卫安全读取。
 * 支持视频推文（最高码率 MP4 直链优先，缺失时回退 HLS `hls_mux`）、
 * 单图/多图推文（原图 `name=orig`）与纯文字长推文（`article`）。
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

type UnknownRecord = Record<string, unknown>;

const TWITTER_REFERER = 'https://x.com/';
const TWITTER_ORIGIN = 'https://x.com';

const TWITTER_HOST_PATTERNS: readonly string[] = [
  'https://x.com/*',
  'https://www.x.com/*',
  'https://twitter.com/*',
  'https://www.twitter.com/*',
];

const TWITTER_DNR_RULES: readonly DnrHeaderRuleSpec[] = [
  {
    idOffset: 1,
    urlFilter: '||video.twimg.com/',
    referer: TWITTER_REFERER,
    origin: TWITTER_ORIGIN,
  },
  {
    idOffset: 2,
    urlFilter: '||pbs.twimg.com/',
    referer: TWITTER_REFERER,
    origin: TWITTER_ORIGIN,
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
    const parsed = Number(value.trim());
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

function toOrigPhotoUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.hostname.endsWith('pbs.twimg.com')) {
      if (!parsed.searchParams.has('name')) {
        parsed.searchParams.set('name', 'orig');
      }
      return parsed.href;
    }
  } catch {
    // 忽略异常
  }
  return url;
}

function extractHashtags(legacy: UnknownRecord, text: string): string[] {
  const seen = new Set<string>();
  const tags: string[] = [];

  if (isRecord(legacy.entities) && Array.isArray(legacy.entities.hashtags)) {
    for (const item of legacy.entities.hashtags) {
      if (isRecord(item)) {
        const tag = readString(item, 'text');
        if (tag && !seen.has(tag.toLowerCase())) {
          seen.add(tag.toLowerCase());
          tags.push(tag);
        }
      }
    }
  }

  const regex = /#([\p{L}\p{N}_]{1,40})/gu;
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

function resolveUserInfo(tweet: UnknownRecord): AuthorInfo {
  const core = isRecord(tweet.core) ? tweet.core : undefined;
  const userResults =
    core && isRecord(core.user_results) ? core.user_results : undefined;
  const userResult =
    userResults && isRecord(userResults.result) ? userResults.result : undefined;
  const userLegacy =
    userResult && isRecord(userResult.legacy) ? userResult.legacy : undefined;
  const userCore =
    userResult && isRecord(userResult.core) ? userResult.core : undefined;
  const userAvatar =
    userResult && isRecord(userResult.avatar) ? userResult.avatar : undefined;

  const id =
    (userResult && readString(userResult, 'rest_id')) ??
    readString(tweet, 'authorId') ??
    'unknown';
  const screenName =
    (userCore && readString(userCore, 'screen_name')) ??
    (userLegacy && readString(userLegacy, 'screen_name')) ??
    readString(tweet, 'authorHandle');
  const name =
    (userCore && readString(userCore, 'name')) ??
    (userLegacy && readString(userLegacy, 'name')) ??
    readString(tweet, 'authorName') ??
    screenName ??
    'X User';
  const avatarUrl = sanitizeHttpUrl(
    (userAvatar && readString(userAvatar, 'image_url')) ??
      (userLegacy && readString(userLegacy, 'profile_image_url_https')) ??
      readString(tweet, 'authorAvatar'),
  );

  return {
    id,
    name,
    ...(screenName ? { handle: `@${screenName}` } : {}),
    ...(avatarUrl ? { avatarUrl } : {}),
    ...(screenName ? { profileUrl: `https://x.com/${screenName}` } : {}),
  };
}

function resolveTweetText(tweet: UnknownRecord, legacy: UnknownRecord): string {
  // 优先读取长推文（Note Tweet）完整文本
  const noteTweet = isRecord(tweet.note_tweet) ? tweet.note_tweet : undefined;
  const noteResults =
    noteTweet && isRecord(noteTweet.note_tweet_results)
      ? noteTweet.note_tweet_results
      : undefined;
  const noteResult =
    noteResults && isRecord(noteResults.result) ? noteResults.result : undefined;
  const noteText = noteResult ? readString(noteResult, 'text') : undefined;
  if (noteText) {
    return noteText;
  }

  return (
    readString(legacy, 'full_text') ??
    readString(legacy, 'text') ??
    readString(tweet, 'text') ??
    ''
  );
}

function buildTitleFromText(text: string, authorName: string, id: string): string {
  const cleaned = text
    .replace(/https?:\/\/t\.co\/\S+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned.length > 0) {
    const chars = Array.from(cleaned);
    return chars.length > 60 ? `${chars.slice(0, 60).join('')}...` : cleaned;
  }
  return `${authorName} 的 X 推文 (${id})`;
}

export const twitterAdapter: PlatformAdapter = {
  id: 'twitter',
  tier: 'deep',
  displayName: 'X',
  hostPatterns: TWITTER_HOST_PATTERNS,
  uiMeta: {
    entryUrl: 'https://x.com/',
    badgeClass: 'bg-slate-800/85 text-white backdrop-blur-xs',
  },

  matchesUrl(url: string): boolean {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        return false;
      }
      const host = parsed.hostname.toLowerCase();
      return (
        host === 'x.com' ||
        host === 'www.x.com' ||
        host === 'twitter.com' ||
        host === 'www.twitter.com'
      );
    } catch {
      return false;
    }
  },

  getDnrRules(): readonly DnrHeaderRuleSpec[] {
    return TWITTER_DNR_RULES;
  },

  normalizeRawData(
    raw: unknown,
    triggerSource: CaptureTriggerSource,
  ): CapturedPayload | null {
    if (!isRecord(raw)) {
      return null;
    }

    // 兼容 TweetWithVisibilityResults 包装结构
    const tweet = isRecord(raw.tweet) ? raw.tweet : raw;
    const legacy = isRecord(tweet.legacy) ? tweet.legacy : tweet;

    const tweetId =
      readString(tweet, 'rest_id') ??
      readString(legacy, 'id_str') ??
      readString(raw, 'sourceId');
    if (!tweetId) {
      return null;
    }

    const author = resolveUserInfo(tweet);
    const fullText = resolveTweetText(tweet, legacy);
    const title = buildTitleFromText(fullText, author.name, tweetId);

    const extEntities = isRecord(legacy.extended_entities)
      ? legacy.extended_entities
      : isRecord(legacy.entities)
        ? legacy.entities
        : undefined;
    const mediaList =
      extEntities && Array.isArray(extEntities.media) ? extEntities.media : [];

    const assets: CapturedAssetInput[] = [];
    let coverUrl: string | undefined;
    let hasVideo = false;
    let imageCount = 0;

    for (const media of mediaList) {
      if (!isRecord(media)) {
        continue;
      }
      const mediaType = readString(media, 'type') ?? 'photo';
      const thumb = sanitizeHttpUrl(readString(media, 'media_url_https'));
      if (!coverUrl && thumb) {
        coverUrl = thumb;
      }

      if (mediaType === 'video' || mediaType === 'animated_gif') {
        const videoInfo = isRecord(media.video_info)
          ? media.video_info
          : undefined;
        const durationMs = videoInfo
          ? readNumber(videoInfo, 'duration_millis')
          : undefined;
        const durationSec =
          durationMs && durationMs > 0 ? Math.round(durationMs / 1000) : undefined;
        const variants =
          videoInfo && Array.isArray(videoInfo.variants)
            ? videoInfo.variants
            : [];

        const mp4Variants: Array<{ url: string; bitrate: number }> = [];
        let hlsUrl: string | undefined;
        for (const v of variants) {
          if (!isRecord(v)) {
            continue;
          }
          const vUrl = sanitizeHttpUrl(readString(v, 'url'));
          const contentType = readString(v, 'content_type') ?? '';
          if (!vUrl) {
            continue;
          }
          if (contentType.includes('mp4')) {
            mp4Variants.push({
              url: vUrl,
              bitrate: readNumber(v, 'bitrate') ?? 0,
            });
          } else if (
            !hlsUrl &&
            (contentType.includes('mpegURL') || vUrl.includes('.m3u8'))
          ) {
            hlsUrl = vUrl;
          }
        }

        mp4Variants.sort((a, b) => b.bitrate - a.bitrate);
        const origInfo = isRecord(media.original_info)
          ? media.original_info
          : undefined;
        const width = origInfo ? readNumber(origInfo, 'width') : undefined;
        const height = origInfo ? readNumber(origInfo, 'height') : undefined;

        if (mp4Variants.length > 0) {
          const best = mp4Variants[0];
          if (best) {
            const fallbacks = mp4Variants.slice(1, 4).map((v) => v.url);
            hasVideo = true;
            assets.push({
              id: assets.length === 0 ? 'video' : `video-${assets.length + 1}`,
              kind: 'video',
              strategy: 'direct',
              sourceUrl: best.url,
              ...(fallbacks.length > 0 ? { fallbackUrls: fallbacks } : {}),
              mimeType: 'video/mp4',
              ...(width ? { width: Math.round(width) } : {}),
              ...(height ? { height: Math.round(height) } : {}),
              ...(durationSec ? { durationSec } : {}),
              filenameHint:
                assets.length === 0
                  ? 'video.mp4'
                  : `video-${assets.length + 1}.mp4`,
            });
          }
        } else if (hlsUrl) {
          hasVideo = true;
          assets.push({
            id: assets.length === 0 ? 'video' : `video-${assets.length + 1}`,
            kind: 'video',
            strategy: 'hls_mux',
            sourceUrl: hlsUrl,
            mimeType: 'video/mp4',
            ...(width ? { width: Math.round(width) } : {}),
            ...(height ? { height: Math.round(height) } : {}),
            ...(durationSec ? { durationSec } : {}),
            filenameHint: 'video.mp4',
          });
        }
      } else if (thumb) {
        imageCount += 1;
        const origUrl = toOrigPhotoUrl(thumb);
        assets.push({
          id: `img-${String(imageCount).padStart(2, '0')}`,
          kind: 'image',
          strategy: 'direct',
          sourceUrl: origUrl,
          ...(origUrl !== thumb ? { fallbackUrls: [thumb] } : {}),
          mimeType: 'image/jpeg',
          filenameHint: `${String(imageCount).padStart(2, '0')}.jpg`,
        });
      }
    }

    let kind: MediaKind;
    if (hasVideo) {
      kind = 'video';
    } else if (imageCount > 1) {
      kind = 'gallery';
    } else if (imageCount === 1) {
      kind = 'image';
    } else {
      kind = 'article';
    }

    const createdAtRaw = readString(legacy, 'created_at');
    const publishedAt = createdAtRaw ? Date.parse(createdAtRaw) : undefined;
    const screenName = author.handle?.replace(/^@/, '');
    const sourceUrl =
      sanitizeHttpUrl(readString(raw, 'sourceUrl')) ??
      (screenName
        ? `https://x.com/${screenName}/status/${tweetId}`
        : `https://x.com/i/web/status/${tweetId}`);

    const platformExtra: Record<string, PlatformExtraValue> = {
      tweetId,
      ...(readNumber(legacy, 'favorite_count') !== undefined
        ? { likeCount: Math.trunc(readNumber(legacy, 'favorite_count') ?? 0) }
        : {}),
      ...(readNumber(legacy, 'retweet_count') !== undefined
        ? {
            retweetCount: Math.trunc(readNumber(legacy, 'retweet_count') ?? 0),
          }
        : {}),
      ...(readNumber(legacy, 'reply_count') !== undefined
        ? { replyCount: Math.trunc(readNumber(legacy, 'reply_count') ?? 0) }
        : {}),
    };

    return {
      platform: 'twitter',
      sourceId: tweetId,
      sourceUrl,
      kind,
      title,
      description: fullText,
      author,
      ...(publishedAt && Number.isFinite(publishedAt) ? { publishedAt } : {}),
      hashtags: extractHashtags(legacy, fullText),
      ...(coverUrl ? { coverUrl } : {}),
      assets,
      platformExtra,
      triggerSource,
    };
  },
};
