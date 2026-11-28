/**
 * Google Drive `VaultStorageBackend` 驱动实现。
 *
 * 特点：
 * - 完全实现 POSIX 相对路径语义，屏蔽 Drive `fileId` 寻址差异；
 * - 内置按 `rootFolderId` 隔离的 `relativePath -> fileId` 缓存（内存 + `chrome.storage.local`），
 *   命中 404 时自动失效重建；
 * - `scanItemMetaFiles` 通过 Drive `files.list` 按页批量查询 `meta.json`，显著加速云端重建索引；
 * - `resolvePlayableMedia` 复用 Session DNR 仅对扩展自身 `media` 请求注入短期 `Authorization` 头，
 *   实现大视频原生 HTTP Range 流式拖拽播放且不落盘凭据。
 */

import {
  clearStorageMediaAuthDnrRule,
  setStorageMediaAuthDnrRule,
} from '../../../download/dnr.ts';
import type {
  PlayableMediaSource,
  ScannedVaultMetaEntry,
  VaultAccessMode,
  VaultPermissionStatus,
  VaultStorageBackend,
} from '../../../types/storage-provider.ts';
import { splitRelativePath } from '../../path.ts';
import {
  createDriveFolder,
  deleteDriveFile,
  downloadDriveFile,
  DRIVE_API_BASE,
  DRIVE_FOLDER_MIME,
  escapeDriveQueryLiteral,
  findDriveChild,
  getDriveFileMetadata,
  isDriveNotFoundError,
  listDriveFiles,
  uploadDriveFile,
  type DriveFileRecord,
} from './api.ts';
import { getGoogleDriveAccessToken } from './auth.ts';

const PATH_CACHE_STORAGE_KEY = 'collect_plus_provider_google_drive_path_cache';
const MAX_PERSISTED_CACHE_ENTRIES = 5000;
const GOOGLE_DRIVE_DNR_RULE_OFFSET = 1;
const ITEMS_DIRNAME = 'items';

interface PersistedPathCache {
  rootFolderId: string;
  entries: Record<string, string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function guessMimeType(fileName: string, fallback = 'application/octet-stream'): string {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.json')) return 'application/json; charset=UTF-8';
  if (lower.endsWith('.txt')) return 'text/plain; charset=UTF-8';
  if (lower.endsWith('.mp4')) return 'video/mp4';
  if (lower.endsWith('.webm')) return 'video/webm';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.gif')) return 'image/gif';
  return fallback;
}

/** 清理 Google Drive 路径缓存（用于断开连接或切换根目录） */
export async function clearGoogleDrivePathCache(): Promise<void> {
  if (
    typeof chrome !== 'undefined' &&
    chrome.storage?.local &&
    typeof chrome.storage.local.remove === 'function'
  ) {
    try {
      await chrome.storage.local.remove(PATH_CACHE_STORAGE_KEY);
    } catch {
      // 忽略
    }
  }
}

export class GoogleDriveVaultBackend implements VaultStorageBackend {
  readonly providerId = 'google_drive' as const;
  readonly isRemote = true;
  readonly rootFolderId: string;
  readonly displayName: string;

  private readonly pathIdCache = new Map<string, string>();
  private readonly pendingDirOps = new Map<string, Promise<string>>();
  private cacheLoaded = false;

  constructor(rootFolderId: string, rootFolderName: string) {
    this.rootFolderId = rootFolderId;
    this.displayName = rootFolderName || 'CollectVault';
    this.pathIdCache.set('', rootFolderId);
  }

  private async ensureCacheHydrated(): Promise<void> {
    if (this.cacheLoaded) {
      return;
    }
    this.cacheLoaded = true;
    if (
      typeof chrome === 'undefined' ||
      !chrome.storage?.local ||
      typeof chrome.storage.local.get !== 'function'
    ) {
      return;
    }
    try {
      const stored = await chrome.storage.local.get(PATH_CACHE_STORAGE_KEY);
      const raw: unknown = stored[PATH_CACHE_STORAGE_KEY];
      if (
        isRecord(raw) &&
        raw.rootFolderId === this.rootFolderId &&
        isRecord(raw.entries)
      ) {
        for (const [k, v] of Object.entries(raw.entries)) {
          if (typeof v === 'string' && v) {
            this.pathIdCache.set(k, v);
          }
        }
      }
    } catch {
      // 忽略缓存读取异常，实时走 API 查询
    }
  }

  private persistCacheSoon(): void {
    if (
      typeof chrome === 'undefined' ||
      !chrome.storage?.local ||
      typeof chrome.storage.local.set !== 'function'
    ) {
      return;
    }
    const entries: Record<string, string> = {};
    let count = 0;
    for (const [k, v] of this.pathIdCache.entries()) {
      if (!k) {
        continue;
      }
      entries[k] = v;
      count += 1;
      if (count >= MAX_PERSISTED_CACHE_ENTRIES) {
        break;
      }
    }
    const payload: PersistedPathCache = {
      rootFolderId: this.rootFolderId,
      entries,
    };
    void chrome.storage.local
      .set({ [PATH_CACHE_STORAGE_KEY]: payload })
      .catch(() => undefined);
  }

  private setCachedId(normalizedPath: string, fileId: string): void {
    this.pathIdCache.set(normalizedPath, fileId);
    this.persistCacheSoon();
  }

  private evictPathPrefix(normalizedPrefix: string): void {
    const prefixWithSlash = normalizedPrefix ? `${normalizedPrefix}/` : '';
    let changed = false;
    for (const key of Array.from(this.pathIdCache.keys())) {
      if (
        key === normalizedPrefix ||
        (prefixWithSlash && key.startsWith(prefixWithSlash))
      ) {
        if (key !== '') {
          this.pathIdCache.delete(key);
          changed = true;
        }
      }
    }
    if (changed) {
      this.persistCacheSoon();
    }
  }

  async queryPermission(
    _mode: VaultAccessMode = 'readwrite',
  ): Promise<VaultPermissionStatus> {
    void _mode;
    if (!this.rootFolderId) {
      return 'unbound';
    }
    try {
      const token = await getGoogleDriveAccessToken(false);
      return token ? 'granted' : 'prompt';
    } catch {
      return 'prompt';
    }
  }

  async requestPermission(
    _mode: VaultAccessMode = 'readwrite',
  ): Promise<boolean> {
    void _mode;
    const token = await getGoogleDriveAccessToken(true);
    return Boolean(token);
  }

  private async ensureSingleDirectory(
    parentId: string,
    dirPath: string,
    segment: string,
  ): Promise<string> {
    const cached = this.pathIdCache.get(dirPath);
    if (cached) {
      return cached;
    }

    const pending = this.pendingDirOps.get(dirPath);
    if (pending) {
      return pending;
    }

    const op = (async () => {
      const existing = await findDriveChild(
        parentId,
        segment,
        DRIVE_FOLDER_MIME,
      );
      if (existing) {
        this.setCachedId(dirPath, existing.id);
        return existing.id;
      }
      const created = await createDriveFolder(parentId, segment, {
        collectPath: dirPath,
      });
      this.setCachedId(dirPath, created.id);
      return created.id;
    })();

    this.pendingDirOps.set(dirPath, op);
    try {
      return await op;
    } finally {
      if (this.pendingDirOps.get(dirPath) === op) {
        this.pendingDirOps.delete(dirPath);
      }
    }
  }

  private async resolveDirId(
    segments: readonly string[],
    createDirs: boolean,
  ): Promise<string | null> {
    await this.ensureCacheHydrated();

    if (segments.length === 0) {
      return this.rootFolderId;
    }

    const fullPath = segments.join('/');
    const cachedFull = this.pathIdCache.get(fullPath);
    if (cachedFull) {
      return cachedFull;
    }

    let parentId = this.rootFolderId;
    let currentPath = '';

    for (const seg of segments) {
      currentPath = currentPath ? `${currentPath}/${seg}` : seg;
      const cached = this.pathIdCache.get(currentPath);
      if (cached) {
        parentId = cached;
        continue;
      }

      if (createDirs) {
        parentId = await this.ensureSingleDirectory(parentId, currentPath, seg);
      } else {
        const found = await findDriveChild(parentId, seg, DRIVE_FOLDER_MIME);
        if (!found) {
          return null;
        }
        this.setCachedId(currentPath, found.id);
        parentId = found.id;
      }
    }

    return parentId;
  }

  private async resolveFileId(relativePath: string): Promise<{
    fileId: string;
    fileName: string;
    normalizedPath: string;
  } | null> {
    await this.ensureCacheHydrated();
    const segments = splitRelativePath(relativePath);
    if (segments.length === 0) {
      return null;
    }
    const fileName = segments[segments.length - 1];
    if (!fileName) {
      return null;
    }
    const normalizedPath = segments.join('/');

    const cachedId = this.pathIdCache.get(normalizedPath);
    if (cachedId) {
      return { fileId: cachedId, fileName, normalizedPath };
    }

    const parentId = await this.resolveDirId(segments.slice(0, -1), false);
    if (!parentId) {
      return null;
    }

    const found = await findDriveChild(parentId, fileName);
    if (!found || found.mimeType === DRIVE_FOLDER_MIME) {
      return null;
    }

    this.setCachedId(normalizedPath, found.id);
    return { fileId: found.id, fileName, normalizedPath };
  }

  async readFile(relativePath: string): Promise<File | null> {
    const resolved = await this.resolveFileId(relativePath);
    if (!resolved) {
      return null;
    }

    const file = await downloadDriveFile(
      resolved.fileId,
      resolved.fileName,
      guessMimeType(resolved.fileName),
    );
    if (file) {
      return file;
    }

    // 缓存的 fileId 可能已失效，清缓存后重新解析一次
    this.evictPathPrefix(resolved.normalizedPath);
    const retry = await this.resolveFileId(relativePath);
    if (!retry) {
      return null;
    }
    return downloadDriveFile(
      retry.fileId,
      retry.fileName,
      guessMimeType(retry.fileName),
    );
  }

  async hasFile(relativePath: string): Promise<boolean> {
    const resolved = await this.resolveFileId(relativePath);
    if (!resolved) {
      return false;
    }
    const meta = await getDriveFileMetadata(resolved.fileId, 'id');
    if (meta) {
      return true;
    }
    this.evictPathPrefix(resolved.normalizedPath);
    const retry = await this.resolveFileId(relativePath);
    return retry !== null;
  }

  private async upsertFile(
    relativePath: string,
    body: Blob,
    mimeType: string,
    onProgress?: (loadedBytes: number, totalBytes: number) => void,
  ): Promise<void> {
    const segments = splitRelativePath(relativePath);
    if (segments.length === 0) {
      throw new Error(`Vault relative path cannot be empty: "${relativePath}"`);
    }
    const fileName = segments[segments.length - 1];
    if (!fileName) {
      throw new Error(`Invalid vault relative path: "${relativePath}"`);
    }

    const normalizedPath = segments.join('/');
    const parentSegments = segments.slice(0, -1);
    const parentDirPath = parentSegments.join('/');

    const appProperties: Record<string, string> = {
      collectPath: normalizedPath,
      ...(fileName === 'meta.json' && parentDirPath
        ? { collectDir: parentDirPath }
        : {}),
    };

    const doUpload = async (): Promise<void> => {
      const parentId = await this.resolveDirId(parentSegments, true);
      if (!parentId) {
        throw new Error(`Failed to resolve Google Drive directory for "${relativePath}"`);
      }

      let existingFileId = this.pathIdCache.get(normalizedPath) ?? null;
      if (!existingFileId) {
        const existing = await findDriveChild(parentId, fileName);
        if (existing && existing.mimeType !== DRIVE_FOLDER_MIME) {
          existingFileId = existing.id;
        }
      }

      const uploaded = await uploadDriveFile({
        parentId,
        name: fileName,
        existingFileId,
        body,
        mimeType,
        appProperties,
        ...(onProgress ? { onProgress } : {}),
      });
      this.setCachedId(normalizedPath, uploaded.id);
    };

    try {
      await doUpload();
    } catch (error) {
      // 若缓存的 parentId 或 existingFileId 失效（404），清缓存重试一次
      if (isDriveNotFoundError(error)) {
        this.evictPathPrefix(parentDirPath);
        this.evictPathPrefix(normalizedPath);
        await doUpload();
        return;
      }
      throw error;
    }
  }

  async writeTextFile(relativePath: string, content: string): Promise<void> {
    const segments = splitRelativePath(relativePath);
    const fileName = segments[segments.length - 1] ?? 'file.txt';
    const mimeType = guessMimeType(fileName, 'text/plain; charset=UTF-8');
    const blob = new Blob([content], { type: mimeType });
    await this.upsertFile(relativePath, blob, mimeType);
  }

  async writeFile(
    relativePath: string,
    sourceFile: File,
    onProgress?: (loadedBytes: number, totalBytes: number) => void,
  ): Promise<void> {
    const mimeType =
      sourceFile.type || guessMimeType(sourceFile.name, 'application/octet-stream');
    await this.upsertFile(relativePath, sourceFile, mimeType, onProgress);
  }

  async ensureDirectory(relativeDir: string): Promise<void> {
    const segments = splitRelativePath(relativeDir);
    await this.resolveDirId(segments, true);
  }

  async hasAnyEntry(relativeDir: string): Promise<boolean> {
    const segments = splitRelativePath(relativeDir);
    const dirId = await this.resolveDirId(segments, false);
    if (!dirId) {
      return false;
    }
    const children = await listDriveFiles({
      q: `'${escapeDriveQueryLiteral(dirId)}' in parents and trashed = false`,
      fields: 'nextPageToken, files(id)',
      pageSize: 1,
      maxPages: 1,
    });
    return children.length > 0;
  }

  async removeDirectory(relativeDir: string): Promise<void> {
    const segments = splitRelativePath(relativeDir);
    if (segments.length === 0) {
      return;
    }
    const normalizedDir = segments.join('/');
    const dirId = await this.resolveDirId(segments, false);
    if (!dirId || dirId === this.rootFolderId) {
      return;
    }
    await deleteDriveFile(dirId);
    this.evictPathPrefix(normalizedDir);
  }

  async purgeDirectoryExcept(
    relativeDir: string,
    keepFileNames: ReadonlySet<string>,
  ): Promise<void> {
    const segments = splitRelativePath(relativeDir);
    const normalizedDir = segments.join('/');
    const dirId = await this.resolveDirId(segments, false);
    if (!dirId) {
      return;
    }

    const children = await listDriveFiles({
      q: `'${escapeDriveQueryLiteral(dirId)}' in parents and trashed = false`,
      fields: 'nextPageToken, files(id, name)',
      pageSize: 200,
    });

    for (const child of children) {
      if (keepFileNames.has(child.name)) {
        continue;
      }
      await deleteDriveFile(child.id);
      const childPath = normalizedDir
        ? `${normalizedDir}/${child.name}`
        : child.name;
      this.evictPathPrefix(childPath);
    }
  }

  async scanItemMetaFiles(): Promise<ScannedVaultMetaEntry[]> {
    await this.ensureCacheHydrated();

    const metaFiles = await listDriveFiles({
      q: "name = 'meta.json' and trashed = false and mimeType != 'application/vnd.google-apps.folder'",
      fields: 'nextPageToken, files(id, name, parents, appProperties)',
      pageSize: 1000,
    });

    if (metaFiles.length === 0) {
      return [];
    }

    // 预拉取文件夹元数据缓存，用于校验 ancestry 是否隶属当前 rootFolderId 并推导相对目录
    const folderMetaCache = new Map<string, DriveFileRecord | null>();
    const resolveFolderPathUnderRoot = async (
      folderId: string,
    ): Promise<string | null> => {
      const chain: string[] = [];
      let currentId = folderId;
      const visited = new Set<string>();

      while (currentId && !visited.has(currentId)) {
        visited.add(currentId);
        if (currentId === this.rootFolderId) {
          chain.reverse();
          return chain.join('/');
        }
        let info = folderMetaCache.get(currentId);
        if (info === undefined) {
          info = await getDriveFileMetadata(currentId, 'id, name, parents');
          folderMetaCache.set(currentId, info);
        }
        if (!info || !info.parents || info.parents.length === 0) {
          return null;
        }
        chain.push(info.name);
        currentId = info.parents[0] ?? '';
      }
      return null;
    };

    const entries: ScannedVaultMetaEntry[] = [];

    for (const metaFile of metaFiles) {
      const parentId = metaFile.parents?.[0];
      if (!parentId) {
        continue;
      }

      const resolvedRelativeDir = await resolveFolderPathUnderRoot(parentId);
      const relativeDir =
        resolvedRelativeDir &&
        (resolvedRelativeDir === ITEMS_DIRNAME ||
          resolvedRelativeDir.startsWith(`${ITEMS_DIRNAME}/`))
          ? resolvedRelativeDir
          : null;

      if (!relativeDir) {
        continue;
      }

      this.pathIdCache.set(relativeDir, parentId);
      this.pathIdCache.set(`${relativeDir}/meta.json`, metaFile.id);

      const metaFileId = metaFile.id;
      const itemDirId = parentId;

      entries.push({
        relativeDir,
        readMetaText: async () => {
          const downloaded = await downloadDriveFile(
            metaFileId,
            'meta.json',
            'application/json; charset=UTF-8',
          );
          if (!downloaded) {
            throw new Error(`Missing meta.json (${metaFileId}) in Google Drive.`);
          }
          return downloaded.text();
        },
        readRelativeFile: async (assetRelativePath: string) => {
          const segments = splitRelativePath(assetRelativePath);
          if (segments.length === 0) {
            return null;
          }
          let currParent = itemDirId;
          for (let i = 0; i < segments.length - 1; i += 1) {
            const seg = segments[i];
            if (!seg) {
              continue;
            }
            const sub = await findDriveChild(currParent, seg, DRIVE_FOLDER_MIME);
            if (!sub) {
              return null;
            }
            currParent = sub.id;
          }
          const leafName = segments[segments.length - 1];
          if (!leafName) {
            return null;
          }
          const child = await findDriveChild(currParent, leafName);
          if (!child || child.mimeType === DRIVE_FOLDER_MIME) {
            return null;
          }
          return downloadDriveFile(
            child.id,
            leafName,
            guessMimeType(leafName),
          );
        },
      });
    }

    this.persistCacheSoon();
    return entries;
  }

  /**
   * 为大视频解析原生支持 HTTP Range 的 Google Drive 流式播放源。
   * 通过会话级 DNR（仅限扩展自身 `media` 请求）注入 `Authorization: Bearer <token>`，
   * 播放组件卸载时自动移除该临时规则。
   */
  async resolvePlayableMedia(
    relativePath: string,
  ): Promise<PlayableMediaSource | null> {
    if (
      typeof chrome === 'undefined' ||
      !chrome.declarativeNetRequest ||
      typeof chrome.declarativeNetRequest.updateSessionRules !== 'function'
    ) {
      return null;
    }

    let resolved = await this.resolveFileId(relativePath);
    if (!resolved) {
      return null;
    }

    let meta = await getDriveFileMetadata(resolved.fileId, 'id, size');
    if (!meta) {
      this.evictPathPrefix(resolved.normalizedPath);
      resolved = await this.resolveFileId(relativePath);
      if (!resolved) {
        return null;
      }
      meta = await getDriveFileMetadata(resolved.fileId, 'id, size');
      if (!meta) {
        return null;
      }
    }

    const token = await getGoogleDriveAccessToken(false);
    if (!token) {
      return null;
    }

    const mediaUrl = `${DRIVE_API_BASE}/files/${encodeURIComponent(resolved.fileId)}?alt=media`;
    const ruleId = await setStorageMediaAuthDnrRule(
      GOOGLE_DRIVE_DNR_RULE_OFFSET,
      mediaUrl,
      `Bearer ${token}`,
    );

    return {
      url: mediaUrl,
      ...(meta.size !== undefined ? { sizeBytes: meta.size } : {}),
      dispose: async () => {
        await clearStorageMediaAuthDnrRule(ruleId).catch(() => undefined);
      },
    };
  }
}
