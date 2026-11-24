import { useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  DatabaseBackup,
  FolderCheck,
  FolderKey,
  FolderOpen,
  FolderSync,
  HardDrive,
  Loader2,
  RefreshCw,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react';
import type {
  FlushProgress,
  FlushSummary,
  RebuildProgress,
  RebuildSummary,
} from '@/storage/vault.ts';
import { formatDateTime, formatRelativeTime } from '../utils/format.ts';

export type VaultPermissionStatus = PermissionState | 'unbound';

export interface VaultBannerProps {
  vaultHandle: FileSystemDirectoryHandle | null;
  permissionState: VaultPermissionStatus;
  lastSyncAt: number | undefined;
  stagedCount: number;
  metaDirtyCount: number;
  isFlushing: boolean;
  flushProgress: FlushProgress | null;
  lastFlushSummary: FlushSummary | null;
  isRebuilding: boolean;
  rebuildProgress: RebuildProgress | null;
  lastRebuildSummary: RebuildSummary | null;
  showRebuildSuggestion: boolean;
  bannerError: string | null;
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

export function VaultBanner({
  vaultHandle,
  permissionState,
  lastSyncAt,
  stagedCount,
  metaDirtyCount,
  isFlushing,
  flushProgress,
  lastFlushSummary,
  isRebuilding,
  rebuildProgress,
  lastRebuildSummary,
  showRebuildSuggestion,
  bannerError,
  onBindVault,
  onRequestPermissionAndSync,
  onFlushToVault,
  onRebuildIndex,
  onClearBrowserCache,
  onDismissSuggestion,
  onDismissFeedback,
}: VaultBannerProps) {
  const [confirmModal, setConfirmModal] = useState<
    'rebuild' | 'clear_cache' | null
  >(null);
  const [isClearingCache, setIsClearingCache] = useState(false);

  const pendingSyncCount = stagedCount + metaDirtyCount;
  const isBusy = isFlushing || isRebuilding || isClearingCache;

  const flushPercent =
    flushProgress && flushProgress.total > 0
      ? Math.min(100, Math.round((flushProgress.current / flushProgress.total) * 100))
      : flushProgress?.phase === 'done'
        ? 100
        : 12;

  const handleConfirmRebuild = async () => {
    setConfirmModal(null);
    await onRebuildIndex();
  };

  const handleConfirmClearCache = async () => {
    setIsClearingCache(true);
    try {
      await onClearBrowserCache();
      setConfirmModal(null);
    } finally {
      setIsClearingCache(false);
    }
  };

  return (
    <div className="flex flex-col gap-2.5 border-b border-slate-200 bg-white px-6 py-3.5">
      {/* 主状态条 */}
      {permissionState === 'unbound' || !vaultHandle ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50/75 px-4 py-3">
          <div className="flex items-center gap-3">
            <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-amber-100 text-amber-700">
              <HardDrive className="h-5 w-5" />
            </span>
            <div>
              <p className="text-sm font-semibold text-amber-950">
                尚未绑定本地 CollectVault 目录，所有媒体暂存于浏览器 OPFS 中
              </p>
              <p className="text-xs text-amber-800/90">
                绑定本地硬盘目录后，媒体文件与元数据将持久化落盘为可离线迁移的真相源
                {pendingSyncCount > 0 ? `（当前有 ${pendingSyncCount} 条待落盘）` : ''}
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={() => void onBindVault()}
            disabled={isBusy}
            className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-3.5 py-2 text-xs font-semibold text-white shadow-xs transition hover:bg-indigo-700 disabled:opacity-60"
          >
            <FolderOpen className="h-4 w-4" />
            <span>选择 / 初始化 CollectVault 目录</span>
          </button>
        </div>
      ) : permissionState !== 'granted' ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-indigo-200 bg-indigo-50/60 px-4 py-3">
          <div className="flex items-center gap-3">
            <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-indigo-100 text-indigo-700">
              <FolderKey className="h-5 w-5" />
            </span>
            <div>
              <div className="flex items-center gap-2">
                <p className="text-sm font-semibold text-slate-900">
                  已绑定目录：
                  <code className="rounded bg-white px-1.5 py-0.5 text-xs font-semibold text-indigo-700 ring-1 ring-indigo-200">
                    {vaultHandle.name}
                  </code>
                </p>
                <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-800">
                  需要授权访问
                </span>
              </div>
              <p className="mt-0.5 text-xs text-slate-600">
                浏览器重启或刷新后需点击授权一次读写权限，即可自动同步落盘并离线读取本地媒体
                {pendingSyncCount > 0 ? `（待同步 ${pendingSyncCount} 条）` : ''}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void onRequestPermissionAndSync()}
              disabled={isBusy}
              className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3.5 py-2 text-xs font-semibold text-white shadow-xs transition hover:bg-indigo-700 disabled:opacity-60"
            >
              <ShieldCheck className="h-4 w-4" />
              <span>授权访问并同步</span>
            </button>
            <button
              type="button"
              onClick={() => void onBindVault()}
              disabled={isBusy}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-700 transition hover:bg-slate-50 disabled:opacity-60"
            >
              <FolderOpen className="h-3.5 w-3.5" />
              <span>切换目录</span>
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-slate-50/80 px-4 py-2.5">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
            <div className="flex items-center gap-2">
              <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-100 text-emerald-700">
                <FolderCheck className="h-4 w-4" />
              </span>
              <div>
                <div className="flex items-center gap-2">
                  <span className="inline-flex h-2 w-2 rounded-full bg-emerald-500" />
                  <span className="text-xs font-semibold text-slate-900">
                    CollectVault 已就绪
                  </span>
                  <code className="rounded bg-white px-1.5 py-0.5 text-[11px] font-semibold text-slate-700 ring-1 ring-slate-200">
                    {vaultHandle.name}
                  </code>
                </div>
                <div className="mt-0.5 flex flex-wrap items-center gap-x-3 text-[11px] text-slate-500">
                  <span
                    title={lastSyncAt ? formatDateTime(lastSyncAt) : '尚未同步'}
                  >
                    上次同步：
                    {lastSyncAt ? formatRelativeTime(lastSyncAt) : '尚未同步'}
                  </span>
                  <span>·</span>
                  <span>
                    待同步：
                    <strong
                      className={
                        pendingSyncCount > 0
                          ? 'text-amber-700'
                          : 'text-emerald-700'
                      }
                    >
                      {pendingSyncCount}
                    </strong>
                    {pendingSyncCount > 0 && (
                      <span className="ml-1 text-slate-400">
                        （暂存媒体 {stagedCount} / 待回写元数据 {metaDirtyCount}）
                      </span>
                    )}
                  </span>
                </div>
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void onFlushToVault()}
              disabled={isBusy}
              className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold shadow-2xs transition disabled:cursor-not-allowed disabled:opacity-60 ${
                pendingSyncCount > 0
                  ? 'bg-indigo-600 text-white hover:bg-indigo-700'
                  : 'border border-indigo-200 bg-indigo-50 text-indigo-700 hover:bg-indigo-100'
              }`}
            >
              {isFlushing ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <FolderSync className="h-3.5 w-3.5" />
              )}
              <span>
                {isFlushing
                  ? '同步中...'
                  : pendingSyncCount > 0
                    ? `同步到 CollectVault (${pendingSyncCount})`
                    : '同步到 CollectVault'}
              </span>
            </button>

            <button
              type="button"
              onClick={() => setConfirmModal('rebuild')}
              disabled={isBusy}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 transition hover:border-slate-300 hover:bg-slate-50 disabled:opacity-60"
            >
              {isRebuilding ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <DatabaseBackup className="h-3.5 w-3.5 text-slate-500" />
              )}
              <span>重建索引</span>
            </button>

            <button
              type="button"
              onClick={() => void onBindVault()}
              disabled={isBusy}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 transition hover:border-slate-300 hover:bg-slate-50 disabled:opacity-60"
            >
              <FolderOpen className="h-3.5 w-3.5 text-slate-500" />
              <span>切换目录</span>
            </button>

            <button
              type="button"
              onClick={() => setConfirmModal('clear_cache')}
              disabled={isBusy}
              title="仅清空浏览器 IndexedDB 缓存索引，不删除本地硬盘文件"
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-600 transition hover:border-rose-200 hover:bg-rose-50 hover:text-rose-700 disabled:opacity-60"
            >
              <Trash2 className="h-3.5 w-3.5" />
              <span>清空浏览器缓存索引</span>
            </button>
          </div>
        </div>
      )}

      {/* 绑定已有 Vault 且 IndexedDB 为空时的一键重建引导 */}
      {showRebuildSuggestion &&
        vaultHandle &&
        permissionState === 'granted' &&
        !isRebuilding && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-indigo-200 bg-indigo-50 px-4 py-2.5 text-xs text-indigo-900">
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
        <div className="rounded-xl border border-indigo-100 bg-indigo-50/50 px-4 py-2.5">
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
        <div className="rounded-xl border border-sky-100 bg-sky-50/70 px-4 py-2.5">
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
          className={`flex items-start justify-between gap-3 rounded-xl border px-4 py-2 text-xs ${
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
        <div className="flex items-center justify-between gap-3 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-2 text-xs text-emerald-900">
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
      {bannerError && (
        <div className="flex items-start justify-between gap-3 rounded-xl border border-rose-200 bg-rose-50 px-4 py-2 text-xs text-rose-800">
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-rose-600" />
            <span>{bannerError}</span>
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

      {/* 二次确认模态框：重建索引 / 清空浏览器缓存索引 */}
      {confirmModal !== null && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/45 p-4 backdrop-blur-[1px]"
          onClick={() => !isClearingCache && setConfirmModal(null)}
        >
          <div
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
                        条尚未同步到硬盘的暂存或修改内容，建议先点击「同步到 CollectVault」后再重建索引。
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
                      <code>tasks</code> 索引缓存（用于容灾恢复测试或故障排查），
                      并保留本地目录绑定。
                    </p>
                    <p className="mt-2 rounded-lg border border-emerald-200 bg-emerald-50 px-2.5 py-2 text-xs font-medium text-emerald-800">
                      安全承诺：绝不会删除您硬盘 CollectVault 目录中的任何视频、图片或元数据文件，随时可点击「重建索引」瞬间恢复全部数据。
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
                    <span>确认清空浏览器索引</span>
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
