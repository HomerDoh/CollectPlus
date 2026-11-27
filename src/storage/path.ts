/**
 * 安全路径清洗、目录命名规范与媒体资产相对路径生成工具。
 *
 * 所有生成的路径均为相对于 CollectVault/ 或条目目录的 POSIX 风格相对路径（`/` 分隔）。
 */

import type { CapturedAssetInput, CapturedPayload } from '../types/adapter.ts';
import type { MediaAsset, PlatformId } from '../types/schema.ts';

/**
 * Windows / macOS 与 Chromium File System Access API（IsSafePathComponent / IsFilenameLegal）
 * 禁止或不安全的目录名字符：
 * - OS 非法字符：< > : " / \ | ? *
 * - Chromium 禁止字符：~（ASCII 波浪号，Chromium Issue #40228805）
 * - 点号 .：避免目录名触发 Chromium 危险后缀/Shell 集成后缀拦截（.local/.lnk/.crswap/.js/.exe 等）及隐藏目录
 * - Unicode 控制字符 (\p{Cc})、格式/零宽/Bidi 控制字符 (\p{Cf})、孤立代理项 (\p{Surrogate})
 */
const ILLEGAL_SEGMENT_CHAR_RE =
  /[<>:"/\\|?*~.]|\p{Cc}|\p{Cf}|\p{Surrogate}/u;
const ILLEGAL_SEGMENT_CHARS_GLOBAL_RE = new RegExp(
  ILLEGAL_SEGMENT_CHAR_RE.source,
  'gu',
);

/** Windows 保留设备名（不区分大小写，含 COM0~9/LPT0~9、上标数字及附带扩展名形式） */
const WINDOWS_RESERVED_NAME_RE =
  /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;

/** MIME 类型到标准扩展名映射表 */
const MIME_TO_EXT_MAP: Readonly<Record<string, string>> = {
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'video/quicktime': '.mov',
  'video/x-matroska': '.mkv',
  'video/x-flv': '.flv',
  'video/mp2t': '.ts',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/avif': '.avif',
  'image/heic': '.heic',
  'image/heif': '.heif',
  'image/bmp': '.bmp',
  'image/svg+xml': '.svg',
  'audio/mp4': '.m4a',
  'audio/x-m4a': '.m4a',
  'audio/mpeg': '.mp3',
  'audio/mp3': '.mp3',
  'audio/aac': '.aac',
  'audio/webm': '.weba',
  'audio/ogg': '.ogg',
  'audio/wav': '.wav',
  'audio/flac': '.flac',
};

/** 已知合法媒体扩展名到默认 MIME 类型映射（用于从 URL/hint 推断封面等扩展名） */
const KNOWN_IMAGE_EXT_TO_MIME: Readonly<Record<string, string>> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
};

const KNOWN_VIDEO_EXTS: ReadonlySet<string> = new Set([
  '.mp4',
  '.webm',
  '.mov',
  '.mkv',
  '.flv',
  '.m4v',
]);

const KNOWN_AUDIO_EXTS: ReadonlySet<string> = new Set([
  '.m4a',
  '.mp3',
  '.aac',
  '.weba',
  '.ogg',
  '.wav',
  '.flac',
]);

/** 按 Unicode 码点安全截断字符串，避免截断中文或 Emoji 代理对 */
function sliceByCodePoints(text: string, maxCodePoints: number): string {
  if (maxCodePoints <= 0) {
    return '';
  }
  const codePoints = Array.from(text);
  if (codePoints.length <= maxCodePoints) {
    return text;
  }
  return codePoints.slice(0, maxCodePoints).join('');
}

/** 去除首尾空白与点号（Windows 不允许文件名/目录名以空格或点结尾） */
function trimSpacesAndDots(text: string): string {
  return text.replace(/^[\s.]+|[\s.]+$/g, '');
}

/**
 * 清洗单个文件名或目录名段，确保跨 Windows / macOS 及 Chromium File System Access API 安全合法。
 *
 * - 替换 OS 非法字符、ASCII 波浪号 `~`、点号 `.`、Unicode 控制/格式字符与孤立代理项
 * - 将所有空白（含全角空格、NBSP、Unicode 行分隔符）折叠为单 ASCII 空格
 * - 去除首尾空格与点号
 * - 按 Unicode 码点安全截断
 * - 规避 Windows 保留设备名（CON, PRN, AUX, NUL, COM0~9, LPT0~9）
 */
export function sanitizeFilenameSegment(
  input: string,
  maxCodePoints = 64,
  fallback = 'untitled',
): string {
  const safeLimit =
    Number.isFinite(maxCodePoints) && maxCodePoints > 0
      ? Math.floor(maxCodePoints)
      : 64;

  let cleaned = input
    .replace(ILLEGAL_SEGMENT_CHARS_GLOBAL_RE, ' ')
    .replace(/\s+/g, ' ');
  cleaned = trimSpacesAndDots(cleaned);
  cleaned = sliceByCodePoints(cleaned, safeLimit);
  cleaned = trimSpacesAndDots(cleaned);

  if (!cleaned) {
    const cleanFallback = trimSpacesAndDots(
      fallback
        .replace(ILLEGAL_SEGMENT_CHARS_GLOBAL_RE, ' ')
        .replace(/\s+/g, ' '),
    );
    cleaned = sliceByCodePoints(cleanFallback || 'untitled', safeLimit);
    cleaned = trimSpacesAndDots(cleaned) || 'untitled';
  }

  if (WINDOWS_RESERVED_NAME_RE.test(cleaned)) {
    const prefixed = `_${cleaned}`;
    cleaned =
      safeLimit > 1 ? sliceByCodePoints(prefixed, safeLimit) : prefixed;
    cleaned = trimSpacesAndDots(cleaned) || '_untitled';
  }

  return cleaned;
}

/** 清洗条目标题用于目录命名，空字符串兜底为 `'untitled'` */
export function sanitizeTitle(rawTitle: string, maxLen = 36): string {
  return sanitizeFilenameSegment(rawTitle, maxLen, 'untitled');
}

function toValidDate(timestampMs: number): Date {
  return Number.isFinite(timestampMs) ? new Date(timestampMs) : new Date();
}

function pad2(num: number): string {
  return String(num).padStart(2, '0');
}

/** 将时间戳（毫秒）按本地时区格式化为 `YYYY-MM` */
export function formatYearMonth(timestampMs: number): string {
  const date = toValidDate(timestampMs);
  const year = date.getFullYear();
  const month = pad2(date.getMonth() + 1);
  return `${year}-${month}`;
}

/** 将时间戳（毫秒）按本地时区格式化为 `YYYYMMDD` */
export function formatYearMonthDay(timestampMs: number): string {
  const date = toValidDate(timestampMs);
  const year = date.getFullYear();
  const month = pad2(date.getMonth() + 1);
  const day = pad2(date.getDate());
  return `${year}${month}${day}`;
}

/**
 * 构建条目相对 `CollectVault/` 根目录的标准目录路径：
 * `items/{platform}/{YYYY-MM}/{YYYYMMDD}_{sanitizedSourceId}_{sanitizedTitle}`
 */
export function buildItemRelativeDir(
  platform: PlatformId,
  sourceId: string,
  title: string,
  collectedAt: number,
): string {
  const yearMonth = formatYearMonth(collectedAt);
  const yearMonthDay = formatYearMonthDay(collectedAt);
  const safeSourceId = sanitizeFilenameSegment(sourceId, 40, 'item');
  const safeTitle = sanitizeTitle(title, 36);
  return `items/${platform}/${yearMonth}/${yearMonthDay}_${safeSourceId}_${safeTitle}`;
}

/**
 * 构建不含标题的纯 ASCII 兜底目录路径（仅含 `[a-zA-Z0-9_-]`），
 * 当未来浏览器对目录名施加未预见限制导致 `Name is not allowed` 时使用。
 */
export function buildFallbackItemRelativeDir(
  platform: PlatformId,
  sourceId: string,
  collectedAt: number,
  itemId: string,
): string {
  const yearMonth = formatYearMonth(collectedAt);
  const yearMonthDay = formatYearMonthDay(collectedAt);
  const asciiSourceId = sourceId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40);
  const asciiItemId = itemId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40);
  const safeId = asciiSourceId || asciiItemId || 'item';
  return `items/${platform}/${yearMonth}/${yearMonthDay}_${safeId}`;
}

function isSafeVaultDirSegment(segment: string): boolean {
  if (!segment || segment !== segment.replace(/\s+/g, ' ').trim()) {
    return false;
  }
  if (ILLEGAL_SEGMENT_CHAR_RE.test(segment)) {
    return false;
  }
  if (WINDOWS_RESERVED_NAME_RE.test(segment)) {
    return false;
  }
  return true;
}

/** 校验条目相对目录路径的每一段是否都满足 Chromium 本地 File System Access API 命名安全约束 */
export function isSafeVaultRelativeDir(relativeDir: string): boolean {
  let segments: string[];
  try {
    segments = splitRelativePath(relativeDir);
  } catch {
    return false;
  }
  if (segments.length === 0) {
    return false;
  }
  return segments.every((seg) => isSafeVaultDirSegment(seg));
}

function normalizeExtension(ext: string): string {
  const trimmed = ext.trim().toLowerCase();
  if (!trimmed) {
    return '';
  }
  return trimmed.startsWith('.') ? trimmed : `.${trimmed}`;
}

/** 根据 MIME 类型推断文件扩展名（包含前导点号），无法识别时回退到 `fallbackExt` */
export function inferExtensionFromMime(
  mimeType: string,
  fallbackExt: string,
): string {
  const baseMime = mimeType.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  const mapped = MIME_TO_EXT_MAP[baseMime];
  if (mapped) {
    return mapped;
  }
  return normalizeExtension(fallbackExt);
}

/** 从 URL 路径或文件名提示中提取符合预期类型的已知扩展名 */
function extractExtensionFromHint(
  hintOrUrl: string | undefined,
  allowedExtensions: ReadonlySet<string> | Readonly<Record<string, string>>,
): string | undefined {
  if (!hintOrUrl) {
    return undefined;
  }

  let candidatePath = hintOrUrl.trim();
  if (!candidatePath) {
    return undefined;
  }

  try {
    const parsed = new URL(candidatePath);
    candidatePath = parsed.pathname;
  } catch {
    // 非完整 URL（例如纯文件名 hint），去除查询串/锚点后直接解析
    candidatePath = candidatePath.split(/[?#]/, 1)[0] ?? candidatePath;
  }

  const lastSegment = candidatePath.split('/').pop() ?? '';
  const dotIdx = lastSegment.lastIndexOf('.');
  if (dotIdx <= 0 || dotIdx === lastSegment.length - 1) {
    return undefined;
  }

  const rawExt = lastSegment.slice(dotIdx).toLowerCase();
  const normalizedExt = rawExt === '.jpeg' ? '.jpg' : rawExt;

  if (allowedExtensions instanceof Set) {
    return allowedExtensions.has(normalizedExt) ? normalizedExt : undefined;
  }
  return Object.prototype.hasOwnProperty.call(allowedExtensions, rawExt)
    ? normalizedExt
    : undefined;
}

function resolveAssetExtension(asset: CapturedAssetInput): string {
  const baseMime = asset.mimeType.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  const fromMime = MIME_TO_EXT_MAP[baseMime];
  if (fromMime) {
    return fromMime;
  }

  if (asset.kind === 'video') {
    return (
      extractExtensionFromHint(asset.filenameHint, KNOWN_VIDEO_EXTS) ??
      extractExtensionFromHint(asset.sourceUrl, KNOWN_VIDEO_EXTS) ??
      '.mp4'
    );
  }

  if (asset.kind === 'audio') {
    return (
      extractExtensionFromHint(asset.filenameHint, KNOWN_AUDIO_EXTS) ??
      extractExtensionFromHint(asset.sourceUrl, KNOWN_AUDIO_EXTS) ??
      '.m4a'
    );
  }

  return (
    extractExtensionFromHint(asset.filenameHint, KNOWN_IMAGE_EXT_TO_MIME) ??
    extractExtensionFromHint(asset.sourceUrl, KNOWN_IMAGE_EXT_TO_MIME) ??
    '.jpg'
  );
}

/**
 * 将平台适配器采集的 `CapturedPayload` 转换为带规范化相对路径的 `MediaAsset[]`。
 *
 * 命名规则：
 * - 封面：`cover.jpg`（按 URL 推断合法图片后缀，默认 `.jpg`）
 * - 单视频：`video.mp4`；多视频：`media/video-01.mp4`, `media/video-02.mp4`...
 * - 图集/图片：`media/01.jpg`, `media/02.jpg`...
 * - 单音频：`audio.m4a`；多音频：`media/audio-01.m4a`...
 */
export function buildMediaAssetsFromPayload(payload: CapturedPayload): {
  assets: MediaAsset[];
  coverRelativePath?: string;
} {
  const assets: MediaAsset[] = [];
  let coverRelativePath: string | undefined;

  const trimmedCoverUrl = payload.coverUrl?.trim();
  if (trimmedCoverUrl) {
    const coverExt =
      extractExtensionFromHint(trimmedCoverUrl, KNOWN_IMAGE_EXT_TO_MIME) ??
      '.jpg';
    const coverPath = `cover${coverExt}`;
    const coverMime = KNOWN_IMAGE_EXT_TO_MIME[coverExt] ?? 'image/jpeg';

    const coverAsset: MediaAsset = {
      id: 'cover',
      kind: 'cover',
      strategy: 'direct',
      sourceUrl: trimmedCoverUrl,
      relativePath: coverPath,
      mimeType: coverMime,
      downloaded: false,
      ...(payload.coverFallbackUrls && payload.coverFallbackUrls.length > 0
        ? { fallbackUrls: [...payload.coverFallbackUrls] }
        : {}),
    };

    assets.push(coverAsset);
    coverRelativePath = coverPath;
  }

  const videoTotal = payload.assets.filter((a) => a.kind === 'video').length;
  const audioTotal = payload.assets.filter((a) => a.kind === 'audio').length;

  let videoIndex = 0;
  let imageIndex = 0;
  let audioIndex = 0;
  let extraCoverIndex = 0;

  for (const input of payload.assets) {
    const ext = resolveAssetExtension(input);
    let relativePath: string;

    switch (input.kind) {
      case 'video': {
        videoIndex += 1;
        relativePath =
          videoTotal <= 1
            ? `video${ext}`
            : `media/video-${pad2(videoIndex)}${ext}`;
        break;
      }
      case 'image': {
        imageIndex += 1;
        relativePath = `media/${pad2(imageIndex)}${ext}`;
        break;
      }
      case 'audio': {
        audioIndex += 1;
        relativePath =
          audioTotal <= 1
            ? `audio${ext}`
            : `media/audio-${pad2(audioIndex)}${ext}`;
        break;
      }
      case 'cover': {
        if (!coverRelativePath) {
          relativePath = `cover${ext}`;
          coverRelativePath = relativePath;
        } else {
          extraCoverIndex += 1;
          relativePath = `media/cover-${pad2(extraCoverIndex)}${ext}`;
        }
        break;
      }
    }

    const mediaAsset: MediaAsset = {
      id: input.id,
      kind: input.kind,
      strategy: input.strategy,
      sourceUrl: input.sourceUrl,
      relativePath,
      mimeType: input.mimeType,
      downloaded: false,
      ...(input.fallbackUrls && input.fallbackUrls.length > 0
        ? { fallbackUrls: [...input.fallbackUrls] }
        : {}),
      ...(input.audioUrl !== undefined ? { audioUrl: input.audioUrl } : {}),
      ...(input.audioFallbackUrls && input.audioFallbackUrls.length > 0
        ? { audioFallbackUrls: [...input.audioFallbackUrls] }
        : {}),
      ...(input.width !== undefined ? { width: input.width } : {}),
      ...(input.height !== undefined ? { height: input.height } : {}),
      ...(input.durationSec !== undefined
        ? { durationSec: input.durationSec }
        : {}),
      ...(typeof input.sizeBytes === 'number' &&
      Number.isFinite(input.sizeBytes) &&
      input.sizeBytes > 0
        ? { sizeBytes: Math.floor(input.sizeBytes) }
        : {}),
    };

    assets.push(mediaAsset);
  }

  return coverRelativePath !== undefined
    ? { assets, coverRelativePath }
    : { assets };
}

/**
 * 规范化相对路径并拆分为安全的路径段数组。
 *
 * - 将 `\` 统一转换为 `/`
 * - 过滤连续斜杠产生的空段
 * - 严格拒绝 `.`、`..`、空字符及 Windows 盘符，防止路径穿越
 */
export function splitRelativePath(relativePath: string): string[] {
  if (relativePath.includes('\0')) {
    throw new Error(`Invalid relative path containing NUL byte: ${relativePath}`);
  }

  const normalized = relativePath.replace(/\\/g, '/');
  const rawSegments = normalized.split('/');
  const segments: string[] = [];

  for (const rawSeg of rawSegments) {
    if (rawSeg === '') {
      continue;
    }
    if (rawSeg === '.' || rawSeg === '..') {
      throw new Error(
        `Path traversal segment "${rawSeg}" is forbidden in relative path: ${relativePath}`,
      );
    }
    if (/^[a-zA-Z]:$/.test(rawSeg)) {
      throw new Error(
        `Absolute drive prefix "${rawSeg}" is forbidden in relative path: ${relativePath}`,
      );
    }
    segments.push(rawSeg);
  }

  return segments;
}
