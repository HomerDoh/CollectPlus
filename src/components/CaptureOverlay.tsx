/**
 * CollectPlus 页面 Shadow DOM 浮层组件：
 * - 左下角轻悬浮采集按钮（支持折叠与加载防重）；
 * - 首次进入已登录站点时的全量收藏同步询问卡片与同步进度/风控兜底横幅。
 */

import {
  AlertTriangle,
  BookmarkPlus,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  Clock,
  CloudOff,
  ExternalLink,
  Folder,
  HardDrive,
  Heart,
  Loader2,
  RefreshCw,
  Sparkles,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { i18n, initI18n, useI18nLocale } from '@/i18n/index.ts';
import { formatBytes } from '../entrypoints/library/utils/format.ts';
import type { AutoSyncExclusionReason, FolderNode } from '../types/schema.ts';
import { flattenFolderOptions } from './folder-options.ts';
import type { NativeCollectToastState } from './native-collect-buffer.ts';

/** 视频过大提示弹窗自动消失时间（毫秒） */
const OVERSIZED_PROMPT_AUTO_DISMISS_MS = 5000;

/** 首次进入已登录网页时的全量同步询问弹窗状态 */
export interface SyncPromptState {
  platformLabel: string;
  accountName?: string;
}

/** 全量收藏同步进度 / 完成 / 风控兜底横幅状态 */
export interface SyncBannerState {
  phase: 'syncing' | 'completed' | 'fallback' | 'error';
  fetchedCount: number;
  addedCount: number;
  deduplicatedCount: number;
  skippedOversizedCount?: number;
  message?: string;
  fallbackUrl?: string;
}

/** 视频体积超过上限取消自动保存时的页面提示弹窗状态 */
export interface OversizedPromptState {
  /** 唯一实例 ID，用于连续触发时重置 5 秒自动消失倒计时 */
  id: string;
  title: string;
  videoSizeBytes: number;
  thresholdMb: number;
}

/** 浮层整体只读快照 */
export interface CaptureOverlaySnapshot {
  isCapturing: boolean;
  floatingButtonEnabled: boolean;
  syncPrompt: SyncPromptState | null;
  syncBanner: SyncBannerState | null;
  oversizedPrompt?: OversizedPromptState | null;
  nativeCollectToast?: NativeCollectToastState | null;
  /** 用户创建的分类文件夹树（用于前置手动指定目录） */
  folders?: readonly FolderNode[];
  /** 未手动指定目录时是否开启智能自动分类 */
  autoClassifyEnabled?: boolean;
  /** 当前页面会话级前置锁定的目标文件夹（undefined = 自动分类，null = 显式未分类） */
  sessionFolderId?: string | null;
}

/** 轻量外部状态存储接口，供 Content Script 驱动 React Shadow DOM 渲染 */
export interface CaptureOverlayStore {
  getSnapshot: () => CaptureOverlaySnapshot;
  subscribe: (listener: () => void) => () => void;
}

/** 浮层交互动作回调集合 */
export interface CaptureOverlayActions {
  onTriggerCapture: () => void;
  onConfirmFullSync: () => void;
  onDismissFullSync: () => void;
  onCancelFullSync: () => void;
  onOpenFallbackPage: (url: string) => void;
  onDismissSyncBanner: () => void;
  onConfirmOversizedSave?: () => void;
  onSkipOversized?: () => void;
  onSkipNativeCollectPersistence?: (reason: AutoSyncExclusionReason) => void;
  onSaveNativeCollectNow?: () => void;
  onPauseNativeCollectTimer?: () => void;
  onResumeNativeCollectTimer?: () => void;
  onSaveNativeCollectToFolder?: (folderId: string | null) => void;
  onSelectSessionFolder?: (folderId: string | null | undefined) => void;
  onRefreshFolders?: () => void;
}

export interface CaptureOverlayProps {
  store: CaptureOverlayStore;
  actions: CaptureOverlayActions;
}

export function CaptureOverlay({ store, actions }: CaptureOverlayProps) {
  useI18nLocale();
  useEffect(() => {
    void initI18n();
  }, []);

  const {
    isCapturing,
    floatingButtonEnabled,
    syncPrompt,
    syncBanner,
    oversizedPrompt = null,
    nativeCollectToast = null,
    folders = [],
    autoClassifyEnabled = true,
    sessionFolderId = undefined,
  } = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [fabCollapsed, setFabCollapsed] = useState(false);
  const [folderMenuOpen, setFolderMenuOpen] = useState(false);
  const [remainingSeconds, setRemainingSeconds] = useState(5);
  const [nativeToastSeconds, setNativeToastSeconds] = useState(5);
  const folderWrapRef = useRef<HTMLDivElement | null>(null);

  const flatFolders = useMemo(() => flattenFolderOptions(folders), [folders]);
  const sessionFolderLabel = useMemo(() => {
    if (sessionFolderId === undefined) {
      return i18n.t('overlay.fabFolderAutoShort');
    }
    if (sessionFolderId === null) {
      return i18n.t('overlay.fabFolderUncategorizedShort');
    }
    const found = folders.find((f) => f.id === sessionFolderId);
    return found ? found.name : i18n.t('overlay.fabFolderAutoShort');
  }, [folders, sessionFolderId]);

  const oversizedPromptId = oversizedPrompt?.id ?? null;
  const nativeToastId = nativeCollectToast?.id ?? null;
  const nativeToastPaused = nativeCollectToast?.paused ?? false;
  const nativeToastRemainingMs =
    nativeCollectToast?.remainingMs ?? nativeCollectToast?.durationMs ?? 5000;

  useEffect(() => {
    if (!folderMenuOpen) {
      return;
    }
    const handlePointerDown = (event: MouseEvent) => {
      const path =
        typeof event.composedPath === 'function' ? event.composedPath() : [];
      if (folderWrapRef.current && !path.includes(folderWrapRef.current)) {
        setFolderMenuOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setFolderMenuOpen(false);
      }
    };
    window.addEventListener('mousedown', handlePointerDown, true);
    window.addEventListener('keydown', handleKeyDown, true);
    return () => {
      window.removeEventListener('mousedown', handlePointerDown, true);
      window.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [folderMenuOpen]);

  useEffect(() => {
    if (!oversizedPromptId) {
      return;
    }

    const deadline = Date.now() + OVERSIZED_PROMPT_AUTO_DISMISS_MS;
    setRemainingSeconds(Math.ceil(OVERSIZED_PROMPT_AUTO_DISMISS_MS / 1000));

    const tickInterval = setInterval(() => {
      const leftMs = deadline - Date.now();
      setRemainingSeconds(Math.max(1, Math.ceil(leftMs / 1000)));
    }, 200);

    const dismissTimer = setTimeout(() => {
      actions.onSkipOversized?.();
    }, OVERSIZED_PROMPT_AUTO_DISMISS_MS);

    return () => {
      clearInterval(tickInterval);
      clearTimeout(dismissTimer);
    };
  }, [oversizedPromptId, actions]);

  useEffect(() => {
    if (!nativeToastId) {
      return;
    }

    if (nativeToastPaused) {
      setNativeToastSeconds(Math.max(1, Math.ceil(nativeToastRemainingMs / 1000)));
      return;
    }

    const deadline = Date.now() + nativeToastRemainingMs;
    setNativeToastSeconds(Math.max(1, Math.ceil(nativeToastRemainingMs / 1000)));

    const tickInterval = setInterval(() => {
      const leftMs = deadline - Date.now();
      setNativeToastSeconds(Math.max(1, Math.ceil(leftMs / 1000)));
    }, 200);

    return () => {
      clearInterval(tickInterval);
    };
  }, [nativeToastId, nativeToastPaused, nativeToastRemainingMs]);

  if (
    !floatingButtonEnabled &&
    !syncPrompt &&
    !syncBanner &&
    !oversizedPrompt &&
    !nativeCollectToast
  ) {
    return null;
  }

  return (
    <div className="cp-overlay-root">
      {(nativeCollectToast || oversizedPrompt || syncPrompt || syncBanner) && (
        <div className="cp-toast-stack">
          {nativeCollectToast && (
            <div
              className="cp-native-collect-toast"
              role="status"
              aria-label={i18n.t('overlay.nativeToastAria')}
              data-testid="cp-native-collect-toast"
            >
              <div className="cp-sync-card-head">
                <span className="cp-sync-icon-badge" aria-hidden="true">
                  <BookmarkPlus size={15} />
                </span>
                <div className="cp-sync-card-title-wrap">
                  <div className="cp-sync-card-title">
                    {nativeCollectToast.paused
                      ? i18n.t('overlay.nativeToastTitlePaused')
                      : i18n.t('overlay.nativeToastTitle', {
                          seconds: nativeToastSeconds,
                        })}
                  </div>
                  <div
                    className="cp-oversized-title"
                    title={nativeCollectToast.title}
                  >
                    {nativeCollectToast.title}
                  </div>
                </div>
                <button
                  type="button"
                  className="cp-sync-close-btn"
                  title={i18n.t('overlay.nativeToastSaveNowAria')}
                  aria-label={i18n.t('overlay.nativeToastSaveNowAria')}
                  onClick={() => actions.onSaveNativeCollectNow?.()}
                >
                  <X size={14} />
                </button>
              </div>
              {actions.onSaveNativeCollectToFolder && (
                <div className="cp-native-folder-row">
                  <span className="cp-native-folder-label">
                    {nativeCollectToast.autoClassifyEnabled !== false ? (
                      <Sparkles size={12} />
                    ) : (
                      <Folder size={12} />
                    )}
                    <span>{i18n.t('overlay.nativeToastFolderLabel')}</span>
                  </span>
                  <select
                    className="cp-native-folder-select"
                    data-testid="cp-native-folder-select"
                    aria-label={i18n.t('overlay.nativeToastFolderLabel')}
                    value="__auto__"
                    onMouseDown={() => {
                      actions.onPauseNativeCollectTimer?.();
                      actions.onRefreshFolders?.();
                    }}
                    onFocus={() => {
                      actions.onPauseNativeCollectTimer?.();
                      actions.onRefreshFolders?.();
                    }}
                    onBlur={() => {
                      actions.onResumeNativeCollectTimer?.();
                    }}
                    onChange={(event) => {
                      const val = event.target.value;
                      if (val === '__auto__') {
                        actions.onResumeNativeCollectTimer?.();
                        return;
                      }
                      actions.onSaveNativeCollectToFolder?.(
                        val === '__uncategorized__' ? null : val,
                      );
                    }}
                  >
                    <option value="__auto__">
                      {nativeCollectToast.autoClassifyEnabled !== false
                        ? nativeCollectToast.predictedFolderName
                          ? i18n.t('overlay.nativeToastFolderAutoPredicted', {
                              folder: nativeCollectToast.predictedFolderName,
                            })
                          : i18n.t('overlay.nativeToastFolderAutoUncategorized')
                        : nativeCollectToast.predictedFolderName
                          ? i18n.t('overlay.nativeToastFolderDefaultTarget', {
                              folder: nativeCollectToast.predictedFolderName,
                            })
                          : i18n.t('overlay.nativeToastFolderDefaultUncategorized')}
                    </option>
                    <option value="__uncategorized__">
                      {i18n.t('overlay.nativeToastFolderManualUncategorized')}
                    </option>
                    {flatFolders.map((opt) => (
                      <option key={opt.id} value={opt.id}>
                        {i18n.t('overlay.nativeToastFolderManualOption', {
                          name: opt.label,
                        })}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              <div className="cp-native-toast-hint">
                {i18n.t('overlay.nativeToastHint')}
              </div>
              <div className="cp-native-toast-reasons">
                <button
                  type="button"
                  className="cp-native-reason-btn"
                  data-testid="cp-skip-reason-support-author"
                  onClick={() =>
                    actions.onSkipNativeCollectPersistence?.('support_author')
                  }
                >
                  <Heart size={12} />
                  <span>{i18n.t('format.exclusion.supportAuthorShort')}</span>
                </button>
                <button
                  type="button"
                  className="cp-native-reason-btn"
                  data-testid="cp-skip-reason-watch-later"
                  onClick={() =>
                    actions.onSkipNativeCollectPersistence?.('watch_later')
                  }
                >
                  <Clock size={12} />
                  <span>{i18n.t('format.exclusion.watchLaterShort')}</span>
                </button>
                <button
                  type="button"
                  className="cp-native-reason-btn"
                  data-testid="cp-skip-reason-skip-local"
                  onClick={() =>
                    actions.onSkipNativeCollectPersistence?.('skip_local_save')
                  }
                >
                  <CloudOff size={12} />
                  <span>{i18n.t('format.exclusion.skipLocalSaveShort')}</span>
                </button>
              </div>
              <div className="cp-oversized-progress-track" aria-hidden="true">
                <div
                  key={nativeCollectToast.id}
                  className={`cp-native-progress-bar${
                    nativeCollectToast.paused
                      ? ' cp-native-progress-bar--paused'
                      : ''
                  }`}
                />
              </div>
            </div>
          )}
          {oversizedPrompt && (
            <div
              className="cp-oversized-prompt"
              role="alertdialog"
              aria-modal="false"
              aria-label={i18n.t('overlay.oversizedAria')}
              data-testid="cp-oversized-prompt"
            >
              <div className="cp-sync-card-head">
                <span
                  className="cp-oversized-icon-badge"
                  aria-hidden="true"
                >
                  <HardDrive size={15} />
                </span>
                <div className="cp-sync-card-title-wrap">
                  <div className="cp-sync-card-title">
                    {i18n.t('overlay.oversizedTitle')}
                  </div>
                  <div
                    className="cp-oversized-title"
                    title={oversizedPrompt.title}
                  >
                    {oversizedPrompt.title}
                  </div>
                </div>
                <button
                  type="button"
                  className="cp-sync-close-btn"
                  aria-label={i18n.t('overlay.oversizedCloseAria')}
                  onClick={() => actions.onSkipOversized?.()}
                >
                  <X size={14} />
                </button>
              </div>
              <div
                className="cp-oversized-size-row"
                data-testid="cp-oversized-size"
              >
                <span>{i18n.t('overlay.oversizedSizeLabel')}</span>
                <strong className="cp-oversized-size-val">
                  {formatBytes(oversizedPrompt.videoSizeBytes)}
                </strong>
                <span className="cp-oversized-size-limit">
                  {i18n.t('overlay.oversizedSizeLimit', {
                    mb: oversizedPrompt.thresholdMb,
                  })}
                </span>
              </div>
              <div className="cp-sync-card-actions">
                <button
                  type="button"
                  className="cp-sync-btn-secondary"
                  data-testid="cp-oversized-skip-btn"
                  onClick={() => actions.onSkipOversized?.()}
                >
                  {i18n.t('overlay.oversizedSkipBtn', {
                    seconds: remainingSeconds,
                  })}
                </button>
                <button
                  type="button"
                  className="cp-sync-btn-primary"
                  data-testid="cp-oversized-save-btn"
                  onClick={() => actions.onConfirmOversizedSave?.()}
                >
                  {i18n.t('overlay.oversizedContinueBtn')}
                </button>
              </div>
              <div className="cp-oversized-progress-track" aria-hidden="true">
                <div
                  key={oversizedPrompt.id}
                  className="cp-oversized-progress-bar"
                />
              </div>
            </div>
          )}

          {syncPrompt && (
            <div
              className="cp-sync-prompt"
              role="dialog"
              aria-modal="false"
              aria-label={i18n.t('overlay.syncPromptAria')}
              data-testid="cp-sync-prompt"
            >
              <div className="cp-sync-card-head">
                <span className="cp-sync-icon-badge" aria-hidden="true">
                  <RefreshCw size={15} />
                </span>
                <div className="cp-sync-card-title-wrap">
                  <div className="cp-sync-card-title">
                    {i18n.t('overlay.syncPromptTitle')}
                  </div>
                  <div className="cp-sync-card-subtitle">
                    {syncPrompt.accountName
                      ? i18n.t('overlay.syncPromptSubtitleWithAccount', {
                          platform: syncPrompt.platformLabel,
                          account: syncPrompt.accountName,
                        })
                      : i18n.t('overlay.syncPromptSubtitle', {
                          platform: syncPrompt.platformLabel,
                        })}
                  </div>
                </div>
                <button
                  type="button"
                  className="cp-sync-close-btn"
                  aria-label={i18n.t('overlay.syncPromptCloseAria')}
                  onClick={actions.onDismissFullSync}
                >
                  <X size={14} />
                </button>
              </div>
              <p className="cp-sync-card-desc">
                {i18n.t('overlay.syncPromptDesc')}
              </p>
              <div className="cp-sync-card-actions">
                <button
                  type="button"
                  className="cp-sync-btn-secondary"
                  onClick={actions.onDismissFullSync}
                >
                  {i18n.t('overlay.syncPromptLaterBtn')}
                </button>
                <button
                  type="button"
                  className="cp-sync-btn-primary"
                  onClick={actions.onConfirmFullSync}
                >
                  {i18n.t('overlay.syncPromptNowBtn')}
                </button>
              </div>
              <div className="cp-sync-card-hint">
                {i18n.t('overlay.syncPromptHint')}
              </div>
            </div>
          )}

          {syncBanner && (
            <div
              className={`cp-sync-banner cp-sync-banner--${syncBanner.phase}`}
              role="status"
              data-testid="cp-sync-banner"
            >
              <div className="cp-sync-banner-row">
                <span className="cp-sync-banner-icon" aria-hidden="true">
                  {syncBanner.phase === 'syncing' ? (
                    <Loader2 size={15} className="cp-spin" />
                  ) : syncBanner.phase === 'completed' ? (
                    <CheckCircle2 size={15} />
                  ) : (
                    <AlertTriangle size={15} />
                  )}
                </span>
                <div className="cp-sync-banner-body">
                  {syncBanner.phase === 'syncing' && (
                    <>
                      <div className="cp-sync-banner-title">
                        {i18n.t('overlay.syncBannerSyncingTitle')}
                      </div>
                      <div className="cp-sync-banner-sub">
                        {i18n.t('overlay.syncBannerSyncingSub', {
                          fetched: syncBanner.fetchedCount,
                          added: syncBanner.addedCount,
                        })}
                        {syncBanner.deduplicatedCount > 0
                          ? i18n.t('overlay.syncBannerExistingPart', {
                              count: syncBanner.deduplicatedCount,
                            })
                          : ''}
                        {(syncBanner.skippedOversizedCount ?? 0) > 0
                          ? i18n.t('overlay.syncBannerSkippedOversizedPart', {
                              count: syncBanner.skippedOversizedCount ?? 0,
                            })
                          : ''}
                      </div>
                    </>
                  )}
                  {syncBanner.phase === 'completed' && (
                    <>
                      <div className="cp-sync-banner-title">
                        {syncBanner.message ??
                          i18n.t('overlay.syncBannerCompletedDefault')}
                      </div>
                      <div className="cp-sync-banner-sub">
                        {i18n.t('overlay.syncBannerCompletedSub', {
                          fetched: syncBanner.fetchedCount,
                          added: syncBanner.addedCount,
                        })}
                        {syncBanner.deduplicatedCount > 0
                          ? i18n.t('overlay.syncBannerDedupPart', {
                              count: syncBanner.deduplicatedCount,
                            })
                          : ''}
                        {(syncBanner.skippedOversizedCount ?? 0) > 0
                          ? i18n.t('overlay.syncBannerSkippedOversizedPart', {
                              count: syncBanner.skippedOversizedCount ?? 0,
                            })
                          : ''}
                      </div>
                    </>
                  )}
                  {syncBanner.phase === 'fallback' && (
                    <>
                      <div className="cp-sync-banner-title">
                        {i18n.t('overlay.syncBannerFallbackTitle')}
                      </div>
                      <div className="cp-sync-banner-sub">
                        {syncBanner.message ??
                          i18n.t('overlay.syncBannerFallbackDefault')}
                      </div>
                      {syncBanner.fallbackUrl && (
                        <button
                          type="button"
                          className="cp-sync-fallback-btn"
                          onClick={() =>
                            actions.onOpenFallbackPage(syncBanner.fallbackUrl!)
                          }
                        >
                          <span>{i18n.t('overlay.syncBannerFallbackBtn')}</span>
                          <ExternalLink size={12} />
                        </button>
                      )}
                    </>
                  )}
                  {syncBanner.phase === 'error' && (
                    <>
                      <div className="cp-sync-banner-title">
                        {i18n.t('overlay.syncBannerErrorTitle')}
                      </div>
                      <div className="cp-sync-banner-sub">
                        {syncBanner.message ??
                          i18n.t('overlay.syncBannerErrorDefault')}
                      </div>
                    </>
                  )}
                </div>
                {syncBanner.phase === 'syncing' ? (
                  <button
                    type="button"
                    className="cp-sync-cancel-btn"
                    onClick={actions.onCancelFullSync}
                  >
                    {i18n.t('common.cancel')}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="cp-sync-close-btn"
                    aria-label={i18n.t('overlay.syncBannerCloseAria')}
                    onClick={actions.onDismissSyncBanner}
                  >
                    <X size={14} />
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {floatingButtonEnabled && (
        <div className="cp-fab-wrap">
          {fabCollapsed ? (
            <button
              type="button"
              className="cp-fab-mini-btn"
              title={i18n.t('overlay.fabExpandTitle')}
              aria-label={i18n.t('overlay.fabExpandAria')}
              onClick={() => setFabCollapsed(false)}
            >
              {isCapturing ? (
                <Loader2 size={16} className="cp-spin" />
              ) : (
                <BookmarkPlus size={16} />
              )}
            </button>
          ) : (
            <>
              <button
                type="button"
                className="cp-fab-btn"
                title={i18n.t('overlay.fabCaptureTitle')}
                disabled={isCapturing}
                onClick={actions.onTriggerCapture}
              >
                <span className="cp-fab-icon-badge" aria-hidden="true">
                  {isCapturing ? (
                    <Loader2 size={14} className="cp-spin" />
                  ) : (
                    <BookmarkPlus size={14} />
                  )}
                </span>
                <span>
                  {isCapturing
                    ? i18n.t('overlay.fabCapturing')
                    : i18n.t('overlay.fabCapture')}
                </span>
                <span className="cp-fab-kbd">Alt+S</span>
              </button>
              {actions.onSelectSessionFolder && (
                <div className="cp-fab-folder-wrap" ref={folderWrapRef}>
                  <button
                    type="button"
                    className={`cp-fab-folder-btn${
                      sessionFolderId !== undefined
                        ? ' cp-fab-folder-btn--locked'
                        : ''
                    }`}
                    data-testid="cp-fab-folder-btn"
                    title={i18n.t('overlay.fabFolderBtnTitle')}
                    aria-expanded={folderMenuOpen}
                    onClick={() => {
                      const nextOpen = !folderMenuOpen;
                      setFolderMenuOpen(nextOpen);
                      if (nextOpen) {
                        actions.onRefreshFolders?.();
                      }
                    }}
                  >
                    {sessionFolderId === undefined ? (
                      <Sparkles size={12} />
                    ) : (
                      <Folder size={12} />
                    )}
                    <span className="cp-fab-folder-name">
                      {sessionFolderLabel}
                    </span>
                    <ChevronDown size={11} />
                  </button>
                  {folderMenuOpen && (
                    <div
                      className="cp-fab-folder-popover"
                      role="menu"
                      data-testid="cp-fab-folder-popover"
                    >
                      <div className="cp-fab-folder-popover-head">
                        {i18n.t('overlay.fabFolderPopoverTitle')}
                      </div>
                      <div className="cp-fab-folder-popover-list">
                        <button
                          type="button"
                          role="menuitemradio"
                          aria-checked={sessionFolderId === undefined}
                          data-testid="cp-fab-folder-opt-auto"
                          className={`cp-fab-folder-opt${
                            sessionFolderId === undefined
                              ? ' cp-fab-folder-opt--active'
                              : ''
                          }`}
                          onClick={() => {
                            actions.onSelectSessionFolder?.(undefined);
                            setFolderMenuOpen(false);
                          }}
                        >
                          <Sparkles size={12} />
                          <span className="cp-fab-folder-opt-label">
                            {autoClassifyEnabled
                              ? i18n.t('overlay.fabFolderOptionAuto')
                              : i18n.t('overlay.fabFolderOptionDefault')}
                          </span>
                          {sessionFolderId === undefined && <Check size={12} />}
                        </button>
                        <button
                          type="button"
                          role="menuitemradio"
                          aria-checked={sessionFolderId === null}
                          data-testid="cp-fab-folder-opt-uncategorized"
                          className={`cp-fab-folder-opt${
                            sessionFolderId === null
                              ? ' cp-fab-folder-opt--active'
                              : ''
                          }`}
                          onClick={() => {
                            actions.onSelectSessionFolder?.(null);
                            setFolderMenuOpen(false);
                          }}
                        >
                          <Folder size={12} />
                          <span className="cp-fab-folder-opt-label">
                            {i18n.t('overlay.fabFolderOptionUncategorized')}
                          </span>
                          {sessionFolderId === null && <Check size={12} />}
                        </button>
                        {flatFolders.map((opt) => {
                          const active = sessionFolderId === opt.id;
                          return (
                            <button
                              key={opt.id}
                              type="button"
                              role="menuitemradio"
                              aria-checked={active}
                              data-testid={`cp-fab-folder-opt-${opt.id}`}
                              className={`cp-fab-folder-opt${
                                active ? ' cp-fab-folder-opt--active' : ''
                              }`}
                              onClick={() => {
                                actions.onSelectSessionFolder?.(opt.id);
                                setFolderMenuOpen(false);
                              }}
                            >
                              <Folder size={12} />
                              <span className="cp-fab-folder-opt-label">
                                {opt.label}
                              </span>
                              {active && <Check size={12} />}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              )}
              <button
                type="button"
                className="cp-fab-collapse-btn"
                title={i18n.t('overlay.fabCollapseTitle')}
                aria-label={i18n.t('overlay.fabCollapseAria')}
                onClick={() => {
                  setFolderMenuOpen(false);
                  setFabCollapsed(true);
                }}
              >
                <ChevronLeft size={14} />
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
