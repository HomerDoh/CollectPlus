/**
 * Cloudflare R2 `VaultStorageBackend` 驱动实现。
 *
 * 特点：
 * - 将 CollectVault POSIX 相对路径直接映射为 R2 对象键（`<prefix>/<relativePath>`）；
 * - 大文件（>= 5 MiB）自动走 S3 Multipart 8 MiB 分片上传；
 * - `scanItemMetaFiles` 通过单次分页 `ListObjectsV2` 扫描 `<prefix>/items/` 下全部 `meta.json`，高速容灾重建索引；
 * - `resolvePlayableMedia` 生成 SigV4 预签名 GET URL，原生支持 `<video>` HTTP Range 流式拖拽播放，无需持久化密钥。
 */

import type {
  PlayableMediaSource,
  ScannedVaultMetaEntry,
  VaultAccessMode,
  VaultPermissionStatus,
  VaultStorageBackend,
} from '../../../types/storage-provider.ts';
import { splitRelativePath } from '../../path.ts';
import {
  createR2PresignedGetUrl,
  deleteR2Objects,
  getR2Object,
  headR2Object,
  listR2Objects,
  uploadR2Object,
  type R2BucketTarget,
} from './api.ts';
import { getCloudflareR2Credentials } from './auth.ts';
import {
  formatR2TargetLabel,
  type CloudflareR2Config,
} from './config.ts';

const ITEMS_DIRNAME = 'items';
const META_FILENAME = 'meta.json';
const META_SUFFIX = `/${META_FILENAME}`;

function guessMimeType(
  fileName: string,
  fallback = 'application/octet-stream',
): string {
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

export class CloudflareR2VaultBackend implements VaultStorageBackend {
  readonly providerId = 'cloudflare_r2' as const;
  readonly isRemote = true;
  readonly displayName: string;

  private readonly target: R2BucketTarget;
  private readonly prefix: string;

  constructor(config: Pick<CloudflareR2Config, 'endpoint' | 'bucket' | 'prefix'>) {
    this.target = {
      endpoint: config.endpoint,
      bucket: config.bucket,
    };
    this.prefix = config.prefix;
    this.displayName = formatR2TargetLabel(config);
  }

  private toObjectKey(relativePath: string): { key: string; fileName: string } {
    const segments = splitRelativePath(relativePath);
    if (segments.length === 0) {
      throw new Error(`Vault relative path cannot be empty: "${relativePath}"`);
    }
    const fileName = segments[segments.length - 1];
    if (!fileName) {
      throw new Error(`Invalid vault relative path: "${relativePath}"`);
    }
    const normalized = segments.join('/');
    return {
      key: this.prefix ? `${this.prefix}/${normalized}` : normalized,
      fileName,
    };
  }

  private toDirPrefix(relativeDir: string): string {
    const segments = splitRelativePath(relativeDir);
    const normalizedDir = segments.join('/');
    if (!this.prefix && !normalizedDir) {
      return '';
    }
    const combined = this.prefix
      ? normalizedDir
        ? `${this.prefix}/${normalizedDir}`
        : this.prefix
      : normalizedDir;
    return `${combined}/`;
  }

  private stripVaultPrefix(objectKey: string): string | null {
    if (!this.prefix) {
      return objectKey;
    }
    const expectedPrefix = `${this.prefix}/`;
    if (!objectKey.startsWith(expectedPrefix)) {
      return null;
    }
    return objectKey.slice(expectedPrefix.length);
  }

  async queryPermission(
    _mode: VaultAccessMode = 'readwrite',
  ): Promise<VaultPermissionStatus> {
    void _mode;
    if (!this.target.endpoint || !this.target.bucket) {
      return 'unbound';
    }
    const creds = await getCloudflareR2Credentials(this.target);
    return creds ? 'granted' : 'prompt';
  }

  async requestPermission(
    _mode: VaultAccessMode = 'readwrite',
  ): Promise<boolean> {
    void _mode;
    const creds = await getCloudflareR2Credentials(this.target);
    return creds !== null;
  }

  async readFile(relativePath: string): Promise<File | null> {
    const { key, fileName } = this.toObjectKey(relativePath);
    return getR2Object(this.target, key, fileName, guessMimeType(fileName));
  }

  async hasFile(relativePath: string): Promise<boolean> {
    const { key } = this.toObjectKey(relativePath);
    const head = await headR2Object(this.target, key);
    return head !== null;
  }

  async writeTextFile(relativePath: string, content: string): Promise<void> {
    const { key, fileName } = this.toObjectKey(relativePath);
    const mimeType = guessMimeType(fileName, 'text/plain; charset=UTF-8');
    const blob = new Blob([content], { type: mimeType });
    await uploadR2Object(this.target, key, blob, mimeType);
  }

  async writeFile(
    relativePath: string,
    sourceFile: File,
    onProgress?: (loadedBytes: number, totalBytes: number) => void,
  ): Promise<void> {
    const { key, fileName } = this.toObjectKey(relativePath);
    const mimeType =
      sourceFile.type || guessMimeType(fileName, 'application/octet-stream');
    await uploadR2Object(this.target, key, sourceFile, mimeType, onProgress);
  }

  async ensureDirectory(_relativeDir: string): Promise<void> {
    // 对象存储采用扁平键前缀，无需创建空目录占位对象
    void _relativeDir;
  }

  async hasAnyEntry(relativeDir: string): Promise<boolean> {
    const dirPrefix = this.toDirPrefix(relativeDir);
    const objects = await listR2Objects(this.target, dirPrefix, {
      maxKeys: 1,
      maxPages: 1,
    });
    return objects.length > 0;
  }

  async removeDirectory(relativeDir: string): Promise<void> {
    const segments = splitRelativePath(relativeDir);
    if (segments.length === 0) {
      return;
    }
    const dirPrefix = this.toDirPrefix(segments.join('/'));
    const objects = await listR2Objects(this.target, dirPrefix);
    await deleteR2Objects(
      this.target,
      objects.map((o) => o.key),
    );
  }

  async purgeDirectoryExcept(
    relativeDir: string,
    keepFileNames: ReadonlySet<string>,
  ): Promise<void> {
    const segments = splitRelativePath(relativeDir);
    if (segments.length === 0) {
      return;
    }
    const dirPrefix = this.toDirPrefix(segments.join('/'));
    const objects = await listR2Objects(this.target, dirPrefix);

    const keysToDelete: string[] = [];
    for (const obj of objects) {
      if (!obj.key.startsWith(dirPrefix)) {
        continue;
      }
      const remainder = obj.key.slice(dirPrefix.length);
      if (!remainder) {
        continue;
      }
      // 仅保留当前目录直接下属且命中 keepFileNames 的文件，其余文件与子目录全部清理
      if (!remainder.includes('/') && keepFileNames.has(remainder)) {
        continue;
      }
      keysToDelete.push(obj.key);
    }

    await deleteR2Objects(this.target, keysToDelete);
  }

  async scanItemMetaFiles(): Promise<ScannedVaultMetaEntry[]> {
    const itemsPrefix = this.toDirPrefix(ITEMS_DIRNAME);
    const objects = await listR2Objects(this.target, itemsPrefix);

    const entries: ScannedVaultMetaEntry[] = [];
    for (const obj of objects) {
      if (!obj.key.endsWith(META_SUFFIX)) {
        continue;
      }
      const relativeMetaPath = this.stripVaultPrefix(obj.key);
      if (
        !relativeMetaPath ||
        !relativeMetaPath.startsWith(`${ITEMS_DIRNAME}/`) ||
        !relativeMetaPath.endsWith(META_SUFFIX)
      ) {
        continue;
      }

      const relativeDir = relativeMetaPath.slice(0, -META_SUFFIX.length);
      if (!relativeDir) {
        continue;
      }

      const metaKey = obj.key;
      entries.push({
        relativeDir,
        readMetaText: async () => {
          const file = await getR2Object(
            this.target,
            metaKey,
            META_FILENAME,
            'application/json; charset=UTF-8',
          );
          if (!file) {
            throw new Error(`Missing meta.json (${metaKey}) in Cloudflare R2.`);
          }
          return file.text();
        },
        readRelativeFile: async (assetRelativePath: string) => {
          const assetSegments = splitRelativePath(assetRelativePath);
          if (assetSegments.length === 0) {
            return null;
          }
          return this.readFile(`${relativeDir}/${assetSegments.join('/')}`);
        },
      });
    }

    return entries;
  }

  async resolvePlayableMedia(
    relativePath: string,
  ): Promise<PlayableMediaSource | null> {
    const { key } = this.toObjectKey(relativePath);
    const head = await headR2Object(this.target, key);
    if (!head) {
      return null;
    }
    const presignedUrl = await createR2PresignedGetUrl(this.target, key, 3600);
    if (!presignedUrl) {
      return null;
    }
    return {
      url: presignedUrl,
      sizeBytes: head.size,
    };
  }
}
