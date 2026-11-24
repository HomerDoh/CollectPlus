/**
 * Collect+ 抖音页面 Shadow DOM 交互浮层组件：
 * 1. 左下角低干扰悬浮采集按钮（支持折叠与加载防重）；
 * 2. 右上角快捷分类、标签编辑与实时下载状态 Toast 卡片（含智能 7s 自动收起）。
 */

import {
  AlertCircle,
  BookmarkCheck,
  BookmarkPlus,
  Check,
  CheckCircle2,
  ChevronLeft,
  Clock,
  ExternalLink,
  Film,
  FolderPlus,
  Images,
  Loader2,
  Plus,
  RotateCcw,
  X,
} from 'lucide-react';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type FocusEvent,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import type { ContentCaptureStatusState } from '../types/messages.ts';
import type {
  CollectionItemRecord,
  FolderNode,
  TagMeta,
} from '../types/schema.ts';

/** Toast 卡片状态（在协议状态基础上增加本地采集过渡态 `'capturing'`） */
export type OverlayToastStatus = ContentCaptureStatusState | 'capturing';

/** 单个 Toast 卡片的数据模型 */
export interface OverlayToastState {
  visible: boolean;
  status: OverlayToastStatus;
  progress: number;
  itemId?: string;
  taskId?: string;
  title?: string;
  error?: string;
  item?: CollectionItemRecord;
  /** 每次新事件递增，用于重置自动隐藏计时器 */
  revision: number;
}

/** 浮层整体只读快照 */
export interface CaptureOverlaySnapshot {
  isCapturing: boolean;
  floatingButtonEnabled: boolean;
  toast: OverlayToastState | null;
  folders: FolderNode[];
  tags: TagMeta[];
}

/** 轻量外部状态存储接口，供 Content Script 驱动 React Shadow DOM 渲染 */
export interface CaptureOverlayStore {
  getSnapshot: () => CaptureOverlaySnapshot;
  subscribe: (listener: () => void) => () => void;
}

/** 浮层交互动作回调集合 */
export interface CaptureOverlayActions {
  onTriggerCapture: () => void;
  onDismissToast: () => void;
  onSelectFolder: (itemId: string, folderId: string | null) => Promise<boolean>;
  onCreateFolder: (
    itemId: string,
    name: string,
    parentId: string | null,
  ) => Promise<{ ok: true; folder: FolderNode } | { ok: false; error: string }>;
  onUpdateTags: (itemId: string, tags: string[]) => Promise<boolean>;
  onRetryTask: (taskId: string) => Promise<boolean>;
  onOpenLibrary: (itemId?: string) => void;
}

export interface CaptureOverlayProps {
  store: CaptureOverlayStore;
  actions: CaptureOverlayActions;
}

interface FlattenedFolderOption {
  id: string;
  label: string;
}

const AUTO_HIDE_DELAY_MS = 7000;
const SAVED_BADGE_DURATION_MS = 1800;

function isTerminalToastStatus(status: OverlayToastStatus): boolean {
  return status === 'staged' || status === 'deduplicated' || status === 'failed';
}

/** 将扁平文件夹列表构造成带层级缩进前缀的有序选项列表 */
function buildFlattenedFolderOptions(
  folders: readonly FolderNode[],
): FlattenedFolderOption[] {
  const byParent = new Map<string | null, FolderNode[]>();
  const existingIds = new Set<string>(folders.map((folder) => folder.id));

  for (const folder of folders) {
    const normalizedParentId =
      folder.parentId !== null && existingIds.has(folder.parentId)
        ? folder.parentId
        : null;
    const siblings = byParent.get(normalizedParentId);
    if (siblings) {
      siblings.push(folder);
    } else {
      byParent.set(normalizedParentId, [folder]);
    }
  }

  for (const siblings of byParent.values()) {
    siblings.sort(
      (a, b) => a.sortOrder - b.sortOrder || a.createdAt - b.createdAt,
    );
  }

  const options: FlattenedFolderOption[] = [];
  const visited = new Set<string>();

  const walk = (parentId: string | null, depth: number): void => {
    const children = byParent.get(parentId);
    if (!children) {
      return;
    }

    for (const node of children) {
      if (visited.has(node.id)) {
        continue;
      }
      visited.add(node.id);
      const prefix =
        depth === 0 ? '' : `${'\u00A0\u00A0'.repeat(depth - 1)}└─ `;
      options.push({
        id: node.id,
        label: `${prefix}${node.name}`,
      });
      walk(node.id, depth + 1);
    }
  };

  walk(null, 0);
  return options;
}

function getMediaKindLabel(item: CollectionItemRecord): string {
  if (item.kind === 'video') {
    return '视频';
  }
  const imageCount = item.assets.filter((asset) => asset.kind === 'image').length;
  if (item.kind === 'gallery') {
    return imageCount > 0 ? `图集 ${imageCount}张` : '图集';
  }
  return '图片';
}

function getStatusBadgeMeta(toast: OverlayToastState): {
  label: string;
  className: string;
} {
  switch (toast.status) {
    case 'capturing':
      return { label: '正在解析...', className: 'cp-status-capturing' };
    case 'queued':
      return { label: '排队中', className: 'cp-status-queued' };
    case 'downloading':
      return {
        label: `下载中 ${Math.max(0, Math.min(100, Math.round(toast.progress)))}%`,
        className: 'cp-status-downloading',
      };
    case 'staged':
      return { label: '已离线暂存', className: 'cp-status-staged' };
    case 'deduplicated':
      return { label: '已在收藏库', className: 'cp-status-deduplicated' };
    case 'failed':
      return {
        label: toast.item ? '下载失败' : '采集失败',
        className: 'cp-status-failed',
      };
  }
}

export function CaptureOverlay({ store, actions }: CaptureOverlayProps) {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const { isCapturing, floatingButtonEnabled, toast, folders, tags } = snapshot;

  const [fabCollapsed, setFabCollapsed] = useState(false);
  const [isHovered, setIsHovered] = useState(false);
  const [isFocusWithin, setIsFocusWithin] = useState(false);
  const [savedNoticeVisible, setSavedNoticeVisible] = useState(false);
  const [isCreatingFolder, setIsCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [folderError, setFolderError] = useState<string | null>(null);
  const [isSubmittingFolder, setIsSubmittingFolder] = useState(false);
  const [tagInput, setTagInput] = useState('');
  const [isRetryingTask, setIsRetryingTask] = useState(false);

  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const newFolderInputRef = useRef<HTMLInputElement | null>(null);

  const triggerSavedNotice = useCallback(() => {
    setSavedNoticeVisible(true);
    if (savedTimerRef.current !== null) {
      clearTimeout(savedTimerRef.current);
    }
    savedTimerRef.current = setTimeout(() => {
      setSavedNoticeVisible(false);
      savedTimerRef.current = null;
    }, SAVED_BADGE_DURATION_MS);
  }, []);

  useEffect(() => {
    return () => {
      if (savedTimerRef.current !== null) {
        clearTimeout(savedTimerRef.current);
      }
    };
  }, []);

  // 切换条目或关闭 Toast 时重置表单临时态
  const activeItemId = toast?.item?.id ?? toast?.itemId;
  useEffect(() => {
    setIsCreatingFolder(false);
    setNewFolderName('');
    setFolderError(null);
    setTagInput('');
    setIsRetryingTask(false);
  }, [activeItemId, toast?.visible]);

  // 展开内联新建文件夹时自动聚焦输入框
  useEffect(() => {
    if (isCreatingFolder) {
      newFolderInputRef.current?.focus();
    }
  }, [isCreatingFolder]);

  // 智能 7 秒自动收起：仅在终态且无悬停、无焦点、非新建目录态时倒计时
  useEffect(() => {
    if (!toast || !toast.visible) {
      return;
    }
    if (!isTerminalToastStatus(toast.status)) {
      return;
    }
    if (isHovered || isFocusWithin || isCreatingFolder) {
      return;
    }

    const timer = setTimeout(() => {
      actions.onDismissToast();
    }, AUTO_HIDE_DELAY_MS);

    return () => {
      clearTimeout(timer);
    };
  }, [
    actions,
    isCreatingFolder,
    isFocusWithin,
    isHovered,
    toast,
    toast?.revision,
    toast?.status,
    toast?.visible,
  ]);

  const folderOptions = useMemo(
    () => buildFlattenedFolderOptions(folders),
    [folders],
  );

  const currentItem = toast?.item;

  const suggestedTags = useMemo(() => {
    if (!currentItem) {
      return [];
    }
    const existingSet = new Set(currentItem.tags);
    const query = tagInput.trim().replace(/^#+/, '').toLowerCase();

    return tags
      .filter((tag) => {
        if (existingSet.has(tag.name)) {
          return false;
        }
        if (query.length > 0) {
          return tag.name.toLowerCase().includes(query);
        }
        return true;
      })
      .slice(0, 5);
  }, [currentItem, tagInput, tags]);

  const handleToastFocusCapture = useCallback(() => {
    setIsFocusWithin(true);
  }, []);

  const handleToastBlurCapture = useCallback(
    (event: FocusEvent<HTMLDivElement>) => {
      const nextTarget = event.relatedTarget;
      if (
        nextTarget instanceof Node &&
        event.currentTarget.contains(nextTarget)
      ) {
        return;
      }
      setIsFocusWithin(false);
    },
    [],
  );

  const handleFolderSelectChange = useCallback(
    async (value: string) => {
      if (!currentItem) {
        return;
      }
      const nextFolderId = value === '' ? null : value;
      const ok = await actions.onSelectFolder(currentItem.id, nextFolderId);
      if (ok) {
        triggerSavedNotice();
      }
    },
    [actions, currentItem, triggerSavedNotice],
  );

  const handleCreateFolderSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!currentItem || isSubmittingFolder) {
        return;
      }

      const trimmed = newFolderName.trim();
      if (!trimmed) {
        setFolderError('请输入文件夹名称');
        return;
      }

      setIsSubmittingFolder(true);
      setFolderError(null);
      try {
        const result = await actions.onCreateFolder(
          currentItem.id,
          trimmed,
          currentItem.folderId,
        );
        if (result.ok) {
          setIsCreatingFolder(false);
          setNewFolderName('');
          triggerSavedNotice();
        } else {
          setFolderError(result.error);
        }
      } finally {
        setIsSubmittingFolder(false);
      }
    },
    [
      actions,
      currentItem,
      isSubmittingFolder,
      newFolderName,
      triggerSavedNotice,
    ],
  );

  const handleAddTag = useCallback(
    async (rawTag: string) => {
      if (!currentItem) {
        return;
      }
      const cleaned = rawTag.trim().replace(/^#+/, '').trim();
      if (!cleaned) {
        setTagInput('');
        return;
      }
      if (currentItem.tags.includes(cleaned)) {
        setTagInput('');
        return;
      }

      const nextTags = [...currentItem.tags, cleaned];
      setTagInput('');
      const ok = await actions.onUpdateTags(currentItem.id, nextTags);
      if (ok) {
        triggerSavedNotice();
      }
    },
    [actions, currentItem, triggerSavedNotice],
  );

  const handleTagInputKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        void handleAddTag(tagInput);
      }
    },
    [handleAddTag, tagInput],
  );

  const handleRemoveTag = useCallback(
    async (tagToRemove: string) => {
      if (!currentItem) {
        return;
      }
      const nextTags = currentItem.tags.filter((tag) => tag !== tagToRemove);
      const ok = await actions.onUpdateTags(currentItem.id, nextTags);
      if (ok) {
        triggerSavedNotice();
      }
    },
    [actions, currentItem, triggerSavedNotice],
  );

  const handleRetryTaskClick = useCallback(async () => {
    if (!toast?.taskId || isRetryingTask) {
      return;
    }
    setIsRetryingTask(true);
    try {
      await actions.onRetryTask(toast.taskId);
    } finally {
      setIsRetryingTask(false);
    }
  }, [actions, isRetryingTask, toast?.taskId]);

  const badgeMeta = toast ? getStatusBadgeMeta(toast) : null;

  const progressFillClass = useMemo(() => {
    if (!toast) {
      return 'cp-progress-fill';
    }
    if (toast.status === 'capturing' || toast.status === 'queued') {
      return 'cp-progress-fill is-indeterminate';
    }
    if (toast.status === 'staged') {
      return 'cp-progress-fill is-staged';
    }
    if (toast.status === 'deduplicated') {
      return 'cp-progress-fill is-deduplicated';
    }
    if (toast.status === 'failed') {
      return 'cp-progress-fill is-failed';
    }
    return 'cp-progress-fill';
  }, [toast]);

  const progressWidthPercent = useMemo(() => {
    if (!toast) {
      return 0;
    }
    if (toast.status === 'staged' || toast.status === 'deduplicated') {
      return 100;
    }
    if (toast.status === 'failed') {
      return Math.max(12, Math.min(100, Math.round(toast.progress)));
    }
    return Math.max(4, Math.min(100, Math.round(toast.progress)));
  }, [toast]);

  return (
    <div className="cp-overlay-root">
      {/* 1. 左下角轻悬浮采集按钮 */}
      {floatingButtonEnabled && (
        <div className="cp-fab-wrap">
          {fabCollapsed ? (
            <button
              type="button"
              className="cp-fab-mini-btn"
              title="展开 Collect+ 收藏按钮 (Alt+S)"
              aria-label="展开 Collect+ 收藏按钮"
              onClick={() => setFabCollapsed(false)}
            >
              {isCapturing ? (
                <Loader2 size={16} className="cp-spin" />
              ) : (
                <BookmarkPlus size={16} />
              )}
            </button>
          ) : (
            <>
              <button
                type="button"
                className="cp-fab-btn"
                title="收藏当前作品到 Collect+ (快捷键 Alt+S)"
                disabled={isCapturing}
                onClick={actions.onTriggerCapture}
              >
                <span className="cp-fab-icon-badge" aria-hidden="true">
                  {isCapturing ? (
                    <Loader2 size={14} className="cp-spin" />
                  ) : (
                    <BookmarkPlus size={14} />
                  )}
                </span>
                <span>{isCapturing ? '采集中...' : '收藏当前'}</span>
                <span className="cp-fab-kbd">Alt+S</span>
              </button>
              <button
                type="button"
                className="cp-fab-collapse-btn"
                title="收起悬浮按钮"
                aria-label="收起悬浮按钮"
                onClick={() => setFabCollapsed(true)}
              >
                <ChevronLeft size={14} />
              </button>
            </>
          )}
        </div>
      )}

      {/* 2. 右上角快捷分类与状态 Toast 卡片 */}
      {toast && toast.visible && badgeMeta && (
        <div
          className="cp-toast-card"
          role="status"
          aria-live="polite"
          onMouseEnter={() => setIsHovered(true)}
          onMouseLeave={() => setIsHovered(false)}
          onFocusCapture={handleToastFocusCapture}
          onBlurCapture={handleToastBlurCapture}
        >
          {/* 头部状态徽标 */}
          <div className="cp-toast-header">
            <div className="cp-toast-header-left">
              <span className={`cp-status-badge ${badgeMeta.className}`}>
                {(toast.status === 'capturing' ||
                  toast.status === 'downloading') && (
                  <Loader2 size={13} className="cp-spin" />
                )}
                {toast.status === 'queued' && <Clock size={13} />}
                {toast.status === 'staged' && <CheckCircle2 size={13} />}
                {toast.status === 'deduplicated' && <BookmarkCheck size={13} />}
                {toast.status === 'failed' && <AlertCircle size={13} />}
                <span>{badgeMeta.label}</span>
              </span>

              {savedNoticeVisible && (
                <span className="cp-saved-chip">
                  <Check size={11} />
                  <span>已保存</span>
                </span>
              )}
            </div>

            <button
              type="button"
              className="cp-icon-close-btn"
              title="关闭"
              aria-label="关闭通知"
              onClick={actions.onDismissToast}
            >
              <X size={15} />
            </button>
          </div>

          {/* 平滑进度条 */}
          <div className="cp-progress-track">
            <div
              className={progressFillClass}
              style={{ width: `${progressWidthPercent}%` }}
            />
          </div>

          <div className="cp-toast-body">
            {/* 条目基础信息 */}
            {currentItem ? (
              <div className="cp-item-summary">
                <div className="cp-item-title" title={currentItem.title}>
                  {currentItem.title}
                </div>
                <div className="cp-item-meta">
                  <span className="cp-item-author" title={currentItem.author.name}>
                    @{currentItem.author.name}
                  </span>
                  <span className="cp-kind-pill">
                    {currentItem.kind === 'video' ? (
                      <Film size={11} />
                    ) : (
                      <Images size={11} />
                    )}
                    <span>{getMediaKindLabel(currentItem)}</span>
                  </span>
                </div>
              </div>
            ) : toast.title ? (
              <div className="cp-item-summary">
                <div className="cp-item-title" title={toast.title}>
                  {toast.title}
                </div>
              </div>
            ) : null}

            {/* 失败错误提示与重试按钮 */}
            {toast.status === 'failed' && (
              <div className="cp-error-box">
                <div>{toast.error || '采集或下载过程中发生未知错误。'}</div>
                <div className="cp-error-actions">
                  {toast.taskId ? (
                    <button
                      type="button"
                      className="cp-retry-btn"
                      disabled={isRetryingTask}
                      onClick={() => {
                        void handleRetryTaskClick();
                      }}
                    >
                      <RotateCcw size={12} />
                      <span>{isRetryingTask ? '重新入队中...' : '重试下载'}</span>
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="cp-retry-btn"
                      disabled={isCapturing}
                      onClick={actions.onTriggerCapture}
                    >
                      <RotateCcw size={12} />
                      <span>重新采集</span>
                    </button>
                  )}
                </div>
              </div>
            )}

            {/* 快捷分类与标签区 */}
            {currentItem && (
              <>
                <div className="cp-divider" />

                {/* 文件夹分类选择 + 内联新建 */}
                <div className="cp-section">
                  <div className="cp-section-label">
                    <span>归属分类</span>
                  </div>

                  {!isCreatingFolder ? (
                    <div className="cp-folder-row">
                      <select
                        className="cp-select"
                        aria-label="选择归属文件夹"
                        value={currentItem.folderId ?? ''}
                        onChange={(event) => {
                          void handleFolderSelectChange(event.target.value);
                        }}
                      >
                        <option value="">未归类（根目录）</option>
                        {folderOptions.map((option) => (
                          <option key={option.id} value={option.id}>
                            {option.label}
                          </option>
                        ))}
                      </select>

                      <button
                        type="button"
                        className="cp-btn-subtle"
                        onClick={() => {
                          setFolderError(null);
                          setIsCreatingFolder(true);
                        }}
                      >
                        <FolderPlus size={13} />
                        <span>新建</span>
                      </button>
                    </div>
                  ) : (
                    <form
                      className="cp-inline-create-row"
                      onSubmit={(event) => {
                        void handleCreateFolderSubmit(event);
                      }}
                    >
                      <input
                        ref={newFolderInputRef}
                        type="text"
                        className="cp-input"
                        placeholder="输入新文件夹名称..."
                        maxLength={40}
                        value={newFolderName}
                        onChange={(event) => {
                          setNewFolderName(event.target.value);
                          if (folderError) {
                            setFolderError(null);
                          }
                        }}
                        onKeyDown={(event) => {
                          if (event.key === 'Escape') {
                            event.preventDefault();
                            setIsCreatingFolder(false);
                            setNewFolderName('');
                            setFolderError(null);
                          }
                        }}
                      />
                      <button
                        type="submit"
                        className="cp-btn-primary-sm"
                        disabled={isSubmittingFolder}
                      >
                        {isSubmittingFolder ? '...' : '确定'}
                      </button>
                      <button
                        type="button"
                        className="cp-btn-ghost-sm"
                        onClick={() => {
                          setIsCreatingFolder(false);
                          setNewFolderName('');
                          setFolderError(null);
                        }}
                      >
                        取消
                      </button>
                    </form>
                  )}

                  {folderError && (
                    <div className="cp-inline-error">{folderError}</div>
                  )}
                </div>

                {/* 快捷标签编辑 */}
                <div className="cp-section">
                  <div className="cp-section-label">
                    <span>标签</span>
                  </div>

                  {currentItem.tags.length > 0 && (
                    <div className="cp-tags-list">
                      {currentItem.tags.map((tag) => (
                        <span key={tag} className="cp-tag-pill">
                          <span className="cp-tag-text" title={tag}>
                            #{tag}
                          </span>
                          <button
                            type="button"
                            className="cp-tag-remove"
                            aria-label={`移除标签 ${tag}`}
                            title={`移除标签 ${tag}`}
                            onClick={() => {
                              void handleRemoveTag(tag);
                            }}
                          >
                            <X size={11} />
                          </button>
                        </span>
                      ))}
                    </div>
                  )}

                  <div className="cp-inline-create-row">
                    <input
                      type="text"
                      className="cp-input"
                      placeholder="输入标签后回车添加..."
                      maxLength={32}
                      value={tagInput}
                      onChange={(event) => setTagInput(event.target.value)}
                      onKeyDown={handleTagInputKeyDown}
                    />
                    <button
                      type="button"
                      className="cp-btn-subtle"
                      disabled={tagInput.trim().length === 0}
                      title="添加标签"
                      onClick={() => {
                        void handleAddTag(tagInput);
                      }}
                    >
                      <Plus size={13} />
                    </button>
                  </div>

                  {suggestedTags.length > 0 && (
                    <div className="cp-tag-suggestions">
                      {suggestedTags.map((tag) => (
                        <button
                          key={tag.name}
                          type="button"
                          className="cp-tag-suggestion-btn"
                          onClick={() => {
                            void handleAddTag(tag.name);
                          }}
                        >
                          <Plus size={10} />
                          <span>{tag.name}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </>
            )}
          </div>

          {/* 底部操作栏 */}
          <div className="cp-toast-footer">
            {currentItem ? (
              <button
                type="button"
                className="cp-btn-library"
                onClick={() => actions.onOpenLibrary(currentItem.id)}
              >
                <ExternalLink size={13} />
                <span>在管理台查看</span>
              </button>
            ) : (
              <button
                type="button"
                className="cp-btn-library"
                onClick={() => actions.onOpenLibrary(toast.itemId)}
              >
                <ExternalLink size={13} />
                <span>打开管理台</span>
              </button>
            )}

            <button
              type="button"
              className="cp-btn-dismiss"
              onClick={actions.onDismissToast}
            >
              关闭
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
