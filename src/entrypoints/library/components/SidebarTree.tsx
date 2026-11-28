import { useMemo, useState } from 'react';
import {
  AlertTriangle,
  BookmarkPlus,
  Check,
  ChevronDown,
  ChevronRight,
  Clock,
  CloudOff,
  Film,
  Folder,
  FolderOpen,
  FolderPlus,
  Images,
  Inbox,
  Layers,
  Monitor,
  Moon,
  Pencil,
  Plus,
  Settings,
  SlidersHorizontal,
  Sun,
  Trash2,
  X,
} from 'lucide-react';
import { getAllSiteAdapters } from '@/adapters/registry.ts';
import { i18n } from '@/i18n/index.ts';
import { setThemeMode, useTheme, type ThemeMode } from '@/theme/index.ts';
import {
  getItemFolderIds,
  isAutoSyncExcluded,
  type CollectionItemRecord,
  type FolderNode,
  type PlatformId,
} from '@/types/schema.ts';
import { platformMeta } from '../utils/format.ts';

export type QuickNavView =
  | 'all'
  | 'recent'
  | 'uncategorized'
  | 'excluded'
  | 'trash';
export type SidebarSyncStatus = 'syncing' | 'failed';
export type MediaKindFilter = 'all' | 'video' | 'image_text';
export type PlatformFilter = 'all' | PlatformId;

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
  onCreateFolder: (
    name: string,
    parentId: string | null,
  ) => Promise<void | FolderNode>;
  onRenameFolder: (id: string, name: string) => Promise<void>;
  onDeleteFolder: (id: string) => Promise<void>;
  onEditFolderAutoRule?: (folder: FolderNode) => void;
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
  onEditFolderAutoRule,
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
  const [moreNavExpanded, setMoreNavExpanded] = useState(false);
  const { mode: themeMode } = useTheme();

  // 计算快捷视图计数与每个文件夹含子级去重计数（支持单条目同时属于多个文件夹）
  const {
    allCount,
    recentCount,
    uncategorizedCount,
    excludedCount,
    trashCount,
    folderDirectItemIds,
  } = useMemo(() => {
    let all = 0;
    let recent = 0;
    let uncategorized = 0;
    let excluded = 0;
    let trash = 0;
    const directMap = new Map<string, Set<string>>();

    for (const item of items) {
      if (isAutoSyncExcluded(item)) {
        excluded += 1;
        continue;
      }
      if (item.deletedAt != null) {
        trash += 1;
        continue;
      }
      all += 1;
      if (item.openedAt == null) {
        recent += 1;
      }
      const itemFolderIds = getItemFolderIds(item);
      if (itemFolderIds.length === 0) {
        uncategorized += 1;
      } else {
        for (const fid of itemFolderIds) {
          let bucket = directMap.get(fid);
          if (!bucket) {
            bucket = new Set<string>();
            directMap.set(fid, bucket);
          }
          bucket.add(item.id);
        }
      }
    }

    return {
      allCount: all,
      recentCount: recent,
      uncategorizedCount: uncategorized,
      excludedCount: excluded,
      trashCount: trash,
      folderDirectItemIds: directMap,
    };
  }, [items]);

  const folderTree = useMemo(() => buildFolderTree(folders), [folders]);

  const folderTotalCounts = useMemo(() => {
    const totals = new Map<string, number>();
    const dfs = (node: FolderTreeNode): Set<string> => {
      const merged = new Set<string>(folderDirectItemIds.get(node.folder.id));
      for (const child of node.children) {
        for (const itemId of dfs(child)) {
          merged.add(itemId);
        }
      }
      totals.set(node.folder.id, merged.size);
      return merged;
    };
    for (const root of folderTree) {
      dfs(root);
    }
    return totals;
  }, [folderTree, folderDirectItemIds]);

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
      className="my-1 flex items-center gap-1 rounded border border-[var(--cp-accent)] bg-[var(--cp-active)] px-2 py-1"
      style={{ marginLeft: `${depth * 14}px` }}
    >
      <FolderPlus className="h-3.5 w-3.5 shrink-0 text-[var(--cp-accent)]" />
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
        placeholder={i18n.t('sidebar.folderNamePlaceholder')}
        autoFocus
        className="min-w-0 flex-1 bg-transparent text-xs text-[var(--cp-text)] placeholder:text-[var(--cp-text-muted)] focus:outline-none"
      />
      <button
        type="button"
        onClick={() => void submitCreateFolder()}
        disabled={submitting}
        className="rounded p-0.5 text-[var(--cp-accent)] hover:bg-[var(--cp-surface)]"
        title={i18n.t('sidebar.confirmCreateFolderTitle')}
      >
        <Check className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        onClick={() => {
          setCreatingParentId(undefined);
          setNewFolderName('');
        }}
        className="rounded p-0.5 text-[var(--cp-text-muted)] hover:bg-[var(--cp-muted)] hover:text-[var(--cp-text)]"
        title={i18n.t('common.cancel')}
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
            className="my-0.5 flex items-center gap-1 rounded border border-[var(--cp-accent)] bg-[var(--cp-surface)] px-2 py-1"
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
              className="min-w-0 flex-1 bg-transparent text-xs text-[var(--cp-text)] focus:outline-none"
            />
            <button
              type="button"
              onClick={() => void submitRenameFolder()}
              disabled={submitting}
              className="rounded p-0.5 text-[var(--cp-accent)] hover:bg-[var(--cp-active)]"
              title={i18n.t('sidebar.saveRenameFolderTitle')}
            >
              <Check className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => setRenamingFolderId(null)}
              className="rounded p-0.5 text-[var(--cp-text-muted)] hover:bg-[var(--cp-muted)]"
              title={i18n.t('common.cancel')}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ) : (
          <div
            className={`group flex items-center gap-1 rounded px-2 py-1.5 text-xs transition ${
              isSelected
                ? 'bg-[var(--cp-active)] font-semibold text-[var(--cp-text-active)]'
                : 'text-[var(--cp-text-secondary)] hover:bg-[var(--cp-muted)] hover:text-[var(--cp-text)]'
            }`}
            style={{ paddingLeft: `${8 + depth * 14}px` }}
          >
            <button
              type="button"
              onClick={() => toggleExpand(folder.id)}
              className={`flex h-4 w-4 shrink-0 items-center justify-center rounded text-[var(--cp-text-muted)] hover:text-[var(--cp-text)] ${
                hasChildren ? 'visible' : 'invisible'
              }`}
              aria-label={
                isExpanded
                  ? i18n.t('sidebar.collapseSubfoldersAria')
                  : i18n.t('sidebar.expandSubfoldersAria')
              }
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
                    isSelected ? 'text-[var(--cp-accent)]' : 'text-[var(--cp-accent-2)]'
                  }`}
                />
              ) : (
                <Folder className="h-3.5 w-3.5 shrink-0 text-[var(--cp-text-muted)] group-hover:text-[var(--cp-accent-2)]" />
              )}
              <span className="truncate">{folder.name}</span>
              {folder.autoRule && (
                <span
                  className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--cp-accent)]"
                  title={i18n.t('sidebar.autoRuleActiveTitle')}
                />
              )}
            </button>

            {/* 悬浮快捷操作 */}
            <div className="hidden items-center gap-0.5 group-hover:flex">
              {onEditFolderAutoRule && (
                <button
                  type="button"
                  data-testid={`sidebar-folder-rule-${folder.id}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onEditFolderAutoRule(folder);
                  }}
                  title={i18n.t('sidebar.autoRuleFolderTitle')}
                  className={`rounded p-0.5 transition hover:bg-[var(--cp-surface)] hover:text-[var(--cp-accent)] ${
                    folder.autoRule
                      ? 'text-[var(--cp-accent)]'
                      : 'text-[var(--cp-text-muted)]'
                  }`}
                >
                  <SlidersHorizontal className="h-3 w-3" />
                </button>
              )}
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  startCreateFolder(folder.id);
                }}
                title={i18n.t('sidebar.newSubfolderTitle')}
                className="rounded p-0.5 text-[var(--cp-text-muted)] hover:bg-[var(--cp-surface)] hover:text-[var(--cp-accent)]"
              >
                <FolderPlus className="h-3 w-3" />
              </button>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  startRenameFolder(folder);
                }}
                title={i18n.t('sidebar.renameFolderTitle')}
                className="rounded p-0.5 text-[var(--cp-text-muted)] hover:bg-[var(--cp-surface)] hover:text-[var(--cp-accent)]"
              >
                <Pencil className="h-3 w-3" />
              </button>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setDeletingFolder(folder);
                }}
                title={i18n.t('sidebar.deleteFolderTitle')}
                className="rounded p-0.5 text-[var(--cp-text-muted)] hover:bg-[var(--cp-surface)] hover:text-rose-600 dark:hover:text-rose-400"
              >
                <Trash2 className="h-3 w-3" />
              </button>
            </div>

            <span
              className={`shrink-0 text-[11px] tabular-nums group-hover:hidden ${
                isSelected ? 'text-[var(--cp-text-active)]' : 'text-[var(--cp-text-muted)]'
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

  const primaryNavItems: Array<{
    key: QuickNavView;
    label: string;
    count: number;
    icon: typeof Layers;
  }> = [
    { key: 'all', label: i18n.t('sidebar.navAll'), count: allCount, icon: Layers },
    {
      key: 'recent',
      label: i18n.t('sidebar.navRecent'),
      count: recentCount,
      icon: Clock,
    },
    {
      key: 'uncategorized',
      label: i18n.t('sidebar.navUncategorized'),
      count: uncategorizedCount,
      icon: Inbox,
    },
  ];

  const collapsedNavItems: Array<{
    key: QuickNavView;
    label: string;
    count: number;
    icon: typeof Layers;
  }> = [
    {
      key: 'excluded',
      label: i18n.t('sidebar.navExcluded'),
      count: excludedCount,
      icon: CloudOff,
    },
    { key: 'trash', label: i18n.t('sidebar.navTrash'), count: trashCount, icon: Trash2 },
  ];

  const renderNavItem = (nav: {
    key: QuickNavView;
    label: string;
    count: number;
    icon: typeof Layers;
  }) => {
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
        className={`flex w-full items-center justify-between rounded px-2.5 py-2 text-xs font-medium transition ${
          isActive
            ? 'bg-[var(--cp-active)] text-[var(--cp-text-active)] font-semibold'
            : 'text-[var(--cp-text-secondary)] hover:bg-[var(--cp-muted)] hover:text-[var(--cp-text)]'
        }`}
      >
        <span className="flex items-center gap-2">
          <Icon
            className={`h-4 w-4 ${
              isActive
                ? 'text-[var(--cp-accent)]'
                : 'text-[var(--cp-text-muted)]'
            }`}
          />
          <span>{nav.label}</span>
        </span>
        <span
          className={`rounded px-1.5 py-0.5 text-[11px] tabular-nums ${
            isActive
              ? 'bg-[var(--cp-accent-soft)] font-semibold text-[var(--cp-text-active)]'
              : 'text-[var(--cp-text-muted)]'
          }`}
        >
          {nav.count}
        </span>
      </button>
    );
  };

  const themeOptions: ReadonlyArray<{
    value: ThemeMode;
    label: string;
    icon: typeof Monitor;
  }> = [
    { value: 'system', label: i18n.t('sidebar.themeSystem'), icon: Monitor },
    { value: 'light', label: i18n.t('sidebar.themeLight'), icon: Sun },
    { value: 'dark', label: i18n.t('sidebar.themeDark'), icon: Moon },
  ];

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-[var(--cp-border)] bg-[var(--cp-surface)]">
      {/* 品牌头部 */}
      <div className="flex items-center justify-between gap-2 border-b border-[var(--cp-divider)] px-4 py-3.5">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded bg-[var(--cp-accent)] text-[var(--cp-on-accent)]">
            <BookmarkPlus className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <h1 className="truncate text-sm font-bold tracking-tight text-[var(--cp-text)]">
              CollectPlus
            </h1>
            <p className="truncate text-[11px] text-[var(--cp-text-muted)]">
              {i18n.t('sidebar.subtitle')}
            </p>
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
            className={`inline-flex items-center gap-1.5 rounded px-2 py-1 text-[11px] font-medium transition ${
              syncStatus === 'syncing'
                ? 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100/80 dark:bg-emerald-950/70 dark:text-emerald-300 dark:hover:bg-emerald-950'
                : 'bg-rose-50 text-rose-700 hover:bg-rose-100/80 dark:bg-rose-950/70 dark:text-rose-300 dark:hover:bg-rose-950'
            }`}
          >
            <span
              className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                syncStatus === 'syncing'
                  ? 'bg-emerald-500 dark:bg-emerald-400'
                  : 'bg-rose-500 dark:bg-rose-400'
              }`}
              aria-hidden="true"
            />
            <span>
              {syncStatus === 'syncing'
                ? i18n.t('sidebar.syncing')
                : i18n.t('sidebar.syncFailed')}
            </span>
          </button>

          {syncTipOpen && (
            <div className="absolute right-0 top-full z-40 w-56 pt-1.5">
              <div
                id="sidebar-sync-tooltip"
                role="tooltip"
                className="rounded-md border border-[var(--cp-border-strong)] bg-[var(--cp-surface)] p-3 text-xs leading-relaxed text-[var(--cp-text-secondary)]"
              >
                {syncStatus === 'syncing' ? (
                  <p>{i18n.t('sidebar.syncingTooltip')}</p>
                ) : (
                  <div>
                    <p>{i18n.t('sidebar.syncFailedTooltip')}</p>
                    <a
                      href="#settings-vault-section"
                      onClick={(e) => {
                        e.preventDefault();
                        setSyncTipOpen(false);
                        onOpenVaultSettings();
                      }}
                      className="mt-1.5 inline-flex items-center font-medium text-[var(--cp-accent)] underline underline-offset-2 transition hover:text-[var(--cp-accent-hover)]"
                    >
                      {i18n.t('sidebar.goToVaultSettings')}
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
        <nav className="flex flex-col gap-0.5" aria-label={i18n.t('sidebar.quickNavAria')}>
          {primaryNavItems.map(renderNavItem)}

          {moreNavExpanded && (
            <div className="flex flex-col gap-0.5">
              {collapsedNavItems.map(renderNavItem)}
            </div>
          )}

          <button
            type="button"
            data-testid="sidebar-more-toggle"
            aria-expanded={moreNavExpanded}
            aria-label={
              moreNavExpanded
                ? i18n.t('sidebar.navCollapseMore')
                : i18n.t('sidebar.navExpandMore')
            }
            title={
              moreNavExpanded
                ? i18n.t('sidebar.navCollapseMore')
                : i18n.t('sidebar.navExpandMore')
            }
            onClick={() => setMoreNavExpanded((prev) => !prev)}
            className="group mt-0.5 flex h-[26px] w-full cursor-pointer items-center justify-center rounded bg-transparent text-[var(--cp-text-muted)] transition-colors duration-200 hover:text-[var(--cp-accent)] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--cp-accent)]"
          >
            <span
              className="inline-flex flex-col items-center justify-center transition-[transform,filter] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] group-hover:-translate-y-[2.5px] group-hover:drop-shadow-[0_2px_3px_rgba(13,148,136,0.25)] motion-reduce:transition-none motion-reduce:group-hover:translate-y-0"
              aria-hidden="true"
            >
              <svg
                className={`-my-[1.5px] block h-2 w-3.5 transition-opacity duration-200 group-hover:opacity-100 ${
                  moreNavExpanded ? 'opacity-90' : 'opacity-50'
                }`}
                viewBox="0 0 14 8"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.6}
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d={moreNavExpanded ? 'M2 6L7 2L12 6' : 'M2 2L7 6L12 2'} />
              </svg>
              <svg
                className={`-my-[1.5px] block h-2 w-3.5 transition-opacity duration-200 group-hover:opacity-100 ${
                  moreNavExpanded ? 'opacity-50' : 'opacity-90'
                }`}
                viewBox="0 0 14 8"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.6}
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d={moreNavExpanded ? 'M2 6L7 2L12 6' : 'M2 2L7 6L12 2'} />
              </svg>
            </span>
          </button>
        </nav>

        {/* 媒体类型与平台筛选 */}
        <section>
          <p className="mb-2 px-2 text-[11px] font-semibold uppercase tracking-wider text-[var(--cp-text-muted)]">
            {i18n.t('sidebar.mediaTypeHeading')}
          </p>
          <div
            className="grid grid-cols-3 gap-1 rounded bg-[var(--cp-muted)] p-1"
            role="group"
            aria-label={i18n.t('sidebar.mediaTypeFilterAria')}
          >
            {(
              [
                { value: 'all', label: i18n.t('common.all'), icon: null },
                { value: 'video', label: i18n.t('format.mediaKind.video'), icon: Film },
                { value: 'image_text', label: i18n.t('format.mediaKind.imageText'), icon: Images },
              ] as const
            ).map((opt) => {
              const Icon = opt.icon;
              const active = mediaKindFilter === opt.value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => onSelectMediaKind(opt.value)}
                  className={`flex items-center justify-center gap-1 rounded px-2 py-1 text-xs font-medium transition ${
                    active
                      ? 'bg-[var(--cp-surface)] text-[var(--cp-text-active)] font-semibold'
                      : 'text-[var(--cp-text-secondary)] hover:text-[var(--cp-text)]'
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
              <p className="text-[11px] font-medium text-[var(--cp-text-muted)]">
                {i18n.t('sidebar.platformHeading')}
              </p>
              {platformFilter !== 'all' && (
                <button
                  type="button"
                  onClick={() => onSelectPlatform('all')}
                  className="text-[11px] font-medium text-[var(--cp-accent)] hover:underline"
                >
                  {i18n.t('common.reset')}
                </button>
              )}
            </div>
            <div
              className="flex flex-wrap gap-1 px-1"
              role="group"
              aria-label={i18n.t('sidebar.platformFilterAria')}
            >
              {(() => {
                const seen = new Set<string>();
                const options: Array<{ value: PlatformFilter; label: string }> = [
                  { value: 'all', label: i18n.t('common.all') },
                ];
                for (const adapter of getAllSiteAdapters()) {
                  seen.add(adapter.id);
                  options.push({
                    value: adapter.id,
                    label: platformMeta(adapter.id).label,
                  });
                }
                // 动态补充通用网页与任意已采集自定义 Recipe 站点
                for (const item of items) {
                  if (item.deletedAt != null || seen.has(item.platform)) {
                    continue;
                  }
                  seen.add(item.platform);
                  options.push({
                    value: item.platform,
                    label:
                      item.platform === 'web'
                        ? i18n.t('platform.web')
                        : platformMeta(item.platform).label,
                  });
                }
                if (
                  platformFilter !== 'all' &&
                  !seen.has(platformFilter)
                ) {
                  options.push({
                    value: platformFilter,
                    label:
                      platformFilter === 'web'
                        ? i18n.t('platform.web')
                        : platformMeta(platformFilter).label,
                  });
                }
                return options;
              })().map((opt) => {
                const active = platformFilter === opt.value;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => onSelectPlatform(opt.value)}
                    className={`rounded border px-2 py-1 text-[11px] font-medium transition ${
                      active
                        ? 'border-[var(--cp-accent)] bg-[var(--cp-active)] text-[var(--cp-text-active)] font-semibold'
                        : 'border-[var(--cp-border)] bg-[var(--cp-surface)] text-[var(--cp-text-secondary)] hover:border-[var(--cp-border-strong)] hover:text-[var(--cp-text)]'
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
            <p className="text-[11px] font-semibold uppercase tracking-wider text-[var(--cp-text-muted)]">
              {i18n.t('sidebar.foldersHeading')}
            </p>
            <button
              type="button"
              onClick={() => startCreateFolder(null)}
              title={i18n.t('sidebar.newRootFolderTitle')}
              className="inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[11px] font-medium text-[var(--cp-accent)] transition hover:bg-[var(--cp-active)]"
            >
              <Plus className="h-3 w-3" />
              <span>{i18n.t('common.create')}</span>
            </button>
          </div>

          {creatingParentId === null && renderInlineCreateInput(0)}

          {folderTree.length === 0 && creatingParentId !== null ? (
            <p className="px-2 py-2 text-xs text-[var(--cp-text-muted)]">
              {i18n.t('sidebar.emptyFoldersHint')}
            </p>
          ) : (
            <div className="flex flex-col gap-0.5">
              {folderTree.map((rootNode) => renderFolderNode(rootNode, 0))}
            </div>
          )}
        </section>
      </div>

      {/* 底部固定区域：设置入口与 tRPC 风格胶囊明暗切换同一行排列 */}
      <div
        data-testid="sidebar-footer-bar"
        className="flex items-center justify-between gap-2 border-t border-[var(--cp-divider)] p-3"
      >
        <button
          type="button"
          data-testid="sidebar-settings-btn"
          onClick={onOpenSettings}
          className={`flex min-w-0 flex-1 items-center gap-2 rounded px-2.5 py-2 text-xs font-medium transition ${
            isSettingsOpen
              ? 'bg-[var(--cp-active)] font-semibold text-[var(--cp-text-active)]'
              : 'text-[var(--cp-text-secondary)] hover:bg-[var(--cp-muted)] hover:text-[var(--cp-text)]'
          }`}
        >
          <Settings
            className={`h-4 w-4 shrink-0 ${
              isSettingsOpen ? 'text-[var(--cp-accent)]' : 'text-[var(--cp-text-muted)]'
            }`}
          />
          <span className="truncate">{i18n.t('sidebar.settings')}</span>
        </button>

        <div
          data-testid="sidebar-theme-switcher"
          role="group"
          aria-label={i18n.t('sidebar.themeSwitchAria')}
          className="inline-flex shrink-0 items-center gap-0.5 rounded-full border border-[var(--cp-border)] bg-[var(--cp-surface)] p-0.5"
        >
          {themeOptions.map((opt) => {
            const Icon = opt.icon;
            const active = themeMode === opt.value;
            return (
              <button
                key={opt.value}
                type="button"
                data-testid={`theme-option-${opt.value}`}
                aria-pressed={active}
                aria-label={opt.label}
                title={opt.label}
                onClick={() => void setThemeMode(opt.value)}
                className={`inline-flex h-6 w-6 items-center justify-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--cp-accent)] ${
                  active
                    ? 'bg-[var(--cp-muted)] text-[var(--cp-text)]'
                    : 'text-[var(--cp-text-muted)] hover:text-[var(--cp-text)]'
                }`}
              >
                <Icon className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
              </button>
            );
          })}
        </div>
      </div>

      {/* 删除文件夹二次确认框 */}
      {deletingFolder && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--cp-scrim)] p-4"
          onClick={() => !submitting && setDeletingFolder(null)}
        >
          <div
            role="dialog"
            aria-modal="true"
            className="w-full max-w-sm rounded-md border border-[var(--cp-border-strong)] bg-[var(--cp-surface)] p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start gap-3">
              <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded bg-rose-50 text-rose-600 dark:bg-rose-950/70 dark:text-rose-400">
                <AlertTriangle className="h-5 w-5" />
              </span>
              <div>
                <h3 className="text-sm font-semibold text-[var(--cp-text)]">
                  {i18n.t('sidebar.deleteFolderConfirmTitle', {
                    name: deletingFolder.name,
                  })}
                </h3>
                <p className="mt-1.5 text-xs leading-relaxed text-[var(--cp-text-secondary)]">
                  {i18n.t('sidebar.deleteFolderConfirmDesc')}
                </p>
              </div>
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setDeletingFolder(null)}
                disabled={submitting}
                className="rounded border border-[var(--cp-border)] bg-[var(--cp-surface)] px-3 py-1.5 text-xs font-medium text-[var(--cp-text-secondary)] transition hover:border-[var(--cp-border-strong)] hover:text-[var(--cp-text)]"
              >
                {i18n.t('common.cancel')}
              </button>
              <button
                type="button"
                onClick={() => void confirmDeleteFolder()}
                disabled={submitting}
                className="rounded bg-rose-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-rose-700 disabled:opacity-60"
              >
                {i18n.t('sidebar.confirmDelete')}
              </button>
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}
