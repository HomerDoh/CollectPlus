/**
 * 方案 A 流式媒体下载与无损混流执行管线（运行于 Offscreen Document）。
 *
 * 职责：
 * 1. `direct`：使用原生 `fetch()` + `ReadableStream` 直接流式写入 OPFS，支持备用 CDN 自动切换、
 *    响应头超时保护、5xx 短退避重试与 `AbortSignal` 实时取消；
 * 2. `dash_mux`：基于 `mediabunny` 拉取视频流与可选独立 `audioUrl` 音频流，无损封装混流为 MP4 写入 OPFS；
 * 3. `hls_mux`：解析 M3U8 播放列表、按序拉取媒体分片并通过 `mediabunny` 无损封装为 MP4 写入 OPFS
 *    （遇到分离音轨或 AES-128 加密流时无缝交由 `mediabunny` 原生 HLS 解封装管线处理）；
 * 4. 整任务调度（视频串行 + 图片最多 3 路并发）、250ms 节流进度上报与离线 WebP 封面缩略图生成。
 */

import {
  ADTS,
  BufferSource,
  Conversion,
  EncodedAudioPacketSource,
  EncodedPacketSink,
  EncodedVideoPacketSource,
  FLAC,
  HLS_FORMATS,
  Input,
  MATROSKA,
  MP3,
  MP4,
  MPEG_TS,
  Mp4OutputFormat,
  OGG,
  Output,
  QTFF,
  StreamTarget,
  UrlSource,
  WEBM,
  type AudioCodec,
  type InputFormat,
  type StreamTargetChunk,
  type VideoCodec,
} from 'mediabunny';
import {
  getOpfsStageRoot,
  readFileFromOpfs,
  writeBlobToOpfs,
  writeStreamToOpfs,
} from '../storage/opfs.ts';
import { inferExtensionFromMime, splitRelativePath } from '../storage/path.ts';
import { generateThumbnailFromBlob } from '../storage/vault.ts';
import type { CapturedCommentInput } from '../types/adapter.ts';
import {
  SCHEMA_VERSION,
  type ItemCommentsFile,
  type MediaAsset,
  type PlatformId,
  type SavedComment,
} from '../types/schema.ts';

/** 单个 HTTP 请求等待响应头的超时阈值（毫秒） */
const FETCH_HEADER_TIMEOUT_MS = 30_000;
/** 预探测视频体积的响应头超时阈值（毫秒），避免慢节点阻塞自动保存反馈 */
const PROBE_HEADER_TIMEOUT_MS = 8_000;
/** 网络抖动或 5xx 临时错误时的退避重试等待时间（毫秒） */
const TRANSIENT_RETRY_DELAY_MS = 600;
/** 单个候选 URL 对临时错误的最大重试次数 */
const MAX_TRANSIENT_RETRIES_PER_URL = 1;
/** 图片类非视频资产的最大并发下载路数 */
const MAX_CONCURRENT_IMAGE_DOWNLOADS = 3;
/** 评论者小头像的最大并发下载路数 */
const MAX_CONCURRENT_AVATAR_DOWNLOADS = 6;
/** 评论快照固定文件名 */
export const COMMENTS_FILENAME = 'comments.json' as const;
const SAFE_AVATAR_EXTENSIONS: ReadonlySet<string> = new Set([
  '.jpg',
  '.png',
  '.webp',
  '.gif',
  '.avif',
]);
/** 进度回调最小节流间隔（毫秒） */
const PROGRESS_THROTTLE_MS = 250;
/** 离线封面缩略图默认最大宽度（像素） */
const THUMBNAIL_MAX_WIDTH = 360;

/** 立即切换备用源、不再原地重试的确定性 HTTP 状态码 */
const IMMEDIATE_FALLBACK_STATUS_CODES: ReadonlySet<number> = new Set([
  403, 404, 410,
]);

const DASH_VIDEO_FORMATS: InputFormat[] = [MP4, WEBM, MATROSKA, QTFF];
const DASH_AUDIO_FORMATS: InputFormat[] = [
  MP4,
  WEBM,
  MATROSKA,
  QTFF,
  ADTS,
  MP3,
  OGG,
  FLAC,
];
const HLS_SEGMENT_FORMATS: InputFormat[] = [MPEG_TS, MP4, ADTS, MP3];

/** 管线实时进度快照 */
export interface PipelineProgressSnapshot {
  progress: number;
  completedAssets: number;
  totalAssets: number;
  downloadedBytes: number;
  totalBytes: number;
}

/** 单次下载作业入参 */
export interface DownloadJobInput {
  itemId: string;
  assets: MediaAsset[];
  /** 文章类条目允许可选内嵌图片全部失败而不阻断正文与评论归档 */
  allowAllAssetsFailed?: boolean;
  signal?: AbortSignal;
  onProgress?: (snapshot: PipelineProgressSnapshot) => void;
}

/** 单次下载作业输出结果 */
export interface DownloadJobResult {
  assets: MediaAsset[];
  totalSizeBytes: number;
  thumbnailDataUrl?: string;
}

/** 可区分 HTTP 状态码与可重试性的内部下载错误 */
class HttpFetchError extends Error {
  readonly status: number;
  readonly url: string;

  constructor(url: string, status: number, statusText: string) {
    super(`HTTP ${status}${statusText ? ` ${statusText}` : ''} for ${url}`);
    this.name = 'HttpFetchError';
    this.status = status;
    this.url = url;
  }
}

/** 判断未知异常是否代表主动中止（AbortError） */
export function isAbortError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === 'AbortError') {
    return true;
  }
  if (error instanceof Error && error.name === 'AbortError') {
    return true;
  }
  return false;
}

function createAbortError(signal?: AbortSignal): DOMException {
  if (signal?.reason instanceof DOMException && signal.reason.name === 'AbortError') {
    return signal.reason;
  }
  if (signal?.reason instanceof Error) {
    return new DOMException(signal.reason.message, 'AbortError');
  }
  return new DOMException('The download operation was aborted.', 'AbortError');
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw createAbortError(signal);
  }
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function sleepWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(createAbortError(signal));
  }

  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(createAbortError(signal));
    };

    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** 去重并过滤空白候选 URL 列表 */
function collectUniqueUrls(rawUrls: readonly (string | undefined)[]): string[] {
  const seen = new Set<string>();
  const urls: string[] = [];

  for (const raw of rawUrls) {
    if (typeof raw !== 'string') {
      continue;
    }
    const trimmed = raw.trim();
    if (trimmed && !seen.has(trimmed)) {
      seen.add(trimmed);
      urls.push(trimmed);
    }
  }

  return urls;
}

function collectCandidateUrls(asset: MediaAsset): string[] {
  return collectUniqueUrls([asset.sourceUrl, ...(asset.fallbackUrls ?? [])]);
}

function collectAudioCandidateUrls(asset: MediaAsset): string[] {
  return collectUniqueUrls([asset.audioUrl, ...(asset.audioFallbackUrls ?? [])]);
}

function parseContentLength(headers: Headers): number | undefined {
  const raw = headers.get('content-length');
  if (!raw) {
    return undefined;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return undefined;
  }
  return Math.floor(parsed);
}

function parseContentRangeTotal(headers: Headers): number | undefined {
  const raw = headers.get('content-range');
  if (!raw) {
    return undefined;
  }
  const match = /^bytes\s+(?:\d+-\d+|\*)\/(\d+)$/i.exec(raw.trim());
  if (!match?.[1]) {
    return undefined;
  }
  const parsed = Number(match[1]);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return undefined;
  }
  return Math.floor(parsed);
}

/**
 * 轻量探测候选直链的精确字节数：
 * 1. 优先发 HEAD 读取 Content-Length；
 * 2. 若站点拒绝 HEAD 或未返回长度，回退发 GET + Range: bytes=0-0，
 *    从 206 Content-Range 或 200 Content-Length 读取后立即取消响应体，绝不下载正文。
 */
async function probeUrlSizeBytes(
  urls: readonly string[],
  signal?: AbortSignal,
): Promise<number | undefined> {
  for (const url of urls) {
    throwIfAborted(signal);

    let headDefinitivelyMissing = false;
    try {
      const headRes = await fetchWithHeaderTimeout(
        url,
        { method: 'HEAD' },
        signal,
        PROBE_HEADER_TIMEOUT_MS,
      );
      if (headRes.ok) {
        const len = parseContentLength(headRes.headers);
        if (len !== undefined && len > 0) {
          return len;
        }
      } else if (headRes.status === 404 || headRes.status === 410) {
        headDefinitivelyMissing = true;
      }
    } catch (error) {
      if (signal?.aborted || isAbortError(error)) {
        throw createAbortError(signal);
      }
    }

    if (headDefinitivelyMissing) {
      continue;
    }

    const rangeController = new AbortController();
    const onExternalAbort = (): void => {
      rangeController.abort(signal?.reason);
    };
    signal?.addEventListener('abort', onExternalAbort, { once: true });

    try {
      const rangeRes = await fetchWithHeaderTimeout(
        url,
        {
          method: 'GET',
          headers: { Range: 'bytes=0-0' },
        },
        rangeController.signal,
        PROBE_HEADER_TIMEOUT_MS,
      );

      let resolvedBytes: number | undefined;
      if (rangeRes.status === 206) {
        resolvedBytes = parseContentRangeTotal(rangeRes.headers);
      } else if (rangeRes.ok) {
        resolvedBytes = parseContentLength(rangeRes.headers);
      }

      void rangeRes.body?.cancel().catch(() => undefined);
      rangeController.abort();

      if (resolvedBytes !== undefined && resolvedBytes > 0) {
        return resolvedBytes;
      }
    } catch (error) {
      if (signal?.aborted || isAbortError(error)) {
        throw createAbortError(signal);
      }
    } finally {
      signal?.removeEventListener('abort', onExternalAbort);
    }
  }

  return undefined;
}

function sumM3u8DurationSec(manifestText: string): number {
  let totalSec = 0;
  const regex = /^#EXTINF:([0-9]+(?:\.[0-9]+)?)/gm;
  let match = regex.exec(manifestText);
  while (match !== null) {
    const val = Number(match[1]);
    if (Number.isFinite(val) && val > 0) {
      totalSec += val;
    }
    match = regex.exec(manifestText);
  }
  return totalSec;
}

async function probeHlsAssetSizeBytes(
  asset: MediaAsset,
  signal?: AbortSignal,
): Promise<number | undefined> {
  const candidates = collectCandidateUrls(asset);
  for (const manifestUrl of candidates) {
    throwIfAborted(signal);
    try {
      const rootManifest = await fetchTextWithRetry(manifestUrl, signal);
      let parsed = parseM3u8Playlist(rootManifest.text, rootManifest.finalUrl);
      let mediaText = rootManifest.text;
      let variantBandwidth = 0;

      if (parsed.isMaster) {
        const sortedVariants = [...parsed.variants].sort(
          (a, b) => b.bandwidth - a.bandwidth,
        );
        const bestVariant = sortedVariants[0];
        if (!bestVariant) {
          continue;
        }
        variantBandwidth = bestVariant.bandwidth;
        const mediaManifest = await fetchTextWithRetry(bestVariant.url, signal);
        mediaText = mediaManifest.text;
        parsed = parseM3u8Playlist(mediaManifest.text, mediaManifest.finalUrl);
      }

      if (
        parsed.segments.length > 0 &&
        parsed.segments.every((seg) => seg.byteRange !== undefined)
      ) {
        let total = parsed.initSegment?.byteRange?.length ?? 0;
        for (const seg of parsed.segments) {
          total += seg.byteRange?.length ?? 0;
        }
        if (total > 0) {
          return total;
        }
      }

      if (variantBandwidth > 0) {
        const totalDurationSec = sumM3u8DurationSec(mediaText);
        if (totalDurationSec > 0) {
          return Math.round((variantBandwidth / 8) * totalDurationSec);
        }
      }
    } catch (error) {
      if (signal?.aborted || isAbortError(error)) {
        throw createAbortError(signal);
      }
    }
  }
  return undefined;
}

/**
 * 在不下载媒体正文的前提下，解析或探测视频资产列表的总体积（字节）。
 * 无法获取任何有效体积时返回 `undefined`（由调用方按放行处理）。
 */
export async function probeVideoAssetsSizeBytes(
  assets: readonly MediaAsset[],
  signal?: AbortSignal,
): Promise<number | undefined> {
  const videoAssets = assets.filter((asset) => asset.kind === 'video');
  if (videoAssets.length === 0) {
    return undefined;
  }

  let totalBytes = 0;
  let knownCount = 0;

  for (const asset of videoAssets) {
    throwIfAborted(signal);

    if (
      typeof asset.sizeBytes === 'number' &&
      Number.isFinite(asset.sizeBytes) &&
      asset.sizeBytes > 0
    ) {
      totalBytes += Math.floor(asset.sizeBytes);
      knownCount += 1;
      continue;
    }

    let probed: number | undefined;
    switch (asset.strategy) {
      case 'direct': {
        probed = await probeUrlSizeBytes(collectCandidateUrls(asset), signal);
        break;
      }
      case 'dash_mux': {
        const videoCandidates = collectCandidateUrls(asset);
        const audioCandidates = collectAudioCandidateUrls(asset);
        const [videoBytes, audioBytes] = await Promise.all([
          probeUrlSizeBytes(videoCandidates, signal),
          audioCandidates.length > 0
            ? probeUrlSizeBytes(audioCandidates, signal)
            : Promise.resolve(undefined),
        ]);
        if (videoBytes !== undefined && videoBytes > 0) {
          probed = videoBytes + (audioBytes ?? 0);
        }
        break;
      }
      case 'hls_mux': {
        probed = await probeHlsAssetSizeBytes(asset, signal);
        break;
      }
    }

    if (probed !== undefined && probed > 0) {
      totalBytes += probed;
      knownCount += 1;
    }
  }

  return knownCount > 0 && totalBytes > 0 ? totalBytes : undefined;
}

/**
 * 发起带响应头超时保护与外部 `AbortSignal` 联动的 `fetch()` 请求。
 *
 * 仅在等待 HTTP 响应头阶段启用 30s 超时；一旦拿到响应头立即清除定时器，
 * 避免大体积视频流式下载超过 30s 被误杀。
 */
async function fetchWithHeaderTimeout(
  input: RequestInfo | URL,
  init: Omit<RequestInit, 'signal'> | undefined,
  externalSignal?: AbortSignal,
  timeoutMs = FETCH_HEADER_TIMEOUT_MS,
): Promise<Response> {
  throwIfAborted(externalSignal);

  const controller = new AbortController();
  let timedOut = false;

  const onExternalAbort = (): void => {
    controller.abort(externalSignal?.reason);
  };
  externalSignal?.addEventListener('abort', onExternalAbort, { once: true });

  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    return await fetch(input, {
      ...init,
      credentials: 'omit',
      signal: controller.signal,
    });
  } catch (error) {
    if (externalSignal?.aborted) {
      throw createAbortError(externalSignal);
    }
    if (timedOut) {
      throw new Error(
        `Request timed out after ${Math.round(timeoutMs / 1000)}s waiting for response headers.`,
      );
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
    externalSignal?.removeEventListener('abort', onExternalAbort);
  }
}

/** 为 Mediabunny `UrlSource` 构造受控 `fetchFn`（透传外部取消信号与 30s 响应头超时） */
function createMediabunnyFetchFn(
  externalSignal?: AbortSignal,
): typeof fetch {
  return async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    throwIfAborted(externalSignal);

    const controller = new AbortController();
    let timedOut = false;

    const internalSignal = init?.signal ?? undefined;
    const onExternalAbort = (): void => {
      controller.abort(externalSignal?.reason);
    };
    const onInternalAbort = (): void => {
      controller.abort(internalSignal?.reason);
    };

    if (internalSignal?.aborted) {
      controller.abort(internalSignal.reason);
    }

    externalSignal?.addEventListener('abort', onExternalAbort, { once: true });
    internalSignal?.addEventListener('abort', onInternalAbort, { once: true });

    const timeoutId = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, FETCH_HEADER_TIMEOUT_MS);

    try {
      const response = await fetch(input, {
        ...init,
        credentials: 'omit',
        signal: controller.signal,
      });

      if (!response.ok && IMMEDIATE_FALLBACK_STATUS_CODES.has(response.status)) {
        throw new HttpFetchError(
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.href
              : input.url,
          response.status,
          response.statusText,
        );
      }

      return response;
    } catch (error) {
      if (externalSignal?.aborted) {
        throw createAbortError(externalSignal);
      }
      if (timedOut) {
        throw new Error(
          `Request timed out after ${Math.round(FETCH_HEADER_TIMEOUT_MS / 1000)}s waiting for response headers.`,
        );
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
      externalSignal?.removeEventListener('abort', onExternalAbort);
      internalSignal?.removeEventListener('abort', onInternalAbort);
    }
  };
}

/** Mediabunny `UrlSource` 有限重试策略：403/404/410 与主动取消立即放弃，临时错误最多重试 1 次 */
function createUrlSourceRetryPolicy(
  externalSignal?: AbortSignal,
): (previousAttempts: number, error: unknown) => number | null {
  return (previousAttempts: number, error: unknown): number | null => {
    if (externalSignal?.aborted || isAbortError(error)) {
      return null;
    }
    if (
      error instanceof HttpFetchError &&
      IMMEDIATE_FALLBACK_STATUS_CODES.has(error.status)
    ) {
      return null;
    }
    if (previousAttempts < MAX_TRANSIENT_RETRIES_PER_URL) {
      return TRANSIENT_RETRY_DELAY_MS / 1000;
    }
    return null;
  };
}

function assertValidItemId(itemId: string): string {
  const trimmed = itemId.trim();
  if (
    !trimmed ||
    trimmed === '.' ||
    trimmed === '..' ||
    trimmed.includes('/') ||
    trimmed.includes('\\') ||
    trimmed.includes('\0')
  ) {
    throw new Error(`Invalid OPFS itemId: "${itemId}"`);
  }
  return trimmed;
}

/** 删除 OPFS 暂存区中的单个残缺/空文件（不存在时静默忽略） */
async function removeOpfsFileSilently(
  itemId: string,
  relativePath: string,
): Promise<void> {
  try {
    const safeItemId = assertValidItemId(itemId);
    const segments = splitRelativePath(relativePath);
    const fileName = segments[segments.length - 1];
    if (!fileName) {
      return;
    }
    const stageRoot = await getOpfsStageRoot();
    let dir = await stageRoot.getDirectoryHandle(safeItemId, { create: false });
    for (let i = 0; i < segments.length - 1; i += 1) {
      const seg = segments[i];
      if (!seg) {
        continue;
      }
      dir = await dir.getDirectoryHandle(seg, { create: false });
    }
    await dir.removeEntry(fileName);
  } catch {
    // 清理阶段忽略不存在等错误
  }
}

/**
 * 在 OPFS `collect-plus-stage/{itemId}/{relativePath}` 上打开一个供 Mediabunny `StreamTarget`
 * 直接写入的流式目标，保证异常或取消时安全 abort 并删除残缺文件。
 */
async function withOpfsStreamTarget(
  itemId: string,
  relativePath: string,
  signal: AbortSignal | undefined,
  runner: (target: StreamTarget) => Promise<void>,
): Promise<number> {
  throwIfAborted(signal);

  const safeItemId = assertValidItemId(itemId);
  const segments = splitRelativePath(relativePath);
  const fileName = segments[segments.length - 1];
  if (!fileName) {
    throw new Error(`Invalid relativePath for OPFS target: "${relativePath}"`);
  }

  const stageRoot = await getOpfsStageRoot();
  let parentDir = await stageRoot.getDirectoryHandle(safeItemId, {
    create: true,
  });
  for (let i = 0; i < segments.length - 1; i += 1) {
    const seg = segments[i];
    if (!seg) {
      continue;
    }
    parentDir = await parentDir.getDirectoryHandle(seg, { create: true });
  }

  const fileHandle = await parentDir.getFileHandle(fileName, { create: true });
  const fileWritable = await fileHandle.createWritable();

  let maxEndOffset = 0;
  let writableClosed = false;

  const targetStream = new WritableStream<StreamTargetChunk>({
    async write(chunk) {
      throwIfAborted(signal);
      await fileWritable.write({
        type: 'write',
        position: chunk.position,
        data: chunk.data,
      });
      const endOffset = chunk.position + chunk.data.byteLength;
      if (endOffset > maxEndOffset) {
        maxEndOffset = endOffset;
      }
    },
    async close() {
      if (!writableClosed) {
        await fileWritable.close();
        writableClosed = true;
      }
    },
    async abort() {
      if (!writableClosed) {
        await fileWritable.abort().catch(() => undefined);
        writableClosed = true;
      }
    },
  });

  const streamTarget = new StreamTarget(targetStream);

  try {
    await runner(streamTarget);
    if (!writableClosed) {
      await fileWritable.close();
      writableClosed = true;
    }
    if (maxEndOffset <= 0) {
      await parentDir.removeEntry(fileName).catch(() => undefined);
      throw new Error(`Muxed output file "${relativePath}" is empty (0 bytes).`);
    }
    return maxEndOffset;
  } catch (error) {
    if (!writableClosed) {
      await fileWritable.abort().catch(() => undefined);
      writableClosed = true;
    }
    await parentDir.removeEntry(fileName).catch(() => undefined);
    throw error;
  }
}

// ============================================================================
// 1. 直链流式下载（strategy === 'direct'）
// ============================================================================

export interface AssetProgressHooks {
  onResetBytes: () => void;
  onDeltaBytes: (deltaBytes: number) => void;
  onKnownTotalBytes: (totalBytes: number) => void;
}

const NOOP_PROGRESS_HOOKS: AssetProgressHooks = {
  onResetBytes: () => undefined,
  onDeltaBytes: () => undefined,
  onKnownTotalBytes: () => undefined,
};

function isRetryableHttpStatus(status: number): boolean {
  return status >= 500 || status === 429 || status === 408;
}

async function downloadDirectAssetToOpfs(
  itemId: string,
  asset: MediaAsset,
  hooks: AssetProgressHooks,
  signal?: AbortSignal,
): Promise<number> {
  const candidates = collectCandidateUrls(asset);
  if (candidates.length === 0) {
    throw new Error(`Asset "${asset.id}" has no valid source URL.`);
  }

  let lastError: unknown = new Error(
    `Failed to download asset "${asset.id}" from all candidate URLs.`,
  );

  for (const url of candidates) {
    throwIfAborted(signal);

    for (let attempt = 0; attempt <= MAX_TRANSIENT_RETRIES_PER_URL; attempt += 1) {
      throwIfAborted(signal);
      hooks.onResetBytes();

      try {
        const response = await fetchWithHeaderTimeout(
          url,
          { method: 'GET' },
          signal,
        );

        if (!response.ok) {
          throw new HttpFetchError(url, response.status, response.statusText);
        }

        const contentLength = parseContentLength(response.headers);
        if (contentLength !== undefined) {
          hooks.onKnownTotalBytes(contentLength);
        }

        let writtenBytes: number;
        if (response.body) {
          writtenBytes = await writeStreamToOpfs(
            itemId,
            asset.relativePath,
            response.body,
            hooks.onDeltaBytes,
            signal,
          );
        } else {
          const blob = await response.blob();
          throwIfAborted(signal);
          writtenBytes = await writeBlobToOpfs(itemId, asset.relativePath, blob);
          if (writtenBytes > 0) {
            hooks.onDeltaBytes(writtenBytes);
          }
        }

        if (writtenBytes <= 0) {
          await removeOpfsFileSilently(itemId, asset.relativePath);
          throw new Error(`Empty response body (0 bytes) from ${url}`);
        }

        return writtenBytes;
      } catch (error) {
        if (signal?.aborted || isAbortError(error)) {
          throw createAbortError(signal);
        }

        lastError = error;

        // 403 / 404 / 410 立即切换下一个备用 CDN，不原地重试
        if (error instanceof HttpFetchError) {
          if (IMMEDIATE_FALLBACK_STATUS_CODES.has(error.status)) {
            break;
          }
          if (
            isRetryableHttpStatus(error.status) &&
            attempt < MAX_TRANSIENT_RETRIES_PER_URL
          ) {
            await sleepWithSignal(TRANSIENT_RETRY_DELAY_MS, signal);
            continue;
          }
          break;
        }

        // 网络抖动或超时：短退避重试 1 次，仍失败则切下一个候选 URL
        if (attempt < MAX_TRANSIENT_RETRIES_PER_URL) {
          await sleepWithSignal(TRANSIENT_RETRY_DELAY_MS, signal);
          continue;
        }
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error(getErrorMessage(lastError));
}

// ============================================================================
// 2. DASH 音视频流无损混流（strategy === 'dash_mux'）
// ============================================================================

/**
 * 拉取 DASH 视频流与可选独立 `audioUrl` 音频流，通过 Mediabunny 无损混流为 MP4 写入 OPFS。
 */
export async function muxDashToOpfs(
  itemId: string,
  asset: MediaAsset,
  hooks: AssetProgressHooks = NOOP_PROGRESS_HOOKS,
  signal?: AbortSignal,
): Promise<number> {
  const candidates = collectCandidateUrls(asset);
  if (candidates.length === 0) {
    throw new Error(`DASH asset "${asset.id}" has no valid video URL.`);
  }

  const audioCandidates = collectAudioCandidateUrls(asset);
  const audioAttemptList: Array<string | undefined> =
    audioCandidates.length > 0 ? audioCandidates.slice(0, 3) : [undefined];
  let lastError: unknown = new Error(
    `Failed to mux DASH asset "${asset.id}" from all candidate URLs.`,
  );

  for (const videoUrl of candidates) {
    for (const audioUrl of audioAttemptList) {
      throwIfAborted(signal);
      hooks.onResetBytes();

      const fetchFn = createMediabunnyFetchFn(signal);
      const getRetryDelay = createUrlSourceRetryPolicy(signal);

      const videoSource = new UrlSource(videoUrl, {
        fetchFn,
        requestInit: { credentials: 'omit' },
        getRetryDelay,
      });
      const audioSource = audioUrl
        ? new UrlSource(audioUrl, {
            fetchFn,
            requestInit: { credentials: 'omit' },
            getRetryDelay,
          })
        : null;

      videoSource.on('read', ({ start, end }) => {
        if (end > start) {
          hooks.onDeltaBytes(end - start);
        }
      });
      audioSource?.on('read', ({ start, end }) => {
        if (end > start) {
          hooks.onDeltaBytes(end - start);
        }
      });

      const videoInput = new Input({
        source: videoSource,
        formats: DASH_VIDEO_FORMATS,
      });
      const audioInput = audioSource
        ? new Input({
            source: audioSource,
            formats: DASH_AUDIO_FORMATS,
          })
        : null;

      let activeOutput: Output | null = null;
      let videoConversion: Conversion | null = null;
      let audioConversion: Conversion | null = null;

      const onAbort = (): void => {
        void videoConversion?.cancel().catch(() => undefined);
        void audioConversion?.cancel().catch(() => undefined);
        void activeOutput?.cancel().catch(() => undefined);
        videoInput.dispose();
        audioInput?.dispose();
      };
      signal?.addEventListener('abort', onAbort, { once: true });

      try {
        const [videoSize, audioSize] = await Promise.all([
          videoSource.getSizeOrNull().catch(() => null),
          audioSource ? audioSource.getSizeOrNull().catch(() => null) : Promise.resolve(0),
        ]);

        const knownTotal = (videoSize ?? 0) + (audioSize ?? 0);
        if (knownTotal > 0) {
          hooks.onKnownTotalBytes(knownTotal);
        }

        const outputBytes = await withOpfsStreamTarget(
          itemId,
          asset.relativePath,
          signal,
          async (streamTarget) => {
            const output = new Output({
              format: new Mp4OutputFormat({ fastStart: false }),
              target: streamTarget,
            });
            activeOutput = output;

            videoConversion = await Conversion.init({
              input: videoInput,
              output,
              composable: true,
              copy: { mode: 'preferred' },
              ...(audioInput ? { audio: { discard: true } } : {}),
              showWarnings: false,
            });

            if (audioInput) {
              audioConversion = await Conversion.init({
                input: audioInput,
                output,
                composable: true,
                copy: { mode: 'preferred' },
                video: { discard: true },
                showWarnings: false,
              });
            }

            if (!output.hasEnoughTracks()) {
              throw new Error(
                `No valid tracks found when muxing DASH stream for asset "${asset.id}".`,
              );
            }

            throwIfAborted(signal);
            await output.start();

            const executions: Promise<void>[] = [videoConversion.execute()];
            if (audioConversion) {
              executions.push(audioConversion.execute());
            }
            await Promise.all(executions);

            throwIfAborted(signal);
            await output.finalize();
          },
        );

        return outputBytes;
      } catch (error) {
        if (signal?.aborted || isAbortError(error)) {
          throw createAbortError(signal);
        }
        lastError = error;
      } finally {
        signal?.removeEventListener('abort', onAbort);
        videoInput.dispose();
        audioInput?.dispose();
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error(getErrorMessage(lastError));
}

// ============================================================================
// 3. HLS (M3U8) 播放列表解析与无损封装（strategy === 'hls_mux'）
// ============================================================================

interface M3u8Variant {
  url: string;
  bandwidth: number;
}

interface M3u8ByteRange {
  length: number;
  offset: number;
}

interface M3u8Segment {
  url: string;
  byteRange?: M3u8ByteRange;
}

interface ParsedM3u8Playlist {
  isMaster: boolean;
  variants: M3u8Variant[];
  hasSeparateAudioRendition: boolean;
  hasEncryption: boolean;
  hasDiscontinuity: boolean;
  initSegment?: M3u8Segment;
  segments: M3u8Segment[];
}

function parseAttributeList(raw: string): Map<string, string> {
  const attrs = new Map<string, string>();
  const attrRe = /([A-Z0-9-]+)=("([^"]*)"|[^,]*)/g;
  let match: RegExpExecArray | null = attrRe.exec(raw);
  while (match !== null) {
    const key = match[1];
    const quotedVal = match[3];
    const unquotedVal = match[2];
    if (key) {
      attrs.set(key, quotedVal !== undefined ? quotedVal : (unquotedVal ?? ''));
    }
    match = attrRe.exec(raw);
  }
  return attrs;
}

function parseByteRangeSpec(
  raw: string,
  previousEndOffset: number,
): M3u8ByteRange | undefined {
  const trimmed = raw.trim();
  const [lenStr, offsetStr] = trimmed.split('@');
  const length = Number(lenStr);
  if (!Number.isFinite(length) || length <= 0) {
    return undefined;
  }
  const offset =
    offsetStr !== undefined && offsetStr.trim() !== ''
      ? Number(offsetStr)
      : previousEndOffset;
  if (!Number.isFinite(offset) || offset < 0) {
    return undefined;
  }
  return { length: Math.floor(length), offset: Math.floor(offset) };
}

function resolvePlaylistUrl(uri: string, baseUrl: string): string {
  return new URL(uri.trim(), baseUrl).href;
}

function parseM3u8Playlist(
  manifestText: string,
  baseUrl: string,
): ParsedM3u8Playlist {
  const lines = manifestText
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n');

  let isMaster = false;
  let hasSeparateAudioRendition = false;
  let hasEncryption = false;
  let hasDiscontinuity = false;
  let initSegment: M3u8Segment | undefined;
  const variants: M3u8Variant[] = [];
  const segments: M3u8Segment[] = [];

  let pendingVariantBandwidth: number | null = null;
  let pendingByteRange: M3u8ByteRange | undefined;
  let lastByteRangeEnd = 0;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    if (line === '#EXT-X-DISCONTINUITY') {
      hasDiscontinuity = true;
      continue;
    }

    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      isMaster = true;
      const attrs = parseAttributeList(line.slice('#EXT-X-STREAM-INF:'.length));
      const bw = Number(attrs.get('BANDWIDTH') ?? attrs.get('AVERAGE-BANDWIDTH') ?? 0);
      pendingVariantBandwidth = Number.isFinite(bw) ? bw : 0;
      continue;
    }

    if (line.startsWith('#EXT-X-MEDIA:')) {
      const attrs = parseAttributeList(line.slice('#EXT-X-MEDIA:'.length));
      if (attrs.get('TYPE') === 'AUDIO' && attrs.get('URI')) {
        hasSeparateAudioRendition = true;
      }
      continue;
    }

    if (line.startsWith('#EXT-X-KEY:')) {
      const attrs = parseAttributeList(line.slice('#EXT-X-KEY:'.length));
      const method = (attrs.get('METHOD') ?? 'NONE').toUpperCase();
      if (method !== 'NONE') {
        hasEncryption = true;
      }
      continue;
    }

    if (line.startsWith('#EXT-X-MAP:')) {
      const attrs = parseAttributeList(line.slice('#EXT-X-MAP:'.length));
      const uri = attrs.get('URI');
      if (uri) {
        const rangeAttr = attrs.get('BYTERANGE');
        const mapRange = rangeAttr ? parseByteRangeSpec(rangeAttr, 0) : undefined;
        initSegment = {
          url: resolvePlaylistUrl(uri, baseUrl),
          ...(mapRange ? { byteRange: mapRange } : {}),
        };
      }
      continue;
    }

    if (line.startsWith('#EXT-X-BYTERANGE:')) {
      const parsedRange = parseByteRangeSpec(
        line.slice('#EXT-X-BYTERANGE:'.length),
        lastByteRangeEnd,
      );
      if (parsedRange) {
        pendingByteRange = parsedRange;
        lastByteRangeEnd = parsedRange.offset + parsedRange.length;
      }
      continue;
    }

    if (line.startsWith('#')) {
      continue;
    }

    const resolvedUrl = resolvePlaylistUrl(line, baseUrl);
    if (pendingVariantBandwidth !== null) {
      variants.push({
        url: resolvedUrl,
        bandwidth: pendingVariantBandwidth,
      });
      pendingVariantBandwidth = null;
    } else {
      segments.push({
        url: resolvedUrl,
        ...(pendingByteRange ? { byteRange: pendingByteRange } : {}),
      });
      pendingByteRange = undefined;
    }
  }

  return {
    isMaster,
    variants,
    hasSeparateAudioRendition,
    hasEncryption,
    hasDiscontinuity,
    ...(initSegment ? { initSegment } : {}),
    segments,
  };
}

async function fetchTextWithRetry(
  url: string,
  signal?: AbortSignal,
): Promise<{ text: string; finalUrl: string }> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= MAX_TRANSIENT_RETRIES_PER_URL; attempt += 1) {
    throwIfAborted(signal);
    try {
      const response = await fetchWithHeaderTimeout(
        url,
        { method: 'GET' },
        signal,
      );
      if (!response.ok) {
        throw new HttpFetchError(url, response.status, response.statusText);
      }
      const text = await response.text();
      return { text, finalUrl: response.url || url };
    } catch (error) {
      if (signal?.aborted || isAbortError(error)) {
        throw createAbortError(signal);
      }
      lastError = error;
      if (
        error instanceof HttpFetchError &&
        IMMEDIATE_FALLBACK_STATUS_CODES.has(error.status)
      ) {
        break;
      }
      if (attempt < MAX_TRANSIENT_RETRIES_PER_URL) {
        await sleepWithSignal(TRANSIENT_RETRY_DELAY_MS, signal);
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error(getErrorMessage(lastError));
}

async function fetchSegmentBytesWithRetry(
  segment: M3u8Segment,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const headers: Record<string, string> = {};
  if (segment.byteRange) {
    const start = segment.byteRange.offset;
    const end = start + segment.byteRange.length - 1;
    headers.Range = `bytes=${start}-${end}`;
  }

  let lastError: unknown;

  for (let attempt = 0; attempt <= MAX_TRANSIENT_RETRIES_PER_URL; attempt += 1) {
    throwIfAborted(signal);
    try {
      const response = await fetchWithHeaderTimeout(
        segment.url,
        { method: 'GET', headers },
        signal,
      );
      if (!response.ok) {
        throw new HttpFetchError(
          segment.url,
          response.status,
          response.statusText,
        );
      }
      const buffer = await response.arrayBuffer();
      if (buffer.byteLength === 0) {
        throw new Error(`Empty HLS segment (0 bytes): ${segment.url}`);
      }
      return new Uint8Array(buffer);
    } catch (error) {
      if (signal?.aborted || isAbortError(error)) {
        throw createAbortError(signal);
      }
      lastError = error;
      if (
        error instanceof HttpFetchError &&
        IMMEDIATE_FALLBACK_STATUS_CODES.has(error.status)
      ) {
        break;
      }
      if (attempt < MAX_TRANSIENT_RETRIES_PER_URL) {
        await sleepWithSignal(TRANSIENT_RETRY_DELAY_MS, signal);
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error(getErrorMessage(lastError));
}

/**
 * 当 HLS 含分离音轨或 AES-128 加密时，交由 Mediabunny 原生 `HLS_FORMATS` 管线处理。
 */
async function muxHlsViaMediabunnyNative(
  itemId: string,
  asset: MediaAsset,
  manifestUrl: string,
  hooks: AssetProgressHooks,
  signal?: AbortSignal,
): Promise<number> {
  const source = new UrlSource(manifestUrl, {
    fetchFn: createMediabunnyFetchFn(signal),
    requestInit: { credentials: 'omit' },
    getRetryDelay: createUrlSourceRetryPolicy(signal),
  });

  const input = new Input({
    source,
    formats: HLS_FORMATS,
    formatOptions: {
      hls: { offsetTimestampsByDateTime: false },
    },
  });

  input.on('source', ({ source: loadedSource }) => {
    loadedSource.on('read', ({ start, end }) => {
      if (end > start) {
        hooks.onDeltaBytes(end - start);
      }
    });
  });

  let activeOutput: Output | null = null;
  let conversion: Conversion | null = null;

  const onAbort = (): void => {
    void conversion?.cancel().catch(() => undefined);
    void activeOutput?.cancel().catch(() => undefined);
    input.dispose();
  };
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    return await withOpfsStreamTarget(
      itemId,
      asset.relativePath,
      signal,
      async (streamTarget) => {
        const output = new Output({
          format: new Mp4OutputFormat({ fastStart: false }),
          target: streamTarget,
        });
        activeOutput = output;

        conversion = await Conversion.init({
          input,
          output,
          tracks: 'primary',
          copy: { mode: 'preferred' },
          showWarnings: false,
        });

        if (!conversion.isValid) {
          throw new Error(
            `Mediabunny HLS conversion has no valid tracks for asset "${asset.id}".`,
          );
        }

        throwIfAborted(signal);
        await conversion.execute();
      },
    );
  } finally {
    signal?.removeEventListener('abort', onAbort);
    input.dispose();
  }
}

/**
 * 按序拉取解析出的 HLS 分片，使用 Mediabunny `EncodedPacketSink` + `Output(Mp4OutputFormat)`
 * 无损封装并流式写入 OPFS（内存中每次仅驻留单个分片）。
 */
async function muxParsedHlsSegmentsToOpfs(
  itemId: string,
  asset: MediaAsset,
  playlist: ParsedM3u8Playlist,
  hooks: AssetProgressHooks,
  signal?: AbortSignal,
): Promise<number> {
  if (playlist.segments.length === 0) {
    throw new Error(`HLS playlist for asset "${asset.id}" contains no media segments.`);
  }

  let initInput: Input | undefined;
  let activeOutput: Output | null = null;

  const onAbort = (): void => {
    void activeOutput?.cancel().catch(() => undefined);
    initInput?.dispose();
  };
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    if (playlist.initSegment) {
      const initBytes = await fetchSegmentBytesWithRetry(
        playlist.initSegment,
        signal,
      );
      hooks.onDeltaBytes(initBytes.byteLength);
      initInput = new Input({
        source: new BufferSource(initBytes),
        formats: HLS_SEGMENT_FORMATS,
      });
    }

    return await withOpfsStreamTarget(
      itemId,
      asset.relativePath,
      signal,
      async (streamTarget) => {
        const format = new Mp4OutputFormat({ fastStart: false });
        const supportedVideoCodecs = new Set<VideoCodec>(
          format.getSupportedVideoCodecs(),
        );
        const supportedAudioCodecs = new Set<AudioCodec>(
          format.getSupportedAudioCodecs(),
        );

        const output = new Output({ format, target: streamTarget });
        activeOutput = output;

        let videoPacketSource: EncodedVideoPacketSource | null = null;
        let audioPacketSource: EncodedAudioPacketSource | null = null;
        let videoFirstMetaSent = false;
        let audioFirstMetaSent = false;
        let outputStarted = false;

        let sharedBaseTimestamp: number | null = null;
        let writtenPacketCount = 0;

        for (let segIdx = 0; segIdx < playlist.segments.length; segIdx += 1) {
          const segment = playlist.segments[segIdx];
          if (!segment) {
            continue;
          }

          throwIfAborted(signal);
          const segmentBytes = await fetchSegmentBytesWithRetry(segment, signal);
          hooks.onDeltaBytes(segmentBytes.byteLength);

          const segmentInput = new Input({
            source: new BufferSource(segmentBytes),
            formats: HLS_SEGMENT_FORMATS,
            ...(initInput ? { initInput } : {}),
          });

          try {
            const [videoTrack, audioTrack] = await Promise.all([
              segmentInput.getPrimaryVideoTrack(),
              segmentInput.getPrimaryAudioTrack(),
            ]);

            if (!outputStarted) {
              if (videoTrack) {
                const vCodec = await videoTrack.getCodec();
                if (vCodec && supportedVideoCodecs.has(vCodec)) {
                  const vConfig = await videoTrack.getDecoderConfig();
                  const [rotation, flip] = await Promise.all([
                    videoTrack.getRotation(),
                    videoTrack.getFlip(),
                  ]);
                  videoPacketSource = new EncodedVideoPacketSource(vCodec);
                  output.addVideoTrack(videoPacketSource, {
                    rotation,
                    flip,
                    ...(vConfig ? { decoderConfig: vConfig } : {}),
                  });
                }
              }

              if (audioTrack) {
                const aCodec = await audioTrack.getCodec();
                if (aCodec && supportedAudioCodecs.has(aCodec)) {
                  const aConfig = await audioTrack.getDecoderConfig();
                  audioPacketSource = new EncodedAudioPacketSource(aCodec);
                  output.addAudioTrack(audioPacketSource, {
                    ...(aConfig ? { decoderConfig: aConfig } : {}),
                  });
                }
              }

              if (!output.hasEnoughTracks()) {
                throw new Error(
                  `HLS segment ${segIdx + 1} has no MP4-compatible video/audio tracks.`,
                );
              }

              const [vFirstTs, aFirstTs] = await Promise.all([
                videoTrack && videoPacketSource
                  ? videoTrack.getFirstTimestampOrNull()
                  : Promise.resolve(null),
                audioTrack && audioPacketSource
                  ? audioTrack.getFirstTimestampOrNull()
                  : Promise.resolve(null),
              ]);
              const candidateFirstTs = [vFirstTs, aFirstTs].filter(
                (ts): ts is number => ts !== null && Number.isFinite(ts),
              );
              if (candidateFirstTs.length > 0) {
                sharedBaseTimestamp = Math.min(...candidateFirstTs);
              }

              await output.start();
              outputStarted = true;
            }

            const baseTimestamp = sharedBaseTimestamp ?? 0;

            const pumpVideo = async (): Promise<void> => {
              if (!videoTrack || !videoPacketSource) {
                return;
              }
              const decoderConfig = !videoFirstMetaSent
                ? await videoTrack.getDecoderConfig()
                : null;
              const sink = new EncodedPacketSink(videoTrack);

              for await (const packet of sink.packets()) {
                throwIfAborted(signal);
                const normalizedTs = packet.timestamp - baseTimestamp;
                const safePacket =
                  normalizedTs !== packet.timestamp
                    ? packet.clone({ timestamp: normalizedTs })
                    : packet;

                if (!videoFirstMetaSent && decoderConfig) {
                  await videoPacketSource.add(safePacket, { decoderConfig });
                  videoFirstMetaSent = true;
                } else {
                  await videoPacketSource.add(safePacket);
                  videoFirstMetaSent = true;
                }
                writtenPacketCount += 1;
              }
            };

            const pumpAudio = async (): Promise<void> => {
              if (!audioTrack || !audioPacketSource) {
                return;
              }
              const decoderConfig = !audioFirstMetaSent
                ? await audioTrack.getDecoderConfig()
                : null;
              const sink = new EncodedPacketSink(audioTrack);

              for await (const packet of sink.packets()) {
                throwIfAborted(signal);
                const normalizedTs = packet.timestamp - baseTimestamp;
                const safePacket =
                  normalizedTs !== packet.timestamp
                    ? packet.clone({ timestamp: normalizedTs })
                    : packet;

                if (!audioFirstMetaSent && decoderConfig) {
                  await audioPacketSource.add(safePacket, { decoderConfig });
                  audioFirstMetaSent = true;
                } else {
                  await audioPacketSource.add(safePacket);
                  audioFirstMetaSent = true;
                }
                writtenPacketCount += 1;
              }
            };

            await Promise.all([pumpVideo(), pumpAudio()]);
          } finally {
            segmentInput.dispose();
          }
        }

        if (!outputStarted || writtenPacketCount === 0) {
          throw new Error(
            `No media packets were muxed from HLS playlist for asset "${asset.id}".`,
          );
        }

        videoPacketSource?.close();
        audioPacketSource?.close();
        throwIfAborted(signal);
        await output.finalize();
      },
    );
  } finally {
    signal?.removeEventListener('abort', onAbort);
    initInput?.dispose();
  }
}

/**
 * 解析 M3U8 播放列表、按序拉取媒体分片并通过 Mediabunny 无损封装输出 MP4 写入 OPFS。
 */
export async function muxHlsToOpfs(
  itemId: string,
  asset: MediaAsset,
  hooks: AssetProgressHooks = NOOP_PROGRESS_HOOKS,
  signal?: AbortSignal,
): Promise<number> {
  const candidates = collectCandidateUrls(asset);
  if (candidates.length === 0) {
    throw new Error(`HLS asset "${asset.id}" has no valid M3U8 URL.`);
  }

  let lastError: unknown = new Error(
    `Failed to mux HLS asset "${asset.id}" from all candidate URLs.`,
  );

  for (const manifestUrl of candidates) {
    throwIfAborted(signal);
    hooks.onResetBytes();

    try {
      const rootManifest = await fetchTextWithRetry(manifestUrl, signal);
      let parsed = parseM3u8Playlist(rootManifest.text, rootManifest.finalUrl);
      let activeManifestUrl = rootManifest.finalUrl;

      // 若为主播放列表含分离音轨，直接交给 Mediabunny 原生 HLS 混流器处理
      if (parsed.isMaster && parsed.hasSeparateAudioRendition) {
        return await muxHlsViaMediabunnyNative(
          itemId,
          asset,
          activeManifestUrl,
          hooks,
          signal,
        );
      }

      // 主播放列表：自动选择最高带宽变体并解析媒体播放列表
      if (parsed.isMaster) {
        const sortedVariants = [...parsed.variants].sort(
          (a, b) => b.bandwidth - a.bandwidth,
        );
        const bestVariant = sortedVariants[0];
        if (!bestVariant) {
          throw new Error(`Master HLS playlist has no variants: ${manifestUrl}`);
        }
        const mediaManifest = await fetchTextWithRetry(bestVariant.url, signal);
        activeManifestUrl = mediaManifest.finalUrl;
        parsed = parseM3u8Playlist(mediaManifest.text, mediaManifest.finalUrl);
      }

      // 加密分片（如 AES-128）或含时间轴不连续标记交由 Mediabunny 原生 HLS 管线处理
      if (parsed.hasEncryption || parsed.hasDiscontinuity) {
        return await muxHlsViaMediabunnyNative(
          itemId,
          asset,
          activeManifestUrl,
          hooks,
          signal,
        );
      }

      return await muxParsedHlsSegmentsToOpfs(
        itemId,
        asset,
        parsed,
        hooks,
        signal,
      );
    } catch (error) {
      if (signal?.aborted || isAbortError(error)) {
        throw createAbortError(signal);
      }
      lastError = error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error(getErrorMessage(lastError));
}

// ============================================================================
// 4. 整任务调度、进度节流与离线封面缩略图生成
// ============================================================================

interface AssetProgressState {
  downloadedBytes: number;
  totalBytes: number;
  completed: boolean;
}

class ThrottledProgressTracker {
  private readonly states: AssetProgressState[];
  private readonly onProgress?: (snapshot: PipelineProgressSnapshot) => void;
  private lastEmitTime = 0;
  private pendingTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(
    assets: readonly MediaAsset[],
    onProgress?: (snapshot: PipelineProgressSnapshot) => void,
  ) {
    this.onProgress = onProgress;
    this.states = assets.map((asset) => {
      const size =
        typeof asset.sizeBytes === 'number' && asset.sizeBytes > 0
          ? asset.sizeBytes
          : 0;
      return {
        downloadedBytes: asset.downloaded ? size : 0,
        totalBytes: size,
        completed: asset.downloaded,
      };
    });
  }

  resetAssetBytes(index: number): void {
    const state = this.states[index];
    if (!state) {
      return;
    }
    state.downloadedBytes = 0;
  }

  setKnownTotalBytes(index: number, totalBytes: number): void {
    const state = this.states[index];
    if (!state || !Number.isFinite(totalBytes) || totalBytes <= 0) {
      return;
    }
    state.totalBytes = Math.floor(totalBytes);
    this.scheduleEmit(false);
  }

  addDeltaBytes(index: number, deltaBytes: number): void {
    const state = this.states[index];
    if (!state || !Number.isFinite(deltaBytes) || deltaBytes <= 0) {
      return;
    }
    state.downloadedBytes += deltaBytes;
    if (state.totalBytes > 0 && state.downloadedBytes > state.totalBytes) {
      state.totalBytes = state.downloadedBytes;
    }
    this.scheduleEmit(false);
  }

  markAssetCompleted(index: number, finalBytes: number): void {
    const state = this.states[index];
    if (!state) {
      return;
    }
    const safeBytes = Math.max(0, Math.floor(finalBytes));
    state.completed = true;
    state.downloadedBytes = safeBytes;
    state.totalBytes = safeBytes;
    this.scheduleEmit(true);
  }

  emitNow(): void {
    this.scheduleEmit(true);
  }

  dispose(): void {
    this.disposed = true;
    if (this.pendingTimer !== null) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
    }
  }

  private buildSnapshot(): PipelineProgressSnapshot {
    const totalAssets = this.states.length;
    if (totalAssets === 0) {
      return {
        progress: 100,
        completedAssets: 0,
        totalAssets: 0,
        downloadedBytes: 0,
        totalBytes: 0,
      };
    }

    let completedAssets = 0;
    let downloadedBytes = 0;
    let totalBytes = 0;
    let allSizesKnown = true;

    for (const state of this.states) {
      if (state.completed) {
        completedAssets += 1;
      }
      downloadedBytes += state.downloadedBytes;
      if (state.totalBytes > 0) {
        totalBytes += state.totalBytes;
      } else {
        allSizesKnown = false;
      }
    }

    let progress: number;
    if (completedAssets >= totalAssets) {
      progress = 100;
    } else if (totalBytes > 0) {
      const byteRatio = Math.min(1, downloadedBytes / totalBytes);
      const countRatio = completedAssets / totalAssets;
      const combinedRatio = allSizesKnown
        ? byteRatio
        : byteRatio * 0.7 + countRatio * 0.3;
      progress = Math.max(0, Math.min(99, Math.round(combinedRatio * 100)));
    } else {
      progress = Math.max(
        0,
        Math.min(99, Math.round((completedAssets / totalAssets) * 100)),
      );
    }

    return {
      progress,
      completedAssets,
      totalAssets,
      downloadedBytes,
      totalBytes,
    };
  }

  private scheduleEmit(force: boolean): void {
    if (this.disposed || !this.onProgress) {
      return;
    }

    const now = Date.now();
    const elapsed = now - this.lastEmitTime;

    if (force || this.lastEmitTime === 0 || elapsed >= PROGRESS_THROTTLE_MS) {
      if (this.pendingTimer !== null) {
        clearTimeout(this.pendingTimer);
        this.pendingTimer = null;
      }
      this.lastEmitTime = now;
      this.onProgress(this.buildSnapshot());
      return;
    }

    if (this.pendingTimer === null) {
      const waitMs = Math.max(10, PROGRESS_THROTTLE_MS - elapsed);
      this.pendingTimer = setTimeout(() => {
        this.pendingTimer = null;
        if (this.disposed || !this.onProgress) {
          return;
        }
        this.lastEmitTime = Date.now();
        this.onProgress(this.buildSnapshot());
      }, waitMs);
    }
  }
}

async function runWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  signal: AbortSignal | undefined,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) {
    return;
  }

  const concurrency = Math.max(1, Math.min(limit, items.length));
  let cursor = 0;

  const runners: Promise<void>[] = [];
  for (let i = 0; i < concurrency; i += 1) {
    runners.push(
      (async () => {
        while (true) {
          throwIfAborted(signal);
          const nextIndex = cursor;
          cursor += 1;
          if (nextIndex >= items.length) {
            return;
          }
          const item = items[nextIndex];
          if (item === undefined) {
            return;
          }
          await worker(item);
        }
      })(),
    );
  }

  await Promise.all(runners);
}

async function downloadSingleAsset(
  itemId: string,
  asset: MediaAsset,
  hooks: AssetProgressHooks,
  signal?: AbortSignal,
): Promise<number> {
  switch (asset.strategy) {
    case 'direct':
      return downloadDirectAssetToOpfs(itemId, asset, hooks, signal);
    case 'dash_mux':
      return muxDashToOpfs(itemId, asset, hooks, signal);
    case 'hls_mux':
      return muxHlsToOpfs(itemId, asset, hooks, signal);
  }
}

async function generateOfflineThumbnail(
  itemId: string,
  assets: readonly MediaAsset[],
): Promise<string | undefined> {
  const thumbCandidate =
    assets.find((asset) => asset.kind === 'cover' && asset.downloaded) ??
    assets.find((asset) => asset.kind === 'image' && asset.downloaded);

  if (!thumbCandidate) {
    return undefined;
  }

  try {
    const file = await readFileFromOpfs(itemId, thumbCandidate.relativePath);
    if (!file || file.size === 0) {
      return undefined;
    }
    return await generateThumbnailFromBlob(file, THUMBNAIL_MAX_WIDTH);
  } catch {
    return undefined;
  }
}

/**
 * 执行完整条目的媒体资产下载与离线封面缩略图生成任务。
 *
 * - 视频资产串行流式下载，避免高码率多路并发争抢带宽或引发内存抖动；
 * - 图片/封面/音频资产采用最多 3 路受控并发下载；
 * - 若封面资产失败但主体媒体资产成功，不阻断整体任务；
 * - 若所有主体媒体资产均失败或任务被中止，则抛出明确异常。
 */
export async function executeDownloadJob(
  input: DownloadJobInput,
): Promise<DownloadJobResult> {
  const { itemId, assets, allowAllAssetsFailed = false, signal, onProgress } =
    input;
  throwIfAborted(signal);

  const resultAssets: MediaAsset[] = assets.map((asset) => ({
    ...asset,
    ...(asset.fallbackUrls ? { fallbackUrls: [...asset.fallbackUrls] } : {}),
    ...(asset.audioFallbackUrls
      ? { audioFallbackUrls: [...asset.audioFallbackUrls] }
      : {}),
  }));

  const tracker = new ThrottledProgressTracker(resultAssets, onProgress);
  const failureMessages = new Map<number, string>();

  const processAssetByIndex = async (index: number): Promise<void> => {
    const asset = resultAssets[index];
    if (!asset) {
      return;
    }

    if (asset.downloaded) {
      tracker.markAssetCompleted(index, asset.sizeBytes ?? 0);
      return;
    }

    throwIfAborted(signal);

    const hooks: AssetProgressHooks = {
      onResetBytes: () => tracker.resetAssetBytes(index),
      onDeltaBytes: (delta) => tracker.addDeltaBytes(index, delta),
      onKnownTotalBytes: (total) => tracker.setKnownTotalBytes(index, total),
    };

    try {
      const sizeBytes = await downloadSingleAsset(itemId, asset, hooks, signal);
      resultAssets[index] = {
        ...asset,
        sizeBytes,
        downloaded: true,
      };
      tracker.markAssetCompleted(index, sizeBytes);
    } catch (error) {
      if (signal?.aborted || isAbortError(error)) {
        throw createAbortError(signal);
      }
      resultAssets[index] = {
        ...asset,
        downloaded: false,
      };
      failureMessages.set(index, getErrorMessage(error));
    }
  };

  try {
    const videoIndices: number[] = [];
    const concurrentIndices: number[] = [];

    for (let i = 0; i < resultAssets.length; i += 1) {
      const asset = resultAssets[i];
      if (!asset) {
        continue;
      }
      if (asset.kind === 'video') {
        videoIndices.push(i);
      } else {
        concurrentIndices.push(i);
      }
    }

    // 1. 视频资产严格串行下载
    for (const index of videoIndices) {
      throwIfAborted(signal);
      await processAssetByIndex(index);
    }

    // 2. 图片 / 封面 / 音频资产最多 3 路受控并发下载
    await runWithConcurrency(
      concurrentIndices,
      MAX_CONCURRENT_IMAGE_DOWNLOADS,
      signal,
      processAssetByIndex,
    );

    throwIfAborted(signal);

    // 3. 容错评估：封面失败不阻断成功的主体媒体；文章类允许可选外链图片失败；其余主体媒体全军覆没则抛出明确错误
    if (!allowAllAssetsFailed) {
      const primaryAssets = resultAssets.filter((asset) => asset.kind !== 'cover');
      if (primaryAssets.length > 0) {
        const hasAnyPrimarySuccess = primaryAssets.some(
          (asset) => asset.downloaded,
        );
        if (!hasAnyPrimarySuccess) {
          const reasons = [...failureMessages.values()];
          throw new Error(
            reasons.length > 0
              ? `All primary media assets failed to download: ${reasons[0]}`
              : 'All primary media assets failed to download.',
          );
        }
      } else if (resultAssets.length > 0) {
        const hasAnySuccess = resultAssets.some((asset) => asset.downloaded);
        if (!hasAnySuccess) {
          const reasons = [...failureMessages.values()];
          throw new Error(
            reasons.length > 0
              ? `All media assets failed to download: ${reasons[0]}`
              : 'All media assets failed to download.',
          );
        }
      }
    }

    const totalSizeBytes = resultAssets.reduce(
      (sum, asset) => sum + (asset.downloaded ? (asset.sizeBytes ?? 0) : 0),
      0,
    );

    const thumbnailDataUrl = await generateOfflineThumbnail(
      itemId,
      resultAssets,
    );

    throwIfAborted(signal);
    tracker.emitNow();

    return {
      assets: resultAssets,
      totalSizeBytes,
      ...(thumbnailDataUrl !== undefined ? { thumbnailDataUrl } : {}),
    };
  } finally {
    tracker.dispose();
  }
}

// ============================================================================
// 5. 离线评论快照与评论者头像暂存（写入 OPFS comments/avatars/* + comments.json）
// ============================================================================

export interface StageCommentsJobInput {
  itemId: string;
  platform: PlatformId;
  sourceId: string;
  comments: readonly CapturedCommentInput[];
  limit: number;
  signal?: AbortSignal;
}

export interface StageCommentsJobResult {
  commentsRelativePath: string;
  savedCommentCount: number;
  commentsSizeBytes: number;
}

function resolveAvatarExtension(
  contentType: string | null,
  sourceUrl: string,
): string {
  if (contentType) {
    const extFromMime = inferExtensionFromMime(contentType, '');
    if (SAFE_AVATAR_EXTENSIONS.has(extFromMime)) {
      return extFromMime;
    }
  }

  try {
    const pathname = new URL(sourceUrl).pathname.toLowerCase();
    const dotIdx = pathname.lastIndexOf('.');
    if (dotIdx > 0) {
      const rawExt = pathname.slice(dotIdx);
      const normalized = rawExt === '.jpeg' ? '.jpg' : rawExt;
      if (SAFE_AVATAR_EXTENSIONS.has(normalized)) {
        return normalized;
      }
    }
  } catch {
    // 忽略异常 URL 并回退 .jpg
  }

  return '.jpg';
}

async function fetchAvatarBlobBestEffort(
  urls: readonly string[],
  signal?: AbortSignal,
): Promise<{ blob: Blob; ext: string } | null> {
  for (const url of urls) {
    throwIfAborted(signal);
    for (let attempt = 0; attempt <= MAX_TRANSIENT_RETRIES_PER_URL; attempt += 1) {
      throwIfAborted(signal);
      try {
        const response = await fetchWithHeaderTimeout(
          url,
          { method: 'GET' },
          signal,
        );
        if (!response.ok) {
          throw new HttpFetchError(url, response.status, response.statusText);
        }
        const blob = await response.blob();
        throwIfAborted(signal);
        if (blob.size <= 0) {
          break;
        }
        const ext = resolveAvatarExtension(
          response.headers.get('content-type') || blob.type || null,
          url,
        );
        return { blob, ext };
      } catch (error) {
        if (signal?.aborted || isAbortError(error)) {
          throw createAbortError(signal);
        }
        if (
          error instanceof HttpFetchError &&
          IMMEDIATE_FALLBACK_STATUS_CODES.has(error.status)
        ) {
          break;
        }
        if (attempt < MAX_TRANSIENT_RETRIES_PER_URL) {
          await sleepWithSignal(TRANSIENT_RETRY_DELAY_MS, signal);
          continue;
        }
      }
    }
  }
  return null;
}

/**
 * 下载并去重评论者头像到 OPFS `collect-plus-stage/{itemId}/comments/avatars/`，
 * 随后原子写入 `comments.json`。单个头像下载失败不阻断整体评论归档。
 */
export async function stageItemCommentsToOpfs(
  input: StageCommentsJobInput,
): Promise<StageCommentsJobResult> {
  const { itemId, platform, sourceId, signal } = input;
  throwIfAborted(signal);

  const safeLimit =
    Number.isFinite(input.limit) && input.limit > 0
      ? Math.floor(input.limit)
      : 100;
  const boundedComments = input.comments.slice(0, safeLimit);

  // 按主头像 URL 去重，避免同一评论者多条评论重复下载与落盘
  interface UniqueAvatarJob {
    key: string;
    slotIndex: number;
    candidateUrls: string[];
  }

  const avatarJobByKey = new Map<string, UniqueAvatarJob>();
  const avatarKeyByCommentIndex: Array<string | undefined> = [];

  for (const comment of boundedComments) {
    const primaryUrl = comment.avatarUrl?.trim();
    if (!primaryUrl) {
      avatarKeyByCommentIndex.push(undefined);
      continue;
    }

    const dedupeKey = primaryUrl;
    avatarKeyByCommentIndex.push(dedupeKey);

    if (!avatarJobByKey.has(dedupeKey)) {
      const seen = new Set<string>([primaryUrl]);
      const candidateUrls = [primaryUrl];
      for (const fallback of comment.avatarFallbackUrls ?? []) {
        const trimmed = fallback.trim();
        if (trimmed && !seen.has(trimmed)) {
          seen.add(trimmed);
          candidateUrls.push(trimmed);
        }
      }
      avatarJobByKey.set(dedupeKey, {
        key: dedupeKey,
        slotIndex: avatarJobByKey.size + 1,
        candidateUrls,
      });
    }
  }

  const stagedAvatarByKey = new Map<
    string,
    { relativePath: string; sizeBytes: number }
  >();

  await runWithConcurrency(
    [...avatarJobByKey.values()],
    MAX_CONCURRENT_AVATAR_DOWNLOADS,
    signal,
    async (job) => {
      throwIfAborted(signal);
      const fetched = await fetchAvatarBlobBestEffort(job.candidateUrls, signal);
      if (!fetched) {
        return;
      }
      const relativePath = `comments/avatars/${String(job.slotIndex).padStart(3, '0')}${fetched.ext}`;
      const sizeBytes = await writeBlobToOpfs(itemId, relativePath, fetched.blob);
      if (sizeBytes > 0) {
        stagedAvatarByKey.set(job.key, { relativePath, sizeBytes });
      }
    },
  );

  throwIfAborted(signal);

  const savedComments: SavedComment[] = boundedComments.map((comment, idx) => {
    const avatarKey = avatarKeyByCommentIndex[idx];
    const stagedAvatar = avatarKey ? stagedAvatarByKey.get(avatarKey) : undefined;
    return {
      id: comment.id,
      ...(comment.authorId !== undefined ? { authorId: comment.authorId } : {}),
      authorName: comment.authorName,
      ...(stagedAvatar !== undefined
        ? { avatarRelativePath: stagedAvatar.relativePath }
        : {}),
      content: comment.content,
      likeCount:
        Number.isFinite(comment.likeCount) && comment.likeCount > 0
          ? Math.trunc(comment.likeCount)
          : 0,
      ...(comment.createdAt !== undefined
        ? { createdAt: comment.createdAt }
        : {}),
    };
  });

  const commentsFile: ItemCommentsFile = {
    schemaVersion: SCHEMA_VERSION,
    platform,
    sourceId,
    capturedAt: Date.now(),
    limit: safeLimit,
    comments: savedComments,
  };

  const jsonBlob = new Blob([JSON.stringify(commentsFile, null, 2)], {
    type: 'application/json; charset=utf-8',
  });
  const jsonBytes = await writeBlobToOpfs(itemId, COMMENTS_FILENAME, jsonBlob);

  let avatarTotalBytes = 0;
  for (const avatar of stagedAvatarByKey.values()) {
    avatarTotalBytes += avatar.sizeBytes;
  }

  return {
    commentsRelativePath: COMMENTS_FILENAME,
    savedCommentCount: savedComments.length,
    commentsSizeBytes: avatarTotalBytes + jsonBytes,
  };
}
