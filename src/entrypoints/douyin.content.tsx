/**
 * Collect+ 抖音 Isolated World Content Script 入口。
 *
 * 职责：
 * 1. 通过 WXT `createShadowRootUi` 挂载样式完全隔离的 React `CaptureOverlay`（仅轻悬浮采集按钮，无页面弹窗）；
 * 2. 桥接 Main World（`douyin-main.content.ts`）的原生收藏捕获与主动请求当前作品响应；
 * 3. 提供静默采集触发：抖音原生收藏拦截 + 页面内 `Alt+S` 兜底热键 + 悬浮按钮 + Popup/Command 指令。
 */

import { createRoot, type Root } from 'react-dom/client';
import {
  douyinAdapter,
  parseDouyinComments,
} from '../adapters/douyin/parser.ts';
import '../components/capture-overlay.css';
import {
  CaptureOverlay,
  type CaptureOverlayActions,
  type CaptureOverlaySnapshot,
  type CaptureOverlayStore,
} from '../components/CaptureOverlay.tsx';
import {
  isPageBridgeMessage,
  PAGE_BRIDGE_CHANNEL,
  type CancelFullCollectionSyncMessage,
  type CapturedPayload,
  type CaptureTriggerSource,
  type CollectionSyncBatchMessage,
  type CollectionSyncDoneMessage,
  type CurrentItemResponseMessage,
  type ItemCommentsResponseMessage,
  type PassiveCollectionListCapturedMessage,
  type RequestCurrentItemMessage,
  type RequestFullCollectionSyncMessage,
  type RequestItemCommentsMessage,
  type RequestLoginStateMessage,
} from '../types/adapter.ts';
import { isContentMessage, sendToBackground } from '../types/messages.ts';

/** 手动触发采集的最小防抖/节流间隔（防止 Chrome Command 与页面 keydown 双重触发） */
const MANUAL_CAPTURE_THROTTLE_MS = 600;
/** 请求 Main World 当前活跃作品数据的超时时间（毫秒） */
const REQUEST_CURRENT_ITEM_TIMEOUT_MS = 5000;
/** 请求 Main World 拉取单条视频前 100 条评论的超时时间（毫秒） */
const REQUEST_COMMENTS_TIMEOUT_MS = 15_000;
/** 单条抖音视频同步保存的最大评论条数 */
const DOUYIN_COMMENT_CAPTURE_LIMIT = 100;
/** 同一作品短时间内重复原生收藏回调去重窗口（毫秒） */
const NATIVE_CAPTURE_DEDUPE_WINDOW_MS = 2000;

interface PendingItemRequest {
  resolve: (response: CurrentItemResponseMessage | null) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface PendingCommentsRequest {
  resolve: (response: ItemCommentsResponseMessage | null) => void;
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
    syncPrompt: null,
    syncBanner: null,
    oversizedPrompt: null,
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
    let lastManualTriggerAt = 0;
    let autoSyncAllCollections = false;
    let currentAccount: { accountId: string; accountName?: string } | null =
      null;
    let activeSyncId: string | null = null;
    let activeSyncFetched = 0;
    let activeSyncAdded = 0;
    let activeSyncDeduplicated = 0;
    let activeSyncSkippedOversized = 0;
    let activeSyncBatchQueue: Promise<void> = Promise.resolve();
    let passiveFallbackActive = false;
    let bannerAutoCloseTimer: ReturnType<typeof setTimeout> | null = null;
    let pendingOversizedPayload: CapturedPayload | null = null;

    const pendingRequests = new Map<string, PendingItemRequest>();
    const pendingCommentRequests = new Map<string, PendingCommentsRequest>();
    const recentNativeCaptures = new Map<string, number>();

    const postToMainWorld = (
      message:
        | RequestCurrentItemMessage
        | RequestItemCommentsMessage
        | RequestLoginStateMessage
        | RequestFullCollectionSyncMessage
        | CancelFullCollectionSyncMessage,
    ): void => {
      try {
        window.postMessage(message, getBridgeTargetOrigin());
      } catch {
        // 忽略跨域或已销毁窗口 postMessage 异常
      }
    };

    const clearBannerTimer = (): void => {
      if (bannerAutoCloseTimer !== null) {
        clearTimeout(bannerAutoCloseTimer);
        bannerAutoCloseTimer = null;
      }
    };

    const scheduleBannerAutoClose = (delayMs = 6000): void => {
      clearBannerTimer();
      bannerAutoCloseTimer = setTimeout(() => {
        bannerAutoCloseTimer = null;
        updateState((prev) =>
          prev.syncBanner?.phase === 'completed'
            ? { ...prev, syncBanner: null }
            : prev,
        );
      }, delayMs);
    };

    const startFullCollectionSync = (): void => {
      if (activeSyncId !== null) {
        return;
      }
      requestCounter += 1;
      const syncId = `cp-sync-${Date.now()}-${requestCounter}`;
      activeSyncId = syncId;
      activeSyncFetched = 0;
      activeSyncAdded = 0;
      activeSyncDeduplicated = 0;
      activeSyncSkippedOversized = 0;
      activeSyncBatchQueue = Promise.resolve();
      clearBannerTimer();

      updateState((prev) => ({
        ...prev,
        syncPrompt: null,
        syncBanner: {
          phase: 'syncing',
          fetchedCount: 0,
          addedCount: 0,
          deduplicatedCount: 0,
        },
      }));

      postToMainWorld({
        channel: PAGE_BRIDGE_CHANNEL,
        direction: 'content-to-main',
        type: 'REQUEST_FULL_COLLECTION_SYNC',
        syncId,
      });
    };

    const evaluateAccountSync = async (account: {
      accountId: string;
      accountName?: string;
    }): Promise<void> => {
      try {
        const decision = await sendToBackground({
          target: 'background',
          type: 'CHECK_ACCOUNT_SYNC_ACTION',
          platform: 'douyin',
          accountId: account.accountId,
        });
        if (!decision || !decision.ok) {
          return;
        }
        passiveFallbackActive = decision.passiveFallbackActive;

        if (decision.action === 'auto_sync') {
          startFullCollectionSync();
        } else if (decision.action === 'prompt') {
          updateState((prev) => ({
            ...prev,
            syncPrompt: {
              platformLabel: '抖音',
              ...(account.accountName !== undefined
                ? { accountName: account.accountName }
                : {}),
            },
          }));
        }
      } catch (error) {
        console.warn('[Collect+] Failed to check account sync action:', error);
      }
    };

    const handleConfirmFullSync = async (): Promise<void> => {
      const account = currentAccount;
      updateState((prev) => ({ ...prev, syncPrompt: null }));
      if (!account) {
        return;
      }
      try {
        const res = await sendToBackground({
          target: 'background',
          type: 'BEGIN_MANUAL_ACCOUNT_SYNC',
          platform: 'douyin',
          accountId: account.accountId,
        });
        if (res && res.ok && res.started) {
          startFullCollectionSync();
        }
      } catch (error) {
        console.warn('[Collect+] Failed to begin manual full sync:', error);
      }
    };

    const handleDismissFullSync = async (): Promise<void> => {
      const account = currentAccount;
      updateState((prev) => ({ ...prev, syncPrompt: null }));
      if (!account) {
        return;
      }
      await sendToBackground({
        target: 'background',
        type: 'REPORT_ACCOUNT_SYNC_RESULT',
        platform: 'douyin',
        accountId: account.accountId,
        outcome: 'dismissed',
      }).catch(() => undefined);
    };

    const handleCancelFullSync = (): void => {
      if (!activeSyncId) {
        return;
      }
      postToMainWorld({
        channel: PAGE_BRIDGE_CHANNEL,
        direction: 'content-to-main',
        type: 'CANCEL_FULL_COLLECTION_SYNC',
        syncId: activeSyncId,
      });
    };

    const ingestRawItemsBatch = async (
      rawItems: readonly unknown[],
    ): Promise<{
      added: number;
      deduplicated: number;
      skippedOversized: number;
    }> => {
      const payloads: CapturedPayload[] = [];
      for (const rawItem of rawItems) {
        const normalized = douyinAdapter.normalizeRawData(rawItem, 'auto_sync');
        if (normalized) {
          payloads.push(normalized);
        }
      }
      if (payloads.length === 0) {
        return { added: 0, deduplicated: 0, skippedOversized: 0 };
      }

      // 容错：MV3 Service Worker 在多页同步间隙休眠/重启时瞬断通道，重试一次唤醒 SW
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const response = await sendToBackground({
            target: 'background',
            type: 'CAPTURE_BATCH_ITEMS',
            payloads,
          });
          if (!response || !response.ok) {
            return { added: 0, deduplicated: 0, skippedOversized: 0 };
          }
          return {
            added: response.capturedCount,
            deduplicated: response.deduplicatedCount,
            skippedOversized: response.skippedOversizedCount,
          };
        } catch (error) {
          if (attempt === 0) {
            await new Promise<void>((resolve) => setTimeout(resolve, 250));
            continue;
          }
          console.warn('[Collect+] Batch ingest failed after retry:', error);
        }
      }
      return { added: 0, deduplicated: 0, skippedOversized: 0 };
    };

    const handleCollectionSyncBatch = (
      message: CollectionSyncBatchMessage,
    ): void => {
      if (message.syncId !== activeSyncId) {
        return;
      }
      const batchSyncId = message.syncId;
      activeSyncBatchQueue = activeSyncBatchQueue.then(async () => {
        if (activeSyncId !== batchSyncId) {
          return;
        }
        const { added, deduplicated, skippedOversized } =
          await ingestRawItemsBatch(message.rawItems);
        activeSyncFetched += message.rawItems.length;
        activeSyncAdded += added;
        activeSyncDeduplicated += deduplicated;
        activeSyncSkippedOversized += skippedOversized;

        updateState((prev) => ({
          ...prev,
          syncBanner: {
            phase: 'syncing',
            fetchedCount: activeSyncFetched,
            addedCount: activeSyncAdded,
            deduplicatedCount: activeSyncDeduplicated,
            ...(activeSyncSkippedOversized > 0
              ? { skippedOversizedCount: activeSyncSkippedOversized }
              : {}),
          },
        }));
      });
    };

    const handleCollectionSyncDone = async (
      message: CollectionSyncDoneMessage,
    ): Promise<void> => {
      if (message.syncId !== activeSyncId) {
        return;
      }

      // 等待所有批次入库完成后再上报同步结果与最终统计
      await activeSyncBatchQueue;
      if (activeSyncId !== message.syncId) {
        return;
      }
      activeSyncId = null;

      const account = currentAccount;
      if (message.status === 'completed') {
        if (account) {
          await sendToBackground({
            target: 'background',
            type: 'REPORT_ACCOUNT_SYNC_RESULT',
            platform: 'douyin',
            accountId: account.accountId,
            outcome: 'synced',
            syncedCount: activeSyncAdded,
          }).catch(() => undefined);
        }
        updateState((prev) => ({
          ...prev,
          syncBanner: {
            phase: 'completed',
            fetchedCount: activeSyncFetched,
            addedCount: activeSyncAdded,
            deduplicatedCount: activeSyncDeduplicated,
            ...(activeSyncSkippedOversized > 0
              ? { skippedOversizedCount: activeSyncSkippedOversized }
              : {}),
          },
        }));
        scheduleBannerAutoClose();
        return;
      }

      if (message.status === 'fallback_needed') {
        passiveFallbackActive = true;
        if (account) {
          await sendToBackground({
            target: 'background',
            type: 'REPORT_ACCOUNT_SYNC_RESULT',
            platform: 'douyin',
            accountId: account.accountId,
            outcome: 'fallback_needed',
          }).catch(() => undefined);
        }
        updateState((prev) => ({
          ...prev,
          syncBanner: {
            phase: 'fallback',
            fetchedCount: activeSyncFetched,
            addedCount: activeSyncAdded,
            deduplicatedCount: activeSyncDeduplicated,
            ...(message.error !== undefined ? { message: message.error } : {}),
            ...(message.fallbackUrl !== undefined
              ? { fallbackUrl: message.fallbackUrl }
              : {}),
          },
        }));
        return;
      }

      if (account) {
        await sendToBackground({
          target: 'background',
          type: 'REPORT_ACCOUNT_SYNC_RESULT',
          platform: 'douyin',
          accountId: account.accountId,
          outcome: 'failed',
        }).catch(() => undefined);
      }

      if (message.status === 'cancelled') {
        updateState((prev) => ({ ...prev, syncBanner: null }));
      } else {
        updateState((prev) => ({
          ...prev,
          syncBanner: {
            phase: 'error',
            fetchedCount: activeSyncFetched,
            addedCount: activeSyncAdded,
            deduplicatedCount: activeSyncDeduplicated,
            ...(message.error !== undefined ? { message: message.error } : {}),
          },
        }));
      }
    };

    const handlePassiveCollectionListCaptured = async (
      message: PassiveCollectionListCapturedMessage,
    ): Promise<void> => {
      if (!passiveFallbackActive && !autoSyncAllCollections) {
        return;
      }
      if (message.rawItems.length === 0) {
        return;
      }

      const { added, deduplicated, skippedOversized } =
        await ingestRawItemsBatch(message.rawItems);
      if (
        passiveFallbackActive &&
        (added > 0 || deduplicated > 0 || skippedOversized > 0)
      ) {
        updateState((prev) => ({
          ...prev,
          syncBanner: {
            phase: 'completed',
            fetchedCount: message.rawItems.length,
            addedCount: added,
            deduplicatedCount: deduplicated,
            ...(skippedOversized > 0
              ? { skippedOversizedCount: skippedOversized }
              : {}),
            message: '已通过被动旁路同步本页收藏作品',
          },
        }));
        scheduleBannerAutoClose();
      }
    };

    const handleNativeUncollectCaptured = async (
      sourceIds: readonly string[],
    ): Promise<void> => {
      if (sourceIds.length === 0) {
        return;
      }
      // 取消收藏后清理短时收藏去重窗口，确保用户在 2 秒内误删后立即重新收藏不会被吞掉
      for (const id of sourceIds) {
        recentNativeCaptures.delete(id);
      }
      try {
        await sendToBackground({
          target: 'background',
          type: 'UNCOLLECT_ITEMS',
          platform: 'douyin',
          sourceIds: [...sourceIds],
        });
      } catch (error) {
        console.warn('[Collect+] Native uncollect sync failed:', error);
      }
    };

    const requestCommentsFromMainWorld = (
      sourceId: string,
      limit = DOUYIN_COMMENT_CAPTURE_LIMIT,
    ): Promise<ItemCommentsResponseMessage | null> => {
      requestCounter += 1;
      const requestId = `cp-cmt-${Date.now()}-${requestCounter}`;

      return new Promise<ItemCommentsResponseMessage | null>((resolve) => {
        const timer = setTimeout(() => {
          pendingCommentRequests.delete(requestId);
          resolve(null);
        }, REQUEST_COMMENTS_TIMEOUT_MS);

        pendingCommentRequests.set(requestId, { resolve, timer });

        const message: RequestItemCommentsMessage = {
          channel: PAGE_BRIDGE_CHANNEL,
          direction: 'content-to-main',
          type: 'REQUEST_ITEM_COMMENTS',
          requestId,
          sourceId,
          limit,
        };

        try {
          window.postMessage(message, getBridgeTargetOrigin());
        } catch {
          clearTimeout(timer);
          pendingCommentRequests.delete(requestId);
          resolve(null);
        }
      });
    };

    const fetchAndSaveVideoComments = async (
      itemId: string,
      sourceId: string,
    ): Promise<void> => {
      try {
        const response = await requestCommentsFromMainWorld(
          sourceId,
          DOUYIN_COMMENT_CAPTURE_LIMIT,
        );
        if (!response || response.rawComments.length === 0) {
          return;
        }

        const comments = parseDouyinComments(
          response.rawComments,
          DOUYIN_COMMENT_CAPTURE_LIMIT,
        );
        if (comments.length === 0) {
          return;
        }

        await sendToBackground({
          target: 'background',
          type: 'SAVE_ITEM_COMMENTS',
          itemId,
          platform: 'douyin',
          sourceId,
          comments,
          limit: DOUYIN_COMMENT_CAPTURE_LIMIT,
        });
      } catch (error) {
        console.warn('[Collect+] Failed to capture Douyin comments:', error);
      }
    };

    const submitCapturedPayload = async (
      payload: CapturedPayload,
      options?: { forceSave?: boolean },
    ): Promise<void> => {
      const captureResponse = await sendToBackground({
        target: 'background',
        type: 'CAPTURE_ITEM',
        payload,
        ...(options?.forceSave ? { forceSave: true } : {}),
      });

      if (!captureResponse || !captureResponse.ok) {
        console.warn(
          '[Collect+] Failed to submit captured item:',
          captureResponse && !captureResponse.ok
            ? captureResponse.error
            : 'Background service did not acknowledge capture.',
        );
        return;
      }

      if (captureResponse.skippedOversized) {
        if (captureResponse.notifyMode === 'popup') {
          requestCounter += 1;
          pendingOversizedPayload = payload;
          updateState((prev) => ({
            ...prev,
            oversizedPrompt: {
              id: `cp-dy-oversized-${Date.now()}-${requestCounter}`,
              title: payload.title,
              videoSizeBytes: captureResponse.videoSizeBytes,
              thresholdMb: captureResponse.thresholdMb,
            },
          }));
        }
        return;
      }

      // 收藏视频成功后异步拉取前 100 条评论并保存，不阻塞视频本身的即时收藏与下载
      if (!captureResponse.deduplicated && payload.kind === 'video') {
        void fetchAndSaveVideoComments(captureResponse.itemId, payload.sourceId);
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

      try {
        const response = await requestCurrentItemFromMainWorld(triggerSource);
        if (!response) {
          console.warn(
            isMainBridgeReady
              ? '[Collect+] Timed out reading current Douyin item.'
              : '[Collect+] Main world bridge is not ready yet.',
          );
          return;
        }

        if (response.rawData === null || response.rawData === undefined) {
          console.warn(
            '[Collect+] No active Douyin item found:',
            response.error ?? 'empty rawData',
          );
          return;
        }

        const payload = douyinAdapter.normalizeRawData(
          response.rawData,
          triggerSource,
        );
        if (!payload) {
          console.warn(
            '[Collect+] Failed to normalize current Douyin item media URLs.',
          );
          return;
        }

        await submitCapturedPayload(payload);
      } catch (error) {
        console.warn('[Collect+] Manual capture failed:', error);
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
        console.warn('[Collect+] Native collect sync failed:', error);
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

        case 'NATIVE_UNCOLLECT_CAPTURED': {
          isMainBridgeReady = true;
          void handleNativeUncollectCaptured(event.data.sourceIds);
          break;
        }

        case 'LOGIN_STATE_DETECTED': {
          isMainBridgeReady = true;
          const nextAccount = {
            accountId: event.data.accountId,
            ...(event.data.accountName !== undefined
              ? { accountName: event.data.accountName }
              : {}),
          };
          const isNewAccount =
            currentAccount?.accountId !== nextAccount.accountId;
          currentAccount = nextAccount;
          if (isNewAccount) {
            void evaluateAccountSync(nextAccount);
          }
          break;
        }

        case 'COLLECTION_SYNC_BATCH': {
          isMainBridgeReady = true;
          handleCollectionSyncBatch(event.data);
          break;
        }

        case 'COLLECTION_SYNC_DONE': {
          isMainBridgeReady = true;
          void handleCollectionSyncDone(event.data);
          break;
        }

        case 'PASSIVE_COLLECTION_LIST_CAPTURED': {
          isMainBridgeReady = true;
          void handlePassiveCollectionListCaptured(event.data);
          break;
        }

        case 'ITEM_COMMENTS_RESPONSE': {
          isMainBridgeReady = true;
          const pending = pendingCommentRequests.get(event.data.requestId);
          if (pending) {
            clearTimeout(pending.timer);
            pendingCommentRequests.delete(event.data.requestId);
            pending.resolve(event.data);
          }
          break;
        }
      }
    });

    // 2. 监听来自 Background / Popup 的控制指令
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

        case 'CONTENT_PREFERENCES_UPDATED': {
          const prevAutoSync = autoSyncAllCollections;
          autoSyncAllCollections = message.autoSyncAllCollections;
          updateState((prev) => ({
            ...prev,
            floatingButtonEnabled: message.floatingButtonEnabled,
            ...(message.autoSyncAllCollections ? { syncPrompt: null } : {}),
          }));
          if (
            !prevAutoSync &&
            message.autoSyncAllCollections &&
            currentAccount &&
            activeSyncId === null
          ) {
            void evaluateAccountSync(currentAccount);
          }
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

    // 上下文失效时清理消息监听器、热键监听、挂起请求与进行中的全量同步
    ctx.onInvalidated(() => {
      chrome.runtime.onMessage.removeListener(runtimeMessageListener);
      window.removeEventListener('keydown', keydownListener, true);
      clearBannerTimer();
      if (activeSyncId !== null) {
        postToMainWorld({
          channel: PAGE_BRIDGE_CHANNEL,
          direction: 'content-to-main',
          type: 'CANCEL_FULL_COLLECTION_SYNC',
          syncId: activeSyncId,
        });
        activeSyncId = null;
      }
      for (const pending of pendingRequests.values()) {
        clearTimeout(pending.timer);
        pending.resolve(null);
      }
      pendingRequests.clear();
      for (const pending of pendingCommentRequests.values()) {
        clearTimeout(pending.timer);
        pending.resolve(null);
      }
      pendingCommentRequests.clear();
    });

    // 4. 构造浮层交互动作并挂载 Shadow DOM UI
    const actions: CaptureOverlayActions = {
      onTriggerCapture: () => {
        void triggerManualCapture('floating_button');
      },
      onConfirmFullSync: () => {
        void handleConfirmFullSync();
      },
      onDismissFullSync: () => {
        void handleDismissFullSync();
      },
      onCancelFullSync: () => {
        handleCancelFullSync();
      },
      onOpenFallbackPage: (url: string) => {
        window.open(url, '_blank', 'noopener,noreferrer');
      },
      onDismissSyncBanner: () => {
        clearBannerTimer();
        updateState((prev) => ({ ...prev, syncBanner: null }));
      },
      onConfirmOversizedSave: () => {
        const payloadToSave = pendingOversizedPayload;
        pendingOversizedPayload = null;
        updateState((prev) => ({ ...prev, oversizedPrompt: null }));
        if (payloadToSave) {
          void submitCapturedPayload(payloadToSave, { forceSave: true });
        }
      },
      onSkipOversized: () => {
        pendingOversizedPayload = null;
        updateState((prev) => ({ ...prev, oversizedPrompt: null }));
      },
    };

    try {
      const prefResponse = await sendToBackground({
        target: 'background',
        type: 'GET_USER_PREFERENCES',
      });
      if (prefResponse && prefResponse.ok) {
        autoSyncAllCollections =
          prefResponse.preferences.autoSyncAllCollections;
        updateState((prev) => ({
          ...prev,
          floatingButtonEnabled: prefResponse.preferences.floatingButtonEnabled,
        }));
      }
    } catch {
      // 偏好读取失败时保持默认显示悬浮按钮
    }

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

    // 主动向 Main World 查询是否已捕获登录态，避免 document_start 广播早于监听器挂载
    postToMainWorld({
      channel: PAGE_BRIDGE_CHANNEL,
      direction: 'content-to-main',
      type: 'REQUEST_LOGIN_STATE',
    });
  },
});
