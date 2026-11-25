import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  Calendar,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock,
  ExternalLink,
  FileText,
  Film,
  Folder,
  FolderKey,
  HardDrive,
  Images,
  Loader2,
  Maximize2,
  Plus,
  RotateCcw,
  Save,
  Tag,
  Trash2,
  User,
  X,
} from 'lucide-react';
import { readItemAssetFile } from '@/storage/vault.ts';
import type {
  CollectionItemRecord,
  FolderNode,
  MediaAsset,
  TagMeta,
} from '@/types/schema.ts';
import {
  formatBytes,
  formatDateTime,
  formatDuration,
  getErrorMessage,
  platformMeta,
  syncStatusMeta,
} from '../utils/format.ts';
import type { VaultPermissionStatus } from './VaultBanner.tsx';

export interface ItemEditPatch {
  title: string;
  folderId: string | null;
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
  vaultHandle: FileSystemDirectoryHandle | null;
  permissionState: VaultPermissionStatus;
  onClose: () => void;
  onRequestVaultAccess: () => Promise<boolean>;
  onSaveItem: (
    itemId: string,
    patch: ItemEditPatch,
  ) => Promise<SaveItemResult>;
  onSoftDeleteItem: (item: CollectionItemRecord) => Promise<void>;
  onRestoreItem: (item: CollectionItemRecord) => Promise<void>;
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

export function ItemDetailDrawer({
  item,
  folders,
  tags,
  vaultHandle,
  permissionState,
  onClose,
  onRequestVaultAccess,
  onSaveItem,
  onSoftDeleteItem,
  onRestoreItem,
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

  // 元数据编辑表单状态
  const [draftTitle, setDraftTitle] = useState(item.title);
  const [draftFolderId, setDraftFolderId] = useState<string | null>(
    item.folderId,
  );
  const [draftTags, setDraftTags] = useState<string[]>(item.tags);
  const [draftNote, setDraftNote] = useState(item.note);
  const [tagInput, setTagInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveFeedback, setSaveFeedback] = useState<{
    type: 'success' | 'error';
    text: string;
  } | null>(null);

  // 切换条目或条目外部刷新时同步表单状态
  useEffect(() => {
    setDraftTitle(item.title);
    setDraftFolderId(item.folderId);
    setDraftTags(item.tags);
    setDraftNote(item.note);
    setTagInput('');
  }, [item.id, item.updatedAt, item.title, item.folderId, item.tags, item.note]);

  // 仅在切换不同条目时重置图集页码与保存反馈提示，避免保存后 liveQuery 刷新把成功提示瞬间擦除
  useEffect(() => {
    setActiveSlideIndex(0);
    setSaveFeedback(null);
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
    return `${item.id}|${item.kind}|${item.relativeDir}|${item.coverRelativePath ?? ''}|${assetSig}|${availabilityPhase}`;
  }, [
    item.id,
    item.kind,
    item.relativeDir,
    item.coverRelativePath,
    item.assets,
    item.syncStatus,
  ]);

  // 100% 离线媒体读取与严格的 Object URL 生命周期管理
  useEffect(() => {
    let cancelled = false;
    const createdUrls: string[] = [];
    const currentItem = itemRef.current;

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
          const [videoFile, coverFile] = await Promise.all([
            videoAsset
              ? readItemAssetFile(
                  currentItem,
                  videoAsset.relativePath,
                  vaultHandle,
                )
              : Promise.resolve(null),
            coverPath
              ? readItemAssetFile(currentItem, coverPath, vaultHandle)
              : Promise.resolve(null),
          ]);

          if (cancelled) {
            return;
          }

          if (coverFile) {
            setCoverUrl(createTrackedUrl(coverFile));
          }

          if (videoAsset && videoFile) {
            setLoadedVideo({
              asset: videoAsset,
              url: createTrackedUrl(videoFile),
              sizeBytes: videoAsset.sizeBytes ?? videoFile.size,
            });
          } else {
            const authBlocked =
              permissionState !== 'granted' &&
              (vaultHandle !== null ||
                currentItem.syncStatus === 'vault_synced');
            setNeedsVaultAuth(authBlocked);
            if (!authBlocked) {
              setMediaError(
                currentItem.syncStatus === 'pending_download'
                  ? '该视频正在后台下载中，请稍候片刻再试。'
                  : currentItem.syncStatus === 'failed'
                    ? '视频下载失败，请在侧边栏重试下载任务。'
                    : '未在本地 CollectVault 或浏览器 OPFS 中找到视频文件。',
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
              readItemAssetFile(currentItem, asset.relativePath, vaultHandle),
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
              (vaultHandle !== null ||
                currentItem.syncStatus === 'vault_synced');
            setNeedsVaultAuth(authBlocked);
            if (!authBlocked) {
              setMediaError(
                currentItem.syncStatus === 'pending_download'
                  ? '图集正在后台下载中，请稍候片刻再试。'
                  : currentItem.syncStatus === 'failed'
                    ? '图集下载失败，请在侧边栏重试下载任务。'
                    : '未在本地 CollectVault 或浏览器 OPFS 中找到图片文件。',
              );
            }
          }
        }
      } catch (error) {
        if (!cancelled) {
          setMediaError(`读取本地媒体失败：${getErrorMessage(error)}`);
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
    };
  }, [mediaLoadKey, vaultHandle, permissionState, reloadTick]);

  // 键盘快捷键：Esc 关闭，图集模式下 ArrowLeft / ArrowRight 翻页
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
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
  }, [onClose, loadedSlides.length]);

  const folderOptions = useMemo(() => flattenFolderOptions(folders), [folders]);
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
      draftFolderId !== item.folderId ||
      draftNote !== item.note ||
      !areTagListsEqual(draftTags, item.tags)
    );
  }, [draftTitle, draftFolderId, draftNote, draftTags, item]);

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
        folderId: draftFolderId,
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
        text: `保存失败：${getErrorMessage(error)}`,
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
  const platformInfo = platformMeta(item.platform);
  const syncInfo = syncStatusMeta(item.syncStatus);
  const isDeleted = item.deletedAt != null;

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-slate-950/60 p-4 backdrop-blur-xs md:p-6"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={item.title}
    >
      <div
        className="flex h-[88vh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl lg:flex-row"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 左侧：100% 离线媒体播放 / 图集画廊 */}
        <section className="flex min-h-[320px] flex-col bg-slate-950 text-white lg:w-[58%]">
          {/* 顶部媒体状态栏 */}
          <div className="flex items-center justify-between gap-2 border-b border-white/10 px-4 py-2.5">
            <div className="flex items-center gap-2 text-xs">
              <span
                className={`rounded-md px-2 py-0.5 text-[10px] font-semibold ${platformInfo.badgeClass}`}
              >
                {platformInfo.label}
              </span>
              <span className="inline-flex items-center gap-1 text-slate-300">
                {item.kind === 'video' ? (
                  <>
                    <Film className="h-3.5 w-3.5 text-indigo-400" />
                    <span>离线视频播放</span>
                  </>
                ) : item.kind === 'article' ? (
                  <>
                    <FileText className="h-3.5 w-3.5 text-indigo-400" />
                    <span>离线文章阅读</span>
                  </>
                ) : (
                  <>
                    <Images className="h-3.5 w-3.5 text-indigo-400" />
                    <span>
                      离线图集画廊
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
                className="inline-flex items-center gap-1 rounded-lg bg-white/10 px-2.5 py-1 text-[11px] font-medium text-white transition hover:bg-white/20"
              >
                <Maximize2 className="h-3 w-3" />
                <span>新标签页查看原图</span>
              </a>
            )}
          </div>

          {/* 主媒体画布 */}
          <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden p-3">
            {mediaLoading ? (
              <div className="flex flex-col items-center gap-2.5 text-xs text-slate-300">
                <Loader2 className="h-7 w-7 animate-spin text-indigo-400" />
                <span>正在从本地存储读取离线媒体...</span>
              </div>
            ) : needsVaultAuth ? (
              <div className="flex max-w-sm flex-col items-center gap-3 rounded-2xl border border-white/10 bg-white/5 px-6 py-7 text-center">
                <span className="inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-indigo-500/20 text-indigo-300">
                  <FolderKey className="h-6 w-6" />
                </span>
                <h4 className="text-sm font-semibold text-white">
                  需要授权本地 CollectVault 目录
                </h4>
                <p className="text-xs leading-relaxed text-slate-300">
                  该作品的离线媒体已保存在本地目录
                  {vaultHandle ? `「${vaultHandle.name}」` : ''}
                  中，授予浏览器读取权限后即可立即离线播放。
                </p>
                <button
                  type="button"
                  onClick={() => void handleAuthorizeAndReload()}
                  disabled={authorizing}
                  className="mt-1 inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-4 py-2 text-xs font-semibold text-white transition hover:bg-indigo-500 disabled:opacity-60"
                >
                  {authorizing ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <FolderKey className="h-4 w-4" />
                  )}
                  <span>授权本地目录并加载</span>
                </button>
              </div>
            ) : mediaError ? (
              <div className="flex max-w-sm flex-col items-center gap-2.5 rounded-2xl border border-rose-500/20 bg-rose-950/30 px-6 py-6 text-center">
                <AlertCircle className="h-8 w-8 text-rose-400" />
                <p className="text-xs leading-relaxed text-rose-100">
                  {mediaError}
                </p>
                <button
                  type="button"
                  onClick={() => setReloadTick((prev) => prev + 1)}
                  className="mt-1 inline-flex items-center gap-1 rounded-lg bg-white/10 px-3 py-1.5 text-xs font-medium text-white hover:bg-white/20"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  <span>重新读取</span>
                </button>
              </div>
            ) : item.kind === 'video' && loadedVideo ? (
              <video
                key={loadedVideo.url}
                src={loadedVideo.url}
                poster={coverUrl ?? item.thumbnailDataUrl}
                controls
                playsInline
                className="max-h-full max-w-full rounded-lg bg-black shadow-lg"
              />
            ) : item.kind === 'article' ? (
              <article className="flex h-full w-full flex-col overflow-y-auto rounded-xl bg-white p-6 text-slate-800 shadow-lg">
                {(currentSlide?.url ?? item.thumbnailDataUrl) && (
                  <img
                    src={currentSlide?.url ?? item.thumbnailDataUrl}
                    alt={item.title}
                    className="mb-4 max-h-56 w-full rounded-lg object-cover"
                  />
                )}
                <h3 className="text-lg font-bold leading-snug text-slate-900">
                  {item.title}
                </h3>
                <p className="mt-1.5 text-xs text-slate-500">
                  作者：{item.author.name}
                  {item.publishedAt
                    ? ` · 发布于 ${formatDateTime(item.publishedAt)}`
                    : ''}
                </p>
                <div className="mt-4 border-t border-slate-100 pt-4 text-sm leading-relaxed whitespace-pre-wrap text-slate-700">
                  {item.description.trim()
                    ? item.description
                    : '该文章暂无正文快照内容，可点击右侧「打开原链接」查看原文。'}
                </div>
              </article>
            ) : currentSlide ? (
              <div className="relative flex h-full w-full items-center justify-center">
                <img
                  key={currentSlide.url}
                  src={currentSlide.url}
                  alt={`${item.title} - 第 ${activeSlideIndex + 1} 张`}
                  className="max-h-full max-w-full rounded-lg object-contain shadow-lg select-none"
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
                      aria-label="上一张"
                      className="absolute left-2 inline-flex h-9 w-9 items-center justify-center rounded-full bg-slate-900/75 text-white shadow-md backdrop-blur-xs transition hover:bg-slate-900"
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
                      aria-label="下一张"
                      className="absolute right-2 inline-flex h-9 w-9 items-center justify-center rounded-full bg-slate-900/75 text-white shadow-md backdrop-blur-xs transition hover:bg-slate-900"
                    >
                      <ChevronRight className="h-5 w-5" />
                    </button>
                    <span className="absolute bottom-2 left-1/2 -translate-x-1/2 rounded-full bg-slate-900/80 px-3 py-1 text-xs font-medium tabular-nums text-white backdrop-blur-xs">
                      {activeSlideIndex + 1} / {loadedSlides.length}
                    </span>
                  </>
                )}
              </div>
            ) : null}
          </div>

          {/* 图集底部缩略图条 */}
          {loadedSlides.length > 1 && (
            <div className="flex items-center gap-2 overflow-x-auto border-t border-white/10 bg-slate-900/90 px-4 py-2.5">
              {loadedSlides.map((slide, index) => {
                const isActive = index === activeSlideIndex;
                return (
                  <button
                    key={slide.asset.id}
                    type="button"
                    onClick={() => setActiveSlideIndex(index)}
                    className={`relative h-12 w-12 shrink-0 overflow-hidden rounded-lg border-2 transition ${
                      isActive
                        ? 'border-indigo-400 ring-2 ring-indigo-500/40'
                        : 'border-transparent opacity-60 hover:opacity-100'
                    }`}
                  >
                    <img
                      src={slide.url}
                      alt={`缩略图 ${index + 1}`}
                      className="h-full w-full object-cover"
                    />
                  </button>
                );
              })}
            </div>
          )}

          {/* 媒体技术参数与落盘相对路径 */}
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t border-white/10 bg-slate-900 px-4 py-2 text-[11px] text-slate-400">
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
                  总大小 {formatBytes(item.totalSizeBytes)}
                </span>
              )}
            </div>

            <code
              className="max-w-full truncate text-[10px] text-slate-400"
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

        {/* 右侧：元数据编辑与详情面板 */}
        <section className="flex min-h-0 flex-1 flex-col bg-white lg:w-[42%]">
          {/* 头部栏 */}
          <header className="flex items-center justify-between gap-2 border-b border-slate-200 px-5 py-3.5">
            <div className="flex items-center gap-2">
              <span
                className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-medium ${syncInfo.badgeClass}`}
              >
                <span
                  className={`h-1.5 w-1.5 rounded-full ${syncInfo.dotClass}`}
                />
                <span>{syncInfo.label}</span>
              </span>
              {isDeleted && (
                <span className="rounded-full bg-rose-100 px-2 py-0.5 text-[11px] font-medium text-rose-700">
                  回收站中
                </span>
              )}
            </div>

            <button
              type="button"
              onClick={onClose}
              aria-label="关闭详情"
              className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
            >
              <X className="h-4 w-4" />
            </button>
          </header>

          {/* 可滚动编辑表单与详情区 */}
          <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-5 py-4">
            {/* 标题编辑 */}
            <div>
              <label
                htmlFor="detail-title-input"
                className="mb-1 block text-xs font-semibold text-slate-700"
              >
                标题
              </label>
              <input
                id="detail-title-input"
                type="text"
                value={draftTitle}
                onChange={(e) => {
                  setDraftTitle(e.target.value);
                  setSaveFeedback(null);
                }}
                className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm font-medium text-slate-900 transition focus:border-indigo-400 focus:bg-white focus:ring-2 focus:ring-indigo-100 focus:outline-none"
              />
            </div>

            {/* 所属文件夹 */}
            <div>
              <label
                htmlFor="detail-folder-select"
                className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-slate-700"
              >
                <Folder className="h-3.5 w-3.5 text-slate-400" />
                <span>所属文件夹</span>
              </label>
              <select
                id="detail-folder-select"
                value={draftFolderId ?? ''}
                onChange={(e) => {
                  setDraftFolderId(e.target.value || null);
                  setSaveFeedback(null);
                }}
                className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-900 transition focus:border-indigo-400 focus:bg-white focus:ring-2 focus:ring-indigo-100 focus:outline-none"
              >
                <option value="">未分类</option>
                {folderOptions.map((opt) => (
                  <option key={opt.id} value={opt.id}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>

            {/* 标签编辑 */}
            <div>
              <label className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-slate-700">
                <Tag className="h-3.5 w-3.5 text-slate-400" />
                <span>标签</span>
              </label>

              {draftTags.length > 0 && (
                <div className="mb-2 flex flex-wrap gap-1.5">
                  {draftTags.map((tagName) => {
                    const color = tagsByName.get(tagName)?.color ?? '#6366f1';
                    return (
                      <span
                        key={tagName}
                        className="inline-flex items-center gap-1.5 rounded-full border border-indigo-200 bg-indigo-50 px-2.5 py-0.5 text-xs font-medium text-indigo-800"
                      >
                        <span
                          className="h-2 w-2 rounded-full"
                          style={{ backgroundColor: color }}
                        />
                        <span>{tagName}</span>
                        <button
                          type="button"
                          onClick={() => handleRemoveTag(tagName)}
                          aria-label={`移除标签 ${tagName}`}
                          className="rounded-full p-0.5 text-indigo-500 hover:bg-indigo-100 hover:text-indigo-800"
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
                  placeholder="输入标签后回车添加..."
                  className="min-w-0 flex-1 rounded-xl border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs text-slate-900 placeholder:text-slate-400 transition focus:border-indigo-400 focus:bg-white focus:ring-2 focus:ring-indigo-100 focus:outline-none"
                />
                <button
                  type="button"
                  onClick={() => handleAddTag(tagInput)}
                  disabled={!tagInput.trim()}
                  className="inline-flex items-center gap-1 rounded-xl border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 transition hover:border-indigo-300 hover:bg-indigo-50 hover:text-indigo-700 disabled:opacity-45"
                >
                  <Plus className="h-3.5 w-3.5" />
                  <span>添加</span>
                </button>
              </div>

              {suggestedTags.length > 0 && (
                <div className="mt-2 flex flex-wrap items-center gap-1">
                  <span className="text-[11px] text-slate-400">推荐标签：</span>
                  {suggestedTags.map((tag) => (
                    <button
                      key={tag.name}
                      type="button"
                      onClick={() => handleAddTag(tag.name)}
                      className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-white px-2 py-0.5 text-[11px] text-slate-600 transition hover:border-indigo-300 hover:bg-indigo-50 hover:text-indigo-700"
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
                className="mb-1 block text-xs font-semibold text-slate-700"
              >
                个人备注
              </label>
              <textarea
                id="detail-note-textarea"
                rows={3}
                value={draftNote}
                onChange={(e) => {
                  setDraftNote(e.target.value);
                  setSaveFeedback(null);
                }}
                placeholder="记录灵感、要点或检索关键词..."
                className="w-full resize-y rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs leading-relaxed text-slate-900 placeholder:text-slate-400 transition focus:border-indigo-400 focus:bg-white focus:ring-2 focus:ring-indigo-100 focus:outline-none"
              />
            </div>

            {/* 保存按钮与反馈 */}
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => void handleSave()}
                  disabled={!isDirty || saving}
                  className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-indigo-600 px-4 py-2 text-xs font-semibold text-white shadow-xs transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-400"
                >
                  {saving ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Save className="h-3.5 w-3.5" />
                  )}
                  <span>
                    {saving
                      ? '正在保存...'
                      : permissionState === 'granted'
                        ? '保存并回写本地元数据'
                        : '保存修改'}
                  </span>
                </button>
                {isDirty && (
                  <button
                    type="button"
                    onClick={() => {
                      setDraftTitle(item.title);
                      setDraftFolderId(item.folderId);
                      setDraftTags(item.tags);
                      setDraftNote(item.note);
                      setSaveFeedback(null);
                    }}
                    className="rounded-xl border border-slate-200 px-3 py-2 text-xs font-medium text-slate-600 hover:bg-slate-50"
                  >
                    重置
                  </button>
                )}
              </div>

              {saveFeedback && (
                <div
                  className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[11px] font-medium ${
                    saveFeedback.type === 'success'
                      ? 'bg-emerald-50 text-emerald-700'
                      : 'bg-rose-50 text-rose-700'
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
              <div className="rounded-xl border border-slate-100 bg-slate-50/80 p-3">
                <p className="mb-1 text-[11px] font-semibold text-slate-500">
                  原作品正文
                </p>
                <p className="whitespace-pre-wrap text-xs leading-relaxed text-slate-700">
                  {item.description}
                </p>
              </div>
            )}

            {/* 归档元信息 */}
            <dl className="flex flex-col gap-2 rounded-xl border border-slate-100 bg-slate-50/80 p-3 text-xs">
              <div className="flex items-center justify-between gap-2">
                <dt className="flex items-center gap-1.5 text-slate-500">
                  <User className="h-3.5 w-3.5 text-slate-400" />
                  <span>作者</span>
                </dt>
                <dd className="flex items-center gap-1.5 truncate font-medium text-slate-900">
                  {item.author.profileUrl ? (
                    <a
                      href={item.author.profileUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-indigo-600 hover:underline"
                    >
                      <span>{item.author.name}</span>
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  ) : (
                    <span>{item.author.name}</span>
                  )}
                  {item.author.handle && (
                    <span className="text-[11px] font-normal text-slate-400">
                      ({item.author.handle})
                    </span>
                  )}
                </dd>
              </div>

              {item.publishedAt !== undefined && (
                <div className="flex items-center justify-between gap-2">
                  <dt className="flex items-center gap-1.5 text-slate-500">
                    <Calendar className="h-3.5 w-3.5 text-slate-400" />
                    <span>原发布时间</span>
                  </dt>
                  <dd className="tabular-nums text-slate-700">
                    {formatDateTime(item.publishedAt)}
                  </dd>
                </div>
              )}

              <div className="flex items-center justify-between gap-2">
                <dt className="flex items-center gap-1.5 text-slate-500">
                  <Clock className="h-3.5 w-3.5 text-slate-400" />
                  <span>收藏时间</span>
                </dt>
                <dd className="tabular-nums text-slate-700">
                  {formatDateTime(item.collectedAt)}
                </dd>
              </div>

              <div className="flex items-center justify-between gap-2">
                <dt className="flex items-center gap-1.5 text-slate-500">
                  <HardDrive className="h-3.5 w-3.5 text-slate-400" />
                  <span>总文件体积</span>
                </dt>
                <dd className="tabular-nums text-slate-700">
                  {formatBytes(item.totalSizeBytes)}
                </dd>
              </div>

              <div className="flex flex-col gap-1 border-t border-slate-200/70 pt-2">
                <dt className="text-[11px] text-slate-500">相对归档目录</dt>
                <dd>
                  <code className="block break-all rounded-lg bg-white px-2 py-1 text-[11px] text-slate-600 ring-1 ring-slate-200/80">
                    {item.relativeDir}
                  </code>
                </dd>
              </div>
            </dl>
          </div>

          {/* 底部操作条 */}
          <footer className="flex items-center justify-between gap-2 border-t border-slate-200 bg-slate-50/70 px-5 py-3">
            <a
              href={item.sourceUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 transition hover:border-indigo-300 hover:text-indigo-700"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              <span>打开原链接</span>
            </a>

            {isDeleted ? (
              <button
                type="button"
                onClick={() => void onRestoreItem(item)}
                className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-emerald-700"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                <span>从回收站恢复</span>
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void onSoftDeleteItem(item)}
                className="inline-flex items-center gap-1.5 rounded-lg border border-rose-200 bg-white px-3 py-1.5 text-xs font-medium text-rose-600 transition hover:bg-rose-50"
              >
                <Trash2 className="h-3.5 w-3.5" />
                <span>移入回收站</span>
              </button>
            )}
          </footer>
        </section>
      </div>
    </div>
  );
}
