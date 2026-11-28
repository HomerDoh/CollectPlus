import {
  ArrowDownWideNarrow,
  Check,
  CheckSquare,
  CloudOff,
  FileText,
  Film,
  FolderMinus,
  FolderPlus,
  HardDrive,
  Images,
  Inbox,
  LayoutGrid,
  List,
  RotateCcw,
  Search,
  Trash2,
  User,
  X,
} from 'lucide-react';
import { i18n } from '@/i18n/index.ts';
import type {
  CollectionItemRecord,
  LibrarySortOption,
  LibraryViewMode,
  TagMeta,
} from '@/types/schema.ts';
import {
  autoSyncExclusionMeta,
  formatBytes,
  formatDuration,
  formatRelativeTime,
  platformMeta,
  syncStatusMeta,
} from '../utils/format.ts';

export type SortOption = LibrarySortOption;
export type ViewMode = LibraryViewMode;

export interface ItemCardGridProps {
  items: readonly CollectionItemRecord[];
  tagsByName: ReadonlyMap<string, TagMeta>;
  searchQuery: string;
  sortBy: SortOption;
  viewMode: ViewMode;
  isTrashView: boolean;
  isExcludedView: boolean;
  currentFolderId: string | null;
  hasActiveFilters: boolean;
  contextTitle: string;
  selectionMode: boolean;
  selectedIds: ReadonlySet<string>;
  onSearchChange: (query: string) => void;
  onSortChange: (sort: SortOption) => void;
  onViewModeChange: (mode: ViewMode) => void;
  onResetFilters: () => void;
  onOpenItem: (item: CollectionItemRecord) => void;
  onToggleSelectionMode: () => void;
  onToggleSelectItem: (itemId: string, shiftKey: boolean) => void;
  onSelectAllVisible: () => void;
  onClearSelection: () => void;
  onOpenBatchFolderModal: () => void;
  onBatchRemoveFromCurrentFolder: () => Promise<void>;
  onRequestDeleteItems: (
    items: CollectionItemRecord[],
    mode: 'soft' | 'permanent',
  ) => void;
  onBatchRestoreItems: (items: CollectionItemRecord[]) => Promise<void>;
  onRestoreItem: (item: CollectionItemRecord) => Promise<void>;
  onAllowAutoSyncAgain: (items: CollectionItemRecord[]) => Promise<void>;
  onRemoteUncollectAndClear: (items: CollectionItemRecord[]) => Promise<void>;
  onCancelItemSync: (item: CollectionItemRecord) => Promise<void>;
}

function getMediaBadgeText(item: CollectionItemRecord): string {
  if (item.kind === 'video') {
    const videoAsset = item.assets.find((asset) => asset.kind === 'video');
    if (videoAsset?.durationSec !== undefined && videoAsset.durationSec > 0) {
      return formatDuration(videoAsset.durationSec);
    }
    return i18n.t('format.mediaKind.video');
  }
  if (item.kind === 'article') {
    return i18n.t('format.mediaKind.article');
  }

  const imageCount = item.assets.filter((asset) => asset.kind === 'image').length;
  if (imageCount > 0) {
    return i18n.t('format.imageCountBadge', { count: imageCount });
  }
  return item.kind === 'gallery'
    ? i18n.t('format.mediaKind.gallery')
    : i18n.t('format.mediaKind.image');
}

export function ItemCardGrid({
  items,
  tagsByName,
  searchQuery,
  sortBy,
  viewMode,
  isTrashView,
  isExcludedView,
  currentFolderId,
  hasActiveFilters,
  contextTitle,
  selectionMode,
  selectedIds,
  onSearchChange,
  onSortChange,
  onViewModeChange,
  onResetFilters,
  onOpenItem,
  onToggleSelectionMode,
  onToggleSelectItem,
  onSelectAllVisible,
  onClearSelection,
  onOpenBatchFolderModal,
  onBatchRemoveFromCurrentFolder,
  onRequestDeleteItems,
  onBatchRestoreItems,
  onRestoreItem,
  onAllowAutoSyncAgain,
  onRemoteUncollectAndClear,
  onCancelItemSync,
}: ItemCardGridProps) {
  const selectedVisibleItems = items.filter((item) => selectedIds.has(item.id));
  const selectedCount = selectedVisibleItems.length;
  const allVisibleSelected = items.length > 0 && selectedCount === items.length;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 顶部工具栏 */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--cp-border)] bg-[var(--cp-surface)] px-6 py-3">
        {/* 搜索输入框 */}
        <div className="relative min-w-[260px] flex-1 max-w-xl">
          <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-[var(--cp-text-muted)]" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder={i18n.t('grid.searchPlaceholder')}
            className="w-full rounded border border-[var(--cp-border)] bg-[var(--cp-input)] py-2 pr-24 pl-9 text-xs text-[var(--cp-text)] placeholder:text-[var(--cp-text-muted)] transition focus:border-[var(--cp-accent)] focus:bg-[var(--cp-surface)] focus:ring-2 focus:ring-[var(--cp-accent-soft)] focus:outline-none"
          />
          <div className="absolute top-1/2 right-2 flex -translate-y-1/2 items-center gap-1.5">
            {searchQuery.trim() && (
              <>
                <span className="rounded bg-[var(--cp-active)] px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-[var(--cp-text-active)]">
                  {i18n.t('grid.searchHits', { count: items.length })}
                </span>
                <button
                  type="button"
                  onClick={() => onSearchChange('')}
                  className="rounded p-1 text-[var(--cp-text-muted)] hover:bg-[var(--cp-muted)] hover:text-[var(--cp-text)]"
                  aria-label={i18n.t('grid.clearSearchAria')}
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </>
            )}
          </div>
        </div>

        {/* 右侧上下文统计 + 批量选择 + 排序 + 视图切换 */}
        <div className="flex items-center gap-2.5">
          <span className="hidden text-xs text-[var(--cp-text-muted)] xl:inline">
            {contextTitle} ·{' '}
            <strong className="font-semibold tabular-nums text-[var(--cp-text)]">
              {items.length}
            </strong>{' '}
            {i18n.t('grid.contextSummarySuffix')}
          </span>

          {/* 批量选择切换按钮 */}
          {items.length > 0 && (
            <button
              type="button"
              onClick={onToggleSelectionMode}
              data-testid="toggle-selection-mode"
              className={`inline-flex items-center gap-1.5 rounded border px-2.5 py-1.5 text-xs font-medium transition ${
                selectionMode
                  ? 'border-[var(--cp-accent)] bg-[var(--cp-active)] text-[var(--cp-text-active)] font-semibold'
                  : 'border-[var(--cp-border)] bg-[var(--cp-surface)] text-[var(--cp-text-secondary)] hover:border-[var(--cp-border-strong)] hover:text-[var(--cp-text)]'
              }`}
            >
              <CheckSquare className="h-3.5 w-3.5" />
              <span>
                {selectionMode
                  ? i18n.t('grid.exitSelectionMode')
                  : i18n.t('grid.enterSelectionMode')}
              </span>
            </button>
          )}

          {/* 排序选择器 */}
          <label className="relative inline-flex items-center">
            <ArrowDownWideNarrow className="pointer-events-none absolute left-2.5 h-3.5 w-3.5 text-[var(--cp-text-muted)]" />
            <select
              value={sortBy}
              onChange={(e) => onSortChange(e.target.value as SortOption)}
              aria-label={i18n.t('grid.sortAria')}
              className="rounded border border-[var(--cp-border)] bg-[var(--cp-surface)] py-1.5 pr-7 pl-8 text-xs font-medium text-[var(--cp-text-secondary)] transition hover:border-[var(--cp-border-strong)] focus:border-[var(--cp-accent)] focus:outline-none"
            >
              <option value="collectedAt">{i18n.t('grid.sortCollectedAt')}</option>
              <option value="publishedAt">{i18n.t('grid.sortPublishedAt')}</option>
              <option value="totalSizeBytes">{i18n.t('grid.sortTotalSizeBytes')}</option>
            </select>
          </label>

          {/* 视图切换 */}
          <div className="inline-flex rounded border border-[var(--cp-border)] bg-[var(--cp-muted)] p-0.5">
            <button
              type="button"
              onClick={() => onViewModeChange('grid')}
              title={i18n.t('grid.gridViewTitle')}
              className={`inline-flex items-center justify-center rounded p-1.5 transition ${
                viewMode === 'grid'
                  ? 'bg-[var(--cp-surface)] text-[var(--cp-accent)]'
                  : 'text-[var(--cp-text-muted)] hover:text-[var(--cp-text)]'
              }`}
            >
              <LayoutGrid className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => onViewModeChange('list')}
              title={i18n.t('grid.listViewTitle')}
              className={`inline-flex items-center justify-center rounded p-1.5 transition ${
                viewMode === 'list'
                  ? 'bg-[var(--cp-surface)] text-[var(--cp-accent)]'
                  : 'text-[var(--cp-text-muted)] hover:text-[var(--cp-text)]'
              }`}
            >
              <List className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </div>

      {/* 批量操作吸顶工具条 */}
      {selectionMode && (
        <div
          data-testid="batch-action-bar"
          className="flex flex-wrap items-center justify-between gap-2.5 border-b border-[var(--cp-border-strong)] bg-[var(--cp-active)] px-6 py-2.5 text-xs"
        >
          <div className="flex items-center gap-3">
            <label className="inline-flex cursor-pointer items-center gap-2 font-medium text-[var(--cp-text-active)]">
              <input
                type="checkbox"
                checked={allVisibleSelected}
                onChange={() =>
                  allVisibleSelected ? onClearSelection() : onSelectAllVisible()
                }
                data-testid="batch-select-all"
                className="h-4 w-4 rounded border-[var(--cp-border-strong)] accent-[var(--cp-accent)]"
              />
              <span>
                {allVisibleSelected
                  ? i18n.t('grid.unselectAll')
                  : i18n.t('grid.selectAllVisible')}
              </span>
            </label>
            <span className="text-[var(--cp-text-active)] tabular-nums">
              {i18n.t('grid.selectedPrefix')}{' '}
              <strong data-testid="batch-selected-count" className="font-bold">
                {selectedCount}
              </strong>{' '}
              {i18n.t('grid.selectedSuffix', { total: items.length })}
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {isExcludedView ? (
              <>
                <button
                  type="button"
                  disabled={selectedCount === 0}
                  onClick={() => void onAllowAutoSyncAgain(selectedVisibleItems)}
                  data-testid="batch-allow-sync-btn"
                  className="inline-flex items-center gap-1.5 rounded bg-[var(--cp-accent)] px-3 py-1.5 text-xs font-semibold text-[var(--cp-on-accent)] transition hover:bg-[var(--cp-accent-hover)] disabled:cursor-not-allowed disabled:opacity-45"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  <span>{i18n.t('grid.allowAutoSyncAgain')}</span>
                </button>
                <button
                  type="button"
                  disabled={selectedCount === 0}
                  onClick={() =>
                    void onRemoteUncollectAndClear(selectedVisibleItems)
                  }
                  data-testid="batch-remote-uncollect-clear-btn"
                  className="inline-flex items-center gap-1.5 rounded bg-rose-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-rose-700 disabled:cursor-not-allowed disabled:opacity-45"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  <span>{i18n.t('grid.remoteUncollectAndClear')}</span>
                </button>
              </>
            ) : isTrashView ? (
              <>
                <button
                  type="button"
                  disabled={selectedCount === 0}
                  onClick={() => void onBatchRestoreItems(selectedVisibleItems)}
                  data-testid="batch-restore-btn"
                  className="inline-flex items-center gap-1.5 rounded bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-45"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  <span>{i18n.t('grid.batchRestore')}</span>
                </button>
                <button
                  type="button"
                  disabled={selectedCount === 0}
                  onClick={() =>
                    onRequestDeleteItems(selectedVisibleItems, 'permanent')
                  }
                  data-testid="batch-permanent-delete-btn"
                  className="inline-flex items-center gap-1.5 rounded bg-rose-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-rose-700 disabled:cursor-not-allowed disabled:opacity-45"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  <span>{i18n.t('grid.permanentDelete')}</span>
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  disabled={selectedCount === 0}
                  onClick={onOpenBatchFolderModal}
                  data-testid="batch-add-folder-btn"
                  className="inline-flex items-center gap-1.5 rounded bg-[var(--cp-accent)] px-3 py-1.5 text-xs font-semibold text-[var(--cp-on-accent)] transition hover:bg-[var(--cp-accent-hover)] disabled:cursor-not-allowed disabled:opacity-45"
                >
                  <FolderPlus className="h-3.5 w-3.5" />
                  <span>{i18n.t('grid.addToFolders')}</span>
                </button>
                {currentFolderId !== null && (
                  <button
                    type="button"
                    disabled={selectedCount === 0}
                    onClick={() => void onBatchRemoveFromCurrentFolder()}
                    data-testid="batch-remove-folder-btn"
                    className="inline-flex items-center gap-1.5 rounded border border-[var(--cp-border-strong)] bg-[var(--cp-surface)] px-3 py-1.5 text-xs font-medium text-[var(--cp-text-active)] transition hover:bg-[var(--cp-muted)] disabled:cursor-not-allowed disabled:opacity-45"
                  >
                    <FolderMinus className="h-3.5 w-3.5" />
                    <span>{i18n.t('grid.removeFromCurrentFolder')}</span>
                  </button>
                )}
                <button
                  type="button"
                  disabled={selectedCount === 0}
                  onClick={() =>
                    onRequestDeleteItems(selectedVisibleItems, 'soft')
                  }
                  data-testid="batch-delete-btn"
                  className="inline-flex items-center gap-1.5 rounded bg-rose-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-rose-700 disabled:cursor-not-allowed disabled:opacity-45"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  <span>{i18n.t('common.delete')}</span>
                </button>
              </>
            )}

            <button
              type="button"
              onClick={onToggleSelectionMode}
              className="rounded border border-[var(--cp-border)] bg-[var(--cp-surface)] px-2.5 py-1.5 text-xs font-medium text-[var(--cp-text-secondary)] transition hover:border-[var(--cp-border-strong)] hover:text-[var(--cp-text)]"
            >
              {i18n.t('common.done')}
            </button>
          </div>
        </div>
      )}

      {/* 内容展示区 */}
      <div className="flex-1 overflow-y-auto px-6 py-5">
        {items.length === 0 ? (
          <div className="mx-auto mt-12 flex max-w-md flex-col items-center justify-center rounded-md border border-dashed border-[var(--cp-border-strong)] bg-[var(--cp-surface)] px-8 py-12 text-center">
            <span className="inline-flex h-12 w-12 items-center justify-center rounded-md bg-[var(--cp-muted)] text-[var(--cp-text-muted)]">
              {isTrashView ? (
                <Trash2 className="h-6 w-6" />
              ) : isExcludedView ? (
                <CloudOff className="h-6 w-6" />
              ) : (
                <Inbox className="h-6 w-6" />
              )}
            </span>
            <h3 className="mt-4 text-sm font-semibold text-[var(--cp-text)]">
              {hasActiveFilters
                ? i18n.t('grid.emptyFilteredTitle')
                : isTrashView
                  ? i18n.t('grid.emptyTrashTitle')
                  : isExcludedView
                    ? i18n.t('grid.emptyExcludedTitle')
                    : i18n.t('grid.emptyAllTitle')}
            </h3>
            <p className="mt-1.5 text-xs leading-relaxed text-[var(--cp-text-muted)]">
              {hasActiveFilters
                ? i18n.t('grid.emptyFilteredDesc')
                : isTrashView
                  ? i18n.t('grid.emptyTrashDesc')
                  : isExcludedView
                    ? i18n.t('grid.emptyExcludedDesc')
                    : i18n.t('grid.emptyAllDesc')}
            </p>
            {hasActiveFilters && (
              <button
                type="button"
                onClick={onResetFilters}
                className="mt-4 inline-flex items-center gap-1.5 rounded bg-[var(--cp-accent)] px-3.5 py-2 text-xs font-semibold text-[var(--cp-on-accent)] transition hover:bg-[var(--cp-accent-hover)]"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                <span>{i18n.t('grid.resetFiltersBtn')}</span>
              </button>
            )}
          </div>
        ) : viewMode === 'grid' ? (
          <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
            {items.map((item) => {
              const platformInfo = platformMeta(
                item.platform,
                item.platformExtra,
              );
              const exclusion = item.autoSyncExclusion ?? null;
              const statusBadge = exclusion
                ? autoSyncExclusionMeta(exclusion.reason)
                : syncStatusMeta(item.syncStatus);
              const mediaBadge = getMediaBadgeText(item);
              const visibleTags = item.tags.slice(0, 3);
              const extraTagCount = item.tags.length - visibleTags.length;
              const isSelected = selectedIds.has(item.id);

              return (
                <article
                  key={item.id}
                  onClick={(e) => {
                    if (selectionMode) {
                      onToggleSelectItem(item.id, e.shiftKey);
                    } else {
                      onOpenItem(item);
                    }
                  }}
                  className={`group relative flex cursor-pointer flex-col overflow-hidden rounded border bg-[var(--cp-surface)] transition duration-150 ${
                    isSelected
                      ? 'border-[var(--cp-accent)] ring-1 ring-[var(--cp-accent)]'
                      : 'border-[var(--cp-border)] hover:border-[var(--cp-accent)]'
                  }`}
                >
                  {/* 封面预览区 */}
                  <div className="relative aspect-16/10 w-full overflow-hidden bg-[var(--cp-muted)]">
                    {item.thumbnailDataUrl ? (
                      <img
                        src={item.thumbnailDataUrl}
                        alt={item.title}
                        loading="lazy"
                        className="h-full w-full object-cover transition duration-300 group-hover:scale-[1.03]"
                      />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center bg-[var(--cp-muted)] text-[var(--cp-text-muted)]">
                        {exclusion ? (
                          <CloudOff className="h-10 w-10" />
                        ) : item.kind === 'video' ? (
                          <Film className="h-10 w-10" />
                        ) : item.kind === 'article' ? (
                          <FileText className="h-10 w-10" />
                        ) : (
                          <Images className="h-10 w-10" />
                        )}
                      </div>
                    )}

                    {/* 左上角：批量选择复选框 + 平台徽标（并排不重叠） */}
                    <div className="absolute top-2 left-2 z-10 flex items-center gap-1.5">
                      <button
                        type="button"
                        role="checkbox"
                        aria-checked={isSelected}
                        aria-label={i18n.t('grid.selectItemAria', {
                          title: item.title,
                        })}
                        data-testid="item-select-checkbox"
                        onClick={(e) => {
                          e.stopPropagation();
                          onToggleSelectItem(item.id, e.shiftKey);
                        }}
                        className={`h-5 w-5 items-center justify-center rounded border transition ${
                          selectionMode || isSelected
                            ? 'inline-flex'
                            : 'hidden group-hover:inline-flex'
                        } ${
                          isSelected
                            ? 'border-[var(--cp-accent)] bg-[var(--cp-accent)] text-[var(--cp-on-accent)]'
                            : 'border-white/90 bg-slate-900/60 text-transparent hover:border-teal-300 hover:bg-slate-900/80'
                        }`}
                      >
                        <Check className="h-3.5 w-3.5 stroke-[3]" />
                      </button>
                      <span
                        className={`rounded px-2 py-0.5 text-[10px] font-semibold ${platformInfo.badgeClass}`}
                      >
                        {platformInfo.label}
                      </span>
                    </div>

                    {/* 右上角状态 / 不自动同步原因角标 */}
                    <span
                      title={statusBadge.label}
                      className={`absolute top-2 right-2 inline-flex items-center gap-1 rounded px-2 py-0.5 text-[10px] font-medium ${statusBadge.badgeClass}`}
                    >
                      <span
                        className={`h-1.5 w-1.5 rounded-full ${statusBadge.dotClass}`}
                      />
                      <span>{statusBadge.shortLabel}</span>
                    </span>

                    {/* 左下角媒体时长 / 图集数 / 文章 */}
                    <span className="absolute bottom-2 left-2 inline-flex items-center gap-1 rounded bg-slate-950/80 px-2 py-0.5 text-[11px] font-medium tabular-nums text-white">
                      {item.kind === 'video' ? (
                        <Film className="h-3 w-3" />
                      ) : item.kind === 'article' ? (
                        <FileText className="h-3 w-3" />
                      ) : (
                        <Images className="h-3 w-3" />
                      )}
                      <span>{mediaBadge}</span>
                    </span>

                    {/* 悬浮快捷动作（批量选择模式下隐藏避免误触） */}
                    {!selectionMode && (
                      <div className="absolute right-2 bottom-2 flex items-center gap-1.5 opacity-0 transition group-hover:opacity-100">
                        {isExcludedView ? (
                          <>
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                void onAllowAutoSyncAgain([item]);
                              }}
                              title={i18n.t('grid.allowAutoSyncAgain')}
                              className="inline-flex items-center gap-1 rounded bg-[var(--cp-accent)] px-2 py-1 text-[11px] font-semibold text-[var(--cp-on-accent)] transition hover:bg-[var(--cp-accent-hover)]"
                            >
                              <RotateCcw className="h-3 w-3" />
                              <span>{i18n.t('grid.allowSyncShort')}</span>
                            </button>
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                void onRemoteUncollectAndClear([item]);
                              }}
                              title={i18n.t('grid.remoteUncollectAndClear')}
                              aria-label={i18n.t('grid.remoteUncollectAndClear')}
                              className="inline-flex h-7 w-7 items-center justify-center rounded bg-slate-900/80 text-white transition hover:bg-rose-600"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </>
                        ) : isTrashView ? (
                          <>
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                void onRestoreItem(item);
                              }}
                              title={i18n.t('grid.restoreFromTrashTitle')}
                              className="inline-flex items-center gap-1 rounded bg-emerald-600 px-2.5 py-1 text-[11px] font-semibold text-white transition hover:bg-emerald-700"
                            >
                              <RotateCcw className="h-3 w-3" />
                              <span>{i18n.t('grid.restoreShort')}</span>
                            </button>
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                onRequestDeleteItems([item], 'permanent');
                              }}
                              title={i18n.t('grid.permanentDelete')}
                              aria-label={i18n.t('grid.permanentDelete')}
                              className="inline-flex h-7 w-7 items-center justify-center rounded bg-slate-900/80 text-white transition hover:bg-rose-600"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </>
                        ) : (
                          <>
                            {item.syncStatus === 'pending_download' && (
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  void onCancelItemSync(item);
                                }}
                                title={i18n.t('grid.cancelItemSyncTitle')}
                                className="inline-flex items-center gap-1 rounded bg-amber-600 px-2 py-1 text-[11px] font-semibold text-white transition hover:bg-amber-700"
                              >
                                <CloudOff className="h-3 w-3" />
                                <span>{i18n.t('grid.cancelItemSyncShort')}</span>
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                onRequestDeleteItems([item], 'soft');
                              }}
                              title={i18n.t('grid.moveToTrash')}
                              aria-label={i18n.t('grid.moveToTrash')}
                              className="inline-flex h-7 w-7 items-center justify-center rounded bg-slate-900/80 text-white transition hover:bg-rose-600"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </>
                        )}
                      </div>
                    )}
                  </div>

                  {/* 信息内容区 */}
                  <div className="flex flex-1 flex-col justify-between gap-2.5 p-3">
                    <div>
                      <h3 className="line-clamp-2 text-[13px] font-semibold leading-snug text-[var(--cp-text)] group-hover:text-[var(--cp-text-active)]">
                        {item.title}
                      </h3>
                      <p className="mt-1 flex items-center gap-1 truncate text-xs text-[var(--cp-text-muted)]">
                        <User className="h-3 w-3 shrink-0 text-[var(--cp-text-muted)]" />
                        <span className="truncate">{item.author.name}</span>
                      </p>
                      {exclusion && (
                        <div
                          data-testid="item-exclusion-reason"
                          className="mt-2 rounded border border-amber-200 bg-amber-50 px-2 py-1.5 text-[11px] leading-snug text-amber-900 dark:border-amber-900/80 dark:bg-amber-950/60 dark:text-amber-200"
                        >
                          <p className="font-medium">{statusBadge.label}</p>
                          {exclusion.detail && (
                            <p className="mt-0.5 line-clamp-2 text-[10px] opacity-90">
                              {exclusion.detail}
                            </p>
                          )}
                        </div>
                      )}
                    </div>

                    {/* 标签 pills */}
                    {visibleTags.length > 0 && (
                      <div className="flex flex-wrap gap-1">
                        {visibleTags.map((tagName) => {
                          const tagColor =
                            tagsByName.get(tagName)?.color ?? '#0d9488';
                          return (
                            <span
                              key={tagName}
                              className="inline-flex max-w-[110px] items-center gap-1 rounded bg-[var(--cp-muted)] px-2 py-0.5 text-[10px] font-medium text-[var(--cp-text-secondary)]"
                            >
                              <span
                                className="h-1.5 w-1.5 shrink-0 rounded-full"
                                style={{ backgroundColor: tagColor }}
                              />
                              <span className="truncate">{tagName}</span>
                            </span>
                          );
                        })}
                        {extraTagCount > 0 && (
                          <span className="rounded bg-[var(--cp-muted)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--cp-text-muted)]">
                            +{extraTagCount}
                          </span>
                        )}
                      </div>
                    )}

                    {/* 底部体积与时间 */}
                    <div className="flex items-center justify-between border-t border-[var(--cp-divider)] pt-2 text-[11px] text-[var(--cp-text-muted)]">
                      {exclusion ? (
                        <>
                          <span className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-300">
                            <CloudOff className="h-3 w-3" />
                            <span>{i18n.t('grid.metadataOnly')}</span>
                          </span>
                          <span>{formatRelativeTime(exclusion.excludedAt)}</span>
                        </>
                      ) : (
                        <>
                          <span className="inline-flex items-center gap-1 tabular-nums">
                            <HardDrive className="h-3 w-3" />
                            <span>{formatBytes(item.totalSizeBytes)}</span>
                          </span>
                          <span>{formatRelativeTime(item.collectedAt)}</span>
                        </>
                      )}
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        ) : (
          /* 紧凑列表视图 */
          <div className="flex flex-col gap-2">
            {items.map((item) => {
              const platformInfo = platformMeta(
                item.platform,
                item.platformExtra,
              );
              const exclusion = item.autoSyncExclusion ?? null;
              const statusBadge = exclusion
                ? autoSyncExclusionMeta(exclusion.reason)
                : syncStatusMeta(item.syncStatus);
              const mediaBadge = getMediaBadgeText(item);
              const isSelected = selectedIds.has(item.id);

              return (
                <article
                  key={item.id}
                  onClick={(e) => {
                    if (selectionMode) {
                      onToggleSelectItem(item.id, e.shiftKey);
                    } else {
                      onOpenItem(item);
                    }
                  }}
                  className={`group flex cursor-pointer items-center gap-3.5 rounded border bg-[var(--cp-surface)] p-2.5 transition ${
                    isSelected
                      ? 'border-[var(--cp-accent)] bg-[var(--cp-active)] ring-1 ring-[var(--cp-accent)]'
                      : 'border-[var(--cp-border)] hover:border-[var(--cp-accent)]'
                  }`}
                >
                  {/* 左侧复选框 */}
                  <button
                    type="button"
                    role="checkbox"
                    aria-checked={isSelected}
                    aria-label={i18n.t('grid.selectItemAria', {
                      title: item.title,
                    })}
                    data-testid="item-select-checkbox"
                    onClick={(e) => {
                      e.stopPropagation();
                      onToggleSelectItem(item.id, e.shiftKey);
                    }}
                    className={`h-5 w-5 shrink-0 items-center justify-center rounded border transition ${
                      selectionMode || isSelected
                        ? 'inline-flex'
                        : 'hidden group-hover:inline-flex'
                    } ${
                      isSelected
                        ? 'border-[var(--cp-accent)] bg-[var(--cp-accent)] text-[var(--cp-on-accent)]'
                        : 'border-[var(--cp-border-strong)] bg-[var(--cp-surface)] text-transparent hover:border-[var(--cp-accent)]'
                    }`}
                  >
                    <Check className="h-3.5 w-3.5 stroke-[3]" />
                  </button>

                  {/* 缩略图 */}
                  <div className="relative h-16 w-28 shrink-0 overflow-hidden rounded bg-[var(--cp-muted)]">
                    {item.thumbnailDataUrl ? (
                      <img
                        src={item.thumbnailDataUrl}
                        alt={item.title}
                        loading="lazy"
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center text-[var(--cp-text-muted)]">
                        {exclusion ? (
                          <CloudOff className="h-5 w-5" />
                        ) : item.kind === 'video' ? (
                          <Film className="h-5 w-5" />
                        ) : item.kind === 'article' ? (
                          <FileText className="h-5 w-5" />
                        ) : (
                          <Images className="h-5 w-5" />
                        )}
                      </div>
                    )}
                    <span className="absolute right-1 bottom-1 rounded bg-slate-950/80 px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-white">
                      {mediaBadge}
                    </span>
                  </div>

                  {/* 主信息 */}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span
                        className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold ${platformInfo.badgeClass}`}
                      >
                        {platformInfo.label}
                      </span>
                      <h3 className="truncate text-sm font-semibold text-[var(--cp-text)] group-hover:text-[var(--cp-text-active)]">
                        {item.title}
                      </h3>
                    </div>

                    <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[var(--cp-text-muted)]">
                      <span className="inline-flex items-center gap-1">
                        <User className="h-3 w-3" />
                        <span>{item.author.name}</span>
                      </span>
                      {exclusion ? (
                        <>
                          <span className="font-medium text-amber-800 dark:text-amber-300">
                            {statusBadge.label}
                          </span>
                          {exclusion.detail && (
                            <span className="truncate text-[11px] text-amber-700 dark:text-amber-400">
                              {exclusion.detail}
                            </span>
                          )}
                          <span>{formatRelativeTime(exclusion.excludedAt)}</span>
                        </>
                      ) : (
                        <>
                          <span className="tabular-nums">
                            {formatBytes(item.totalSizeBytes)}
                          </span>
                          <span>{formatRelativeTime(item.collectedAt)}</span>
                        </>
                      )}
                      {item.tags.slice(0, 4).map((tagName) => {
                        const tagColor =
                          tagsByName.get(tagName)?.color ?? '#0d9488';
                        return (
                          <span
                            key={tagName}
                            className="inline-flex items-center gap-1 rounded bg-[var(--cp-muted)] px-2 py-0.5 text-[10px] font-medium text-[var(--cp-text-secondary)]"
                          >
                            <span
                              className="h-1.5 w-1.5 rounded-full"
                              style={{ backgroundColor: tagColor }}
                            />
                            <span>{tagName}</span>
                          </span>
                        );
                      })}
                    </div>
                  </div>

                  {/* 右侧状态与悬浮操作 */}
                  <div className="flex shrink-0 items-center gap-2">
                    <span
                      title={statusBadge.label}
                      className={`inline-flex items-center gap-1 rounded px-2.5 py-0.5 text-[11px] font-medium ${statusBadge.badgeClass}`}
                    >
                      <span
                        className={`h-1.5 w-1.5 rounded-full ${statusBadge.dotClass}`}
                      />
                      <span>{statusBadge.shortLabel}</span>
                    </span>

                    {!selectionMode &&
                      (isExcludedView ? (
                        <>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              void onAllowAutoSyncAgain([item]);
                            }}
                            title={i18n.t('grid.allowAutoSyncAgain')}
                            className="inline-flex items-center gap-1 rounded border border-[var(--cp-border-strong)] bg-[var(--cp-active)] px-2.5 py-1.5 text-xs font-medium text-[var(--cp-text-active)] transition hover:border-[var(--cp-accent)]"
                          >
                            <RotateCcw className="h-3.5 w-3.5" />
                            <span>{i18n.t('grid.allowSyncShort')}</span>
                          </button>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              void onRemoteUncollectAndClear([item]);
                            }}
                            title={i18n.t('grid.remoteUncollectAndClear')}
                            aria-label={i18n.t('grid.remoteUncollectAndClear')}
                            className="rounded p-1.5 text-[var(--cp-text-muted)] transition hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-950/60 dark:hover:text-rose-400"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </>
                      ) : isTrashView ? (
                        <>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              void onRestoreItem(item);
                            }}
                            title={i18n.t('grid.restoreFromTrashTitle')}
                            className="inline-flex items-center gap-1 rounded border border-emerald-200 bg-emerald-50 px-2.5 py-1.5 text-xs font-medium text-emerald-700 transition hover:bg-emerald-100 dark:border-emerald-900 dark:bg-emerald-950/70 dark:text-emerald-300"
                          >
                            <RotateCcw className="h-3.5 w-3.5" />
                            <span>{i18n.t('grid.restoreShort')}</span>
                          </button>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              onRequestDeleteItems([item], 'permanent');
                            }}
                            title={i18n.t('grid.permanentDelete')}
                            aria-label={i18n.t('grid.permanentDelete')}
                            className="rounded p-1.5 text-[var(--cp-text-muted)] transition hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-950/60 dark:hover:text-rose-400"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </>
                      ) : (
                        <>
                          {item.syncStatus === 'pending_download' && (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                void onCancelItemSync(item);
                              }}
                              title={i18n.t('grid.cancelItemSyncTitle')}
                              className="inline-flex items-center gap-1 rounded border border-amber-200 bg-amber-50 px-2 py-1 text-xs font-medium text-amber-800 transition hover:bg-amber-100 dark:border-amber-900 dark:bg-amber-950/70 dark:text-amber-300"
                            >
                              <CloudOff className="h-3.5 w-3.5" />
                              <span>{i18n.t('grid.cancelItemSyncShort')}</span>
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              onRequestDeleteItems([item], 'soft');
                            }}
                            title={i18n.t('grid.moveToTrash')}
                            aria-label={i18n.t('grid.moveToTrash')}
                            className="rounded p-1.5 text-[var(--cp-text-muted)] opacity-0 transition hover:bg-rose-50 hover:text-rose-600 group-hover:opacity-100 dark:hover:bg-rose-950/60 dark:hover:text-rose-400"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </>
                      ))}
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
