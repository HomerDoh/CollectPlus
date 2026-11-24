/**
 * Collect+ 抖音 Isolated World Content Script 入口。
 *
 * 职责：
 * 1. 通过 WXT `createShadowRootUi` 挂载样式完全隔离的 React `CaptureOverlay`；
 * 2. 桥接 Main World（`douyin-main.content.ts`）的原生收藏捕获与主动请求当前作品响应；
 * 3. 提供双轨触发：抖音原生收藏拦截 + 页面内 `Alt+S` 兜底热键 + 悬浮按钮 + Popup/Command 指令；
 * 4. 实时接收 Background 推送的下载进度并驱动 Toast 快捷分类与标签编辑交互。
 */

import { createRoot, type Root } from 'react-dom/client';
import { douyinAdapter } from '../adapters/douyin/parser.ts';
import '../components/capture-overlay.css';
import {
  CaptureOverlay,
  type CaptureOverlayActions,
  type CaptureOverlaySnapshot,
  type CaptureOverlayStore,
  type OverlayToastState,
} from '../components/CaptureOverlay.tsx';
import {
  isPageBridgeMessage,
  PAGE_BRIDGE_CHANNEL,
  type CapturedPayload,
  type CaptureTriggerSource,
  type CurrentItemResponseMessage,
  type RequestCurrentItemMessage,
} from '../types/adapter.ts';
import {
  isContentMessage,
  sendToBackground,
  type ContentCaptureStatusMessage,
} from '../types/messages.ts';
import type { FolderNode, TagMeta } from '../types/schema.ts';

/** 手动触发采集的最小防抖/节流间隔（防止 Chrome Command 与页面 keydown 双重触发） */
const MANUAL_CAPTURE_THROTTLE_MS = 600;
/** 请求 Main World 当前活跃作品数据的超时时间（毫秒） */
const REQUEST_CURRENT_ITEM_TIMEOUT_MS = 5000;
/** 同一作品短时间内重复原生收藏回调去重窗口（毫秒） */
const NATIVE_CAPTURE_DEDUPE_WINDOW_MS = 2000;

interface PendingItemRequest {
  resolve: (response: CurrentItemResponseMessage | null) => void;
  timer: ReturnType<typeof setTimeout>;
}

function getBridgeTargetOrigin(): string {
  try {
    const origin = window.location.origin;
    if (origin && origin !== 'null') {
      return origin;
    }
  } catch {
    // 忽略异常并回退通配 origin
  }
  return '*';
}

function isEditableElement(node: EventTarget | null): boolean {
  if (!(node instanceof Element)) {
    return false;
  }
  const tagName = node.tagName.toUpperCase();
  if (tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT') {
    return true;
  }
  if (node instanceof HTMLElement && node.isContentEditable) {
    return true;
  }
  return node.getAttribute('contenteditable') === 'true';
}

function isEditableKeyboardEvent(event: KeyboardEvent): boolean {
  if (isEditableElement(event.target)) {
    return true;
  }
  if (typeof event.composedPath === 'function') {
    const path = event.composedPath();
    for (const node of path) {
      if (isEditableElement(node)) {
        return true;
      }
    }
  }
  return false;
}

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return String(error);
}

/** 创建轻量级外部状态容器，供 `useSyncExternalStore` 订阅更新 */
function createOverlayStore(): {
  store: CaptureOverlayStore;
  getState: () => CaptureOverlaySnapshot;
  updateState: (
    updater: (prev: CaptureOverlaySnapshot) => CaptureOverlaySnapshot,
  ) => void;
} {
  let snapshot: CaptureOverlaySnapshot = {
    isCapturing: false,
    floatingButtonEnabled: true,
    toast: null,
    folders: [],
    tags: [],
  };

  const listeners = new Set<() => void>();

  const store: CaptureOverlayStore = {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };

  const updateState = (
    updater: (prev: CaptureOverlaySnapshot) => CaptureOverlaySnapshot,
  ): void => {
    const next = updater(snapshot);
    if (Object.is(next, snapshot)) {
      return;
    }
    snapshot = next;
    for (const listener of listeners) {
      listener();
    }
  };

  return {
    store,
    getState: () => snapshot,
    updateState,
  };
}

export default defineContentScript({
  matches: ['https://www.douyin.com/*', 'https://douyin.com/*'],
  cssInjectionMode: 'ui',
  runAt: 'document_idle',

  async main(ctx) {
    const { store, getState, updateState } = createOverlayStore();

    let isMainBridgeReady = false;
    let requestCounter = 0;
    let toastRevision = 0;
    let lastManualTriggerAt = 0;

    const pendingRequests = new Map<string, PendingItemRequest>();
    const recentNativeCaptures = new Map<string, number>();
    /** 暂存早于 CAPTURE_ITEM 响应到达的后台状态推送，防止极速下载丢失终态事件 */
    const earlyStatusByItemId = new Map<string, ContentCaptureStatusMessage>();

    const nextRevision = (): number => {
      toastRevision += 1;
      return toastRevision;
    };

    const setToast = (toast: Omit<OverlayToastState, 'revision'>): void => {
      updateState((prev) => ({
        ...prev,
        toast: {
          ...toast,
          revision: nextRevision(),
        },
      }));
    };

    const refreshTaxonomy = async (): Promise<void> => {
      try {
        const response = await sendToBackground({
          target: 'background',
          type: 'GET_TAXONOMY',
        });
        if (response && response.ok) {
          updateState((prev) => ({
            ...prev,
            folders: response.folders,
            tags: response.tags,
          }));
        }
      } catch {
        // 分类读取失败不影响主采集流程
      }
    };

    const submitCapturedPayload = async (
      payload: CapturedPayload,
    ): Promise<void> => {
      setToast({
        visible: true,
        status: 'capturing',
        progress: 0,
        title: payload.title,
      });

      const captureResponse = await sendToBackground({
        target: 'background',
        type: 'CAPTURE_ITEM',
        payload,
      });
      void refreshTaxonomy();

      if (!captureResponse || !captureResponse.ok) {
        const errMsg =
          captureResponse && !captureResponse.ok
            ? captureResponse.error
            : '提交收藏到后台服务失败，请稍后重试。';
        setToast({
          visible: true,
          status: 'failed',
          progress: 0,
          title: payload.title,
          error: errMsg,
        });
        return;
      }

      const { item, itemId, taskId, deduplicated } = captureResponse;
      setToast({
        visible: true,
        status: deduplicated ? 'deduplicated' : 'queued',
        progress: deduplicated ? 100 : 0,
        itemId,
        ...(taskId !== undefined ? { taskId } : {}),
        title: item.title,
        item,
      });

      const earlyStatus = earlyStatusByItemId.get(itemId);
      if (earlyStatus) {
        earlyStatusByItemId.delete(itemId);
        applyContentCaptureStatus(earlyStatus);
      }
    };

    const requestCurrentItemFromMainWorld = (
      triggerSource: CaptureTriggerSource,
    ): Promise<CurrentItemResponseMessage | null> => {
      requestCounter += 1;
      const requestId = `cp-${Date.now()}-${requestCounter}`;

      return new Promise<CurrentItemResponseMessage | null>((resolve) => {
        const timer = setTimeout(() => {
          pendingRequests.delete(requestId);
          resolve(null);
        }, REQUEST_CURRENT_ITEM_TIMEOUT_MS);

        pendingRequests.set(requestId, { resolve, timer });

        const message: RequestCurrentItemMessage = {
          channel: PAGE_BRIDGE_CHANNEL,
          direction: 'content-to-main',
          type: 'REQUEST_CURRENT_ITEM',
          requestId,
          triggerSource,
        };

        try {
          window.postMessage(message, getBridgeTargetOrigin());
        } catch {
          clearTimeout(timer);
          pendingRequests.delete(requestId);
          resolve(null);
        }
      });
    };

    const triggerManualCapture = async (
      triggerSource: CaptureTriggerSource,
    ): Promise<void> => {
      const now = Date.now();
      if (now - lastManualTriggerAt < MANUAL_CAPTURE_THROTTLE_MS) {
        return;
      }
      if (getState().isCapturing) {
        return;
      }

      lastManualTriggerAt = now;
      updateState((prev) => ({
        ...prev,
        isCapturing: true,
      }));

      setToast({
        visible: true,
        status: 'capturing',
        progress: 0,
        title: '正在识别当前页面作品...',
      });

      try {
        const response = await requestCurrentItemFromMainWorld(triggerSource);
        if (!response) {
          setToast({
            visible: true,
            status: 'failed',
            progress: 0,
            error: isMainBridgeReady
              ? '读取当前页面作品超时，请稍后重试。'
              : '页面采集桥接未响应，请刷新当前抖音页面后再试。',
          });
          return;
        }

        if (response.rawData === null || response.rawData === undefined) {
          setToast({
            visible: true,
            status: 'failed',
            progress: 0,
            error:
              response.error ??
              '未能定位当前正在浏览的抖音视频或图集，请进入作品详情或播放视频后重试。',
          });
          return;
        }

        const payload = douyinAdapter.normalizeRawData(
          response.rawData,
          triggerSource,
        );
        if (!payload) {
          setToast({
            visible: true,
            status: 'failed',
            progress: 0,
            error:
              '未能从当前作品中解析出有效的视频或图集链接，请刷新页面后重试。',
          });
          return;
        }

        await submitCapturedPayload(payload);
      } catch (error) {
        setToast({
          visible: true,
          status: 'failed',
          progress: 0,
          error: `采集失败：${formatErrorMessage(error)}`,
        });
      } finally {
        updateState((prev) => ({
          ...prev,
          isCapturing: false,
        }));
      }
    };

    const handleNativeCollectCaptured = async (
      rawData: unknown,
      sourceId?: string,
    ): Promise<void> => {
      const payload = douyinAdapter.normalizeRawData(rawData, 'native_collect');
      if (!payload) {
        return;
      }

      const dedupeId = sourceId ?? payload.sourceId;
      const now = Date.now();
      const lastCapturedAt = recentNativeCaptures.get(dedupeId);
      if (
        lastCapturedAt !== undefined &&
        now - lastCapturedAt < NATIVE_CAPTURE_DEDUPE_WINDOW_MS
      ) {
        return;
      }
      recentNativeCaptures.set(dedupeId, now);

      // 清理过期去重记录，防止长时间浏览无限增长
      if (recentNativeCaptures.size > 64) {
        for (const [key, ts] of recentNativeCaptures.entries()) {
          if (now - ts >= NATIVE_CAPTURE_DEDUPE_WINDOW_MS) {
            recentNativeCaptures.delete(key);
          }
        }
      }

      try {
        await submitCapturedPayload(payload);
      } catch (error) {
        setToast({
          visible: true,
          status: 'failed',
          progress: 0,
          title: payload.title,
          error: `同步原站收藏失败：${formatErrorMessage(error)}`,
        });
      }
    };

    const applyContentCaptureStatus = (
      message: ContentCaptureStatusMessage,
    ): void => {
      let matchedCurrentToast = false;

      updateState((prev) => {
        const current = prev.toast;
        if (!current) {
          return prev;
        }

        const matchesItem = current.itemId === message.itemId;
        const matchesTask =
          message.taskId !== undefined && current.taskId === message.taskId;
        if (!matchesItem && !matchesTask) {
          return prev;
        }
        matchedCurrentToast = true;

        // 终态防乱序回退：已进入 staged 后忽略迟到的 queued/downloading 进度包
        if (
          current.status === 'staged' &&
          (message.status === 'queued' || message.status === 'downloading')
        ) {
          return prev;
        }

        // 若用户已手动关闭 Toast，仅在未隐藏时实时更新进度，避免突然打扰
        if (!current.visible && message.status === 'downloading') {
          return prev;
        }

        const nextProgress =
          message.progress !== undefined
            ? Math.max(0, Math.min(100, Math.round(message.progress)))
            : message.status === 'staged' || message.status === 'deduplicated'
              ? 100
              : current.progress;

        const nextSyncStatus =
          message.status === 'staged'
            ? 'opfs_staged'
            : message.status === 'failed'
              ? 'failed'
              : current.item?.syncStatus;

        const nextItem =
          current.item && nextSyncStatus !== undefined
            ? { ...current.item, syncStatus: nextSyncStatus }
            : current.item;

        const statusChanged = current.status !== message.status;

        return {
          ...prev,
          toast: {
            ...current,
            visible: true,
            status: message.status,
            progress: nextProgress,
            ...(message.taskId !== undefined ? { taskId: message.taskId } : {}),
            ...(message.title !== undefined ? { title: message.title } : {}),
            ...(message.error !== undefined
              ? { error: message.error }
              : message.status !== 'failed'
                ? { error: undefined }
                : {}),
            ...(nextItem !== undefined ? { item: nextItem } : {}),
            revision: statusChanged ? nextRevision() : current.revision,
          },
        };
      });

      if (!matchedCurrentToast) {
        const existingEarly = earlyStatusByItemId.get(message.itemId);
        if (
          existingEarly?.status === 'staged' &&
          (message.status === 'queued' || message.status === 'downloading')
        ) {
          return;
        }
        earlyStatusByItemId.set(message.itemId, message);
        if (earlyStatusByItemId.size > 32) {
          const oldestKey = earlyStatusByItemId.keys().next().value;
          if (oldestKey !== undefined) {
            earlyStatusByItemId.delete(oldestKey);
          }
        }
      }
    };

    // 1. 监听 Main World 桥接消息
    ctx.addEventListener(window, 'message', (event: MessageEvent<unknown>) => {
      if (event.source !== window) {
        return;
      }
      if (!isPageBridgeMessage(event.data)) {
        return;
      }
      if (event.data.direction !== 'main-to-content') {
        return;
      }

      switch (event.data.type) {
        case 'BRIDGE_READY': {
          isMainBridgeReady = true;
          break;
        }

        case 'CURRENT_ITEM_RESPONSE': {
          isMainBridgeReady = true;
          const pending = pendingRequests.get(event.data.requestId);
          if (pending) {
            clearTimeout(pending.timer);
            pendingRequests.delete(event.data.requestId);
            pending.resolve(event.data);
          }
          break;
        }

        case 'NATIVE_COLLECT_CAPTURED': {
          isMainBridgeReady = true;
          void handleNativeCollectCaptured(
            event.data.rawData,
            event.data.sourceId,
          );
          break;
        }
      }
    });

    // 2. 监听来自 Background / Popup 的控制指令与进度推送
    const runtimeMessageListener = (
      message: unknown,
      _sender: chrome.runtime.MessageSender,
      sendResponse: (response?: unknown) => void,
    ): boolean => {
      if (!isContentMessage(message)) {
        return false;
      }

      switch (message.type) {
        case 'CONTENT_TRIGGER_CAPTURE': {
          void triggerManualCapture(message.triggerSource);
          sendResponse({ ok: true });
          return false;
        }

        case 'CONTENT_CAPTURE_STATUS': {
          applyContentCaptureStatus(message);
          sendResponse({ ok: true });
          return false;
        }
      }
    };

    chrome.runtime.onMessage.addListener(runtimeMessageListener);

    // 3. 页面内 Alt+S 兜底热键（忽略表单输入与可编辑区域，兼容 Shadow DOM 焦点）
    const keydownListener = (event: KeyboardEvent): void => {
      if (event.repeat) {
        return;
      }
      if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
        return;
      }
      const isKeyS = event.code === 'KeyS' || event.key.toLowerCase() === 's';
      if (!isKeyS) {
        return;
      }
      if (isEditableKeyboardEvent(event)) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      void triggerManualCapture('hotkey');
    };

    window.addEventListener('keydown', keydownListener, true);

    // 上下文失效时清理消息监听器、热键监听与挂起请求定时器
    ctx.onInvalidated(() => {
      chrome.runtime.onMessage.removeListener(runtimeMessageListener);
      window.removeEventListener('keydown', keydownListener, true);
      for (const pending of pendingRequests.values()) {
        clearTimeout(pending.timer);
        pending.resolve(null);
      }
      pendingRequests.clear();
    });

    // 4. 构造浮层交互动作并挂载 Shadow DOM UI
    const actions: CaptureOverlayActions = {
      onTriggerCapture: () => {
        void triggerManualCapture('floating_button');
      },

      onDismissToast: () => {
        updateState((prev) => {
          if (!prev.toast || !prev.toast.visible) {
            return prev;
          }
          return {
            ...prev,
            toast: {
              ...prev.toast,
              visible: false,
            },
          };
        });
      },

      onSelectFolder: async (itemId: string, folderId: string | null) => {
        try {
          const response = await sendToBackground({
            target: 'background',
            type: 'UPDATE_ITEM_CLASSIFICATION',
            itemId,
            folderId,
          });
          if (response && response.ok) {
            updateState((prev) => {
              if (!prev.toast || prev.toast.item?.id !== itemId) {
                return prev;
              }
              return {
                ...prev,
                toast: {
                  ...prev.toast,
                  item: response.item,
                },
              };
            });
            return true;
          }
        } catch {
          // 忽略通信错误并返回 false
        }
        return false;
      },

      onCreateFolder: async (
        itemId: string,
        name: string,
        parentId: string | null,
      ): Promise<
        { ok: true; folder: FolderNode } | { ok: false; error: string }
      > => {
        try {
          const createRes = await sendToBackground({
            target: 'background',
            type: 'CREATE_FOLDER_QUICK',
            name,
            parentId,
          });

          if (!createRes || !createRes.ok) {
            return {
              ok: false,
              error:
                createRes && !createRes.ok
                  ? createRes.error
                  : '创建文件夹失败',
            };
          }

          const newFolder = createRes.folder;

          const updateRes = await sendToBackground({
            target: 'background',
            type: 'UPDATE_ITEM_CLASSIFICATION',
            itemId,
            folderId: newFolder.id,
          });

          updateState((prev) => {
            const exists = prev.folders.some((f) => f.id === newFolder.id);
            const nextFolders: FolderNode[] = exists
              ? prev.folders
              : [...prev.folders, newFolder];

            const nextToast =
              prev.toast && prev.toast.item?.id === itemId && updateRes?.ok
                ? {
                    ...prev.toast,
                    item: updateRes.item,
                  }
                : prev.toast;

            return {
              ...prev,
              folders: nextFolders,
              toast: nextToast,
            };
          });

          void refreshTaxonomy();
          return { ok: true, folder: newFolder };
        } catch (error) {
          return {
            ok: false,
            error: formatErrorMessage(error),
          };
        }
      },

      onUpdateTags: async (itemId: string, tags: string[]) => {
        try {
          const response = await sendToBackground({
            target: 'background',
            type: 'UPDATE_ITEM_CLASSIFICATION',
            itemId,
            tags,
          });
          if (response && response.ok) {
            updateState((prev) => {
              const existingTagNames = new Set(prev.tags.map((t) => t.name));
              const extraTags: TagMeta[] = [];
              const now = Date.now();
              for (const tagName of response.item.tags) {
                if (!existingTagNames.has(tagName)) {
                  extraTags.push({
                    name: tagName,
                    color: '#6366f1',
                    createdAt: now,
                  });
                }
              }

              const nextToast =
                prev.toast && prev.toast.item?.id === itemId
                  ? {
                      ...prev.toast,
                      item: response.item,
                    }
                  : prev.toast;

              return {
                ...prev,
                tags:
                  extraTags.length > 0
                    ? [...prev.tags, ...extraTags]
                    : prev.tags,
                toast: nextToast,
              };
            });
            return true;
          }
        } catch {
          // 忽略通信错误并返回 false
        }
        return false;
      },

      onRetryTask: async (taskId: string) => {
        try {
          const response = await sendToBackground({
            target: 'background',
            type: 'RETRY_DOWNLOAD_TASK',
            taskId,
          });
          if (response && response.ok) {
            updateState((prev) => {
              if (!prev.toast || prev.toast.taskId !== taskId) {
                return prev;
              }
              return {
                ...prev,
                toast: {
                  ...prev.toast,
                  status: 'queued',
                  progress: 0,
                  error: undefined,
                  revision: nextRevision(),
                },
              };
            });
            return true;
          }
        } catch {
          // 忽略重试失败
        }
        return false;
      },

      onOpenLibrary: (itemId?: string) => {
        void sendToBackground({
          target: 'background',
          type: 'OPEN_LIBRARY_PAGE',
          ...(itemId !== undefined ? { itemId } : {}),
        }).catch(() => undefined);
      },
    };

    const ui = await createShadowRootUi<Root>(ctx, {
      name: 'collect-plus-overlay',
      position: 'overlay',
      zIndex: 2147483647,
      anchor: 'body',
      onMount(container) {
        const appMount = document.createElement('div');
        container.append(appMount);
        const root = createRoot(appMount);
        root.render(<CaptureOverlay store={store} actions={actions} />);
        return root;
      },
      onRemove(root) {
        root?.unmount();
      },
    });

    ui.mount();
  },
});
