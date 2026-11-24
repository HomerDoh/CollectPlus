/**
 * Collect+ IndexedDB 高速索引层（基于 Dexie.js）。
 *
 * 承担条目元数据缓存、文件夹树、标签表、下载队列任务以及配置句柄持久化。
 */

import Dexie, { type Table } from 'dexie';
import { ulid } from 'ulid';
import type {
  CollectionItemRecord,
  DownloadTask,
  FolderNode,
  SettingKey,
  SettingRecord,
  SettingValueMap,
  TagMeta,
  UserPreferences,
} from '../types/schema.ts';

/** Collect+ IndexedDB 数据库定义 */
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
  }
}

/** 全局数据库单例 */
export const db = new CollectPlusDB();

/** 默认用户偏好设置 */
export const DEFAULT_USER_PREFERENCES: UserPreferences = {
  autoSyncOnLibraryOpen: true,
  floatingButtonEnabled: true,
  defaultFolderId: null,
  maxConcurrentDownloads: 2,
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
  return {
    ...DEFAULT_USER_PREFERENCES,
    ...saved,
  };
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

    const affectedItems = await db.items
      .where('folderId')
      .anyOf(idsToDelete)
      .toArray();

    if (affectedItems.length > 0) {
      const now = Date.now();
      const updatedItems: CollectionItemRecord[] = affectedItems.map((item) => ({
        ...item,
        folderId: null,
        updatedAt: now,
        syncStatus:
          item.syncStatus === 'vault_synced' ? 'meta_dirty' : item.syncStatus,
      }));
      await db.items.bulkPut(updatedItems);
    }
  });
}

/** 更新条目的分类、标签、备注或标题，自动 upsert 标签并在必要时标记 `meta_dirty` */
export async function updateItemClassification(
  itemId: string,
  patch: {
    folderId?: string | null;
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

    const updated: CollectionItemRecord = {
      ...existing,
      folderId:
        patch.folderId !== undefined ? patch.folderId : existing.folderId,
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

/** 软删除条目（移入回收站），已同步条目自动置为 `meta_dirty` */
export async function softDeleteItem(itemId: string): Promise<void> {
  await db.transaction('rw', db.items, async () => {
    const existing = await db.items.get(itemId);
    if (!existing) {
      return;
    }

    const now = Date.now();
    await db.items.put({
      ...existing,
      deletedAt: now,
      updatedAt: now,
      syncStatus:
        existing.syncStatus === 'vault_synced'
          ? 'meta_dirty'
          : existing.syncStatus,
    });
  });
}

/** 从回收站恢复软删除条目，已同步条目自动置为 `meta_dirty` */
export async function restoreItem(itemId: string): Promise<void> {
  await db.transaction('rw', db.items, async () => {
    const existing = await db.items.get(itemId);
    if (!existing) {
      return;
    }

    const now = Date.now();
    await db.items.put({
      ...existing,
      deletedAt: null,
      updatedAt: now,
      syncStatus:
        existing.syncStatus === 'vault_synced'
          ? 'meta_dirty'
          : existing.syncStatus,
    });
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
