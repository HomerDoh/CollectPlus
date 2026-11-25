import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Download } from 'lucide-react';
import {
  createFolder,
  db,
  DEFAULT_USER_PREFERENCES,
  deleteFolder,
  getSetting,
  getUserPreferences,
  getVaultSyncPendingCounts,
  renameFolder,
  restoreItem,
  softDeleteItem,
  updateItemClassification,
  updateUserPreferences,
} from '@/storage/db.ts';
import { sendToBackground } from '@/types/messages.ts';
import { CollectionSearchEngine } from '@/storage/search.ts';
import {
  bindNewVaultDirectory,
  flushToVault,
  getSavedVaultHandle,
  isFilesystemWriteDeniedError,
  queryVaultPermission,
  rebuildIndexFromVault,
  requestVaultPermission,
  VAULT_PERMISSION_HELP_URL,
  VaultFilesystemPermissionError,
  writeItemMetaToVault,
  writeTaxonomyToVault,
  type FlushProgress,
  type FlushSummary,
  type RebuildProgress,
  type RebuildSummary,
} from '@/storage/vault.ts';
import type {
  CollectionItemRecord,
  FolderNode,
  TagMeta,
  UserPreferences,
} from '@/types/schema.ts';
import {
  ItemCardGrid,
  type SortOption,
  type ViewMode,
} from './components/ItemCardGrid.tsx';
import {
  ItemDetailDrawer,
  type ItemEditPatch,
  type SaveItemResult,
} from './components/ItemDetailDrawer.tsx';
import { SettingsPanel } from './components/SettingsPanel.tsx';
import {
  SidebarTree,
  type MediaKindFilter,
  type PlatformFilter,
  type QuickNavView,
} from './components/SidebarTree.tsx';
import {
  VaultBanner,
  type VaultBannerError,
  type VaultPermissionStatus,
} from './components/VaultBanner.tsx';
import { getErrorMessage } from './utils/format.ts';

function toVaultBannerError(
  prefix: string,
  error: unknown,
  fallbackDirName?: string,
): string | VaultBannerError {
  if (isFilesystemWriteDeniedError(error)) {
    const message =
      error instanceof VaultFilesystemPermissionError
        ? error.message
        : new VaultFilesystemPermissionError(
            fallbackDirName || 'CollectVault',
            error,
          ).message;
    return {
      message,
      helpUrl: VAULT_PERMISSION_HELP_URL,
      helpLabel: '查看权限问题解决办法',
      canRebind: true,
    };
  }
  return `${prefix}：${getErrorMessage(error)}`;
}

function parseItemIdFromHash(hash: string): string | null {
  const match = hash.match(/^#item=(.+)$/);
  if (!match?.[1]) {
    return null;
  }
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

function collectDescendantFolderIds(
  rootId: string,
  folders: readonly FolderNode[],
): Set<string> {
  const childrenMap = new Map<string, string[]>();
  for (const folder of folders) {
    if (folder.parentId !== null) {
      const list = childrenMap.get(folder.parentId);
      if (list) {
        list.push(folder.id);
      } else {
        childrenMap.set(folder.parentId, [folder.id]);
      }
    }
  }

  const result = new Set<string>([rootId]);
  const queue: string[] = [rootId];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      continue;
    }
    const children = childrenMap.get(current);
    if (children) {
      for (const childId of children) {
        if (!result.has(childId)) {
          result.add(childId);
          queue.push(childId);
        }
      }
    }
  }
  return result;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

export default function App() {
  // 1. 实时订阅 IndexedDB 全量数据
  const liveItems = useLiveQuery(() => db.items.toArray(), []);
  const liveFolders = useLiveQuery(
    () => db.folders.orderBy('sortOrder').toArray(),
    [],
  );
  const liveTags = useLiveQuery(
    () => db.tags.orderBy('createdAt').toArray(),
    [],
  );
  const activeDownloadCount = useLiveQuery(
    () =>
      db.tasks
        .where('status')
        .anyOf(['queued', 'downloading', 'processing'])
        .count(),
    [],
  );
  const lastSyncAt = useLiveQuery(() => getSetting('last_sync_at'), []);
  const livePreferences = useLiveQuery(() => getUserPreferences(), []);

  const items: readonly CollectionItemRecord[] = liveItems ?? [];
  const folders: readonly FolderNode[] = liveFolders ?? [];
  const tags: readonly TagMeta[] = liveTags ?? [];
  const preferences: UserPreferences =
    livePreferences ?? DEFAULT_USER_PREFERENCES;

  // 2. Vault 目录句柄与同步/重建状态
  const [vaultHandle, setVaultHandle] =
    useState<FileSystemDirectoryHandle | null>(null);
  const [permissionState, setPermissionState] =
    useState<VaultPermissionStatus>('unbound');
  const [isFlushing, setIsFlushing] = useState(false);
  const [flushProgress, setFlushProgress] = useState<FlushProgress | null>(
    null,
  );
  const [lastFlushSummary, setLastFlushSummary] = useState<FlushSummary | null>(
    null,
  );
  const [isRebuilding, setIsRebuilding] = useState(false);
  const [rebuildProgress, setRebuildProgress] =
    useState<RebuildProgress | null>(null);
  const [lastRebuildSummary, setLastRebuildSummary] =
    useState<RebuildSummary | null>(null);
  const [showRebuildSuggestion, setShowRebuildSuggestion] = useState(false);
  const [bannerError, setBannerError] = useState<
    string | VaultBannerError | null
  >(null);

  const vaultBusyRef = useRef(false);
  const autoSyncTriggeredRef = useRef(false);
  const prefsHydratedRef = useRef(false);

  // 3. 视图筛选、设置页与详情抽屉状态
  const [activePage, setActivePage] = useState<'library' | 'settings'>(
    'library',
  );
  const [activeView, setActiveView] = useState<QuickNavView>('all');
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);
  const [mediaKindFilter, setMediaKindFilter] =
    useState<MediaKindFilter>('all');
  const [platformFilter, setPlatformFilter] = useState<PlatformFilter>('all');
  const [selectedTag, setSelectedTag] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState<SortOption>('collectedAt');
  const [viewMode, setViewMode] = useState<ViewMode>('grid');
  const [selectedItemId, setSelectedItemId] = useState<string | null>(() =>
    parseItemIdFromHash(window.location.hash),
  );

  // 首次加载持久化偏好时同步默认视图与默认排序
  useEffect(() => {
    if (!livePreferences || prefsHydratedRef.current) {
      return;
    }
    prefsHydratedRef.current = true;
    setViewMode(livePreferences.defaultViewMode);
    setSortBy(livePreferences.defaultSortBy);
  }, [livePreferences]);

  const handleUpdatePreferences = useCallback(
    async (patch: Partial<UserPreferences>) => {
      const updated = await updateUserPreferences(patch);
      if (patch.defaultViewMode !== undefined) {
        setViewMode(updated.defaultViewMode);
      }
      if (patch.defaultSortBy !== undefined) {
        setSortBy(updated.defaultSortBy);
      }
      void sendToBackground({
        target: 'background',
        type: 'NOTIFY_PREFERENCES_UPDATED',
      }).catch(() => undefined);
    },
    [],
  );

  // 4. MiniSearch 全文检索引擎联动
  const searchEngineRef = useRef<CollectionSearchEngine>(
    new CollectionSearchEngine(),
  );
  const [searchIndexVersion, setSearchIndexVersion] = useState(0);

  useEffect(() => {
    searchEngineRef.current.rebuild([...items]);
    setSearchIndexVersion((v) => v + 1);
  }, [items]);

  // 5. 监听 URL hash (#item=<id>) 变化
  useEffect(() => {
    const handleHashChange = () => {
      setSelectedItemId(parseItemIdFromHash(window.location.hash));
    };
    window.addEventListener('hashchange', handleHashChange);
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, []);

  const openItemDrawer = useCallback((item: CollectionItemRecord) => {
    setSelectedItemId(item.id);
    const nextHash = `#item=${encodeURIComponent(item.id)}`;
    if (window.location.hash !== nextHash) {
      window.history.replaceState(
        null,
        '',
        `${window.location.pathname}${window.location.search}${nextHash}`,
      );
    }
  }, []);

  const closeItemDrawer = useCallback(() => {
    setSelectedItemId(null);
    if (window.location.hash) {
      window.history.replaceState(
        null,
        '',
        `${window.location.pathname}${window.location.search}`,
      );
    }
  }, []);

  // 6. 执行 OPFS -> CollectVault 同步落盘
  const runFlushToVault = useCallback(
    async (
      handle: FileSystemDirectoryHandle,
      options?: { silentEmpty?: boolean },
    ) => {
      if (vaultBusyRef.current) {
        return;
      }
      vaultBusyRef.current = true;
      setIsFlushing(true);
      setBannerError(null);
      setLastRebuildSummary(null);
      setFlushProgress({ phase: 'preparing', current: 0, total: 0 });

      try {
        const summary = await flushToVault(handle, (progress) => {
          setFlushProgress(progress);
        });
        if (
          !options?.silentEmpty ||
          summary.syncedStagedCount > 0 ||
          summary.syncedMetaCount > 0 ||
          summary.failedCount > 0
        ) {
          setLastFlushSummary(summary);
        }
      } catch (error) {
        setBannerError(
          toVaultBannerError('同步到 CollectVault 失败', error, handle.name),
        );
      } finally {
        setIsFlushing(false);
        setFlushProgress(null);
        vaultBusyRef.current = false;
      }
    },
    [],
  );

  // 7. 页面初始化读取 Vault 句柄、权限并按偏好自动静默同步
  useEffect(() => {
    let disposed = false;

    const initVault = async () => {
      try {
        const savedHandle = await getSavedVaultHandle();
        if (disposed) {
          return;
        }
        if (!savedHandle) {
          setVaultHandle(null);
          setPermissionState('unbound');
          return;
        }

        setVaultHandle(savedHandle);
        const perm = await queryVaultPermission(savedHandle, 'readwrite');
        if (disposed) {
          return;
        }
        setPermissionState(perm);

        if (perm === 'granted' && !autoSyncTriggeredRef.current) {
          const [prefs, pendingCounts] = await Promise.all([
            getUserPreferences(),
            getVaultSyncPendingCounts(),
          ]);
          if (disposed) {
            return;
          }
          if (
            prefs.autoSyncOnLibraryOpen &&
            pendingCounts.stagedCount + pendingCounts.metaDirtyCount > 0
          ) {
            autoSyncTriggeredRef.current = true;
            await runFlushToVault(savedHandle, { silentEmpty: true });
          }
        }
      } catch (error) {
        if (!disposed) {
          setBannerError(`读取本地目录状态失败：${getErrorMessage(error)}`);
        }
      }
    };

    void initVault();

    return () => {
      disposed = true;
    };
  }, [runFlushToVault]);

  // 8. 绑定/切换本地 CollectVault 目录
  const handleBindVault = useCallback(async () => {
    if (vaultBusyRef.current) {
      return;
    }
    setBannerError(null);
    setLastFlushSummary(null);
    setLastRebuildSummary(null);

    try {
      const { handle, isExistingVault } = await bindNewVaultDirectory();
      setVaultHandle(handle);
      setPermissionState('granted');

      const [totalInDb, pendingCounts] = await Promise.all([
        db.items.count(),
        getVaultSyncPendingCounts(),
      ]);

      if (isExistingVault && totalInDb === 0) {
        setShowRebuildSuggestion(true);
      } else {
        setShowRebuildSuggestion(false);
        if (pendingCounts.stagedCount + pendingCounts.metaDirtyCount > 0) {
          await runFlushToVault(handle);
        }
      }
    } catch (error) {
      if (isAbortError(error)) {
        return;
      }
      setBannerError(toVaultBannerError('绑定本地目录失败', error));
    }
  }, [runFlushToVault]);

  // 9. 请求已有目录权限并在授权后同步待落盘条目
  const handleRequestPermissionAndSync = useCallback(async (): Promise<boolean> => {
    setBannerError(null);

    if (!vaultHandle) {
      await handleBindVault();
      const updatedHandle = await getSavedVaultHandle();
      if (!updatedHandle) {
        return false;
      }
      const perm = await queryVaultPermission(updatedHandle, 'readwrite');
      return perm === 'granted';
    }

    try {
      const granted = await requestVaultPermission(vaultHandle, 'readwrite');
      const nextPerm: VaultPermissionStatus = granted
        ? 'granted'
        : await queryVaultPermission(vaultHandle, 'readwrite');
      setPermissionState(nextPerm);

      if (!granted) {
        setBannerError('未授予本地 CollectVault 目录的读写权限。');
        return false;
      }

      const pendingCounts = await getVaultSyncPendingCounts();
      if (pendingCounts.stagedCount + pendingCounts.metaDirtyCount > 0) {
        await runFlushToVault(vaultHandle);
      }
      return true;
    } catch (error) {
      if (!isAbortError(error)) {
        setBannerError(`请求本地目录权限失败：${getErrorMessage(error)}`);
      }
      return false;
    }
  }, [vaultHandle, handleBindVault, runFlushToVault]);

  // 10. 手动触发同步到 CollectVault
  const handleManualFlush = useCallback(async () => {
    if (!vaultHandle) {
      return;
    }
    const granted = await requestVaultPermission(vaultHandle, 'readwrite');
    if (!granted) {
      setPermissionState(await queryVaultPermission(vaultHandle, 'readwrite'));
      setBannerError('缺少本地目录写权限，无法执行同步。');
      return;
    }
    setPermissionState('granted');
    await runFlushToVault(vaultHandle);
  }, [vaultHandle, runFlushToVault]);

  // 11. 容灾重建索引
  const handleRebuildIndex = useCallback(async () => {
    if (!vaultHandle || vaultBusyRef.current) {
      return;
    }
    const granted = await requestVaultPermission(vaultHandle, 'readwrite');
    if (!granted) {
      setPermissionState(await queryVaultPermission(vaultHandle, 'readwrite'));
      setBannerError('缺少本地目录权限，无法重建索引。');
      return;
    }
    setPermissionState('granted');

    vaultBusyRef.current = true;
    setIsRebuilding(true);
    setShowRebuildSuggestion(false);
    setBannerError(null);
    setLastFlushSummary(null);
    setRebuildProgress({ phase: 'scanning', scannedItems: 0 });

    try {
      const summary = await rebuildIndexFromVault(vaultHandle, (progress) => {
        setRebuildProgress(progress);
      });
      setLastRebuildSummary(summary);
    } catch (error) {
      setBannerError(`重建索引失败：${getErrorMessage(error)}`);
    } finally {
      setIsRebuilding(false);
      setRebuildProgress(null);
      vaultBusyRef.current = false;
    }
  }, [vaultHandle]);

  // 12. 清空浏览器缓存索引（绝不删除硬盘文件与目录句柄）
  const handleClearBrowserCache = useCallback(async () => {
    if (vaultBusyRef.current) {
      return;
    }
    setBannerError(null);
    setLastFlushSummary(null);
    setLastRebuildSummary(null);

    try {
      await db.transaction(
        'rw',
        db.items,
        db.folders,
        db.tags,
        db.tasks,
        async () => {
          await Promise.all([
            db.items.clear(),
            db.folders.clear(),
            db.tags.clear(),
            db.tasks.clear(),
          ]);
        },
      );
      closeItemDrawer();
      setSelectedFolderId(null);
      setSelectedTag(null);
      setActiveView('all');
      if (vaultHandle && permissionState === 'granted') {
        setShowRebuildSuggestion(true);
      }
    } catch (error) {
      setBannerError(`清空浏览器缓存索引失败：${getErrorMessage(error)}`);
    }
  }, [closeItemDrawer, vaultHandle, permissionState]);

  // 13. 文件夹操作（有 Vault 写权限时自动回写 taxonomy.json）
  const syncTaxonomyIfPermitted = useCallback(async () => {
    if (!vaultHandle || permissionState !== 'granted') {
      return;
    }
    try {
      await writeTaxonomyToVault(vaultHandle);
    } catch (error) {
      setBannerError(
        toVaultBannerError('回写 taxonomy.json 失败', error, vaultHandle.name),
      );
    }
  }, [vaultHandle, permissionState]);

  const handleCreateFolder = useCallback(
    async (name: string, parentId: string | null) => {
      await createFolder(name, parentId);
      await syncTaxonomyIfPermitted();
    },
    [syncTaxonomyIfPermitted],
  );

  const handleRenameFolder = useCallback(
    async (id: string, name: string) => {
      await renameFolder(id, name);
      await syncTaxonomyIfPermitted();
    },
    [syncTaxonomyIfPermitted],
  );

  const handleDeleteFolder = useCallback(
    async (id: string) => {
      const removedSet = collectDescendantFolderIds(id, folders);
      await deleteFolder(id);
      if (selectedFolderId !== null && removedSet.has(selectedFolderId)) {
        setSelectedFolderId(null);
        setActiveView('all');
      }
      await syncTaxonomyIfPermitted();
    },
    [folders, selectedFolderId, syncTaxonomyIfPermitted],
  );

  // 14. 条目元数据实时编辑保存 + 有写权限立即回写 meta.json & taxonomy.json
  const handleSaveItem = useCallback(
    async (itemId: string, patch: ItemEditPatch): Promise<SaveItemResult> => {
      const updated = await updateItemClassification(itemId, patch);
      if (!updated) {
        throw new Error('未找到对应的收藏条目。');
      }

      if (vaultHandle && permissionState === 'granted') {
        await writeTaxonomyToVault(vaultHandle);

        if (
          updated.syncStatus === 'meta_dirty' ||
          updated.syncStatus === 'vault_synced'
        ) {
          const syncedRecord: CollectionItemRecord = {
            ...updated,
            syncStatus: 'vault_synced',
          };
          await writeItemMetaToVault(vaultHandle, syncedRecord);
          await db.items.put(syncedRecord);
          return {
            syncedToVault: true,
            message: '已保存并实时回写至本地 meta.json 与 taxonomy.json',
          };
        }

        // 若条目仍处于 opfs_staged，媒体文件尚在 OPFS 中，保留 opfs_staged 等待落盘以免丢失媒体
        return {
          syncedToVault: false,
          message: '分类已保存并更新 taxonomy.json，请点击顶部同步将暂存媒体落盘',
        };
      }

      return {
        syncedToVault: false,
        message: '已保存到浏览器索引，授权 CollectVault 后可同步至硬盘',
      };
    },
    [vaultHandle, permissionState],
  );

  // 15. 软删除 / 恢复条目（已授权且已落盘条目同步回写 meta.json）
  const syncItemMetaAfterTrashToggle = useCallback(
    async (itemId: string) => {
      if (!vaultHandle || permissionState !== 'granted') {
        return;
      }
      try {
        const latest = await db.items.get(itemId);
        if (latest && latest.syncStatus === 'meta_dirty') {
          const synced: CollectionItemRecord = {
            ...latest,
            syncStatus: 'vault_synced',
          };
          await writeItemMetaToVault(vaultHandle, synced);
          await db.items.put(synced);
        }
      } catch (error) {
        setBannerError(
          toVaultBannerError('回写条目元数据失败', error, vaultHandle.name),
        );
      }
    },
    [vaultHandle, permissionState],
  );

  const handleSoftDeleteItem = useCallback(
    async (item: CollectionItemRecord) => {
      await softDeleteItem(item.id);
      await syncItemMetaAfterTrashToggle(item.id);
    },
    [syncItemMetaAfterTrashToggle],
  );

  const handleRestoreItem = useCallback(
    async (item: CollectionItemRecord) => {
      await restoreItem(item.id);
      await syncItemMetaAfterTrashToggle(item.id);
    },
    [syncItemMetaAfterTrashToggle],
  );

  // 16. 派生统计、标签映射、筛选与排序结果
  const { stagedCount, metaDirtyCount } = useMemo(() => {
    let staged = 0;
    let dirty = 0;
    for (const item of items) {
      if (item.syncStatus === 'opfs_staged') {
        staged += 1;
      } else if (item.syncStatus === 'meta_dirty') {
        dirty += 1;
      }
    }
    return { stagedCount: staged, metaDirtyCount: dirty };
  }, [items]);

  const tagsByName = useMemo(() => {
    const map = new Map<string, TagMeta>();
    for (const tag of tags) {
      map.set(tag.name, tag);
    }
    return map;
  }, [tags]);

  const foldersById = useMemo(() => {
    const map = new Map<string, FolderNode>();
    for (const folder of folders) {
      map.set(folder.id, folder);
    }
    return map;
  }, [folders]);

  const filteredItems = useMemo(() => {
    // 显式依赖 searchIndexVersion，确保条目内容变化后搜索结果即时刷新
    void searchIndexVersion;

    const trimmedQuery = searchQuery.trim();
    const searchRankMap = new Map<string, number>();
    if (trimmedQuery) {
      const matchedIds = searchEngineRef.current.search(trimmedQuery);
      for (let i = 0; i < matchedIds.length; i += 1) {
        const id = matchedIds[i];
        if (id) {
          searchRankMap.set(id, i);
        }
      }
    }

    const allowedFolderIds =
      selectedFolderId !== null
        ? collectDescendantFolderIds(selectedFolderId, folders)
        : null;

    const list = items.filter((item) => {
      const isDeleted = item.deletedAt != null;

      if (selectedFolderId !== null) {
        if (isDeleted) {
          return false;
        }
        if (
          item.folderId === null ||
          !allowedFolderIds?.has(item.folderId)
        ) {
          return false;
        }
      } else {
        switch (activeView) {
          case 'all':
            if (isDeleted) {
              return false;
            }
            break;
          case 'uncategorized':
            if (isDeleted || item.folderId !== null) {
              return false;
            }
            break;
          case 'pending_sync':
            if (
              isDeleted ||
              (item.syncStatus !== 'opfs_staged' &&
                item.syncStatus !== 'meta_dirty')
            ) {
              return false;
            }
            break;
          case 'trash':
            if (!isDeleted) {
              return false;
            }
            break;
        }
      }

      if (mediaKindFilter === 'video' && item.kind !== 'video') {
        return false;
      }
      if (
        mediaKindFilter === 'gallery' &&
        item.kind !== 'gallery' &&
        item.kind !== 'image'
      ) {
        return false;
      }
      if (mediaKindFilter === 'article' && item.kind !== 'article') {
        return false;
      }

      if (platformFilter !== 'all' && item.platform !== platformFilter) {
        return false;
      }

      if (selectedTag !== null && !item.tags.includes(selectedTag)) {
        return false;
      }

      if (trimmedQuery && !searchRankMap.has(item.id)) {
        return false;
      }

      return true;
    });

    list.sort((a, b) => {
      if (trimmedQuery) {
        const rankA = searchRankMap.get(a.id) ?? Number.MAX_SAFE_INTEGER;
        const rankB = searchRankMap.get(b.id) ?? Number.MAX_SAFE_INTEGER;
        if (rankA !== rankB) {
          return rankA - rankB;
        }
      }

      switch (sortBy) {
        case 'publishedAt':
          return (
            (b.publishedAt ?? b.collectedAt) -
              (a.publishedAt ?? a.collectedAt) || b.collectedAt - a.collectedAt
          );
        case 'totalSizeBytes':
          return (
            b.totalSizeBytes - a.totalSizeBytes ||
            b.collectedAt - a.collectedAt
          );
        case 'collectedAt':
          return b.collectedAt - a.collectedAt;
      }
    });

    return list;
  }, [
    items,
    folders,
    activeView,
    selectedFolderId,
    mediaKindFilter,
    platformFilter,
    selectedTag,
    searchQuery,
    sortBy,
    searchIndexVersion,
  ]);

  const selectedItem = useMemo(() => {
    if (!selectedItemId) {
      return null;
    }
    return items.find((item) => item.id === selectedItemId) ?? null;
  }, [items, selectedItemId]);

  const contextTitle = useMemo(() => {
    if (selectedFolderId !== null) {
      return foldersById.get(selectedFolderId)?.name ?? '文件夹';
    }
    switch (activeView) {
      case 'all':
        return '全部收藏';
      case 'uncategorized':
        return '未分类';
      case 'pending_sync':
        return '待同步';
      case 'trash':
        return '回收站';
    }
  }, [selectedFolderId, foldersById, activeView]);

  const hasActiveFilters =
    searchQuery.trim().length > 0 ||
    mediaKindFilter !== 'all' ||
    platformFilter !== 'all' ||
    selectedTag !== null ||
    selectedFolderId !== null ||
    activeView === 'uncategorized' ||
    activeView === 'pending_sync';

  const handleResetFilters = useCallback(() => {
    setSearchQuery('');
    setMediaKindFilter('all');
    setPlatformFilter('all');
    setSelectedTag(null);
    setSelectedFolderId(null);
    if (activeView !== 'trash') {
      setActiveView('all');
    }
  }, [activeView]);

  const activeItemCount = useMemo(
    () => items.filter((item) => item.deletedAt == null).length,
    [items],
  );

  return (
    <div className="flex h-screen overflow-hidden bg-slate-50 text-slate-900">
      {/* 左侧导航与多级文件夹分类树 */}
      <SidebarTree
        items={items}
        folders={folders}
        tags={tags}
        activeView={activeView}
        selectedFolderId={selectedFolderId}
        mediaKindFilter={mediaKindFilter}
        platformFilter={platformFilter}
        selectedTag={selectedTag}
        isSettingsOpen={activePage === 'settings'}
        onSelectView={(view) => {
          setActivePage('library');
          setSelectedFolderId(null);
          setActiveView(view);
        }}
        onSelectFolder={(folderId) => {
          setActivePage('library');
          setSelectedFolderId(folderId);
        }}
        onSelectMediaKind={(kind) => {
          setActivePage('library');
          setMediaKindFilter(kind);
        }}
        onSelectPlatform={(platform) => {
          setActivePage('library');
          setPlatformFilter(platform);
        }}
        onSelectTag={(tag) => {
          setActivePage('library');
          setSelectedTag(tag);
        }}
        onOpenSettings={() => {
          setActivePage('settings');
        }}
        onCreateFolder={handleCreateFolder}
        onRenameFolder={handleRenameFolder}
        onDeleteFolder={handleDeleteFolder}
      />

      {/* 右侧主工作区 */}
      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {/* Vault 状态横幅 */}
        <VaultBanner
          vaultHandle={vaultHandle}
          permissionState={permissionState}
          lastSyncAt={lastSyncAt}
          stagedCount={stagedCount}
          metaDirtyCount={metaDirtyCount}
          isFlushing={isFlushing}
          flushProgress={flushProgress}
          lastFlushSummary={lastFlushSummary}
          isRebuilding={isRebuilding}
          rebuildProgress={rebuildProgress}
          lastRebuildSummary={lastRebuildSummary}
          showRebuildSuggestion={showRebuildSuggestion}
          bannerError={bannerError}
          onBindVault={handleBindVault}
          onRequestPermissionAndSync={async () => {
            await handleRequestPermissionAndSync();
          }}
          onFlushToVault={handleManualFlush}
          onRebuildIndex={handleRebuildIndex}
          onDismissSuggestion={() => setShowRebuildSuggestion(false)}
          onDismissFeedback={() => {
            setLastFlushSummary(null);
            setLastRebuildSummary(null);
            setBannerError(null);
          }}
        />

        {/* 后台下载进行中轻提示条 */}
        {activeDownloadCount !== undefined && activeDownloadCount > 0 && (
          <div className="flex items-center gap-2 border-b border-indigo-100 bg-indigo-50/70 px-6 py-1.5 text-xs text-indigo-800">
            <Download className="h-3.5 w-3.5 animate-bounce text-indigo-600" />
            <span>
              当前有 <strong>{activeDownloadCount}</strong>{' '}
              个作品正在后台下载中，完成后会自动进入暂存队列并可一键落盘。
            </span>
          </div>
        )}

        {activePage === 'settings' ? (
          <SettingsPanel
            preferences={preferences}
            folders={folders}
            vaultHandle={vaultHandle}
            permissionState={permissionState}
            lastSyncAt={lastSyncAt}
            stagedCount={stagedCount}
            metaDirtyCount={metaDirtyCount}
            totalItemCount={activeItemCount}
            totalFolderCount={folders.length}
            totalTagCount={tags.length}
            isFlushing={isFlushing}
            isRebuilding={isRebuilding}
            onUpdatePreferences={handleUpdatePreferences}
            onBindVault={handleBindVault}
            onRequestPermissionAndSync={async () => {
              await handleRequestPermissionAndSync();
            }}
            onFlushToVault={handleManualFlush}
            onRebuildIndex={handleRebuildIndex}
            onClearBrowserCache={handleClearBrowserCache}
          />
        ) : (
          /* 工具栏与卡片网格/紧凑列表 */
          <ItemCardGrid
            items={filteredItems}
            tagsByName={tagsByName}
            searchQuery={searchQuery}
            sortBy={sortBy}
            viewMode={viewMode}
            isTrashView={selectedFolderId === null && activeView === 'trash'}
            hasActiveFilters={hasActiveFilters}
            contextTitle={contextTitle}
            onSearchChange={setSearchQuery}
            onSortChange={setSortBy}
            onViewModeChange={setViewMode}
            onResetFilters={handleResetFilters}
            onOpenItem={openItemDrawer}
            onSoftDeleteItem={handleSoftDeleteItem}
            onRestoreItem={handleRestoreItem}
          />
        )}
      </main>

      {/* 离线播放与元数据编辑抽屉/模态框 */}
      {selectedItem && (
        <ItemDetailDrawer
          item={selectedItem}
          folders={folders}
          tags={tags}
          vaultHandle={vaultHandle}
          permissionState={permissionState}
          onClose={closeItemDrawer}
          onRequestVaultAccess={handleRequestPermissionAndSync}
          onSaveItem={handleSaveItem}
          onSoftDeleteItem={handleSoftDeleteItem}
          onRestoreItem={handleRestoreItem}
        />
      )}
    </div>
  );
}
