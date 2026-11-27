import { useCallback, useEffect, useState } from 'react';
import {
  AlertCircle,
  BookmarkPlus,
  CheckCircle2,
  Clock,
  CloudOff,
  Download,
  ExternalLink,
  FolderOpen,
  FolderSync,
  Heart,
  Layers,
  Loader2,
  Pin,
  Sparkles,
} from 'lucide-react';
import { sendToBackground } from '@/types/messages.ts';
import {
  PIN_HINT_PENDING_KEY,
  type AutoSyncExclusionReason,
  type PlatformId,
} from '@/types/schema.ts';
import { getErrorMessage } from '../library/utils/format.ts';

const POPUP_SKIP_REASONS: ReadonlyArray<{
  reason: AutoSyncExclusionReason;
  label: string;
}> = [
  { reason: 'support_author', label: '支持作者' },
  { reason: 'watch_later', label: '稍后观看' },
  { reason: 'skip_local_save', label: '仅存元数据' },
];

interface PopupSummary {
  supportedPlatform: PlatformId | null;
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

const PLATFORM_READY_TEXT: Record<PlatformId, string> = {
  douyin: '已就绪：抖音网页版（收藏自动拦截已开启）',
  bilibili: '已就绪：B站网页版（收藏自动拦截已开启）',
  v2ex: '已就绪：V2EX 网页版（收藏自动拦截已开启）',
  zhihu: '已就绪：知乎网页版（收藏自动拦截已开启）',
  youtube: '已就绪：YouTube 网页版',
  xiaohongshu: '已就绪：小红书网页版（收藏自动拦截已开启）',
  twitter: '已就绪：X / Twitter 网页版',
  instagram: '已就绪：Instagram 网页版',
};

export default function App() {
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

      const response = await sendToBackground({
        target: 'background',
        type: 'GET_STATUS_SUMMARY',
        ...(activeTab?.url ? { tabUrl: activeTab.url } : {}),
      });

      if (!response.ok) {
        setSummaryError(response.error);
        return;
      }

      setSummary({
        supportedPlatform: response.supportedPlatform,
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
      const response = await sendToBackground({
        target: 'background',
        type: 'TRIGGER_ACTIVE_TAB_CAPTURE',
        ...(activeTabId !== undefined ? { tabId: activeTabId } : {}),
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
        message: '已触发采集，媒体正在后台静默下载',
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
        message: `已取消本地持久化（${reasonLabel}），仅保留元数据并跳过后续自动同步`,
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
        message: `打开管理台失败：${getErrorMessage(error)}`,
      });
    }
  };

  const pendingSyncCount = summary
    ? summary.stagedCount + summary.metaDirtyCount
    : 0;

  return (
    <main className="flex w-[350px] flex-col gap-3 bg-slate-50 p-3.5 text-slate-900">
      {/* 顶部品牌栏 */}
      <header className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2.5">
          <span className="inline-flex h-8 w-8 items-center justify-center rounded-xl bg-indigo-600 text-white shadow-xs">
            <BookmarkPlus className="h-4 w-4" />
          </span>
          <div>
            <h1 className="text-sm font-semibold leading-tight text-slate-900">
              Collect+
            </h1>
            <p className="text-[11px] text-slate-500">本地优先防失效收藏</p>
          </div>
        </div>
      </header>

      {/* 首次安装：固定到插件栏提示 */}
      {showPinHint && (
        <section
          data-testid="popup-pin-hint"
          className="flex items-start gap-2 rounded-xl border border-indigo-200 bg-indigo-50/80 p-2.5 text-xs text-indigo-900"
        >
          <Pin className="mt-0.5 h-3.5 w-3.5 shrink-0 text-indigo-600" />
          <div className="min-w-0 flex-1">
            <p className="font-semibold leading-snug">
              将 Collect+ 固定到浏览器插件栏
            </p>
            <p className="mt-0.5 text-[11px] leading-relaxed text-indigo-700/90">
              点击右上角拼图图标，点亮 Collect+ 右侧图钉，随时查看下载进度与快捷收藏。
            </p>
          </div>
          <button
            type="button"
            onClick={handleDismissPinHint}
            aria-label="关闭固定提示"
            className="shrink-0 rounded-md px-1.5 py-0.5 text-[11px] font-medium text-indigo-700 transition hover:bg-indigo-100"
          >
            知道了
          </button>
        </section>
      )}

      {/* 未选定本地同步目录提示 */}
      {summary !== null && !summary.hasVaultDirectory && (
        <section
          data-testid="popup-vault-hint"
          className="flex items-center justify-between gap-2.5 rounded-xl border border-amber-200 bg-amber-50/80 p-2.5 text-xs text-amber-950"
        >
          <div className="flex min-w-0 items-start gap-2">
            <FolderOpen className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" />
            <div className="min-w-0">
              <p className="font-semibold leading-snug">
                尚未选定本地同步目录
              </p>
              <p className="mt-0.5 text-[11px] leading-relaxed text-amber-800/90">
                选择目录后，收藏作品将自动落盘备份。
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => void handleOpenLibrary('vault')}
            className="shrink-0 rounded-lg bg-amber-600 px-2.5 py-1.5 text-[11px] font-semibold text-white shadow-2xs transition hover:bg-amber-700"
          >
            选择目录
          </button>
        </section>
      )}

      {/* 当前标签页状态卡 */}
      <section className="rounded-xl border border-slate-200 bg-white p-3 shadow-2xs">
        {loadingSummary && !summary ? (
          <div className="flex items-center gap-2 py-2 text-xs text-slate-500">
            <Loader2 className="h-4 w-4 animate-spin text-indigo-600" />
            <span>正在检测当前页面状态...</span>
          </div>
        ) : summaryError ? (
          <div className="flex items-start gap-2 rounded-lg bg-rose-50 p-2.5 text-xs text-rose-700">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>状态读取失败：{summaryError}</span>
          </div>
        ) : summary?.supportedPlatform ? (
          <div className="flex flex-col gap-2.5">
            <div className="flex items-center gap-2">
              <span className="relative flex h-2.5 w-2.5 shrink-0">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
                <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-emerald-500" />
              </span>
              <p className="text-xs font-medium text-emerald-800">
                {PLATFORM_READY_TEXT[summary.supportedPlatform]}
              </p>
            </div>

            <button
              type="button"
              onClick={() => void handleTriggerCapture()}
              disabled={captureFeedback.state === 'loading' || skipSubmitting}
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-indigo-600 px-3.5 py-2.5 text-xs font-semibold text-white shadow-xs transition hover:bg-indigo-700 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-65"
            >
              {captureFeedback.state === 'loading' ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span>正在采集当前作品...</span>
                </>
              ) : (
                <>
                  <Sparkles className="h-4 w-4" />
                  <span>立即收藏当前作品 (Alt+S)</span>
                </>
              )}
            </button>

            <button
              type="button"
              data-testid="popup-skip-persistence-btn"
              onClick={() => setSkipPanelOpen((prev) => !prev)}
              disabled={captureFeedback.state === 'loading' || skipSubmitting}
              aria-expanded={skipPanelOpen}
              className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs font-semibold text-slate-700 transition hover:border-slate-300 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-65"
            >
              {skipSubmitting ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-slate-500" />
                  <span>正在取消本地持久化...</span>
                </>
              ) : (
                <>
                  <CloudOff className="h-3.5 w-3.5 text-slate-500" />
                  <span>取消当前内容本地持久化</span>
                </>
              )}
            </button>

            {skipPanelOpen && (
              <div
                data-testid="popup-skip-persistence-panel"
                className="flex flex-col gap-2 rounded-lg border border-slate-200 bg-slate-50/90 p-2.5"
              >
                <p className="text-[11px] leading-snug text-slate-600">
                  选择未保存原因（仅保留元数据，后续打开网站不再自动下载）：
                </p>
                <div className="grid grid-cols-3 gap-1.5">
                  {POPUP_SKIP_REASONS.map(({ reason, label }) => (
                    <button
                      key={reason}
                      type="button"
                      data-testid={`popup-skip-reason-${reason.replaceAll('_', '-')}`}
                      disabled={skipSubmitting}
                      onClick={() =>
                        void handleSkipLocalPersistence(reason, label)
                      }
                      className="inline-flex items-center justify-center gap-1 rounded-md border border-slate-200 bg-white px-2 py-1.5 text-[11px] font-semibold text-slate-700 shadow-2xs transition hover:border-indigo-300 hover:bg-indigo-50 hover:text-indigo-700 disabled:opacity-60"
                    >
                      {reason === 'support_author' ? (
                        <Heart className="h-3 w-3 text-pink-500" />
                      ) : reason === 'watch_later' ? (
                        <Clock className="h-3 w-3 text-sky-500" />
                      ) : (
                        <CloudOff className="h-3 w-3 text-violet-500" />
                      )}
                      <span>{label}</span>
                    </button>
                  ))}
                </div>
                <input
                  type="text"
                  data-testid="popup-skip-detail-input"
                  value={skipDetail}
                  onChange={(e) => setSkipDetail(e.target.value)}
                  placeholder="补充原因（可选，点击上方原因按钮生效）"
                  maxLength={120}
                  className="w-full rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-[11px] text-slate-800 placeholder:text-slate-400 focus:border-indigo-400 focus:outline-none"
                />
              </div>
            )}

            {captureFeedback.state === 'success' && (
              <div className="flex items-center gap-1.5 rounded-lg bg-emerald-50 px-2.5 py-1.5 text-[11px] font-medium text-emerald-700">
                <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                <span>{captureFeedback.message}</span>
              </div>
            )}

            {captureFeedback.state === 'error' && (
              <div className="flex items-start gap-1.5 rounded-lg bg-rose-50 px-2.5 py-1.5 text-[11px] text-rose-700">
                <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>{captureFeedback.message}</span>
              </div>
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <div className="flex items-start gap-2">
              <span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-slate-300" />
              <p className="text-xs leading-relaxed text-slate-600">
                当前页面暂不支持采集，前往抖音、B站、V2EX、小红书或知乎网页版即可使用
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <a
                href="https://www.douyin.com/"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex w-fit items-center gap-1 text-[11px] font-medium text-indigo-600 hover:text-indigo-700 hover:underline"
              >
                <span>抖音</span>
                <ExternalLink className="h-3 w-3" />
              </a>
              <a
                href="https://www.bilibili.com/"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex w-fit items-center gap-1 text-[11px] font-medium text-indigo-600 hover:text-indigo-700 hover:underline"
              >
                <span>B站</span>
                <ExternalLink className="h-3 w-3" />
              </a>
              <a
                href="https://www.v2ex.com/"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex w-fit items-center gap-1 text-[11px] font-medium text-indigo-600 hover:text-indigo-700 hover:underline"
              >
                <span>V2EX</span>
                <ExternalLink className="h-3 w-3" />
              </a>
              <a
                href="https://www.xiaohongshu.com/"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex w-fit items-center gap-1 text-[11px] font-medium text-indigo-600 hover:text-indigo-700 hover:underline"
              >
                <span>小红书</span>
                <ExternalLink className="h-3 w-3" />
              </a>
              <a
                href="https://www.zhihu.com/"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex w-fit items-center gap-1 text-[11px] font-medium text-indigo-600 hover:text-indigo-700 hover:underline"
              >
                <span>知乎</span>
                <ExternalLink className="h-3 w-3" />
              </a>
            </div>
          </div>
        )}
      </section>

      {/* 3 列统计指标卡 */}
      <section className="grid grid-cols-3 gap-2">
        <div className="flex flex-col gap-1 rounded-xl border border-slate-200 bg-white px-2.5 py-2.5 shadow-2xs">
          <div className="flex items-center gap-1 text-[11px] text-slate-500">
            <Layers className="h-3 w-3 text-indigo-500" />
            <span>总收藏</span>
          </div>
          <span className="text-lg font-bold tabular-nums text-slate-900">
            {summary ? summary.totalItems : '-'}
          </span>
        </div>

        <div
          className={`flex flex-col gap-1 rounded-xl border px-2.5 py-2.5 shadow-2xs ${
            pendingSyncCount > 0
              ? 'border-amber-200 bg-amber-50/60'
              : 'border-slate-200 bg-white'
          }`}
        >
          <div className="flex items-center gap-1 text-[11px] text-slate-500">
            <FolderSync
              className={`h-3 w-3 ${
                pendingSyncCount > 0 ? 'text-amber-600' : 'text-slate-400'
              }`}
            />
            <span>待同步</span>
          </div>
          <span
            className={`text-lg font-bold tabular-nums ${
              pendingSyncCount > 0 ? 'text-amber-700' : 'text-slate-900'
            }`}
          >
            {summary ? pendingSyncCount : '-'}
          </span>
        </div>

        <div
          className={`flex flex-col gap-1 rounded-xl border px-2.5 py-2.5 shadow-2xs ${
            summary && summary.activeTaskCount > 0
              ? 'border-indigo-200 bg-indigo-50/60'
              : 'border-slate-200 bg-white'
          }`}
        >
          <div className="flex items-center gap-1 text-[11px] text-slate-500">
            <Download
              className={`h-3 w-3 ${
                summary && summary.activeTaskCount > 0
                  ? 'text-indigo-600'
                  : 'text-slate-400'
              }`}
            />
            <span>下载中</span>
          </div>
          <span
            className={`text-lg font-bold tabular-nums ${
              summary && summary.activeTaskCount > 0
                ? 'text-indigo-700'
                : 'text-slate-900'
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
        className="flex w-full items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white px-3.5 py-2.5 text-xs font-semibold text-slate-800 shadow-2xs transition hover:border-indigo-300 hover:bg-indigo-50/50 hover:text-indigo-700"
      >
        <span>打开 Collect+ 全屏管理台</span>
        {pendingSyncCount > 0 && (
          <span className="inline-flex min-w-5 items-center justify-center rounded-full bg-amber-500 px-1.5 py-0.5 text-[10px] font-bold leading-none text-white">
            {pendingSyncCount > 99 ? '99+' : pendingSyncCount}
          </span>
        )}
        <ExternalLink className="h-3.5 w-3.5 text-slate-400" />
      </button>
    </main>
  );
}
