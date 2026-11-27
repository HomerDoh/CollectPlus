/**
 * Collect+ Bilibili Isolated World Content Script 独立入口。
 *
 * 职责：
 * 1. 通过 WXT `createShadowRootUi` 挂载样式隔离的 `CaptureOverlay`；
 * 2. 桥接 Bilibili Main World（`bilibili-main.content.ts`）的视频采集、评论抓取与登录全量同步；
 * 3. 响应原生收藏/取消收藏、悬浮按钮、`Alt+S` 快捷键与 Popup 触发指令。
 */

import { createRoot, type Root } from 'react-dom/client';
import {
  bilibiliAdapter,
  parseBilibiliComments,
} from '../adapters/bilibili/parser.ts';
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

const MANUAL_CAPTURE_THROTTLE_MS = 600;
const REQUEST_CURRENT_ITEM_TIMEOUT_MS = 6000;
const REQUEST_COMMENTS_TIMEOUT_MS = 15_000;
const BILIBILI_COMMENT_CAPTURE_LIMIT = 100;
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
    for (const node of event.composedPath()) {
      if (isEditableElement(node)) {
        return true;
      }
    }
  }
  return false;
}

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

  return { store, getState: () => snapshot, updateState };
}

export default defineContentScript({
  matches: [
    'https://www.bilibili.com/*',
    'https://bilibili.com/*',
    'https://space.bilibili.com/*',
  ],
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
        // 忽略已销毁窗口异常
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
      const syncId = `cp-bili-sync-${Date.now()}-${requestCounter}`;
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
          platform: 'bilibili',
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
              platformLabel: 'B站',
              ...(account.accountName !== undefined
                ? { accountName: account.accountName }
                : {}),
            },
          }));
        }
      } catch (error) {
        console.warn('[Collect+] Failed to check Bilibili account sync:', error);
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
          platform: 'bilibili',
          accountId: account.accountId,
        });
        if (res && res.ok && res.started) {
          startFullCollectionSync();
        }
      } catch (error) {
        console.warn('[Collect+] Failed to begin Bilibili full sync:', error);
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
        platform: 'bilibili',
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
        const normalized = bilibiliAdapter.normalizeRawData(rawItem, 'auto_sync');
        if (normalized) {
          payloads.push(normalized);
        }
      }
      if (payloads.length === 0) {
        return { added: 0, deduplicated: 0, skippedOversized: 0 };
      }

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
          console.warn('[Collect+] Bilibili batch ingest failed:', error);
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
            platform: 'bilibili',
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
            platform: 'bilibili',
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
          platform: 'bilibili',
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
            message: '已通过被动旁路同步本页B站收藏视频',
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
      for (const id of sourceIds) {
        recentNativeCaptures.delete(id);
      }
      try {
        await sendToBackground({
          target: 'background',
          type: 'UNCOLLECT_ITEMS',
          platform: 'bilibili',
          sourceIds: [...sourceIds],
        });
      } catch (error) {
        console.warn('[Collect+] Bilibili native uncollect sync failed:', error);
      }
    };

    const requestCommentsFromMainWorld = (
      sourceId: string,
      limit = BILIBILI_COMMENT_CAPTURE_LIMIT,
    ): Promise<ItemCommentsResponseMessage | null> => {
      requestCounter += 1;
      const requestId = `cp-bili-cmt-${Date.now()}-${requestCounter}`;

      return new Promise<ItemCommentsResponseMessage | null>((resolve) => {
        const timer = setTimeout(() => {
          pendingCommentRequests.delete(requestId);
          resolve(null);
        }, REQUEST_COMMENTS_TIMEOUT_MS);

        pendingCommentRequests.set(requestId, { resolve, timer });
        postToMainWorld({
          channel: PAGE_BRIDGE_CHANNEL,
          direction: 'content-to-main',
          type: 'REQUEST_ITEM_COMMENTS',
          requestId,
          sourceId,
          limit,
        });
      });
    };

    const fetchAndSaveVideoComments = async (
      itemId: string,
      sourceId: string,
    ): Promise<void> => {
      try {
        const response = await requestCommentsFromMainWorld(
          sourceId,
          BILIBILI_COMMENT_CAPTURE_LIMIT,
        );
        if (!response || response.rawComments.length === 0) {
          return;
        }
        const comments = parseBilibiliComments(
          response.rawComments,
          BILIBILI_COMMENT_CAPTURE_LIMIT,
        );
        if (comments.length === 0) {
          return;
        }
        await sendToBackground({
          target: 'background',
          type: 'SAVE_ITEM_COMMENTS',
          itemId,
          platform: 'bilibili',
          sourceId,
          comments,
          limit: BILIBILI_COMMENT_CAPTURE_LIMIT,
        });
      } catch (error) {
        console.warn('[Collect+] Failed to capture Bilibili comments:', error);
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
          '[Collect+] Failed to submit Bilibili item:',
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
              id: `cp-bili-oversized-${Date.now()}-${requestCounter}`,
              title: payload.title,
              videoSizeBytes: captureResponse.videoSizeBytes,
              thresholdMb: captureResponse.thresholdMb,
            },
          }));
        }
        return;
      }

      if (!captureResponse.deduplicated && payload.kind === 'video') {
        void fetchAndSaveVideoComments(captureResponse.itemId, payload.sourceId);
      }
    };

    const requestCurrentItemFromMainWorld = (
      triggerSource: CaptureTriggerSource,
    ): Promise<CurrentItemResponseMessage | null> => {
      requestCounter += 1;
      const requestId = `cp-bili-${Date.now()}-${requestCounter}`;

      return new Promise<CurrentItemResponseMessage | null>((resolve) => {
        const timer = setTimeout(() => {
          pendingRequests.delete(requestId);
          resolve(null);
        }, REQUEST_CURRENT_ITEM_TIMEOUT_MS);

        pendingRequests.set(requestId, { resolve, timer });
        postToMainWorld({
          channel: PAGE_BRIDGE_CHANNEL,
          direction: 'content-to-main',
          type: 'REQUEST_CURRENT_ITEM',
          requestId,
          triggerSource,
        });
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
      updateState((prev) => ({ ...prev, isCapturing: true }));

      try {
        const response = await requestCurrentItemFromMainWorld(triggerSource);
        if (!response) {
          console.warn(
            isMainBridgeReady
              ? '[Collect+] Timed out reading current Bilibili video.'
              : '[Collect+] Bilibili main world bridge is not ready yet.',
          );
          return;
        }
        if (response.rawData === null || response.rawData === undefined) {
          console.warn(
            '[Collect+] No active Bilibili video found:',
            response.error ?? 'empty rawData',
          );
          return;
        }
        const payload = bilibiliAdapter.normalizeRawData(
          response.rawData,
          triggerSource,
        );
        if (!payload) {
          console.warn('[Collect+] Failed to normalize Bilibili video payload.');
          return;
        }
        await submitCapturedPayload(payload);
      } catch (error) {
        console.warn('[Collect+] Bilibili manual capture failed:', error);
      } finally {
        updateState((prev) => ({ ...prev, isCapturing: false }));
      }
    };

    const handleNativeCollectCaptured = async (
      rawData: unknown,
      sourceId?: string,
    ): Promise<void> => {
      const payload = bilibiliAdapter.normalizeRawData(
        rawData,
        'native_collect',
      );
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
        console.warn('[Collect+] Bilibili native collect sync failed:', error);
      }
    };

    // 1. 监听 Main World 桥接消息（严格隔离 platform === 'bilibili'）
    ctx.addEventListener(window, 'message', (event: MessageEvent<unknown>) => {
      if (event.source !== window) {
        return;
      }
      if (!isPageBridgeMessage(event.data)) {
        return;
      }
      if (
        event.data.direction !== 'main-to-content' ||
        event.data.platform !== 'bilibili'
      ) {
        return;
      }

      switch (event.data.type) {
        case 'BRIDGE_READY':
          isMainBridgeReady = true;
          break;

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

        case 'NATIVE_COLLECT_CAPTURED':
          isMainBridgeReady = true;
          void handleNativeCollectCaptured(
            event.data.rawData,
            event.data.sourceId,
          );
          break;

        case 'NATIVE_UNCOLLECT_CAPTURED':
          isMainBridgeReady = true;
          void handleNativeUncollectCaptured(event.data.sourceIds);
          break;

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

        case 'COLLECTION_SYNC_BATCH':
          handleCollectionSyncBatch(event.data);
          break;

        case 'COLLECTION_SYNC_DONE':
          void handleCollectionSyncDone(event.data);
          break;

        case 'PASSIVE_COLLECTION_LIST_CAPTURED':
          void handlePassiveCollectionListCaptured(event.data);
          break;

        case 'ITEM_COMMENTS_RESPONSE': {
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

    // 2. 监听来自 Background / Popup 的指令与偏好变更广播
    const handleRuntimeMessage = (
      message: unknown,
      _sender: chrome.runtime.MessageSender,
      sendResponse: (response: unknown) => void,
    ): boolean => {
      if (!isContentMessage(message)) {
        return false;
      }

      if (message.type === 'CONTENT_TRIGGER_CAPTURE') {
        void triggerManualCapture(message.triggerSource);
        sendResponse({ ok: true });
        return false;
      }

      if (message.type === 'CONTENT_PREFERENCES_UPDATED') {
        autoSyncAllCollections = message.autoSyncAllCollections;
        updateState((prev) => ({
          ...prev,
          floatingButtonEnabled: message.floatingButtonEnabled,
        }));
        if (message.autoSyncAllCollections && currentAccount) {
          void evaluateAccountSync(currentAccount);
        }
        sendResponse({ ok: true });
        return false;
      }

      return false;
    };

    chrome.runtime.onMessage.addListener(handleRuntimeMessage);

    // 3. 页面内 Alt+S 兜底快捷键（避开输入框与评论编辑框）
    ctx.addEventListener(window, 'keydown', (event: KeyboardEvent) => {
      if (
        !event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        event.repeat
      ) {
        return;
      }
      const isKeyS =
        event.code === 'KeyS' || event.key.toLowerCase() === 's';
      if (!isKeyS || isEditableKeyboardEvent(event)) {
        return;
      }
      event.preventDefault();
      void triggerManualCapture('hotkey');
    });

    // 4. 初始化用户偏好设置并向 Main World 查询登录态
    try {
      const prefRes = await sendToBackground({
        target: 'background',
        type: 'GET_USER_PREFERENCES',
      });
      if (prefRes && prefRes.ok) {
        autoSyncAllCollections = prefRes.preferences.autoSyncAllCollections;
        updateState((prev) => ({
          ...prev,
          floatingButtonEnabled: prefRes.preferences.floatingButtonEnabled,
        }));
      }
    } catch {
      // 偏好读取失败时保留默认值
    }

    postToMainWorld({
      channel: PAGE_BRIDGE_CHANNEL,
      direction: 'content-to-main',
      type: 'REQUEST_LOGIN_STATE',
    });

    // 5. 通过 Shadow DOM 挂载完全样式隔离的悬浮采集浮层
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

    const ui = await createShadowRootUi(ctx, {
      name: 'collect-plus-bilibili-overlay',
      position: 'overlay',
      zIndex: 2147483640,
      onMount(container) {
        const root = createRoot(container);
        root.render(<CaptureOverlay store={store} actions={actions} />);
        return root;
      },
      onRemove(root?: Root) {
        root?.unmount();
      },
    });

    ui.mount();

    ctx.onInvalidated(() => {
      chrome.runtime.onMessage.removeListener(handleRuntimeMessage);
      clearBannerTimer();
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
      ui.remove();
    });
  },
});
