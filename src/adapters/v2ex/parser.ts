/**
 * V2EX 平台适配器与原始主题/回复归一化解析器。
 *
 * 严格零 `any`：全部字段通过运行时类型守卫安全收窄，
 * 将 V2EX 主题归档为 `kind: 'article'`，保留完整正文、附言、节点标签、内嵌图片与回复列表。
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

const V2EX_REFERER = 'https://www.v2ex.com/';

const V2EX_HOST_PATTERNS: readonly string[] = [
  'https://www.v2ex.com/*',
  'https://v2ex.com/*',
];

const V2EX_DNR_RULES: readonly DnrHeaderRuleSpec[] = [
  {
    idOffset: 1,
    urlFilter: '||cdn.v2ex.com/',
    referer: V2EX_REFERER,
  },
  {
    idOffset: 2,
    urlFilter: '||i.v2ex.co/',
    referer: V2EX_REFERER,
  },
];

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

function normalizeHttpsUrl(rawUrl: string): string | null {
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

function inferImageMimeType(url: string): string {
  let pathname = url.toLowerCase();
  try {
    pathname = new URL(url).pathname.toLowerCase();
  } catch {
    // 使用原小写字符串兜底
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

/**
 * 将 V2EX 提取出的原始回复列表归一化为跨平台 `CapturedCommentInput[]`。
 */
export function parseV2exComments(
  rawReplies: readonly unknown[],
  limit = 100,
): CapturedCommentInput[] {
  const safeLimit =
    Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 100;
  const result: CapturedCommentInput[] = [];
  const seenIds = new Set<string>();

  for (const raw of rawReplies) {
    if (result.length >= safeLimit) {
      break;
    }
    if (!isRecord(raw)) {
      continue;
    }

    const id = readString(raw, 'id');
    const content = readString(raw, 'content');
    if (!id || !content || seenIds.has(id)) {
      continue;
    }
    seenIds.add(id);

    const authorName = readString(raw, 'authorName') ?? '匿名用户';
    const authorId = readString(raw, 'authorId');
    const rawAvatar = readString(raw, 'avatarUrl');
    const avatarUrl = rawAvatar
      ? (normalizeHttpsUrl(rawAvatar) ?? undefined)
      : undefined;
    const rawLike = readNumber(raw, 'likeCount') ?? 0;
    const likeCount = rawLike > 0 ? Math.trunc(rawLike) : 0;
    const rawCreated = readNumber(raw, 'createdAt');
    const createdAt =
      rawCreated !== undefined && rawCreated > 0
        ? Math.trunc(rawCreated)
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

/** V2EX 平台适配器实例 */
export const v2exAdapter: PlatformAdapter = {
  id: 'v2ex',
  displayName: 'V2EX',
  hostPatterns: V2EX_HOST_PATTERNS,

  matchesUrl(url: string): boolean {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        return false;
      }
      const host = parsed.hostname.toLowerCase();
      return host === 'v2ex.com' || host === 'www.v2ex.com';
    } catch {
      return false;
    }
  },

  getDnrRules(): readonly DnrHeaderRuleSpec[] {
    return V2EX_DNR_RULES;
  },

  normalizeRawData(
    raw: unknown,
    triggerSource: CaptureTriggerSource,
  ): CapturedPayload | null {
    if (!isRecord(raw)) {
      return null;
    }

    const topicId = readString(raw, 'topicId');
    const title = readString(raw, 'title');
    if (!topicId || !title) {
      return null;
    }

    const sourceUrl =
      readString(raw, 'sourceUrl') ?? `https://www.v2ex.com/t/${topicId}`;
    const description =
      typeof raw.description === 'string' ? raw.description.trim() : '';

    const authorName = readString(raw, 'authorName') ?? '未知作者';
    const authorId = readString(raw, 'authorId') ?? authorName;
    const rawAvatar = readString(raw, 'authorAvatarUrl');
    const avatarUrl = rawAvatar
      ? (normalizeHttpsUrl(rawAvatar) ?? undefined)
      : undefined;

    const author: AuthorInfo = {
      id: authorId,
      name: authorName,
      handle: authorId,
      ...(avatarUrl ? { avatarUrl } : {}),
      ...(authorId !== '未知作者'
        ? { profileUrl: `https://www.v2ex.com/member/${encodeURIComponent(authorId)}` }
        : {}),
    };

    const nodeName = readString(raw, 'nodeName');
    const nodeSlug = readString(raw, 'nodeSlug');
    const hashtags = nodeName ? [nodeName] : [];

    const rawPublishedAt = readNumber(raw, 'publishedAt');
    const publishedAt =
      rawPublishedAt !== undefined && rawPublishedAt > 0
        ? Math.trunc(rawPublishedAt)
        : undefined;

    const rawImageUrls = Array.isArray(raw.imageUrls) ? raw.imageUrls : [];
    const assets: CapturedAssetInput[] = [];
    const seenUrls = new Set<string>();
    let imageIdx = 0;

    for (const entry of rawImageUrls) {
      if (typeof entry !== 'string') {
        continue;
      }
      const normalized = normalizeHttpsUrl(entry);
      if (!normalized || seenUrls.has(normalized)) {
        continue;
      }
      seenUrls.add(normalized);
      imageIdx += 1;
      assets.push({
        id: `img-${String(imageIdx).padStart(2, '0')}`,
        kind: 'image',
        strategy: 'direct',
        sourceUrl: normalized,
        mimeType: inferImageMimeType(normalized),
      });
    }

    const platformExtra: Record<string, PlatformExtraValue> = {};
    if (nodeName) {
      platformExtra.nodeName = nodeName;
    }
    if (nodeSlug) {
      platformExtra.nodeSlug = nodeSlug;
    }
    const replyCount = readNumber(raw, 'replyCount');
    if (replyCount !== undefined && replyCount >= 0) {
      platformExtra.replyCount = Math.trunc(replyCount);
    }
    const clicks = readNumber(raw, 'clicks');
    if (clicks !== undefined && clicks >= 0) {
      platformExtra.clicks = Math.trunc(clicks);
    }

    return {
      platform: 'v2ex',
      sourceId: topicId,
      sourceUrl,
      kind: 'article',
      title,
      description,
      author,
      ...(publishedAt !== undefined ? { publishedAt } : {}),
      hashtags,
      assets,
      ...(Object.keys(platformExtra).length > 0 ? { platformExtra } : {}),
      triggerSource,
    };
  },
};
