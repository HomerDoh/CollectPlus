import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  AlertTriangle,
  BookmarkPlus,
  ChevronRight,
  Clock,
  Download,
  ExternalLink,
  FileText,
  Film,
  FolderSync,
  Images,
  Loader2,
  RotateCcw,
  X,
} from 'lucide-react';
import { db } from '@/storage/db.ts';
import { sendToBackground } from '@/types/messages.ts';
import type { CollectionItemRecord, DownloadTask } from '@/types/schema.ts';
import {
  formatBytes,
  formatRelativeTime,
  getErrorMessage,
  mediaKindLabel,
  syncStatusMeta,
} from '../library/utils/format.ts';

interface SidePanelData {
  activeTasks: DownloadTask[];
  failedTasks: DownloadTask[];
  recentItems: CollectionItemRecord[];
  pendingSyncCount: number;
}

const TASK_STATUS_LABEL: Record<
  Extract<DownloadTask['status'], 'queued' | 'downloading' | 'processing'>,
  string
> = {
  queued: '排队中',
  downloading: '下载中',
  processing: '处理中',
};

export default function App() {
  const [busyTaskIds, setBusyTaskIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [actionError, setActionError] = useState<string | null>(null);

  const data = useLiveQuery<SidePanelData>(async () => {
    const [allActive, allFailed, allItems] = await Promise.all([
      db.tasks
        .where('status')
        .anyOf(['queued', 'downloading', 'processing'])
        .sortBy('createdAt'),
      db.tasks.where('status').equals('failed').toArray(),
      db.items.orderBy('collectedAt').reverse().toArray(),
    ]);

    allFailed.sort((a, b) => b.updatedAt - a.updatedAt);
    const failedTasks = allFailed.slice(0, 5);

    const visibleItems: CollectionItemRecord[] = [];
    let pendingSyncCount = 0;

    for (const item of allItems) {
      if (item.deletedAt != null) {
        continue;
      }
      if (
        item.syncStatus === 'opfs_staged' ||
        item.syncStatus === 'meta_dirty'
      ) {
        pendingSyncCount += 1;
      }
      if (visibleItems.length < 25) {
        visibleItems.push(item);
      }
    }

    return {
      activeTasks: allActive,
      failedTasks,
      recentItems: visibleItems,
      pendingSyncCount,
    };
  }, []);

  const markTaskBusy = (taskId: string, busy: boolean) => {
    setBusyTaskIds((prev) => {
      const next = new Set(prev);
      if (busy) {
        next.add(taskId);
      } else {
        next.delete(taskId);
      }
      return next;
    });
  };

  const handleOpenLibrary = async (itemId?: string) => {
    setActionError(null);
    try {
      await sendToBackground({
        target: 'background',
        type: 'OPEN_LIBRARY_PAGE',
        ...(itemId !== undefined ? { itemId } : {}),
      });
    } catch (error) {
      setActionError(`打开管理台失败：${getErrorMessage(error)}`);
    }
  };

  const handleCancelTask = async (taskId: string) => {
    setActionError(null);
    markTaskBusy(taskId, true);
    try {
      const res = await sendToBackground({
        target: 'background',
        type: 'CANCEL_DOWNLOAD_TASK',
        taskId,
      });
      if (!res.ok) {
        setActionError(res.error);
      }
    } catch (error) {
      setActionError(`取消任务失败：${getErrorMessage(error)}`);
    } finally {
      markTaskBusy(taskId, false);
    }
  };

  const handleRetryTask = async (taskId: string) => {
    setActionError(null);
    markTaskBusy(taskId, true);
    try {
      const res = await sendToBackground({
        target: 'background',
        type: 'RETRY_DOWNLOAD_TASK',
        taskId,
      });
      if (!res.ok) {
        setActionError(res.error);
      }
    } catch (error) {
      setActionError(`重试任务失败：${getErrorMessage(error)}`);
    } finally {
      markTaskBusy(taskId, false);
    }
  };

  const activeTasks = data?.activeTasks ?? [];
  const failedTasks = data?.failedTasks ?? [];
  const recentItems = data?.recentItems ?? [];
  const pendingSyncCount = data?.pendingSyncCount ?? 0;

  return (
    <div className="flex min-h-screen flex-col bg-slate-50 text-slate-900">
      {/* 顶部标题栏 */}
      <header className="sticky top-0 z-10 flex items-center justify-between gap-2 border-b border-slate-200 bg-white/95 px-3.5 py-3 backdrop-blur-xs">
        <div className="flex items-center gap-2">
          <span className="inline-flex h-8 w-8 items-center justify-center rounded-xl bg-indigo-600 text-white shadow-xs">
            <BookmarkPlus className="h-4 w-4" />
          </span>
          <div>
            <h1 className="text-sm font-semibold leading-tight text-slate-900">
              Collect+ 侧边栏
            </h1>
            <p className="text-[11px] text-slate-500">实时下载队列与最近收藏</p>
          </div>
        </div>

        <button
          type="button"
          onClick={() => void handleOpenLibrary()}
          className="inline-flex items-center gap-1 rounded-lg bg-indigo-600 px-2.5 py-1.5 text-xs font-medium text-white shadow-2xs transition hover:bg-indigo-700"
        >
          <span>打开管理台</span>
          <ExternalLink className="h-3 w-3" />
        </button>
      </header>

      <main className="flex flex-1 flex-col gap-3 p-3">
        {/* 操作错误提示 */}
        {actionError && (
          <div className="flex items-start justify-between gap-2 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
            <span className="leading-relaxed">{actionError}</span>
            <button
              type="button"
              onClick={() => setActionError(null)}
              className="rounded p-0.5 text-rose-500 hover:bg-rose-100"
              aria-label="关闭提示"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}

        {/* 待同步提示条 */}
        {pendingSyncCount > 0 && (
          <button
            type="button"
            onClick={() => void handleOpenLibrary()}
            className="flex w-full items-center justify-between gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-left transition hover:bg-amber-100/75"
          >
            <div className="flex items-center gap-2.5 min-w-0">
              <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-amber-500/15 text-amber-700">
                <FolderSync className="h-4 w-4" />
              </span>
              <div className="min-w-0">
                <p className="text-xs font-semibold text-amber-900">
                  {pendingSyncCount} 条内容待同步至 CollectVault
                </p>
                <p className="truncate text-[11px] text-amber-700">
                  前往管理台一键落盘到本地硬盘目录
                </p>
              </div>
            </div>
            <ChevronRight className="h-4 w-4 shrink-0 text-amber-600" />
          </button>
        )}

        {/* 下载任务队列区 */}
        <section className="flex flex-col gap-2">
          <div className="flex items-center justify-between px-0.5">
            <h2 className="flex items-center gap-1.5 text-xs font-semibold text-slate-700">
              <Download className="h-3.5 w-3.5 text-indigo-600" />
              <span>下载任务队列</span>
            </h2>
            {activeTasks.length > 0 && (
              <span className="rounded-full bg-indigo-100 px-2 py-0.5 text-[10px] font-semibold text-indigo-700">
                {activeTasks.length} 进行中
              </span>
            )}
          </div>

          {activeTasks.length === 0 && failedTasks.length === 0 ? (
            <div className="rounded-xl border border-dashed border-slate-200 bg-white px-3 py-3 text-center text-xs text-slate-400">
              当前无进行中的下载任务
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {activeTasks.map((task) => {
                const isBusy = busyTaskIds.has(task.id);
                const statusText =
                  task.status === 'queued' ||
                  task.status === 'downloading' ||
                  task.status === 'processing'
                    ? TASK_STATUS_LABEL[task.status]
                    : '处理中';
                const bytesLabel =
                  task.totalBytes > 0
                    ? `${formatBytes(task.downloadedBytes)} / ${formatBytes(task.totalBytes)}`
                    : task.downloadedBytes > 0
                      ? formatBytes(task.downloadedBytes)
                      : '准备中...';

                return (
                  <div
                    key={task.id}
                    className="rounded-xl border border-slate-200 bg-white p-2.5 shadow-2xs"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <p className="line-clamp-1 text-xs font-medium text-slate-900">
                        {task.title}
                      </p>
                      <button
                        type="button"
                        onClick={() => void handleCancelTask(task.id)}
                        disabled={isBusy}
                        title="取消下载任务"
                        className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-slate-400 transition hover:bg-rose-50 hover:text-rose-600 disabled:opacity-50"
                      >
                        {isBusy ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <X className="h-3.5 w-3.5" />
                        )}
                      </button>
                    </div>

                    <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
                      <div
                        className="h-full rounded-full bg-indigo-600 transition-all duration-300"
                        style={{
                          width: `${Math.max(2, Math.min(100, task.progress))}%`,
                        }}
                      />
                    </div>

                    <div className="mt-1.5 flex items-center justify-between text-[11px] text-slate-500">
                      <span className="inline-flex items-center gap-1">
                        <span className="font-medium text-indigo-600">
                          {statusText}
                        </span>
                        <span>·</span>
                        <span className="tabular-nums">{bytesLabel}</span>
                      </span>
                      <span className="font-semibold tabular-nums text-slate-700">
                        {task.progress}%
                      </span>
                    </div>
                  </div>
                );
              })}

              {failedTasks.map((task) => {
                const isBusy = busyTaskIds.has(task.id);
                return (
                  <div
                    key={task.id}
                    className="rounded-xl border border-rose-200 bg-rose-50/50 p-2.5"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-rose-500" />
                          <p className="truncate text-xs font-medium text-slate-900">
                            {task.title}
                          </p>
                        </div>
                        <p className="mt-1 line-clamp-2 text-[11px] leading-snug text-rose-700">
                          {task.errorMessage || '下载异常中断，请点击重试'}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => void handleRetryTask(task.id)}
                        disabled={isBusy}
                        className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-rose-200 bg-white px-2 py-1 text-[11px] font-medium text-rose-700 transition hover:bg-rose-50 disabled:opacity-50"
                      >
                        {isBusy ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <RotateCcw className="h-3 w-3" />
                        )}
                        <span>重试</span>
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* 最近收藏列表 */}
        <section className="flex flex-1 flex-col gap-2">
          <div className="flex items-center justify-between px-0.5">
            <h2 className="flex items-center gap-1.5 text-xs font-semibold text-slate-700">
              <Clock className="h-3.5 w-3.5 text-indigo-600" />
              <span>最近收藏</span>
            </h2>
            <span className="text-[11px] text-slate-400">
              最近 {recentItems.length} 条
            </span>
          </div>

          {!data ? (
            <div className="flex items-center justify-center gap-2 py-8 text-xs text-slate-400">
              <Loader2 className="h-4 w-4 animate-spin text-indigo-500" />
              <span>正在加载收藏列表...</span>
            </div>
          ) : recentItems.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-1.5 rounded-xl border border-dashed border-slate-200 bg-white px-4 py-8 text-center">
              <BookmarkPlus className="h-6 w-6 text-slate-300" />
              <p className="text-xs font-medium text-slate-600">暂无收藏内容</p>
              <p className="text-[11px] text-slate-400">
                在抖音网页版点击收藏或按 Alt+S 即可自动归档
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {recentItems.map((item) => {
                const statusInfo = syncStatusMeta(item.syncStatus);
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => void handleOpenLibrary(item.id)}
                    className="group flex w-full items-stretch gap-2.5 rounded-xl border border-slate-200 bg-white p-2 text-left shadow-2xs transition hover:border-indigo-300 hover:shadow-xs"
                  >
                    {/* 封面缩略图 */}
                    <div className="relative h-16 w-20 shrink-0 overflow-hidden rounded-lg bg-slate-100">
                      {item.thumbnailDataUrl ? (
                        <img
                          src={item.thumbnailDataUrl}
                          alt={item.title}
                          className="h-full w-full object-cover transition duration-300 group-hover:scale-105"
                        />
                      ) : (
                        <div className="flex h-full w-full items-center justify-center text-slate-300">
                          {item.kind === 'video' ? (
                            <Film className="h-5 w-5" />
                          ) : item.kind === 'article' ? (
                            <FileText className="h-5 w-5" />
                          ) : (
                            <Images className="h-5 w-5" />
                          )}
                        </div>
                      )}
                      <span className="absolute bottom-1 left-1 rounded bg-slate-900/75 px-1.5 py-0.5 text-[10px] font-medium text-white">
                        {mediaKindLabel(item.kind)}
                      </span>
                    </div>

                    {/* 信息区 */}
                    <div className="flex min-w-0 flex-1 flex-col justify-between py-0.5">
                      <p className="line-clamp-2 text-xs font-medium leading-snug text-slate-900 group-hover:text-indigo-700">
                        {item.title}
                      </p>

                      <div className="mt-1 flex items-center justify-between gap-1.5">
                        <span className="truncate text-[11px] text-slate-500">
                          @{item.author.name}
                        </span>
                        <div className="flex shrink-0 items-center gap-1.5">
                          <span
                            className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium ${statusInfo.badgeClass}`}
                          >
                            {statusInfo.shortLabel}
                          </span>
                          <span className="text-[10px] text-slate-400">
                            {formatRelativeTime(item.collectedAt)}
                          </span>
                        </div>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
