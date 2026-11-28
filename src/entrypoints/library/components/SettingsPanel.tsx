import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Cloud,
  DatabaseBackup,
  ExternalLink,
  FolderCheck,
  FolderKey,
  FolderOpen,
  FolderSync,
  HardDrive,
  Keyboard,
  LayoutGrid,
  List,
  Loader2,
  RefreshCw,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
  X,
} from 'lucide-react';
import {
  clampOversizedVideoThresholdMb,
  MAX_OVERSIZED_VIDEO_THRESHOLD_MB,
  MIN_OVERSIZED_VIDEO_THRESHOLD_MB,
} from '@/storage/db.ts';
import {
  i18n,
  setUiLanguage,
  useI18nLocale,
  type UiLanguage,
} from '@/i18n/index.ts';
import {
  getBrowserStorageEstimate,
  type BrowserStorageEstimate,
} from '@/storage/opfs.ts';
import type { ConnectCloudflareR2Input } from '@/storage/providers/cloudflare-r2/index.ts';
import type { ConnectGoogleDriveInput } from '@/storage/providers/google-drive/index.ts';
import { listVaultProviders } from '@/storage/providers/registry.ts';
import type {
  FlushProgress,
  FlushSummary,
  MigrationProgress,
  MigrationSummary,
  RebuildProgress,
  RebuildSummary,
  VaultPermissionStatus,
  VaultProviderId,
} from '@/storage/vault.ts';
import { CloudflareR2SettingsCard } from './providers/CloudflareR2SettingsCard.tsx';
import { GoogleDriveSettingsCard } from './providers/GoogleDriveSettingsCard.tsx';
import type {
  FolderNode,
  LibrarySortOption,
  LibraryViewMode,
  OversizedVideoNotifyMode,
  UserPreferences,
} from '@/types/schema.ts';
import {
  formatBytes,
  formatDateTime,
  formatRelativeTime,
  getErrorMessage,
} from '../utils/format.ts';

export interface VaultActionError {
  message: string;
  helpUrl?: string;
  helpLabel?: string;
  canRebind?: boolean;
}

export interface SettingsPanelProps {
  preferences: UserPreferences;
  folders: readonly FolderNode[];
  activeProviderId: VaultProviderId;
  vaultTargetName: string | null;
  vaultHandle: FileSystemDirectoryHandle | null;
  permissionState: VaultPermissionStatus;
  lastSyncAt: number | undefined;
  stagedCount: number;
  metaDirtyCount: number;
  totalItemCount: number;
  totalFolderCount: number;
  totalTagCount: number;
  isFlushing: boolean;
  flushProgress: FlushProgress | null;
  lastFlushSummary: FlushSummary | null;
  isRebuilding: boolean;
  rebuildProgress: RebuildProgress | null;
  lastRebuildSummary: RebuildSummary | null;
  isMigrating: boolean;
  migrationProgress: MigrationProgress | null;
  lastMigrationSummary: MigrationSummary | null;
  pendingMigrationConflict: {
    sourceName: string;
    targetName: string;
  } | null;
  showRebuildSuggestion: boolean;
  vaultError: string | VaultActionError | null;
  focusVaultSectionTick: number;
  onUpdatePreferences: (patch: Partial<UserPreferences>) => Promise<void>;
  onSelectVaultProvider: (providerId: VaultProviderId) => Promise<void>;
  onBindVault: () => Promise<void>;
  onConnectGoogleDrive: (input: ConnectGoogleDriveInput) => Promise<void>;
  onDisconnectGoogleDrive: () => Promise<void>;
  onConnectCloudflareR2: (input: ConnectCloudflareR2Input) => Promise<void>;
  onDisconnectCloudflareR2: () => Promise<void>;
  onResolveMigrationConflict: (mode: 'overwrite' | 'merge') => Promise<void>;
  onCancelMigrationConflict: () => void;
  onRequestPermissionAndSync: () => Promise<void>;
  onFlushToVault: () => Promise<void>;
  onRebuildIndex: () => Promise<void>;
  onClearBrowserCache: () => Promise<void>;
  onDismissSuggestion: () => void;
  onDismissFeedback: () => void;
}

function getFlushPhaseLabel(phase: FlushProgress['phase']): string {
  switch (phase) {
    case 'preparing':
      return i18n.t('settings.flushPhase.preparing');
    case 'flushing_staged':
      return i18n.t('settings.flushPhase.flushingStaged');
    case 'syncing_meta':
      return i18n.t('settings.flushPhase.syncingMeta');
    case 'writing_taxonomy':
      return i18n.t('settings.flushPhase.writingTaxonomy');
    case 'done':
      return i18n.t('settings.flushPhase.done');
  }
}

function getRebuildPhaseLabel(phase: RebuildProgress['phase']): string {
  switch (phase) {
    case 'scanning':
      return i18n.t('settings.rebuildPhase.scanning');
    case 'importing':
      return i18n.t('settings.rebuildPhase.importing');
    case 'done':
      return i18n.t('settings.rebuildPhase.done');
  }
}

function getMigrationPhaseLabel(phase: MigrationProgress['phase']): string {
  switch (phase) {
    case 'preparing':
      return i18n.t('settings.migrationPhase.preparing');
    case 'clearing_target':
      return i18n.t('settings.migrationPhase.clearingTarget');
    case 'copying':
      return i18n.t('settings.migrationPhase.copying');
    case 'finalizing':
      return i18n.t('settings.migrationPhase.finalizing');
    case 'cleaning_source':
      return i18n.t('settings.migrationPhase.cleaningSource');
    case 'done':
      return i18n.t('settings.migrationPhase.done');
  }
}

function getMigrationModeLabel(mode: MigrationSummary['mode']): string {
  switch (mode) {
    case 'empty_target':
      return i18n.t('settings.migrationMode.emptyTarget');
    case 'overwrite':
      return i18n.t('settings.migrationMode.overwrite');
    case 'merge':
      return i18n.t('settings.migrationMode.merge');
  }
}

interface FlatFolderOption {
  id: string;
  label: string;
}

const CONCURRENCY_OPTIONS = [1, 2, 3, 4, 5] as const;
const OVERSIZED_THRESHOLD_PRESETS_MB = [50, 100, 200, 500, 1024] as const;
const OVERSIZED_NOTIFY_VALUES: readonly OversizedVideoNotifyMode[] = [
  'popup',
  'silent',
];

function flattenFoldersForSelect(
  folders: readonly FolderNode[],
): FlatFolderOption[] {
  const byParent = new Map<string | null, FolderNode[]>();
  for (const folder of folders) {
    const bucket = byParent.get(folder.parentId);
    if (bucket) {
      bucket.push(folder);
    } else {
      byParent.set(folder.parentId, [folder]);
    }
  }
  for (const list of byParent.values()) {
    list.sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt - b.createdAt);
  }

  const options: FlatFolderOption[] = [];
  const walk = (parentId: string | null, depth: number) => {
    const children = byParent.get(parentId);
    if (!children) {
      return;
    }
    const prefix = depth > 0 ? `${'　'.repeat(depth)}└ ` : '';
    for (const node of children) {
      options.push({
        id: node.id,
        label: `${prefix}${node.name}`,
      });
      walk(node.id, depth + 1);
    }
  };
  walk(null, 0);
  return options;
}

interface ToggleSwitchProps {
  id: string;
  checked: boolean;
  disabled?: boolean;
  ariaLabel: string;
  onChange: (checked: boolean) => void;
}

function ToggleSwitch({
  id,
  checked,
  disabled = false,
  ariaLabel,
  onChange,
}: ToggleSwitchProps) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-[var(--cp-accent)] focus:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-60 ${
        checked ? 'bg-[var(--cp-accent)]' : 'bg-[var(--cp-border-strong)]'
      }`}
    >
      <span
        className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
          checked ? 'translate-x-6' : 'translate-x-1'
        }`}
      />
    </button>
  );
}

function getVaultProviderDisplayName(providerId: VaultProviderId): string {
  switch (providerId) {
    case 'local_fs':
      return i18n.t('settings.vaultProviderLocalFs');
    case 'google_drive':
      return i18n.t('settings.vaultProviderGoogleDrive');
    case 'cloudflare_r2':
      return i18n.t('settings.vaultProviderCloudflareR2');
  }
}

export function SettingsPanel({
  preferences,
  folders,
  activeProviderId,
  vaultTargetName,
  vaultHandle,
  permissionState,
  lastSyncAt,
  stagedCount,
  metaDirtyCount,
  totalItemCount,
  totalFolderCount,
  totalTagCount,
  isFlushing,
  flushProgress,
  lastFlushSummary,
  isRebuilding,
  rebuildProgress,
  lastRebuildSummary,
  isMigrating,
  migrationProgress,
  lastMigrationSummary,
  pendingMigrationConflict,
  showRebuildSuggestion,
  vaultError,
  focusVaultSectionTick,
  onUpdatePreferences,
  onSelectVaultProvider,
  onBindVault,
  onConnectGoogleDrive,
  onDisconnectGoogleDrive,
  onConnectCloudflareR2,
  onDisconnectCloudflareR2,
  onResolveMigrationConflict,
  onCancelMigrationConflict,
  onRequestPermissionAndSync,
  onFlushToVault,
  onRebuildIndex,
  onClearBrowserCache,
  onDismissSuggestion,
  onDismissFeedback,
}: SettingsPanelProps) {
  const uiLanguage = useI18nLocale();
  const vaultSectionRef = useRef<HTMLElement | null>(null);
  const [highlightVaultSection, setHighlightVaultSection] = useState(false);
  const [storageEstimate, setStorageEstimate] =
    useState<BrowserStorageEstimate | null>(null);
  const [loadingStorage, setLoadingStorage] = useState(true);
  const [confirmModal, setConfirmModal] = useState<
    'rebuild' | 'clear_cache' | null
  >(null);
  const [isClearingCache, setIsClearingCache] = useState(false);
  const [shortcutText, setShortcutText] = useState('Alt+S');
  const [shortcutNotice, setShortcutNotice] = useState<string | null>(null);
  const [savingNotice, setSavingNotice] = useState<string | null>(null);
  const [thresholdDraft, setThresholdDraft] = useState<string>(
    String(preferences.oversizedVideoThresholdMb),
  );

  useEffect(() => {
    setThresholdDraft(String(preferences.oversizedVideoThresholdMb));
  }, [preferences.oversizedVideoThresholdMb]);

  useEffect(() => {
    if (focusVaultSectionTick === 0) {
      return;
    }
    vaultSectionRef.current?.scrollIntoView({
      behavior: 'smooth',
      block: 'start',
    });
    setHighlightVaultSection(true);
    const timer = window.setTimeout(() => setHighlightVaultSection(false), 1600);
    return () => window.clearTimeout(timer);
  }, [focusVaultSectionTick]);

  const folderOptions = useMemo(
    () => flattenFoldersForSelect(folders),
    [folders],
  );

  const pendingSyncCount = stagedCount + metaDirtyCount;
  const isBusy = isFlushing || isRebuilding || isMigrating || isClearingCache;
  const flushPercent =
    flushProgress && flushProgress.total > 0
      ? Math.min(100, Math.round((flushProgress.current / flushProgress.total) * 100))
      : flushProgress?.phase === 'done'
        ? 100
        : 12;
  const migrationPercent =
    migrationProgress && migrationProgress.total > 0
      ? Math.min(
          100,
          Math.round(
            (migrationProgress.current / migrationProgress.total) * 100,
          ),
        )
      : migrationProgress?.phase === 'done'
        ? 100
        : 15;

  const refreshStorageEstimate = useCallback(async () => {
    setLoadingStorage(true);
    try {
      const next = await getBrowserStorageEstimate();
      setStorageEstimate(next);
    } finally {
      setLoadingStorage(false);
    }
  }, []);

  useEffect(() => {
    void refreshStorageEstimate();
  }, [refreshStorageEstimate, totalItemCount, stagedCount]);

  useEffect(() => {
    let active = true;
    const loadCommandShortcut = async () => {
      try {
        if (
          typeof chrome !== 'undefined' &&
          chrome.commands &&
          typeof chrome.commands.getAll === 'function'
        ) {
          const commands = await chrome.commands.getAll();
          const captureCmd = commands.find(
            (cmd) => cmd.name === 'capture-current-item',
          );
          if (active && captureCmd?.shortcut) {
            setShortcutText(captureCmd.shortcut);
          }
        }
      } catch {
        // 保留默认快捷键展示
      }
    };
    void loadCommandShortcut();
    return () => {
      active = false;
    };
  }, []);

  const handlePatchPreferences = async (
    patch: Partial<UserPreferences>,
    notice?: string,
  ) => {
    await onUpdatePreferences(patch);
    if (notice) {
      setSavingNotice(notice);
    }
  };

  const handleCommitThresholdDraft = () => {
    const clamped = clampOversizedVideoThresholdMb(thresholdDraft);
    setThresholdDraft(String(clamped));
    if (clamped !== preferences.oversizedVideoThresholdMb) {
      void handlePatchPreferences(
        { oversizedVideoThresholdMb: clamped },
        i18n.t('settings.oversizedThresholdNotice', { mb: clamped }),
      );
    }
  };

  useEffect(() => {
    if (!savingNotice) {
      return;
    }
    const timer = window.setTimeout(() => setSavingNotice(null), 2200);
    return () => window.clearTimeout(timer);
  }, [savingNotice]);

  const handleOpenShortcutsPage = async () => {
    setShortcutNotice(null);
    try {
      await chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
    } catch (error) {
      setShortcutNotice(
        i18n.t('settings.shortcutOpenFailed', {
          error: getErrorMessage(error),
        }),
      );
    }
  };

  const handleConfirmRebuild = async () => {
    setConfirmModal(null);
    await onRebuildIndex();
    await refreshStorageEstimate();
  };

  const handleConfirmClearCache = async () => {
    setIsClearingCache(true);
    try {
      await onClearBrowserCache();
      setConfirmModal(null);
      await refreshStorageEstimate();
      setSavingNotice(i18n.t('settings.clearCacheSuccessNotice'));
    } finally {
      setIsClearingCache(false);
    }
  };

  const usagePercent = useMemo(() => {
    if (!storageEstimate || storageEstimate.quotaBytes <= 0) {
      return 0;
    }
    const pct =
      (storageEstimate.totalUsageBytes / storageEstimate.quotaBytes) * 100;
    return Math.min(100, Math.max(pct > 0 ? 1 : 0, Math.round(pct)));
  }, [storageEstimate]);

  const registeredProviders = useMemo(() => listVaultProviders(), []);
  const hasBoundVault = vaultTargetName !== null;

  const vaultStatusBadge =
    permissionState === 'granted' && hasBoundVault
      ? {
          label: i18n.t('settings.vaultStatusGranted'),
          className:
            'bg-emerald-50 text-emerald-700 ring-1 ring-inset ring-emerald-200 dark:bg-emerald-950/70 dark:text-emerald-300 dark:ring-emerald-800',
        }
      : hasBoundVault
        ? {
            label: i18n.t('settings.vaultStatusReauth'),
            className:
              'bg-amber-50 text-amber-800 ring-1 ring-inset ring-amber-200 dark:bg-amber-950/70 dark:text-amber-300 dark:ring-amber-800',
          }
        : {
            label: i18n.t('settings.vaultStatusUnbound'),
            className:
              'bg-[var(--cp-muted)] text-[var(--cp-text-muted)] ring-1 ring-inset ring-[var(--cp-border)]',
          };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {/* 顶部标题栏 */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--cp-border)] bg-[var(--cp-surface)] px-6 py-3.5">
        <div className="flex items-center gap-2.5">
          <span className="inline-flex h-8 w-8 items-center justify-center rounded bg-[var(--cp-active)] text-[var(--cp-accent)]">
            <Settings className="h-4 w-4" />
          </span>
          <div>
            <h2 className="text-sm font-bold text-[var(--cp-text)]">
              {i18n.t('settings.title')}
            </h2>
            <p className="text-xs text-[var(--cp-text-muted)]">
              {i18n.t('settings.subtitle')}
            </p>
          </div>
        </div>

        {savingNotice && (
          <span className="rounded bg-emerald-50 px-3 py-1 text-xs font-medium text-emerald-700 ring-1 ring-inset ring-emerald-200 dark:bg-emerald-950/70 dark:text-emerald-300 dark:ring-emerald-800">
            {savingNotice}
          </span>
        )}
      </div>

      {/* 主体设置卡片流 */}
      <div className="flex-1 overflow-y-auto px-6 py-5">
        <div className="mx-auto flex max-w-4xl flex-col gap-5 pb-8">
          {/* 1. 采集与交互 */}
          <section className="rounded-md border border-[var(--cp-border)] bg-[var(--cp-surface)] p-5">
            <div className="mb-4 flex items-center gap-2">
              <SlidersHorizontal className="h-4 w-4 text-[var(--cp-accent)]" />
              <h3 className="text-sm font-semibold text-[var(--cp-text)]">
                {i18n.t('settings.sectionCapture')}
              </h3>
            </div>

            <div className="divide-y divide-[var(--cp-divider)]">
              {/* 悬浮图标开关 */}
              <div className="flex items-center justify-between gap-4 py-3.5 first:pt-0">
                <div className="min-w-0">
                  <label
                    htmlFor="setting-floating-button"
                    className="block text-xs font-semibold text-[var(--cp-text)]"
                  >
                    {i18n.t('settings.floatingBtnLabel')}
                  </label>
                  <p className="mt-0.5 text-xs text-[var(--cp-text-muted)]">
                    {i18n.t('settings.floatingBtnDesc')}
                  </p>
                </div>
                <ToggleSwitch
                  id="setting-floating-button"
                  checked={preferences.floatingButtonEnabled}
                  ariaLabel={i18n.t('settings.floatingBtnLabel')}
                  onChange={(checked) =>
                    void handlePatchPreferences(
                      { floatingButtonEnabled: checked },
                      checked
                        ? i18n.t('settings.floatingBtnEnabledNotice')
                        : i18n.t('settings.floatingBtnDisabledNotice'),
                    )
                  }
                />
              </div>

              {/* 原生收藏 5 秒取消保存提示 Toast 开关 */}
              <div className="flex items-center justify-between gap-4 py-3.5">
                <div className="min-w-0">
                  <label
                    htmlFor="setting-native-collect-toast"
                    className="block text-xs font-semibold text-[var(--cp-text)]"
                  >
                    {i18n.t('settings.nativeCollectToastLabel')}
                  </label>
                  <p className="mt-0.5 text-xs text-[var(--cp-text-muted)]">
                    {i18n.t('settings.nativeCollectToastDesc')}
                  </p>
                </div>
                <ToggleSwitch
                  id="setting-native-collect-toast"
                  checked={preferences.nativeCollectToastEnabled}
                  ariaLabel={i18n.t('settings.nativeCollectToastLabel')}
                  onChange={(checked) =>
                    void handlePatchPreferences(
                      { nativeCollectToastEnabled: checked },
                      checked
                        ? i18n.t('settings.nativeCollectToastEnabledNotice')
                        : i18n.t('settings.nativeCollectToastDisabledNotice'),
                    )
                  }
                />
              </div>

              {/* NSFW 内容过滤开关 */}
              <div className="flex items-center justify-between gap-4 py-3.5">
                <div className="min-w-0">
                  <label
                    htmlFor="setting-nsfw-filter"
                    className="block text-xs font-semibold text-[var(--cp-text)]"
                  >
                    {i18n.t('settings.nsfwFilterLabel')}
                  </label>
                  <p className="mt-0.5 text-xs text-[var(--cp-text-muted)]">
                    {i18n.t('settings.nsfwFilterDesc')}
                  </p>
                </div>
                <ToggleSwitch
                  id="setting-nsfw-filter"
                  checked={preferences.nsfwFilterEnabled}
                  ariaLabel={i18n.t('settings.nsfwFilterLabel')}
                  onChange={(checked) =>
                    void handlePatchPreferences(
                      { nsfwFilterEnabled: checked },
                      checked
                        ? i18n.t('settings.nsfwFilterEnabledNotice')
                        : i18n.t('settings.nsfwFilterDisabledNotice'),
                    )
                  }
                />
              </div>

              {/* 自动同步全部收藏（总开关） */}
              <div className="flex items-center justify-between gap-4 py-3.5">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <label
                      htmlFor="setting-auto-sync-all"
                      className="block text-xs font-semibold text-[var(--cp-text)]"
                    >
                      {i18n.t('settings.autoSyncAllLabel')}
                    </label>
                    <span className="rounded bg-[var(--cp-active)] px-2 py-0.5 text-[10px] font-semibold text-[var(--cp-text-active)] ring-1 ring-inset ring-[var(--cp-border-strong)]">
                      {i18n.t('settings.masterSwitchBadge')}
                    </span>
                  </div>
                  <p className="mt-0.5 text-xs text-[var(--cp-text-muted)]">
                    {i18n.t('settings.autoSyncAllDesc')}
                  </p>
                </div>
                <ToggleSwitch
                  id="setting-auto-sync-all"
                  checked={preferences.autoSyncAllCollections}
                  ariaLabel={i18n.t('settings.autoSyncAllLabel')}
                  onChange={(checked) =>
                    void handlePatchPreferences(
                      { autoSyncAllCollections: checked },
                      checked
                        ? i18n.t('settings.autoSyncAllEnabledNotice')
                        : i18n.t('settings.autoSyncAllDisabledNotice'),
                    )
                  }
                />
              </div>

              {/* 取消收藏时同步至插件 */}
              <div className="flex items-center justify-between gap-4 py-3.5">
                <div className="min-w-0">
                  <label
                    htmlFor="setting-sync-uncollect"
                    className="block text-xs font-semibold text-[var(--cp-text)]"
                  >
                    {i18n.t('settings.syncUncollectLabel')}
                  </label>
                  <p className="mt-0.5 text-xs text-[var(--cp-text-muted)]">
                    {i18n.t('settings.syncUncollectDesc')}
                  </p>
                </div>
                <ToggleSwitch
                  id="setting-sync-uncollect"
                  checked={preferences.syncUncollectToPlugin}
                  ariaLabel={i18n.t('settings.syncUncollectLabel')}
                  onChange={(checked) =>
                    void handlePatchPreferences(
                      { syncUncollectToPlugin: checked },
                      checked
                        ? i18n.t('settings.syncUncollectEnabledNotice')
                        : i18n.t('settings.syncUncollectDisabledNotice'),
                    )
                  }
                />
              </div>

              {/* 视频过大时取消自动保存 */}
              <div className="py-3.5">
                <div className="flex items-center justify-between gap-4">
                  <div className="min-w-0">
                    <label
                      htmlFor="setting-skip-oversized-video"
                      className="block text-xs font-semibold text-[var(--cp-text)]"
                    >
                      {i18n.t('settings.skipOversizedLabel')}
                    </label>
                    <p className="mt-0.5 text-xs text-[var(--cp-text-muted)]">
                      {i18n.t('settings.skipOversizedDesc')}
                    </p>
                  </div>
                  <ToggleSwitch
                    id="setting-skip-oversized-video"
                    checked={preferences.skipOversizedVideoAutoSave}
                    ariaLabel={i18n.t('settings.skipOversizedLabel')}
                    onChange={(checked) =>
                      void handlePatchPreferences(
                        { skipOversizedVideoAutoSave: checked },
                        checked
                          ? i18n.t('settings.skipOversizedEnabledNotice')
                          : i18n.t('settings.skipOversizedDisabledNotice'),
                      )
                    }
                  />
                </div>

                {preferences.skipOversizedVideoAutoSave && (
                  <div
                    data-testid="oversized-video-options"
                    className="mt-3 flex flex-col gap-3 rounded border border-[var(--cp-border)] bg-[var(--cp-canvas)] p-3.5"
                  >
                    {/* 体积上限（MB） */}
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="min-w-0">
                        <label
                          htmlFor="setting-oversized-threshold-mb"
                          className="block text-xs font-medium text-[var(--cp-text)]"
                        >
                          {i18n.t('settings.oversizedThresholdLabel')}
                        </label>
                        <p className="mt-0.5 text-[11px] text-[var(--cp-text-muted)]">
                          {i18n.t('settings.oversizedThresholdDesc', {
                            min: MIN_OVERSIZED_VIDEO_THRESHOLD_MB,
                            max: MAX_OVERSIZED_VIDEO_THRESHOLD_MB,
                          })}
                        </p>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <div
                          className="inline-flex rounded border border-[var(--cp-border)] bg-[var(--cp-muted)] p-0.5"
                          role="group"
                          aria-label={i18n.t('settings.oversizedPresetAria')}
                        >
                          {OVERSIZED_THRESHOLD_PRESETS_MB.map((mb) => {
                            const active =
                              preferences.oversizedVideoThresholdMb === mb;
                            return (
                              <button
                                key={mb}
                                type="button"
                                onClick={() =>
                                  void handlePatchPreferences(
                                    { oversizedVideoThresholdMb: mb },
                                    i18n.t('settings.oversizedThresholdNotice', {
                                      mb,
                                    }),
                                  )
                                }
                                className={`rounded px-2 py-1 text-xs font-semibold tabular-nums transition ${
                                  active
                                    ? 'bg-[var(--cp-surface)] text-[var(--cp-text-active)]'
                                    : 'text-[var(--cp-text-secondary)] hover:text-[var(--cp-text)]'
                                }`}
                              >
                                {mb} MB
                              </button>
                            );
                          })}
                        </div>
                        <div className="inline-flex items-center rounded border border-[var(--cp-border)] bg-[var(--cp-surface)] px-2 py-1 focus-within:border-[var(--cp-accent)]">
                          <input
                            id="setting-oversized-threshold-mb"
                            type="number"
                            min={MIN_OVERSIZED_VIDEO_THRESHOLD_MB}
                            max={MAX_OVERSIZED_VIDEO_THRESHOLD_MB}
                            step={10}
                            value={thresholdDraft}
                            onChange={(e) => setThresholdDraft(e.target.value)}
                            onBlur={handleCommitThresholdDraft}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                e.currentTarget.blur();
                              }
                            }}
                            aria-label={i18n.t('settings.oversizedCustomAria')}
                            className="w-16 bg-transparent text-right text-xs font-semibold tabular-nums text-[var(--cp-text)] focus:outline-none"
                          />
                          <span className="ml-1 text-[11px] font-medium text-[var(--cp-text-muted)]">
                            MB
                          </span>
                        </div>
                      </div>
                    </div>

                    {/* 触发时通知状态 */}
                    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--cp-divider)] pt-3">
                      <div className="min-w-0">
                        <p className="text-xs font-medium text-[var(--cp-text)]">
                          {i18n.t('settings.oversizedNotifyLabel')}
                        </p>
                        <p className="mt-0.5 text-[11px] text-[var(--cp-text-muted)]">
                          {preferences.oversizedVideoNotifyMode === 'popup'
                            ? i18n.t('settings.oversizedNotifyPopupDesc')
                            : i18n.t('settings.oversizedNotifySilentDesc')}
                        </p>
                      </div>
                      <div
                        className="inline-flex rounded border border-[var(--cp-border)] bg-[var(--cp-muted)] p-0.5"
                        role="group"
                        aria-label={i18n.t('settings.oversizedNotifyLabel')}
                      >
                        {OVERSIZED_NOTIFY_VALUES.map((mode) => {
                          const active =
                            preferences.oversizedVideoNotifyMode === mode;
                          return (
                            <button
                              key={mode}
                              type="button"
                              aria-pressed={active}
                              onClick={() =>
                                void handlePatchPreferences(
                                  { oversizedVideoNotifyMode: mode },
                                  mode === 'popup'
                                    ? i18n.t('settings.oversizedNotifyPopupNotice')
                                    : i18n.t('settings.oversizedNotifySilentNotice'),
                                )
                              }
                              className={`min-w-14 rounded px-3 py-1 text-xs font-semibold transition ${
                                active
                                  ? 'bg-[var(--cp-surface)] text-[var(--cp-text-active)]'
                                  : 'text-[var(--cp-text-secondary)] hover:text-[var(--cp-text)]'
                              }`}
                            >
                              {mode === 'popup'
                                ? i18n.t('settings.oversizedNotifyPopup')
                                : i18n.t('settings.oversizedNotifySilent')}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* 未手动指定文件夹时的归类方式 */}
              <div className="flex flex-wrap items-center justify-between gap-4 py-3.5">
                <div className="min-w-0">
                  <label
                    htmlFor="setting-default-folder"
                    className="block text-xs font-semibold text-[var(--cp-text)]"
                  >
                    {i18n.t('settings.defaultFolderLabel')}
                  </label>
                  <p className="mt-0.5 text-xs text-[var(--cp-text-muted)]">
                    {i18n.t('settings.defaultFolderDesc')}
                  </p>
                </div>
                <select
                  id="setting-default-folder"
                  value={
                    preferences.autoClassifyEnabled
                      ? '__auto__'
                      : (preferences.defaultFolderId ?? '')
                  }
                  onChange={(e) => {
                    const raw = e.target.value;
                    if (raw === '__auto__') {
                      void handlePatchPreferences(
                        { autoClassifyEnabled: true, defaultFolderId: null },
                        i18n.t('settings.defaultFolderUpdatedNotice'),
                      );
                      return;
                    }
                    const nextFolderId = raw || null;
                    void handlePatchPreferences(
                      {
                        autoClassifyEnabled: false,
                        defaultFolderId: nextFolderId,
                      },
                      i18n.t('settings.defaultFolderUpdatedNotice'),
                    );
                  }}
                  className="min-w-[240px] rounded border border-[var(--cp-border)] bg-[var(--cp-surface)] px-3 py-1.5 text-xs font-medium text-[var(--cp-text)] transition hover:border-[var(--cp-border-strong)] focus:border-[var(--cp-accent)] focus:outline-none"
                >
                  <option value="__auto__">
                    {i18n.t('settings.defaultFolderAutoOption')}
                  </option>
                  <option value="">
                    {i18n.t('settings.defaultFolderRootOption')}
                  </option>
                  {folderOptions.map((opt) => (
                    <option key={opt.id} value={opt.id}>
                      {i18n.t('settings.defaultFolderFixedPrefix', {
                        name: opt.label,
                      })}
                    </option>
                  ))}
                </select>
              </div>

              {/* 最大并发下载任务数 */}
              <div className="flex flex-wrap items-center justify-between gap-4 py-3.5">
                <div className="min-w-0">
                  <p className="text-xs font-semibold text-[var(--cp-text)]">
                    {i18n.t('settings.concurrencyLabel')}
                  </p>
                  <p className="mt-0.5 text-xs text-[var(--cp-text-muted)]">
                    {i18n.t('settings.concurrencyDesc')}
                  </p>
                </div>
                <div
                  className="inline-flex rounded border border-[var(--cp-border)] bg-[var(--cp-muted)] p-0.5"
                  role="group"
                  aria-label={i18n.t('settings.concurrencyLabel')}
                >
                  {CONCURRENCY_OPTIONS.map((num) => {
                    const active = preferences.maxConcurrentDownloads === num;
                    return (
                      <button
                        key={num}
                        type="button"
                        onClick={() =>
                          void handlePatchPreferences(
                            { maxConcurrentDownloads: num },
                            i18n.t('settings.concurrencyNotice', { count: num }),
                          )
                        }
                        className={`min-w-8 rounded px-2.5 py-1 text-xs font-semibold tabular-nums transition ${
                          active
                            ? 'bg-[var(--cp-surface)] text-[var(--cp-text-active)]'
                            : 'text-[var(--cp-text-secondary)] hover:text-[var(--cp-text)]'
                        }`}
                      >
                        {num}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* 快捷键说明与入口 */}
              <div className="flex flex-wrap items-center justify-between gap-4 pt-3.5">
                <div className="min-w-0">
                  <p className="flex items-center gap-1.5 text-xs font-semibold text-[var(--cp-text)]">
                    <Keyboard className="h-3.5 w-3.5 text-[var(--cp-text-muted)]" />
                    <span>{i18n.t('settings.shortcutLabel')}</span>
                  </p>
                  <p className="mt-0.5 text-xs text-[var(--cp-text-muted)]">
                    {i18n.t('settings.shortcutDesc')}
                  </p>
                  {shortcutNotice && (
                    <p className="mt-1.5 text-[11px] text-amber-700 dark:text-amber-300">
                      {shortcutNotice}
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <kbd className="rounded border border-[var(--cp-border)] bg-[var(--cp-canvas)] px-2.5 py-1 font-mono text-xs font-semibold text-[var(--cp-text)]">
                    {shortcutText}
                  </kbd>
                  <button
                    type="button"
                    onClick={() => void handleOpenShortcutsPage()}
                    className="inline-flex items-center gap-1.5 rounded border border-[var(--cp-border)] bg-[var(--cp-surface)] px-3 py-1.5 text-xs font-medium text-[var(--cp-text-secondary)] transition hover:border-[var(--cp-accent)] hover:bg-[var(--cp-active)] hover:text-[var(--cp-text-active)]"
                  >
                    <span>{i18n.t('settings.modifyShortcutBtn')}</span>
                    <ExternalLink className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            </div>
          </section>

          {/* 2. 同步与持久化目标（支持插件化扩展本地与云存储） */}
          <section
            id="settings-vault-section"
            data-testid="settings-vault-section"
            ref={vaultSectionRef}
            className={`scroll-mt-4 rounded-md border bg-[var(--cp-surface)] p-5 transition ${
              highlightVaultSection
                ? 'border-[var(--cp-accent)] ring-2 ring-[var(--cp-accent-soft)]'
                : 'border-[var(--cp-border)]'
            }`}
          >
            <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                {activeProviderId !== 'local_fs' ? (
                  <Cloud
                    className={`h-4 w-4 ${
                      permissionState === 'granted' && hasBoundVault
                        ? 'text-emerald-600 dark:text-emerald-400'
                        : 'text-[var(--cp-accent)]'
                    }`}
                  />
                ) : permissionState === 'granted' && hasBoundVault ? (
                  <FolderCheck className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                ) : (
                  <FolderKey className="h-4 w-4 text-[var(--cp-accent)]" />
                )}
                <h3 className="text-sm font-semibold text-[var(--cp-text)]">
                  {activeProviderId === 'local_fs'
                    ? i18n.t('settings.sectionVault')
                    : i18n.t('settings.sectionVaultCloud')}
                </h3>
              </div>
              <span
                data-testid="vault-status-badge"
                className={`rounded px-2.5 py-0.5 text-[11px] font-medium ${vaultStatusBadge.className}`}
              >
                {vaultStatusBadge.label}
              </span>
            </div>

            {/* 持久化插件切换器（按注册中心动态渲染，方便后续接入 WebDAV / S3 等） */}
            <div className="mb-3.5 flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs font-medium text-[var(--cp-text-secondary)]">
                {i18n.t('settings.vaultProviderLabel')}
              </span>
              <div
                data-testid="vault-provider-switcher"
                role="tablist"
                aria-label={i18n.t('settings.vaultProviderLabel')}
                className="inline-flex rounded border border-[var(--cp-border)] bg-[var(--cp-muted)] p-0.5"
              >
                {registeredProviders.map((provider) => {
                  const active = activeProviderId === provider.id;
                  const label = getVaultProviderDisplayName(provider.id);
                  return (
                    <button
                      key={provider.id}
                      type="button"
                      role="tab"
                      aria-selected={active}
                      data-testid={`vault-provider-tab-${provider.id}`}
                      disabled={isBusy}
                      onClick={() => {
                        if (active) {
                          return;
                        }
                        void onSelectVaultProvider(provider.id).then(() => {
                          setSavingNotice(
                            i18n.t('settings.vaultProviderSwitchedNotice', {
                              label,
                            }),
                          );
                        });
                      }}
                      className={`inline-flex items-center gap-1.5 rounded px-3 py-1 text-xs font-medium transition disabled:opacity-60 ${
                        active
                          ? 'bg-[var(--cp-surface)] font-semibold text-[var(--cp-text-active)]'
                          : 'text-[var(--cp-text-secondary)] hover:text-[var(--cp-text)]'
                      }`}
                    >
                      {provider.isRemote ? (
                        <Cloud className="h-3.5 w-3.5" />
                      ) : (
                        <HardDrive className="h-3.5 w-3.5" />
                      )}
                      <span>{label}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            {activeProviderId === 'google_drive' ? (
              <GoogleDriveSettingsCard
                permissionState={permissionState}
                lastSyncAt={lastSyncAt}
                stagedCount={stagedCount}
                metaDirtyCount={metaDirtyCount}
                isBusy={isBusy}
                isFlushing={isFlushing}
                isRebuilding={isRebuilding}
                onConnect={onConnectGoogleDrive}
                onDisconnect={onDisconnectGoogleDrive}
                onRequestPermissionAndSync={onRequestPermissionAndSync}
                onFlushToVault={onFlushToVault}
                onOpenRebuildConfirm={() => setConfirmModal('rebuild')}
              />
            ) : activeProviderId === 'cloudflare_r2' ? (
              <CloudflareR2SettingsCard
                permissionState={permissionState}
                lastSyncAt={lastSyncAt}
                stagedCount={stagedCount}
                metaDirtyCount={metaDirtyCount}
                isBusy={isBusy}
                isFlushing={isFlushing}
                isRebuilding={isRebuilding}
                onConnect={onConnectCloudflareR2}
                onDisconnect={onDisconnectCloudflareR2}
                onFlushToVault={onFlushToVault}
                onOpenRebuildConfirm={() => setConfirmModal('rebuild')}
              />
            ) : (
            <div className="rounded border border-[var(--cp-border)] bg-[var(--cp-canvas)] p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-xs text-[var(--cp-text-muted)]">
                    {i18n.t('settings.currentVaultDirLabel')}
                  </p>
                  <p className="mt-1 flex items-center gap-2 text-sm font-semibold text-[var(--cp-text)]">
                    <code className="rounded border border-[var(--cp-border)] bg-[var(--cp-surface)] px-2 py-0.5 text-xs font-semibold text-[var(--cp-text-active)]">
                      {vaultHandle
                        ? vaultHandle.name
                        : i18n.t('settings.vaultUnboundName')}
                    </code>
                  </p>
                  <p
                    className="mt-1.5 text-[11px] text-[var(--cp-text-muted)]"
                    title={
                      lastSyncAt
                        ? formatDateTime(lastSyncAt)
                        : i18n.t('settings.notSyncedYet')
                    }
                  >
                    {i18n.t('settings.lastSyncPrefix')}
                    {lastSyncAt
                      ? formatRelativeTime(lastSyncAt)
                      : i18n.t('settings.notSyncedYet')}
                    {i18n.t('settings.pendingSyncPrefix')}
                    <strong
                      className={
                        pendingSyncCount > 0
                          ? 'text-amber-700 dark:text-amber-300'
                          : 'text-emerald-700 dark:text-emerald-300'
                      }
                    >
                      {pendingSyncCount}
                    </strong>
                    {pendingSyncCount > 0
                      ? i18n.t('settings.pendingSyncBreakdown', {
                          staged: stagedCount,
                          metaDirty: metaDirtyCount,
                        })
                      : ''}
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void onBindVault()}
                    disabled={isBusy}
                    className="inline-flex items-center gap-1.5 rounded bg-[var(--cp-accent)] px-3 py-1.5 text-xs font-semibold text-[var(--cp-on-accent)] transition hover:bg-[var(--cp-accent-hover)] disabled:opacity-60"
                  >
                    <FolderOpen className="h-3.5 w-3.5" />
                    <span>
                      {vaultHandle
                        ? i18n.t('settings.switchVaultDir')
                        : i18n.t('settings.selectVaultDir')}
                    </span>
                  </button>

                  {vaultHandle && permissionState !== 'granted' && (
                    <button
                      type="button"
                      onClick={() => void onRequestPermissionAndSync()}
                      disabled={isBusy}
                      className="inline-flex items-center gap-1.5 rounded border border-[var(--cp-border-strong)] bg-[var(--cp-active)] px-3 py-1.5 text-xs font-semibold text-[var(--cp-text-active)] transition hover:border-[var(--cp-accent)] disabled:opacity-60"
                    >
                      <ShieldCheck className="h-3.5 w-3.5" />
                      <span>{i18n.t('settings.authorizeAndSync')}</span>
                    </button>
                  )}

                  {vaultHandle && permissionState === 'granted' && (
                    <button
                      type="button"
                      onClick={() => void onFlushToVault()}
                      disabled={isBusy}
                      className="inline-flex items-center gap-1.5 rounded border border-[var(--cp-border)] bg-[var(--cp-surface)] px-3 py-1.5 text-xs font-medium text-[var(--cp-text-secondary)] transition hover:border-[var(--cp-border-strong)] hover:text-[var(--cp-text)] disabled:opacity-60"
                    >
                      {isFlushing ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <FolderSync className="h-3.5 w-3.5 text-[var(--cp-accent)]" />
                      )}
                      <span>
                        {isFlushing
                          ? i18n.t('settings.syncing')
                          : i18n.t('settings.syncNow')}
                      </span>
                    </button>
                  )}

                  {vaultHandle && (
                    <button
                      type="button"
                      onClick={() => setConfirmModal('rebuild')}
                      disabled={isBusy}
                      className="inline-flex items-center gap-1.5 rounded border border-[var(--cp-border)] bg-[var(--cp-surface)] px-3 py-1.5 text-xs font-medium text-[var(--cp-text-secondary)] transition hover:border-[var(--cp-border-strong)] hover:text-[var(--cp-text)] disabled:opacity-60"
                    >
                      {isRebuilding ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <DatabaseBackup className="h-3.5 w-3.5 text-[var(--cp-text-muted)]" />
                      )}
                      <span>
                        {isRebuilding
                          ? i18n.t('settings.rebuilding')
                          : i18n.t('settings.rebuildIndexBtn')}
                      </span>
                    </button>
                  )}
                </div>
              </div>
            </div>
            )}

            {/* 绑定已有 Vault 且 IndexedDB 为空时的一键重建引导 */}
            {showRebuildSuggestion &&
              hasBoundVault &&
              permissionState === 'granted' &&
              !isRebuilding && (
                <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded border border-[var(--cp-border-strong)] bg-[var(--cp-active)] px-4 py-2.5 text-xs text-[var(--cp-text-active)]">
                  <div className="flex items-center gap-2">
                    <RefreshCw className="h-4 w-4 shrink-0 text-[var(--cp-accent)]" />
                    <span>
                      {i18n.t('settings.rebuildSuggestionPrefix')}
                      <strong>{vaultTargetName}</strong>
                      {i18n.t('settings.rebuildSuggestionSuffix')}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        onDismissSuggestion();
                        void onRebuildIndex();
                      }}
                      className="rounded bg-[var(--cp-accent)] px-3 py-1 text-xs font-semibold text-[var(--cp-on-accent)] transition hover:bg-[var(--cp-accent-hover)]"
                    >
                      {i18n.t('settings.rebuildNowBtn')}
                    </button>
                    <button
                      type="button"
                      onClick={onDismissSuggestion}
                      className="rounded px-2 py-1 text-xs font-medium text-[var(--cp-text-active)] hover:bg-[var(--cp-surface)]"
                    >
                      {i18n.t('settings.laterBtn')}
                    </button>
                  </div>
                </div>
              )}

            {/* 目录迁移进度条 */}
            {isMigrating && migrationProgress && (
              <div className="mt-3 rounded border border-[var(--cp-border)] bg-[var(--cp-active)] px-4 py-2.5">
                <div className="flex items-center justify-between gap-2 text-xs">
                  <span className="flex items-center gap-2 truncate font-medium text-[var(--cp-text-active)]">
                    <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-[var(--cp-accent)]" />
                    <span className="truncate">
                      {getMigrationPhaseLabel(migrationProgress.phase)}
                      {migrationProgress.currentPath
                        ? `：${migrationProgress.currentPath}`
                        : ''}
                    </span>
                  </span>
                  <span className="shrink-0 font-semibold tabular-nums text-[var(--cp-text-active)]">
                    {migrationProgress.total > 0
                      ? `${migrationProgress.current} / ${migrationProgress.total}`
                      : `${migrationPercent}%`}
                  </span>
                </div>
                <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-[var(--cp-border)]">
                  <div
                    className="h-full rounded-full bg-[var(--cp-accent)] transition-all duration-300"
                    style={{ width: `${migrationPercent}%` }}
                  />
                </div>
              </div>
            )}

            {/* 同步进度条 */}
            {isFlushing && flushProgress && (
              <div className="mt-3 rounded border border-[var(--cp-border)] bg-[var(--cp-active)] px-4 py-2.5">
                <div className="flex items-center justify-between gap-2 text-xs">
                  <span className="font-medium text-[var(--cp-text-active)]">
                    {getFlushPhaseLabel(flushProgress.phase)}
                    {flushProgress.currentTitle
                      ? `：${flushProgress.currentTitle}`
                      : ''}
                  </span>
                  <span className="shrink-0 font-semibold tabular-nums text-[var(--cp-text-active)]">
                    {flushProgress.total > 0
                      ? `${flushProgress.current} / ${flushProgress.total}`
                      : `${flushPercent}%`}
                  </span>
                </div>
                <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-[var(--cp-border)]">
                  <div
                    className="h-full rounded-full bg-[var(--cp-accent)] transition-all duration-300"
                    style={{ width: `${flushPercent}%` }}
                  />
                </div>
              </div>
            )}

            {/* 索引重建进度条 */}
            {isRebuilding && rebuildProgress && (
              <div className="mt-3 rounded border border-sky-200 bg-sky-50 px-4 py-2.5 dark:border-sky-900 dark:bg-sky-950/60">
                <div className="flex items-center justify-between gap-2 text-xs">
                  <span className="flex items-center gap-2 font-medium text-sky-900 dark:text-sky-200">
                    <Loader2 className="h-3.5 w-3.5 animate-spin text-sky-600 dark:text-sky-400" />
                    <span>
                      {getRebuildPhaseLabel(rebuildProgress.phase)}
                      {rebuildProgress.currentTitle
                        ? `：${rebuildProgress.currentTitle}`
                        : ''}
                    </span>
                  </span>
                  <span className="shrink-0 font-semibold tabular-nums text-sky-700 dark:text-sky-300">
                    {i18n.t('settings.scannedItemsCount', {
                      count: rebuildProgress.scannedItems,
                    })}
                  </span>
                </div>
              </div>
            )}

            {/* 目录迁移结果反馈 */}
            {!isMigrating && lastMigrationSummary && (
              <div
                className={`mt-3 flex items-start justify-between gap-3 rounded border px-4 py-2 text-xs ${
                  lastMigrationSummary.sourceCleanupFailedCount > 0
                    ? 'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950/60 dark:text-amber-200'
                    : 'border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/60 dark:text-emerald-200'
                }`}
              >
                <div className="flex items-start gap-2">
                  {lastMigrationSummary.sourceCleanupFailedCount > 0 ? (
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
                  ) : (
                    <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
                  )}
                  <div>
                    <span>
                      {i18n.t('settings.migrationDonePrefix', {
                        mode: getMigrationModeLabel(lastMigrationSummary.mode),
                      })}
                      <strong>{lastMigrationSummary.sourceName}</strong>
                      {i18n.t('settings.migrationDoneSwitchTo')}
                      <strong>{lastMigrationSummary.targetName}</strong>
                      {i18n.t('settings.migrationDoneCopiedPrefix')}
                      <strong>{lastMigrationSummary.copiedFiles}</strong>
                      {i18n.t('settings.migrationDoneCopiedSuffix')}
                      {lastMigrationSummary.skippedFiles > 0
                        ? i18n.t('settings.migrationDoneSkippedPart', {
                            count: lastMigrationSummary.skippedFiles,
                          })
                        : ''}
                      {lastMigrationSummary.sourceCleanupFailedCount === 0
                        ? i18n.t('settings.migrationDoneSourceCleaned')
                        : i18n.t('settings.migrationDoneSourceCleanFailed', {
                            count: lastMigrationSummary.sourceCleanupFailedCount,
                          })}
                      {i18n.t('settings.migrationDoneClosing')}
                    </span>
                    {lastMigrationSummary.sourceCleanupError && (
                      <p className="mt-1 text-[11px] opacity-90">
                        {i18n.t('settings.migrationCleanupHint', {
                          error: lastMigrationSummary.sourceCleanupError,
                        })}
                      </p>
                    )}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={onDismissFeedback}
                  className="rounded p-0.5 opacity-70 hover:opacity-100"
                  aria-label={i18n.t('settings.dismissNoticeAria')}
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            )}

            {/* 同步完成结果反馈 */}
            {!isFlushing && lastFlushSummary && (
              <div
                className={`mt-3 flex items-start justify-between gap-3 rounded border px-4 py-2 text-xs ${
                  lastFlushSummary.failedCount > 0
                    ? 'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950/60 dark:text-amber-200'
                    : 'border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/60 dark:text-emerald-200'
                }`}
              >
                <div className="flex items-start gap-2">
                  {lastFlushSummary.failedCount > 0 ? (
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
                  ) : (
                    <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
                  )}
                  <div>
                    <span>
                      {i18n.t('settings.flushDonePrefix')}
                      <strong>{lastFlushSummary.syncedStagedCount}</strong>
                      {i18n.t('settings.flushDoneMetaPrefix')}
                      <strong>{lastFlushSummary.syncedMetaCount}</strong>
                      {i18n.t('settings.flushDoneMetaSuffix')}
                      {lastFlushSummary.failedCount > 0
                        ? i18n.t('settings.flushDoneFailedPart', {
                            count: lastFlushSummary.failedCount,
                          })
                        : i18n.t('settings.flushDoneTaxonomyPart')}
                      {i18n.t('settings.flushDoneClosing')}
                    </span>
                    {lastFlushSummary.errors.length > 0 && (
                      <p className="mt-1 text-[11px] opacity-90">
                        {i18n.t('settings.firstErrorLabel', {
                          message: lastFlushSummary.errors[0]?.message ?? '',
                        })}
                      </p>
                    )}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={onDismissFeedback}
                  className="rounded p-0.5 opacity-70 hover:opacity-100"
                  aria-label={i18n.t('settings.dismissNoticeAria')}
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            )}

            {/* 索引重建结果反馈 */}
            {!isRebuilding && lastRebuildSummary && (
              <div className="mt-3 flex items-center justify-between gap-3 rounded border border-emerald-200 bg-emerald-50 px-4 py-2 text-xs text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/60 dark:text-emerald-200">
                <div className="flex items-center gap-2">
                  <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
                  <span>
                    {i18n.t('settings.rebuildDonePrefix')}
                    <strong>{lastRebuildSummary.restoredItems}</strong>
                    {i18n.t('settings.rebuildDoneItemsUnit')}
                    <strong>{lastRebuildSummary.restoredFolders}</strong>
                    {i18n.t('settings.rebuildDoneFoldersUnit')}
                    <strong>{lastRebuildSummary.restoredTags}</strong>
                    {i18n.t('settings.rebuildDoneTagsUnit')}
                    {lastRebuildSummary.skippedFiles > 0
                      ? i18n.t('settings.rebuildDoneSkippedPart', {
                          count: lastRebuildSummary.skippedFiles,
                        })
                      : ''}
                    {i18n.t('settings.rebuildDoneClosing')}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={onDismissFeedback}
                  className="rounded p-0.5 opacity-70 hover:opacity-100"
                  aria-label={i18n.t('settings.dismissNoticeAria')}
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            )}

            {/* 错误提示 */}
            {vaultError && (
              <div className="mt-3 flex items-start justify-between gap-3 rounded border border-rose-200 bg-rose-50 px-4 py-2.5 text-xs text-rose-800 dark:border-rose-900 dark:bg-rose-950/60 dark:text-rose-200">
                <div className="flex items-start gap-2">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-rose-600 dark:text-rose-400" />
                  <div className="flex flex-col gap-1.5">
                    <span>
                      {typeof vaultError === 'string'
                        ? vaultError
                        : vaultError.message}
                    </span>
                    {typeof vaultError !== 'string' &&
                      (vaultError.helpUrl || vaultError.canRebind) && (
                        <div className="flex flex-wrap items-center gap-3 pt-0.5">
                          {vaultError.canRebind && (
                            <button
                              type="button"
                              onClick={() => void onBindVault()}
                              disabled={isBusy}
                              className="inline-flex items-center gap-1 rounded bg-rose-600 px-2.5 py-1 text-[11px] font-semibold text-white transition hover:bg-rose-700 disabled:opacity-60"
                            >
                              <FolderOpen className="h-3 w-3" />
                              <span>{i18n.t('settings.reselectDirBtn')}</span>
                            </button>
                          )}
                          {vaultError.helpUrl && (
                            <a
                              href={vaultError.helpUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-1 font-medium underline underline-offset-2"
                            >
                              <span>
                                {vaultError.helpLabel ??
                                  i18n.t('settings.viewPermissionHelp')}
                              </span>
                              <ExternalLink className="h-3 w-3" />
                            </a>
                          )}
                        </div>
                      )}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={onDismissFeedback}
                  className="rounded p-0.5 opacity-70 hover:opacity-100"
                  aria-label={i18n.t('settings.dismissErrorAria')}
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            )}

            <div className="mt-4 flex items-center justify-between gap-4 border-t border-[var(--cp-divider)] pt-4">
              <div className="min-w-0">
                <label
                  htmlFor="setting-auto-sync"
                  className="block text-xs font-semibold text-[var(--cp-text)]"
                >
                  {i18n.t('settings.autoSyncOnOpenLabel')}
                </label>
                <p className="mt-0.5 text-xs text-[var(--cp-text-muted)]">
                  {i18n.t('settings.autoSyncOnOpenDesc')}
                </p>
              </div>
              <ToggleSwitch
                id="setting-auto-sync"
                checked={preferences.autoSyncOnLibraryOpen}
                ariaLabel={i18n.t('settings.autoSyncOnOpenLabel')}
                onChange={(checked) =>
                  void handlePatchPreferences(
                    { autoSyncOnLibraryOpen: checked },
                    checked
                      ? i18n.t('settings.autoSyncOnOpenEnabledNotice')
                      : i18n.t('settings.autoSyncOnOpenDisabledNotice'),
                  )
                }
              />
            </div>
          </section>

          {/* 3. 浏览器缓存与存储 */}
          <section className="rounded-md border border-[var(--cp-border)] bg-[var(--cp-surface)] p-5">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <HardDrive className="h-4 w-4 text-[var(--cp-accent)]" />
                <h3 className="text-sm font-semibold text-[var(--cp-text)]">
                  {i18n.t('settings.sectionBrowserCache')}
                </h3>
              </div>
              <button
                type="button"
                onClick={() => void refreshStorageEstimate()}
                disabled={loadingStorage}
                className="inline-flex items-center gap-1 rounded border border-[var(--cp-border)] bg-[var(--cp-surface)] px-2.5 py-1 text-xs font-medium text-[var(--cp-text-secondary)] transition hover:border-[var(--cp-border-strong)] hover:text-[var(--cp-text)] disabled:opacity-60"
              >
                <RefreshCw
                  className={`h-3.5 w-3.5 ${loadingStorage ? 'animate-spin' : ''}`}
                />
                <span>{i18n.t('settings.refreshStatsBtn')}</span>
              </button>
            </div>

            {/* 总占用与配额条 */}
            <div className="rounded border border-[var(--cp-border)] bg-[var(--cp-canvas)] p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <div>
                  <span className="text-xs text-[var(--cp-text-muted)]">
                    {i18n.t('settings.totalCacheUsageLabel')}
                  </span>
                  <p
                    data-testid="browser-cache-total-size"
                    className="mt-0.5 text-xl font-bold tabular-nums text-[var(--cp-text)]"
                  >
                    {storageEstimate
                      ? formatBytes(storageEstimate.totalUsageBytes)
                      : loadingStorage
                        ? i18n.t('settings.calculating')
                        : '0 B'}
                  </p>
                </div>
                {storageEstimate && storageEstimate.quotaBytes > 0 && (
                  <span className="text-xs tabular-nums text-[var(--cp-text-muted)]">
                    {i18n.t('settings.availableQuota', {
                      size: formatBytes(storageEstimate.quotaBytes),
                    })}
                  </span>
                )}
              </div>

              {storageEstimate && storageEstimate.quotaBytes > 0 && (
                <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-[var(--cp-muted)]">
                  <div
                    className="h-full rounded-full bg-[var(--cp-accent)] transition-all duration-300"
                    style={{ width: `${usagePercent}%` }}
                  />
                </div>
              )}

              <div className="mt-3.5 grid grid-cols-1 gap-2.5 sm:grid-cols-3">
                <div className="rounded border border-[var(--cp-border)] bg-[var(--cp-surface)] px-3 py-2">
                  <p className="text-[11px] text-[var(--cp-text-muted)]">
                    {i18n.t('settings.opfsStagedMediaLabel')}
                  </p>
                  <p
                    data-testid="browser-cache-opfs-size"
                    className="mt-0.5 text-sm font-semibold tabular-nums text-[var(--cp-text)]"
                  >
                    {storageEstimate
                      ? formatBytes(storageEstimate.opfsBytes)
                      : '-'}
                  </p>
                </div>
                <div className="rounded border border-[var(--cp-border)] bg-[var(--cp-surface)] px-3 py-2">
                  <p className="text-[11px] text-[var(--cp-text-muted)]">
                    {i18n.t('settings.indexedDbCacheLabel')}
                  </p>
                  <p
                    data-testid="browser-cache-index-size"
                    className="mt-0.5 text-sm font-semibold tabular-nums text-[var(--cp-text)]"
                  >
                    {storageEstimate
                      ? formatBytes(storageEstimate.indexCacheBytes)
                      : '-'}
                  </p>
                </div>
                <div className="rounded border border-[var(--cp-border)] bg-[var(--cp-surface)] px-3 py-2">
                  <p className="text-[11px] text-[var(--cp-text-muted)]">
                    {i18n.t('settings.currentIndexRecordsLabel')}
                  </p>
                  <p
                    data-testid="browser-cache-record-counts"
                    className="mt-0.5 text-sm font-semibold tabular-nums text-[var(--cp-text)]"
                  >
                    {i18n.t('settings.recordCountsSummary', {
                      items: totalItemCount,
                      folders: totalFolderCount,
                      tags: totalTagCount,
                    })}
                  </p>
                </div>
              </div>
            </div>

            <div className="mt-4 flex flex-wrap items-center justify-between gap-4 border-t border-[var(--cp-divider)] pt-4">
              <div className="min-w-0">
                <p className="text-xs font-semibold text-[var(--cp-text)]">
                  {i18n.t('settings.clearCacheLabel')}
                </p>
                <p className="mt-0.5 text-xs text-[var(--cp-text-muted)]">
                  {i18n.t('settings.clearCacheDesc')}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setConfirmModal('clear_cache')}
                disabled={isBusy}
                className="inline-flex items-center gap-1.5 rounded border border-rose-200 bg-rose-50 px-3 py-1.5 text-xs font-semibold text-rose-700 transition hover:bg-rose-100 disabled:opacity-60 dark:border-rose-900 dark:bg-rose-950/70 dark:text-rose-300 dark:hover:bg-rose-950"
              >
                <Trash2 className="h-3.5 w-3.5" />
                <span>{i18n.t('settings.clearCacheBtn')}</span>
              </button>
            </div>
          </section>

          {/* 4. 控制台显示偏好 */}
          <section className="rounded-md border border-[var(--cp-border)] bg-[var(--cp-surface)] p-5">
            <div className="mb-4 flex items-center gap-2">
              <LayoutGrid className="h-4 w-4 text-[var(--cp-accent)]" />
              <h3 className="text-sm font-semibold text-[var(--cp-text)]">
                {i18n.t('settings.sectionDisplay')}
              </h3>
            </div>

            <div className="divide-y divide-[var(--cp-divider)]">
              <div className="flex flex-wrap items-center justify-between gap-4 py-3.5 first:pt-0">
                <div className="min-w-0">
                  <p className="text-xs font-semibold text-[var(--cp-text)]">
                    {i18n.t('settings.defaultViewLabel')}
                  </p>
                  <p className="mt-0.5 text-xs text-[var(--cp-text-muted)]">
                    {i18n.t('settings.defaultViewDesc')}
                  </p>
                </div>
                <div className="inline-flex rounded border border-[var(--cp-border)] bg-[var(--cp-muted)] p-0.5">
                  {(
                    [
                      {
                        value: 'grid',
                        label: i18n.t('settings.viewGrid'),
                        icon: LayoutGrid,
                      },
                      {
                        value: 'list',
                        label: i18n.t('settings.viewList'),
                        icon: List,
                      },
                    ] as const
                  ).map((opt) => {
                    const Icon = opt.icon;
                    const active = preferences.defaultViewMode === opt.value;
                    return (
                      <button
                        key={opt.value}
                        type="button"
                        onClick={() =>
                          void handlePatchPreferences(
                            { defaultViewMode: opt.value as LibraryViewMode },
                            i18n.t('settings.defaultViewNotice', {
                              label: opt.label,
                            }),
                          )
                        }
                        className={`inline-flex items-center gap-1.5 rounded px-3 py-1 text-xs font-medium transition ${
                          active
                            ? 'bg-[var(--cp-surface)] font-semibold text-[var(--cp-text-active)]'
                            : 'text-[var(--cp-text-secondary)] hover:text-[var(--cp-text)]'
                        }`}
                      >
                        <Icon className="h-3.5 w-3.5" />
                        <span>{opt.label}</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-4 py-3.5">
                <div className="min-w-0">
                  <label
                    htmlFor="setting-default-sort"
                    className="block text-xs font-semibold text-[var(--cp-text)]"
                  >
                    {i18n.t('settings.defaultSortLabel')}
                  </label>
                  <p className="mt-0.5 text-xs text-[var(--cp-text-muted)]">
                    {i18n.t('settings.defaultSortDesc')}
                  </p>
                </div>
                <select
                  id="setting-default-sort"
                  value={preferences.defaultSortBy}
                  onChange={(e) =>
                    void handlePatchPreferences(
                      { defaultSortBy: e.target.value as LibrarySortOption },
                      i18n.t('settings.defaultSortUpdatedNotice'),
                    )
                  }
                  className="min-w-[160px] rounded border border-[var(--cp-border)] bg-[var(--cp-surface)] px-3 py-1.5 text-xs font-medium text-[var(--cp-text)] transition hover:border-[var(--cp-border-strong)] focus:border-[var(--cp-accent)] focus:outline-none"
                >
                  <option value="collectedAt">{i18n.t('grid.sortCollectedAt')}</option>
                  <option value="publishedAt">{i18n.t('grid.sortPublishedAt')}</option>
                  <option value="totalSizeBytes">{i18n.t('grid.sortTotalSizeBytes')}</option>
                </select>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-4 pt-3.5">
                <div className="min-w-0">
                  <label
                    htmlFor="setting-ui-language"
                    className="block text-xs font-semibold text-[var(--cp-text)]"
                  >
                    {i18n.t('settings.languageLabel')}
                  </label>
                  <p className="mt-0.5 text-xs text-[var(--cp-text-muted)]">
                    {i18n.t('settings.languageDesc')}
                  </p>
                </div>
                <select
                  id="setting-ui-language"
                  data-testid="setting-ui-language"
                  value={uiLanguage}
                  onChange={(e) => {
                    const nextLang = e.target.value as UiLanguage;
                    void setUiLanguage(nextLang).then(() => {
                      const label =
                        nextLang === 'zh_CN'
                          ? i18n.t('settings.languageZhCN')
                          : nextLang === 'en'
                            ? i18n.t('settings.languageEn')
                            : i18n.t('settings.languageAuto');
                      setSavingNotice(
                        i18n.t('settings.languageUpdatedNotice', { label }),
                      );
                    });
                  }}
                  className="min-w-[160px] rounded border border-[var(--cp-border)] bg-[var(--cp-surface)] px-3 py-1.5 text-xs font-medium text-[var(--cp-text)] transition hover:border-[var(--cp-border-strong)] focus:border-[var(--cp-accent)] focus:outline-none"
                >
                  <option value="auto">{i18n.t('settings.languageAuto')}</option>
                  <option value="zh_CN">{i18n.t('settings.languageZhCN')}</option>
                  <option value="en">{i18n.t('settings.languageEn')}</option>
                </select>
              </div>
            </div>
          </section>
        </div>
      </div>

      {/* 目标目录已初始化：合并或覆盖确认弹窗 */}
      {pendingMigrationConflict !== null && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--cp-scrim)] p-4"
          onClick={onCancelMigrationConflict}
        >
          <div
            role="dialog"
            aria-modal="true"
            data-testid="vault-migration-conflict-dialog"
            className="w-full max-w-md rounded-md border border-[var(--cp-border-strong)] bg-[var(--cp-surface)] p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start gap-3">
              <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded bg-amber-50 text-amber-600 dark:bg-amber-950/70 dark:text-amber-400">
                <FolderSync className="h-5 w-5" />
              </span>
              <div className="min-w-0">
                <h3 className="text-base font-semibold text-[var(--cp-text)]">
                  {i18n.t('settings.migrationConflictTitle')}
                </h3>
                <p className="mt-1.5 text-xs leading-relaxed text-[var(--cp-text-secondary)]">
                  {i18n.t('settings.migrationConflictIntro1')}
                  <code className="rounded bg-[var(--cp-muted)] px-1 py-0.5 font-semibold text-[var(--cp-text)]">
                    {pendingMigrationConflict.targetName}
                  </code>
                  {i18n.t('settings.migrationConflictIntro2')}
                  <code className="rounded bg-[var(--cp-muted)] px-1 py-0.5 font-semibold text-[var(--cp-text)]">
                    {pendingMigrationConflict.sourceName}
                  </code>
                  {i18n.t('settings.migrationConflictIntro3')}
                </p>
                <ul className="mt-2.5 space-y-1.5 rounded border border-[var(--cp-border)] bg-[var(--cp-canvas)] p-2.5 text-xs text-[var(--cp-text-secondary)]">
                  <li>
                    <strong className="text-[var(--cp-text-active)]">
                      {i18n.t('settings.migrationConflictMergeTitle')}
                    </strong>
                    {i18n.t('settings.migrationConflictMergeDesc')}
                  </li>
                  <li>
                    <strong className="text-rose-700 dark:text-rose-400">
                      {i18n.t('settings.migrationConflictOverwriteTitle')}
                    </strong>
                    {i18n.t('settings.migrationConflictOverwriteDesc')}
                  </li>
                </ul>
              </div>
            </div>
            <div className="mt-5 flex flex-wrap justify-end gap-2">
              <button
                type="button"
                onClick={onCancelMigrationConflict}
                className="rounded border border-[var(--cp-border)] bg-[var(--cp-surface)] px-3.5 py-2 text-xs font-medium text-[var(--cp-text-secondary)] hover:border-[var(--cp-border-strong)] hover:text-[var(--cp-text)]"
              >
                {i18n.t('common.cancel')}
              </button>
              <button
                type="button"
                onClick={() => void onResolveMigrationConflict('overwrite')}
                className="rounded border border-rose-200 bg-rose-50 px-3.5 py-2 text-xs font-semibold text-rose-700 hover:bg-rose-100 dark:border-rose-900 dark:bg-rose-950/70 dark:text-rose-300"
              >
                {i18n.t('settings.migrationConflictOverwriteBtn')}
              </button>
              <button
                type="button"
                onClick={() => void onResolveMigrationConflict('merge')}
                className="rounded bg-[var(--cp-accent)] px-3.5 py-2 text-xs font-semibold text-[var(--cp-on-accent)] hover:bg-[var(--cp-accent-hover)]"
              >
                {i18n.t('settings.migrationConflictMergeBtn')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 二次确认弹窗：重建索引 / 清空浏览器缓存 */}
      {confirmModal !== null && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--cp-scrim)] p-4"
          onClick={() => !isClearingCache && setConfirmModal(null)}
        >
          <div
            role="dialog"
            aria-modal="true"
            className="w-full max-w-md rounded-md border border-[var(--cp-border-strong)] bg-[var(--cp-surface)] p-5"
            onClick={(e) => e.stopPropagation()}
          >
            {confirmModal === 'rebuild' ? (
              <>
                <div className="flex items-start gap-3">
                  <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded bg-[var(--cp-active)] text-[var(--cp-accent)]">
                    <DatabaseBackup className="h-5 w-5" />
                  </span>
                  <div>
                    <h3 className="text-base font-semibold text-[var(--cp-text)]">
                      {i18n.t('settings.rebuildConfirmTitle')}
                    </h3>
                    <p className="mt-1.5 text-xs leading-relaxed text-[var(--cp-text-secondary)]">
                      {i18n.t('settings.rebuildConfirmDesc1')}
                      <code className="rounded bg-[var(--cp-muted)] px-1 py-0.5 font-semibold text-[var(--cp-text)]">
                        {vaultTargetName ?? vaultHandle?.name}
                      </code>
                      {i18n.t('settings.rebuildConfirmDesc2')}
                      <code>meta.json</code>
                      {i18n.t('settings.rebuildConfirmDescAnd')}
                      <code>taxonomy.json</code>
                      {i18n.t('settings.rebuildConfirmDesc3')}
                    </p>
                    {pendingSyncCount > 0 && (
                      <p className="mt-2 rounded bg-amber-50 px-2.5 py-2 text-xs font-medium text-amber-800 dark:bg-amber-950/60 dark:text-amber-200">
                        {i18n.t('settings.rebuildConfirmPendingWarn', {
                          count: pendingSyncCount,
                        })}
                      </p>
                    )}
                  </div>
                </div>
                <div className="mt-5 flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setConfirmModal(null)}
                    className="rounded border border-[var(--cp-border)] bg-[var(--cp-surface)] px-3.5 py-2 text-xs font-medium text-[var(--cp-text-secondary)] hover:border-[var(--cp-border-strong)] hover:text-[var(--cp-text)]"
                  >
                    {i18n.t('common.cancel')}
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleConfirmRebuild()}
                    className="rounded bg-[var(--cp-accent)] px-3.5 py-2 text-xs font-semibold text-[var(--cp-on-accent)] hover:bg-[var(--cp-accent-hover)]"
                  >
                    {i18n.t('settings.confirmRebuildBtn')}
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="flex items-start gap-3">
                  <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded bg-rose-50 text-rose-600 dark:bg-rose-950/70 dark:text-rose-400">
                    <AlertTriangle className="h-5 w-5" />
                  </span>
                  <div>
                    <h3 className="text-base font-semibold text-[var(--cp-text)]">
                      {i18n.t('settings.clearCacheConfirmTitle')}
                    </h3>
                    <p className="mt-1.5 text-xs leading-relaxed text-[var(--cp-text-secondary)]">
                      {i18n.t('settings.clearCacheConfirmDesc1')}
                      <code>items</code>, <code>folders</code>, <code>tags</code>,{' '}
                      <code>tasks</code>
                      {i18n.t('settings.clearCacheConfirmDesc2')}
                    </p>
                    <p className="mt-2 rounded border border-emerald-200 bg-emerald-50 px-2.5 py-2 text-xs font-medium text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/60 dark:text-emerald-200">
                      {i18n.t('settings.clearCacheConfirmPromise')}
                    </p>
                  </div>
                </div>
                <div className="mt-5 flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setConfirmModal(null)}
                    disabled={isClearingCache}
                    className="rounded border border-[var(--cp-border)] bg-[var(--cp-surface)] px-3.5 py-2 text-xs font-medium text-[var(--cp-text-secondary)] hover:border-[var(--cp-border-strong)] hover:text-[var(--cp-text)] disabled:opacity-50"
                  >
                    {i18n.t('common.cancel')}
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleConfirmClearCache()}
                    disabled={isClearingCache}
                    className="inline-flex items-center gap-1.5 rounded bg-rose-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-rose-700 disabled:opacity-60"
                  >
                    {isClearingCache && (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    )}
                    <span>{i18n.t('settings.confirmClearCacheBtn')}</span>
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
