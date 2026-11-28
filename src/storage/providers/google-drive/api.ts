/**
 * Google Drive REST API v3 零依赖原生 `fetch` 客户端。
 *
 * - 小文件（< 5 MB）采用 `uploadType=multipart` 单次上传；
 * - 大文件（>= 5 MB）采用 `uploadType=resumable` 按 8 MB（256 KiB 整数倍）分片上传，
 *   直接从 OPFS `File.slice()` 流式读取，避免整视频常驻内存；
 * - 内置 401 自动失效重取 Token（单次重试）与 429/5xx 指数退避重试。
 */

import {
  getGoogleDriveAccessToken,
  invalidateGoogleDriveToken,
} from './auth.ts';

export const DRIVE_API_BASE = 'https://www.googleapis.com/drive/v3';
export const DRIVE_UPLOAD_BASE = 'https://www.googleapis.com/upload/drive/v3';
export const DRIVE_FOLDER_MIME = 'application/vnd.google-apps.folder';

/** 超过 5 MB 的媒体文件切换为可续传分片上传 */
export const RESUMABLE_UPLOAD_THRESHOLD_BYTES = 5 * 1024 * 1024;
/** Google Drive Resumable 分片大小必须为 256 KiB 的整数倍（此处取 8 MiB） */
export const RESUMABLE_CHUNK_SIZE_BYTES = 8 * 1024 * 1024;

const MAX_RETRY_ATTEMPTS = 3;
const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);

export interface DriveFileRecord {
  id: string;
  name: string;
  mimeType?: string;
  size?: number;
  parents?: string[];
  appProperties?: Record<string, string>;
}

export class DriveApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'DriveApiError';
    this.status = status;
  }
}

export function isDriveNotFoundError(error: unknown): boolean {
  return error instanceof DriveApiError && error.status === 404;
}

export function isDriveAuthError(error: unknown): boolean {
  return error instanceof DriveApiError && (error.status === 401 || error.status === 403);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseDriveFileRecord(raw: unknown): DriveFileRecord | null {
  if (!isRecord(raw) || typeof raw.id !== 'string' || !raw.id) {
    return null;
  }
  const name = typeof raw.name === 'string' ? raw.name : '';
  const mimeType = typeof raw.mimeType === 'string' ? raw.mimeType : undefined;
  let size: number | undefined;
  if (typeof raw.size === 'string' && raw.size.trim()) {
    const parsed = Number(raw.size);
    if (Number.isFinite(parsed) && parsed >= 0) {
      size = parsed;
    }
  } else if (typeof raw.size === 'number' && Number.isFinite(raw.size)) {
    size = raw.size;
  }

  const parents = Array.isArray(raw.parents)
    ? raw.parents.filter((p): p is string => typeof p === 'string')
    : undefined;

  let appProperties: Record<string, string> | undefined;
  if (isRecord(raw.appProperties)) {
    const map: Record<string, string> = {};
    let hasEntry = false;
    for (const [k, v] of Object.entries(raw.appProperties)) {
      if (typeof v === 'string') {
        map[k] = v;
        hasEntry = true;
      }
    }
    if (hasEntry) {
      appProperties = map;
    }
  }

  return {
    id: raw.id,
    name,
    ...(mimeType !== undefined ? { mimeType } : {}),
    ...(size !== undefined ? { size } : {}),
    ...(parents !== undefined ? { parents } : {}),
    ...(appProperties !== undefined ? { appProperties } : {}),
  };
}

/** 转义 Google Drive `q` 查询字符串字面量 */
export function escapeDriveQueryLiteral(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll("'", "\\'");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function extractErrorMessage(response: Response): Promise<string> {
  try {
    const text = await response.text();
    if (!text) {
      return `Google Drive API HTTP ${response.status}`;
    }
    try {
      const parsed: unknown = JSON.parse(text);
      if (
        isRecord(parsed) &&
        isRecord(parsed.error) &&
        typeof parsed.error.message === 'string' &&
        parsed.error.message.trim()
      ) {
        return `Google Drive API (${response.status}): ${parsed.error.message}`;
      }
    } catch {
      // 非 JSON 错误体
    }
    return `Google Drive API (${response.status}): ${text.slice(0, 200)}`;
  } catch {
    return `Google Drive API HTTP ${response.status}`;
  }
}

async function authenticatedFetch(
  url: string,
  buildInit: (token: string) => RequestInit,
  options?: { allowStatuses?: ReadonlySet<number> },
): Promise<Response> {
  let token = await getGoogleDriveAccessToken(false);
  if (!token) {
    throw new DriveApiError(
      401,
      'Google Drive authorization required. Please reconnect your Google account.',
    );
  }

  let authRetried = false;

  for (let attempt = 0; attempt <= MAX_RETRY_ATTEMPTS; attempt += 1) {
    const response = await fetch(url, buildInit(token));

    if (response.status === 401 && !authRetried) {
      authRetried = true;
      await invalidateGoogleDriveToken(token);
      const refreshed = await getGoogleDriveAccessToken(false);
      if (!refreshed) {
        throw new DriveApiError(
          401,
          'Google Drive session expired. Please re-authorize your Google account.',
        );
      }
      token = refreshed;
      continue;
    }

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

    if (response.ok || options?.allowStatuses?.has(response.status)) {
      return response;
    }

    const message = await extractErrorMessage(response);
    throw new DriveApiError(response.status, message);
  }

  throw new DriveApiError(503, 'Google Drive API request exhausted retries.');
}

/** 分页查询匹配 `q` 条件的 Drive 文件/目录列表 */
export async function listDriveFiles(params: {
  q: string;
  fields?: string;
  pageSize?: number;
  maxPages?: number;
}): Promise<DriveFileRecord[]> {
  const results: DriveFileRecord[] = [];
  let pageToken: string | undefined;
  const pageSize = Math.min(1000, Math.max(1, params.pageSize ?? 200));
  const maxPages = params.maxPages ?? 50;
  const fields =
    params.fields ?? 'nextPageToken, files(id, name, mimeType, size, parents, appProperties)';

  for (let page = 0; page < maxPages; page += 1) {
    const url = new URL(`${DRIVE_API_BASE}/files`);
    url.searchParams.set('q', params.q);
    url.searchParams.set('fields', fields);
    url.searchParams.set('pageSize', String(pageSize));
    url.searchParams.set('spaces', 'drive');
    if (pageToken) {
      url.searchParams.set('pageToken', pageToken);
    }

    const response = await authenticatedFetch(url.toString(), (token) => ({
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
      },
    }));

    const raw: unknown = await response.json();
    if (!isRecord(raw)) {
      break;
    }

    if (Array.isArray(raw.files)) {
      for (const item of raw.files) {
        const parsed = parseDriveFileRecord(item);
        if (parsed) {
          results.push(parsed);
        }
      }
    }

    if (typeof raw.nextPageToken === 'string' && raw.nextPageToken) {
      pageToken = raw.nextPageToken;
    } else {
      break;
    }
  }

  return results;
}

/** 在指定父目录下按精确名称查找单个未进回收站的子项 */
export async function findDriveChild(
  parentId: string,
  name: string,
  mimeType?: string,
): Promise<DriveFileRecord | null> {
  const clauses = [
    `'${escapeDriveQueryLiteral(parentId)}' in parents`,
    `name = '${escapeDriveQueryLiteral(name)}'`,
    'trashed = false',
  ];
  if (mimeType) {
    clauses.push(`mimeType = '${escapeDriveQueryLiteral(mimeType)}'`);
  }

  const files = await listDriveFiles({
    q: clauses.join(' and '),
    pageSize: 10,
    maxPages: 1,
  });
  return files[0] ?? null;
}

/** 读取指定 Drive 文件的元数据，不存在返回 `null` */
export async function getDriveFileMetadata(
  fileId: string,
  fields = 'id, name, mimeType, size, parents, appProperties',
): Promise<DriveFileRecord | null> {
  const url = new URL(`${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}`);
  url.searchParams.set('fields', fields);

  try {
    const response = await authenticatedFetch(url.toString(), (token) => ({
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
      },
    }));
    const raw: unknown = await response.json();
    return parseDriveFileRecord(raw);
  } catch (error) {
    if (isDriveNotFoundError(error)) {
      return null;
    }
    throw error;
  }
}

/** 在指定父目录下创建子文件夹 */
export async function createDriveFolder(
  parentId: string,
  name: string,
  appProperties?: Record<string, string>,
): Promise<DriveFileRecord> {
  const url = new URL(`${DRIVE_API_BASE}/files`);
  url.searchParams.set('fields', 'id, name, mimeType, parents, appProperties');

  const metadata: Record<string, unknown> = {
    name,
    mimeType: DRIVE_FOLDER_MIME,
    parents: [parentId],
    ...(appProperties ? { appProperties } : {}),
  };

  const response = await authenticatedFetch(url.toString(), (token) => ({
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=UTF-8',
    },
    body: JSON.stringify(metadata),
  }));

  const raw: unknown = await response.json();
  const parsed = parseDriveFileRecord(raw);
  if (!parsed) {
    throw new Error(`Google Drive returned invalid folder metadata for "${name}".`);
  }
  return parsed;
}

/** 使用 `uploadType=multipart` 创建或覆盖更新小文件 */
async function uploadMultipartFile(params: {
  parentId: string;
  name: string;
  existingFileId: string | null;
  body: Blob;
  mimeType: string;
  appProperties?: Record<string, string>;
}): Promise<DriveFileRecord> {
  const boundary = `collect_plus_${crypto.randomUUID().replaceAll('-', '')}`;
  const metadata: Record<string, unknown> = params.existingFileId
    ? {
        name: params.name,
        ...(params.appProperties ? { appProperties: params.appProperties } : {}),
      }
    : {
        name: params.name,
        parents: [params.parentId],
        ...(params.appProperties ? { appProperties: params.appProperties } : {}),
      };

  const preamble =
    `--${boundary}\r\n` +
    'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
    `${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: ${params.mimeType}\r\n\r\n`;
  const epilogue = `\r\n--${boundary}--`;
  const multipartBlob = new Blob([preamble, params.body, epilogue], {
    type: `multipart/related; boundary=${boundary}`,
  });

  const basePath = params.existingFileId
    ? `${DRIVE_UPLOAD_BASE}/files/${encodeURIComponent(params.existingFileId)}`
    : `${DRIVE_UPLOAD_BASE}/files`;
  const url = new URL(basePath);
  url.searchParams.set('uploadType', 'multipart');
  url.searchParams.set('fields', 'id, name, mimeType, size, parents, appProperties');

  const response = await authenticatedFetch(url.toString(), (token) => ({
    method: params.existingFileId ? 'PATCH' : 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': `multipart/related; boundary=${boundary}`,
    },
    body: multipartBlob,
  }));

  const raw: unknown = await response.json();
  const parsed = parseDriveFileRecord(raw);
  if (!parsed) {
    throw new Error(`Google Drive returned invalid file metadata for "${params.name}".`);
  }
  return parsed;
}

/** 使用 `uploadType=resumable` 分片上传大文件（直接切片读取，避免整文件驻留内存） */
async function uploadResumableFile(params: {
  parentId: string;
  name: string;
  existingFileId: string | null;
  file: Blob;
  mimeType: string;
  appProperties?: Record<string, string>;
  onProgress?: (loadedBytes: number, totalBytes: number) => void;
}): Promise<DriveFileRecord> {
  const totalSize = params.file.size;
  const metadata: Record<string, unknown> = params.existingFileId
    ? {
        name: params.name,
        ...(params.appProperties ? { appProperties: params.appProperties } : {}),
      }
    : {
        name: params.name,
        parents: [params.parentId],
        ...(params.appProperties ? { appProperties: params.appProperties } : {}),
      };

  const basePath = params.existingFileId
    ? `${DRIVE_UPLOAD_BASE}/files/${encodeURIComponent(params.existingFileId)}`
    : `${DRIVE_UPLOAD_BASE}/files`;
  const initUrl = new URL(basePath);
  initUrl.searchParams.set('uploadType', 'resumable');
  initUrl.searchParams.set('fields', 'id, name, mimeType, size, parents, appProperties');

  const initResponse = await authenticatedFetch(initUrl.toString(), (token) => ({
    method: params.existingFileId ? 'PATCH' : 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Type': params.mimeType,
      'X-Upload-Content-Length': String(totalSize),
    },
    body: JSON.stringify(metadata),
  }));

  const sessionUri = initResponse.headers.get('Location');
  if (!sessionUri) {
    throw new Error(
      `Google Drive resumable upload did not return a Location header for "${params.name}".`,
    );
  }

  let offset = 0;
  let finalRecord: DriveFileRecord | null = null;
  const allowResumeStatus = new Set([308]);

  while (offset < totalSize) {
    const endExclusive = Math.min(totalSize, offset + RESUMABLE_CHUNK_SIZE_BYTES);
    const chunk = params.file.slice(offset, endExclusive);
    const contentRange = `bytes ${offset}-${endExclusive - 1}/${totalSize}`;

    const chunkResponse = await authenticatedFetch(
      sessionUri,
      (token) => ({
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': params.mimeType,
          'Content-Range': contentRange,
        },
        body: chunk,
      }),
      { allowStatuses: allowResumeStatus },
    );

    if (chunkResponse.status === 308) {
      const rangeHeader = chunkResponse.headers.get('Range');
      const match = rangeHeader?.match(/bytes=0-(\d+)/i);
      if (match?.[1]) {
        offset = Number(match[1]) + 1;
      } else {
        offset = endExclusive;
      }
      params.onProgress?.(offset, totalSize);
      continue;
    }

    const raw: unknown = await chunkResponse.json();
    finalRecord = parseDriveFileRecord(raw);
    offset = totalSize;
    params.onProgress?.(totalSize, totalSize);
  }

  if (!finalRecord) {
    throw new Error(
      `Google Drive resumable upload finished without file metadata for "${params.name}".`,
    );
  }
  return finalRecord;
}

/** 统一上传文件（按大小自动切换 Multipart 或 Resumable 分片上传） */
export async function uploadDriveFile(params: {
  parentId: string;
  name: string;
  existingFileId: string | null;
  body: Blob;
  mimeType: string;
  appProperties?: Record<string, string>;
  onProgress?: (loadedBytes: number, totalBytes: number) => void;
}): Promise<DriveFileRecord> {
  if (params.body.size >= RESUMABLE_UPLOAD_THRESHOLD_BYTES) {
    return uploadResumableFile({
      parentId: params.parentId,
      name: params.name,
      existingFileId: params.existingFileId,
      file: params.body,
      mimeType: params.mimeType,
      ...(params.appProperties ? { appProperties: params.appProperties } : {}),
      ...(params.onProgress ? { onProgress: params.onProgress } : {}),
    });
  }

  const uploaded = await uploadMultipartFile(params);
  params.onProgress?.(params.body.size, params.body.size);
  return uploaded;
}

/** 下载指定 Drive 文件并封装为浏览器 `File` 对象，不存在返回 `null` */
export async function downloadDriveFile(
  fileId: string,
  fileName: string,
  fallbackMimeType = 'application/octet-stream',
): Promise<File | null> {
  const url = `${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}?alt=media`;
  try {
    const response = await authenticatedFetch(url, (token) => ({
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
      },
    }));
    const blob = await response.blob();
    const contentType =
      response.headers.get('Content-Type') || blob.type || fallbackMimeType;
    return new File([blob], fileName, { type: contentType });
  } catch (error) {
    if (isDriveNotFoundError(error)) {
      return null;
    }
    throw error;
  }
}

/** 永久删除指定 Drive 文件或文件夹（不存在时静默忽略） */
export async function deleteDriveFile(fileId: string): Promise<void> {
  const url = `${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}`;
  try {
    await authenticatedFetch(url, (token) => ({
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${token}`,
      },
    }));
  } catch (error) {
    if (!isDriveNotFoundError(error)) {
      throw error;
    }
  }
}
