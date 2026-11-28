import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  Calendar,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock,
  CloudOff,
  ExternalLink,
  FileText,
  Film,
  Folder,
  FolderKey,
  HardDrive,
  Images,
  Loader2,
  Maximize2,
  MessageSquare,
  Plus,
  RotateCcw,
  Save,
  Tag,
  Trash2,
  User,
  X,
} from 'lucide-react';
import { i18n } from '@/i18n/index.ts';
import {
  readItemAssetFile,
  resolveItemPlayableMedia,
  type VaultPermissionStatus,
  type VaultStorageBackend,
} from '@/storage/vault.ts';
import {
  getItemFolderIds,
  isAutoSyncExcluded,
  normalizeFolderIds,
  type CollectionItemRecord,
  type FolderNode,
  type MediaAsset,
  type TagMeta,
} from '@/types/schema.ts';
import {
  autoSyncExclusionMeta,
  formatBytes,
  formatDateTime,
  formatDuration,
  getErrorMessage,
  platformMeta,
  syncStatusMeta,
} from '../utils/format.ts';
import { ItemCommentsPanel } from './ItemCommentsPanel.tsx';

export interface ItemEditPatch {
  title: string;
  folderIds: string[];
  tags: string[];
  note: string;
}

export interface SaveItemResult {
  syncedToVault: boolean;
  message: string;
}

export interface ItemDetailDrawerProps {
  item: CollectionItemRecord;
  folders: readonly FolderNode[];
  tags: readonly TagMeta[];
  vaultBackend: VaultStorageBackend | null;
  permissionState: VaultPermissionStatus;
  disableEscapeClose?: boolean;
  onClose: () => void;
  onRequestVaultAccess: () => Promise<boolean>;
  onSaveItem: (
    itemId: string,
    patch: ItemEditPatch,
  ) => Promise<SaveItemResult>;
  onRequestDeleteItem: (
    item: CollectionItemRecord,
    mode: 'soft' | 'permanent',
  ) => void;
  onRestoreItem: (item: CollectionItemRecord) => Promise<void>;
  onAllowAutoSyncAgain: (items: CollectionItemRecord[]) => Promise<void>;
  onRemoteUncollectAndClear: (items: CollectionItemRecord[]) => Promise<void>;
  onCancelItemSync: (item: CollectionItemRecord) => Promise<void>;
}

interface LoadedSlide {
  asset: MediaAsset;
  url: string;
  sizeBytes: number;
}

interface LoadedVideo {
  asset: MediaAsset;
  url: string;
  sizeBytes: number;
}

interface FlatFolderOption {
  id: string;
  label: string;
}

function flattenFolderOptions(folders: readonly FolderNode[]): FlatFolderOption[] {
  const sorted = [...folders].sort(
    (a, b) => a.sortOrder - b.sortOrder || a.createdAt - b.createdAt,
  );
  const childrenByParent = new Map<string | null, FolderNode[]>();
  const idSet = new Set(sorted.map((f) => f.id));

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

  const options: FlatFolderOption[] = [];
  const visit = (parentId: string | null, depth: number) => {
    const list = childrenByParent.get(parentId);
    if (!list) {
      return;
    }
    for (const folder of list) {
      const prefix = depth > 0 ? `${'　'.repeat(depth - 1)}└─ ` : '';
      options.push({
        id: folder.id,
        label: `${prefix}${folder.name}`,
      });
      visit(folder.id, depth + 1);
    }
  };

  visit(null, 0);
  return options;
}

function areTagListsEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

function areStringSetsEqual(
  a: readonly string[],
  b: readonly string[],
): boolean {
  if (a.length !== b.length) {
    return false;
  }
  const setB = new Set(b);
  for (const val of a) {
    if (!setB.has(val)) {
      return false;
    }
  }
  return true;
}

export function ItemDetailDrawer({
  item,
  folders,
  tags,
  vaultBackend,
  permissionState,
  disableEscapeClose = false,
  onClose,
  onRequestVaultAccess,
  onSaveItem,
  onRequestDeleteItem,
  onRestoreItem,
  onAllowAutoSyncAgain,
  onRemoteUncollectAndClear,
  onCancelItemSync,
}: ItemDetailDrawerProps) {
  // 离线媒体加载状态
  const [mediaLoading, setMediaLoading] = useState(true);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const [needsVaultAuth, setNeedsVaultAuth] = useState(false);
  const [loadedVideo, setLoadedVideo] = useState<LoadedVideo | null>(null);
  const [coverUrl, setCoverUrl] = useState<string | undefined>(undefined);
  const [loadedSlides, setLoadedSlides] = useState<LoadedSlide[]>([]);
  const [activeSlideIndex, setActiveSlideIndex] = useState(0);
  const [reloadTick, setReloadTick] = useState(0);
  const [authorizing, setAuthorizing] = useState(false);
  const [activeRightTab, setActiveRightTab] = useState<'details' | 'comments'>(
    'details',
  );

  // 元数据编辑表单状态
  const itemFolderIds = useMemo(() => getItemFolderIds(item), [item]);
  const [draftTitle, setDraftTitle] = useState(item.title);
  const [draftFolderIds, setDraftFolderIds] = useState<string[]>(itemFolderIds);
  const [draftTags, setDraftTags] = useState<string[]>(item.tags);
  const [draftNote, setDraftNote] = useState(item.note);
  const [tagInput, setTagInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [saveFeedback, setSaveFeedback] = useState<{
    type: 'success' | 'error';
    text: string;
  } | null>(null);

  // 切换条目或条目外部刷新时同步表单状态
  useEffect(() => {
    setDraftTitle(item.title);
    setDraftFolderIds(itemFolderIds);
    setDraftTags(item.tags);
    setDraftNote(item.note);
    setTagInput('');
  }, [item.id, item.updatedAt, item.title, itemFolderIds, item.tags, item.note]);

  // 仅在切换不同条目时重置图集页码、右侧标签页与保存反馈提示，避免保存后 liveQuery 刷新把成功提示瞬间擦除
  useEffect(() => {
    setActiveSlideIndex(0);
    setSaveFeedback(null);
    setActiveRightTab('details');
  }, [item.id]);

  // 仅在媒体来源或授权状态真正变化时重新加载，避免编辑标题/标签/备注时打断播放
  const itemRef = useRef(item);
  itemRef.current = item;

  const mediaLoadKey = useMemo(() => {
    const assetSig = item.assets
      .map((a) => `${a.id}:${a.relativePath}:${a.downloaded ? '1' : '0'}`)
      .join(',');
    const availabilityPhase =
      item.syncStatus === 'pending_download' || item.syncStatus === 'failed'
        ? item.syncStatus
        : 'ready';
    const excludedFlag = isAutoSyncExcluded(item) ? 'excluded' : 'normal';
    return `${item.id}|${item.kind}|${item.relativeDir}|${item.coverRelativePath ?? ''}|${assetSig}|${availabilityPhase}|${excludedFlag}`;
  }, [
    item.id,
    item.kind,
    item.relativeDir,
    item.coverRelativePath,
    item.assets,
    item.syncStatus,
    item.autoSyncExclusion,
  ]);

  // 离线/云端媒体读取与严格的资源生命周期管理（Object URL + 远端流式 DNR 规则）
  useEffect(() => {
    let cancelled = false;
    const createdUrls: string[] = [];
    const cleanupFns: Array<() => Promise<void> | void> = [];
    const currentItem = itemRef.current;

    if (isAutoSyncExcluded(currentItem)) {
      setMediaLoading(false);
      setMediaError(null);
      setNeedsVaultAuth(false);
      setLoadedVideo(null);
      setCoverUrl(undefined);
      setLoadedSlides([]);
      return;
    }

    const createTrackedUrl = (file: File): string => {
      const url = URL.createObjectURL(file);
      createdUrls.push(url);
      return url;
    };

    const loadMedia = async () => {
      setMediaLoading(true);
      setMediaError(null);
      setNeedsVaultAuth(false);
      setLoadedVideo(null);
      setCoverUrl(undefined);
      setLoadedSlides([]);

      try {
        const coverAsset = currentItem.assets.find((a) => a.kind === 'cover');
        const coverPath =
          coverAsset?.relativePath ?? currentItem.coverRelativePath;

        if (currentItem.kind === 'video') {
          const videoAsset = currentItem.assets.find((a) => a.kind === 'video');
          const [playableVideo, coverFile] = await Promise.all([
            videoAsset
              ? resolveItemPlayableMedia(
                  currentItem,
                  videoAsset.relativePath,
                  vaultBackend,
                )
              : Promise.resolve(null),
            coverPath
              ? readItemAssetFile(currentItem, coverPath, vaultBackend)
              : Promise.resolve(null),
          ]);

          if (cancelled) {
            if (playableVideo?.dispose) {
              void Promise.resolve(playableVideo.dispose()).catch(() => undefined);
            }
            return;
          }

          if (playableVideo?.dispose) {
            cleanupFns.push(playableVideo.dispose);
          }

          if (coverFile) {
            setCoverUrl(createTrackedUrl(coverFile));
          }

          if (videoAsset && playableVideo) {
            setLoadedVideo({
              asset: videoAsset,
              url: playableVideo.url,
              sizeBytes: videoAsset.sizeBytes ?? playableVideo.sizeBytes ?? 0,
            });
          } else {
            const authBlocked =
              permissionState !== 'granted' &&
              (vaultBackend !== null ||
                currentItem.syncStatus === 'vault_synced');
            setNeedsVaultAuth(authBlocked);
            if (!authBlocked) {
              setMediaError(
                currentItem.syncStatus === 'pending_download'
                  ? i18n.t('detail.videoDownloadingError')
                  : currentItem.syncStatus === 'failed'
                    ? i18n.t('detail.videoFailedError')
                    : i18n.t('detail.videoNotFoundError'),
              );
            }
          }
        } else {
          // 图集或单图模式
          const imageAssets = currentItem.assets.filter(
            (a) => a.kind === 'image',
          );
          const targetAssets =
            imageAssets.length > 0
              ? imageAssets
              : coverAsset
                ? [coverAsset]
                : [];

          const files = await Promise.all(
            targetAssets.map((asset) =>
              readItemAssetFile(currentItem, asset.relativePath, vaultBackend),
            ),
          );

          if (cancelled) {
            return;
          }

          const slides: LoadedSlide[] = [];
          for (let i = 0; i < targetAssets.length; i += 1) {
            const asset = targetAssets[i];
            const file = files[i];
            if (asset && file) {
              slides.push({
                asset,
                url: createTrackedUrl(file),
                sizeBytes: asset.sizeBytes ?? file.size,
              });
            }
          }

          if (slides.length > 0) {
            setLoadedSlides(slides);
            setActiveSlideIndex((prev) =>
              prev >= slides.length ? 0 : prev,
            );
          } else if (currentItem.kind !== 'article') {
            const authBlocked =
              permissionState !== 'granted' &&
              (vaultBackend !== null ||
                currentItem.syncStatus === 'vault_synced');
            setNeedsVaultAuth(authBlocked);
            if (!authBlocked) {
              setMediaError(
                currentItem.syncStatus === 'pending_download'
                  ? i18n.t('detail.galleryDownloadingError')
                  : currentItem.syncStatus === 'failed'
                    ? i18n.t('detail.galleryFailedError')
                    : i18n.t('detail.imageNotFoundError'),
              );
            }
          }
        }
      } catch (error) {
        if (!cancelled) {
          setMediaError(
            i18n.t('detail.readMediaFailed', { error: getErrorMessage(error) }),
          );
        }
      } finally {
        if (!cancelled) {
          setMediaLoading(false);
        }
      }
    };

    void loadMedia();

    return () => {
      cancelled = true;
      for (const url of createdUrls) {
        URL.revokeObjectURL(url);
      }
      for (const cleanup of cleanupFns) {
        void Promise.resolve(cleanup()).catch(() => undefined);
      }
    };
  }, [mediaLoadKey, vaultBackend, permissionState, reloadTick]);

  // 键盘快捷键：Esc 关闭，图集模式下 ArrowLeft / ArrowRight 翻页
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (disableEscapeClose) {
          return;
        }
        event.preventDefault();
        onClose();
        return;
      }

      if (loadedSlides.length <= 1) {
        return;
      }

      const activeTag = document.activeElement?.tagName;
      if (
        activeTag === 'INPUT' ||
        activeTag === 'TEXTAREA' ||
        activeTag === 'SELECT'
      ) {
        return;
      }

      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        setActiveSlideIndex((prev) =>
          prev === 0 ? loadedSlides.length - 1 : prev - 1,
        );
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        setActiveSlideIndex((prev) =>
          prev === loadedSlides.length - 1 ? 0 : prev + 1,
        );
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose, loadedSlides.length, disableEscapeClose]);

  const folderOptions = useMemo(() => flattenFolderOptions(folders), [folders]);
  const foldersById = useMemo(() => {
    const map = new Map<string, FolderNode>();
    for (const f of folders) {
      map.set(f.id, f);
    }
    return map;
  }, [folders]);
  const tagsByName = useMemo(() => {
    const map = new Map<string, TagMeta>();
    for (const tag of tags) {
      map.set(tag.name, tag);
    }
    return map;
  }, [tags]);

  const suggestedTags = useMemo(() => {
    const selectedSet = new Set(draftTags);
    return tags.filter((tag) => !selectedSet.has(tag.name)).slice(0, 12);
  }, [tags, draftTags]);

  const isDirty = useMemo(() => {
    return (
      draftTitle.trim() !== item.title ||
      !areStringSetsEqual(normalizeFolderIds(draftFolderIds), itemFolderIds) ||
      draftNote !== item.note ||
      !areTagListsEqual(draftTags, item.tags)
    );
  }, [draftTitle, draftFolderIds, itemFolderIds, draftNote, draftTags, item]);

  const handleToggleFolder = useCallback((folderId: string) => {
    setDraftFolderIds((prev) =>
      prev.includes(folderId)
        ? prev.filter((id) => id !== folderId)
        : [...prev, folderId],
    );
    setSaveFeedback(null);
  }, []);

  const handleAddTag = useCallback(
    (rawValue: string) => {
      const cleaned = rawValue.trim().replace(/^#+/, '').trim();
      if (!cleaned) {
        return;
      }
      setDraftTags((prev) =>
        prev.includes(cleaned) ? prev : [...prev, cleaned],
      );
      setTagInput('');
      setSaveFeedback(null);
    },
    [],
  );

  const handleRemoveTag = useCallback((tagName: string) => {
    setDraftTags((prev) => prev.filter((t) => t !== tagName));
    setSaveFeedback(null);
  }, []);

  const handleSave = async () => {
    if (saving) {
      return;
    }
    setSaving(true);
    setSaveFeedback(null);
    try {
      const result = await onSaveItem(item.id, {
        title: draftTitle.trim() || item.title,
        folderIds: normalizeFolderIds(draftFolderIds),
        tags: draftTags,
        note: draftNote,
      });
      setSaveFeedback({
        type: 'success',
        text: result.message,
      });
    } catch (error) {
      setSaveFeedback({
        type: 'error',
        text: i18n.t('detail.saveFailed', { error: getErrorMessage(error) }),
      });
    } finally {
      setSaving(false);
    }
  };

  const handleAuthorizeAndReload = async () => {
    setAuthorizing(true);
    try {
      const granted = await onRequestVaultAccess();
      if (granted) {
        setReloadTick((prev) => prev + 1);
      }
    } finally {
      setAuthorizing(false);
    }
  };

  const currentSlide = loadedSlides[activeSlideIndex];
  const platformInfo = platformMeta(item.platform, item.platformExtra);
  const syncInfo = syncStatusMeta(item.syncStatus);
  const exclusion = item.autoSyncExclusion ?? null;
  const isExcluded = exclusion !== null;
  const exclusionInfo = exclusion
    ? autoSyncExclusionMeta(exclusion.reason)
    : null;
  const isDeleted = item.deletedAt != null;
  const showCommentsTab =
    !isExcluded &&
    (item.kind === 'video' ||
      Boolean(item.commentsRelativePath) ||
      (item.savedCommentCount ?? 0) > 0);

  const runFooterAction = async (fn: () => Promise<void>) => {
    if (actionBusy) {
      return;
    }
    setActionBusy(true);
    try {
      await fn();
    } finally {
      setActionBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-[var(--cp-scrim)] p-4 md:p-6"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={item.title}
    >
      <div
        data-testid="item-detail-dialog"
        data-platform={item.platform}
        className="flex h-[88vh] w-full max-w-5xl flex-col overflow-hidden rounded-[var(--pd-radius-dialog)] border border-[var(--pd-border)] bg-[var(--pd-surface)] text-[var(--pd-text)] shadow-[var(--pd-dialog-shadow)]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 顶部来源平台品牌识别色带 */}
        <div
          aria-hidden="true"
          className="pd-brand-bar h-[3px] w-full shrink-0"
        />

        <div className="flex min-h-0 flex-1 flex-col overflow-hidden lg:flex-row">
        {/* 左侧：100% 离线媒体播放 / 图集画廊（按来源网站原生明暗配色渲染） */}
        <section className="flex min-h-[320px] flex-col bg-[var(--pd-stage)] text-[var(--pd-stage-text)] lg:w-[58%]">
          {/* 顶部媒体状态栏 */}
          <div className="flex items-center justify-between gap-2 border-b border-[var(--pd-stage-border)] bg-[var(--pd-stage-bar)] px-4 py-2.5">
            <div className="flex items-center gap-2 text-xs">
              <span className="rounded-[var(--pd-radius-pill)] bg-[var(--pd-badge-bg)] px-2.5 py-0.5 text-[10px] font-semibold text-[var(--pd-badge-text)]">
                {platformInfo.label}
              </span>
              <span className="inline-flex items-center gap-1 text-[var(--pd-stage-muted)]">
                {isExcluded ? (
                  <>
                    <CloudOff className="h-3.5 w-3.5 text-amber-500" />
                    <span>{i18n.t('detail.modeExcluded')}</span>
                  </>
                ) : item.kind === 'video' ? (
                  <>
                    <Film className="h-3.5 w-3.5 text-[var(--pd-accent)]" />
                    <span>{i18n.t('detail.modeVideo')}</span>
                  </>
                ) : item.kind === 'article' ? (
                  <>
                    <FileText className="h-3.5 w-3.5 text-[var(--pd-accent)]" />
                    <span>{i18n.t('detail.modeArticle')}</span>
                  </>
                ) : (
                  <>
                    <Images className="h-3.5 w-3.5 text-[var(--pd-accent)]" />
                    <span>
                      {i18n.t('detail.modeGallery')}
                      {loadedSlides.length > 0
                        ? ` (${activeSlideIndex + 1} / ${loadedSlides.length})`
                        : ''}
                    </span>
                  </>
                )}
              </span>
            </div>

            {currentSlide && (
              <a
                href={currentSlide.url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 rounded border border-[var(--pd-stage-border)] bg-[var(--pd-surface-muted)] px-2.5 py-1 text-[11px] font-medium text-[var(--pd-text)] transition hover:border-[var(--pd-accent)]"
              >
                <Maximize2 className="h-3 w-3" />
                <span>{i18n.t('detail.openOriginalImage')}</span>
              </a>
            )}
          </div>

          {/* 主媒体画布 */}
          <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden p-3">
            {isExcluded && exclusion && exclusionInfo ? (
              <div
                data-testid="excluded-detail-panel"
                className="flex max-w-md flex-col items-center gap-3.5 rounded-md border border-[var(--pd-stage-border)] bg-[var(--pd-surface)] px-6 py-7 text-center text-[var(--pd-text)]"
              >
                {item.thumbnailDataUrl ? (
                  <img
                    src={item.thumbnailDataUrl}
                    alt={item.title}
                    className="max-h-36 w-full rounded object-cover opacity-90 ring-1 ring-[var(--pd-border)]"
                  />
                ) : (
                  <span className="inline-flex h-12 w-12 items-center justify-center rounded bg-amber-500/15 text-amber-500">
                    <CloudOff className="h-6 w-6" />
                  </span>
                )}
                <h4 className="text-sm font-semibold text-[var(--pd-text)]">
                  {i18n.t('detail.excludedTitle')}
                </h4>
                <span
                  className={`inline-flex items-center gap-1.5 rounded px-3 py-1 text-xs font-medium ${exclusionInfo.badgeClass}`}
                >
                  <span
                    className={`h-1.5 w-1.5 rounded-full ${exclusionInfo.dotClass}`}
                  />
                  <span>{exclusionInfo.label}</span>
                </span>
                {exclusion.detail && (
                  <p className="w-full rounded border border-[var(--pd-border)] bg-[var(--pd-surface-muted)] px-3 py-2 text-xs leading-relaxed text-[var(--pd-text-secondary)]">
                    {exclusion.detail}
                  </p>
                )}
                <p className="text-[11px] text-[var(--pd-text-muted)]">
                  {i18n.t('detail.excludedAtLabel', {
                    time: formatDateTime(exclusion.excludedAt),
                  })}
                </p>
                <p className="text-xs leading-relaxed text-[var(--pd-text-secondary)]">
                  {i18n.t('detail.excludedDesc')}
                </p>
                <a
                  href={item.sourceUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-1 inline-flex items-center gap-1.5 rounded bg-[var(--pd-accent)] px-4 py-2 text-xs font-semibold text-[var(--pd-on-accent)] transition hover:bg-[var(--pd-accent-hover)]"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                  <span>{i18n.t('detail.openSourcePage')}</span>
                </a>
              </div>
            ) : mediaLoading ? (
              <div className="flex flex-col items-center gap-2.5 text-xs text-[var(--pd-stage-muted)]">
                <Loader2 className="h-7 w-7 animate-spin text-[var(--pd-accent)]" />
                <span>{i18n.t('detail.loadingLocalMedia')}</span>
              </div>
            ) : needsVaultAuth ? (
              <div className="flex max-w-sm flex-col items-center gap-3 rounded-md border border-[var(--pd-stage-border)] bg-[var(--pd-surface)] px-6 py-7 text-center text-[var(--pd-text)]">
                <span className="inline-flex h-12 w-12 items-center justify-center rounded bg-[var(--pd-accent-soft)] text-[var(--pd-accent)]">
                  <FolderKey className="h-6 w-6" />
                </span>
                <h4 className="text-sm font-semibold text-[var(--pd-text)]">
                  {i18n.t('detail.vaultAuthTitle')}
                </h4>
                <p className="text-xs leading-relaxed text-[var(--pd-text-secondary)]">
                  {vaultBackend
                    ? i18n.t('detail.vaultAuthDescNamed', {
                        name: vaultBackend.displayName,
                      })
                    : i18n.t('detail.vaultAuthDesc')}
                </p>
                <button
                  type="button"
                  onClick={() => void handleAuthorizeAndReload()}
                  disabled={authorizing}
                  className="mt-1 inline-flex items-center gap-1.5 rounded bg-[var(--pd-accent)] px-4 py-2 text-xs font-semibold text-[var(--pd-on-accent)] transition hover:bg-[var(--pd-accent-hover)] disabled:opacity-60"
                >
                  {authorizing ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <FolderKey className="h-4 w-4" />
                  )}
                  <span>{i18n.t('detail.vaultAuthBtn')}</span>
                </button>
              </div>
            ) : mediaError ? (
              <div className="flex max-w-sm flex-col items-center gap-2.5 rounded-md border border-rose-500/30 bg-rose-950/30 px-6 py-6 text-center">
                <AlertCircle className="h-8 w-8 text-rose-400" />
                <p className="text-xs leading-relaxed text-rose-100">
                  {mediaError}
                </p>
                <button
                  type="button"
                  onClick={() => setReloadTick((prev) => prev + 1)}
                  className="mt-1 inline-flex items-center gap-1 rounded bg-white/10 px-3 py-1.5 text-xs font-medium text-white hover:bg-white/20"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  <span>{i18n.t('detail.reloadMedia')}</span>
                </button>
              </div>
            ) : item.kind === 'video' && loadedVideo ? (
              <video
                key={loadedVideo.url}
                src={loadedVideo.url}
                poster={coverUrl ?? item.thumbnailDataUrl}
                controls
                playsInline
                className="max-h-full max-w-full rounded bg-black"
              />
            ) : item.kind === 'article' ? (
              <article className="flex h-full w-full flex-col overflow-y-auto rounded border border-[var(--pd-border)] bg-[var(--pd-article-bg)] p-6 text-[var(--pd-article-text)]">
                {(currentSlide?.url ?? item.thumbnailDataUrl) && (
                  <img
                    src={currentSlide?.url ?? item.thumbnailDataUrl}
                    alt={item.title}
                    className="mb-4 max-h-56 w-full rounded object-cover"
                  />
                )}
                <h3 className="text-lg font-bold leading-snug text-[var(--pd-article-text)]">
                  {item.title}
                </h3>
                <p className="mt-1.5 text-xs text-[var(--pd-article-muted)]">
                  {i18n.t('detail.articleMetaAuthor', {
                    author: item.author.name,
                  })}
                  {item.publishedAt
                    ? i18n.t('detail.articleMetaPublishedPart', {
                        time: formatDateTime(item.publishedAt),
                      })
                    : ''}
                </p>
                <div className="mt-4 border-t border-[var(--pd-divider)] pt-4 text-sm leading-relaxed whitespace-pre-wrap text-[var(--pd-article-text)]">
                  {item.description.trim()
                    ? item.description
                    : i18n.t('detail.articleEmptyBody')}
                </div>
              </article>
            ) : currentSlide ? (
              <div className="relative flex h-full w-full items-center justify-center">
                <img
                  key={currentSlide.url}
                  src={currentSlide.url}
                  alt={i18n.t('detail.slideAlt', {
                    title: item.title,
                    index: activeSlideIndex + 1,
                  })}
                  className="max-h-full max-w-full rounded object-contain select-none"
                />

                {loadedSlides.length > 1 && (
                  <>
                    <button
                      type="button"
                      onClick={() =>
                        setActiveSlideIndex((prev) =>
                          prev === 0 ? loadedSlides.length - 1 : prev - 1,
                        )
                      }
                      aria-label={i18n.t('detail.prevSlideAria')}
                      className="absolute left-2 inline-flex h-9 w-9 items-center justify-center rounded-full bg-[var(--pd-media-control-bg)] text-[var(--pd-media-control-text)] transition hover:bg-[var(--pd-media-control-hover)]"
                    >
                      <ChevronLeft className="h-5 w-5" />
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        setActiveSlideIndex((prev) =>
                          prev === loadedSlides.length - 1 ? 0 : prev + 1,
                        )
                      }
                      aria-label={i18n.t('detail.nextSlideAria')}
                      className="absolute right-2 inline-flex h-9 w-9 items-center justify-center rounded-full bg-[var(--pd-media-control-bg)] text-[var(--pd-media-control-text)] transition hover:bg-[var(--pd-media-control-hover)]"
                    >
                      <ChevronRight className="h-5 w-5" />
                    </button>
                    <span className="absolute bottom-2 left-1/2 -translate-x-1/2 rounded-[var(--pd-radius-pill)] bg-[var(--pd-media-control-bg)] px-3 py-1 text-xs font-medium tabular-nums text-[var(--pd-media-control-text)]">
                      {activeSlideIndex + 1} / {loadedSlides.length}
                    </span>
                  </>
                )}
              </div>
            ) : null}
          </div>

          {/* 图集底部缩略图条 */}
          {loadedSlides.length > 1 && (
            <div className="flex items-center gap-2 overflow-x-auto border-t border-[var(--pd-stage-border)] bg-[var(--pd-stage-bar)] px-4 py-2.5">
              {loadedSlides.map((slide, index) => {
                const isActive = index === activeSlideIndex;
                return (
                  <button
                    key={slide.asset.id}
                    type="button"
                    onClick={() => setActiveSlideIndex(index)}
                    className={`relative h-12 w-12 shrink-0 overflow-hidden rounded border-2 transition ${
                      isActive
                        ? 'border-[var(--pd-accent)]'
                        : 'border-transparent opacity-60 hover:opacity-100'
                    }`}
                  >
                    <img
                      src={slide.url}
                      alt={i18n.t('detail.thumbnailAlt', { index: index + 1 })}
                      className="h-full w-full object-cover"
                    />
                  </button>
                );
              })}
            </div>
          )}

          {/* 媒体技术参数与落盘相对路径 */}
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t border-[var(--pd-stage-border)] bg-[var(--pd-stage-bar)] px-4 py-2 text-[11px] text-[var(--pd-stage-muted)]">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
              {loadedVideo && (
                <>
                  {loadedVideo.asset.width && loadedVideo.asset.height && (
                    <span className="tabular-nums">
                      {loadedVideo.asset.width} × {loadedVideo.asset.height}
                    </span>
                  )}
                  {loadedVideo.asset.durationSec !== undefined && (
                    <span className="tabular-nums">
                      {formatDuration(loadedVideo.asset.durationSec)}
                    </span>
                  )}
                  <span className="tabular-nums">
                    {formatBytes(loadedVideo.sizeBytes)}
                  </span>
                </>
              )}
              {currentSlide && (
                <>
                  {currentSlide.asset.width && currentSlide.asset.height && (
                    <span className="tabular-nums">
                      {currentSlide.asset.width} × {currentSlide.asset.height}
                    </span>
                  )}
                  <span className="tabular-nums">
                    {formatBytes(currentSlide.sizeBytes)}
                  </span>
                </>
              )}
              {!loadedVideo && !currentSlide && (
                <span className="tabular-nums">
                  {i18n.t('detail.totalSizeLabel', {
                    size: formatBytes(item.totalSizeBytes),
                  })}
                </span>
              )}
            </div>

            <code
              className="max-w-full truncate text-[10px] text-[var(--pd-stage-muted)]"
              title={
                loadedVideo
                  ? `${item.relativeDir}/${loadedVideo.asset.relativePath}`
                  : currentSlide
                    ? `${item.relativeDir}/${currentSlide.asset.relativePath}`
                    : item.relativeDir
              }
            >
              {loadedVideo
                ? `${item.relativeDir}/${loadedVideo.asset.relativePath}`
                : currentSlide
                  ? `${item.relativeDir}/${currentSlide.asset.relativePath}`
                  : item.relativeDir}
            </code>
          </div>
        </section>

        {/* 右侧：元数据编辑与详情面板（继承来源网站明暗配色） */}
        <section className="flex min-h-0 flex-1 flex-col border-t border-[var(--pd-border)] bg-[var(--pd-surface)] lg:w-[42%] lg:border-t-0 lg:border-l">
          {/* 头部栏 */}
          <header className="flex items-center justify-between gap-2 border-b border-[var(--pd-divider)] px-5 py-3.5">
            <div className="flex items-center gap-2">
              {exclusionInfo ? (
                <span
                  className={`inline-flex items-center gap-1 rounded px-2.5 py-0.5 text-[11px] font-medium ${exclusionInfo.badgeClass}`}
                >
                  <span
                    className={`h-1.5 w-1.5 rounded-full ${exclusionInfo.dotClass}`}
                  />
                  <span>{i18n.t('sidebar.navExcluded')}</span>
                </span>
              ) : (
                <span
                  className={`inline-flex items-center gap-1 rounded px-2.5 py-0.5 text-[11px] font-medium ${syncInfo.badgeClass}`}
                >
                  <span
                    className={`h-1.5 w-1.5 rounded-full ${syncInfo.dotClass}`}
                  />
                  <span>{syncInfo.label}</span>
                </span>
              )}
              {isDeleted && (
                <span className="rounded bg-rose-100 px-2 py-0.5 text-[11px] font-medium text-rose-700 dark:bg-rose-950/70 dark:text-rose-300">
                  {i18n.t('detail.inTrashBadge')}
                </span>
              )}
            </div>

            <button
              type="button"
              onClick={onClose}
              aria-label={i18n.t('detail.closeDetailAria')}
              className="inline-flex h-8 w-8 items-center justify-center rounded text-[var(--pd-text-muted)] transition hover:bg-[var(--pd-surface-muted)] hover:text-[var(--pd-text)]"
            >
              <X className="h-4 w-4" />
            </button>
          </header>

          {/* 详情 / 评论切换标签栏 */}
          {showCommentsTab && (
            <div
              role="tablist"
              aria-label={i18n.t('detail.tabsAria')}
              className="flex items-center gap-1 border-b border-[var(--pd-divider)] bg-[var(--pd-surface-muted)] px-5 py-2"
            >
              <button
                type="button"
                role="tab"
                aria-selected={activeRightTab === 'details'}
                onClick={() => setActiveRightTab('details')}
                className={`inline-flex items-center gap-1.5 rounded-[var(--pd-radius-control)] px-3 py-1.5 text-xs font-medium transition ${
                  activeRightTab === 'details'
                    ? 'bg-[var(--pd-surface)] font-semibold text-[var(--pd-accent)] ring-1 ring-[var(--pd-border)]'
                    : 'text-[var(--pd-text-secondary)] hover:bg-[var(--pd-surface)]/70 hover:text-[var(--pd-text)]'
                }`}
              >
                <span>{i18n.t('detail.tabDetails')}</span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={activeRightTab === 'comments'}
                onClick={() => setActiveRightTab('comments')}
                className={`inline-flex items-center gap-1.5 rounded-[var(--pd-radius-control)] px-3 py-1.5 text-xs font-medium transition ${
                  activeRightTab === 'comments'
                    ? 'bg-[var(--pd-surface)] font-semibold text-[var(--pd-accent)] ring-1 ring-[var(--pd-border)]'
                    : 'text-[var(--pd-text-secondary)] hover:bg-[var(--pd-surface)]/70 hover:text-[var(--pd-text)]'
                }`}
              >
                <MessageSquare className="h-3.5 w-3.5" />
                <span>{i18n.t('detail.tabComments')}</span>
                {(item.savedCommentCount ?? 0) > 0 && (
                  <span className="rounded-[var(--pd-radius-pill)] bg-[var(--pd-accent-soft)] px-1.5 py-0.2 text-[10px] font-semibold tabular-nums text-[var(--pd-accent)]">
                    {item.savedCommentCount}
                  </span>
                )}
              </button>
            </div>
          )}

          {activeRightTab === 'comments' && showCommentsTab ? (
            <ItemCommentsPanel
              item={item}
              vaultBackend={vaultBackend}
              permissionState={permissionState}
              onRequestVaultAccess={onRequestVaultAccess}
            />
          ) : (
          /* 可滚动编辑表单与详情区 */
          <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-5 py-4">
            {/* 不自动同步原因摘要卡 */}
            {isExcluded && exclusion && exclusionInfo && (
              <div className="rounded border border-amber-200 bg-amber-50 p-3 text-xs text-amber-950 dark:border-amber-900 dark:bg-amber-950/60 dark:text-amber-200">
                <div className="flex items-center justify-between gap-2">
                  <span className="inline-flex items-center gap-1.5 font-semibold">
                    <CloudOff className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" />
                    <span>{i18n.t('detail.exclusionReasonHeading')}</span>
                  </span>
                  <span className="text-[11px] tabular-nums opacity-80">
                    {formatDateTime(exclusion.excludedAt)}
                  </span>
                </div>
                <p className="mt-1 font-medium">
                  {exclusionInfo.label}
                </p>
                {exclusion.detail && (
                  <p className="mt-1 leading-relaxed opacity-90">
                    {exclusion.detail}
                  </p>
                )}
              </div>
            )}

            {/* 标题编辑 */}
            <div>
              <label
                htmlFor="detail-title-input"
                className="mb-1 block text-xs font-semibold text-[var(--pd-text-secondary)]"
              >
                {i18n.t('detail.fieldTitle')}
              </label>
              <input
                id="detail-title-input"
                type="text"
                value={draftTitle}
                onChange={(e) => {
                  setDraftTitle(e.target.value);
                  setSaveFeedback(null);
                }}
                className="w-full rounded-[var(--pd-radius-control)] border border-[var(--pd-border)] bg-[var(--pd-input)] px-3 py-2 text-sm font-medium text-[var(--pd-text)] transition focus:border-[var(--pd-accent)] focus:bg-[var(--pd-surface)] focus:ring-2 focus:ring-[var(--pd-accent-soft)] focus:outline-none"
              />
            </div>

            {/* 所属文件夹（支持多选） */}
            <div>
              <div className="mb-1.5 flex items-center justify-between gap-2">
                <span className="flex items-center gap-1.5 text-xs font-semibold text-[var(--pd-text-secondary)]">
                  <Folder className="h-3.5 w-3.5 text-[var(--pd-text-muted)]" />
                  <span>{i18n.t('detail.fieldFolders')}</span>
                  {item.folderAssignedBy === 'auto' && draftFolderIds.length > 0 && (
                    <span
                      data-testid="detail-auto-assigned-badge"
                      title={i18n.t('detail.autoAssignedHint')}
                      className="rounded bg-[var(--pd-accent-soft)] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--pd-accent)]"
                    >
                      {i18n.t('detail.autoAssignedBadge')}
                    </span>
                  )}
                </span>
                <span className="text-[11px] text-[var(--pd-text-muted)]">
                  {draftFolderIds.length > 0
                    ? i18n.t('detail.selectedFoldersCount', {
                        count: draftFolderIds.length,
                      })
                    : i18n.t('sidebar.navUncategorized')}
                </span>
              </div>

              {draftFolderIds.length > 0 && (
                <div className="mb-2 flex flex-wrap gap-1.5">
                  {draftFolderIds.map((fid) => {
                    const folderName = foldersById.get(fid)?.name;
                    if (!folderName) {
                      return null;
                    }
                    return (
                      <span
                        key={fid}
                        className="inline-flex items-center gap-1 rounded-[var(--pd-radius-pill)] border border-[var(--pd-border)] bg-[var(--pd-accent-secondary-soft)] px-2.5 py-0.5 text-xs font-medium text-[var(--pd-accent-secondary)]"
                      >
                        <Folder className="h-3 w-3" />
                        <span>{folderName}</span>
                        <button
                          type="button"
                          onClick={() => handleToggleFolder(fid)}
                          aria-label={i18n.t('detail.removeFolderAria', {
                            name: folderName,
                          })}
                          className="rounded-full p-0.5 opacity-75 transition hover:opacity-100"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </span>
                    );
                  })}
                </div>
              )}

              {folderOptions.length === 0 ? (
                <p className="rounded border border-dashed border-[var(--pd-border)] bg-[var(--pd-surface-muted)] px-3 py-2 text-xs text-[var(--pd-text-muted)]">
                  {i18n.t('detail.noFoldersHint')}
                </p>
              ) : (
                <div
                  data-testid="detail-folder-list"
                  className="max-h-36 overflow-y-auto rounded border border-[var(--pd-border)] bg-[var(--pd-surface-muted)] p-1.5"
                >
                  {folderOptions.map((opt) => {
                    const checked = draftFolderIds.includes(opt.id);
                    return (
                      <label
                        key={opt.id}
                        className={`flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-xs transition ${
                          checked
                            ? 'bg-[var(--pd-accent-soft)] font-semibold text-[var(--pd-accent)]'
                            : 'text-[var(--pd-text-secondary)] hover:bg-[var(--pd-surface)]'
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => handleToggleFolder(opt.id)}
                          className="h-3.5 w-3.5 shrink-0 rounded border-[var(--pd-border)] accent-[var(--pd-accent)]"
                        />
                        <span className="truncate">{opt.label}</span>
                      </label>
                    );
                  })}
                </div>
              )}
            </div>

            {/* 标签编辑 */}
            <div>
              <label className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-[var(--pd-text-secondary)]">
                <Tag className="h-3.5 w-3.5 text-[var(--pd-text-muted)]" />
                <span>{i18n.t('detail.fieldTags')}</span>
              </label>

              {draftTags.length > 0 && (
                <div className="mb-2 flex flex-wrap gap-1.5">
                  {draftTags.map((tagName) => {
                    const color = tagsByName.get(tagName)?.color ?? '#0d9488';
                    return (
                      <span
                        key={tagName}
                        className="inline-flex items-center gap-1.5 rounded-[var(--pd-radius-pill)] border border-[var(--pd-border)] bg-[var(--pd-accent-soft)] px-2.5 py-0.5 text-xs font-medium text-[var(--pd-accent)]"
                      >
                        <span
                          className="h-2 w-2 rounded-full"
                          style={{ backgroundColor: color }}
                        />
                        <span>{tagName}</span>
                        <button
                          type="button"
                          onClick={() => handleRemoveTag(tagName)}
                          aria-label={i18n.t('detail.removeTagAria', {
                            name: tagName,
                          })}
                          className="rounded-full p-0.5 opacity-75 hover:opacity-100"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </span>
                    );
                  })}
                </div>
              )}

              <div className="flex items-center gap-1.5">
                <input
                  type="text"
                  value={tagInput}
                  onChange={(e) => setTagInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      handleAddTag(tagInput);
                    }
                  }}
                  placeholder={i18n.t('detail.tagInputPlaceholder')}
                  className="min-w-0 flex-1 rounded-[var(--pd-radius-control)] border border-[var(--pd-border)] bg-[var(--pd-input)] px-3 py-1.5 text-xs text-[var(--pd-text)] placeholder:text-[var(--pd-text-muted)] transition focus:border-[var(--pd-accent)] focus:bg-[var(--pd-surface)] focus:ring-2 focus:ring-[var(--pd-accent-soft)] focus:outline-none"
                />
                <button
                  type="button"
                  onClick={() => handleAddTag(tagInput)}
                  disabled={!tagInput.trim()}
                  className="inline-flex items-center gap-1 rounded-[var(--pd-radius-control)] border border-[var(--pd-border)] bg-[var(--pd-surface)] px-2.5 py-1.5 text-xs font-medium text-[var(--pd-text-secondary)] transition hover:border-[var(--pd-accent)] hover:bg-[var(--pd-accent-soft)] hover:text-[var(--pd-accent)] disabled:opacity-45"
                >
                  <Plus className="h-3.5 w-3.5" />
                  <span>{i18n.t('common.add')}</span>
                </button>
              </div>

              {suggestedTags.length > 0 && (
                <div className="mt-2 flex flex-wrap items-center gap-1">
                  <span className="text-[11px] text-[var(--pd-text-muted)]">
                    {i18n.t('detail.suggestedTagsLabel')}
                  </span>
                  {suggestedTags.map((tag) => (
                    <button
                      key={tag.name}
                      type="button"
                      onClick={() => handleAddTag(tag.name)}
                      className="inline-flex items-center gap-1 rounded-[var(--pd-radius-pill)] border border-[var(--pd-border)] bg-[var(--pd-surface)] px-2 py-0.5 text-[11px] text-[var(--pd-text-secondary)] transition hover:border-[var(--pd-accent)] hover:bg-[var(--pd-accent-soft)] hover:text-[var(--pd-accent)]"
                    >
                      <span
                        className="h-1.5 w-1.5 rounded-full"
                        style={{ backgroundColor: tag.color }}
                      />
                      <span>{tag.name}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* 备注编辑 */}
            <div>
              <label
                htmlFor="detail-note-textarea"
                className="mb-1 block text-xs font-semibold text-[var(--pd-text-secondary)]"
              >
                {i18n.t('detail.fieldNote')}
              </label>
              <textarea
                id="detail-note-textarea"
                rows={3}
                value={draftNote}
                onChange={(e) => {
                  setDraftNote(e.target.value);
                  setSaveFeedback(null);
                }}
                placeholder={i18n.t('detail.notePlaceholder')}
                className="w-full resize-y rounded-[var(--pd-radius-control)] border border-[var(--pd-border)] bg-[var(--pd-input)] px-3 py-2 text-xs leading-relaxed text-[var(--pd-text)] placeholder:text-[var(--pd-text-muted)] transition focus:border-[var(--pd-accent)] focus:bg-[var(--pd-surface)] focus:ring-2 focus:ring-[var(--pd-accent-soft)] focus:outline-none"
              />
            </div>

            {/* 保存按钮与反馈 */}
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => void handleSave()}
                  disabled={!isDirty || saving}
                  className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-[var(--pd-radius-control)] bg-[var(--pd-accent)] px-4 py-2 text-xs font-semibold text-[var(--pd-on-accent)] transition hover:bg-[var(--pd-accent-hover)] disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {saving ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Save className="h-3.5 w-3.5" />
                  )}
                  <span>
                    {saving
                      ? i18n.t('detail.saving')
                      : permissionState === 'granted'
                        ? i18n.t('detail.saveAndWriteMeta')
                        : i18n.t('detail.saveChanges')}
                  </span>
                </button>
                {isDirty && (
                  <button
                    type="button"
                    onClick={() => {
                      setDraftTitle(item.title);
                      setDraftFolderIds(itemFolderIds);
                      setDraftTags(item.tags);
                      setDraftNote(item.note);
                      setSaveFeedback(null);
                    }}
                    className="rounded border border-[var(--pd-border)] px-3 py-2 text-xs font-medium text-[var(--pd-text-secondary)] hover:bg-[var(--pd-surface-muted)]"
                  >
                    {i18n.t('common.reset')}
                  </button>
                )}
              </div>

              {saveFeedback && (
                <div
                  className={`flex items-center gap-1.5 rounded px-2.5 py-1.5 text-[11px] font-medium ${
                    saveFeedback.type === 'success'
                      ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/70 dark:text-emerald-300'
                      : 'bg-rose-50 text-rose-700 dark:bg-rose-950/70 dark:text-rose-300'
                  }`}
                >
                  {saveFeedback.type === 'success' ? (
                    <Check className="h-3.5 w-3.5 shrink-0" />
                  ) : (
                    <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                  )}
                  <span>{saveFeedback.text}</span>
                </div>
              )}
            </div>

            {/* 正文描述（如有） */}
            {item.description && item.description !== item.title && (
              <div className="rounded border border-[var(--pd-divider)] bg-[var(--pd-surface-muted)] p-3">
                <p className="mb-1 text-[11px] font-semibold text-[var(--pd-text-muted)]">
                  {i18n.t('detail.originalDescriptionHeading')}
                </p>
                <p className="whitespace-pre-wrap text-xs leading-relaxed text-[var(--pd-text-secondary)]">
                  {item.description}
                </p>
              </div>
            )}

            {/* 归档元信息 */}
            <dl className="flex flex-col gap-2 rounded border border-[var(--pd-divider)] bg-[var(--pd-surface-muted)] p-3 text-xs">
              <div className="flex items-center justify-between gap-2">
                <dt className="flex items-center gap-1.5 text-[var(--pd-text-muted)]">
                  <User className="h-3.5 w-3.5" />
                  <span>{i18n.t('detail.metaAuthor')}</span>
                </dt>
                <dd className="flex items-center gap-1.5 truncate font-medium text-[var(--pd-text)]">
                  {item.author.profileUrl ? (
                    <a
                      href={item.author.profileUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-[var(--pd-accent-secondary)] hover:underline"
                    >
                      <span>{item.author.name}</span>
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  ) : (
                    <span>{item.author.name}</span>
                  )}
                  {item.author.handle && (
                    <span className="text-[11px] font-normal text-[var(--pd-text-muted)]">
                      ({item.author.handle})
                    </span>
                  )}
                </dd>
              </div>

              {item.publishedAt !== undefined && (
                <div className="flex items-center justify-between gap-2">
                  <dt className="flex items-center gap-1.5 text-[var(--pd-text-muted)]">
                    <Calendar className="h-3.5 w-3.5" />
                    <span>{i18n.t('detail.metaPublishedAt')}</span>
                  </dt>
                  <dd className="tabular-nums text-[var(--pd-text-secondary)]">
                    {formatDateTime(item.publishedAt)}
                  </dd>
                </div>
              )}

              <div className="flex items-center justify-between gap-2">
                <dt className="flex items-center gap-1.5 text-[var(--pd-text-muted)]">
                  <Clock className="h-3.5 w-3.5" />
                  <span>{i18n.t('detail.metaCollectedAt')}</span>
                </dt>
                <dd className="tabular-nums text-[var(--pd-text-secondary)]">
                  {formatDateTime(item.collectedAt)}
                </dd>
              </div>

              <div className="flex items-center justify-between gap-2">
                <dt className="flex items-center gap-1.5 text-[var(--pd-text-muted)]">
                  <HardDrive className="h-3.5 w-3.5" />
                  <span>{i18n.t('detail.metaTotalSize')}</span>
                </dt>
                <dd className="tabular-nums text-[var(--pd-text-secondary)]">
                  {formatBytes(item.totalSizeBytes)}
                </dd>
              </div>

              <div className="flex flex-col gap-1 border-t border-[var(--pd-divider)] pt-2">
                <dt className="text-[11px] text-[var(--pd-text-muted)]">
                  {i18n.t('detail.metaRelativeDir')}
                </dt>
                <dd>
                  <code className="block break-all rounded border border-[var(--pd-border)] bg-[var(--pd-surface)] px-2 py-1 text-[11px] text-[var(--pd-text-secondary)]">
                    {item.relativeDir}
                  </code>
                </dd>
              </div>
            </dl>
          </div>
          )}

          {/* 底部操作条 */}
          <footer className="flex items-center justify-between gap-2 border-t border-[var(--pd-divider)] bg-[var(--pd-surface-muted)] px-5 py-3">
            <a
              href={item.sourceUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 rounded-[var(--pd-radius-control)] border border-[var(--pd-border)] bg-[var(--pd-surface)] px-3 py-1.5 text-xs font-medium text-[var(--pd-text-secondary)] transition hover:border-[var(--pd-accent)] hover:text-[var(--pd-accent)]"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              <span>{i18n.t('detail.openOriginalLink')}</span>
            </a>

            {isExcluded ? (
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  disabled={actionBusy}
                  onClick={() =>
                    void runFooterAction(() => onAllowAutoSyncAgain([item]))
                  }
                  className="inline-flex items-center gap-1.5 rounded bg-[var(--pd-accent)] px-3 py-1.5 text-xs font-semibold text-[var(--pd-on-accent)] transition hover:bg-[var(--pd-accent-hover)] disabled:opacity-60"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  <span>{i18n.t('grid.allowAutoSyncAgain')}</span>
                </button>
                <button
                  type="button"
                  disabled={actionBusy}
                  onClick={() =>
                    void runFooterAction(() => onRemoteUncollectAndClear([item]))
                  }
                  className="inline-flex items-center gap-1.5 rounded border border-rose-300 bg-[var(--pd-surface)] px-3 py-1.5 text-xs font-medium text-rose-600 transition hover:bg-rose-50 disabled:opacity-60 dark:border-rose-900 dark:text-rose-400 dark:hover:bg-rose-950/60"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  <span>{i18n.t('grid.remoteUncollectAndClear')}</span>
                </button>
              </div>
            ) : isDeleted ? (
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => void onRestoreItem(item)}
                  className="inline-flex items-center gap-1.5 rounded bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-emerald-700"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  <span>{i18n.t('grid.restoreFromTrashTitle')}</span>
                </button>
                <button
                  type="button"
                  onClick={() => onRequestDeleteItem(item, 'permanent')}
                  className="inline-flex items-center gap-1.5 rounded border border-rose-300 bg-[var(--pd-surface)] px-3 py-1.5 text-xs font-medium text-rose-600 transition hover:bg-rose-50 dark:border-rose-900 dark:text-rose-400 dark:hover:bg-rose-950/60"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  <span>{i18n.t('grid.permanentDelete')}</span>
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                {item.syncStatus === 'pending_download' && (
                  <button
                    type="button"
                    disabled={actionBusy}
                    onClick={() =>
                      void runFooterAction(() => onCancelItemSync(item))
                    }
                    className="inline-flex items-center gap-1.5 rounded border border-amber-200 bg-amber-50 px-3 py-1.5 text-xs font-medium text-amber-800 transition hover:bg-amber-100 disabled:opacity-60 dark:border-amber-900 dark:bg-amber-950/60 dark:text-amber-300"
                  >
                    <CloudOff className="h-3.5 w-3.5" />
                    <span>{i18n.t('grid.cancelItemSyncShort')}</span>
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => onRequestDeleteItem(item, 'soft')}
                  className="inline-flex items-center gap-1.5 rounded border border-rose-300 bg-[var(--pd-surface)] px-3 py-1.5 text-xs font-medium text-rose-600 transition hover:bg-rose-50 dark:border-rose-900 dark:text-rose-400 dark:hover:bg-rose-950/60"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  <span>{i18n.t('grid.moveToTrash')}</span>
                </button>
              </div>
            )}
          </footer>
        </section>
        </div>
      </div>
    </div>
  );
}
