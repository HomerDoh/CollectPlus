import { useMemo, useState } from 'react';
import {
  AlertTriangle,
  BookmarkPlus,
  Check,
  ChevronDown,
  ChevronRight,
  Film,
  Folder,
  FolderOpen,
  FolderPlus,
  FolderSync,
  Images,
  Inbox,
  Layers,
  Pencil,
  Plus,
  Settings,
  Trash2,
  X,
} from 'lucide-react';
import type { CollectionItemRecord, FolderNode } from '@/types/schema.ts';

export type QuickNavView = 'all' | 'uncategorized' | 'pending_sync' | 'trash';
export type SidebarSyncStatus = 'syncing' | 'failed';
export type MediaKindFilter = 'all' | 'video' | 'image_text';
export type PlatformFilter =
  | 'all'
  | 'douyin'
  | 'bilibili'
  | 'v2ex'
  | 'xiaohongshu'
  | 'zhihu'
  | 'youtube'
  | 'twitter';

export interface SidebarTreeProps {
  items: readonly CollectionItemRecord[];
  folders: readonly FolderNode[];
  activeView: QuickNavView;
  selectedFolderId: string | null;
  mediaKindFilter: MediaKindFilter;
  platformFilter: PlatformFilter;
  isSettingsOpen: boolean;
  syncStatus: SidebarSyncStatus;
  onSelectView: (view: QuickNavView) => void;
  onSelectFolder: (folderId: string) => void;
  onSelectMediaKind: (kind: MediaKindFilter) => void;
  onSelectPlatform: (platform: PlatformFilter) => void;
  onOpenSettings: () => void;
  onOpenVaultSettings: () => void;
  onCreateFolder: (name: string, parentId: string | null) => Promise<void>;
  onRenameFolder: (id: string, name: string) => Promise<void>;
  onDeleteFolder: (id: string) => Promise<void>;
}

interface FolderTreeNode {
  folder: FolderNode;
  children: FolderTreeNode[];
}

function buildFolderTree(folders: readonly FolderNode[]): FolderTreeNode[] {
  const sorted = [...folders].sort(
    (a, b) => a.sortOrder - b.sortOrder || a.createdAt - b.createdAt,
  );
  const nodeMap = new Map<string, FolderTreeNode>();
  for (const folder of sorted) {
    nodeMap.set(folder.id, { folder, children: [] });
  }

  const roots: FolderTreeNode[] = [];
  for (const folder of sorted) {
    const node = nodeMap.get(folder.id);
    if (!node) {
      continue;
    }
    if (folder.parentId !== null) {
      const parent = nodeMap.get(folder.parentId);
      if (parent) {
        parent.children.push(node);
        continue;
      }
    }
    roots.push(node);
  }
  return roots;
}

export function SidebarTree({
  items,
  folders,
  activeView,
  selectedFolderId,
  mediaKindFilter,
  platformFilter,
  isSettingsOpen,
  syncStatus,
  onSelectView,
  onSelectFolder,
  onSelectMediaKind,
  onSelectPlatform,
  onOpenSettings,
  onOpenVaultSettings,
  onCreateFolder,
  onRenameFolder,
  onDeleteFolder,
}: SidebarTreeProps) {
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [creatingParentId, setCreatingParentId] = useState<
    string | null | undefined
  >(undefined);
  const [newFolderName, setNewFolderName] = useState('');
  const [renamingFolderId, setRenamingFolderId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [deletingFolder, setDeletingFolder] = useState<FolderNode | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [syncTipOpen, setSyncTipOpen] = useState(false);

  // 计算快捷视图计数与每个文件夹含子级计数
  const {
    allCount,
    uncategorizedCount,
    pendingSyncCount,
    trashCount,
    folderDirectCounts,
  } = useMemo(() => {
    let all = 0;
    let uncategorized = 0;
    let pendingSync = 0;
    let trash = 0;
    const directFolderMap = new Map<string, number>();

    for (const item of items) {
      if (item.deletedAt != null) {
        trash += 1;
        continue;
      }
      all += 1;
      if (item.folderId === null) {
        uncategorized += 1;
      } else {
        directFolderMap.set(
          item.folderId,
          (directFolderMap.get(item.folderId) ?? 0) + 1,
        );
      }
      if (
        item.syncStatus === 'opfs_staged' ||
        item.syncStatus === 'meta_dirty'
      ) {
        pendingSync += 1;
      }
    }

    return {
      allCount: all,
      uncategorizedCount: uncategorized,
      pendingSyncCount: pendingSync,
      trashCount: trash,
      folderDirectCounts: directFolderMap,
    };
  }, [items]);

  const folderTree = useMemo(() => buildFolderTree(folders), [folders]);

  const folderTotalCounts = useMemo(() => {
    const totals = new Map<string, number>();
    const dfs = (node: FolderTreeNode): number => {
      let sum = folderDirectCounts.get(node.folder.id) ?? 0;
      for (const child of node.children) {
        sum += dfs(child);
      }
      totals.set(node.folder.id, sum);
      return sum;
    };
    for (const root of folderTree) {
      dfs(root);
    }
    return totals;
  }, [folderTree, folderDirectCounts]);

  const toggleExpand = (folderId: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(folderId)) {
        next.delete(folderId);
      } else {
        next.add(folderId);
      }
      return next;
    });
  };

  const startCreateFolder = (parentId: string | null) => {
    setRenamingFolderId(null);
    setCreatingParentId(parentId);
    setNewFolderName('');
    if (parentId !== null) {
      setExpandedIds((prev) => new Set(prev).add(parentId));
    }
  };

  const submitCreateFolder = async () => {
    const trimmed = newFolderName.trim();
    if (!trimmed || creatingParentId === undefined || submitting) {
      setCreatingParentId(undefined);
      setNewFolderName('');
      return;
    }
    setSubmitting(true);
    try {
      await onCreateFolder(trimmed, creatingParentId);
      setCreatingParentId(undefined);
      setNewFolderName('');
    } finally {
      setSubmitting(false);
    }
  };

  const startRenameFolder = (folder: FolderNode) => {
    setCreatingParentId(undefined);
    setRenamingFolderId(folder.id);
    setRenameDraft(folder.name);
  };

  const submitRenameFolder = async () => {
    const trimmed = renameDraft.trim();
    if (!renamingFolderId || !trimmed || submitting) {
      setRenamingFolderId(null);
      return;
    }
    setSubmitting(true);
    try {
      await onRenameFolder(renamingFolderId, trimmed);
      setRenamingFolderId(null);
    } finally {
      setSubmitting(false);
    }
  };

  const confirmDeleteFolder = async () => {
    if (!deletingFolder || submitting) {
      return;
    }
    setSubmitting(true);
    try {
      await onDeleteFolder(deletingFolder.id);
      setDeletingFolder(null);
    } finally {
      setSubmitting(false);
    }
  };

  const renderInlineCreateInput = (depth: number) => (
    <div
      className="my-1 flex items-center gap-1 rounded-lg border border-indigo-300 bg-indigo-50/40 px-2 py-1"
      style={{ marginLeft: `${depth * 14}px` }}
    >
      <FolderPlus className="h-3.5 w-3.5 shrink-0 text-indigo-600" />
      <input
        type="text"
        value={newFolderName}
        onChange={(e) => setNewFolderName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            void submitCreateFolder();
          } else if (e.key === 'Escape') {
            setCreatingParentId(undefined);
            setNewFolderName('');
          }
        }}
        placeholder="输入文件夹名称"
        autoFocus
        className="min-w-0 flex-1 bg-transparent text-xs text-slate-900 placeholder:text-slate-400 focus:outline-none"
      />
      <button
        type="button"
        onClick={() => void submitCreateFolder()}
        disabled={submitting}
        className="rounded p-0.5 text-indigo-600 hover:bg-indigo-100"
        title="确认创建"
      >
        <Check className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        onClick={() => {
          setCreatingParentId(undefined);
          setNewFolderName('');
        }}
        className="rounded p-0.5 text-slate-400 hover:bg-slate-200/70 hover:text-slate-600"
        title="取消"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );

  const renderFolderNode = (node: FolderTreeNode, depth: number) => {
    const { folder, children } = node;
    const isExpanded = expandedIds.has(folder.id);
    const isSelected = !isSettingsOpen && selectedFolderId === folder.id;
    const isRenaming = renamingFolderId === folder.id;
    const isCreatingChild = creatingParentId === folder.id;
    const hasChildren = children.length > 0;
    const count = folderTotalCounts.get(folder.id) ?? 0;

    return (
      <div key={folder.id}>
        {isRenaming ? (
          <div
            className="my-0.5 flex items-center gap-1 rounded-lg border border-indigo-300 bg-white px-2 py-1"
            style={{ marginLeft: `${depth * 14}px` }}
          >
            <input
              type="text"
              value={renameDraft}
              onChange={(e) => setRenameDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void submitRenameFolder();
                } else if (e.key === 'Escape') {
                  setRenamingFolderId(null);
                }
              }}
              autoFocus
              className="min-w-0 flex-1 bg-transparent text-xs text-slate-900 focus:outline-none"
            />
            <button
              type="button"
              onClick={() => void submitRenameFolder()}
              disabled={submitting}
              className="rounded p-0.5 text-indigo-600 hover:bg-indigo-50"
              title="保存重命名"
            >
              <Check className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => setRenamingFolderId(null)}
              className="rounded p-0.5 text-slate-400 hover:bg-slate-100"
              title="取消"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ) : (
          <div
            className={`group flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs transition ${
              isSelected
                ? 'bg-indigo-50 font-semibold text-indigo-700'
                : 'text-slate-700 hover:bg-slate-100/80'
            }`}
            style={{ paddingLeft: `${8 + depth * 14}px` }}
          >
            <button
              type="button"
              onClick={() => toggleExpand(folder.id)}
              className={`flex h-4 w-4 shrink-0 items-center justify-center rounded text-slate-400 hover:text-slate-600 ${
                hasChildren ? 'visible' : 'invisible'
              }`}
              aria-label={isExpanded ? '折叠子文件夹' : '展开子文件夹'}
            >
              {isExpanded ? (
                <ChevronDown className="h-3.5 w-3.5" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5" />
              )}
            </button>

            <button
              type="button"
              onClick={() => onSelectFolder(folder.id)}
              className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
            >
              {isSelected || isExpanded ? (
                <FolderOpen
                  className={`h-3.5 w-3.5 shrink-0 ${
                    isSelected ? 'text-indigo-600' : 'text-amber-500'
                  }`}
                />
              ) : (
                <Folder className="h-3.5 w-3.5 shrink-0 text-slate-400 group-hover:text-amber-500" />
              )}
              <span className="truncate">{folder.name}</span>
            </button>

            {/* 悬浮快捷操作 */}
            <div className="hidden items-center gap-0.5 group-hover:flex">
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  startCreateFolder(folder.id);
                }}
                title="新建子文件夹"
                className="rounded p-0.5 text-slate-400 hover:bg-white hover:text-indigo-600"
              >
                <FolderPlus className="h-3 w-3" />
              </button>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  startRenameFolder(folder);
                }}
                title="重命名文件夹"
                className="rounded p-0.5 text-slate-400 hover:bg-white hover:text-indigo-600"
              >
                <Pencil className="h-3 w-3" />
              </button>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setDeletingFolder(folder);
                }}
                title="删除文件夹"
                className="rounded p-0.5 text-slate-400 hover:bg-white hover:text-rose-600"
              >
                <Trash2 className="h-3 w-3" />
              </button>
            </div>

            <span
              className={`shrink-0 text-[11px] tabular-nums group-hover:hidden ${
                isSelected ? 'text-indigo-600' : 'text-slate-400'
              }`}
            >
              {count}
            </span>
          </div>
        )}

        {isCreatingChild && renderInlineCreateInput(depth + 1)}

        {hasChildren &&
          isExpanded &&
          children.map((child) => renderFolderNode(child, depth + 1))}
      </div>
    );
  };

  const navItems: Array<{
    key: QuickNavView;
    label: string;
    count: number;
    icon: typeof Layers;
    highlightAmber?: boolean;
  }> = [
    { key: 'all', label: '全部收藏', count: allCount, icon: Layers },
    {
      key: 'uncategorized',
      label: '未分类',
      count: uncategorizedCount,
      icon: Inbox,
    },
    {
      key: 'pending_sync',
      label: '待同步',
      count: pendingSyncCount,
      icon: FolderSync,
      highlightAmber: pendingSyncCount > 0,
    },
    { key: 'trash', label: '回收站', count: trashCount, icon: Trash2 },
  ];

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-slate-200 bg-white">
      {/* 品牌头部 */}
      <div className="flex items-center justify-between gap-2 border-b border-slate-200 px-4 py-3.5">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-indigo-600 text-white shadow-xs">
            <BookmarkPlus className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <h1 className="truncate text-sm font-bold tracking-tight text-slate-900">
              Collect+
            </h1>
            <p className="truncate text-[11px] text-slate-500">本地离线媒体库</p>
          </div>
        </div>

        {/* 本地目录同步状态点与悬浮提示 */}
        <div
          className="relative shrink-0"
          onMouseEnter={() => setSyncTipOpen(true)}
          onMouseLeave={() => setSyncTipOpen(false)}
          onFocus={() => setSyncTipOpen(true)}
          onBlur={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget)) {
              setSyncTipOpen(false);
            }
          }}
        >
          <button
            type="button"
            data-testid="sidebar-sync-status"
            aria-describedby={syncTipOpen ? 'sidebar-sync-tooltip' : undefined}
            className={`inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-[11px] font-medium transition ${
              syncStatus === 'syncing'
                ? 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100/80'
                : 'bg-rose-50 text-rose-700 hover:bg-rose-100/80'
            }`}
          >
            <span
              className={`h-2 w-2 shrink-0 rounded-full ${
                syncStatus === 'syncing' ? 'bg-emerald-500' : 'bg-rose-500'
              }`}
              aria-hidden="true"
            />
            <span>{syncStatus === 'syncing' ? '同步中' : '同步失败'}</span>
          </button>

          {syncTipOpen && (
            <div className="absolute right-0 top-full z-40 w-56 pt-1.5">
              <div
                id="sidebar-sync-tooltip"
                role="tooltip"
                className="rounded-xl border border-slate-200 bg-white p-3 text-xs leading-relaxed text-slate-700 shadow-lg"
              >
                {syncStatus === 'syncing' ? (
                  <p>收藏内容正在同步保存到本地文件夹</p>
                ) : (
                  <div>
                    <p>请选择本地同步文件夹</p>
                    <a
                      href="#settings-vault-section"
                      onClick={(e) => {
                        e.preventDefault();
                        setSyncTipOpen(false);
                        onOpenVaultSettings();
                      }}
                      className="mt-1.5 inline-flex items-center font-medium text-indigo-600 underline decoration-indigo-300 underline-offset-2 transition hover:text-indigo-700"
                    >
                      前往本地同步目录设置
                    </a>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* 可滚动导航区 */}
      <div className="flex flex-1 flex-col gap-5 overflow-y-auto px-3 py-4">
        {/* 快捷视图导航 */}
        <nav className="flex flex-col gap-0.5" aria-label="快捷视图">
          {navItems.map((nav) => {
            const Icon = nav.icon;
            const isActive =
              !isSettingsOpen &&
              selectedFolderId === null &&
              activeView === nav.key;
            return (
              <button
                key={nav.key}
                type="button"
                onClick={() => onSelectView(nav.key)}
                className={`flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-xs font-medium transition ${
                  isActive
                    ? 'bg-indigo-50 text-indigo-700'
                    : 'text-slate-700 hover:bg-slate-100/80'
                }`}
              >
                <span className="flex items-center gap-2">
                  <Icon
                    className={`h-4 w-4 ${
                      isActive
                        ? 'text-indigo-600'
                        : nav.highlightAmber
                          ? 'text-amber-500'
                          : 'text-slate-400'
                    }`}
                  />
                  <span>{nav.label}</span>
                </span>
                <span
                  className={`rounded-full px-1.5 py-0.5 text-[11px] tabular-nums ${
                    isActive
                      ? 'bg-indigo-100 font-semibold text-indigo-700'
                      : nav.highlightAmber
                        ? 'bg-amber-100 font-semibold text-amber-800'
                        : 'text-slate-400'
                  }`}
                >
                  {nav.count}
                </span>
              </button>
            );
          })}
        </nav>

        {/* 媒体类型与平台筛选 */}
        <section>
          <p className="mb-2 px-2 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
            媒体类型
          </p>
          <div
            className="grid grid-cols-3 gap-1 rounded-lg bg-slate-100 p-1"
            role="group"
            aria-label="媒体类型筛选"
          >
            {(
              [
                { value: 'all', label: '全部', icon: null },
                { value: 'video', label: '视频', icon: Film },
                { value: 'image_text', label: '图文', icon: Images },
              ] as const
            ).map((opt) => {
              const Icon = opt.icon;
              const active = mediaKindFilter === opt.value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => onSelectMediaKind(opt.value)}
                  className={`flex items-center justify-center gap-1 rounded-md px-2 py-1 text-xs font-medium transition ${
                    active
                      ? 'bg-white text-indigo-700 shadow-2xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {Icon && <Icon className="h-3 w-3" />}
                  <span>{opt.label}</span>
                </button>
              );
            })}
          </div>

          <div className="mt-2.5">
            <div className="mb-1.5 flex items-center justify-between px-2">
              <p className="text-[11px] font-medium text-slate-400">来源平台</p>
              {platformFilter !== 'all' && (
                <button
                  type="button"
                  onClick={() => onSelectPlatform('all')}
                  className="text-[11px] font-medium text-indigo-600 hover:underline"
                >
                  重置
                </button>
              )}
            </div>
            <div
              className="flex flex-wrap gap-1 px-1"
              role="group"
              aria-label="来源平台筛选"
            >
              {(
                [
                  { value: 'all', label: '全部' },
                  { value: 'douyin', label: '抖音' },
                  { value: 'bilibili', label: 'B站' },
                  { value: 'v2ex', label: 'V2EX' },
                  { value: 'xiaohongshu', label: '小红书' },
                  { value: 'zhihu', label: '知乎' },
                  { value: 'youtube', label: 'YouTube' },
                  { value: 'twitter', label: 'X' },
                ] as const
              ).map((opt) => {
                const active = platformFilter === opt.value;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => onSelectPlatform(opt.value)}
                    className={`rounded-md border px-2 py-1 text-[11px] font-medium transition ${
                      active
                        ? 'border-indigo-500 bg-indigo-50 text-indigo-700 shadow-2xs'
                        : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:bg-slate-50 hover:text-slate-900'
                    }`}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
          </div>
        </section>

        {/* 多级文件夹分类树 */}
        <section>
          <div className="mb-1.5 flex items-center justify-between px-2">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
              文件夹
            </p>
            <button
              type="button"
              onClick={() => startCreateFolder(null)}
              title="新建顶级文件夹"
              className="inline-flex items-center gap-0.5 rounded-md px-1.5 py-0.5 text-[11px] font-medium text-indigo-600 transition hover:bg-indigo-50"
            >
              <Plus className="h-3 w-3" />
              <span>新建</span>
            </button>
          </div>

          {creatingParentId === null && renderInlineCreateInput(0)}

          {folderTree.length === 0 && creatingParentId !== null ? (
            <p className="px-2 py-2 text-xs text-slate-400">
              暂无文件夹，点击「新建」整理收藏
            </p>
          ) : (
            <div className="flex flex-col gap-0.5">
              {folderTree.map((rootNode) => renderFolderNode(rootNode, 0))}
            </div>
          )}
        </section>
      </div>

      {/* 底部固定设置入口 */}
      <div className="border-t border-slate-200 p-3">
        <button
          type="button"
          onClick={onOpenSettings}
          className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-xs font-medium transition ${
            isSettingsOpen
              ? 'bg-indigo-50 text-indigo-700'
              : 'text-slate-700 hover:bg-slate-100/80'
          }`}
        >
          <Settings
            className={`h-4 w-4 ${
              isSettingsOpen ? 'text-indigo-600' : 'text-slate-400'
            }`}
          />
          <span>设置</span>
        </button>
      </div>

      {/* 删除文件夹二次确认框 */}
      {deletingFolder && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/45 p-4 backdrop-blur-[1px]"
          onClick={() => !submitting && setDeletingFolder(null)}
        >
          <div
            className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-5 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start gap-3">
              <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-rose-50 text-rose-600">
                <AlertTriangle className="h-5 w-5" />
              </span>
              <div>
                <h3 className="text-sm font-semibold text-slate-900">
                  删除文件夹「{deletingFolder.name}」？
                </h3>
                <p className="mt-1.5 text-xs leading-relaxed text-slate-600">
                  该文件夹及其所有子文件夹将被移除；其中的收藏条目不会被删除，而是自动移至「未分类」。
                </p>
              </div>
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setDeletingFolder(null)}
                disabled={submitting}
                className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => void confirmDeleteFolder()}
                disabled={submitting}
                className="rounded-lg bg-rose-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-rose-700 disabled:opacity-60"
              >
                确认删除
              </button>
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}
