import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
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
  getBrowserStorageEstimate,
  type BrowserStorageEstimate,
} from '@/storage/opfs.ts';
import type {
  FlushProgress,
  FlushSummary,
  RebuildProgress,
  RebuildSummary,
  VaultPermissionStatus,
} from '@/storage/vault.ts';
import type {
  FolderNode,
  LibrarySortOption,
  LibraryViewMode,
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
  showRebuildSuggestion: boolean;
  vaultError: string | VaultActionError | null;
  focusVaultSectionTick: number;
  onUpdatePreferences: (patch: Partial<UserPreferences>) => Promise<void>;
  onBindVault: () => Promise<void>;
  onRequestPermissionAndSync: () => Promise<void>;
  onFlushToVault: () => Promise<void>;
  onRebuildIndex: () => Promise<void>;
  onClearBrowserCache: () => Promise<void>;
  onDismissSuggestion: () => void;
  onDismissFeedback: () => void;
}

const FLUSH_PHASE_LABEL: Record<FlushProgress['phase'], string> = {
  preparing: '准备本地目录结构与 README.txt...',
  flushing_staged: '正在将 OPFS 暂存媒体流式落盘至 CollectVault',
  syncing_meta: '正在回写条目元数据 meta.json',
  writing_taxonomy: '正在回写文件夹与标签 taxonomy.json',
  done: '同步完成',
};

const REBUILD_PHASE_LABEL: Record<RebuildProgress['phase'], string> = {
  scanning: '正在扫描 CollectVault/items 下的 meta.json 并生成缩略图',
  importing: '正在原子写入浏览器 IndexedDB 索引',
  done: '索引重建完成',
};

interface FlatFolderOption {
  id: string;
  label: string;
}

const CONCURRENCY_OPTIONS = [1, 2, 3, 4, 5] as const;

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
      className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-indigo-400 focus:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-60 ${
        checked ? 'bg-indigo-600' : 'bg-slate-300'
      }`}
    >
      <span
        className={`inline-block h-4 w-4 transform rounded-full bg-white shadow-xs transition-transform ${
          checked ? 'translate-x-6' : 'translate-x-1'
        }`}
      />
    </button>
  );
}

export function SettingsPanel({
  preferences,
  folders,
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
  showRebuildSuggestion,
  vaultError,
  focusVaultSectionTick,
  onUpdatePreferences,
  onBindVault,
  onRequestPermissionAndSync,
  onFlushToVault,
  onRebuildIndex,
  onClearBrowserCache,
  onDismissSuggestion,
  onDismissFeedback,
}: SettingsPanelProps) {
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
  const isBusy = isFlushing || isRebuilding || isClearingCache;
  const flushPercent =
    flushProgress && flushProgress.total > 0
      ? Math.min(100, Math.round((flushProgress.current / flushProgress.total) * 100))
      : flushProgress?.phase === 'done'
        ? 100
        : 12;

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
        `无法自动打开快捷键设置页，请在地址栏手动访问 chrome://extensions/shortcuts（${getErrorMessage(error)}）`,
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
      setSavingNotice('已清空浏览器缓存索引，硬盘 CollectVault 文件未受影响');
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

  const vaultStatusBadge =
    permissionState === 'granted' && vaultHandle
      ? {
          label: '已授权就绪',
          className:
            'bg-emerald-50 text-emerald-700 ring-1 ring-inset ring-emerald-200',
        }
      : vaultHandle
        ? {
            label: '需要重新授权',
            className:
              'bg-amber-50 text-amber-800 ring-1 ring-inset ring-amber-200',
          }
        : {
            label: '尚未绑定',
            className:
              'bg-slate-100 text-slate-600 ring-1 ring-inset ring-slate-200',
          };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {/* 顶部标题栏 */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-white/90 px-6 py-3.5">
        <div className="flex items-center gap-2.5">
          <span className="inline-flex h-8 w-8 items-center justify-center rounded-xl bg-indigo-50 text-indigo-600">
            <Settings className="h-4 w-4" />
          </span>
          <div>
            <h2 className="text-sm font-bold text-slate-900">插件设置</h2>
            <p className="text-xs text-slate-500">
              管理采集浮层、本地同步目录、浏览器缓存与控制台偏好
            </p>
          </div>
        </div>

        {savingNotice && (
          <span className="rounded-lg bg-emerald-50 px-3 py-1 text-xs font-medium text-emerald-700 ring-1 ring-inset ring-emerald-200">
            {savingNotice}
          </span>
        )}
      </div>

      {/* 主体设置卡片流 */}
      <div className="flex-1 overflow-y-auto px-6 py-5">
        <div className="mx-auto flex max-w-4xl flex-col gap-5 pb-8">
          {/* 1. 采集与交互 */}
          <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-2xs">
            <div className="mb-4 flex items-center gap-2">
              <SlidersHorizontal className="h-4 w-4 text-indigo-600" />
              <h3 className="text-sm font-semibold text-slate-900">
                采集与交互
              </h3>
            </div>

            <div className="divide-y divide-slate-100">
              {/* 悬浮图标开关 */}
              <div className="flex items-center justify-between gap-4 py-3.5 first:pt-0">
                <div className="min-w-0">
                  <label
                    htmlFor="setting-floating-button"
                    className="block text-xs font-semibold text-slate-900"
                  >
                    在支持的网页显示悬浮收藏图标
                  </label>
                  <p className="mt-0.5 text-xs text-slate-500">
                    关闭后将隐藏页面右下角悬浮按钮，仍可通过原站收藏或快捷键触发采集（对已打开页面即时生效）
                  </p>
                </div>
                <ToggleSwitch
                  id="setting-floating-button"
                  checked={preferences.floatingButtonEnabled}
                  ariaLabel="在支持的网页显示悬浮收藏图标"
                  onChange={(checked) =>
                    void handlePatchPreferences(
                      { floatingButtonEnabled: checked },
                      checked ? '已开启页面悬浮图标' : '已隐藏页面悬浮图标',
                    )
                  }
                />
              </div>

              {/* 快捷收藏默认保存文件夹 */}
              <div className="flex flex-wrap items-center justify-between gap-4 py-3.5">
                <div className="min-w-0">
                  <label
                    htmlFor="setting-default-folder"
                    className="block text-xs font-semibold text-slate-900"
                  >
                    快捷收藏默认保存文件夹
                  </label>
                  <p className="mt-0.5 text-xs text-slate-500">
                    通过原站收藏、悬浮按钮或快捷键新采集的作品将自动归入该目录
                  </p>
                </div>
                <select
                  id="setting-default-folder"
                  value={preferences.defaultFolderId ?? ''}
                  onChange={(e) => {
                    const nextFolderId = e.target.value || null;
                    void handlePatchPreferences(
                      { defaultFolderId: nextFolderId },
                      '已更新默认保存文件夹',
                    );
                  }}
                  className="min-w-[200px] rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 transition hover:border-slate-300 focus:border-indigo-400 focus:outline-none"
                >
                  <option value="">未分类（根目录）</option>
                  {folderOptions.map((opt) => (
                    <option key={opt.id} value={opt.id}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>

              {/* 最大并发下载任务数 */}
              <div className="flex flex-wrap items-center justify-between gap-4 py-3.5">
                <div className="min-w-0">
                  <p className="text-xs font-semibold text-slate-900">
                    最大并发下载任务数
                  </p>
                  <p className="mt-0.5 text-xs text-slate-500">
                    控制后台同时下载的媒体数量（1~5），数值过大可能触发站点限流
                  </p>
                </div>
                <div
                  className="inline-flex rounded-lg border border-slate-200 bg-slate-100 p-0.5"
                  role="group"
                  aria-label="最大并发下载任务数"
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
                            `并发下载数已设为 ${num}`,
                          )
                        }
                        className={`min-w-8 rounded-md px-2.5 py-1 text-xs font-semibold tabular-nums transition ${
                          active
                            ? 'bg-white text-indigo-700 shadow-2xs'
                            : 'text-slate-600 hover:text-slate-900'
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
                  <p className="flex items-center gap-1.5 text-xs font-semibold text-slate-900">
                    <Keyboard className="h-3.5 w-3.5 text-slate-400" />
                    <span>全局采集快捷键</span>
                  </p>
                  <p className="mt-0.5 text-xs text-slate-500">
                    在支持的平台页面按下快捷键即可一键触发离线采集，可在浏览器扩展快捷键页自定义
                  </p>
                  {shortcutNotice && (
                    <p className="mt-1.5 text-[11px] text-amber-700">
                      {shortcutNotice}
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <kbd className="rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1 font-mono text-xs font-semibold text-slate-700">
                    {shortcutText}
                  </kbd>
                  <button
                    type="button"
                    onClick={() => void handleOpenShortcutsPage()}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 transition hover:border-indigo-300 hover:bg-indigo-50/50 hover:text-indigo-700"
                  >
                    <span>修改快捷键</span>
                    <ExternalLink className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            </div>
          </section>

          {/* 2. 本地同步目录（CollectVault） */}
          <section
            id="settings-vault-section"
            data-testid="settings-vault-section"
            ref={vaultSectionRef}
            className={`scroll-mt-4 rounded-2xl border bg-white p-5 shadow-2xs transition ${
              highlightVaultSection
                ? 'border-indigo-400 ring-2 ring-indigo-200'
                : 'border-slate-200'
            }`}
          >
            <div className="mb-4 flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                {permissionState === 'granted' && vaultHandle ? (
                  <FolderCheck className="h-4 w-4 text-emerald-600" />
                ) : (
                  <FolderKey className="h-4 w-4 text-indigo-600" />
                )}
                <h3 className="text-sm font-semibold text-slate-900">
                  本地同步目录（CollectVault）
                </h3>
              </div>
              <span
                className={`rounded-full px-2.5 py-0.5 text-[11px] font-medium ${vaultStatusBadge.className}`}
              >
                {vaultStatusBadge.label}
              </span>
            </div>

            <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-xs text-slate-500">当前绑定的本地目录</p>
                  <p className="mt-1 flex items-center gap-2 text-sm font-semibold text-slate-900">
                    <code className="rounded-md bg-white px-2 py-0.5 text-xs font-semibold text-indigo-700 ring-1 ring-slate-200">
                      {vaultHandle ? vaultHandle.name : '未绑定本地目录'}
                    </code>
                  </p>
                  <p
                    className="mt-1.5 text-[11px] text-slate-500"
                    title={lastSyncAt ? formatDateTime(lastSyncAt) : '尚未同步'}
                  >
                    上次同步：
                    {lastSyncAt ? formatRelativeTime(lastSyncAt) : '尚未同步'}
                    {' · '}待同步：
                    <strong
                      className={
                        pendingSyncCount > 0
                          ? 'text-amber-700'
                          : 'text-emerald-700'
                      }
                    >
                      {pendingSyncCount}
                    </strong>
                    {pendingSyncCount > 0
                      ? `（暂存媒体 ${stagedCount} / 待回写元数据 ${metaDirtyCount}）`
                      : ''}
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void onBindVault()}
                    disabled={isBusy}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white shadow-2xs transition hover:bg-indigo-700 disabled:opacity-60"
                  >
                    <FolderOpen className="h-3.5 w-3.5" />
                    <span>
                      {vaultHandle ? '切换本地目录' : '选择本地同步目录'}
                    </span>
                  </button>

                  {vaultHandle && permissionState !== 'granted' && (
                    <button
                      type="button"
                      onClick={() => void onRequestPermissionAndSync()}
                      disabled={isBusy}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-1.5 text-xs font-semibold text-indigo-700 transition hover:bg-indigo-100 disabled:opacity-60"
                    >
                      <ShieldCheck className="h-3.5 w-3.5" />
                      <span>授权访问并同步</span>
                    </button>
                  )}

                  {vaultHandle && permissionState === 'granted' && (
                    <button
                      type="button"
                      onClick={() => void onFlushToVault()}
                      disabled={isBusy}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 transition hover:border-slate-300 hover:bg-slate-50 disabled:opacity-60"
                    >
                      {isFlushing ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <FolderSync className="h-3.5 w-3.5 text-indigo-600" />
                      )}
                      <span>{isFlushing ? '同步中...' : '立即同步'}</span>
                    </button>
                  )}

                  {vaultHandle && (
                    <button
                      type="button"
                      onClick={() => setConfirmModal('rebuild')}
                      disabled={isBusy}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 transition hover:border-slate-300 hover:bg-slate-50 disabled:opacity-60"
                    >
                      {isRebuilding ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <DatabaseBackup className="h-3.5 w-3.5 text-slate-500" />
                      )}
                      <span>{isRebuilding ? '重建中...' : '从本地重建索引'}</span>
                    </button>
                  )}
                </div>
              </div>
            </div>

            {/* 绑定已有 Vault 且 IndexedDB 为空时的一键重建引导 */}
            {showRebuildSuggestion &&
              vaultHandle &&
              permissionState === 'granted' &&
              !isRebuilding && (
                <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-indigo-200 bg-indigo-50 px-4 py-2.5 text-xs text-indigo-900">
                  <div className="flex items-center gap-2">
                    <RefreshCw className="h-4 w-4 shrink-0 text-indigo-600" />
                    <span>
                      检测到目录 <strong>{vaultHandle.name}</strong> 中已有 CollectVault 数据且当前浏览器索引为空，建议一键重建索引以恢复全部收藏与分类。
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        onDismissSuggestion();
                        void onRebuildIndex();
                      }}
                      className="rounded-lg bg-indigo-600 px-3 py-1 text-xs font-semibold text-white transition hover:bg-indigo-700"
                    >
                      立即重建索引
                    </button>
                    <button
                      type="button"
                      onClick={onDismissSuggestion}
                      className="rounded-lg px-2 py-1 text-xs font-medium text-indigo-700 hover:bg-indigo-100"
                    >
                      稍后再说
                    </button>
                  </div>
                </div>
              )}

            {/* 同步进度条 */}
            {isFlushing && flushProgress && (
              <div className="mt-3 rounded-xl border border-indigo-100 bg-indigo-50/50 px-4 py-2.5">
                <div className="flex items-center justify-between gap-2 text-xs">
                  <span className="font-medium text-indigo-900">
                    {FLUSH_PHASE_LABEL[flushProgress.phase]}
                    {flushProgress.currentTitle
                      ? `：${flushProgress.currentTitle}`
                      : ''}
                  </span>
                  <span className="shrink-0 font-semibold tabular-nums text-indigo-700">
                    {flushProgress.total > 0
                      ? `${flushProgress.current} / ${flushProgress.total}`
                      : `${flushPercent}%`}
                  </span>
                </div>
                <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-indigo-100">
                  <div
                    className="h-full rounded-full bg-indigo-600 transition-all duration-300"
                    style={{ width: `${flushPercent}%` }}
                  />
                </div>
              </div>
            )}

            {/* 索引重建进度条 */}
            {isRebuilding && rebuildProgress && (
              <div className="mt-3 rounded-xl border border-sky-100 bg-sky-50/70 px-4 py-2.5">
                <div className="flex items-center justify-between gap-2 text-xs">
                  <span className="flex items-center gap-2 font-medium text-sky-900">
                    <Loader2 className="h-3.5 w-3.5 animate-spin text-sky-600" />
                    <span>
                      {REBUILD_PHASE_LABEL[rebuildProgress.phase]}
                      {rebuildProgress.currentTitle
                        ? `：${rebuildProgress.currentTitle}`
                        : ''}
                    </span>
                  </span>
                  <span className="shrink-0 font-semibold tabular-nums text-sky-700">
                    已扫描 {rebuildProgress.scannedItems} 条
                  </span>
                </div>
              </div>
            )}

            {/* 同步完成结果反馈 */}
            {!isFlushing && lastFlushSummary && (
              <div
                className={`mt-3 flex items-start justify-between gap-3 rounded-xl border px-4 py-2 text-xs ${
                  lastFlushSummary.failedCount > 0
                    ? 'border-amber-200 bg-amber-50 text-amber-900'
                    : 'border-emerald-200 bg-emerald-50 text-emerald-900'
                }`}
              >
                <div className="flex items-start gap-2">
                  {lastFlushSummary.failedCount > 0 ? (
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
                  ) : (
                    <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
                  )}
                  <div>
                    <span>
                      同步完成：落盘媒体条目{' '}
                      <strong>{lastFlushSummary.syncedStagedCount}</strong> 条，回写元数据{' '}
                      <strong>{lastFlushSummary.syncedMetaCount}</strong> 条
                      {lastFlushSummary.failedCount > 0
                        ? `，失败 ${lastFlushSummary.failedCount} 条`
                        : '，taxonomy.json 已同步更新'}
                      。
                    </span>
                    {lastFlushSummary.errors.length > 0 && (
                      <p className="mt-1 text-[11px] text-amber-800">
                        首个错误：{lastFlushSummary.errors[0]?.message}
                      </p>
                    )}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={onDismissFeedback}
                  className="rounded p-0.5 opacity-70 hover:bg-black/5 hover:opacity-100"
                  aria-label="关闭通知"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            )}

            {/* 索引重建结果反馈 */}
            {!isRebuilding && lastRebuildSummary && (
              <div className="mt-3 flex items-center justify-between gap-3 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-2 text-xs text-emerald-900">
                <div className="flex items-center gap-2">
                  <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" />
                  <span>
                    索引重建成功：已恢复{' '}
                    <strong>{lastRebuildSummary.restoredItems}</strong> 条收藏、
                    <strong>{lastRebuildSummary.restoredFolders}</strong> 个文件夹、
                    <strong>{lastRebuildSummary.restoredTags}</strong> 个标签
                    {lastRebuildSummary.skippedFiles > 0
                      ? `（跳过 ${lastRebuildSummary.skippedFiles} 个无效或重复文件）`
                      : ''}
                    。
                  </span>
                </div>
                <button
                  type="button"
                  onClick={onDismissFeedback}
                  className="rounded p-0.5 opacity-70 hover:bg-black/5 hover:opacity-100"
                  aria-label="关闭通知"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            )}

            {/* 错误提示 */}
            {vaultError && (
              <div className="mt-3 flex items-start justify-between gap-3 rounded-xl border border-rose-200 bg-rose-50 px-4 py-2.5 text-xs text-rose-800">
                <div className="flex items-start gap-2">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-rose-600" />
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
                              className="inline-flex items-center gap-1 rounded-md bg-rose-600 px-2.5 py-1 text-[11px] font-semibold text-white transition hover:bg-rose-700 disabled:opacity-60"
                            >
                              <FolderOpen className="h-3 w-3" />
                              <span>重新选择目录</span>
                            </button>
                          )}
                          {vaultError.helpUrl && (
                            <a
                              href={vaultError.helpUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-1 font-medium text-rose-700 underline decoration-rose-400 underline-offset-2 hover:text-rose-900"
                            >
                              <span>
                                {vaultError.helpLabel ?? '查看权限问题解决办法'}
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
                  className="rounded p-0.5 text-rose-600 hover:bg-rose-100"
                  aria-label="关闭错误"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            )}

            <div className="mt-4 flex items-center justify-between gap-4 border-t border-slate-100 pt-4">
              <div className="min-w-0">
                <label
                  htmlFor="setting-auto-sync"
                  className="block text-xs font-semibold text-slate-900"
                >
                  打开控制台时自动同步暂存内容
                </label>
                <p className="mt-0.5 text-xs text-slate-500">
                  已获得本地目录读写权限时，打开控制台自动将浏览器暂存媒体与元数据变更落盘至 CollectVault
                </p>
              </div>
              <ToggleSwitch
                id="setting-auto-sync"
                checked={preferences.autoSyncOnLibraryOpen}
                ariaLabel="打开控制台时自动同步暂存内容"
                onChange={(checked) =>
                  void handlePatchPreferences(
                    { autoSyncOnLibraryOpen: checked },
                    checked ? '已开启打开控制台自动同步' : '已关闭自动同步',
                  )
                }
              />
            </div>
          </section>

          {/* 3. 浏览器缓存与存储 */}
          <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-2xs">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <HardDrive className="h-4 w-4 text-indigo-600" />
                <h3 className="text-sm font-semibold text-slate-900">
                  浏览器缓存与存储
                </h3>
              </div>
              <button
                type="button"
                onClick={() => void refreshStorageEstimate()}
                disabled={loadingStorage}
                className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-600 transition hover:bg-slate-50 disabled:opacity-60"
              >
                <RefreshCw
                  className={`h-3.5 w-3.5 ${loadingStorage ? 'animate-spin' : ''}`}
                />
                <span>刷新统计</span>
              </button>
            </div>

            {/* 总占用与配额条 */}
            <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <div>
                  <span className="text-xs text-slate-500">当前缓存总占用</span>
                  <p
                    data-testid="browser-cache-total-size"
                    className="mt-0.5 text-xl font-bold tabular-nums text-slate-900"
                  >
                    {storageEstimate
                      ? formatBytes(storageEstimate.totalUsageBytes)
                      : loadingStorage
                        ? '计算中...'
                        : '0 B'}
                  </p>
                </div>
                {storageEstimate && storageEstimate.quotaBytes > 0 && (
                  <span className="text-xs tabular-nums text-slate-500">
                    浏览器可用配额：{formatBytes(storageEstimate.quotaBytes)}
                  </span>
                )}
              </div>

              {storageEstimate && storageEstimate.quotaBytes > 0 && (
                <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-slate-200/80">
                  <div
                    className="h-full rounded-full bg-indigo-600 transition-all duration-300"
                    style={{ width: `${usagePercent}%` }}
                  />
                </div>
              )}

              <div className="mt-3.5 grid grid-cols-1 gap-2.5 sm:grid-cols-3">
                <div className="rounded-lg border border-slate-200/80 bg-white px-3 py-2">
                  <p className="text-[11px] text-slate-500">OPFS 暂存媒体</p>
                  <p
                    data-testid="browser-cache-opfs-size"
                    className="mt-0.5 text-sm font-semibold tabular-nums text-slate-900"
                  >
                    {storageEstimate
                      ? formatBytes(storageEstimate.opfsBytes)
                      : '-'}
                  </p>
                </div>
                <div className="rounded-lg border border-slate-200/80 bg-white px-3 py-2">
                  <p className="text-[11px] text-slate-500">
                    IndexedDB 索引缓存（估算）
                  </p>
                  <p
                    data-testid="browser-cache-index-size"
                    className="mt-0.5 text-sm font-semibold tabular-nums text-slate-900"
                  >
                    {storageEstimate
                      ? formatBytes(storageEstimate.indexCacheBytes)
                      : '-'}
                  </p>
                </div>
                <div className="rounded-lg border border-slate-200/80 bg-white px-3 py-2">
                  <p className="text-[11px] text-slate-500">当前索引条目</p>
                  <p
                    data-testid="browser-cache-record-counts"
                    className="mt-0.5 text-sm font-semibold tabular-nums text-slate-900"
                  >
                    {totalItemCount} 条 · {totalFolderCount} 目录 ·{' '}
                    {totalTagCount} 标签
                  </p>
                </div>
              </div>
            </div>

            <div className="mt-4 flex flex-wrap items-center justify-between gap-4 border-t border-slate-100 pt-4">
              <div className="min-w-0">
                <p className="text-xs font-semibold text-slate-900">
                  清空浏览器缓存索引
                </p>
                <p className="mt-0.5 text-xs text-slate-500">
                  仅清空浏览器 IndexedDB 索引与任务队列缓存，绝不删除本地硬盘 CollectVault 文件及目录绑定
                </p>
              </div>
              <button
                type="button"
                onClick={() => setConfirmModal('clear_cache')}
                disabled={isBusy}
                className="inline-flex items-center gap-1.5 rounded-lg border border-rose-200 bg-rose-50 px-3 py-1.5 text-xs font-semibold text-rose-700 transition hover:bg-rose-100 disabled:opacity-60"
              >
                <Trash2 className="h-3.5 w-3.5" />
                <span>清空浏览器缓存</span>
              </button>
            </div>
          </section>

          {/* 4. 控制台显示偏好 */}
          <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-2xs">
            <div className="mb-4 flex items-center gap-2">
              <LayoutGrid className="h-4 w-4 text-indigo-600" />
              <h3 className="text-sm font-semibold text-slate-900">
                控制台显示偏好
              </h3>
            </div>

            <div className="divide-y divide-slate-100">
              <div className="flex flex-wrap items-center justify-between gap-4 py-3.5 first:pt-0">
                <div className="min-w-0">
                  <p className="text-xs font-semibold text-slate-900">
                    默认展示视图
                  </p>
                  <p className="mt-0.5 text-xs text-slate-500">
                    设置打开控制台时收藏列表的默认布局形式
                  </p>
                </div>
                <div className="inline-flex rounded-lg border border-slate-200 bg-slate-100 p-0.5">
                  {(
                    [
                      { value: 'grid', label: '卡片网格', icon: LayoutGrid },
                      { value: 'list', label: '紧凑列表', icon: List },
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
                            `默认视图已设为${opt.label}`,
                          )
                        }
                        className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1 text-xs font-medium transition ${
                          active
                            ? 'bg-white text-indigo-700 shadow-2xs'
                            : 'text-slate-600 hover:text-slate-900'
                        }`}
                      >
                        <Icon className="h-3.5 w-3.5" />
                        <span>{opt.label}</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-4 pt-3.5">
                <div className="min-w-0">
                  <label
                    htmlFor="setting-default-sort"
                    className="block text-xs font-semibold text-slate-900"
                  >
                    默认排序方式
                  </label>
                  <p className="mt-0.5 text-xs text-slate-500">
                    设置打开控制台时的默认排序规则
                  </p>
                </div>
                <select
                  id="setting-default-sort"
                  value={preferences.defaultSortBy}
                  onChange={(e) =>
                    void handlePatchPreferences(
                      { defaultSortBy: e.target.value as LibrarySortOption },
                      '已更新默认排序方式',
                    )
                  }
                  className="min-w-[160px] rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 transition hover:border-slate-300 focus:border-indigo-400 focus:outline-none"
                >
                  <option value="collectedAt">最近收藏</option>
                  <option value="publishedAt">原发布时间</option>
                  <option value="totalSizeBytes">文件体积</option>
                </select>
              </div>
            </div>
          </section>
        </div>
      </div>

      {/* 二次确认弹窗：重建索引 / 清空浏览器缓存 */}
      {confirmModal !== null && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/45 p-4 backdrop-blur-[1px]"
          onClick={() => !isClearingCache && setConfirmModal(null)}
        >
          <div
            role="dialog"
            aria-modal="true"
            className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-5 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            {confirmModal === 'rebuild' ? (
              <>
                <div className="flex items-start gap-3">
                  <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-indigo-50 text-indigo-600">
                    <DatabaseBackup className="h-5 w-5" />
                  </span>
                  <div>
                    <h3 className="text-base font-semibold text-slate-900">
                      确认从本地 CollectVault 重建索引？
                    </h3>
                    <p className="mt-1.5 text-xs leading-relaxed text-slate-600">
                      系统将递归扫描本地目录{' '}
                      <code className="rounded bg-slate-100 px-1 py-0.5 font-semibold text-slate-800">
                        {vaultHandle?.name}
                      </code>{' '}
                      中的全部 <code>meta.json</code> 与{' '}
                      <code>taxonomy.json</code>
                      ，重新生成缩略图并覆盖浏览器 IndexedDB 索引。
                    </p>
                    {pendingSyncCount > 0 && (
                      <p className="mt-2 rounded-lg bg-amber-50 px-2.5 py-2 text-xs font-medium text-amber-800">
                        提示：当前有 {pendingSyncCount}{' '}
                        条尚未同步到硬盘的暂存或修改内容，建议先执行「立即同步」后再重建索引。
                      </p>
                    )}
                  </div>
                </div>
                <div className="mt-5 flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setConfirmModal(null)}
                    className="rounded-lg border border-slate-200 bg-white px-3.5 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50"
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleConfirmRebuild()}
                    className="rounded-lg bg-indigo-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-indigo-700"
                  >
                    确认重建索引
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="flex items-start gap-3">
                  <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-rose-50 text-rose-600">
                    <AlertTriangle className="h-5 w-5" />
                  </span>
                  <div>
                    <h3 className="text-base font-semibold text-slate-900">
                      确认清空浏览器缓存索引？
                    </h3>
                    <p className="mt-1.5 text-xs leading-relaxed text-slate-600">
                      此操作仅清空浏览器 IndexedDB 中的{' '}
                      <code>items</code>、<code>folders</code>、<code>tags</code>、
                      <code>tasks</code> 索引缓存，并保留本地目录绑定与偏好设置。
                    </p>
                    <p className="mt-2 rounded-lg border border-emerald-200 bg-emerald-50 px-2.5 py-2 text-xs font-medium text-emerald-800">
                      安全承诺：绝不会删除您硬盘 CollectVault 目录中的任何视频、图片或元数据文件，随时可点击「从本地重建索引」恢复全部数据。
                    </p>
                  </div>
                </div>
                <div className="mt-5 flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setConfirmModal(null)}
                    disabled={isClearingCache}
                    className="rounded-lg border border-slate-200 bg-white px-3.5 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleConfirmClearCache()}
                    disabled={isClearingCache}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-rose-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-rose-700 disabled:opacity-60"
                  >
                    {isClearingCache && (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    )}
                    <span>确认清空浏览器缓存</span>
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
