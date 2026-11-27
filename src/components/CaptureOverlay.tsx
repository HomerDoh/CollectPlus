/**
 * Collect+ 页面 Shadow DOM 浮层组件：
 * - 左下角轻悬浮采集按钮（支持折叠与加载防重）；
 * - 首次进入已登录站点时的全量收藏同步询问卡片与同步进度/风控兜底横幅。
 */

import {
  AlertTriangle,
  BookmarkPlus,
  CheckCircle2,
  ChevronLeft,
  ExternalLink,
  HardDrive,
  Loader2,
  RefreshCw,
  X,
} from 'lucide-react';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { formatBytes } from '../entrypoints/library/utils/format.ts';

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
}

export interface CaptureOverlayProps {
  store: CaptureOverlayStore;
  actions: CaptureOverlayActions;
}

export function CaptureOverlay({ store, actions }: CaptureOverlayProps) {
  const {
    isCapturing,
    floatingButtonEnabled,
    syncPrompt,
    syncBanner,
    oversizedPrompt = null,
  } = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [fabCollapsed, setFabCollapsed] = useState(false);
  const [remainingSeconds, setRemainingSeconds] = useState(5);

  const oversizedPromptId = oversizedPrompt?.id ?? null;

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

  if (!floatingButtonEnabled && !syncPrompt && !syncBanner && !oversizedPrompt) {
    return null;
  }

  return (
    <div className="cp-overlay-root">
      {(oversizedPrompt || syncPrompt || syncBanner) && (
        <div className="cp-toast-stack">
          {oversizedPrompt && (
            <div
              className="cp-oversized-prompt"
              role="alertdialog"
              aria-modal="false"
              aria-label="视频体积过大已取消自动保存"
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
                    视频过大，已取消自动保存
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
                  aria-label="跳过并关闭"
                  onClick={() => actions.onSkipOversized?.()}
                >
                  <X size={14} />
                </button>
              </div>
              <div
                className="cp-oversized-size-row"
                data-testid="cp-oversized-size"
              >
                <span>视频容量：</span>
                <strong className="cp-oversized-size-val">
                  {formatBytes(oversizedPrompt.videoSizeBytes)}
                </strong>
                <span className="cp-oversized-size-limit">
                  （上限 {oversizedPrompt.thresholdMb} MB）
                </span>
              </div>
              <div className="cp-sync-card-actions">
                <button
                  type="button"
                  className="cp-sync-btn-secondary"
                  data-testid="cp-oversized-skip-btn"
                  onClick={() => actions.onSkipOversized?.()}
                >
                  跳过 ({remainingSeconds}s)
                </button>
                <button
                  type="button"
                  className="cp-sync-btn-primary"
                  data-testid="cp-oversized-save-btn"
                  onClick={() => actions.onConfirmOversizedSave?.()}
                >
                  继续保存
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
          aria-label="是否同步账号全部收藏数据"
          data-testid="cp-sync-prompt"
        >
          <div className="cp-sync-card-head">
            <span className="cp-sync-icon-badge" aria-hidden="true">
              <RefreshCw size={15} />
            </span>
            <div className="cp-sync-card-title-wrap">
              <div className="cp-sync-card-title">同步账号全部收藏？</div>
              <div className="cp-sync-card-subtitle">
                检测到已登录{syncPrompt.platformLabel}账号
                {syncPrompt.accountName ? `（${syncPrompt.accountName}）` : ''}
              </div>
            </div>
            <button
              type="button"
              className="cp-sync-close-btn"
              aria-label="暂不同步并关闭"
              onClick={actions.onDismissFullSync}
            >
              <X size={14} />
            </button>
          </div>
          <p className="cp-sync-card-desc">
            是否将当前账号的全部历史收藏数据同步到 Collect+ 本地离线库？已收藏条目会自动去重跳过。
          </p>
          <div className="cp-sync-card-actions">
            <button
              type="button"
              className="cp-sync-btn-secondary"
              onClick={actions.onDismissFullSync}
            >
              暂不同步
            </button>
            <button
              type="button"
              className="cp-sync-btn-primary"
              onClick={actions.onConfirmFullSync}
            >
              立即同步
            </button>
          </div>
          <div className="cp-sync-card-hint">
            可在 Collect+ 设置中开启「自动同步全部收藏」
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
                    正在同步账号全部收藏...
                  </div>
                  <div className="cp-sync-banner-sub">
                    已扫描 {syncBanner.fetchedCount} 条 · 新增{' '}
                    {syncBanner.addedCount} 条
                    {syncBanner.deduplicatedCount > 0
                      ? ` · 已存在 ${syncBanner.deduplicatedCount} 条`
                      : ''}
                    {(syncBanner.skippedOversizedCount ?? 0) > 0
                      ? ` · 跳过过大 ${syncBanner.skippedOversizedCount} 条`
                      : ''}
                  </div>
                </>
              )}
              {syncBanner.phase === 'completed' && (
                <>
                  <div className="cp-sync-banner-title">
                    {syncBanner.message ?? '账号全部收藏已加入离线下载队列'}
                  </div>
                  <div className="cp-sync-banner-sub">
                    共扫描 {syncBanner.fetchedCount} 条 · 新增{' '}
                    {syncBanner.addedCount} 条
                    {syncBanner.deduplicatedCount > 0
                      ? ` · 去重 ${syncBanner.deduplicatedCount} 条`
                      : ''}
                    {(syncBanner.skippedOversizedCount ?? 0) > 0
                      ? ` · 跳过过大 ${syncBanner.skippedOversizedCount} 条`
                      : ''}
                  </div>
                </>
              )}
              {syncBanner.phase === 'fallback' && (
                <>
                  <div className="cp-sync-banner-title">
                    已切换为被动旁路同步模式
                  </div>
                  <div className="cp-sync-banner-sub">
                    {syncBanner.message ??
                      '主动分页拉取受限，已安全中止。请前往「我的收藏」页滚动浏览，插件将自动旁路同步。'}
                  </div>
                  {syncBanner.fallbackUrl && (
                    <button
                      type="button"
                      className="cp-sync-fallback-btn"
                      onClick={() =>
                        actions.onOpenFallbackPage(syncBanner.fallbackUrl!)
                      }
                    >
                      <span>前往「我的收藏」页被动同步</span>
                      <ExternalLink size={12} />
                    </button>
                  )}
                </>
              )}
              {syncBanner.phase === 'error' && (
                <>
                  <div className="cp-sync-banner-title">全量收藏同步未完成</div>
                  <div className="cp-sync-banner-sub">
                    {syncBanner.message ?? '拉取过程中发生异常，请稍后重试。'}
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
                取消
              </button>
            ) : (
              <button
                type="button"
                className="cp-sync-close-btn"
                aria-label="关闭同步提示"
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
              title="展开 Collect+ 收藏按钮 (Alt+S)"
              aria-label="展开 Collect+ 收藏按钮"
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
                title="收藏当前作品到 Collect+ (快捷键 Alt+S)"
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
                <span>{isCapturing ? '采集中...' : '收藏当前'}</span>
                <span className="cp-fab-kbd">Alt+S</span>
              </button>
              <button
                type="button"
                className="cp-fab-collapse-btn"
                title="收起悬浮按钮"
                aria-label="收起悬浮按钮"
                onClick={() => setFabCollapsed(true)}
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
