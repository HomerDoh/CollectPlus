import { useEffect, useMemo, useState } from 'react';
import {
  Check,
  Folder,
  FolderPlus,
  Loader2,
  Plus,
  X,
} from 'lucide-react';
import { i18n } from '#i18n';
import {
  getItemFolderIds,
  type CollectionItemRecord,
  type FolderNode,
} from '@/types/schema.ts';

export interface FolderAssignModalProps {
  selectedItems: readonly CollectionItemRecord[];
  folders: readonly FolderNode[];
  onClose: () => void;
  onCreateFolder: (name: string, parentId: string | null) => Promise<FolderNode>;
  onConfirm: (folderIds: string[]) => Promise<void>;
}

interface FlatFolderRow {
  folder: FolderNode;
  depth: number;
}

function flattenFoldersWithDepth(folders: readonly FolderNode[]): FlatFolderRow[] {
  const sorted = [...folders].sort(
    (a, b) => a.sortOrder - b.sortOrder || a.createdAt - b.createdAt,
  );
  const idSet = new Set(sorted.map((f) => f.id));
  const childrenByParent = new Map<string | null, FolderNode[]>();

  for (const folder of sorted) {
    const parentKey =
      folder.parentId !== null && idSet.has(folder.parentId)
        ? folder.parentId
        : null;
    const list = childrenByParent.get(parentKey);
    if (list) {
      list.push(folder);
    } else {
      childrenByParent.set(parentKey, [folder]);
    }
  }

  const rows: FlatFolderRow[] = [];
  const visit = (parentId: string | null, depth: number) => {
    const list = childrenByParent.get(parentId);
    if (!list) {
      return;
    }
    for (const folder of list) {
      rows.push({ folder, depth });
      visit(folder.id, depth + 1);
    }
  };
  visit(null, 0);
  return rows;
}

export function FolderAssignModal({
  selectedItems,
  folders,
  onClose,
  onCreateFolder,
  onConfirm,
}: FolderAssignModalProps) {
  const [pickedFolderIds, setPickedFolderIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [newFolderName, setNewFolderName] = useState('');
  const [creating, setCreating] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !submitting) {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose, submitting]);

  const folderRows = useMemo(() => flattenFoldersWithDepth(folders), [folders]);

  const membershipCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of selectedItems) {
      for (const fid of getItemFolderIds(item)) {
        counts.set(fid, (counts.get(fid) ?? 0) + 1);
      }
    }
    return counts;
  }, [selectedItems]);

  const toggleFolder = (folderId: string) => {
    setPickedFolderIds((prev) => {
      const next = new Set(prev);
      if (next.has(folderId)) {
        next.delete(folderId);
      } else {
        next.add(folderId);
      }
      return next;
    });
  };

  const handleQuickCreate = async () => {
    const trimmed = newFolderName.trim();
    if (!trimmed || creating || submitting) {
      return;
    }
    setCreating(true);
    try {
      const created = await onCreateFolder(trimmed, null);
      setNewFolderName('');
      setPickedFolderIds((prev) => new Set(prev).add(created.id));
    } finally {
      setCreating(false);
    }
  };

  const handleSubmit = async () => {
    if (pickedFolderIds.size === 0 || submitting) {
      return;
    }
    setSubmitting(true);
    try {
      await onConfirm(Array.from(pickedFolderIds));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/55 p-4 backdrop-blur-[1px]"
      onClick={() => !submitting && onClose()}
      role="dialog"
      aria-modal="true"
      aria-labelledby="folder-assign-modal-title"
      data-testid="folder-assign-modal"
    >
      <div
        className="flex max-h-[82vh] w-full max-w-md flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 头部 */}
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3.5">
          <div className="flex items-center gap-2">
            <span className="inline-flex h-8 w-8 items-center justify-center rounded-xl bg-indigo-50 text-indigo-600">
              <FolderPlus className="h-4 w-4" />
            </span>
            <div>
              <h3
                id="folder-assign-modal-title"
                className="text-sm font-semibold text-slate-900"
              >
                {i18n.t('folderModal.title')}
              </h3>
              <p className="text-[11px] text-slate-500">
                {i18n.t('folderModal.subtitle', { count: selectedItems.length })}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            aria-label={i18n.t('folderModal.closeAria')}
            className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* 快速新建文件夹 */}
        <div className="border-b border-slate-100 bg-slate-50/70 px-5 py-3">
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void handleQuickCreate();
                }
              }}
              placeholder={i18n.t('folderModal.quickCreatePlaceholder')}
              disabled={creating || submitting}
              className="min-w-0 flex-1 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-900 placeholder:text-slate-400 focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 focus:outline-none"
            />
            <button
              type="button"
              onClick={() => void handleQuickCreate()}
              disabled={!newFolderName.trim() || creating || submitting}
              className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 transition hover:border-indigo-300 hover:bg-indigo-50 hover:text-indigo-700 disabled:opacity-45"
            >
              {creating ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Plus className="h-3.5 w-3.5" />
              )}
              <span>{i18n.t('common.create')}</span>
            </button>
          </div>
        </div>

        {/* 文件夹多选列表 */}
        <div className="flex-1 overflow-y-auto px-3 py-2.5">
          {folderRows.length === 0 ? (
            <div className="py-8 text-center text-xs text-slate-400">
              {i18n.t('folderModal.emptyHint')}
            </div>
          ) : (
            <div className="flex flex-col gap-0.5">
              {folderRows.map(({ folder, depth }) => {
                const checked = pickedFolderIds.has(folder.id);
                const existingCount = membershipCounts.get(folder.id) ?? 0;

                return (
                  <label
                    key={folder.id}
                    className={`flex cursor-pointer items-center justify-between gap-2 rounded-xl px-3 py-2 text-xs transition ${
                      checked
                        ? 'bg-indigo-50 text-indigo-800'
                        : 'text-slate-700 hover:bg-slate-50'
                    }`}
                    style={{ paddingLeft: `${12 + depth * 18}px` }}
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={submitting}
                        onChange={() => toggleFolder(folder.id)}
                        className="h-4 w-4 shrink-0 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                      />
                      <Folder
                        className={`h-3.5 w-3.5 shrink-0 ${
                          checked ? 'text-indigo-600' : 'text-amber-500'
                        }`}
                      />
                      <span className="truncate font-medium">{folder.name}</span>
                    </span>

                    {existingCount > 0 && (
                      <span className="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium tabular-nums text-slate-500">
                        {existingCount === selectedItems.length
                          ? i18n.t('folderModal.allAlreadyIn')
                          : i18n.t('folderModal.partialAlreadyIn', {
                              existing: existingCount,
                              total: selectedItems.length,
                            })}
                      </span>
                    )}
                  </label>
                );
              })}
            </div>
          )}
        </div>

        {/* 底部操作栏 */}
        <div className="flex items-center justify-between gap-2 border-t border-slate-200 bg-slate-50/70 px-5 py-3">
          <span className="text-[11px] text-slate-500">
            {i18n.t('folderModal.selectedPrefix')}{' '}
            <strong className="font-semibold text-indigo-700">
              {pickedFolderIds.size}
            </strong>{' '}
            {i18n.t('folderModal.selectedSuffix')}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 transition hover:bg-slate-50"
            >
              {i18n.t('common.cancel')}
            </button>
            <button
              type="button"
              onClick={() => void handleSubmit()}
              disabled={pickedFolderIds.size === 0 || submitting}
              data-testid="folder-assign-submit"
              className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3.5 py-1.5 text-xs font-semibold text-white shadow-xs transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-400"
            >
              {submitting ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Check className="h-3.5 w-3.5" />
              )}
              <span>{i18n.t('folderModal.confirmAdd')}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
