/**
 * Cloudflare R2 S3 兼容 REST API 零依赖原生 `fetch` 客户端。
 *
 * - 小文件（< 5 MiB）采用单次 `PUT` 上传；
 * - 大文件（>= 5 MiB）采用 S3 Multipart Upload 按 8 MiB 分片切片上传，
 *   直接从 OPFS `File.slice()` 读取，避免大视频常驻内存；失败时自动 `AbortMultipartUpload`；
 * - 内置无 DOM 依赖的轻量 S3 XML 解析器，兼容 Window、Offscreen 与 Service Worker；
 * - 内置 429 / 5xx 指数退避重试。
 */

import {
  getCloudflareR2Credentials,
  type CloudflareR2Credentials,
} from './auth.ts';
import {
  createPresignedGetUrl,
  encodeRfc3986,
  signS3Request,
} from './sigv4.ts';

/** 超过 5 MiB 切换为 S3 Multipart 分片上传 */
export const R2_MULTIPART_THRESHOLD_BYTES = 5 * 1024 * 1024;
/** 分片大小取 8 MiB（满足 S3/R2 最低 5 MiB 分片要求） */
export const R2_MULTIPART_PART_SIZE_BYTES = 8 * 1024 * 1024;

const MAX_RETRY_ATTEMPTS = 3;
const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);
const DELETE_CONCURRENCY = 6;

export interface R2BucketTarget {
  endpoint: string;
  bucket: string;
}

export interface R2ObjectSummary {
  key: string;
  size: number;
}

export interface R2ObjectHead {
  size: number;
  contentType?: string;
}

export class R2ApiError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = 'R2ApiError';
    this.status = status;
    if (code !== undefined) {
      this.code = code;
    }
  }
}

export function isR2NotFoundError(error: unknown): boolean {
  return error instanceof R2ApiError && error.status === 404;
}

export function isR2AuthError(error: unknown): boolean {
  return error instanceof R2ApiError && (error.status === 401 || error.status === 403);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function decodeXmlEntities(value: string): string {
  return value.replace(
    /&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g,
    (match, entity: string) => {
      switch (entity) {
        case 'amp':
          return '&';
        case 'lt':
          return '<';
        case 'gt':
          return '>';
        case 'quot':
          return '"';
        case 'apos':
          return "'";
        default: {
          if (entity.startsWith('#x') || entity.startsWith('#X')) {
            const cp = Number.parseInt(entity.slice(2), 16);
            return Number.isFinite(cp) ? String.fromCodePoint(cp) : match;
          }
          if (entity.startsWith('#')) {
            const cp = Number.parseInt(entity.slice(1), 10);
            return Number.isFinite(cp) ? String.fromCodePoint(cp) : match;
          }
          return match;
        }
      }
    },
  );
}

function extractXmlTag(xml: string, tagName: string): string | null {
  const re = new RegExp(`<${tagName}(?:\\s[^>]*)?>([\\s\\S]*?)</${tagName}>`, 'i');
  const match = xml.match(re);
  return match?.[1] !== undefined ? decodeXmlEntities(match[1]) : null;
}

function extractXmlBlocks(xml: string, tagName: string): string[] {
  const re = new RegExp(`<${tagName}(?:\\s[^>]*)?>([\\s\\S]*?)</${tagName}>`, 'gi');
  const blocks: string[] = [];
  let match: RegExpExecArray | null = re.exec(xml);
  while (match !== null) {
    if (match[1] !== undefined) {
      blocks.push(match[1]);
    }
    match = re.exec(xml);
  }
  return blocks;
}

/** 构造 path-style R2 S3 URL：`https://<account>.r2.cloudflarestorage.com/<bucket>[/<key>]` */
export function buildR2Url(
  target: R2BucketTarget,
  objectKey?: string,
  query?: Record<string, string>,
): URL {
  const basePath = `/${encodeRfc3986(target.bucket)}`;
  const keyPath = objectKey
    ? `/${objectKey
        .split('/')
        .map((seg) => encodeRfc3986(seg))
        .join('/')}`
    : '';
  const url = new URL(`${target.endpoint}${basePath}${keyPath}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      url.searchParams.set(k, v);
    }
  }
  return url;
}

async function parseR2Error(response: Response): Promise<R2ApiError> {
  try {
    const text = await response.text();
    if (text) {
      const code = extractXmlTag(text, 'Code')?.trim();
      const message = extractXmlTag(text, 'Message')?.trim();
      if (code || message) {
        const detail = [code, message].filter(Boolean).join(': ');
        return new R2ApiError(
          response.status,
          `Cloudflare R2 API (${response.status}): ${detail}`,
          code || undefined,
        );
      }
      return new R2ApiError(
        response.status,
        `Cloudflare R2 API (${response.status}): ${text.slice(0, 200)}`,
      );
    }
  } catch {
    // 忽略错误体解析异常
  }
  return new R2ApiError(response.status, `Cloudflare R2 API HTTP ${response.status}`);
}

async function resolveCredentials(
  target: R2BucketTarget,
  explicitCredentials?: CloudflareR2Credentials,
): Promise<CloudflareR2Credentials> {
  if (explicitCredentials) {
    return explicitCredentials;
  }
  const creds = await getCloudflareR2Credentials(target);
  if (!creds) {
    throw new R2ApiError(
      401,
      'Cloudflare R2 credentials are required. Please reconnect your R2 bucket.',
    );
  }
  return creds;
}

async function signedR2Fetch(params: {
  target: R2BucketTarget;
  method: string;
  url: URL;
  bodyBytes?: ArrayBuffer;
  contentType?: string;
  credentials?: CloudflareR2Credentials;
}): Promise<Response> {
  const creds = await resolveCredentials(params.target, params.credentials);

  for (let attempt = 0; attempt <= MAX_RETRY_ATTEMPTS; attempt += 1) {
    const headers = await signS3Request({
      method: params.method,
      url: params.url,
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
      ...(params.bodyBytes !== undefined ? { bodyBytes: params.bodyBytes } : {}),
      ...(params.contentType !== undefined ? { contentType: params.contentType } : {}),
    });

    const response = await fetch(params.url.toString(), {
      method: params.method,
      headers,
      ...(params.bodyBytes !== undefined ? { body: params.bodyBytes } : {}),
    });

    if (
      RETRYABLE_STATUS_CODES.has(response.status) &&
      attempt < MAX_RETRY_ATTEMPTS
    ) {
      const retryAfterSec = Number(response.headers.get('Retry-After'));
      const delayMs =
        Number.isFinite(retryAfterSec) && retryAfterSec > 0
          ? Math.min(10_000, retryAfterSec * 1000)
          : Math.min(4000, 400 * 2 ** attempt);
      await sleep(delayMs);
      continue;
    }

    if (response.ok) {
      return response;
    }

    throw await parseR2Error(response);
  }

  throw new R2ApiError(503, 'Cloudflare R2 API request exhausted retries.');
}

/** 验证目标 R2 Bucket 存在且当前凭据具备访问权限 */
export async function headR2Bucket(
  target: R2BucketTarget,
  credentials?: CloudflareR2Credentials,
): Promise<void> {
  await signedR2Fetch({
    target,
    method: 'HEAD',
    url: buildR2Url(target),
    ...(credentials ? { credentials } : {}),
  });
}

/** 查询对象元数据，不存在时返回 `null` */
export async function headR2Object(
  target: R2BucketTarget,
  key: string,
): Promise<R2ObjectHead | null> {
  try {
    const response = await signedR2Fetch({
      target,
      method: 'HEAD',
      url: buildR2Url(target, key),
    });
    const rawLen = Number(response.headers.get('Content-Length'));
    const size = Number.isFinite(rawLen) && rawLen >= 0 ? rawLen : 0;
    const contentType = response.headers.get('Content-Type') ?? undefined;
    return {
      size,
      ...(contentType ? { contentType } : {}),
    };
  } catch (error) {
    if (isR2NotFoundError(error)) {
      return null;
    }
    throw error;
  }
}

/** 下载对象并封装为浏览器 `File`，不存在返回 `null` */
export async function getR2Object(
  target: R2BucketTarget,
  key: string,
  fileName: string,
  fallbackMimeType = 'application/octet-stream',
): Promise<File | null> {
  try {
    const response = await signedR2Fetch({
      target,
      method: 'GET',
      url: buildR2Url(target, key),
    });
    const blob = await response.blob();
    const contentType =
      response.headers.get('Content-Type') || blob.type || fallbackMimeType;
    return new File([blob], fileName, { type: contentType });
  } catch (error) {
    if (isR2NotFoundError(error)) {
      return null;
    }
    throw error;
  }
}

async function putSmallR2Object(
  target: R2BucketTarget,
  key: string,
  body: Blob,
  mimeType: string,
): Promise<void> {
  const bodyBytes = await body.arrayBuffer();
  await signedR2Fetch({
    target,
    method: 'PUT',
    url: buildR2Url(target, key),
    bodyBytes,
    contentType: mimeType,
  });
}

async function uploadMultipartR2Object(
  target: R2BucketTarget,
  key: string,
  file: Blob,
  mimeType: string,
  onProgress?: (loadedBytes: number, totalBytes: number) => void,
): Promise<void> {
  const initResponse = await signedR2Fetch({
    target,
    method: 'POST',
    url: buildR2Url(target, key, { uploads: '' }),
    contentType: mimeType,
  });
  const initXml = await initResponse.text();
  const uploadId = extractXmlTag(initXml, 'UploadId')?.trim();
  if (!uploadId) {
    throw new Error(`Cloudflare R2 multipart initiation did not return an UploadId for "${key}".`);
  }

  const completedParts: Array<{ partNumber: number; etag: string }> = [];
  const totalSize = file.size;
  let offset = 0;
  let partNumber = 1;

  try {
    while (offset < totalSize) {
      const endExclusive = Math.min(totalSize, offset + R2_MULTIPART_PART_SIZE_BYTES);
      const chunkBytes = await file.slice(offset, endExclusive).arrayBuffer();

      const partResponse = await signedR2Fetch({
        target,
        method: 'PUT',
        url: buildR2Url(target, key, {
          partNumber: String(partNumber),
          uploadId,
        }),
        bodyBytes: chunkBytes,
      });

      const etag = partResponse.headers.get('ETag')?.trim();
      if (!etag) {
        throw new Error(
          `Cloudflare R2 multipart upload part ${partNumber} did not return an ETag for "${key}".`,
        );
      }

      completedParts.push({ partNumber, etag });
      offset = endExclusive;
      partNumber += 1;
      onProgress?.(offset, totalSize);
    }

    const completeXml =
      '<CompleteMultipartUpload>' +
      completedParts
        .map(
          (part) =>
            `<Part><PartNumber>${part.partNumber}</PartNumber><ETag>${escapeXml(part.etag)}</ETag></Part>`,
        )
        .join('') +
      '</CompleteMultipartUpload>';
    const completeBytes = await new Blob([completeXml]).arrayBuffer();

    await signedR2Fetch({
      target,
      method: 'POST',
      url: buildR2Url(target, key, { uploadId }),
      bodyBytes: completeBytes,
      contentType: 'application/xml; charset=UTF-8',
    });
  } catch (error) {
    // 分片上传中断时尽力清理远端未完成分片，避免产生孤立存储费用
    await signedR2Fetch({
      target,
      method: 'DELETE',
      url: buildR2Url(target, key, { uploadId }),
    }).catch(() => undefined);
    throw error;
  }
}

/** 统一上传对象（>= 5 MiB 自动切换为 S3 Multipart 8 MiB 分片上传） */
export async function uploadR2Object(
  target: R2BucketTarget,
  key: string,
  body: Blob,
  mimeType: string,
  onProgress?: (loadedBytes: number, totalBytes: number) => void,
): Promise<void> {
  if (body.size >= R2_MULTIPART_THRESHOLD_BYTES) {
    await uploadMultipartR2Object(target, key, body, mimeType, onProgress);
    return;
  }
  await putSmallR2Object(target, key, body, mimeType);
  onProgress?.(body.size, body.size);
}

/** 分页列举指定前缀下的对象（S3 ListObjectsV2） */
export async function listR2Objects(
  target: R2BucketTarget,
  prefix: string,
  options?: { maxKeys?: number; maxPages?: number },
): Promise<R2ObjectSummary[]> {
  const results: R2ObjectSummary[] = [];
  const maxKeys = Math.min(1000, Math.max(1, options?.maxKeys ?? 1000));
  const maxPages = options?.maxPages ?? 200;
  let continuationToken: string | undefined;

  for (let page = 0; page < maxPages; page += 1) {
    const query: Record<string, string> = {
      'list-type': '2',
      'max-keys': String(maxKeys),
    };
    if (prefix) {
      query.prefix = prefix;
    }
    if (continuationToken) {
      query['continuation-token'] = continuationToken;
    }

    const response = await signedR2Fetch({
      target,
      method: 'GET',
      url: buildR2Url(target, undefined, query),
    });
    const xml = await response.text();

    for (const block of extractXmlBlocks(xml, 'Contents')) {
      const key = extractXmlTag(block, 'Key');
      if (!key) {
        continue;
      }
      const rawSize = Number(extractXmlTag(block, 'Size') ?? '0');
      results.push({
        key,
        size: Number.isFinite(rawSize) && rawSize >= 0 ? rawSize : 0,
      });
    }

    const isTruncated =
      extractXmlTag(xml, 'IsTruncated')?.trim().toLowerCase() === 'true';
    const nextToken = extractXmlTag(xml, 'NextContinuationToken')?.trim();
    if (isTruncated && nextToken) {
      continuationToken = nextToken;
    } else {
      break;
    }
  }

  return results;
}

/** 删除单个对象（不存在时静默忽略） */
export async function deleteR2Object(
  target: R2BucketTarget,
  key: string,
): Promise<void> {
  try {
    await signedR2Fetch({
      target,
      method: 'DELETE',
      url: buildR2Url(target, key),
    });
  } catch (error) {
    if (!isR2NotFoundError(error)) {
      throw error;
    }
  }
}

/** 受控并发批量删除多个对象（无需 MD5 计算，兼容所有 S3/R2 端点） */
export async function deleteR2Objects(
  target: R2BucketTarget,
  keys: readonly string[],
): Promise<void> {
  if (keys.length === 0) {
    return;
  }

  let cursor = 0;
  const workerCount = Math.min(DELETE_CONCURRENCY, keys.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (cursor < keys.length) {
      const idx = cursor;
      cursor += 1;
      const key = keys[idx];
      if (key) {
        await deleteR2Object(target, key);
      }
    }
  });
  await Promise.all(workers);
}

/** 为 `<video>` 流式播放生成 SigV4 预签名 GET URL */
export async function createR2PresignedGetUrl(
  target: R2BucketTarget,
  key: string,
  expiresInSeconds = 3600,
): Promise<string | null> {
  const creds = await getCloudflareR2Credentials(target);
  if (!creds) {
    return null;
  }
  return createPresignedGetUrl({
    url: buildR2Url(target, key),
    accessKeyId: creds.accessKeyId,
    secretAccessKey: creds.secretAccessKey,
    expiresInSeconds,
  });
}
