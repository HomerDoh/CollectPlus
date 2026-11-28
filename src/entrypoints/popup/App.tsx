import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  BookmarkPlus,
  CheckCircle2,
  Clock,
  CloudOff,
  Download,
  ExternalLink,
  Folder,
  FolderOpen,
  FolderSync,
  Heart,
  Layers,
  Loader2,
  Pin,
  Sparkles,
} from 'lucide-react';
import { getAdapterById, getAllSiteAdapters } from '@/adapters/registry.ts';
import { flattenFolderOptions } from '@/components/folder-options.ts';
import {
  i18n,
  translateOptionalKey,
  useI18nLocale,
} from '@/i18n/index.ts';
import { useTheme } from '@/theme/index.ts';
import { sendToBackground } from '@/types/messages.ts';
import {
  PIN_HINT_PENDING_KEY,
  type AutoSyncExclusionReason,
  type FolderNode,
  type PlatformId,
} from '@/types/schema.ts';
import { getErrorMessage } from '../library/utils/format.ts';

const POPUP_SKIP_REASON_KEYS: readonly AutoSyncExclusionReason[] = [
  'support_author',
  'watch_later',
  'skip_local_save',
];

function getPopupSkipReasonLabel(reason: AutoSyncExclusionReason): string {
  switch (reason) {
    case 'support_author':
      return i18n.t('format.exclusion.supportAuthorShort');
    case 'watch_later':
      return i18n.t('format.exclusion.watchLaterShort');
    case 'skip_local_save':
      return i18n.t('format.exclusion.skipLocalSaveShort');
    default:
      return i18n.t('format.exclusion.skipLocalSaveShort');
  }
}

interface PopupSummary {
  supportedPlatform: PlatformId | null;
  captureMode: 'deep' | 'recipe' | 'universal' | 'unsupported';
  siteHost?: string;
  totalItems: number;
  stagedCount: number;
  metaDirtyCount: number;
  activeTaskCount: number;
  hasVaultDirectory: boolean;
}

type CaptureFeedback =
  | { state: 'idle' }
  | { state: 'loading' }
  | { state: 'success'; message: string }
  | { state: 'error'; message: string };

function getPlatformReadyText(summary: PopupSummary): string {
  if (summary.captureMode === 'universal' || summary.supportedPlatform === 'web') {
    return i18n.t('popup.universalReady', {
      host: summary.siteHost ?? i18n.t('platform.web'),
    });
  }
  const platform = summary.supportedPlatform;
  if (!platform) {
    return '';
  }
  const key = `popup.platformReady.${platform}`;
  const translated = translateOptionalKey(key);
  if (translated) {
    return translated;
  }
  const adapter = getAdapterById(platform);
  return i18n.t('popup.platformReadyGeneric', {
    platform: adapter?.displayName ?? platform,
  });
}

export default function App() {
  useI18nLocale();
  useTheme();
  const [activeTabId, setActiveTabId] = useState<number | undefined>(undefined);
  const [summary, setSummary] = useState<PopupSummary | null>(null);
  const [loadingSummary, setLoadingSummary] = useState<boolean>(true);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [showPinHint, setShowPinHint] = useState<boolean>(false);
  const [captureFeedback, setCaptureFeedback] = useState<CaptureFeedback>({
    state: 'idle',
  });
  const [skipPanelOpen, setSkipPanelOpen] = useState<boolean>(false);
  const [skipDetail, setSkipDetail] = useState<string>('');
  const [skipSubmitting, setSkipSubmitting] = useState<boolean>(false);
  const [folders, setFolders] = useState<FolderNode[]>([]);
  const [autoClassifyEnabled, setAutoClassifyEnabled] = useState<boolean>(true);
  const [selectedFolderValue, setSelectedFolderValue] =
    useState<string>('__auto__');

  const folderOptions = useMemo(() => flattenFolderOptions(folders), [folders]);

  const loadStatus = useCallback(async () => {
    setLoadingSummary(true);
    setSummaryError(null);
    try {
      const tabs = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      const activeTab = tabs[0];
      setActiveTabId(activeTab?.id);

      const [response, foldersRes] = await Promise.all([
        sendToBackground({
          target: 'background',
          type: 'GET_STATUS_SUMMARY',
          ...(activeTab?.url ? { tabUrl: activeTab.url } : {}),
        }),
        sendToBackground({
          target: 'background',
          type: 'GET_CAPTURE_FOLDERS',
        }).catch(() => null),
      ]);

      if (foldersRes && foldersRes.ok) {
        setFolders(foldersRes.folders);
        setAutoClassifyEnabled(foldersRes.autoClassifyEnabled);
        setSelectedFolderValue((prev) => {
          if (prev === '__auto__' || prev === '__uncategorized__') {
            return prev;
          }
          return foldersRes.folders.some((f) => f.id === prev)
            ? prev
            : '__auto__';
        });
      }

      if (!response.ok) {
        setSummaryError(response.error);
        return;
      }

      setSummary({
        supportedPlatform: response.supportedPlatform,
        captureMode: response.captureMode,
        ...(response.siteHost ? { siteHost: response.siteHost } : {}),
        totalItems: response.totalItems,
        stagedCount: response.stagedCount,
        metaDirtyCount: response.metaDirtyCount,
        activeTaskCount: response.activeTaskCount,
        hasVaultDirectory: response.hasVaultDirectory,
      });
    } catch (error) {
      setSummaryError(getErrorMessage(error));
    } finally {
      setLoadingSummary(false);
    }
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  useEffect(() => {
    let disposed = false;

    const checkPinHint = async () => {
      try {
        const stored = await chrome.storage.local.get(PIN_HINT_PENDING_KEY);
        if (disposed || stored[PIN_HINT_PENDING_KEY] !== true) {
          return;
        }

        const settings =
          typeof chrome.action?.getUserSettings === 'function'
            ? await chrome.action.getUserSettings()
            : { isOnToolbar: false };

        if (disposed) {
          return;
        }

        if (settings.isOnToolbar) {
          await chrome.storage.local
            .set({ [PIN_HINT_PENDING_KEY]: false })
            .catch(() => undefined);
          return;
        }

        setShowPinHint(true);
      } catch {
        // 忽略扩展存储或工具栏状态读取异常
      }
    };

    void checkPinHint();

    const handleUserSettingsChanged = (
      change: chrome.action.UserSettingsChange,
    ) => {
      if (change.isOnToolbar) {
        setShowPinHint(false);
        void chrome.storage.local
          .set({ [PIN_HINT_PENDING_KEY]: false })
          .catch(() => undefined);
      }
    };

    if (chrome.action?.onUserSettingsChanged) {
      chrome.action.onUserSettingsChanged.addListener(
        handleUserSettingsChanged,
      );
    }

    return () => {
      disposed = true;
      if (chrome.action?.onUserSettingsChanged) {
        chrome.action.onUserSettingsChanged.removeListener(
          handleUserSettingsChanged,
        );
      }
    };
  }, []);

  const handleDismissPinHint = () => {
    setShowPinHint(false);
    void chrome.storage.local
      .set({ [PIN_HINT_PENDING_KEY]: false })
      .catch(() => undefined);
  };

  const handleTriggerCapture = async () => {
    setCaptureFeedback({ state: 'loading' });
    try {
      const explicitFolderId =
        selectedFolderValue === '__auto__'
          ? undefined
          : selectedFolderValue === '__uncategorized__'
            ? null
            : selectedFolderValue;
      const response = await sendToBackground({
        target: 'background',
        type: 'TRIGGER_ACTIVE_TAB_CAPTURE',
        ...(activeTabId !== undefined ? { tabId: activeTabId } : {}),
        ...(explicitFolderId !== undefined
          ? { folderId: explicitFolderId }
          : {}),
      });

      if (!response.ok) {
        setCaptureFeedback({
          state: 'error',
          message: response.error,
        });
        return;
      }

      setCaptureFeedback({
        state: 'success',
        message: i18n.t('popup.captureTriggered'),
      });
      void loadStatus();
    } catch (error) {
      setCaptureFeedback({
        state: 'error',
        message: getErrorMessage(error),
      });
    }
  };

  const handleSkipLocalPersistence = async (
    reason: AutoSyncExclusionReason,
    reasonLabel: string,
  ) => {
    setSkipSubmitting(true);
    setCaptureFeedback({ state: 'idle' });
    try {
      const trimmedDetail = skipDetail.trim();
      const response = await sendToBackground({
        target: 'background',
        type: 'TRIGGER_ACTIVE_TAB_CAPTURE',
        ...(activeTabId !== undefined ? { tabId: activeTabId } : {}),
        autoSyncExclusion: {
          reason,
          ...(trimmedDetail ? { detail: trimmedDetail } : {}),
        },
      });

      if (!response.ok) {
        setCaptureFeedback({
          state: 'error',
          message: response.error,
        });
        return;
      }

      setSkipPanelOpen(false);
      setSkipDetail('');
      setCaptureFeedback({
        state: 'success',
        message: i18n.t('popup.skipPersistenceSuccess', {
          reason: reasonLabel,
        }),
      });
      void loadStatus();
    } catch (error) {
      setCaptureFeedback({
        state: 'error',
        message: getErrorMessage(error),
      });
    } finally {
      setSkipSubmitting(false);
    }
  };

  const handleOpenLibrary = async (section?: 'vault') => {
    try {
      await sendToBackground({
        target: 'background',
        type: 'OPEN_LIBRARY_PAGE',
        ...(section ? { section } : {}),
      });
      window.close();
    } catch (error) {
      setCaptureFeedback({
        state: 'error',
        message: i18n.t('popup.openLibraryFailed', {
          error: getErrorMessage(error),
        }),
      });
    }
  };

  const pendingSyncCount = summary
    ? summary.stagedCount + summary.metaDirtyCount
    : 0;

  return (
    <main className="flex w-[350px] flex-col gap-3 bg-[var(--cp-canvas)] p-3.5 text-[var(--cp-text)]">
      {/* 顶部品牌栏 */}
      <header className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2.5">
          <span className="inline-flex h-8 w-8 items-center justify-center rounded bg-[var(--cp-accent)] text-[var(--cp-on-accent)]">
            <BookmarkPlus className="h-4 w-4" />
          </span>
          <div>
            <h1 className="text-sm font-semibold leading-tight text-[var(--cp-text)]">
              Collect+
            </h1>
            <p className="text-[11px] text-[var(--cp-text-muted)]">
              {i18n.t('popup.tagline')}
            </p>
          </div>
        </div>
      </header>

      {/* 首次安装：固定到插件栏提示 */}
      {showPinHint && (
        <section
          data-testid="popup-pin-hint"
          className="flex items-start gap-2 rounded border border-[var(--cp-border-strong)] bg-[var(--cp-active)] p-2.5 text-xs text-[var(--cp-text-active)]"
        >
          <Pin className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--cp-accent)]" />
          <div className="min-w-0 flex-1">
            <p className="font-semibold leading-snug">
              {i18n.t('popup.pinHintTitle')}
            </p>
            <p className="mt-0.5 text-[11px] leading-relaxed text-[var(--cp-text-secondary)]">
              {i18n.t('popup.pinHintDesc')}
            </p>
          </div>
          <button
            type="button"
            onClick={handleDismissPinHint}
            aria-label={i18n.t('popup.pinHintDismissAria')}
            className="shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium text-[var(--cp-text-active)] transition hover:bg-[var(--cp-surface)]"
          >
            {i18n.t('popup.pinHintGotIt')}
          </button>
        </section>
      )}

      {/* 未选定本地同步目录提示 */}
      {summary !== null && !summary.hasVaultDirectory && (
        <section
          data-testid="popup-vault-hint"
          className="flex items-center justify-between gap-2.5 rounded border border-amber-200 bg-amber-50 p-2.5 text-xs text-amber-950 dark:border-amber-900 dark:bg-amber-950/60 dark:text-amber-200"
        >
          <div className="flex min-w-0 items-start gap-2">
            <FolderOpen className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
            <div className="min-w-0">
              <p className="font-semibold leading-snug">
                {i18n.t('popup.vaultHintTitle')}
              </p>
              <p className="mt-0.5 text-[11px] leading-relaxed text-amber-800/90 dark:text-amber-300/90">
                {i18n.t('popup.vaultHintDesc')}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => void handleOpenLibrary('vault')}
            className="shrink-0 rounded bg-amber-600 px-2.5 py-1.5 text-[11px] font-semibold text-white transition hover:bg-amber-700"
          >
            {i18n.t('popup.vaultHintChooseDir')}
          </button>
        </section>
      )}

      {/* 当前标签页状态卡 */}
      <section className="rounded border border-[var(--cp-border)] bg-[var(--cp-surface)] p-3">
        {loadingSummary && !summary ? (
          <div className="flex items-center gap-2 py-2 text-xs text-[var(--cp-text-muted)]">
            <Loader2 className="h-4 w-4 animate-spin text-[var(--cp-accent)]" />
            <span>{i18n.t('popup.checkingPage')}</span>
          </div>
        ) : summaryError ? (
          <div className="flex items-start gap-2 rounded bg-rose-50 p-2.5 text-xs text-rose-700 dark:bg-rose-950/70 dark:text-rose-300">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              {i18n.t('popup.statusLoadFailed', { error: summaryError })}
            </span>
          </div>
        ) : summary?.supportedPlatform ? (
          <div className="flex flex-col gap-2.5">
            <div className="flex items-center gap-2">
              <span className="relative flex h-2.5 w-2.5 shrink-0">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
                <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-emerald-500" />
              </span>
              <p className="text-xs font-medium text-emerald-700 dark:text-emerald-300">
                {getPlatformReadyText(summary)}
              </p>
            </div>

            <div className="flex items-center gap-2">
              <label
                htmlFor="popup-folder-select"
                className="inline-flex shrink-0 items-center gap-1 text-[11px] font-medium text-[var(--cp-text-secondary)]"
              >
                <Folder className="h-3.5 w-3.5 text-[var(--cp-text-muted)]" />
                <span>{i18n.t('popup.targetFolderLabel')}</span>
              </label>
              <select
                id="popup-folder-select"
                data-testid="popup-folder-select"
                value={selectedFolderValue}
                onChange={(e) => setSelectedFolderValue(e.target.value)}
                disabled={captureFeedback.state === 'loading' || skipSubmitting}
                className="min-w-0 flex-1 rounded border border-[var(--cp-border)] bg-[var(--cp-canvas)] px-2 py-1 text-[11px] font-medium text-[var(--cp-text)] transition hover:border-[var(--cp-border-strong)] focus:border-[var(--cp-accent)] focus:outline-none"
              >
                <option value="__auto__">
                  {autoClassifyEnabled
                    ? i18n.t('popup.targetFolderAutoOption')
                    : i18n.t('popup.targetFolderDefaultOption')}
                </option>
                <option value="__uncategorized__">
                  {i18n.t('popup.targetFolderUncategorizedOption')}
                </option>
                {folderOptions.map((opt) => (
                  <option key={opt.id} value={opt.id}>
                    {i18n.t('popup.targetFolderManualPrefix', {
                      name: opt.label,
                    })}
                  </option>
                ))}
              </select>
            </div>

            <button
              type="button"
              onClick={() => void handleTriggerCapture()}
              disabled={captureFeedback.state === 'loading' || skipSubmitting}
              className="flex w-full items-center justify-center gap-2 rounded bg-[var(--cp-accent)] px-3.5 py-2.5 text-xs font-semibold text-[var(--cp-on-accent)] transition hover:bg-[var(--cp-accent-hover)] disabled:cursor-not-allowed disabled:opacity-65"
            >
              {captureFeedback.state === 'loading' ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span>{i18n.t('popup.capturing')}</span>
                </>
              ) : (
                <>
                  <Sparkles className="h-4 w-4" />
                  <span>{i18n.t('popup.captureCurrentWithShortcut')}</span>
                </>
              )}
            </button>

            <button
              type="button"
              data-testid="popup-skip-persistence-btn"
              onClick={() => setSkipPanelOpen((prev) => !prev)}
              disabled={captureFeedback.state === 'loading' || skipSubmitting}
              aria-expanded={skipPanelOpen}
              className="flex w-full items-center justify-center gap-1.5 rounded border border-[var(--cp-border)] bg-[var(--cp-canvas)] px-3 py-2 text-xs font-semibold text-[var(--cp-text-secondary)] transition hover:border-[var(--cp-border-strong)] hover:text-[var(--cp-text)] disabled:cursor-not-allowed disabled:opacity-65"
            >
              {skipSubmitting ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-[var(--cp-text-muted)]" />
                  <span>{i18n.t('popup.skipPersistenceSubmitting')}</span>
                </>
              ) : (
                <>
                  <CloudOff className="h-3.5 w-3.5 text-[var(--cp-text-muted)]" />
                  <span>{i18n.t('popup.skipPersistenceBtn')}</span>
                </>
              )}
            </button>

            {skipPanelOpen && (
              <div
                data-testid="popup-skip-persistence-panel"
                className="flex flex-col gap-2 rounded border border-[var(--cp-border)] bg-[var(--cp-canvas)] p-2.5"
              >
                <p className="text-[11px] leading-snug text-[var(--cp-text-secondary)]">
                  {i18n.t('popup.skipPersistenceHint')}
                </p>
                <div className="grid grid-cols-3 gap-1.5">
                  {POPUP_SKIP_REASON_KEYS.map((reason) => {
                    const label = getPopupSkipReasonLabel(reason);
                    return (
                      <button
                        key={reason}
                        type="button"
                        data-testid={`popup-skip-reason-${reason.replaceAll('_', '-')}`}
                        disabled={skipSubmitting}
                        onClick={() =>
                          void handleSkipLocalPersistence(reason, label)
                        }
                        className="inline-flex items-center justify-center gap-1 rounded border border-[var(--cp-border)] bg-[var(--cp-surface)] px-2 py-1.5 text-[11px] font-semibold text-[var(--cp-text-secondary)] transition hover:border-[var(--cp-accent)] hover:bg-[var(--cp-active)] hover:text-[var(--cp-text-active)] disabled:opacity-60"
                      >
                        {reason === 'support_author' ? (
                          <Heart className="h-3 w-3 text-pink-500" />
                        ) : reason === 'watch_later' ? (
                          <Clock className="h-3 w-3 text-sky-500" />
                        ) : (
                          <CloudOff className="h-3 w-3 text-[var(--cp-accent)]" />
                        )}
                        <span>{label}</span>
                      </button>
                    );
                  })}
                </div>
                <input
                  type="text"
                  data-testid="popup-skip-detail-input"
                  value={skipDetail}
                  onChange={(e) => setSkipDetail(e.target.value)}
                  placeholder={i18n.t('popup.skipPersistenceDetailPlaceholder')}
                  maxLength={120}
                  className="w-full rounded border border-[var(--cp-border)] bg-[var(--cp-surface)] px-2.5 py-1.5 text-[11px] text-[var(--cp-text)] placeholder:text-[var(--cp-text-muted)] focus:border-[var(--cp-accent)] focus:outline-none"
                />
              </div>
            )}

            {captureFeedback.state === 'success' && (
              <div className="flex items-center gap-1.5 rounded bg-emerald-50 px-2.5 py-1.5 text-[11px] font-medium text-emerald-700 dark:bg-emerald-950/70 dark:text-emerald-300">
                <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                <span>{captureFeedback.message}</span>
              </div>
            )}

            {captureFeedback.state === 'error' && (
              <div className="flex items-start gap-1.5 rounded bg-rose-50 px-2.5 py-1.5 text-[11px] text-rose-700 dark:bg-rose-950/70 dark:text-rose-300">
                <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>{captureFeedback.message}</span>
              </div>
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <div className="flex items-start gap-2">
              <span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-[var(--cp-border-strong)]" />
              <p className="text-xs leading-relaxed text-[var(--cp-text-secondary)]">
                {i18n.t('popup.unsupportedPageDesc')}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              {getAllSiteAdapters()
                .filter((adapter) => Boolean(adapter.uiMeta?.entryUrl))
                .slice(0, 6)
                .map((adapter) => {
                  const labelKey =
                    adapter.uiMeta?.i18nNameKey ?? `platform.${adapter.id}`;
                  const label =
                    translateOptionalKey(labelKey) ?? adapter.displayName;
                  return (
                    <a
                      key={adapter.id}
                      href={adapter.uiMeta?.entryUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex w-fit items-center gap-1 text-[11px] font-medium text-[var(--cp-accent)] hover:text-[var(--cp-accent-hover)] hover:underline"
                    >
                      <span>{label}</span>
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  );
                })}
            </div>
          </div>
        )}
      </section>

      {/* 3 列统计指标卡 */}
      <section className="grid grid-cols-3 gap-2">
        <div className="flex flex-col gap-1 rounded border border-[var(--cp-border)] bg-[var(--cp-surface)] px-2.5 py-2.5">
          <div className="flex items-center gap-1 text-[11px] text-[var(--cp-text-muted)]">
            <Layers className="h-3 w-3 text-[var(--cp-accent)]" />
            <span>{i18n.t('popup.statTotal')}</span>
          </div>
          <span className="text-lg font-bold tabular-nums text-[var(--cp-text)]">
            {summary ? summary.totalItems : '-'}
          </span>
        </div>

        <div
          className={`flex flex-col gap-1 rounded border px-2.5 py-2.5 ${
            pendingSyncCount > 0
              ? 'border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/60'
              : 'border-[var(--cp-border)] bg-[var(--cp-surface)]'
          }`}
        >
          <div className="flex items-center gap-1 text-[11px] text-[var(--cp-text-muted)]">
            <FolderSync
              className={`h-3 w-3 ${
                pendingSyncCount > 0
                  ? 'text-amber-600 dark:text-amber-400'
                  : 'text-[var(--cp-text-muted)]'
              }`}
            />
            <span>{i18n.t('popup.statPendingSync')}</span>
          </div>
          <span
            className={`text-lg font-bold tabular-nums ${
              pendingSyncCount > 0
                ? 'text-amber-700 dark:text-amber-300'
                : 'text-[var(--cp-text)]'
            }`}
          >
            {summary ? pendingSyncCount : '-'}
          </span>
        </div>

        <div
          className={`flex flex-col gap-1 rounded border px-2.5 py-2.5 ${
            summary && summary.activeTaskCount > 0
              ? 'border-[var(--cp-accent)] bg-[var(--cp-active)]'
              : 'border-[var(--cp-border)] bg-[var(--cp-surface)]'
          }`}
        >
          <div className="flex items-center gap-1 text-[11px] text-[var(--cp-text-muted)]">
            <Download
              className={`h-3 w-3 ${
                summary && summary.activeTaskCount > 0
                  ? 'text-[var(--cp-accent)]'
                  : 'text-[var(--cp-text-muted)]'
              }`}
            />
            <span>{i18n.t('popup.statDownloading')}</span>
          </div>
          <span
            className={`text-lg font-bold tabular-nums ${
              summary && summary.activeTaskCount > 0
                ? 'text-[var(--cp-text-active)]'
                : 'text-[var(--cp-text)]'
            }`}
          >
            {summary ? summary.activeTaskCount : '-'}
          </span>
        </div>
      </section>

      {/* 底部主操作 */}
      <button
        type="button"
        onClick={() => void handleOpenLibrary()}
        className="flex w-full items-center justify-center gap-2 rounded border border-[var(--cp-border)] bg-[var(--cp-surface)] px-3.5 py-2.5 text-xs font-semibold text-[var(--cp-text)] transition hover:border-[var(--cp-accent)] hover:bg-[var(--cp-active)] hover:text-[var(--cp-text-active)]"
      >
        <span>{i18n.t('popup.openLibraryBtn')}</span>
        {pendingSyncCount > 0 && (
          <span className="inline-flex min-w-5 items-center justify-center rounded bg-[var(--cp-accent-2)] px-1.5 py-0.5 text-[10px] font-bold leading-none text-white">
            {pendingSyncCount > 99 ? '99+' : pendingSyncCount}
          </span>
        )}
        <ExternalLink className="h-3.5 w-3.5 text-[var(--cp-text-muted)]" />
      </button>
    </main>
  );
}
