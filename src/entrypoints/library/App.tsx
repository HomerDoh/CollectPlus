import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { AlertCircle, CheckCircle2, Download, X } from 'lucide-react';
import {
  addItemsToFolders,
  createFolder,
  db,
  DEFAULT_USER_PREFERENCES,
  deleteFolder,
  getSetting,
  getUserPreferences,
  getVaultSyncPendingCounts,
  hardDeleteItemsFromDb,
  markItemsAutoSyncExcluded,
  removeItemsFromFolder,
  renameFolder,
  restoreItem,
  restoreItems,
  softDeleteItems,
  updateItemClassification,
  updateUserPreferences,
} from '@/storage/db.ts';
import { removeItemFromOpfs } from '@/storage/opfs.ts';
import { sendToBackground } from '@/types/messages.ts';
import { CollectionSearchEngine } from '@/storage/search.ts';
import {
  checkVaultDirectoryExists,
  finalizeVaultBinding,
  flushToVault,
  getSavedVaultHandle,
  isFilesystemWriteDeniedError,
  migrateVaultDirectory,
  pickAndValidateVaultDirectory,
  purgeItemMediaFilesFromVault,
  queryVaultPermission,
  rebuildIndexFromVault,
  removeItemDirFromVault,
  requestVaultPermission,
  VAULT_PERMISSION_HELP_URL,
  VaultDirectoryValidationError,
  VaultFilesystemPermissionError,
  writeItemMetaToVault,
  writeTaxonomyToVault,
  type FlushProgress,
  type FlushSummary,
  type MigrationProgress,
  type MigrationSummary,
  type RebuildOptions,
  type RebuildProgress,
  type RebuildSummary,
  type VaultMigrationMode,
  type VaultPermissionStatus,
} from '@/storage/vault.ts';
import {
  getItemFolderIds,
  isAutoSyncExcluded,
  type AutoSyncExclusionReason,
  type CollectionItemRecord,
  type FolderNode,
  type TagMeta,
  type UserPreferences,
} from '@/types/schema.ts';
import {
  DeleteConfirmModal,
  type DeleteConfirmMode,
} from './components/DeleteConfirmModal.tsx';
import { FolderAssignModal } from './components/FolderAssignModal.tsx';
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
import {
  SettingsPanel,
  type VaultActionError,
} from './components/SettingsPanel.tsx';
import {
  SidebarTree,
  type MediaKindFilter,
  type PlatformFilter,
  type QuickNavView,
  type SidebarSyncStatus,
} from './components/SidebarTree.tsx';
import { getErrorMessage } from './utils/format.ts';

function toVaultActionError(
  prefix: string,
  error: unknown,
  fallbackDirName?: string,
): string | VaultActionError {
  if (error instanceof VaultDirectoryValidationError) {
    return {
      message: error.message,
      canRebind: true,
    };
  }
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

function isVaultSettingsHash(hash: string): boolean {
  return hash === '#settings=vault';
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
  const [isMigrating, setIsMigrating] = useState(false);
  const [migrationProgress, setMigrationProgress] =
    useState<MigrationProgress | null>(null);
  const [lastMigrationSummary, setLastMigrationSummary] =
    useState<MigrationSummary | null>(null);
  const [pendingMigrationConflict, setPendingMigrationConflict] = useState<{
    sourceHandle: FileSystemDirectoryHandle;
    targetHandle: FileSystemDirectoryHandle;
  } | null>(null);
  const [showRebuildSuggestion, setShowRebuildSuggestion] = useState(false);
  const [vaultError, setVaultError] = useState<
    string | VaultActionError | null
  >(null);

  const vaultBusyRef = useRef(false);
  const autoSyncTriggeredRef = useRef(false);
  const prefsHydratedRef = useRef(false);

  // 3. 视图筛选、设置页与详情抽屉状态
  const [activePage, setActivePage] = useState<'library' | 'settings'>(() =>
    isVaultSettingsHash(window.location.hash) ? 'settings' : 'library',
  );
  const [vaultSectionFocusTick, setVaultSectionFocusTick] = useState(() =>
    isVaultSettingsHash(window.location.hash) ? 1 : 0,
  );
  const [activeView, setActiveView] = useState<QuickNavView>('all');
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);
  const [mediaKindFilter, setMediaKindFilter] =
    useState<MediaKindFilter>('all');
  const [platformFilter, setPlatformFilter] = useState<PlatformFilter>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState<SortOption>('collectedAt');
  const [viewMode, setViewMode] = useState<ViewMode>('grid');
  const [selectedItemId, setSelectedItemId] = useState<string | null>(() =>
    parseItemIdFromHash(window.location.hash),
  );

  // 3b. 批量选择、统一删除弹窗与多文件夹分配弹窗状态
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedItemIds, setSelectedItemIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const lastSelectedAnchorRef = useRef<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<{
    items: CollectionItemRecord[];
    mode: DeleteConfirmMode;
  } | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [showFolderAssignModal, setShowFolderAssignModal] = useState(false);
  const [actionNotice, setActionNotice] = useState<{
    type: 'success' | 'warning' | 'error';
    text: string;
  } | null>(null);

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

  // 5. 监听 URL hash (#item=<id> 或 #settings=vault) 变化
  useEffect(() => {
    const clearHash = () => {
      window.history.replaceState(
        null,
        '',
        `${window.location.pathname}${window.location.search}`,
      );
    };

    if (isVaultSettingsHash(window.location.hash)) {
      clearHash();
    }

    const handleHashChange = () => {
      if (isVaultSettingsHash(window.location.hash)) {
        setActivePage('settings');
        setVaultSectionFocusTick((n) => n + 1);
        clearHash();
        return;
      }
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
      options?: { silentEmpty?: boolean; preserveOtherFeedback?: boolean },
    ) => {
      if (vaultBusyRef.current) {
        return;
      }
      vaultBusyRef.current = true;
      setIsFlushing(true);
      setVaultError(null);
      if (!options?.preserveOtherFeedback) {
        setLastRebuildSummary(null);
        setLastMigrationSummary(null);
      }
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
        setVaultError(
          toVaultActionError('同步到 CollectVault 失败', error, handle.name),
        );
      } finally {
        setIsFlushing(false);
        setFlushProgress(null);
        vaultBusyRef.current = false;
      }
    },
    [],
  );

  // 6b. 从本地 CollectVault 重建索引（供手动触发与首次绑定已初始化目录复用）
  const runRebuildIndex = useCallback(
    async (
      handle: FileSystemDirectoryHandle,
      options?: RebuildOptions & { preserveMigrationSummary?: boolean },
    ): Promise<boolean> => {
      if (vaultBusyRef.current) {
        return false;
      }
      vaultBusyRef.current = true;
      setIsRebuilding(true);
      setShowRebuildSuggestion(false);
      setVaultError(null);
      setLastFlushSummary(null);
      if (!options?.preserveMigrationSummary) {
        setLastMigrationSummary(null);
      }
      setRebuildProgress({ phase: 'scanning', scannedItems: 0 });

      try {
        const summary = await rebuildIndexFromVault(
          handle,
          (progress) => {
            setRebuildProgress(progress);
          },
          options?.preserveOpfsStaged !== undefined
            ? { preserveOpfsStaged: options.preserveOpfsStaged }
            : undefined,
        );
        setLastRebuildSummary(summary);
        return true;
      } catch (error) {
        setVaultError(`重建索引失败：${getErrorMessage(error)}`);
        return false;
      } finally {
        setIsRebuilding(false);
        setRebuildProgress(null);
        vaultBusyRef.current = false;
      }
    },
    [],
  );

  // 6c. 执行已绑定目录到新目录的文件迁移与索引对齐
  const executeVaultMigration = useCallback(
    async (
      sourceHandle: FileSystemDirectoryHandle,
      targetHandle: FileSystemDirectoryHandle,
      mode: VaultMigrationMode,
    ) => {
      if (vaultBusyRef.current) {
        return;
      }
      vaultBusyRef.current = true;
      setIsMigrating(true);
      setVaultError(null);
      setLastFlushSummary(null);
      setLastRebuildSummary(null);
      setLastMigrationSummary(null);
      setShowRebuildSuggestion(false);
      setMigrationProgress({ phase: 'preparing', current: 0, total: 0 });

      let migrationSucceeded = false;
      try {
        const summary = await migrateVaultDirectory(
          sourceHandle,
          targetHandle,
          mode,
          (progress) => {
            setMigrationProgress(progress);
          },
        );
        setVaultHandle(targetHandle);
        setPermissionState('granted');
        setLastMigrationSummary(summary);
        migrationSucceeded = true;
      } catch (error) {
        setVaultError(
          toVaultActionError('迁移本地同步目录失败', error, targetHandle.name),
        );
      } finally {
        setIsMigrating(false);
        setMigrationProgress(null);
        vaultBusyRef.current = false;
      }

      if (!migrationSucceeded) {
        return;
      }

      const [totalInDb, pendingCounts] = await Promise.all([
        db.items.count(),
        getVaultSyncPendingCounts(),
      ]);

      if (mode === 'merge' || totalInDb === 0) {
        await runRebuildIndex(targetHandle, {
          preserveOpfsStaged: true,
          preserveMigrationSummary: true,
        });
      }

      const afterRebuildPending =
        mode === 'merge' || totalInDb === 0
          ? await getVaultSyncPendingCounts()
          : pendingCounts;
      if (
        afterRebuildPending.stagedCount + afterRebuildPending.metaDirtyCount >
        0
      ) {
        await runFlushToVault(targetHandle, {
          silentEmpty: true,
          preserveOtherFeedback: true,
        });
      }
    },
    [runFlushToVault, runRebuildIndex],
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
          setVaultError(`读取本地目录状态失败：${getErrorMessage(error)}`);
        }
      }
    };

    void initVault();

    return () => {
      disposed = true;
    };
  }, [runFlushToVault]);

  // 8. 绑定/切换本地 CollectVault 目录（含磁盘根与非空校验、已初始化自动建索引及目录迁移）
  const handleBindVault = useCallback(async () => {
    if (vaultBusyRef.current) {
      return;
    }
    setVaultError(null);
    setLastFlushSummary(null);
    setLastRebuildSummary(null);
    setLastMigrationSummary(null);
    setPendingMigrationConflict(null);

    try {
      // 若当前已有绑定目录，切换前先确认原目录读写权限与存在性
      let sourceHandle: FileSystemDirectoryHandle | null = null;
      if (vaultHandle) {
        const granted = await requestVaultPermission(vaultHandle, 'readwrite');
        if (!granted) {
          setPermissionState(
            await queryVaultPermission(vaultHandle, 'readwrite'),
          );
          setVaultError(
            `切换目录前需要先授予原目录“${vaultHandle.name}”的读写权限以迁移旧文件，请授权后重试。`,
          );
          return;
        }
        setPermissionState('granted');
        const exists = await checkVaultDirectoryExists(vaultHandle);
        sourceHandle = exists ? vaultHandle : null;
      }

      const { handle: targetHandle, inspection } =
        await pickAndValidateVaultDirectory(sourceHandle);

      // 分支 A：首次绑定（或原目录已在外部被删除）
      if (!sourceHandle) {
        await finalizeVaultBinding(targetHandle);
        setVaultHandle(targetHandle);
        setPermissionState('granted');
        setShowRebuildSuggestion(false);

        if (inspection.kind === 'initialized_vault') {
          const rebuilt = await runRebuildIndex(targetHandle, {
            preserveOpfsStaged: true,
          });
          if (rebuilt) {
            const pendingCounts = await getVaultSyncPendingCounts();
            if (pendingCounts.stagedCount + pendingCounts.metaDirtyCount > 0) {
              await runFlushToVault(targetHandle, {
                silentEmpty: true,
                preserveOtherFeedback: true,
              });
            }
          }
        } else {
          const pendingCounts = await getVaultSyncPendingCounts();
          if (pendingCounts.stagedCount + pendingCounts.metaDirtyCount > 0) {
            await runFlushToVault(targetHandle);
          }
        }
        return;
      }

      // 分支 B：从已绑定目录切换到新目录
      if (inspection.kind === 'initialized_vault') {
        setPendingMigrationConflict({
          sourceHandle,
          targetHandle,
        });
        return;
      }

      await executeVaultMigration(sourceHandle, targetHandle, 'empty_target');
    } catch (error) {
      if (isAbortError(error)) {
        return;
      }
      setVaultError(toVaultActionError('绑定本地目录失败', error));
    }
  }, [vaultHandle, executeVaultMigration, runFlushToVault, runRebuildIndex]);

  const handleResolveMigrationConflict = useCallback(
    async (mode: 'overwrite' | 'merge') => {
      if (!pendingMigrationConflict) {
        return;
      }
      const { sourceHandle, targetHandle } = pendingMigrationConflict;
      setPendingMigrationConflict(null);
      await executeVaultMigration(sourceHandle, targetHandle, mode);
    },
    [pendingMigrationConflict, executeVaultMigration],
  );

  const handleCancelMigrationConflict = useCallback(() => {
    setPendingMigrationConflict(null);
  }, []);

  // 9. 请求已有目录权限并在授权后同步待落盘条目
  const handleRequestPermissionAndSync = useCallback(async (): Promise<boolean> => {
    setVaultError(null);

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
        setVaultError('未授予本地 CollectVault 目录的读写权限。');
        return false;
      }

      const pendingCounts = await getVaultSyncPendingCounts();
      if (pendingCounts.stagedCount + pendingCounts.metaDirtyCount > 0) {
        await runFlushToVault(vaultHandle);
      }
      return true;
    } catch (error) {
      if (!isAbortError(error)) {
        setVaultError(`请求本地目录权限失败：${getErrorMessage(error)}`);
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
      setVaultError('缺少本地目录写权限，无法执行同步。');
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
      setVaultError('缺少本地目录权限，无法重建索引。');
      return;
    }
    setPermissionState('granted');
    await runRebuildIndex(vaultHandle);
  }, [vaultHandle, runRebuildIndex]);

  // 12. 清空浏览器缓存索引（绝不删除硬盘文件与目录句柄）
  const handleClearBrowserCache = useCallback(async () => {
    if (vaultBusyRef.current) {
      return;
    }
    setVaultError(null);
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
      setActiveView('all');
      if (vaultHandle && permissionState === 'granted') {
        setShowRebuildSuggestion(true);
      }
    } catch (error) {
      setVaultError(`清空浏览器缓存索引失败：${getErrorMessage(error)}`);
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
      setVaultError(
        toVaultActionError('回写 taxonomy.json 失败', error, vaultHandle.name),
      );
    }
  }, [vaultHandle, permissionState]);

  const handleCreateFolder = useCallback(
    async (name: string, parentId: string | null): Promise<FolderNode> => {
      const created = await createFolder(name, parentId);
      await syncTaxonomyIfPermitted();
      return created;
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
          message:
            '分类已保存并更新 taxonomy.json，请在设置页点击「立即同步」将暂存媒体落盘',
        };
      }

      return {
        syncedToVault: false,
        message: '已保存到浏览器索引，授权 CollectVault 后可同步至硬盘',
      };
    },
    [vaultHandle, permissionState],
  );

  // 15. 软删除 / 彻底删除 / 恢复 / 批量分类（已授权且已落盘条目同步回写 meta.json）
  const syncItemMetasIfPermitted = useCallback(
    async (itemIds: readonly string[], includeTaxonomy = false) => {
      if (!vaultHandle || permissionState !== 'granted') {
        return;
      }
      try {
        if (includeTaxonomy) {
          await writeTaxonomyToVault(vaultHandle);
        }
        for (const itemId of itemIds) {
          const latest = await db.items.get(itemId);
          if (latest && latest.syncStatus === 'meta_dirty') {
            const synced: CollectionItemRecord = {
              ...latest,
              syncStatus: 'vault_synced',
            };
            await writeItemMetaToVault(vaultHandle, synced);
            await db.items.put(synced);
          }
        }
      } catch (error) {
        setVaultError(
          toVaultActionError('回写条目元数据失败', error, vaultHandle.name),
        );
      }
    },
    [vaultHandle, permissionState],
  );

  const handleRequestDeleteItems = useCallback(
    (targetItems: CollectionItemRecord[], mode: DeleteConfirmMode) => {
      if (targetItems.length === 0) {
        return;
      }
      setPendingDelete({ items: targetItems, mode });
    },
    [],
  );

  const handleConfirmDelete = useCallback(
    async (syncPlatformUncollect: boolean) => {
      if (!pendingDelete || isDeleting) {
        return;
      }
      const { items: targets, mode } = pendingDelete;
      const targetIds = targets.map((t) => t.id);
      const targetIdSet = new Set(targetIds);

      setIsDeleting(true);
      try {
        // 1. 先取消关联的进行中/排队下载任务，防止删后下载完成写回状态
        await sendToBackground({
          target: 'background',
          type: 'CANCEL_ITEM_DOWNLOAD_TASKS',
          itemIds: targetIds,
        }).catch(() => undefined);

        // 2. 若用户勾选了「同步取消账号的收藏」，先执行远程取消以决定彻底删除条目是否需要保留「不自动同步」记录
        const remoteOutcomeByKey = new Map<
          string,
          { ok: boolean; reason?: string }
        >();
        let remoteTransportError: string | null = null;

        if (syncPlatformUncollect) {
          const remoteRes = await sendToBackground({
            target: 'background',
            type: 'REMOTE_UNCOLLECT_ITEMS',
            items: targets.map((item) => ({
              platform: item.platform,
              sourceId: item.sourceId,
              ...(item.platformExtra !== undefined
                ? { platformExtra: item.platformExtra }
                : {}),
            })),
          }).catch((error: unknown) => ({
            ok: false as const,
            error: getErrorMessage(error),
          }));

          if (remoteRes && remoteRes.ok) {
            for (const entry of remoteRes.results) {
              remoteOutcomeByKey.set(`${entry.platform}:${entry.sourceId}`, {
                ok: entry.ok,
                ...(entry.reason !== undefined ? { reason: entry.reason } : {}),
              });
            }
          } else {
            remoteTransportError = remoteRes?.error ?? '通信失败';
          }
        }

        // 3. 执行本地删除（软删除 / 彻底删除：未取消原站收藏或取消失败时仅删媒体并转入「不自动同步」）
        let vaultDeleteErrors = 0;
        let fullyRemovedCount = 0;
        let excludedCount = 0;

        if (mode === 'soft') {
          await softDeleteItems(targetIds);
          await syncItemMetasIfPermitted(targetIds);
        } else {
          const fullyRemovedItems: CollectionItemRecord[] = [];
          const excludedSpecs: Array<{
            itemId: string;
            reason: 'deleted_keep_remote';
            detail: string;
          }> = [];

          for (const item of targets) {
            const key = `${item.platform}:${item.sourceId}`;
            const outcome = remoteOutcomeByKey.get(key);
            if (syncPlatformUncollect && outcome?.ok === true) {
              fullyRemovedItems.push(item);
            } else {
              const detail = syncPlatformUncollect
                ? `管理台已删除本地媒体，但取消原站收藏失败：${outcome?.reason ?? remoteTransportError ?? '未知原因'}`
                : '管理台彻底删除本地媒体，保留原平台账号收藏';
              excludedSpecs.push({
                itemId: item.id,
                reason: 'deleted_keep_remote',
                detail,
              });
            }
          }

          for (const item of targets) {
            await removeItemFromOpfs(item.id).catch(() => undefined);
          }

          if (fullyRemovedItems.length > 0) {
            if (vaultHandle && permissionState === 'granted') {
              for (const item of fullyRemovedItems) {
                try {
                  await removeItemDirFromVault(vaultHandle, item.relativeDir);
                } catch {
                  vaultDeleteErrors += 1;
                }
              }
            }
            await hardDeleteItemsFromDb(fullyRemovedItems.map((i) => i.id));
            fullyRemovedCount = fullyRemovedItems.length;
          }

          if (excludedSpecs.length > 0) {
            const updatedExcluded = await markItemsAutoSyncExcluded(excludedSpecs);
            excludedCount = updatedExcluded.length;

            if (vaultHandle && permissionState === 'granted') {
              for (const rec of updatedExcluded) {
                try {
                  await purgeItemMediaFilesFromVault(
                    vaultHandle,
                    rec.relativeDir,
                  );
                  const synced: CollectionItemRecord = {
                    ...rec,
                    syncStatus: 'vault_synced',
                  };
                  await writeItemMetaToVault(vaultHandle, synced);
                  await db.items.put(synced);
                } catch {
                  vaultDeleteErrors += 1;
                }
              }
            }
          }
        }

        // 若当前打开的详情抽屉对应条目已被删除或转入「不自动同步」，自动关闭抽屉
        if (selectedItemId && targetIdSet.has(selectedItemId)) {
          closeItemDrawer();
        }

        let remoteSummaryText = '';
        let noticeType: 'success' | 'warning' | 'error' =
          vaultDeleteErrors > 0 ? 'warning' : 'success';

        if (syncPlatformUncollect) {
          if (remoteTransportError !== null) {
            noticeType = 'warning';
            remoteSummaryText = `；原平台同步取消收藏未完成（${remoteTransportError}）`;
          } else {
            const outcomes = Array.from(remoteOutcomeByKey.values());
            const okCount = outcomes.filter((r) => r.ok).length;
            const failedList = outcomes.filter((r) => !r.ok);
            if (failedList.length === 0 && okCount > 0) {
              remoteSummaryText = `；已同步取消原平台账号收藏 ${okCount} 项`;
            } else if (failedList.length > 0) {
              noticeType = 'warning';
              const firstReason = failedList[0]?.reason ?? '未知原因';
              remoteSummaryText = `；原平台取消收藏成功 ${okCount} 项，失败 ${failedList.length} 项（${firstReason}）`;
            }
          }
        }

        let localActionLabel: string;
        if (mode === 'permanent') {
          if (excludedCount > 0 && fullyRemovedCount > 0) {
            localActionLabel = `已彻底清除 ${fullyRemovedCount} 项，另有 ${excludedCount} 项已删除本地媒体并转入「不自动同步」`;
          } else if (excludedCount > 0) {
            localActionLabel = `已删除 ${excludedCount} 项本地媒体并转入「不自动同步」（保留轻量元数据防止重复同步）`;
          } else {
            localActionLabel = `已彻底删除 ${fullyRemovedCount} 项收藏`;
          }
        } else {
          localActionLabel = `已将 ${targets.length} 项移入回收站`;
        }

        const vaultWarnText =
          vaultDeleteErrors > 0
            ? `（其中 ${vaultDeleteErrors} 项本地目录清理失败）`
            : '';

        setActionNotice({
          type: noticeType,
          text: `${localActionLabel}${vaultWarnText}${remoteSummaryText}`,
        });
        setPendingDelete(null);
        setSelectionMode(false);
        setSelectedItemIds(new Set());
        lastSelectedAnchorRef.current = null;
      } catch (error) {
        setActionNotice({
          type: 'error',
          text: `删除失败：${getErrorMessage(error)}`,
        });
      } finally {
        setIsDeleting(false);
      }
    },
    [
      pendingDelete,
      isDeleting,
      syncItemMetasIfPermitted,
      vaultHandle,
      permissionState,
      selectedItemId,
      closeItemDrawer,
    ],
  );

  const handleAllowAutoSyncAgain = useCallback(
    async (targets: CollectionItemRecord[]) => {
      if (targets.length === 0) {
        return;
      }
      let writableVault: FileSystemDirectoryHandle | null =
        vaultHandle && permissionState === 'granted' ? vaultHandle : null;

      if (
        !writableVault &&
        vaultHandle &&
        targets.some((item) => item.syncStatus === 'vault_synced')
      ) {
        const granted = await requestVaultPermission(vaultHandle, 'readwrite');
        setPermissionState(
          granted
            ? 'granted'
            : await queryVaultPermission(vaultHandle, 'readwrite'),
        );
        if (!granted) {
          setActionNotice({
            type: 'warning',
            text: '需要授权本地 CollectVault 写权限以清理磁盘上的忽略元数据文件，请授权后重试。',
          });
          return;
        }
        writableVault = vaultHandle;
      }

      const targetIds = targets.map((t) => t.id);
      const targetIdSet = new Set(targetIds);
      let vaultRemoveErrors = 0;

      for (const item of targets) {
        await removeItemFromOpfs(item.id).catch(() => undefined);
        if (writableVault) {
          try {
            await removeItemDirFromVault(writableVault, item.relativeDir);
          } catch {
            vaultRemoveErrors += 1;
          }
        }
      }

      await hardDeleteItemsFromDb(targetIds);
      if (selectedItemId && targetIdSet.has(selectedItemId)) {
        closeItemDrawer();
      }
      setSelectionMode(false);
      setSelectedItemIds(new Set());
      lastSelectedAnchorRef.current = null;
      setActionNotice({
        type: vaultRemoveErrors > 0 ? 'warning' : 'success',
        text:
          vaultRemoveErrors > 0
            ? `已移除 ${targets.length} 项不自动同步限制（其中 ${vaultRemoveErrors} 项本地目录清理失败）`
            : `已移除 ${targets.length} 项「不自动同步」限制，下次同步或重新采集时将正常入库`,
      });
    },
    [vaultHandle, permissionState, selectedItemId, closeItemDrawer],
  );

  const handleRemoteUncollectAndClear = useCallback(
    async (targets: CollectionItemRecord[]) => {
      if (targets.length === 0) {
        return;
      }
      const remoteRes = await sendToBackground({
        target: 'background',
        type: 'REMOTE_UNCOLLECT_ITEMS',
        items: targets.map((item) => ({
          platform: item.platform,
          sourceId: item.sourceId,
          ...(item.platformExtra !== undefined
            ? { platformExtra: item.platformExtra }
            : {}),
        })),
      }).catch((error: unknown) => ({
        ok: false as const,
        error: getErrorMessage(error),
      }));

      if (!remoteRes || !remoteRes.ok) {
        setActionNotice({
          type: 'warning',
          text: `取消原站收藏失败：${remoteRes?.error ?? '通信失败'}，已保留「不自动同步」记录。`,
        });
        return;
      }

      const outcomeByKey = new Map<string, { ok: boolean; reason?: string }>();
      for (const entry of remoteRes.results) {
        outcomeByKey.set(`${entry.platform}:${entry.sourceId}`, {
          ok: entry.ok,
          ...(entry.reason !== undefined ? { reason: entry.reason } : {}),
        });
      }

      const succeeded: CollectionItemRecord[] = [];
      const failedSpecs: Array<{
        itemId: string;
        reason: AutoSyncExclusionReason;
        detail: string;
      }> = [];

      for (const item of targets) {
        const outcome = outcomeByKey.get(`${item.platform}:${item.sourceId}`);
        if (outcome?.ok) {
          succeeded.push(item);
        } else {
          failedSpecs.push({
            itemId: item.id,
            reason: item.autoSyncExclusion?.reason ?? 'deleted_keep_remote',
            detail: `取消原站收藏失败：${outcome?.reason ?? '未知原因'}`,
          });
        }
      }

      if (succeeded.length > 0) {
        const succeededIds = succeeded.map((i) => i.id);
        const succeededIdSet = new Set(succeededIds);
        for (const item of succeeded) {
          await removeItemFromOpfs(item.id).catch(() => undefined);
          if (vaultHandle && permissionState === 'granted') {
            await removeItemDirFromVault(vaultHandle, item.relativeDir).catch(
              () => undefined,
            );
          }
        }
        await hardDeleteItemsFromDb(succeededIds);
        if (selectedItemId && succeededIdSet.has(selectedItemId)) {
          closeItemDrawer();
        }
      }

      if (failedSpecs.length > 0) {
        const updatedFailed = await markItemsAutoSyncExcluded(failedSpecs);
        if (vaultHandle && permissionState === 'granted') {
          for (const rec of updatedFailed) {
            const synced: CollectionItemRecord = {
              ...rec,
              syncStatus: 'vault_synced',
            };
            await writeItemMetaToVault(vaultHandle, synced).catch(
              () => undefined,
            );
            await db.items.put(synced);
          }
        }
      }

      setSelectionMode(false);
      setSelectedItemIds(new Set());
      lastSelectedAnchorRef.current = null;
      setActionNotice({
        type: failedSpecs.length > 0 ? 'warning' : 'success',
        text:
          failedSpecs.length === 0
            ? `已同步取消原站收藏并彻底清除 ${succeeded.length} 项记录`
            : `已取消原站收藏并清除 ${succeeded.length} 项，另有 ${failedSpecs.length} 项取消失败已继续保留在「不自动同步」`,
      });
    },
    [vaultHandle, permissionState, selectedItemId, closeItemDrawer],
  );

  const handleCancelItemSync = useCallback(
    async (item: CollectionItemRecord) => {
      const relatedTasks = await db.tasks
        .where('itemId')
        .equals(item.id)
        .toArray();
      const activeTask = relatedTasks.find(
        (task) =>
          task.status === 'queued' ||
          task.status === 'downloading' ||
          task.status === 'processing',
      );

      if (activeTask) {
        await sendToBackground({
          target: 'background',
          type: 'CANCEL_DOWNLOAD_TASK',
          taskId: activeTask.id,
        }).catch(() => undefined);
      }

      const latest = await db.items.get(item.id);
      if (latest && !isAutoSyncExcluded(latest)) {
        await removeItemFromOpfs(item.id).catch(() => undefined);
        await markItemsAutoSyncExcluded([
          {
            itemId: item.id,
            reason: 'sync_cancelled_by_user',
            detail: '下载同步过程中已手动取消同步到插件',
          },
        ]);
      }

      if (vaultHandle && permissionState === 'granted') {
        const updated = await db.items.get(item.id);
        if (updated && isAutoSyncExcluded(updated)) {
          await purgeItemMediaFilesFromVault(
            vaultHandle,
            updated.relativeDir,
          ).catch(() => undefined);
          const synced: CollectionItemRecord = {
            ...updated,
            syncStatus: 'vault_synced',
          };
          await writeItemMetaToVault(vaultHandle, synced).catch(
            () => undefined,
          );
          await db.items.put(synced);
        }
      }

      if (selectedItemId === item.id) {
        closeItemDrawer();
      }
      setActionNotice({
        type: 'success',
        text: `已取消「${item.title}」同步到插件，并移入「不自动同步」列表`,
      });
    },
    [vaultHandle, permissionState, selectedItemId, closeItemDrawer],
  );

  const handleRestoreItem = useCallback(
    async (item: CollectionItemRecord) => {
      await restoreItem(item.id);
      await syncItemMetasIfPermitted([item.id]);
    },
    [syncItemMetasIfPermitted],
  );

  const handleBatchRestoreItems = useCallback(
    async (targets: CollectionItemRecord[]) => {
      if (targets.length === 0) {
        return;
      }
      const ids = targets.map((t) => t.id);
      await restoreItems(ids);
      await syncItemMetasIfPermitted(ids);
      setSelectedItemIds(new Set());
      setActionNotice({
        type: 'success',
        text: `已从回收站恢复 ${targets.length} 项收藏`,
      });
    },
    [syncItemMetasIfPermitted],
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
      const isExcluded = isAutoSyncExcluded(item);

      if (selectedFolderId !== null) {
        if (isDeleted || isExcluded) {
          return false;
        }
        const itemFolderIds = getItemFolderIds(item);
        if (
          itemFolderIds.length === 0 ||
          !itemFolderIds.some((fid) => allowedFolderIds?.has(fid))
        ) {
          return false;
        }
      } else {
        switch (activeView) {
          case 'all':
            if (isDeleted || isExcluded) {
              return false;
            }
            break;
          case 'uncategorized':
            if (isDeleted || isExcluded || getItemFolderIds(item).length > 0) {
              return false;
            }
            break;
          case 'pending_sync':
            if (
              isDeleted ||
              isExcluded ||
              (item.syncStatus !== 'opfs_staged' &&
                item.syncStatus !== 'meta_dirty')
            ) {
              return false;
            }
            break;
          case 'excluded':
            if (!isExcluded) {
              return false;
            }
            break;
          case 'trash':
            if (!isDeleted || isExcluded) {
              return false;
            }
            break;
        }
      }

      if (mediaKindFilter === 'video' && item.kind !== 'video') {
        return false;
      }
      if (
        mediaKindFilter === 'image_text' &&
        item.kind !== 'gallery' &&
        item.kind !== 'image' &&
        item.kind !== 'article'
      ) {
        return false;
      }

      if (platformFilter !== 'all' && item.platform !== platformFilter) {
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
      case 'excluded':
        return '不自动同步';
      case 'trash':
        return '回收站';
    }
  }, [selectedFolderId, foldersById, activeView]);

  const hasActiveFilters =
    searchQuery.trim().length > 0 ||
    mediaKindFilter !== 'all' ||
    platformFilter !== 'all' ||
    selectedFolderId !== null ||
    activeView === 'uncategorized' ||
    activeView === 'pending_sync';

  const handleResetFilters = useCallback(() => {
    setSearchQuery('');
    setMediaKindFilter('all');
    setPlatformFilter('all');
    setSelectedFolderId(null);
    if (activeView !== 'trash' && activeView !== 'excluded') {
      setActiveView('all');
    }
  }, [activeView]);

  const activeItemCount = useMemo(
    () =>
      items.filter((item) => item.deletedAt == null && !isAutoSyncExcluded(item))
        .length,
    [items],
  );

  const sidebarSyncStatus: SidebarSyncStatus =
    vaultHandle !== null &&
    permissionState === 'granted' &&
    vaultError === null &&
    !(lastFlushSummary !== null && lastFlushSummary.failedCount > 0)
      ? 'syncing'
      : 'failed';

  const handleOpenVaultSettings = useCallback(() => {
    setActivePage('settings');
    setVaultSectionFocusTick((n) => n + 1);
  }, []);

  // 17. 批量选择交互、安全裁剪与批量文件夹操作
  const exitSelectionMode = useCallback(() => {
    setSelectionMode(false);
    setSelectedItemIds(new Set());
    lastSelectedAnchorRef.current = null;
  }, []);

  // 切换主视图/文件夹/设置页时退出批量选择并清空选中项，避免误操作不可见条目
  useEffect(() => {
    setSelectionMode(false);
    setSelectedItemIds(new Set());
    lastSelectedAnchorRef.current = null;
  }, [activeView, selectedFolderId, activePage]);

  // 筛选结果变化时自动裁剪不在当前视图的选中 ID
  useEffect(() => {
    setSelectedItemIds((prev) => {
      if (prev.size === 0) {
        return prev;
      }
      const visibleIds = new Set(filteredItems.map((item) => item.id));
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (visibleIds.has(id)) {
          next.add(id);
        } else {
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [filteredItems]);

  // 批量选择模式下按 Esc 退出（无弹窗/详情抽屉打开时）
  useEffect(() => {
    if (
      !selectionMode ||
      pendingDelete !== null ||
      showFolderAssignModal ||
      selectedItem !== null
    ) {
      return;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        exitSelectionMode();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    selectionMode,
    pendingDelete,
    showFolderAssignModal,
    selectedItem,
    exitSelectionMode,
  ]);

  const handleToggleSelectionMode = useCallback(() => {
    if (selectionMode) {
      exitSelectionMode();
    } else {
      setSelectionMode(true);
    }
  }, [selectionMode, exitSelectionMode]);

  const handleToggleSelectItem = useCallback(
    (itemId: string, shiftKey: boolean) => {
      if (!selectionMode) {
        setSelectionMode(true);
      }

      if (shiftKey && lastSelectedAnchorRef.current) {
        const orderedIds = filteredItems.map((item) => item.id);
        const startIdx = orderedIds.indexOf(lastSelectedAnchorRef.current);
        const endIdx = orderedIds.indexOf(itemId);
        if (startIdx !== -1 && endIdx !== -1) {
          const [from, to] =
            startIdx <= endIdx ? [startIdx, endIdx] : [endIdx, startIdx];
          setSelectedItemIds((prev) => {
            const next = new Set(prev);
            for (let i = from; i <= to; i += 1) {
              const id = orderedIds[i];
              if (id) {
                next.add(id);
              }
            }
            return next;
          });
          lastSelectedAnchorRef.current = itemId;
          return;
        }
      }

      setSelectedItemIds((prev) => {
        const next = new Set(prev);
        if (next.has(itemId)) {
          next.delete(itemId);
        } else {
          next.add(itemId);
        }
        return next;
      });
      lastSelectedAnchorRef.current = itemId;
    },
    [selectionMode, filteredItems],
  );

  const handleSelectAllVisible = useCallback(() => {
    setSelectedItemIds(new Set(filteredItems.map((item) => item.id)));
  }, [filteredItems]);

  const handleClearSelection = useCallback(() => {
    setSelectedItemIds(new Set());
    lastSelectedAnchorRef.current = null;
  }, []);

  const selectedVisibleItems = useMemo(
    () => filteredItems.filter((item) => selectedItemIds.has(item.id)),
    [filteredItems, selectedItemIds],
  );

  const handleBatchAddToFolders = useCallback(
    async (targetFolderIds: string[]) => {
      const itemIds = selectedVisibleItems.map((item) => item.id);
      if (itemIds.length === 0 || targetFolderIds.length === 0) {
        setShowFolderAssignModal(false);
        return;
      }

      const updated = await addItemsToFolders(itemIds, targetFolderIds);
      if (updated.length > 0) {
        await syncItemMetasIfPermitted(
          updated.map((u) => u.id),
          true,
        );
      }

      const folderNames = targetFolderIds
        .map((fid) => foldersById.get(fid)?.name)
        .filter((name): name is string => Boolean(name));
      setShowFolderAssignModal(false);
      exitSelectionMode();
      setActionNotice({
        type: 'success',
        text: `已将 ${itemIds.length} 项加入文件夹：${folderNames.join('、')}`,
      });
    },
    [
      selectedVisibleItems,
      syncItemMetasIfPermitted,
      foldersById,
      exitSelectionMode,
    ],
  );

  const handleBatchRemoveFromCurrentFolder = useCallback(async () => {
    if (selectedFolderId === null || selectedVisibleItems.length === 0) {
      return;
    }
    const itemIds = selectedVisibleItems.map((item) => item.id);
    const updated = await removeItemsFromFolder(itemIds, selectedFolderId);
    if (updated.length > 0) {
      await syncItemMetasIfPermitted(updated.map((u) => u.id));
    }
    const folderName = foldersById.get(selectedFolderId)?.name ?? '当前文件夹';
    setSelectedItemIds(new Set());
    setActionNotice({
      type: 'success',
      text: `已将 ${updated.length} 项从「${folderName}」移出`,
    });
  }, [
    selectedFolderId,
    selectedVisibleItems,
    syncItemMetasIfPermitted,
    foldersById,
  ]);

  return (
    <div className="flex h-screen overflow-hidden bg-slate-50 text-slate-900">
      {/* 左侧导航与多级文件夹分类树 */}
      <SidebarTree
        items={items}
        folders={folders}
        activeView={activeView}
        selectedFolderId={selectedFolderId}
        mediaKindFilter={mediaKindFilter}
        platformFilter={platformFilter}
        isSettingsOpen={activePage === 'settings'}
        syncStatus={sidebarSyncStatus}
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
        onOpenSettings={() => {
          setActivePage('settings');
        }}
        onOpenVaultSettings={handleOpenVaultSettings}
        onCreateFolder={handleCreateFolder}
        onRenameFolder={handleRenameFolder}
        onDeleteFolder={handleDeleteFolder}
      />

      {/* 右侧主工作区 */}
      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
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

        {/* 批量操作 / 删除同步结果轻提示条 */}
        {actionNotice && (
          <div
            data-testid="library-action-notice"
            className={`flex items-center justify-between gap-2 border-b px-6 py-2 text-xs ${
              actionNotice.type === 'success'
                ? 'border-emerald-200 bg-emerald-50/90 text-emerald-800'
                : actionNotice.type === 'warning'
                  ? 'border-amber-200 bg-amber-50/90 text-amber-900'
                  : 'border-rose-200 bg-rose-50/90 text-rose-800'
            }`}
          >
            <div className="flex min-w-0 items-center gap-2">
              {actionNotice.type === 'success' ? (
                <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-600" />
              ) : (
                <AlertCircle className="h-3.5 w-3.5 shrink-0" />
              )}
              <span className="truncate font-medium">{actionNotice.text}</span>
            </div>
            <button
              type="button"
              onClick={() => setActionNotice(null)}
              aria-label="关闭提示"
              className="rounded p-0.5 opacity-70 transition hover:opacity-100"
            >
              <X className="h-3.5 w-3.5" />
            </button>
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
            flushProgress={flushProgress}
            lastFlushSummary={lastFlushSummary}
            isRebuilding={isRebuilding}
            rebuildProgress={rebuildProgress}
            lastRebuildSummary={lastRebuildSummary}
            isMigrating={isMigrating}
            migrationProgress={migrationProgress}
            lastMigrationSummary={lastMigrationSummary}
            pendingMigrationConflict={
              pendingMigrationConflict
                ? {
                    sourceName:
                      pendingMigrationConflict.sourceHandle.name || '原目录',
                    targetName:
                      pendingMigrationConflict.targetHandle.name || '新目录',
                  }
                : null
            }
            showRebuildSuggestion={showRebuildSuggestion}
            vaultError={vaultError}
            focusVaultSectionTick={vaultSectionFocusTick}
            onUpdatePreferences={handleUpdatePreferences}
            onBindVault={handleBindVault}
            onResolveMigrationConflict={handleResolveMigrationConflict}
            onCancelMigrationConflict={handleCancelMigrationConflict}
            onRequestPermissionAndSync={async () => {
              await handleRequestPermissionAndSync();
            }}
            onFlushToVault={handleManualFlush}
            onRebuildIndex={handleRebuildIndex}
            onClearBrowserCache={handleClearBrowserCache}
            onDismissSuggestion={() => setShowRebuildSuggestion(false)}
            onDismissFeedback={() => {
              setLastFlushSummary(null);
              setLastRebuildSummary(null);
              setLastMigrationSummary(null);
              setVaultError(null);
            }}
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
            isExcludedView={
              selectedFolderId === null && activeView === 'excluded'
            }
            currentFolderId={selectedFolderId}
            hasActiveFilters={hasActiveFilters}
            contextTitle={contextTitle}
            selectionMode={selectionMode}
            selectedIds={selectedItemIds}
            onSearchChange={setSearchQuery}
            onSortChange={setSortBy}
            onViewModeChange={setViewMode}
            onResetFilters={handleResetFilters}
            onOpenItem={openItemDrawer}
            onToggleSelectionMode={handleToggleSelectionMode}
            onToggleSelectItem={handleToggleSelectItem}
            onSelectAllVisible={handleSelectAllVisible}
            onClearSelection={handleClearSelection}
            onOpenBatchFolderModal={() => setShowFolderAssignModal(true)}
            onBatchRemoveFromCurrentFolder={handleBatchRemoveFromCurrentFolder}
            onRequestDeleteItems={handleRequestDeleteItems}
            onBatchRestoreItems={handleBatchRestoreItems}
            onRestoreItem={handleRestoreItem}
            onAllowAutoSyncAgain={handleAllowAutoSyncAgain}
            onRemoteUncollectAndClear={handleRemoteUncollectAndClear}
            onCancelItemSync={handleCancelItemSync}
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
          disableEscapeClose={pendingDelete !== null}
          onClose={closeItemDrawer}
          onRequestVaultAccess={handleRequestPermissionAndSync}
          onSaveItem={handleSaveItem}
          onRequestDeleteItem={(item, mode) =>
            handleRequestDeleteItems([item], mode)
          }
          onRestoreItem={handleRestoreItem}
          onAllowAutoSyncAgain={handleAllowAutoSyncAgain}
          onRemoteUncollectAndClear={handleRemoteUncollectAndClear}
          onCancelItemSync={handleCancelItemSync}
        />
      )}

      {/* 统一删除二次确认弹窗（含同步取消账号收藏勾选框，默认勾选） */}
      {pendingDelete && (
        <DeleteConfirmModal
          items={pendingDelete.items}
          mode={pendingDelete.mode}
          submitting={isDeleting}
          onCancel={() => !isDeleting && setPendingDelete(null)}
          onConfirm={handleConfirmDelete}
        />
      )}

      {/* 批量加入分类文件夹弹窗（支持多选） */}
      {showFolderAssignModal && (
        <FolderAssignModal
          selectedItems={selectedVisibleItems}
          folders={folders}
          onClose={() => setShowFolderAssignModal(false)}
          onCreateFolder={handleCreateFolder}
          onConfirm={handleBatchAddToFolders}
        />
      )}
    </div>
  );
}
