import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { AlertCircle, CheckCircle2, Download, X } from 'lucide-react';
import { i18n, useI18nLocale } from '@/i18n/index.ts';
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
  markItemOpened,
  markItemsAutoSyncExcluded,
  removeItemsFromFolder,
  renameFolder,
  restoreItem,
  restoreItems,
  softDeleteItems,
  updateFolderAutoRule,
  updateItemClassification,
  updateUserPreferences,
} from '@/storage/db.ts';
import { removeItemFromOpfs } from '@/storage/opfs.ts';
import {
  connectCloudflareR2,
  disconnectCloudflareR2,
  formatR2TargetLabel,
  type ConnectCloudflareR2Input,
} from '@/storage/providers/cloudflare-r2/index.ts';
import {
  connectGoogleDrive,
  disconnectGoogleDrive,
  type ConnectGoogleDriveInput,
} from '@/storage/providers/google-drive/index.ts';
import { createLocalFsVaultBackend } from '@/storage/providers/local-fs/index.ts';
import {
  getActiveVaultProviderId,
  getVaultProvider,
  setActiveVaultProviderId,
} from '@/storage/providers/registry.ts';
import { sendToBackground } from '@/types/messages.ts';
import { CollectionSearchEngine } from '@/storage/search.ts';
import {
  checkVaultDirectoryExists,
  ensureVaultStructure,
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
  type VaultProviderId,
  type VaultStorageBackend,
} from '@/storage/vault.ts';
import {
  getItemFolderIds,
  isAutoSyncExcluded,
  isNsfwItem,
  type AutoSyncExclusionReason,
  type CollectionItemRecord,
  type FolderAutoRule,
  type FolderNode,
  type TagMeta,
  type UserPreferences,
} from '@/types/schema.ts';
import {
  DeleteConfirmModal,
  type DeleteConfirmMode,
} from './components/DeleteConfirmModal.tsx';
import { FolderAssignModal } from './components/FolderAssignModal.tsx';
import { FolderRuleModal } from './components/FolderRuleModal.tsx';
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
      helpLabel: i18n.t('settings.viewPermissionHelp'),
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
  const uiLanguage = useI18nLocale();

  useEffect(() => {
    document.title = i18n.t('library.pageTitle');
  }, [uiLanguage]);

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

  // 2. 插件化 Vault 后端状态（本地目录句柄 + 统一 VaultStorageBackend）与同步/重建状态
  const [activeProviderId, setActiveProviderId] =
    useState<VaultProviderId>('local_fs');
  const [vaultBackend, setVaultBackend] = useState<VaultStorageBackend | null>(
    null,
  );
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
  const [editingRuleFolder, setEditingRuleFolder] = useState<FolderNode | null>(
    null,
  );
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

  // 6. 执行 OPFS -> CollectVault 同步落盘（通用支持本地目录与云存储后端）
  const runFlushToVault = useCallback(
    async (
      target: VaultStorageBackend | FileSystemDirectoryHandle,
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
      const targetName =
        'displayName' in target ? target.displayName : target.name;

      try {
        const summary = await flushToVault(target, (progress) => {
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
          toVaultActionError(
            i18n.t('library.syncVaultFailedPrefix'),
            error,
            targetName,
          ),
        );
      } finally {
        setIsFlushing(false);
        setFlushProgress(null);
        vaultBusyRef.current = false;
      }
    },
    [],
  );

  // 6b. 从 CollectVault（本地或云端）重建索引
  const runRebuildIndex = useCallback(
    async (
      target: VaultStorageBackend | FileSystemDirectoryHandle,
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
          target,
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
        setVaultError(
          i18n.t('library.rebuildIndexFailed', {
            error: getErrorMessage(error),
          }),
        );
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
        setVaultBackend(createLocalFsVaultBackend(targetHandle));
        setPermissionState('granted');
        setLastMigrationSummary(summary);
        migrationSucceeded = true;
      } catch (error) {
        setVaultError(
          toVaultActionError(
            i18n.t('library.migrateVaultFailedPrefix'),
            error,
            targetHandle.name,
          ),
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

  // 7. 加载当前启用的持久化插件状态并按偏好自动静默同步
  const hydrateVaultProviderState = useCallback(
    async (providerId: VaultProviderId, allowAutoSync: boolean) => {
      const provider = getVaultProvider(providerId);
      const [connectionState, backend, savedLocalHandle] = await Promise.all([
        provider.getConnectionState(),
        provider.getBackend(),
        getSavedVaultHandle(),
      ]);

      setActiveProviderId(providerId);
      setVaultHandle(savedLocalHandle);
      setVaultBackend(backend);
      setPermissionState(
        connectionState.configured ? connectionState.permission : 'unbound',
      );

      if (
        allowAutoSync &&
        backend &&
        connectionState.permission === 'granted' &&
        !autoSyncTriggeredRef.current
      ) {
        const [prefs, pendingCounts] = await Promise.all([
          getUserPreferences(),
          getVaultSyncPendingCounts(),
        ]);
        if (
          prefs.autoSyncOnLibraryOpen &&
          pendingCounts.stagedCount + pendingCounts.metaDirtyCount > 0
        ) {
          autoSyncTriggeredRef.current = true;
          await runFlushToVault(backend, { silentEmpty: true });
        }
      }
    },
    [runFlushToVault],
  );

  useEffect(() => {
    let disposed = false;

    const initVault = async () => {
      try {
        const providerId = await getActiveVaultProviderId();
        if (disposed) {
          return;
        }
        await hydrateVaultProviderState(providerId, true);
      } catch (error) {
        if (!disposed) {
          setVaultError(
            i18n.t('library.readVaultStatusFailed', {
              error: getErrorMessage(error),
            }),
          );
        }
      }
    };

    void initVault();

    return () => {
      disposed = true;
    };
  }, [hydrateVaultProviderState]);

  // 7b. 切换持久化存储插件（如本地目录 <-> Google Drive，后续可扩展 WebDAV / S3 等）
  const handleSelectVaultProvider = useCallback(
    async (nextProviderId: VaultProviderId) => {
      if (vaultBusyRef.current) {
        return;
      }
      setVaultError(null);
      setLastFlushSummary(null);
      setLastRebuildSummary(null);
      setLastMigrationSummary(null);
      setShowRebuildSuggestion(false);
      await setActiveVaultProviderId(nextProviderId);
      await hydrateVaultProviderState(nextProviderId, false);
    },
    [hydrateVaultProviderState],
  );

  // 7c. 连接 / 断开 Google Drive 独立云存储插件
  const handleConnectGoogleDrive = useCallback(
    async (input: ConnectGoogleDriveInput) => {
      if (vaultBusyRef.current) {
        return;
      }
      setVaultError(null);
      setLastFlushSummary(null);
      setLastRebuildSummary(null);
      setLastMigrationSummary(null);
      setShowRebuildSuggestion(false);

      try {
        const { backend, config } = await connectGoogleDrive(input);
        await setActiveVaultProviderId('google_drive');
        const { isExistingVault } = await ensureVaultStructure(backend);

        setActiveProviderId('google_drive');
        setVaultBackend(backend);
        setPermissionState('granted');
        setActionNotice({
          type: 'success',
          text: i18n.t('settings.gdriveConnectedNotice', {
            folder: config.rootFolderName,
          }),
        });

        const [totalInDb, pendingCounts] = await Promise.all([
          db.items.count(),
          getVaultSyncPendingCounts(),
        ]);

        if (isExistingVault && totalInDb === 0) {
          const rebuilt = await runRebuildIndex(backend, {
            preserveOpfsStaged: true,
          });
          if (rebuilt) {
            const afterPending = await getVaultSyncPendingCounts();
            if (afterPending.stagedCount + afterPending.metaDirtyCount > 0) {
              await runFlushToVault(backend, {
                silentEmpty: true,
                preserveOtherFeedback: true,
              });
            }
          }
        } else if (
          pendingCounts.stagedCount + pendingCounts.metaDirtyCount > 0
        ) {
          await runFlushToVault(backend);
        }
      } catch (error) {
        setVaultError(
          `${i18n.t('settings.gdriveConnectFailedPrefix')}：${getErrorMessage(error)}`,
        );
      }
    },
    [runFlushToVault, runRebuildIndex],
  );

  const handleDisconnectGoogleDrive = useCallback(async () => {
    if (vaultBusyRef.current) {
      return;
    }
    setVaultError(null);
    setLastFlushSummary(null);
    setLastRebuildSummary(null);
    setShowRebuildSuggestion(false);

    try {
      await disconnectGoogleDrive();
      await hydrateVaultProviderState('google_drive', false);
      setActionNotice({
        type: 'success',
        text: i18n.t('settings.gdriveDisconnectedNotice'),
      });
    } catch (error) {
      setVaultError(
        `${i18n.t('settings.gdriveDisconnectFailedPrefix')}：${getErrorMessage(error)}`,
      );
    }
  }, [hydrateVaultProviderState]);

  // 7d. 连接 / 断开 Cloudflare R2 独立对象存储插件
  const handleConnectCloudflareR2 = useCallback(
    async (input: ConnectCloudflareR2Input) => {
      if (vaultBusyRef.current) {
        return;
      }
      setVaultError(null);
      setLastFlushSummary(null);
      setLastRebuildSummary(null);
      setLastMigrationSummary(null);
      setShowRebuildSuggestion(false);

      try {
        const { backend, config } = await connectCloudflareR2(input);
        await setActiveVaultProviderId('cloudflare_r2');
        const { isExistingVault } = await ensureVaultStructure(backend);

        setActiveProviderId('cloudflare_r2');
        setVaultBackend(backend);
        setPermissionState('granted');
        setActionNotice({
          type: 'success',
          text: i18n.t('settings.r2ConnectedNotice', {
            target: formatR2TargetLabel(config),
          }),
        });

        const [totalInDb, pendingCounts] = await Promise.all([
          db.items.count(),
          getVaultSyncPendingCounts(),
        ]);

        if (isExistingVault && totalInDb === 0) {
          const rebuilt = await runRebuildIndex(backend, {
            preserveOpfsStaged: true,
          });
          if (rebuilt) {
            const afterPending = await getVaultSyncPendingCounts();
            if (afterPending.stagedCount + afterPending.metaDirtyCount > 0) {
              await runFlushToVault(backend, {
                silentEmpty: true,
                preserveOtherFeedback: true,
              });
            }
          }
        } else if (
          pendingCounts.stagedCount + pendingCounts.metaDirtyCount > 0
        ) {
          await runFlushToVault(backend);
        }
      } catch (error) {
        setVaultError(
          `${i18n.t('settings.r2ConnectFailedPrefix')}：${getErrorMessage(error)}`,
        );
      }
    },
    [runFlushToVault, runRebuildIndex],
  );

  const handleDisconnectCloudflareR2 = useCallback(async () => {
    if (vaultBusyRef.current) {
      return;
    }
    setVaultError(null);
    setLastFlushSummary(null);
    setLastRebuildSummary(null);
    setShowRebuildSuggestion(false);

    try {
      await disconnectCloudflareR2();
      await hydrateVaultProviderState('cloudflare_r2', false);
      setActionNotice({
        type: 'success',
        text: i18n.t('settings.r2DisconnectedNotice'),
      });
    } catch (error) {
      setVaultError(
        `${i18n.t('settings.r2DisconnectFailedPrefix')}：${getErrorMessage(error)}`,
      );
    }
  }, [hydrateVaultProviderState]);

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
            i18n.t('library.switchVaultNeedSourcePerm', {
              name: vaultHandle.name,
            }),
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
        await setActiveVaultProviderId('local_fs');
        setActiveProviderId('local_fs');
        setVaultHandle(targetHandle);
        setVaultBackend(createLocalFsVaultBackend(targetHandle));
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
      setVaultError(
        toVaultActionError(i18n.t('library.bindVaultFailedPrefix'), error),
      );
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

  // 9. 请求当前持久化目标权限并在授权后同步待落盘条目
  const handleRequestPermissionAndSync = useCallback(async (): Promise<boolean> => {
    setVaultError(null);

    if (!vaultBackend) {
      if (activeProviderId === 'local_fs') {
        await handleBindVault();
        const updatedHandle = await getSavedVaultHandle();
        if (!updatedHandle) {
          return false;
        }
        const perm = await queryVaultPermission(updatedHandle, 'readwrite');
        return perm === 'granted';
      }
      setActivePage('settings');
      setVaultSectionFocusTick((n) => n + 1);
      return false;
    }

    try {
      const granted = await vaultBackend.requestPermission('readwrite');
      const nextPerm: VaultPermissionStatus = granted
        ? 'granted'
        : await vaultBackend.queryPermission('readwrite');
      setPermissionState(nextPerm);

      if (!granted) {
        setVaultError(i18n.t('library.vaultPermDenied'));
        return false;
      }

      const pendingCounts = await getVaultSyncPendingCounts();
      if (pendingCounts.stagedCount + pendingCounts.metaDirtyCount > 0) {
        await runFlushToVault(vaultBackend);
      }
      return true;
    } catch (error) {
      if (!isAbortError(error)) {
        setVaultError(
          i18n.t('library.requestVaultPermFailed', {
            error: getErrorMessage(error),
          }),
        );
      }
      return false;
    }
  }, [vaultBackend, activeProviderId, handleBindVault, runFlushToVault]);

  // 10. 手动触发同步到当前 CollectVault（本地或云端）
  const handleManualFlush = useCallback(async () => {
    if (!vaultBackend) {
      return;
    }
    const granted = await vaultBackend.requestPermission('readwrite');
    if (!granted) {
      setPermissionState(await vaultBackend.queryPermission('readwrite'));
      setVaultError(i18n.t('library.missingVaultWritePermForSync'));
      return;
    }
    setPermissionState('granted');
    await runFlushToVault(vaultBackend);
  }, [vaultBackend, runFlushToVault]);

  // 11. 容灾重建索引（支持本地目录与云存储后端）
  const handleRebuildIndex = useCallback(async () => {
    if (!vaultBackend || vaultBusyRef.current) {
      return;
    }
    const granted = await vaultBackend.requestPermission('readwrite');
    if (!granted) {
      setPermissionState(await vaultBackend.queryPermission('readwrite'));
      setVaultError(i18n.t('library.missingVaultPermForRebuild'));
      return;
    }
    setPermissionState('granted');
    await runRebuildIndex(vaultBackend);
  }, [vaultBackend, runRebuildIndex]);

  // 12. 清空浏览器缓存索引（绝不删除硬盘/云端文件与绑定配置）
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
      if (vaultBackend && permissionState === 'granted') {
        setShowRebuildSuggestion(true);
      }
    } catch (error) {
      setVaultError(
        i18n.t('library.clearCacheFailed', { error: getErrorMessage(error) }),
      );
    }
  }, [closeItemDrawer, vaultBackend, permissionState]);

  // 13. 文件夹操作（有 Vault 写权限时自动回写 taxonomy.json）
  const syncTaxonomyIfPermitted = useCallback(async () => {
    if (!vaultBackend || permissionState !== 'granted') {
      return;
    }
    try {
      await writeTaxonomyToVault(vaultBackend);
    } catch (error) {
      setVaultError(
        toVaultActionError(
          i18n.t('library.writeTaxonomyFailedPrefix'),
          error,
          vaultBackend.displayName,
        ),
      );
    }
  }, [vaultBackend, permissionState]);

  const notifyTaxonomyUpdated = useCallback(() => {
    void sendToBackground({
      target: 'background',
      type: 'NOTIFY_TAXONOMY_UPDATED',
    }).catch(() => undefined);
  }, []);

  const handleCreateFolder = useCallback(
    async (name: string, parentId: string | null): Promise<FolderNode> => {
      const created = await createFolder(name, parentId);
      await syncTaxonomyIfPermitted();
      notifyTaxonomyUpdated();
      return created;
    },
    [syncTaxonomyIfPermitted, notifyTaxonomyUpdated],
  );

  const handleRenameFolder = useCallback(
    async (id: string, name: string) => {
      await renameFolder(id, name);
      await syncTaxonomyIfPermitted();
      notifyTaxonomyUpdated();
    },
    [syncTaxonomyIfPermitted, notifyTaxonomyUpdated],
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
      notifyTaxonomyUpdated();
    },
    [folders, selectedFolderId, syncTaxonomyIfPermitted, notifyTaxonomyUpdated],
  );

  const handleSaveFolderAutoRule = useCallback(
    async (folderId: string, autoRule: FolderAutoRule | undefined) => {
      const updated = await updateFolderAutoRule(folderId, autoRule);
      await syncTaxonomyIfPermitted();
      notifyTaxonomyUpdated();
      if (updated) {
        setActionNotice({
          type: 'success',
          text: autoRule
            ? i18n.t('folderRuleModal.savedNotice', { name: updated.name })
            : i18n.t('folderRuleModal.clearedNotice', { name: updated.name }),
        });
      }
    },
    [syncTaxonomyIfPermitted, notifyTaxonomyUpdated],
  );

  // 14. 条目元数据实时编辑保存 + 有写权限立即回写 meta.json & taxonomy.json
  const handleSaveItem = useCallback(
    async (itemId: string, patch: ItemEditPatch): Promise<SaveItemResult> => {
      const updated = await updateItemClassification(itemId, patch);
      if (!updated) {
        throw new Error(i18n.t('library.itemNotFound'));
      }

      if (vaultBackend && permissionState === 'granted') {
        await writeTaxonomyToVault(vaultBackend);

        if (
          updated.syncStatus === 'meta_dirty' ||
          updated.syncStatus === 'vault_synced'
        ) {
          const syncedRecord: CollectionItemRecord = {
            ...updated,
            syncStatus: 'vault_synced',
          };
          await writeItemMetaToVault(vaultBackend, syncedRecord);
          await db.items.put(syncedRecord);
          return {
            syncedToVault: true,
            message: i18n.t('library.saveSyncedMsg'),
          };
        }

        // 若条目仍处于 opfs_staged，媒体文件尚在 OPFS 中，保留 opfs_staged 等待落盘以免丢失媒体
        return {
          syncedToVault: false,
          message: i18n.t('library.saveStagedMsg'),
        };
      }

      return {
        syncedToVault: false,
        message: i18n.t('library.saveLocalOnlyMsg'),
      };
    },
    [vaultBackend, permissionState],
  );

  // 15. 软删除 / 彻底删除 / 恢复 / 批量分类（已授权且已落盘条目同步回写 meta.json）
  const syncItemMetasIfPermitted = useCallback(
    async (itemIds: readonly string[], includeTaxonomy = false) => {
      if (!vaultBackend || permissionState !== 'granted') {
        return;
      }
      try {
        if (includeTaxonomy) {
          await writeTaxonomyToVault(vaultBackend);
        }
        for (const itemId of itemIds) {
          const latest = await db.items.get(itemId);
          if (latest && latest.syncStatus === 'meta_dirty') {
            const synced: CollectionItemRecord = {
              ...latest,
              syncStatus: 'vault_synced',
            };
            await writeItemMetaToVault(vaultBackend, synced);
            await db.items.put(synced);
          }
        }
      } catch (error) {
        setVaultError(
          toVaultActionError(
            i18n.t('library.writeItemMetaFailedPrefix'),
            error,
            vaultBackend.displayName,
          ),
        );
      }
    },
    [vaultBackend, permissionState],
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
            remoteTransportError = remoteRes?.error ?? i18n.t('common.commFailed');
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
                ? i18n.t('library.excludedRemoteFailDetail', {
                    reason:
                      outcome?.reason ??
                      remoteTransportError ??
                      i18n.t('common.unknownReason'),
                  })
                : i18n.t('library.excludedKeepRemoteDetail');
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
            if (vaultBackend && permissionState === 'granted') {
              for (const item of fullyRemovedItems) {
                try {
                  await removeItemDirFromVault(vaultBackend, item.relativeDir);
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

            if (vaultBackend && permissionState === 'granted') {
              for (const rec of updatedExcluded) {
                try {
                  await purgeItemMediaFilesFromVault(
                    vaultBackend,
                    rec.relativeDir,
                  );
                  const synced: CollectionItemRecord = {
                    ...rec,
                    syncStatus: 'vault_synced',
                  };
                  await writeItemMetaToVault(vaultBackend, synced);
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
            remoteSummaryText = i18n.t('library.remoteUncollectTransportWarn', {
              error: remoteTransportError,
            });
          } else {
            const outcomes = Array.from(remoteOutcomeByKey.values());
            const okCount = outcomes.filter((r) => r.ok).length;
            const failedList = outcomes.filter((r) => !r.ok);
            if (failedList.length === 0 && okCount > 0) {
              remoteSummaryText = i18n.t('library.remoteUncollectSuccessPart', {
                count: okCount,
              });
            } else if (failedList.length > 0) {
              noticeType = 'warning';
              const firstReason =
                failedList[0]?.reason ?? i18n.t('common.unknownReason');
              remoteSummaryText = i18n.t('library.remoteUncollectPartialPart', {
                ok: okCount,
                failed: failedList.length,
                reason: firstReason,
              });
            }
          }
        }

        let localActionLabel: string;
        if (mode === 'permanent') {
          if (excludedCount > 0 && fullyRemovedCount > 0) {
            localActionLabel = i18n.t('library.deletedMixed', {
              removed: fullyRemovedCount,
              excluded: excludedCount,
            });
          } else if (excludedCount > 0) {
            localActionLabel = i18n.t('library.deletedToExcluded', {
              count: excludedCount,
            });
          } else {
            localActionLabel = i18n.t('library.deletedPermanent', {
              count: fullyRemovedCount,
            });
          }
        } else {
          localActionLabel = i18n.t('library.deletedSoft', {
            count: targets.length,
          });
        }

        const vaultWarnText =
          vaultDeleteErrors > 0
            ? i18n.t('library.vaultDeleteWarn', { count: vaultDeleteErrors })
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
          text: i18n.t('library.deleteFailed', {
            error: getErrorMessage(error),
          }),
        });
      } finally {
        setIsDeleting(false);
      }
    },
    [
      pendingDelete,
      isDeleting,
      syncItemMetasIfPermitted,
      vaultBackend,
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
      let writableVault: VaultStorageBackend | null =
        vaultBackend && permissionState === 'granted' ? vaultBackend : null;

      if (
        !writableVault &&
        vaultBackend &&
        targets.some((item) => item.syncStatus === 'vault_synced')
      ) {
        const granted = await vaultBackend.requestPermission('readwrite');
        setPermissionState(
          granted
            ? 'granted'
            : await vaultBackend.queryPermission('readwrite'),
        );
        if (!granted) {
          setActionNotice({
            type: 'warning',
            text: i18n.t('library.allowSyncNeedVaultPerm'),
          });
          return;
        }
        writableVault = vaultBackend;
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
            ? i18n.t('library.allowSyncDoneWithErrors', {
                count: targets.length,
                errors: vaultRemoveErrors,
              })
            : i18n.t('library.allowSyncDone', { count: targets.length }),
      });
    },
    [vaultBackend, permissionState, selectedItemId, closeItemDrawer],
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
          text: i18n.t('library.remoteUncollectClearFailed', {
            error: remoteRes?.error ?? i18n.t('common.commFailed'),
          }),
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
            detail: i18n.t('library.remoteUncollectItemFailed', {
              reason: outcome?.reason ?? i18n.t('common.unknownReason'),
            }),
          });
        }
      }

      if (succeeded.length > 0) {
        const succeededIds = succeeded.map((i) => i.id);
        const succeededIdSet = new Set(succeededIds);
        for (const item of succeeded) {
          await removeItemFromOpfs(item.id).catch(() => undefined);
          if (vaultBackend && permissionState === 'granted') {
            await removeItemDirFromVault(vaultBackend, item.relativeDir).catch(
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
        if (vaultBackend && permissionState === 'granted') {
          for (const rec of updatedFailed) {
            const synced: CollectionItemRecord = {
              ...rec,
              syncStatus: 'vault_synced',
            };
            await writeItemMetaToVault(vaultBackend, synced).catch(
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
            ? i18n.t('library.remoteUncollectClearAllOk', {
                count: succeeded.length,
              })
            : i18n.t('library.remoteUncollectClearPartial', {
                ok: succeeded.length,
                failed: failedSpecs.length,
              }),
      });
    },
    [vaultBackend, permissionState, selectedItemId, closeItemDrawer],
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
            detail: i18n.t('library.cancelSyncDetail'),
          },
        ]);
      }

      if (vaultBackend && permissionState === 'granted') {
        const updated = await db.items.get(item.id);
        if (updated && isAutoSyncExcluded(updated)) {
          await purgeItemMediaFilesFromVault(
            vaultBackend,
            updated.relativeDir,
          ).catch(() => undefined);
          const synced: CollectionItemRecord = {
            ...updated,
            syncStatus: 'vault_synced',
          };
          await writeItemMetaToVault(vaultBackend, synced).catch(
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
        text: i18n.t('library.cancelSyncNotice', { title: item.title }),
      });
    },
    [vaultBackend, permissionState, selectedItemId, closeItemDrawer],
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
        text: i18n.t('library.batchRestoredNotice', { count: targets.length }),
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

  // NSFW 过滤仅影响展示（列表与侧边栏计数），同步计数仍基于全量 items
  const visibleItems = useMemo(
    () =>
      preferences.nsfwFilterEnabled
        ? items.filter((item) => !isNsfwItem(item))
        : items,
    [items, preferences.nsfwFilterEnabled],
  );

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

    const list = visibleItems.filter((item) => {
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
          case 'recent':
            if (isDeleted || isExcluded || item.openedAt != null) {
              return false;
            }
            break;
          case 'uncategorized':
            if (isDeleted || isExcluded || getItemFolderIds(item).length > 0) {
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
    visibleItems,
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

  useEffect(() => {
    if (
      !selectedItem ||
      selectedItem.openedAt != null ||
      selectedItem.deletedAt != null ||
      isAutoSyncExcluded(selectedItem)
    ) {
      return;
    }
    void markItemOpened(selectedItem.id).then((updated) => {
      if (updated) {
        return syncItemMetasIfPermitted([updated.id]);
      }
      return undefined;
    });
  }, [selectedItem, syncItemMetasIfPermitted]);

  const contextTitle = useMemo(() => {
    if (selectedFolderId !== null) {
      return (
        foldersById.get(selectedFolderId)?.name ??
        i18n.t('library.folderFallback')
      );
    }
    switch (activeView) {
      case 'all':
        return i18n.t('sidebar.navAll');
      case 'recent':
        return i18n.t('sidebar.navRecent');
      case 'uncategorized':
        return i18n.t('sidebar.navUncategorized');
      case 'excluded':
        return i18n.t('sidebar.navExcluded');
      case 'trash':
        return i18n.t('sidebar.navTrash');
    }
  }, [selectedFolderId, foldersById, activeView]);

  const hasActiveFilters =
    searchQuery.trim().length > 0 ||
    mediaKindFilter !== 'all' ||
    platformFilter !== 'all' ||
    selectedFolderId !== null ||
    activeView === 'recent' ||
    activeView === 'uncategorized';

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
    vaultBackend !== null &&
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
        text: i18n.t('library.batchAddedToFoldersNotice', {
          count: itemIds.length,
          folders: folderNames.join(i18n.t('common.listSeparator')),
        }),
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
    const folderName =
      foldersById.get(selectedFolderId)?.name ??
      i18n.t('library.currentFolderFallback');
    setSelectedItemIds(new Set());
    setActionNotice({
      type: 'success',
      text: i18n.t('library.batchRemovedFromFolderNotice', {
        count: updated.length,
        folder: folderName,
      }),
    });
  }, [
    selectedFolderId,
    selectedVisibleItems,
    syncItemMetasIfPermitted,
    foldersById,
  ]);

  return (
    <div className="flex h-screen overflow-hidden bg-[var(--cp-canvas)] text-[var(--cp-text)]">
      {/* 左侧导航与多级文件夹分类树 */}
      <SidebarTree
        items={visibleItems}
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
        onEditFolderAutoRule={(folder) => setEditingRuleFolder(folder)}
      />

      {/* 右侧主工作区 */}
      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {/* 后台下载进行中轻提示条 */}
        {activeDownloadCount !== undefined && activeDownloadCount > 0 && (
          <div className="flex items-center gap-2 border-b border-[var(--cp-border)] bg-[var(--cp-active)] px-6 py-1.5 text-xs text-[var(--cp-text-active)]">
            <Download className="h-3.5 w-3.5 animate-bounce text-[var(--cp-accent)]" />
            <span>
              {i18n.t('library.downloadingBannerPrefix')}
              <strong>{activeDownloadCount}</strong>
              {i18n.t('library.downloadingBannerSuffix')}
            </span>
          </div>
        )}

        {/* 批量操作 / 删除同步结果轻提示条 */}
        {actionNotice && (
          <div
            data-testid="library-action-notice"
            className={`flex items-center justify-between gap-2 border-b px-6 py-2 text-xs ${
              actionNotice.type === 'success'
                ? 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/60 dark:text-emerald-200'
                : actionNotice.type === 'warning'
                  ? 'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950/60 dark:text-amber-200'
                  : 'border-rose-200 bg-rose-50 text-rose-800 dark:border-rose-900 dark:bg-rose-950/60 dark:text-rose-200'
            }`}
          >
            <div className="flex min-w-0 items-center gap-2">
              {actionNotice.type === 'success' ? (
                <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
              ) : (
                <AlertCircle className="h-3.5 w-3.5 shrink-0" />
              )}
              <span className="truncate font-medium">{actionNotice.text}</span>
            </div>
            <button
              type="button"
              onClick={() => setActionNotice(null)}
              aria-label={i18n.t('library.dismissNoticeAria')}
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
            activeProviderId={activeProviderId}
            vaultTargetName={vaultBackend ? vaultBackend.displayName : null}
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
                      pendingMigrationConflict.sourceHandle.name ||
                      i18n.t('library.sourceDirFallback'),
                    targetName:
                      pendingMigrationConflict.targetHandle.name ||
                      i18n.t('library.targetDirFallback'),
                  }
                : null
            }
            showRebuildSuggestion={showRebuildSuggestion}
            vaultError={vaultError}
            focusVaultSectionTick={vaultSectionFocusTick}
            onUpdatePreferences={handleUpdatePreferences}
            onSelectVaultProvider={handleSelectVaultProvider}
            onBindVault={handleBindVault}
            onConnectGoogleDrive={handleConnectGoogleDrive}
            onDisconnectGoogleDrive={handleDisconnectGoogleDrive}
            onConnectCloudflareR2={handleConnectCloudflareR2}
            onDisconnectCloudflareR2={handleDisconnectCloudflareR2}
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
          vaultBackend={vaultBackend}
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

      {/* 文件夹自动分类显式微规则弹窗 */}
      {editingRuleFolder && (
        <FolderRuleModal
          folder={editingRuleFolder}
          onClose={() => setEditingRuleFolder(null)}
          onSave={handleSaveFolderAutoRule}
        />
      )}
    </div>
  );
}
