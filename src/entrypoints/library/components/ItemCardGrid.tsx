import {
  ArrowDownWideNarrow,
  FileText,
  Film,
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
import type {
  CollectionItemRecord,
  LibrarySortOption,
  LibraryViewMode,
  TagMeta,
} from '@/types/schema.ts';
import {
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
  hasActiveFilters: boolean;
  contextTitle: string;
  onSearchChange: (query: string) => void;
  onSortChange: (sort: SortOption) => void;
  onViewModeChange: (mode: ViewMode) => void;
  onResetFilters: () => void;
  onOpenItem: (item: CollectionItemRecord) => void;
  onSoftDeleteItem: (item: CollectionItemRecord) => Promise<void>;
  onRestoreItem: (item: CollectionItemRecord) => Promise<void>;
}

function getMediaBadgeText(item: CollectionItemRecord): string {
  if (item.kind === 'video') {
    const videoAsset = item.assets.find((asset) => asset.kind === 'video');
    if (videoAsset?.durationSec !== undefined && videoAsset.durationSec > 0) {
      return formatDuration(videoAsset.durationSec);
    }
    return '视频';
  }
  if (item.kind === 'article') {
    return '文章';
  }

  const imageCount = item.assets.filter((asset) => asset.kind === 'image').length;
  if (imageCount > 0) {
    return `${imageCount} 图`;
  }
  return item.kind === 'gallery' ? '图集' : '图片';
}

export function ItemCardGrid({
  items,
  tagsByName,
  searchQuery,
  sortBy,
  viewMode,
  isTrashView,
  hasActiveFilters,
  contextTitle,
  onSearchChange,
  onSortChange,
  onViewModeChange,
  onResetFilters,
  onOpenItem,
  onSoftDeleteItem,
  onRestoreItem,
}: ItemCardGridProps) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 顶部工具栏 */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-white/80 px-6 py-3 backdrop-blur-xs">
        {/* 搜索输入框 */}
        <div className="relative min-w-[260px] flex-1 max-w-xl">
          <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="全文检索标题、正文、作者、标签、备注..."
            className="w-full rounded-xl border border-slate-200 bg-slate-50 py-2 pr-24 pl-9 text-xs text-slate-900 placeholder:text-slate-400 transition focus:border-indigo-400 focus:bg-white focus:ring-2 focus:ring-indigo-100 focus:outline-none"
          />
          <div className="absolute top-1/2 right-2 flex -translate-y-1/2 items-center gap-1.5">
            {searchQuery.trim() && (
              <>
                <span className="rounded-md bg-indigo-50 px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-indigo-700">
                  {items.length} 命中
                </span>
                <button
                  type="button"
                  onClick={() => onSearchChange('')}
                  className="rounded-md p-1 text-slate-400 hover:bg-slate-200/70 hover:text-slate-700"
                  aria-label="清除搜索"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </>
            )}
          </div>
        </div>

        {/* 右侧上下文统计 + 排序 + 视图切换 */}
        <div className="flex items-center gap-2.5">
          <span className="hidden text-xs text-slate-500 xl:inline">
            {contextTitle} ·{' '}
            <strong className="font-semibold tabular-nums text-slate-700">
              {items.length}
            </strong>{' '}
            条
          </span>

          {/* 排序选择器 */}
          <label className="relative inline-flex items-center">
            <ArrowDownWideNarrow className="pointer-events-none absolute left-2.5 h-3.5 w-3.5 text-slate-400" />
            <select
              value={sortBy}
              onChange={(e) => onSortChange(e.target.value as SortOption)}
              aria-label="排序方式"
              className="rounded-lg border border-slate-200 bg-white py-1.5 pr-7 pl-8 text-xs font-medium text-slate-700 transition hover:border-slate-300 focus:border-indigo-400 focus:outline-none"
            >
              <option value="collectedAt">最近收藏</option>
              <option value="publishedAt">原发布时间</option>
              <option value="totalSizeBytes">文件体积</option>
            </select>
          </label>

          {/* 视图切换 */}
          <div className="inline-flex rounded-lg border border-slate-200 bg-slate-100 p-0.5">
            <button
              type="button"
              onClick={() => onViewModeChange('grid')}
              title="卡片网格视图"
              className={`inline-flex items-center justify-center rounded-md p-1.5 transition ${
                viewMode === 'grid'
                  ? 'bg-white text-indigo-600 shadow-2xs'
                  : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              <LayoutGrid className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => onViewModeChange('list')}
              title="紧凑列表视图"
              className={`inline-flex items-center justify-center rounded-md p-1.5 transition ${
                viewMode === 'list'
                  ? 'bg-white text-indigo-600 shadow-2xs'
                  : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              <List className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </div>

      {/* 内容展示区 */}
      <div className="flex-1 overflow-y-auto px-6 py-5">
        {items.length === 0 ? (
          <div className="mx-auto mt-12 flex max-w-md flex-col items-center justify-center rounded-2xl border border-dashed border-slate-200 bg-white px-8 py-12 text-center">
            <span className="inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-slate-100 text-slate-400">
              {isTrashView ? (
                <Trash2 className="h-6 w-6" />
              ) : (
                <Inbox className="h-6 w-6" />
              )}
            </span>
            <h3 className="mt-4 text-sm font-semibold text-slate-900">
              {hasActiveFilters
                ? '没有符合当前筛选条件的收藏条目'
                : isTrashView
                  ? '回收站为空'
                  : '还没有收藏任何作品'}
            </h3>
            <p className="mt-1.5 text-xs leading-relaxed text-slate-500">
              {hasActiveFilters
                ? '尝试更换检索关键词，或清除文件夹、媒体类型与来源平台筛选条件。'
                : isTrashView
                  ? '移入回收站的条目会暂时保存在这里，随时可以一键恢复。'
                  : '打开抖音网页版并点击收藏按钮或按下 Alt+S，作品将自动静默下载并归档到本地。'}
            </p>
            {hasActiveFilters && (
              <button
                type="button"
                onClick={onResetFilters}
                className="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3.5 py-2 text-xs font-semibold text-white shadow-xs transition hover:bg-indigo-700"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                <span>一键重置筛选</span>
              </button>
            )}
          </div>
        ) : viewMode === 'grid' ? (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
            {items.map((item) => {
              const platformInfo = platformMeta(item.platform);
              const syncInfo = syncStatusMeta(item.syncStatus);
              const mediaBadge = getMediaBadgeText(item);
              const visibleTags = item.tags.slice(0, 3);
              const extraTagCount = item.tags.length - visibleTags.length;

              return (
                <article
                  key={item.id}
                  onClick={() => onOpenItem(item)}
                  className="group relative flex cursor-pointer flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xs transition duration-200 hover:-translate-y-0.5 hover:border-indigo-300 hover:shadow-md"
                >
                  {/* 封面预览区 */}
                  <div className="relative aspect-16/10 w-full overflow-hidden bg-slate-100">
                    {item.thumbnailDataUrl ? (
                      <img
                        src={item.thumbnailDataUrl}
                        alt={item.title}
                        loading="lazy"
                        className="h-full w-full object-cover transition duration-300 group-hover:scale-105"
                      />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-slate-100 to-slate-200/70 text-slate-300">
                        {item.kind === 'video' ? (
                          <Film className="h-10 w-10" />
                        ) : item.kind === 'article' ? (
                          <FileText className="h-10 w-10" />
                        ) : (
                          <Images className="h-10 w-10" />
                        )}
                      </div>
                    )}

                    {/* 左上角平台徽标 */}
                    <span
                      className={`absolute top-2.5 left-2.5 rounded-md px-2 py-0.5 text-[10px] font-semibold ${platformInfo.badgeClass}`}
                    >
                      {platformInfo.label}
                    </span>

                    {/* 右上角同步状态角标 */}
                    <span
                      title={syncInfo.label}
                      className={`absolute top-2.5 right-2.5 inline-flex items-center gap-1 rounded-full bg-white/95 px-2 py-0.5 text-[10px] font-medium shadow-xs backdrop-blur-xs ${syncInfo.badgeClass}`}
                    >
                      <span
                        className={`h-1.5 w-1.5 rounded-full ${syncInfo.dotClass}`}
                      />
                      <span>{syncInfo.shortLabel}</span>
                    </span>

                    {/* 左下角媒体时长 / 图集数 / 文章 */}
                    <span className="absolute bottom-2.5 left-2.5 inline-flex items-center gap-1 rounded-md bg-slate-950/75 px-2 py-0.5 text-[11px] font-medium tabular-nums text-white backdrop-blur-xs">
                      {item.kind === 'video' ? (
                        <Film className="h-3 w-3" />
                      ) : item.kind === 'article' ? (
                        <FileText className="h-3 w-3" />
                      ) : (
                        <Images className="h-3 w-3" />
                      )}
                      <span>{mediaBadge}</span>
                    </span>

                    {/* 悬浮快捷动作（移入回收站 / 恢复） */}
                    <div className="absolute right-2.5 bottom-2.5 opacity-0 transition group-hover:opacity-100">
                      {isTrashView ? (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            void onRestoreItem(item);
                          }}
                          title="从回收站恢复"
                          className="inline-flex items-center gap-1 rounded-lg bg-emerald-600/95 px-2.5 py-1 text-[11px] font-semibold text-white shadow-sm transition hover:bg-emerald-700"
                        >
                          <RotateCcw className="h-3 w-3" />
                          <span>恢复</span>
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            void onSoftDeleteItem(item);
                          }}
                          title="移入回收站"
                          className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-slate-900/75 text-white shadow-sm backdrop-blur-xs transition hover:bg-rose-600"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                  </div>

                  {/* 信息内容区 */}
                  <div className="flex flex-1 flex-col justify-between gap-2.5 p-3.5">
                    <div>
                      <h3 className="line-clamp-2 text-[13px] font-semibold leading-snug text-slate-900 group-hover:text-indigo-700">
                        {item.title}
                      </h3>
                      <p className="mt-1 flex items-center gap-1 truncate text-xs text-slate-500">
                        <User className="h-3 w-3 shrink-0 text-slate-400" />
                        <span className="truncate">{item.author.name}</span>
                      </p>
                    </div>

                    {/* 标签 pills */}
                    {visibleTags.length > 0 && (
                      <div className="flex flex-wrap gap-1">
                        {visibleTags.map((tagName) => {
                          const tagColor =
                            tagsByName.get(tagName)?.color ?? '#6366f1';
                          return (
                            <span
                              key={tagName}
                              className="inline-flex max-w-[110px] items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-700"
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
                          <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-500">
                            +{extraTagCount}
                          </span>
                        )}
                      </div>
                    )}

                    {/* 底部体积与收藏时间 */}
                    <div className="flex items-center justify-between border-t border-slate-100 pt-2 text-[11px] text-slate-400">
                      <span className="inline-flex items-center gap-1 tabular-nums">
                        <HardDrive className="h-3 w-3" />
                        <span>{formatBytes(item.totalSizeBytes)}</span>
                      </span>
                      <span>{formatRelativeTime(item.collectedAt)}</span>
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
              const platformInfo = platformMeta(item.platform);
              const syncInfo = syncStatusMeta(item.syncStatus);
              const mediaBadge = getMediaBadgeText(item);

              return (
                <article
                  key={item.id}
                  onClick={() => onOpenItem(item)}
                  className="group flex cursor-pointer items-center gap-3.5 rounded-xl border border-slate-200 bg-white p-2.5 shadow-2xs transition hover:border-indigo-300 hover:shadow-xs"
                >
                  {/* 缩略图 */}
                  <div className="relative h-16 w-28 shrink-0 overflow-hidden rounded-lg bg-slate-100">
                    {item.thumbnailDataUrl ? (
                      <img
                        src={item.thumbnailDataUrl}
                        alt={item.title}
                        loading="lazy"
                        className="h-full w-full object-cover"
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
                    <span className="absolute right-1 bottom-1 rounded bg-slate-950/75 px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-white">
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
                      <h3 className="truncate text-sm font-semibold text-slate-900 group-hover:text-indigo-700">
                        {item.title}
                      </h3>
                    </div>

                    <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
                      <span className="inline-flex items-center gap-1">
                        <User className="h-3 w-3 text-slate-400" />
                        <span>{item.author.name}</span>
                      </span>
                      <span className="tabular-nums">
                        {formatBytes(item.totalSizeBytes)}
                      </span>
                      <span>{formatRelativeTime(item.collectedAt)}</span>
                      {item.tags.slice(0, 4).map((tagName) => {
                        const tagColor =
                          tagsByName.get(tagName)?.color ?? '#6366f1';
                        return (
                          <span
                            key={tagName}
                            className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-700"
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
                      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-medium ${syncInfo.badgeClass}`}
                    >
                      <span
                        className={`h-1.5 w-1.5 rounded-full ${syncInfo.dotClass}`}
                      />
                      <span>{syncInfo.shortLabel}</span>
                    </span>

                    {isTrashView ? (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          void onRestoreItem(item);
                        }}
                        title="从回收站恢复"
                        className="inline-flex items-center gap-1 rounded-lg border border-emerald-200 bg-emerald-50 px-2.5 py-1.5 text-xs font-medium text-emerald-700 transition hover:bg-emerald-100"
                      >
                        <RotateCcw className="h-3.5 w-3.5" />
                        <span>恢复</span>
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          void onSoftDeleteItem(item);
                        }}
                        title="移入回收站"
                        className="rounded-lg p-1.5 text-slate-400 opacity-0 transition hover:bg-rose-50 hover:text-rose-600 group-hover:opacity-100"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    )}
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
