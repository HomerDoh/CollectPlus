/**
 * CollectPlus IndexedDB 高速索引层（基于 Dexie.js）。
 *
 * 承担条目元数据缓存、文件夹树、标签表、下载队列任务以及配置句柄持久化。
 */

import Dexie, { type Table } from 'dexie';
import { ulid } from 'ulid';
import {
  getItemFolderIds,
  isAutoSyncExcluded,
  normalizeFolderAutoRule,
  normalizeFolderIds,
  type AutoSyncExclusion,
  type AutoSyncExclusionReason,
  type CollectionItemRecord,
  type DownloadTask,
  type FolderAutoRule,
  type FolderNode,
  type MediaAsset,
  type PlatformAccountSyncEntry,
  type PlatformId,
  type SettingKey,
  type SettingRecord,
  type SettingValueMap,
  type TagMeta,
  type UserPreferences,
} from '../types/schema.ts';

/** CollectPlus IndexedDB 数据库定义 */
export class CollectPlusDB extends Dexie {
  items!: Table<CollectionItemRecord, string>;
  folders!: Table<FolderNode, string>;
  tags!: Table<TagMeta, string>;
  tasks!: Table<DownloadTask, string>;
  settings!: Table<SettingRecord, SettingKey>;

  constructor() {
    super('CollectPlusDB');

    this.version(1).stores({
      items:
        'id, &dedupeKey, platform, folderId, syncStatus, collectedAt, updatedAt, deletedAt, [platform+collectedAt], [folderId+collectedAt], *tags',
      folders: 'id, parentId, sortOrder, name',
      tags: '&name, createdAt',
      tasks: 'id, itemId, dedupeKey, status, createdAt, updatedAt',
      settings: 'key',
    });

    this.version(2)
      .stores({
        items:
          'id, &dedupeKey, platform, folderId, *folderIds, syncStatus, collectedAt, updatedAt, deletedAt, [platform+collectedAt], [folderId+collectedAt], *tags',
        folders: 'id, parentId, sortOrder, name',
        tags: '&name, createdAt',
        tasks: 'id, itemId, dedupeKey, status, createdAt, updatedAt',
        settings: 'key',
      })
      .upgrade((tx) =>
        tx
          .table('items')
          .toCollection()
          .modify((item: CollectionItemRecord) => {
            const normalized = getItemFolderIds(item);
            item.folderIds = normalized;
            item.folderId = normalized[0] ?? null;
          }),
      );
  }
}

/** 全局数据库单例 */
export const db = new CollectPlusDB();

/** 取消自动保存的默认视频体积阈值（MB） */
export const DEFAULT_OVERSIZED_VIDEO_THRESHOLD_MB = 200;
/** 取消自动保存视频体积阈值的最小合法值（MB） */
export const MIN_OVERSIZED_VIDEO_THRESHOLD_MB = 1;
/** 取消自动保存视频体积阈值的最大合法值（MB） */
export const MAX_OVERSIZED_VIDEO_THRESHOLD_MB = 10240;

/** 钳位并规范化视频体积阈值（MB），异常值回退默认 200MB */
export function clampOversizedVideoThresholdMb(value: unknown): number {
  const num =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim() !== ''
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(num)) {
    return DEFAULT_OVERSIZED_VIDEO_THRESHOLD_MB;
  }
  return Math.max(
    MIN_OVERSIZED_VIDEO_THRESHOLD_MB,
    Math.min(MAX_OVERSIZED_VIDEO_THRESHOLD_MB, Math.round(num)),
  );
}

/** 默认用户偏好设置 */
export const DEFAULT_USER_PREFERENCES: UserPreferences = {
  autoSyncOnLibraryOpen: true,
  floatingButtonEnabled: true,
  nativeCollectToastEnabled: true,
  nsfwFilterEnabled: false,
  autoSyncAllCollections: false,
  syncUncollectToPlugin: false,
  skipOversizedVideoAutoSave: false,
  oversizedVideoThresholdMb: DEFAULT_OVERSIZED_VIDEO_THRESHOLD_MB,
  oversizedVideoNotifyMode: 'popup',
  autoClassifyEnabled: true,
  defaultFolderId: null,
  maxConcurrentDownloads: 2,
  defaultViewMode: 'grid',
  defaultSortBy: 'collectedAt',
};

/** 协调的 Tailwind 友好标签调色板 */
export const TAG_COLOR_PALETTE = [
  '#3b82f6', // blue-500
  '#10b981', // emerald-500
  '#f59e0b', // amber-500
  '#ef4444', // red-500
  '#8b5cf6', // violet-500
  '#ec4899', // pink-500
  '#06b6d4', // cyan-500
  '#84cc16', // lime-500
  '#f97316', // orange-500
  '#6366f1', // indigo-500
  '#14b8a6', // teal-500
  '#d946ef', // fuchsia-500
] as const;

/** 基于标签名确定性地从调色板选取视觉色值 */
export function pickTagColor(tagName: string): string {
  let hash = 0;
  for (const ch of tagName) {
    hash = (hash * 31 + (ch.codePointAt(0) ?? 0)) >>> 0;
  }
  const index = hash % TAG_COLOR_PALETTE.length;
  return TAG_COLOR_PALETTE[index] ?? '#3b82f6';
}

/** 清洗并去重标签名列表（去除首尾空白及前导 `#`） */
export function normalizeTagNames(tagNames: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const raw of tagNames) {
    const cleaned = raw.trim().replace(/^#+/, '').trim();
    if (!cleaned || seen.has(cleaned)) {
      continue;
    }
    seen.add(cleaned);
    result.push(cleaned);
  }

  return result;
}

/** 根据强类型 key 安全提取设置值，避免不安全的类型断言 */
function extractSettingValue<K extends SettingKey>(
  key: K,
  record: SettingRecord | undefined,
): SettingValueMap[K] | undefined {
  if (!record || record.key !== key) {
    return undefined;
  }
  return record.value as SettingValueMap[K];
}

/** 构造强类型 SettingRecord */
function buildSettingRecord<K extends SettingKey>(
  key: K,
  value: SettingValueMap[K],
  updatedAt: number,
): SettingRecord {
  return { key, value, updatedAt } as SettingRecord;
}

/** 读取指定键的强类型配置值 */
export async function getSetting<K extends SettingKey>(
  key: K,
): Promise<SettingValueMap[K] | undefined> {
  const record = await db.settings.get(key);
  return extractSettingValue(key, record);
}

/** 写入指定键的强类型配置值 */
export async function setSetting<K extends SettingKey>(
  key: K,
  value: SettingValueMap[K],
): Promise<void> {
  const record = buildSettingRecord(key, value, Date.now());
  await db.settings.put(record);
}

/** 删除指定键的配置项 */
export async function deleteSetting(key: SettingKey): Promise<void> {
  await db.settings.delete(key);
}

/** 读取用户偏好设置并与默认值合并，保障向后兼容 */
export async function getUserPreferences(): Promise<UserPreferences> {
  const saved = await getSetting('user_preferences');
  if (!saved) {
    return { ...DEFAULT_USER_PREFERENCES };
  }
  const merged: UserPreferences = {
    ...DEFAULT_USER_PREFERENCES,
    ...saved,
  };
  const resolvedAutoClassify =
    typeof saved.autoClassifyEnabled === 'boolean'
      ? saved.autoClassifyEnabled
      : saved.defaultFolderId
        ? false
        : DEFAULT_USER_PREFERENCES.autoClassifyEnabled;
  return {
    ...merged,
    autoClassifyEnabled: resolvedAutoClassify,
    oversizedVideoThresholdMb: clampOversizedVideoThresholdMb(
      merged.oversizedVideoThresholdMb,
    ),
    oversizedVideoNotifyMode:
      merged.oversizedVideoNotifyMode === 'silent' ? 'silent' : 'popup',
  };
}

/** 局部更新用户偏好设置并返回合并后的最新配置 */
export async function updateUserPreferences(
  patch: Partial<UserPreferences>,
): Promise<UserPreferences> {
  return db.transaction('rw', db.settings, async () => {
    const current = await getUserPreferences();
    const next: UserPreferences = {
      ...current,
      ...patch,
    };
    await setSetting('user_preferences', next);
    return next;
  });
}

/** 构造按平台 + 非敏感账号 ID 区分的稳定存储键 */
export function buildPlatformAccountKey(
  platform: PlatformId,
  accountId: string,
): string {
  return `${platform}:${accountId.trim()}`;
}

/** 读取指定平台账号的全量收藏同步状态 */
export async function getPlatformAccountSyncState(
  platform: PlatformId,
  accountId: string,
): Promise<PlatformAccountSyncEntry | null> {
  const key = buildPlatformAccountKey(platform, accountId);
  const allStates = await getSetting('platform_account_sync_states');
  return allStates?.[key] ?? null;
}

/** 持久化指定平台账号的全量收藏同步状态 */
export async function setPlatformAccountSyncState(
  entry: PlatformAccountSyncEntry,
): Promise<void> {
  const key = buildPlatformAccountKey(entry.platform, entry.accountId);
  await db.transaction('rw', db.settings, async () => {
    const existing = (await getSetting('platform_account_sync_states')) ?? {};
    await setSetting('platform_account_sync_states', {
      ...existing,
      [key]: entry,
    });
  });
}

/** 清洗并幂等写入标签元数据，已存在的标签保留原颜色与创建时间 */
export async function upsertTags(tagNames: string[]): Promise<TagMeta[]> {
  const normalized = normalizeTagNames(tagNames);
  if (normalized.length === 0) {
    return [];
  }

  return db.transaction('rw', db.tags, async () => {
    const existingList = await db.tags.bulkGet(normalized);
    const now = Date.now();
    const toInsert: TagMeta[] = [];
    const resolved: TagMeta[] = [];

    for (let i = 0; i < normalized.length; i += 1) {
      const name = normalized[i];
      if (!name) {
        continue;
      }
      const existing = existingList[i];
      if (existing) {
        resolved.push(existing);
      } else {
        const created: TagMeta = {
          name,
          color: pickTagColor(name),
          createdAt: now,
        };
        toInsert.push(created);
        resolved.push(created);
      }
    }

    if (toInsert.length > 0) {
      await db.tags.bulkPut(toInsert);
    }

    return resolved;
  });
}

/** 创建新文件夹节点（使用 ULID 生成唯一 ID） */
export async function createFolder(
  name: string,
  parentId: string | null = null,
): Promise<FolderNode> {
  const trimmedName = name.trim();
  if (!trimmedName) {
    throw new Error('Folder name cannot be empty.');
  }

  return db.transaction('rw', db.folders, async () => {
    const allFolders = await db.folders.toArray();
    if (parentId !== null && !allFolders.some((f) => f.id === parentId)) {
      throw new Error(`Parent folder "${parentId}" does not exist.`);
    }

    let maxSortOrder = -1;
    for (const folder of allFolders) {
      if (folder.parentId === parentId && folder.sortOrder > maxSortOrder) {
        maxSortOrder = folder.sortOrder;
      }
    }

    const now = Date.now();
    const node: FolderNode = {
      id: ulid(),
      parentId,
      name: trimmedName,
      sortOrder: maxSortOrder + 1,
      createdAt: now,
      updatedAt: now,
    };

    await db.folders.add(node);
    return node;
  });
}

/** 重命名文件夹，节点不存在时返回 `null` */
export async function renameFolder(
  id: string,
  name: string,
): Promise<FolderNode | null> {
  const trimmedName = name.trim();
  if (!trimmedName) {
    throw new Error('Folder name cannot be empty.');
  }

  return db.transaction('rw', db.folders, async () => {
    const existing = await db.folders.get(id);
    if (!existing) {
      return null;
    }

    const updated: FolderNode = {
      ...existing,
      name: trimmedName,
      updatedAt: Date.now(),
    };
    await db.folders.put(updated);
    return updated;
  });
}

/** 更新文件夹自动分类显式微规则（全空规则时清除 `autoRule` 字段） */
export async function updateFolderAutoRule(
  id: string,
  autoRule: FolderAutoRule | null | undefined,
): Promise<FolderNode | null> {
  return db.transaction('rw', db.folders, async () => {
    const existing = await db.folders.get(id);
    if (!existing) {
      return null;
    }
    const normalizedRule = normalizeFolderAutoRule(autoRule);
    const { autoRule: _prevAutoRule, ...baseFolder } = existing;
    void _prevAutoRule;
    const updated: FolderNode = {
      ...baseFolder,
      ...(normalizedRule ? { autoRule: normalizedRule } : {}),
      updatedAt: Date.now(),
    };
    await db.folders.put(updated);
    return updated;
  });
}

/**
 * 递归删除指定文件夹及其所有子文件夹：
 * - 将所有受影响条目的 `folderId` 置为 `null`
 * - 若条目原同步状态为 `vault_synced`，则标记为 `meta_dirty` 以便下次同步回写 `meta.json`
 */
export async function deleteFolder(id: string): Promise<void> {
  await db.transaction('rw', db.folders, db.items, async () => {
    const allFolders = await db.folders.toArray();
    if (!allFolders.some((f) => f.id === id)) {
      return;
    }

    const childrenByParent = new Map<string, string[]>();
    for (const folder of allFolders) {
      if (folder.parentId !== null) {
        const list = childrenByParent.get(folder.parentId);
        if (list) {
          list.push(folder.id);
        } else {
          childrenByParent.set(folder.parentId, [folder.id]);
        }
      }
    }

    const idsToDelete: string[] = [];
    const queue: string[] = [id];
    const visited = new Set<string>();

    while (queue.length > 0) {
      const current = queue.shift();
      if (!current || visited.has(current)) {
        continue;
      }
      visited.add(current);
      idsToDelete.push(current);

      const children = childrenByParent.get(current);
      if (children) {
        for (const childId of children) {
          if (!visited.has(childId)) {
            queue.push(childId);
          }
        }
      }
    }

    await db.folders.bulkDelete(idsToDelete);

    const deletedSet = new Set(idsToDelete);
    const [byFolderIds, byLegacyFolderId] = await Promise.all([
      db.items.where('folderIds').anyOf(idsToDelete).toArray(),
      db.items.where('folderId').anyOf(idsToDelete).toArray(),
    ]);

    const affectedById = new Map<string, CollectionItemRecord>();
    for (const item of [...byFolderIds, ...byLegacyFolderId]) {
      affectedById.set(item.id, item);
    }

    if (affectedById.size > 0) {
      const now = Date.now();
      const updatedItems: CollectionItemRecord[] = [];
      for (const item of affectedById.values()) {
        const nextFolderIds = getItemFolderIds(item).filter(
          (fid) => !deletedSet.has(fid),
        );
        updatedItems.push({
          ...item,
          folderIds: nextFolderIds,
          folderId: nextFolderIds[0] ?? null,
          updatedAt: now,
          syncStatus:
            item.syncStatus === 'vault_synced' ? 'meta_dirty' : item.syncStatus,
        });
      }
      await db.items.bulkPut(updatedItems);
    }
  });
}

/** 更新条目的分类（支持多文件夹）、标签、备注或标题，自动 upsert 标签并在必要时标记 `meta_dirty` */
export async function updateItemClassification(
  itemId: string,
  patch: {
    folderId?: string | null;
    folderIds?: string[];
    tags?: string[];
    note?: string;
    title?: string;
  },
): Promise<CollectionItemRecord | null> {
  return db.transaction('rw', db.items, db.tags, async () => {
    const existing = await db.items.get(itemId);
    if (!existing) {
      return null;
    }

    let nextTags = existing.tags;
    if (patch.tags !== undefined) {
      const upserted = await upsertTags(patch.tags);
      nextTags = upserted.map((t) => t.name);
    }

    const nextTitle =
      patch.title !== undefined ? patch.title.trim() || existing.title : existing.title;

    let nextFolderIds = getItemFolderIds(existing);
    const foldersExplicitlyEdited =
      patch.folderIds !== undefined || patch.folderId !== undefined;
    if (patch.folderIds !== undefined) {
      nextFolderIds = normalizeFolderIds(patch.folderIds);
    } else if (patch.folderId !== undefined) {
      nextFolderIds = normalizeFolderIds(undefined, patch.folderId);
    }

    const updated: CollectionItemRecord = {
      ...existing,
      folderIds: nextFolderIds,
      folderId: nextFolderIds[0] ?? null,
      ...(foldersExplicitlyEdited ? { folderAssignedBy: 'manual' as const } : {}),
      tags: nextTags,
      note: patch.note !== undefined ? patch.note : existing.note,
      title: nextTitle,
      updatedAt: Date.now(),
      syncStatus:
        existing.syncStatus === 'vault_synced'
          ? 'meta_dirty'
          : existing.syncStatus,
    };

    await db.items.put(updated);
    return updated;
  });
}

/** 批量将条目加入一个或多个分类文件夹（并集追加，保留既有文件夹归属） */
export async function addItemsToFolders(
  itemIds: readonly string[],
  folderIdsToAdd: readonly string[],
): Promise<CollectionItemRecord[]> {
  const uniqueItemIds = Array.from(new Set(itemIds.filter(Boolean)));
  const normalizedTargetFolders = normalizeFolderIds(folderIdsToAdd);
  if (uniqueItemIds.length === 0 || normalizedTargetFolders.length === 0) {
    return [];
  }

  return db.transaction('rw', db.items, db.folders, async () => {
    const existingFolders = await db.folders.bulkGet(normalizedTargetFolders);
    const validFolderIds = normalizedTargetFolders.filter(
      (_, idx) => existingFolders[idx] !== undefined,
    );
    if (validFolderIds.length === 0) {
      return [];
    }

    const records = await db.items.bulkGet(uniqueItemIds);
    const now = Date.now();
    const updatedList: CollectionItemRecord[] = [];

    for (const existing of records) {
      if (!existing) {
        continue;
      }
      const currentFolderIds = getItemFolderIds(existing);
      const mergedFolderIds = normalizeFolderIds([
        ...currentFolderIds,
        ...validFolderIds,
      ]);
      const unchanged =
        mergedFolderIds.length === currentFolderIds.length &&
        Array.isArray(existing.folderIds) &&
        existing.folderId === (mergedFolderIds[0] ?? null) &&
        existing.folderAssignedBy !== 'auto';
      if (unchanged) {
        continue;
      }

      updatedList.push({
        ...existing,
        folderIds: mergedFolderIds,
        folderId: mergedFolderIds[0] ?? null,
        folderAssignedBy: 'manual',
        updatedAt: now,
        syncStatus:
          existing.syncStatus === 'vault_synced'
            ? 'meta_dirty'
            : existing.syncStatus,
      });
    }

    if (updatedList.length > 0) {
      await db.items.bulkPut(updatedList);
    }
    return updatedList;
  });
}

/** 批量将条目从指定分类文件夹移出（保留条目在其他文件夹中的归属） */
export async function removeItemsFromFolder(
  itemIds: readonly string[],
  folderIdToRemove: string,
): Promise<CollectionItemRecord[]> {
  const uniqueItemIds = Array.from(new Set(itemIds.filter(Boolean)));
  const targetFolderId = folderIdToRemove.trim();
  if (uniqueItemIds.length === 0 || !targetFolderId) {
    return [];
  }

  return db.transaction('rw', db.items, async () => {
    const records = await db.items.bulkGet(uniqueItemIds);
    const now = Date.now();
    const updatedList: CollectionItemRecord[] = [];

    for (const existing of records) {
      if (!existing) {
        continue;
      }
      const currentFolderIds = getItemFolderIds(existing);
      if (!currentFolderIds.includes(targetFolderId)) {
        continue;
      }
      const nextFolderIds = currentFolderIds.filter(
        (fid) => fid !== targetFolderId,
      );
      updatedList.push({
        ...existing,
        folderIds: nextFolderIds,
        folderId: nextFolderIds[0] ?? null,
        folderAssignedBy: 'manual',
        updatedAt: now,
        syncStatus:
          existing.syncStatus === 'vault_synced'
            ? 'meta_dirty'
            : existing.syncStatus,
      });
    }

    if (updatedList.length > 0) {
      await db.items.bulkPut(updatedList);
    }
    return updatedList;
  });
}

/** 批量软删除条目（移入回收站），已同步条目自动置为 `meta_dirty` */
export async function softDeleteItems(
  itemIds: readonly string[],
): Promise<CollectionItemRecord[]> {
  const uniqueIds = Array.from(new Set(itemIds.filter(Boolean)));
  if (uniqueIds.length === 0) {
    return [];
  }

  return db.transaction('rw', db.items, async () => {
    const records = await db.items.bulkGet(uniqueIds);
    const now = Date.now();
    const updatedList: CollectionItemRecord[] = [];

    for (const existing of records) {
      if (!existing || existing.deletedAt != null || isAutoSyncExcluded(existing)) {
        continue;
      }
      updatedList.push({
        ...existing,
        deletedAt: now,
        updatedAt: now,
        syncStatus:
          existing.syncStatus === 'vault_synced'
            ? 'meta_dirty'
            : existing.syncStatus,
      });
    }

    if (updatedList.length > 0) {
      await db.items.bulkPut(updatedList);
    }
    return updatedList;
  });
}

/** 软删除单个条目（移入回收站），已同步条目自动置为 `meta_dirty` */
export async function softDeleteItem(itemId: string): Promise<void> {
  await softDeleteItems([itemId]);
}

/** 批量从回收站恢复软删除条目，已同步条目自动置为 `meta_dirty` */
export async function restoreItems(
  itemIds: readonly string[],
): Promise<CollectionItemRecord[]> {
  const uniqueIds = Array.from(new Set(itemIds.filter(Boolean)));
  if (uniqueIds.length === 0) {
    return [];
  }

  return db.transaction('rw', db.items, async () => {
    const records = await db.items.bulkGet(uniqueIds);
    const now = Date.now();
    const updatedList: CollectionItemRecord[] = [];

    for (const existing of records) {
      if (!existing || existing.deletedAt == null || isAutoSyncExcluded(existing)) {
        continue;
      }
      updatedList.push({
        ...existing,
        deletedAt: null,
        updatedAt: now,
        syncStatus:
          existing.syncStatus === 'vault_synced'
            ? 'meta_dirty'
            : existing.syncStatus,
      });
    }

    if (updatedList.length > 0) {
      await db.items.bulkPut(updatedList);
    }
    return updatedList;
  });
}

/** 从回收站恢复单个软删除条目，已同步条目自动置为 `meta_dirty` */
export async function restoreItem(itemId: string): Promise<void> {
  await restoreItems([itemId]);
}

/** 批量将条目转入「不自动同步」特殊分类（清空媒体下载标记与文件夹归属，保留轻量元数据，并将未完成任务置为取消） */
export async function markItemsAutoSyncExcluded(
  entries: ReadonlyArray<{
    itemId: string;
    reason: AutoSyncExclusionReason;
    detail?: string;
  }>,
): Promise<CollectionItemRecord[]> {
  const entryById = new Map<
    string,
    { reason: AutoSyncExclusionReason; detail?: string }
  >();
  for (const entry of entries) {
    const id = entry.itemId.trim();
    if (!id) {
      continue;
    }
    entryById.set(id, {
      reason: entry.reason,
      ...(entry.detail !== undefined ? { detail: entry.detail } : {}),
    });
  }

  const uniqueIds = Array.from(entryById.keys());
  if (uniqueIds.length === 0) {
    return [];
  }

  return db.transaction('rw', db.items, db.tasks, async () => {
    const records = await db.items.bulkGet(uniqueIds);
    const now = Date.now();
    const updatedList: CollectionItemRecord[] = [];

    for (const existing of records) {
      if (!existing) {
        continue;
      }
      const spec = entryById.get(existing.id);
      if (!spec) {
        continue;
      }

      const trimmedDetail = spec.detail?.trim();
      const exclusion: AutoSyncExclusion = {
        reason: spec.reason,
        ...(trimmedDetail ? { detail: trimmedDetail } : {}),
        excludedAt: now,
      };

      const resetAssets: MediaAsset[] = existing.assets.map((asset) => {
        const { sizeBytes: _sizeBytes, ...rest } = asset;
        void _sizeBytes;
        return {
          ...rest,
          downloaded: false,
        };
      });

      const {
        commentsRelativePath: _commentsRelativePath,
        savedCommentCount: _savedCommentCount,
        commentsSizeBytes: _commentsSizeBytes,
        folderAssignedBy: _folderAssignedBy,
        ...baseRecord
      } = existing;
      void _commentsRelativePath;
      void _savedCommentCount;
      void _commentsSizeBytes;
      void _folderAssignedBy;

      updatedList.push({
        ...baseRecord,
        folderId: null,
        folderIds: [],
        deletedAt: null,
        autoSyncExclusion: exclusion,
        assets: resetAssets,
        totalSizeBytes: 0,
        syncStatus: 'meta_dirty',
        updatedAt: now,
      });
    }

    if (updatedList.length > 0) {
      await db.items.bulkPut(updatedList);
    }

    const relatedTasks = await db.tasks
      .where('itemId')
      .anyOf(uniqueIds)
      .toArray();
    const cancelledTasks: DownloadTask[] = [];
    for (const task of relatedTasks) {
      if (
        task.status === 'queued' ||
        task.status === 'downloading' ||
        task.status === 'processing'
      ) {
        cancelledTasks.push({
          ...task,
          status: 'cancelled',
          errorMessage: '条目已设为不自动同步，下载任务已取消。',
          updatedAt: now,
        });
      }
    }
    if (cancelledTasks.length > 0) {
      await db.tasks.bulkPut(cancelledTasks);
    }

    return updatedList;
  });
}

/** 从 IndexedDB 彻底移除指定条目及其关联下载任务记录 */
export async function hardDeleteItemsFromDb(
  itemIds: readonly string[],
): Promise<void> {
  const uniqueIds = Array.from(new Set(itemIds.filter(Boolean)));
  if (uniqueIds.length === 0) {
    return;
  }

  await db.transaction('rw', db.items, db.tasks, async () => {
    const relatedTasks = await db.tasks
      .where('itemId')
      .anyOf(uniqueIds)
      .primaryKeys();
    if (relatedTasks.length > 0) {
      await db.tasks.bulkDelete(relatedTasks);
    }
    await db.items.bulkDelete(uniqueIds);
  });
}

/** 标记条目已在管理台打开查看（幂等，已打开过则跳过）；已落盘条目自动置为 `meta_dirty` */
export async function markItemOpened(
  itemId: string,
): Promise<CollectionItemRecord | null> {
  return db.transaction('rw', db.items, async () => {
    const existing = await db.items.get(itemId);
    if (!existing || existing.openedAt != null) {
      return null;
    }
    const now = Date.now();
    const updated: CollectionItemRecord = {
      ...existing,
      openedAt: now,
      updatedAt: now,
      syncStatus:
        existing.syncStatus === 'vault_synced'
          ? 'meta_dirty'
          : existing.syncStatus,
    };
    await db.items.put(updated);
    return updated;
  });
}

/** 统计待同步到 CollectVault 的暂存条目数与元数据脏条目数 */
export async function getVaultSyncPendingCounts(): Promise<{
  stagedCount: number;
  metaDirtyCount: number;
}> {
  const [stagedCount, metaDirtyCount] = await Promise.all([
    db.items.where('syncStatus').equals('opfs_staged').count(),
    db.items.where('syncStatus').equals('meta_dirty').count(),
  ]);

  return { stagedCount, metaDirtyCount };
}
