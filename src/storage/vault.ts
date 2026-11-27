/**
 * File System Access API 本地 Vault 管理器。
 *
 * 负责 CollectVault 目录绑定与权限管理、`README.txt` 自动生成与守护、
 * OPFS -> Vault 原子落盘（VaultFlusher）、双层媒体读取回退，以及基于本地目录的容灾索引重建。
 */

import { ulid } from 'ulid';
import {
  isPlatformId,
  SCHEMA_VERSION,
  stripRecordToMeta,
  type AssetKind,
  type AuthorInfo,
  type CollectionItemMeta,
  type CollectionItemRecord,
  type DownloadStrategy,
  type FolderNode,
  type ItemCommentsFile,
  type MediaAsset,
  type MediaKind,
  type PlatformExtraValue,
  type SavedComment,
  type TagMeta,
  type TaxonomyFile,
  type VaultConfig,
} from '../types/schema.ts';
import {
  db,
  getSetting,
  pickTagColor,
  setSetting,
} from './db.ts';
import {
  listOpfsItemFilePaths,
  readFileFromOpfs,
  removeOpfsItemFiles,
} from './opfs.ts';
import {
  buildFallbackItemRelativeDir,
  buildItemRelativeDir,
  isSafeVaultRelativeDir,
  splitRelativePath,
} from './path.ts';

export const VAULT_README_FILENAME = 'README.txt';
export const VAULT_CONFIG_FILENAME = '.collect-vault.json';
export const TAXONOMY_FILENAME = 'taxonomy.json';
export const ITEMS_DIRNAME = 'items';
export const TRASH_DIRNAME = '.trash';

export const VAULT_MANAGED_ENTRIES = [
  VAULT_README_FILENAME,
  VAULT_CONFIG_FILENAME,
  TAXONOMY_FILENAME,
  ITEMS_DIRNAME,
  TRASH_DIRNAME,
] as const;

const VAULT_MANAGED_ENTRY_SET: ReadonlySet<string> = new Set(
  VAULT_MANAGED_ENTRIES,
);

const DISK_ROOT_SYSTEM_ENTRIES: ReadonlySet<string> = new Set([
  '$recycle.bin',
  'system volume information',
]);

export type VaultPermissionStatus = PermissionState | 'unbound';

export type VaultDirectoryValidationReason =
  | 'disk_root'
  | 'non_empty'
  | 'same_directory'
  | 'nested_directory';

export class VaultDirectoryValidationError extends Error {
  readonly reason: VaultDirectoryValidationReason;
  readonly directoryName: string;

  constructor(
    reason: VaultDirectoryValidationReason,
    directoryName: string,
    cause?: unknown,
  ) {
    const label = directoryName || '所选目录';
    const messageByReason: Record<VaultDirectoryValidationReason, string> = {
      disk_root:
        '不允许选择磁盘根目录或系统受保护目录作为本地同步目录，请在磁盘下新建或选择一个专用的空子文件夹。',
      non_empty: `所选文件夹“${label}”不为空且未被 Collect+ 初始化，请选择一个空文件夹或已初始化的 CollectVault 目录。`,
      same_directory: `所选目录“${label}”与当前本地同步目录相同，无需切换。`,
      nested_directory: `所选目录“${label}”与当前本地同步目录存在父子包含关系，请选择其他独立目录。`,
    };
    super(messageByReason[reason], { cause });
    this.name = 'VaultDirectoryValidationError';
    this.reason = reason;
    this.directoryName = directoryName;
  }
}

export type VaultDirectoryInspection =
  | { kind: 'disk_root' }
  | { kind: 'empty' }
  | { kind: 'non_empty'; entryCount: number }
  | { kind: 'initialized_vault'; config: VaultConfig | null };

export type ValidVaultDirectoryInspection = Extract<
  VaultDirectoryInspection,
  { kind: 'empty' | 'initialized_vault' }
>;

export type VaultMigrationMode = 'empty_target' | 'overwrite' | 'merge';

export interface MigrationProgress {
  phase:
    | 'preparing'
    | 'clearing_target'
    | 'copying'
    | 'finalizing'
    | 'cleaning_source'
    | 'done';
  current: number;
  total: number;
  currentPath?: string;
}

export interface MigrationSummary {
  mode: VaultMigrationMode;
  sourceName: string;
  targetName: string;
  copiedFiles: number;
  skippedFiles: number;
  sourceCleanupFailedCount: number;
  sourceCleanupError?: string;
}

export interface RebuildOptions {
  preserveOpfsStaged?: boolean;
}

// shortcut: 帮助页暂未创建，后续替换为正式文档链接
export const VAULT_PERMISSION_HELP_URL =
  'https://github.com/collect-plus/collect-plus/wiki/vault-permission';

export class VaultFilesystemPermissionError extends Error {
  readonly directoryName: string;

  constructor(directoryName: string, cause?: unknown) {
    super(
      `所选目录“${directoryName}”当前无法写入（常见原因：Windows 文件夹缺少当前用户的写入权限、目录为只读，或被安全软件拦截）。建议改选「文档」目录，或修改该文件夹权限后重试。`,
      { cause },
    );
    this.name = 'VaultFilesystemPermissionError';
    this.directoryName = directoryName;
  }
}

export function isFilesystemWriteDeniedError(error: unknown): boolean {
  if (error instanceof VaultFilesystemPermissionError) {
    return true;
  }
  if (error instanceof DOMException) {
    return error.name === 'NoModificationAllowedError';
  }
  return error instanceof Error && error.name === 'NoModificationAllowedError';
}

export const VAULT_README_CONTENT = `========================================================================
Collect+ 本地离线收藏库（Local Offline Vault）
========================================================================

本目录由浏览器扩展 Collect+ 自动创建并管理，作为您的离线内容真相源（Source of Truth）。
所有收藏的视频、图集、封面以及分类元数据均以人类可读的文件夹结构安全保存在本地硬盘中。

【目录结构说明 / Directory Structure】
- README.txt            本说明文档（Collect+ 会自动检测并守护此文件）
- .collect-vault.json   收藏库标识与版本配置文件
- taxonomy.json         文件夹树与标签体系配置
- items/                按「平台 / 年月 / 日期_源ID_标题」归档的全部收藏条目与媒体文件
                        （每个条目目录下包含 meta.json、对应的视频/图片/封面，以及可选的 comments.json 与 comments/avatars/ 离线评论）
- .trash/               回收站归档目录

【重要警告 / IMPORTANT WARNING】
请勿手动重命名、移动、编辑或删除此目录内的任何文件或子文件夹！
手动改动内部文件结构可能导致索引失效、分类丢失或离线媒体无法读取。

【如何安全迁移收藏库位置 / How to Move This Vault】
如需将本收藏库迁移到其他磁盘或目录，请按以下步骤操作：
1. 将整个 CollectVault 文件夹完整复制或移动到新位置；
2. 打开 Collect+ 管理库页面，在设置中重新绑定新的 CollectVault 目录；
3. 点击执行「重建索引」，即可瞬间恢复全部收藏条目、文件夹、标签与缩略图。

------------------------------------------------------------------------
This directory is managed by the Collect+ browser extension.
DO NOT manually rename, move, edit, or delete files inside this folder.
To relocate your vault, move the entire folder, re-bind it in Collect+,
and run "Rebuild Index".
========================================================================
`;

export interface FlushProgress {
  phase:
    | 'preparing'
    | 'flushing_staged'
    | 'syncing_meta'
    | 'writing_taxonomy'
    | 'done';
  current: number;
  total: number;
  currentTitle?: string;
}

export interface FlushSummary {
  syncedStagedCount: number;
  syncedMetaCount: number;
  failedCount: number;
  errors: Array<{ itemId: string; message: string }>;
}

export interface RebuildProgress {
  phase: 'scanning' | 'importing' | 'done';
  scannedItems: number;
  currentTitle?: string;
}

export interface RebuildSummary {
  restoredItems: number;
  restoredFolders: number;
  restoredTags: number;
  skippedFiles: number;
}

function isNotFoundError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'NotFoundError';
}

function isNameNotAllowedError(error: unknown): boolean {
  return (
    error instanceof TypeError && /Name is not allowed/i.test(error.message)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function toWritableBuffer(chunk: Uint8Array): Uint8Array<ArrayBuffer> {
  if (chunk.buffer instanceof ArrayBuffer) {
    return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  }
  const copy = new Uint8Array(chunk.byteLength);
  copy.set(chunk);
  return copy;
}

// ============================================================================
// 1. 权限与目录绑定
// ============================================================================

/** 读取 IndexedDB 中已持久化的 CollectVault 目录句柄 */
export async function getSavedVaultHandle(): Promise<FileSystemDirectoryHandle | null> {
  const handle = await getSetting('vault_directory_handle');
  return handle ?? null;
}

/** 查询 Vault 目录句柄当前权限状态 */
export async function queryVaultPermission(
  handle: FileSystemDirectoryHandle,
  mode: FileSystemPermissionMode = 'readwrite',
): Promise<PermissionState> {
  return handle.queryPermission({ mode });
}

/** 请求 Vault 目录句柄的访问权限，已授权时直接返回 `true` */
export async function requestVaultPermission(
  handle: FileSystemDirectoryHandle,
  mode: FileSystemPermissionMode = 'readwrite',
): Promise<boolean> {
  const current = await handle.queryPermission({ mode });
  if (current === 'granted') {
    return true;
  }
  const requested = await handle.requestPermission({ mode });
  return requested === 'granted';
}

/** 检测根目录 `README.txt` 是否存在且非空，缺失或为空时自动补写 */
export async function ensureVaultReadme(
  root: FileSystemDirectoryHandle,
): Promise<void> {
  const existing = await readVaultFile(root, VAULT_README_FILENAME);
  if (existing && existing.size > 0) {
    return;
  }
  await writeVaultTextFile(root, VAULT_README_FILENAME, VAULT_README_CONTENT);
}

function parseVaultConfig(raw: unknown): VaultConfig | null {
  if (!isRecord(raw)) {
    return null;
  }
  if (
    raw.schemaVersion !== SCHEMA_VERSION ||
    typeof raw.vaultId !== 'string' ||
    !raw.vaultId.trim() ||
    typeof raw.name !== 'string' ||
    typeof raw.createdAt !== 'number' ||
    !Number.isFinite(raw.createdAt) ||
    typeof raw.updatedAt !== 'number' ||
    !Number.isFinite(raw.updatedAt)
  ) {
    return null;
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    vaultId: raw.vaultId,
    name: raw.name,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
  };
}

/** 检查目录下是否存在至少一个子项 */
async function hasAnyEntry(dir: FileSystemDirectoryHandle): Promise<boolean> {
  for await (const _entry of dir.entries()) {
    void _entry;
    return true;
  }
  return false;
}

/**
 * 初始化并守护 CollectVault 标准目录结构：
 * - `README.txt`（缺失/为空时自动写入）
 * - `.collect-vault.json`
 * - `taxonomy.json`
 * - `items/` 与 `.trash/`
 */
export async function ensureVaultStructure(
  root: FileSystemDirectoryHandle,
): Promise<{ config: VaultConfig; isExistingVault: boolean }> {
  await ensureVaultReadme(root);

  let isExistingVault = false;
  let config: VaultConfig | null = null;

  const configFile = await readVaultFile(root, VAULT_CONFIG_FILENAME);
  if (configFile) {
    try {
      const parsed: unknown = JSON.parse(await configFile.text());
      config = parseVaultConfig(parsed);
      if (config) {
        isExistingVault = true;
      }
    } catch {
      // 配置文件损坏时在下方安全重建
    }
  }

  const itemsDir = await root.getDirectoryHandle(ITEMS_DIRNAME, {
    create: true,
  });
  await root.getDirectoryHandle(TRASH_DIRNAME, { create: true });

  const taxonomyFile = await readVaultFile(root, TAXONOMY_FILENAME);
  if (!isExistingVault) {
    if (taxonomyFile || (await hasAnyEntry(itemsDir))) {
      isExistingVault = true;
    }
  }

  const now = Date.now();
  if (!config) {
    config = {
      schemaVersion: SCHEMA_VERSION,
      vaultId: ulid(),
      name: root.name || 'CollectVault',
      createdAt: now,
      updatedAt: now,
    };
    await writeVaultTextFile(
      root,
      VAULT_CONFIG_FILENAME,
      JSON.stringify(config, null, 2),
    );
  }

  if (!taxonomyFile) {
    const initialTaxonomy: TaxonomyFile = {
      schemaVersion: SCHEMA_VERSION,
      updatedAt: now,
      folders: [],
      tags: [],
    };
    await writeVaultTextFile(
      root,
      TAXONOMY_FILENAME,
      JSON.stringify(initialTaxonomy, null, 2),
    );
  }

  return { config, isExistingVault };
}

/** 判断目录名是否表示磁盘根目录（Windows 盘符根、POSIX `/` 或 UNC 共享根） */
export function isDiskRootDirectoryName(name: string): boolean {
  const trimmed = name.trim();
  if (!trimmed || trimmed === '/' || trimmed === '\\') {
    return true;
  }
  if (/^[a-zA-Z]:[\\/]?$/.test(trimmed)) {
    return true;
  }
  if (/^\\\\[^\\]+\\[^\\]+[\\/]?$/.test(trimmed)) {
    return true;
  }
  return false;
}

async function isSameDirectoryHandle(
  a: FileSystemDirectoryHandle,
  b: FileSystemDirectoryHandle,
): Promise<boolean> {
  if (a === b) {
    return true;
  }
  try {
    if (typeof a.isSameEntry === 'function') {
      return await a.isSameEntry(b);
    }
  } catch {
    // 忽略非标准句柄异常
  }
  return false;
}

async function isNestedDirectoryHandle(
  a: FileSystemDirectoryHandle,
  b: FileSystemDirectoryHandle,
): Promise<boolean> {
  try {
    if (typeof a.resolve === 'function') {
      const resolved = await a.resolve(b);
      if (resolved !== null && resolved.length > 0) {
        return true;
      }
    }
  } catch {
    // 忽略
  }
  try {
    if (typeof b.resolve === 'function') {
      const resolved = await b.resolve(a);
      if (resolved !== null && resolved.length > 0) {
        return true;
      }
    }
  } catch {
    // 忽略
  }
  return false;
}

/** 检测已绑定目录在磁盘上是否仍然存在 */
export async function checkVaultDirectoryExists(
  handle: FileSystemDirectoryHandle,
): Promise<boolean> {
  try {
    for await (const _entry of handle.entries()) {
      void _entry;
      break;
    }
    return true;
  } catch (error) {
    if (isNotFoundError(error)) {
      return false;
    }
    throw error;
  }
}

/**
 * 只读检测目标目录状态（绝不写入任何文件或子目录）：
 * - `disk_root`: 磁盘根目录或包含卷根系统文件夹
 * - `empty`: 空文件夹
 * - `initialized_vault`: 已被 Collect+ 初始化的本地同步目录
 * - `non_empty`: 非空且未初始化的普通文件夹
 */
export async function inspectVaultDirectory(
  handle: FileSystemDirectoryHandle,
): Promise<VaultDirectoryInspection> {
  if (isDiskRootDirectoryName(handle.name)) {
    return { kind: 'disk_root' };
  }

  let entryCount = 0;
  let hasConfigFile = false;
  let hasTaxonomyFile = false;
  let hasItemsDir = false;
  let hasReadmeFile = false;

  for await (const [name, entry] of handle.entries()) {
    entryCount += 1;
    if (DISK_ROOT_SYSTEM_ENTRIES.has(name.toLowerCase())) {
      return { kind: 'disk_root' };
    }
    if (entry.kind === 'file') {
      if (name === VAULT_CONFIG_FILENAME) {
        hasConfigFile = true;
      } else if (name === TAXONOMY_FILENAME) {
        hasTaxonomyFile = true;
      } else if (name === VAULT_README_FILENAME) {
        hasReadmeFile = true;
      }
    } else if (entry.kind === 'directory' && name === ITEMS_DIRNAME) {
      hasItemsDir = true;
    }
  }

  if (entryCount === 0) {
    return { kind: 'empty' };
  }

  if (hasConfigFile) {
    const configFile = await readVaultFile(handle, VAULT_CONFIG_FILENAME);
    if (configFile) {
      try {
        const parsed: unknown = JSON.parse(await configFile.text());
        const config = parseVaultConfig(parsed);
        if (config) {
          return { kind: 'initialized_vault', config };
        }
      } catch {
        // .collect-vault.json 损坏时继续检查 taxonomy.json 兜底特征
      }
    }
  }

  if (hasTaxonomyFile) {
    const taxonomyFile = await readVaultFile(handle, TAXONOMY_FILENAME);
    if (taxonomyFile) {
      try {
        const parsed: unknown = JSON.parse(await taxonomyFile.text());
        const isCollectTaxonomy =
          isRecord(parsed) &&
          parsed.schemaVersion === SCHEMA_VERSION &&
          Array.isArray(parsed.folders) &&
          Array.isArray(parsed.tags);
        if (isCollectTaxonomy) {
          let hasCollectReadme = false;
          if (!hasItemsDir && hasReadmeFile) {
            const readmeFile = await readVaultFile(
              handle,
              VAULT_README_FILENAME,
            );
            if (readmeFile) {
              hasCollectReadme = (await readmeFile.text()).includes('Collect+');
            }
          }
          if (hasItemsDir || hasCollectReadme) {
            return { kind: 'initialized_vault', config: null };
          }
        }
      } catch {
        // 忽略无效 JSON
      }
    }
  }

  return { kind: 'non_empty', entryCount };
}

/**
 * 弹出系统目录选择器并只读校验目标目录合法性：
 * 拦截磁盘根目录、非空未初始化文件夹，以及与当前目录相同或父子嵌套的目录。
 */
export async function pickAndValidateVaultDirectory(
  currentHandle?: FileSystemDirectoryHandle | null,
): Promise<{
  handle: FileSystemDirectoryHandle;
  inspection: ValidVaultDirectoryInspection;
}> {
  if (
    typeof window === 'undefined' ||
    typeof window.showDirectoryPicker !== 'function'
  ) {
    throw new Error(
      'File System Access API (showDirectoryPicker) is not supported in this context.',
    );
  }

  let handle: FileSystemDirectoryHandle;
  try {
    handle = await window.showDirectoryPicker({
      id: 'collect-plus-vault',
      mode: 'readwrite',
      startIn: 'documents',
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'SecurityError') {
      throw new VaultDirectoryValidationError('disk_root', '', error);
    }
    throw error;
  }

  const granted = await requestVaultPermission(handle, 'readwrite');
  if (!granted) {
    throw new Error(
      'Read/write permission for the selected Vault directory was denied.',
    );
  }

  if (currentHandle) {
    if (await isSameDirectoryHandle(currentHandle, handle)) {
      throw new VaultDirectoryValidationError('same_directory', handle.name);
    }
    if (await isNestedDirectoryHandle(currentHandle, handle)) {
      throw new VaultDirectoryValidationError('nested_directory', handle.name);
    }
  }

  const inspection = await inspectVaultDirectory(handle);
  if (inspection.kind === 'disk_root') {
    throw new VaultDirectoryValidationError('disk_root', handle.name);
  }
  if (inspection.kind === 'non_empty') {
    throw new VaultDirectoryValidationError('non_empty', handle.name);
  }

  return { handle, inspection };
}

/** 初始化并持久化已校验通过的 CollectVault 目录句柄与配置到 IndexedDB */
export async function finalizeVaultBinding(
  handle: FileSystemDirectoryHandle,
): Promise<{
  handle: FileSystemDirectoryHandle;
  config: VaultConfig;
  isExistingVault: boolean;
}> {
  let config: VaultConfig;
  let isExistingVault: boolean;
  try {
    const ensured = await ensureVaultStructure(handle);
    config = ensured.config;
    isExistingVault = ensured.isExistingVault;
  } catch (error) {
    if (isFilesystemWriteDeniedError(error)) {
      throw new VaultFilesystemPermissionError(
        handle.name || 'CollectVault',
        error,
      );
    }
    throw error;
  }

  await setSetting('vault_directory_handle', handle);
  await setSetting('vault_config', config);

  return { handle, config, isExistingVault };
}

/** 弹出系统目录选择器校验并绑定新的 CollectVault（不含旧目录迁移） */
export async function bindNewVaultDirectory(): Promise<{
  handle: FileSystemDirectoryHandle;
  config: VaultConfig;
  isExistingVault: boolean;
}> {
  const { handle } = await pickAndValidateVaultDirectory(null);
  return finalizeVaultBinding(handle);
}

// ============================================================================
// 2. 通用文件读写与双层读取回退
// ============================================================================

async function resolveVaultTarget(
  root: FileSystemDirectoryHandle,
  relativePath: string,
  createDirs: boolean,
): Promise<{ parentDir: FileSystemDirectoryHandle; fileName: string } | null> {
  const segments = splitRelativePath(relativePath);
  if (segments.length === 0) {
    throw new Error(`Vault relative path cannot be empty: "${relativePath}"`);
  }

  const fileName = segments[segments.length - 1];
  if (!fileName) {
    throw new Error(`Invalid vault relative path: "${relativePath}"`);
  }

  let currentDir = root;
  try {
    for (let i = 0; i < segments.length - 1; i += 1) {
      const seg = segments[i];
      if (!seg) {
        continue;
      }
      currentDir = await currentDir.getDirectoryHandle(seg, {
        create: createDirs,
      });
    }
  } catch (error) {
    if (!createDirs && isNotFoundError(error)) {
      return null;
    }
    throw error;
  }

  return { parentDir: currentDir, fileName };
}

/** 读取 Vault 中指定相对路径的文件，不存在时返回 `null` */
export async function readVaultFile(
  root: FileSystemDirectoryHandle,
  relativePath: string,
): Promise<File | null> {
  const target = await resolveVaultTarget(root, relativePath, false);
  if (!target) {
    return null;
  }

  try {
    const fileHandle = await target.parentDir.getFileHandle(target.fileName, {
      create: false,
    });
    return await fileHandle.getFile();
  } catch (error) {
    if (isNotFoundError(error)) {
      return null;
    }
    throw error;
  }
}

/** 判断 Vault 中指定相对路径的文件是否存在 */
async function hasVaultFile(
  root: FileSystemDirectoryHandle,
  relativePath: string,
): Promise<boolean> {
  const target = await resolveVaultTarget(root, relativePath, false);
  if (!target) {
    return false;
  }
  try {
    await target.parentDir.getFileHandle(target.fileName, { create: false });
    return true;
  } catch (error) {
    if (isNotFoundError(error)) {
      return false;
    }
    throw error;
  }
}

/** 向 Vault 指定相对路径写入 UTF-8 文本文件（自动创建父目录） */
export async function writeVaultTextFile(
  root: FileSystemDirectoryHandle,
  relativePath: string,
  content: string,
): Promise<void> {
  const target = await resolveVaultTarget(root, relativePath, true);
  if (!target) {
    throw new Error(`Failed to resolve vault path: "${relativePath}"`);
  }

  const { parentDir, fileName } = target;
  const fileHandle = await parentDir.getFileHandle(fileName, { create: true });
  const writable = await fileHandle.createWritable();

  try {
    await writable.write(content);
    await writable.close();
  } catch (error) {
    await writable.abort().catch(() => undefined);
    throw error;
  }
}

/** 将源 `File` 流式拷贝写入 Vault 指定相对路径，避免大视频文件全量载入内存 */
async function copyFileToVault(
  root: FileSystemDirectoryHandle,
  relativePath: string,
  sourceFile: File,
): Promise<void> {
  const target = await resolveVaultTarget(root, relativePath, true);
  if (!target) {
    throw new Error(`Failed to resolve vault path: "${relativePath}"`);
  }

  const { parentDir, fileName } = target;
  const fileHandle = await parentDir.getFileHandle(fileName, { create: true });
  const writable = await fileHandle.createWritable();
  const reader = sourceFile.stream().getReader();
  let closed = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value && value.byteLength > 0) {
        await writable.write(toWritableBuffer(value));
      }
    }
    await writable.close();
    closed = true;
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    if (!closed) {
      await writable.abort().catch(() => undefined);
    }
    await parentDir.removeEntry(fileName).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

/**
 * 统一读取条目媒体资产：
 * 1. 优先从 CollectVault（若句柄可用且已获至少 `read` 权限）读取 `${item.relativeDir}/${assetRelativePath}`；
 * 2. 缺失或无 Vault 权限时自动回退至 OPFS `(item.id, assetRelativePath)`。
 */
export async function readItemAssetFile(
  item: CollectionItemRecord,
  assetRelativePath: string,
  vaultHandle?: FileSystemDirectoryHandle | null,
): Promise<File | null> {
  const effectiveHandle =
    vaultHandle === undefined ? await getSavedVaultHandle() : vaultHandle;

  if (effectiveHandle) {
    try {
      const permission = await queryVaultPermission(effectiveHandle, 'read');
      if (permission === 'granted') {
        const vaultFile = await readVaultFile(
          effectiveHandle,
          `${item.relativeDir}/${assetRelativePath}`,
        );
        if (vaultFile) {
          return vaultFile;
        }
      }
    } catch {
      // Vault 访问异常时静默回退到 OPFS
    }
  }

  return readFileFromOpfs(item.id, assetRelativePath);
}

function parseSavedComment(raw: unknown): SavedComment | null {
  if (!isRecord(raw)) {
    return null;
  }
  if (
    typeof raw.id !== 'string' ||
    !raw.id.trim() ||
    typeof raw.authorName !== 'string' ||
    typeof raw.content !== 'string'
  ) {
    return null;
  }

  let avatarRelativePath: string | undefined;
  if (
    typeof raw.avatarRelativePath === 'string' &&
    raw.avatarRelativePath.trim()
  ) {
    try {
      if (splitRelativePath(raw.avatarRelativePath).length > 0) {
        avatarRelativePath = raw.avatarRelativePath;
      }
    } catch {
      avatarRelativePath = undefined;
    }
  }

  const likeCount =
    typeof raw.likeCount === 'number' &&
    Number.isFinite(raw.likeCount) &&
    raw.likeCount >= 0
      ? Math.trunc(raw.likeCount)
      : 0;

  return {
    id: raw.id.trim(),
    ...(typeof raw.authorId === 'string' && raw.authorId.trim()
      ? { authorId: raw.authorId.trim() }
      : {}),
    authorName: raw.authorName.trim() || '匿名用户',
    ...(avatarRelativePath !== undefined ? { avatarRelativePath } : {}),
    content: raw.content,
    likeCount,
    ...(typeof raw.createdAt === 'number' && Number.isFinite(raw.createdAt)
      ? { createdAt: Math.trunc(raw.createdAt) }
      : {}),
  };
}

function parseItemCommentsFile(raw: unknown): ItemCommentsFile | null {
  if (!isRecord(raw)) {
    return null;
  }
  if (
    !isPlatformId(raw.platform) ||
    typeof raw.sourceId !== 'string' ||
    !Array.isArray(raw.comments)
  ) {
    return null;
  }

  const comments: SavedComment[] = [];
  for (const entry of raw.comments) {
    const parsed = parseSavedComment(entry);
    if (parsed) {
      comments.push(parsed);
    }
  }

  const capturedAt =
    typeof raw.capturedAt === 'number' && Number.isFinite(raw.capturedAt)
      ? Math.trunc(raw.capturedAt)
      : 0;
  const limit =
    typeof raw.limit === 'number' && Number.isFinite(raw.limit) && raw.limit > 0
      ? Math.trunc(raw.limit)
      : 100;

  return {
    schemaVersion: SCHEMA_VERSION,
    platform: raw.platform,
    sourceId: raw.sourceId,
    capturedAt,
    limit,
    comments,
  };
}

/**
 * 100% 离线读取条目评论快照（优先 CollectVault，自动回退 OPFS）。
 */
export async function readItemComments(
  item: CollectionItemRecord,
  vaultHandle?: FileSystemDirectoryHandle | null,
): Promise<ItemCommentsFile | null> {
  const commentsPath = item.commentsRelativePath ?? 'comments.json';
  const file = await readItemAssetFile(item, commentsPath, vaultHandle);
  if (!file) {
    return null;
  }
  try {
    const raw: unknown = JSON.parse(await file.text());
    return parseItemCommentsFile(raw);
  } catch {
    return null;
  }
}

// ============================================================================
// 3. 业务落盘与同步（VaultFlusher）
// ============================================================================

const VAULT_IO_LOCK_NAME = 'collect-plus-vault-io';

/** 跨上下文互斥锁：串行化 Offscreen 自动落盘与管理台手动同步/迁移/重建对 CollectVault 的写入 */
async function withVaultIoLock<T>(task: () => Promise<T>): Promise<T> {
  if (
    typeof navigator !== 'undefined' &&
    navigator.locks &&
    typeof navigator.locks.request === 'function'
  ) {
    return navigator.locks.request(
      VAULT_IO_LOCK_NAME,
      { mode: 'exclusive' },
      async () => task(),
    );
  }
  return task();
}

async function writeTaxonomyToVaultUnlocked(
  root: FileSystemDirectoryHandle,
): Promise<void> {
  const [folders, tags] = await Promise.all([
    db.folders.toArray(),
    db.tags.toArray(),
  ]);

  folders.sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt - b.createdAt);
  tags.sort((a, b) => a.createdAt - b.createdAt || a.name.localeCompare(b.name));

  const payload: TaxonomyFile = {
    schemaVersion: SCHEMA_VERSION,
    updatedAt: Date.now(),
    folders,
    tags,
  };

  await writeVaultTextFile(
    root,
    TAXONOMY_FILENAME,
    JSON.stringify(payload, null, 2),
  );
}

/** 将 IndexedDB 中最新的文件夹树与标签表全量回写到 `CollectVault/taxonomy.json` */
export async function writeTaxonomyToVault(
  root: FileSystemDirectoryHandle,
): Promise<void> {
  return withVaultIoLock(() => writeTaxonomyToVaultUnlocked(root));
}

async function writeItemMetaToVaultUnlocked(
  root: FileSystemDirectoryHandle,
  item: CollectionItemRecord,
): Promise<void> {
  const cleanMeta = stripRecordToMeta(item);
  await writeVaultTextFile(
    root,
    `${cleanMeta.relativeDir}/meta.json`,
    JSON.stringify(cleanMeta, null, 2),
  );
}

/**
 * 将单个条目的纯净元数据写入 `CollectVault/{item.relativeDir}/meta.json`。
 * 强制通过 `stripRecordToMeta` 剥离 `thumbnailDataUrl`。
 */
export async function writeItemMetaToVault(
  root: FileSystemDirectoryHandle,
  item: CollectionItemRecord,
): Promise<void> {
  return withVaultIoLock(() => writeItemMetaToVaultUnlocked(root, item));
}

async function copyStagedCommentFilesToDir(
  root: FileSystemDirectoryHandle,
  item: CollectionItemRecord,
  targetRelativeDir: string,
  copiedPaths: string[],
): Promise<void> {
  if (!item.commentsRelativePath) {
    return;
  }

  const allOpfsPaths = await listOpfsItemFilePaths(item.id);
  const commentPaths = allOpfsPaths.filter(
    (relPath) =>
      relPath === item.commentsRelativePath || relPath.startsWith('comments/'),
  );

  for (const relPath of commentPaths) {
    const opfsFile = await readFileFromOpfs(item.id, relPath);
    if (opfsFile) {
      await copyFileToVault(root, `${targetRelativeDir}/${relPath}`, opfsFile);
      copiedPaths.push(relPath);
    }
  }
}

async function syncStagedItemToDir(
  root: FileSystemDirectoryHandle,
  item: CollectionItemRecord,
  targetRelativeDir: string,
): Promise<string[]> {
  const copiedPaths: string[] = [];

  for (const asset of item.assets) {
    const opfsFile = await readFileFromOpfs(item.id, asset.relativePath);
    const vaultAssetPath = `${targetRelativeDir}/${asset.relativePath}`;

    if (opfsFile) {
      await copyFileToVault(root, vaultAssetPath, opfsFile);
      copiedPaths.push(asset.relativePath);
    } else if (asset.downloaded) {
      const alreadyInVault = await hasVaultFile(root, vaultAssetPath);
      if (!alreadyInVault) {
        throw new Error(
          `Missing staged asset "${asset.relativePath}" in both OPFS and Vault.`,
        );
      }
    }
  }

  await copyStagedCommentFilesToDir(root, item, targetRelativeDir, copiedPaths);

  const syncedSnapshot: CollectionItemRecord = {
    ...item,
    relativeDir: targetRelativeDir,
    syncStatus: 'vault_synced',
  };
  await writeItemMetaToVaultUnlocked(root, syncedSnapshot);

  return copiedPaths;
}

async function flushToVaultUnlocked(
  root: FileSystemDirectoryHandle,
  onProgress?: (p: FlushProgress) => void,
): Promise<FlushSummary> {
  const summary: FlushSummary = {
    syncedStagedCount: 0,
    syncedMetaCount: 0,
    failedCount: 0,
    errors: [],
  };

  onProgress?.({ phase: 'preparing', current: 0, total: 0 });
  await ensureVaultStructure(root);

  const [stagedItems, dirtyItems] = await Promise.all([
    db.items.where('syncStatus').equals('opfs_staged').toArray(),
    db.items.where('syncStatus').equals('meta_dirty').toArray(),
  ]);

  // Phase 1: 同步 OPFS 暂存条目
  for (let i = 0; i < stagedItems.length; i += 1) {
    const item = stagedItems[i];
    if (!item) {
      continue;
    }

    onProgress?.({
      phase: 'flushing_staged',
      current: i + 1,
      total: stagedItems.length,
      currentTitle: item.title,
    });

    try {
      // 存量自愈：对尚未落盘但含非法目录段（如旧版保留的 ~ / . / 零宽字符）的暂存条目按最新规则重算路径
      let effectiveRelativeDir = isSafeVaultRelativeDir(item.relativeDir)
        ? item.relativeDir
        : buildItemRelativeDir(
            item.platform,
            item.sourceId,
            item.title,
            item.collectedAt,
          );

      let copiedPaths: string[];
      try {
        copiedPaths = await syncStagedItemToDir(root, item, effectiveRelativeDir);
      } catch (error) {
        if (!isNameNotAllowedError(error)) {
          throw error;
        }
        // 运行时兜底：若未来浏览器新增未预见的目录名限制，降级为纯 ASCII 安全路径（不含标题）重试一次
        const fallbackDir = buildFallbackItemRelativeDir(
          item.platform,
          item.sourceId,
          item.collectedAt,
          item.id,
        );
        if (fallbackDir === effectiveRelativeDir) {
          throw error;
        }
        effectiveRelativeDir = fallbackDir;
        copiedPaths = await syncStagedItemToDir(root, item, effectiveRelativeDir);
      }

      await db.transaction('rw', db.items, async () => {
        const latest = await db.items.get(item.id);
        if (!latest) {
          return;
        }
        // 若同步过程中用户又修改了该条目，则转为 meta_dirty 以保留最新编辑待下次写回
        const nextStatus =
          latest.updatedAt > item.updatedAt ? 'meta_dirty' : 'vault_synced';
        await db.items.put({
          ...latest,
          relativeDir: effectiveRelativeDir,
          syncStatus: nextStatus,
        });
      });

      await removeOpfsItemFiles(item.id, copiedPaths);
      summary.syncedStagedCount += 1;
    } catch (error) {
      summary.failedCount += 1;
      summary.errors.push({
        itemId: item.id,
        message: getErrorMessage(error),
      });
    }
  }

  // Phase 2: 回写元数据变更条目（顺带清理可能残余的 OPFS 文件）
  for (let i = 0; i < dirtyItems.length; i += 1) {
    const item = dirtyItems[i];
    if (!item) {
      continue;
    }

    onProgress?.({
      phase: 'syncing_meta',
      current: i + 1,
      total: dirtyItems.length,
      currentTitle: item.title,
    });

    try {
      const copiedPaths: string[] = [];
      for (const asset of item.assets) {
        const opfsFile = await readFileFromOpfs(item.id, asset.relativePath);
        if (opfsFile) {
          await copyFileToVault(
            root,
            `${item.relativeDir}/${asset.relativePath}`,
            opfsFile,
          );
          copiedPaths.push(asset.relativePath);
        }
      }

      await copyStagedCommentFilesToDir(
        root,
        item,
        item.relativeDir,
        copiedPaths,
      );

      const syncedSnapshot: CollectionItemRecord = {
        ...item,
        syncStatus: 'vault_synced',
      };
      await writeItemMetaToVaultUnlocked(root, syncedSnapshot);

      await db.transaction('rw', db.items, async () => {
        const latest = await db.items.get(item.id);
        if (!latest) {
          return;
        }
        const nextStatus =
          latest.updatedAt > item.updatedAt ? 'meta_dirty' : 'vault_synced';
        await db.items.put({
          ...latest,
          syncStatus: nextStatus,
        });
      });

      if (copiedPaths.length > 0) {
        await removeOpfsItemFiles(item.id, copiedPaths);
      }

      summary.syncedMetaCount += 1;
    } catch (error) {
      summary.failedCount += 1;
      summary.errors.push({
        itemId: item.id,
        message: getErrorMessage(error),
      });
    }
  }

  // Phase 3: 回写分类与标签索引并记录最近同步时间
  onProgress?.({
    phase: 'writing_taxonomy',
    current: 1,
    total: 1,
  });
  await writeTaxonomyToVaultUnlocked(root);
  await setSetting('last_sync_at', Date.now());

  const totalProcessed = stagedItems.length + dirtyItems.length;
  onProgress?.({
    phase: 'done',
    current: totalProcessed,
    total: totalProcessed,
  });

  return summary;
}

/**
 * 执行 OPFS -> CollectVault 同步落盘：
 * 1. 守护目录结构与 `README.txt`；
 * 2. 将 `opfs_staged` 条目的已下载媒体流式拷贝到 Vault，写入 `meta.json`，更新 DB 状态并释放 OPFS；
 * 3. 将 `meta_dirty` 条目的残余 OPFS 文件（如有）补齐落盘并回写最新 `meta.json`；
 * 4. 回写 `taxonomy.json` 并更新 `last_sync_at`。
 */
export async function flushToVault(
  root: FileSystemDirectoryHandle,
  onProgress?: (p: FlushProgress) => void,
): Promise<FlushSummary> {
  return withVaultIoLock(() => flushToVaultUnlocked(root, onProgress));
}

/**
 * 后台静默自动落盘：在已绑定目录且已持有 `readwrite` 权限（不触发需要用户手势的弹窗）时，
 * 立即将待同步条目从 OPFS 落盘至 `CollectVault`；未绑定、无权限或无待同步条目时返回 `null`。
 */
export async function tryAutoFlushToVault(): Promise<FlushSummary | null> {
  return withVaultIoLock(async () => {
    const handle = await getSavedVaultHandle();
    if (!handle) {
      return null;
    }
    const permission = await queryVaultPermission(handle, 'readwrite');
    if (permission !== 'granted') {
      return null;
    }
    const [stagedCount, dirtyCount] = await Promise.all([
      db.items.where('syncStatus').equals('opfs_staged').count(),
      db.items.where('syncStatus').equals('meta_dirty').count(),
    ]);
    if (stagedCount + dirtyCount === 0) {
      return null;
    }
    return flushToVaultUnlocked(handle);
  });
}

// ============================================================================
// 4. 缩略图生成与容灾索引重建扫描器
// ============================================================================

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        resolve(reader.result);
      } else {
        reject(new Error('FileReader did not produce a string Data URL.'));
      }
    };
    reader.onerror = () => {
      reject(reader.error ?? new Error('Failed to read thumbnail Blob.'));
    };
    reader.readAsDataURL(blob);
  });
}

function loadImageElementFromBlob(blob: Blob): Promise<HTMLImageElement> {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const objectUrl = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(objectUrl);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error('Failed to decode image blob.'));
    };
    img.src = objectUrl;
  });
}

function computeThumbnailDimensions(
  srcWidth: number,
  srcHeight: number,
  maxWidth: number,
): { width: number; height: number } {
  const safeMaxWidth = Math.max(1, Math.floor(maxWidth));
  if (srcWidth <= safeMaxWidth) {
    return {
      width: Math.max(1, Math.round(srcWidth)),
      height: Math.max(1, Math.round(srcHeight)),
    };
  }
  const scale = safeMaxWidth / srcWidth;
  return {
    width: safeMaxWidth,
    height: Math.max(1, Math.round(srcHeight * scale)),
  };
}

/**
 * 将图片 Blob 压缩为低分辨率 `image/webp` Data URL 缩略图（默认最大宽 360px，quality 0.78）。
 * 优先使用 `createImageBitmap` + `OffscreenCanvas`，不可用时自动降级到 `HTMLCanvasElement`。
 * 任何解码或渲染异常均安全吞掉并返回 `undefined`。
 */
export async function generateThumbnailFromBlob(
  blob: Blob,
  maxWidth = 360,
): Promise<string | undefined> {
  if (blob.size === 0) {
    return undefined;
  }

  const safeMaxWidth = Math.max(1, Math.floor(maxWidth));

  try {
    if (
      typeof createImageBitmap === 'function' &&
      typeof OffscreenCanvas === 'function'
    ) {
      const bitmap = await createImageBitmap(blob);
      try {
        if (bitmap.width <= 0 || bitmap.height <= 0) {
          return undefined;
        }
        const { width, height } = computeThumbnailDimensions(
          bitmap.width,
          bitmap.height,
          safeMaxWidth,
        );
        const canvas = new OffscreenCanvas(width, height);
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          return undefined;
        }
        ctx.drawImage(bitmap, 0, 0, width, height);
        const thumbBlob = await canvas.convertToBlob({
          type: 'image/webp',
          quality: 0.78,
        });
        return await blobToDataUrl(thumbBlob);
      } finally {
        bitmap.close();
      }
    }

    if (typeof document !== 'undefined') {
      const img = await loadImageElementFromBlob(blob);
      const naturalW = img.naturalWidth || img.width;
      const naturalH = img.naturalHeight || img.height;
      if (naturalW <= 0 || naturalH <= 0) {
        return undefined;
      }
      const { width, height } = computeThumbnailDimensions(
        naturalW,
        naturalH,
        safeMaxWidth,
      );
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        return undefined;
      }
      ctx.drawImage(img, 0, 0, width, height);
      return canvas.toDataURL('image/webp', 0.78);
    }

    return undefined;
  } catch {
    return undefined;
  }
}

const VALID_MEDIA_KINDS: ReadonlySet<string> = new Set<MediaKind>([
  'video',
  'gallery',
  'image',
  'article',
]);

const VALID_ASSET_KINDS: ReadonlySet<string> = new Set<AssetKind>([
  'cover',
  'video',
  'audio',
  'image',
]);

const VALID_DOWNLOAD_STRATEGIES: ReadonlySet<string> = new Set<DownloadStrategy>(
  ['direct', 'dash_mux', 'hls_mux'],
);

function parseStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === 'string' && item.trim()) {
      out.push(item.trim());
    }
  }
  return out;
}

function parseAuthorInfo(raw: unknown): AuthorInfo | null {
  if (!isRecord(raw)) {
    return null;
  }
  if (typeof raw.id !== 'string' || typeof raw.name !== 'string') {
    return null;
  }
  return {
    id: raw.id,
    name: raw.name,
    ...(typeof raw.handle === 'string' ? { handle: raw.handle } : {}),
    ...(typeof raw.avatarUrl === 'string' ? { avatarUrl: raw.avatarUrl } : {}),
    ...(typeof raw.profileUrl === 'string'
      ? { profileUrl: raw.profileUrl }
      : {}),
  };
}

function parseMediaAsset(raw: unknown): MediaAsset | null {
  if (!isRecord(raw)) {
    return null;
  }
  if (
    typeof raw.id !== 'string' ||
    typeof raw.kind !== 'string' ||
    !VALID_ASSET_KINDS.has(raw.kind) ||
    typeof raw.strategy !== 'string' ||
    !VALID_DOWNLOAD_STRATEGIES.has(raw.strategy) ||
    typeof raw.sourceUrl !== 'string' ||
    typeof raw.relativePath !== 'string' ||
    typeof raw.mimeType !== 'string'
  ) {
    return null;
  }

  try {
    const segs = splitRelativePath(raw.relativePath);
    if (segs.length === 0) {
      return null;
    }
  } catch {
    return null;
  }

  const fallbackUrls = Array.isArray(raw.fallbackUrls)
    ? raw.fallbackUrls.filter((u): u is string => typeof u === 'string')
    : undefined;
  const audioFallbackUrls = Array.isArray(raw.audioFallbackUrls)
    ? raw.audioFallbackUrls.filter((u): u is string => typeof u === 'string')
    : undefined;

  return {
    id: raw.id,
    kind: raw.kind as AssetKind,
    strategy: raw.strategy as DownloadStrategy,
    sourceUrl: raw.sourceUrl,
    relativePath: raw.relativePath,
    mimeType: raw.mimeType,
    downloaded: typeof raw.downloaded === 'boolean' ? raw.downloaded : true,
    ...(fallbackUrls && fallbackUrls.length > 0 ? { fallbackUrls } : {}),
    ...(typeof raw.audioUrl === 'string' ? { audioUrl: raw.audioUrl } : {}),
    ...(audioFallbackUrls && audioFallbackUrls.length > 0
      ? { audioFallbackUrls }
      : {}),
    ...(typeof raw.sizeBytes === 'number' && Number.isFinite(raw.sizeBytes)
      ? { sizeBytes: raw.sizeBytes }
      : {}),
    ...(typeof raw.width === 'number' && Number.isFinite(raw.width)
      ? { width: raw.width }
      : {}),
    ...(typeof raw.height === 'number' && Number.isFinite(raw.height)
      ? { height: raw.height }
      : {}),
    ...(typeof raw.durationSec === 'number' && Number.isFinite(raw.durationSec)
      ? { durationSec: raw.durationSec }
      : {}),
  };
}

function parsePlatformExtra(
  raw: unknown,
): Record<string, PlatformExtraValue> | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const result: Record<string, PlatformExtraValue> = {};
  let count = 0;
  for (const [key, val] of Object.entries(raw)) {
    if (
      typeof val === 'string' ||
      typeof val === 'number' ||
      typeof val === 'boolean' ||
      val === null
    ) {
      result[key] = val;
      count += 1;
    }
  }
  return count > 0 ? result : undefined;
}

function parseCollectionItemMeta(
  raw: unknown,
  scannedRelativeDir: string,
): CollectionItemMeta | null {
  if (!isRecord(raw)) {
    return null;
  }

  if (
    typeof raw.id !== 'string' ||
    !raw.id.trim() ||
    !isPlatformId(raw.platform) ||
    typeof raw.sourceId !== 'string' ||
    !raw.sourceId.trim() ||
    typeof raw.sourceUrl !== 'string' ||
    typeof raw.kind !== 'string' ||
    !VALID_MEDIA_KINDS.has(raw.kind) ||
    typeof raw.title !== 'string'
  ) {
    return null;
  }

  const author = parseAuthorInfo(raw.author);
  if (!author) {
    return null;
  }

  const collectedAt =
    typeof raw.collectedAt === 'number' && Number.isFinite(raw.collectedAt)
      ? raw.collectedAt
      : Date.now();
  const updatedAt =
    typeof raw.updatedAt === 'number' && Number.isFinite(raw.updatedAt)
      ? raw.updatedAt
      : collectedAt;

  const dedupeKey =
    typeof raw.dedupeKey === 'string' && raw.dedupeKey.trim()
      ? raw.dedupeKey.trim()
      : `${raw.platform}:${raw.sourceId}`;

  const assets: MediaAsset[] = [];
  if (Array.isArray(raw.assets)) {
    for (const rawAsset of raw.assets) {
      const parsedAsset = parseMediaAsset(rawAsset);
      if (parsedAsset) {
        assets.push(parsedAsset);
      }
    }
  }

  let coverRelativePath: string | undefined;
  if (typeof raw.coverRelativePath === 'string' && raw.coverRelativePath.trim()) {
    try {
      if (splitRelativePath(raw.coverRelativePath).length > 0) {
        coverRelativePath = raw.coverRelativePath;
      }
    } catch {
      coverRelativePath = undefined;
    }
  }

  let commentsRelativePath: string | undefined;
  if (
    typeof raw.commentsRelativePath === 'string' &&
    raw.commentsRelativePath.trim()
  ) {
    try {
      if (splitRelativePath(raw.commentsRelativePath).length > 0) {
        commentsRelativePath = raw.commentsRelativePath;
      }
    } catch {
      commentsRelativePath = undefined;
    }
  }

  const savedCommentCount =
    typeof raw.savedCommentCount === 'number' &&
    Number.isFinite(raw.savedCommentCount) &&
    raw.savedCommentCount >= 0
      ? Math.trunc(raw.savedCommentCount)
      : undefined;

  const commentsSizeBytes =
    typeof raw.commentsSizeBytes === 'number' &&
    Number.isFinite(raw.commentsSizeBytes) &&
    raw.commentsSizeBytes >= 0
      ? Math.trunc(raw.commentsSizeBytes)
      : undefined;

  const platformExtra = parsePlatformExtra(raw.platformExtra);

  return {
    schemaVersion: SCHEMA_VERSION,
    id: raw.id.trim(),
    dedupeKey,
    platform: raw.platform,
    sourceId: raw.sourceId.trim(),
    sourceUrl: raw.sourceUrl,
    kind: raw.kind as MediaKind,
    title: raw.title,
    description: typeof raw.description === 'string' ? raw.description : '',
    author,
    ...(typeof raw.publishedAt === 'number' && Number.isFinite(raw.publishedAt)
      ? { publishedAt: raw.publishedAt }
      : {}),
    collectedAt,
    updatedAt,
    folderId: typeof raw.folderId === 'string' ? raw.folderId : null,
    tags: parseStringArray(raw.tags),
    note: typeof raw.note === 'string' ? raw.note : '',
    // 以实际扫描目录为准，确保目录迁移或重整后仍可精准定位同级媒体文件
    relativeDir: scannedRelativeDir,
    ...(coverRelativePath !== undefined ? { coverRelativePath } : {}),
    ...(commentsRelativePath !== undefined ? { commentsRelativePath } : {}),
    ...(savedCommentCount !== undefined ? { savedCommentCount } : {}),
    ...(commentsSizeBytes !== undefined ? { commentsSizeBytes } : {}),
    assets,
    syncStatus: 'vault_synced',
    totalSizeBytes:
      typeof raw.totalSizeBytes === 'number' &&
      Number.isFinite(raw.totalSizeBytes)
        ? raw.totalSizeBytes
        : 0,
    ...(typeof raw.deletedAt === 'number' && Number.isFinite(raw.deletedAt)
      ? { deletedAt: raw.deletedAt }
      : { deletedAt: null }),
    ...(platformExtra !== undefined ? { platformExtra } : {}),
  };
}

function parseTaxonomyFile(raw: unknown): {
  folders: FolderNode[];
  tags: TagMeta[];
} {
  const folders: FolderNode[] = [];
  const tags: TagMeta[] = [];

  if (!isRecord(raw)) {
    return { folders, tags };
  }

  if (Array.isArray(raw.folders)) {
    for (const entry of raw.folders) {
      if (
        isRecord(entry) &&
        typeof entry.id === 'string' &&
        entry.id.trim() &&
        (entry.parentId === null || typeof entry.parentId === 'string') &&
        typeof entry.name === 'string' &&
        entry.name.trim() &&
        typeof entry.sortOrder === 'number' &&
        Number.isFinite(entry.sortOrder) &&
        typeof entry.createdAt === 'number' &&
        Number.isFinite(entry.createdAt) &&
        typeof entry.updatedAt === 'number' &&
        Number.isFinite(entry.updatedAt)
      ) {
        folders.push({
          id: entry.id.trim(),
          parentId: entry.parentId,
          name: entry.name.trim(),
          sortOrder: entry.sortOrder,
          createdAt: entry.createdAt,
          updatedAt: entry.updatedAt,
        });
      }
    }
  }

  if (Array.isArray(raw.tags)) {
    for (const entry of raw.tags) {
      if (
        isRecord(entry) &&
        typeof entry.name === 'string' &&
        entry.name.trim() &&
        typeof entry.color === 'string' &&
        entry.color.trim() &&
        typeof entry.createdAt === 'number' &&
        Number.isFinite(entry.createdAt)
      ) {
        tags.push({
          name: entry.name.trim(),
          color: entry.color.trim(),
          createdAt: entry.createdAt,
        });
      }
    }
  }

  return { folders, tags };
}

interface ScannedMetaFile {
  dirHandle: FileSystemDirectoryHandle;
  fileHandle: FileSystemFileHandle;
  relativeDir: string;
}

async function scanMetaFilesRecursively(
  dir: FileSystemDirectoryHandle,
  currentRelativeDir: string,
  results: ScannedMetaFile[],
): Promise<void> {
  for await (const [name, handle] of dir.entries()) {
    if (handle.kind === 'file' && name === 'meta.json') {
      results.push({
        dirHandle: dir,
        fileHandle: handle,
        relativeDir: currentRelativeDir,
      });
    } else if (handle.kind === 'directory') {
      const nextRelativeDir = currentRelativeDir
        ? `${currentRelativeDir}/${name}`
        : name;
      await scanMetaFilesRecursively(handle, nextRelativeDir, results);
    }
  }
}

/**
 * 容灾重建 IndexedDB 索引：
 * 1. 守护 `README.txt` 并读取 `.collect-vault.json` 与 `taxonomy.json`；
 * 2. 递归扫描 `items/` 下全部 `meta.json`，校验核心字段合法性并生成缩略图；
 * 3. 在 Dexie 事务中重建 `items`、`folders`、`tags`，清理已结束的 `tasks` 残留，
 *    绝不破坏 `settings` 中的 `vault_directory_handle`；
 * 4. 所有恢复条目标记为 `vault_synced`，并自动补齐被条目引用但 `taxonomy.json` 遗漏的标签。
 */
export async function rebuildIndexFromVault(
  root: FileSystemDirectoryHandle,
  onProgress?: (p: RebuildProgress) => void,
  options?: RebuildOptions,
): Promise<RebuildSummary> {
  return withVaultIoLock(async () => {
    await ensureVaultReadme(root);

  // 读取并同步 .collect-vault.json（如果合法）
  const configFile = await readVaultFile(root, VAULT_CONFIG_FILENAME);
  if (configFile) {
    try {
      const parsedConfig = parseVaultConfig(
        JSON.parse(await configFile.text()) as unknown,
      );
      if (parsedConfig) {
        await setSetting('vault_config', parsedConfig);
      }
    } catch {
      // 忽略损坏配置，不阻塞索引恢复
    }
  }

  // 读取并解析 taxonomy.json
  let taxonomyFolders: FolderNode[] = [];
  let taxonomyTags: TagMeta[] = [];
  const taxonomyFile = await readVaultFile(root, TAXONOMY_FILENAME);
  if (taxonomyFile) {
    try {
      const parsedTaxonomy = parseTaxonomyFile(
        JSON.parse(await taxonomyFile.text()) as unknown,
      );
      taxonomyFolders = parsedTaxonomy.folders;
      taxonomyTags = parsedTaxonomy.tags;
    } catch {
      // taxonomy.json 缺失或损坏时仍继续恢复 items 并从条目标签自动补齐
    }
  }

  const folderMap = new Map<string, FolderNode>();
  for (const folder of taxonomyFolders) {
    folderMap.set(folder.id, folder);
  }
  // 清理悬空的 parentId 引用
  const normalizedFolders: FolderNode[] = [];
  for (const folder of folderMap.values()) {
    normalizedFolders.push({
      ...folder,
      parentId:
        folder.parentId !== null && folderMap.has(folder.parentId)
          ? folder.parentId
          : null,
    });
  }

  const tagMap = new Map<string, TagMeta>();
  for (const tag of taxonomyTags) {
    tagMap.set(tag.name, tag);
  }

  // 递归收集 items/ 下全部 meta.json
  const metaFiles: ScannedMetaFile[] = [];
  try {
    const itemsDir = await root.getDirectoryHandle(ITEMS_DIRNAME, {
      create: false,
    });
    await scanMetaFilesRecursively(itemsDir, ITEMS_DIRNAME, metaFiles);
  } catch (error) {
    if (!isNotFoundError(error)) {
      throw error;
    }
  }

  let skippedFiles = 0;
  const recordsById = new Map<string, CollectionItemRecord>();
  const idByDedupeKey = new Map<string, string>();

  for (const entry of metaFiles) {
    try {
      const file = await entry.fileHandle.getFile();
      const raw: unknown = JSON.parse(await file.text());
      const parsedMeta = parseCollectionItemMeta(raw, entry.relativeDir);
      if (!parsedMeta) {
        skippedFiles += 1;
        continue;
      }

      // 若 folderId 不存在于恢复出的文件夹中，回退为未归类
      if (
        parsedMeta.folderId !== null &&
        !folderMap.has(parsedMeta.folderId)
      ) {
        parsedMeta.folderId = null;
      }

      // 去重冲突处理：同一 id 或 dedupeKey 保留 updatedAt 较新的记录
      const existingById = recordsById.get(parsedMeta.id);
      if (existingById) {
        skippedFiles += 1;
        if (existingById.updatedAt >= parsedMeta.updatedAt) {
          continue;
        }
      }

      const existingIdForDedupe = idByDedupeKey.get(parsedMeta.dedupeKey);
      if (existingIdForDedupe && existingIdForDedupe !== parsedMeta.id) {
        const prev = recordsById.get(existingIdForDedupe);
        skippedFiles += 1;
        if (prev && prev.updatedAt >= parsedMeta.updatedAt) {
          continue;
        }
        recordsById.delete(existingIdForDedupe);
      }

      // 尝试从条目目录读取封面并生成轻量缩略图
      let thumbnailDataUrl: string | undefined;
      if (parsedMeta.coverRelativePath) {
        const coverFile = await readVaultFile(
          entry.dirHandle,
          parsedMeta.coverRelativePath,
        );
        if (coverFile) {
          thumbnailDataUrl = await generateThumbnailFromBlob(coverFile, 360);
        }
      }

      const record: CollectionItemRecord = {
        ...parsedMeta,
        syncStatus: 'vault_synced',
        ...(thumbnailDataUrl !== undefined ? { thumbnailDataUrl } : {}),
      };

      recordsById.set(record.id, record);
      idByDedupeKey.set(record.dedupeKey, record.id);

      onProgress?.({
        phase: 'scanning',
        scannedItems: recordsById.size,
        currentTitle: record.title,
      });
    } catch {
      skippedFiles += 1;
    }
  }

  const restoredRecords = [...recordsById.values()];

  // 自动重建索引时保留浏览器尚未落盘的 opfs_staged 条目，避免未同步视频丢失
  const preservedStagedRecords: CollectionItemRecord[] = [];
  if (options?.preserveOpfsStaged) {
    const currentStaged = await db.items
      .where('syncStatus')
      .equals('opfs_staged')
      .toArray();
    for (const staged of currentStaged) {
      if (recordsById.has(staged.id) || idByDedupeKey.has(staged.dedupeKey)) {
        continue;
      }
      preservedStagedRecords.push({
        ...staged,
        folderId:
          staged.folderId !== null && folderMap.has(staged.folderId)
            ? staged.folderId
            : null,
      });
    }
  }

  const allRecordsToPersist = [...restoredRecords, ...preservedStagedRecords];

  // 补齐条目引用到但 taxonomy.json 遗漏的标签
  const now = Date.now();
  for (const record of allRecordsToPersist) {
    for (const tagName of record.tags) {
      if (!tagMap.has(tagName)) {
        tagMap.set(tagName, {
          name: tagName,
          color: pickTagColor(tagName),
          createdAt: now,
        });
      }
    }
  }
  const normalizedTags = [...tagMap.values()];

  onProgress?.({
    phase: 'importing',
    scannedItems: restoredRecords.length,
  });

  await db.transaction('rw', db.items, db.folders, db.tags, db.tasks, async () => {
    await Promise.all([db.items.clear(), db.folders.clear(), db.tags.clear()]);

    // 仅清理已结束的历史任务残留，不干扰 settings（特别是 vault_directory_handle）
    const finishedTasks = await db.tasks
      .where('status')
      .anyOf(['completed', 'failed', 'cancelled'])
      .primaryKeys();
    if (finishedTasks.length > 0) {
      await db.tasks.bulkDelete(finishedTasks);
    }

    if (normalizedFolders.length > 0) {
      await db.folders.bulkPut(normalizedFolders);
    }
    if (normalizedTags.length > 0) {
      await db.tags.bulkPut(normalizedTags);
    }
    if (allRecordsToPersist.length > 0) {
      await db.items.bulkPut(allRecordsToPersist);
    }
  });

  await setSetting('last_sync_at', Date.now());

  onProgress?.({
    phase: 'done',
    scannedItems: restoredRecords.length,
  });

    return {
      restoredItems: restoredRecords.length,
      restoredFolders: normalizedFolders.length,
      restoredTags: normalizedTags.length,
      skippedFiles,
    };
  });
}

// ============================================================================
// 5. Vault 目录迁移与合并（空目标迁移 / 覆盖 / 合并）
// ============================================================================

interface PendingCopyEntry {
  relativePath: string;
  fileHandle: FileSystemFileHandle;
}

async function collectFilesRecursively(
  dir: FileSystemDirectoryHandle,
  prefix: string,
  results: PendingCopyEntry[],
): Promise<void> {
  for await (const [name, entry] of dir.entries()) {
    const nextPath = prefix ? `${prefix}/${name}` : name;
    if (entry.kind === 'file') {
      results.push({ relativePath: nextPath, fileHandle: entry });
    } else if (entry.kind === 'directory') {
      await collectFilesRecursively(entry, nextPath, results);
    }
  }
}

async function collectManagedVaultFiles(
  root: FileSystemDirectoryHandle,
): Promise<PendingCopyEntry[]> {
  const files: PendingCopyEntry[] = [];
  for await (const [name, entry] of root.entries()) {
    if (!VAULT_MANAGED_ENTRY_SET.has(name)) {
      continue;
    }
    if (entry.kind === 'file') {
      files.push({ relativePath: name, fileHandle: entry });
    } else if (entry.kind === 'directory') {
      await collectFilesRecursively(entry, name, files);
    }
  }
  return files;
}

async function removeVaultManagedEntries(
  root: FileSystemDirectoryHandle,
  options?: { ignoreErrors?: boolean },
): Promise<{ failedCount: number; firstError?: string }> {
  const entriesToRemove: Array<{ name: string; kind: 'file' | 'directory' }> =
    [];
  for await (const [name, entry] of root.entries()) {
    if (VAULT_MANAGED_ENTRY_SET.has(name)) {
      entriesToRemove.push({ name, kind: entry.kind });
    }
  }

  let failedCount = 0;
  let firstError: string | undefined;

  for (const entry of entriesToRemove) {
    try {
      await root.removeEntry(entry.name, {
        recursive: entry.kind === 'directory',
      });
    } catch (error) {
      if (isNotFoundError(error)) {
        continue;
      }
      if (!options?.ignoreErrors) {
        throw error;
      }
      failedCount += 1;
      if (firstError === undefined) {
        firstError = getErrorMessage(error);
      }
    }
  }

  return {
    failedCount,
    ...(firstError !== undefined ? { firstError } : {}),
  };
}

async function removeRelativeDirectory(
  root: FileSystemDirectoryHandle,
  relativeDir: string,
): Promise<void> {
  const segments = splitRelativePath(relativeDir);
  if (segments.length === 0) {
    return;
  }
  const leafName = segments[segments.length - 1];
  if (!leafName) {
    return;
  }

  let parentDir = root;
  try {
    for (let i = 0; i < segments.length - 1; i += 1) {
      const seg = segments[i];
      if (!seg) {
        continue;
      }
      parentDir = await parentDir.getDirectoryHandle(seg, { create: false });
    }
    await parentDir.removeEntry(leafName, { recursive: true });
  } catch (error) {
    if (!isNotFoundError(error)) {
      throw error;
    }
  }
}

async function readParsedTaxonomyFromVault(
  root: FileSystemDirectoryHandle,
): Promise<{ folders: FolderNode[]; tags: TagMeta[] }> {
  const taxonomyFile = await readVaultFile(root, TAXONOMY_FILENAME);
  if (!taxonomyFile) {
    return { folders: [], tags: [] };
  }
  try {
    const raw: unknown = JSON.parse(await taxonomyFile.text());
    return parseTaxonomyFile(raw);
  } catch {
    return { folders: [], tags: [] };
  }
}

function mergeTaxonomies(
  source: { folders: FolderNode[]; tags: TagMeta[] },
  target: { folders: FolderNode[]; tags: TagMeta[] },
): TaxonomyFile {
  const folderMap = new Map<string, FolderNode>();
  for (const folder of target.folders) {
    folderMap.set(folder.id, folder);
  }
  for (const folder of source.folders) {
    const existing = folderMap.get(folder.id);
    if (!existing || folder.updatedAt > existing.updatedAt) {
      folderMap.set(folder.id, folder);
    }
  }
  const folders = [...folderMap.values()].sort(
    (a, b) => a.sortOrder - b.sortOrder || a.createdAt - b.createdAt,
  );

  const tagMap = new Map<string, TagMeta>();
  for (const tag of target.tags) {
    tagMap.set(tag.name, tag);
  }
  for (const tag of source.tags) {
    const existing = tagMap.get(tag.name);
    if (!existing) {
      tagMap.set(tag.name, tag);
    } else if (tag.createdAt < existing.createdAt) {
      tagMap.set(tag.name, { ...existing, createdAt: tag.createdAt });
    }
  }
  const tags = [...tagMap.values()].sort(
    (a, b) => a.createdAt - b.createdAt || a.name.localeCompare(b.name),
  );

  return {
    schemaVersion: SCHEMA_VERSION,
    updatedAt: Date.now(),
    folders,
    tags,
  };
}

interface IndexedVaultItemInfo {
  id: string;
  dedupeKey: string;
  updatedAt: number;
  relativeDir: string;
}

async function scanItemsIndex(
  root: FileSystemDirectoryHandle,
): Promise<{
  entries: ScannedMetaFile[];
  parsedByDir: Map<string, CollectionItemMeta>;
}> {
  const entries: ScannedMetaFile[] = [];
  const parsedByDir = new Map<string, CollectionItemMeta>();
  try {
    const itemsDir = await root.getDirectoryHandle(ITEMS_DIRNAME, {
      create: false,
    });
    await scanMetaFilesRecursively(itemsDir, ITEMS_DIRNAME, entries);
  } catch (error) {
    if (!isNotFoundError(error)) {
      throw error;
    }
  }

  for (const entry of entries) {
    try {
      const file = await entry.fileHandle.getFile();
      const raw: unknown = JSON.parse(await file.text());
      const meta = parseCollectionItemMeta(raw, entry.relativeDir);
      if (meta) {
        parsedByDir.set(entry.relativeDir, meta);
      }
    } catch {
      // 忽略损坏 meta.json
    }
  }

  return { entries, parsedByDir };
}

/**
 * 将 CollectVault 从 `sourceRoot` 迁移至 `targetRoot`：
 * - `empty_target`: 目标目录为空，流式全量拷贝 CollectVault 文件。
 * - `overwrite`: 目标目录已有 CollectVault，先清理目标目录旧 Vault 数据再全量迁移。
 * - `merge`: 目标目录已有 CollectVault，合并 taxonomy.json、items/（冲突按 updatedAt 较新保留）与 .trash/。
 *
 * 崩溃安全顺序：全部文件写入目标目录并持久化新句柄绑定后，再删除原目录中的 CollectVault 文件。
 */
export async function migrateVaultDirectory(
  sourceRoot: FileSystemDirectoryHandle,
  targetRoot: FileSystemDirectoryHandle,
  mode: VaultMigrationMode,
  onProgress?: (p: MigrationProgress) => void,
): Promise<MigrationSummary> {
  if (await isSameDirectoryHandle(sourceRoot, targetRoot)) {
    throw new VaultDirectoryValidationError('same_directory', targetRoot.name);
  }
  if (await isNestedDirectoryHandle(sourceRoot, targetRoot)) {
    throw new VaultDirectoryValidationError(
      'nested_directory',
      targetRoot.name,
    );
  }

  const [sourceGranted, targetGranted] = await Promise.all([
    requestVaultPermission(sourceRoot, 'readwrite'),
    requestVaultPermission(targetRoot, 'readwrite'),
  ]);
  if (!sourceGranted) {
    throw new Error(
      `缺少原目录“${sourceRoot.name}”的读写权限，无法迁移旧文件。`,
    );
  }
  if (!targetGranted) {
    throw new Error(
      `缺少目标目录“${targetRoot.name}”的读写权限，无法写入迁移文件。`,
    );
  }

  onProgress?.({ phase: 'preparing', current: 0, total: 0 });

  return withVaultIoLock(async () => {
    // 若本地索引存在已落盘条目的未写回编辑（meta_dirty），迁移前先刷新轻量 JSON 至原目录
    const dirtyItems = await db.items
      .where('syncStatus')
      .equals('meta_dirty')
      .toArray();
    if (dirtyItems.length > 0) {
      for (const item of dirtyItems) {
        await writeItemMetaToVaultUnlocked(sourceRoot, {
          ...item,
          syncStatus: 'vault_synced',
        }).catch(() => undefined);
      }
      await writeTaxonomyToVaultUnlocked(sourceRoot).catch(() => undefined);
    }

  let copiedFiles = 0;
  let skippedFiles = 0;

  try {
    if (mode === 'overwrite') {
      onProgress?.({ phase: 'clearing_target', current: 0, total: 1 });
      await removeVaultManagedEntries(targetRoot, { ignoreErrors: false });
    }

    if (mode === 'empty_target' || mode === 'overwrite') {
      const filesToCopy = await collectManagedVaultFiles(sourceRoot);
      const total = filesToCopy.length;

      for (let i = 0; i < filesToCopy.length; i += 1) {
        const item = filesToCopy[i];
        if (!item) {
          continue;
        }
        onProgress?.({
          phase: 'copying',
          current: i + 1,
          total,
          currentPath: item.relativePath,
        });
        const sourceFile = await item.fileHandle.getFile();
        await copyFileToVault(targetRoot, item.relativePath, sourceFile);
        copiedFiles += 1;
      }
    } else {
      // mode === 'merge'
      const [sourceTaxonomy, targetTaxonomy, sourceScan, targetScan] =
        await Promise.all([
          readParsedTaxonomyFromVault(sourceRoot),
          readParsedTaxonomyFromVault(targetRoot),
          scanItemsIndex(sourceRoot),
          scanItemsIndex(targetRoot),
        ]);

      const targetById = new Map<string, IndexedVaultItemInfo>();
      const targetByDedupeKey = new Map<string, IndexedVaultItemInfo>();
      const targetByRelativeDir = new Map<string, IndexedVaultItemInfo>();

      for (const meta of targetScan.parsedByDir.values()) {
        const info: IndexedVaultItemInfo = {
          id: meta.id,
          dedupeKey: meta.dedupeKey,
          updatedAt: meta.updatedAt,
          relativeDir: meta.relativeDir,
        };
        targetById.set(meta.id, info);
        targetByDedupeKey.set(meta.dedupeKey, info);
        targetByRelativeDir.set(meta.relativeDir, info);
      }

      const dirsToReplaceInTarget = new Set<string>();
      const filesToCopy: PendingCopyEntry[] = [];

      for (const entry of sourceScan.entries) {
        const dirFiles: PendingCopyEntry[] = [];
        await collectFilesRecursively(
          entry.dirHandle,
          entry.relativeDir,
          dirFiles,
        );

        const sourceMeta = sourceScan.parsedByDir.get(entry.relativeDir);
        if (!sourceMeta) {
          skippedFiles += dirFiles.length;
          continue;
        }

        const conflictingTargets = new Map<string, IndexedVaultItemInfo>();
        for (const candidate of [
          targetById.get(sourceMeta.id),
          targetByDedupeKey.get(sourceMeta.dedupeKey),
          targetByRelativeDir.get(sourceMeta.relativeDir),
        ]) {
          if (candidate) {
            conflictingTargets.set(candidate.relativeDir, candidate);
          }
        }

        let targetIsNewerOrEqual = false;
        for (const existing of conflictingTargets.values()) {
          if (existing.updatedAt >= sourceMeta.updatedAt) {
            targetIsNewerOrEqual = true;
            break;
          }
        }

        if (targetIsNewerOrEqual) {
          skippedFiles += dirFiles.length;
          continue;
        }

        for (const obsolete of conflictingTargets.values()) {
          dirsToReplaceInTarget.add(obsolete.relativeDir);
          targetById.delete(obsolete.id);
          targetByDedupeKey.delete(obsolete.dedupeKey);
          targetByRelativeDir.delete(obsolete.relativeDir);
        }

        const nextInfo: IndexedVaultItemInfo = {
          id: sourceMeta.id,
          dedupeKey: sourceMeta.dedupeKey,
          updatedAt: sourceMeta.updatedAt,
          relativeDir: sourceMeta.relativeDir,
        };
        targetById.set(nextInfo.id, nextInfo);
        targetByDedupeKey.set(nextInfo.dedupeKey, nextInfo);
        targetByRelativeDir.set(nextInfo.relativeDir, nextInfo);

        filesToCopy.push(...dirFiles);
      }

      // 合并 .trash/ 中目标目录尚未存在的文件
      try {
        const sourceTrash = await sourceRoot.getDirectoryHandle(TRASH_DIRNAME, {
          create: false,
        });
        const trashFiles: PendingCopyEntry[] = [];
        await collectFilesRecursively(sourceTrash, TRASH_DIRNAME, trashFiles);
        for (const trashFile of trashFiles) {
          if (await hasVaultFile(targetRoot, trashFile.relativePath)) {
            skippedFiles += 1;
          } else {
            filesToCopy.push(trashFile);
          }
        }
      } catch (error) {
        if (!isNotFoundError(error)) {
          throw error;
        }
      }

      for (const obsoleteDir of dirsToReplaceInTarget) {
        await removeRelativeDirectory(targetRoot, obsoleteDir);
      }

      const total = filesToCopy.length;
      for (let i = 0; i < filesToCopy.length; i += 1) {
        const item = filesToCopy[i];
        if (!item) {
          continue;
        }
        onProgress?.({
          phase: 'copying',
          current: i + 1,
          total,
          currentPath: item.relativePath,
        });
        const sourceFile = await item.fileHandle.getFile();
        await copyFileToVault(targetRoot, item.relativePath, sourceFile);
        copiedFiles += 1;
      }

      const mergedTaxonomy = mergeTaxonomies(sourceTaxonomy, targetTaxonomy);
      await writeVaultTextFile(
        targetRoot,
        TAXONOMY_FILENAME,
        JSON.stringify(mergedTaxonomy, null, 2),
      );
    }

    onProgress?.({ phase: 'finalizing', current: 1, total: 1 });
    const ensured = await ensureVaultStructure(targetRoot);
    const updatedConfig: VaultConfig = {
      ...ensured.config,
      name: targetRoot.name || ensured.config.name,
      updatedAt: Date.now(),
    };
    await writeVaultTextFile(
      targetRoot,
      VAULT_CONFIG_FILENAME,
      JSON.stringify(updatedConfig, null, 2),
    );

    // 先切换句柄绑定再清理原目录，防止中途异常导致丢失有效绑定
    await setSetting('vault_directory_handle', targetRoot);
    await setSetting('vault_config', updatedConfig);
    await setSetting('last_sync_at', Date.now());
  } catch (error) {
    if (isFilesystemWriteDeniedError(error)) {
      throw new VaultFilesystemPermissionError(
        targetRoot.name || 'CollectVault',
        error,
      );
    }
    throw error;
  }

  // 将迁移前已同步落盘的 meta_dirty 条目标记为 vault_synced
  if (dirtyItems.length > 0) {
    await db.transaction('rw', db.items, async () => {
      for (const dirty of dirtyItems) {
        const latest = await db.items.get(dirty.id);
        if (latest && latest.syncStatus === 'meta_dirty' && latest.updatedAt <= dirty.updatedAt) {
          await db.items.put({ ...latest, syncStatus: 'vault_synced' });
        }
      }
    });
  }

  onProgress?.({ phase: 'cleaning_source', current: 0, total: 1 });
  const cleanup = await removeVaultManagedEntries(sourceRoot, {
    ignoreErrors: true,
  });

  onProgress?.({
    phase: 'done',
    current: copiedFiles,
    total: copiedFiles,
  });

    return {
      mode,
      sourceName: sourceRoot.name || '原目录',
      targetName: targetRoot.name || '新目录',
      copiedFiles,
      skippedFiles,
      sourceCleanupFailedCount: cleanup.failedCount,
      ...(cleanup.firstError !== undefined
        ? { sourceCleanupError: cleanup.firstError }
        : {}),
    };
  });
}
