/**
 * 统一 Isolated World Content Script 运行时（覆盖全部 Tier 2 Recipe 与 Tier 3 Deep Adapter）。
 *
 * 通过按需组合的能力插槽（`BridgeRuntimeCapabilities`）替代各站点千行级重复入口：
 * 1. 核心能力（默认启用）：CaptureOverlay Store、Shadow DOM 浮层交互、Alt+S 热键、
 *    Popup 触发、原生收藏 5 秒撤销 Toast、超大视频确认弹窗、文件夹前置选择与偏好热更新；
 * 2. 可选能力 `fullSync`：登录态感知、首次全量收藏同步提示与分页批次入库、风控被动旁路兜底；
 * 3. 可选能力 `comments`：采集成功后异步抓取前 N 条评论与离线头像；
 * 4. 可选能力 `remoteUncollect`：响应管理台后台静默取消原站收藏；
 * 5. 可选能力 `isolatedDriver`：支持 V2EX 等纯 SSR/DOM 站点免 Main World 桥接直接提取与同步。
 */

import { i18n, translateOptionalKey } from '../i18n/index.ts';
import type {
  CaptureOverlayActions,
  CaptureOverlaySnapshot,
  CaptureOverlayStore,
} from './CaptureOverlay.tsx';
import { createNativeCollectBuffer } from './native-collect-buffer.ts';
import { createOverlayFolderController } from './overlay-folder-state.ts';
import {
  isPageBridgeMessage,
  PAGE_BRIDGE_CHANNEL,
  type CancelFullCollectionSyncMessage,
  type CapturedCommentInput,
  type CapturedPayload,
  type CaptureTriggerSource,
  type CollectionSyncBatchMessage,
  type CollectionSyncDoneMessage,
  type CurrentItemResponseMessage,
  type ItemCommentsResponseMessage,
  type PassiveCollectionListCapturedMessage,
  type PlatformAdapter,
  type RemoteUncollectResponseMessage,
  type RemoteUncollectTargetInput,
  type RemoteUncollectTargetOutcome,
  type RequestCurrentItemMessage,
  type RequestFullCollectionSyncMessage,
  type RequestItemCommentsMessage,
  type RequestLoginStateMessage,
  type RequestRemoteUncollectMessage,
} from '../types/adapter.ts';
import {
  isContentMessage,
  sendToBackground,
  type CaptureAutoSyncExclusionInput,
} from '../types/messages.ts';

const MANUAL_CAPTURE_THROTTLE_MS = 600;
const REQUEST_CURRENT_ITEM_TIMEOUT_MS = 6000;
const REQUEST_COMMENTS_TIMEOUT_MS = 15_000;
const NATIVE_CAPTURE_DEDUPE_WINDOW_MS = 2000;

interface PendingItemRequest {
  resolve: (response: CurrentItemResponseMessage | null) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface PendingCommentsRequest {
  resolve: (response: ItemCommentsResponseMessage | null) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface PendingRemoteUncollectRequest {
  resolve: (response: RemoteUncollectResponseMessage | null) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** 供纯 Isolated World 站点驱动（如 V2EX）与统一运行时协同的回调钩子 */
export interface IsolatedDriverHooks {
  readonly updateState: (
    updater: (prev: CaptureOverlaySnapshot) => CaptureOverlaySnapshot,
  ) => void;
  readonly getAutoSyncAllCollections: () => boolean;
  readonly getPassiveFallbackActive: () => boolean;
  readonly setPassiveFallbackActive: (active: boolean) => void;
  readonly scheduleBannerAutoClose: (delayMs?: number) => void;
  readonly clearBannerTimer: () => void;
  readonly enqueueNativeCollect: (
    payload: CapturedPayload,
    inlineComments?: CapturedCommentInput[],
  ) => void;
  readonly notifyNativeUncollect: (sourceIds: readonly string[]) => Promise<void>;
  readonly submitPayload: (
    payload: CapturedPayload,
    options?: {
      forceSave?: boolean;
      autoSyncExclusion?: CaptureAutoSyncExclusionInput;
      folderId?: string | null;
      inlineComments?: CapturedCommentInput[];
    },
  ) => Promise<{ ok: true; deduplicated?: boolean } | { ok: false; error: string }>;
  readonly registerLoginAccount: (account: {
    accountId: string;
    accountName?: string;
  }) => void;
}

/** 纯 Isolated World 站点驱动接口（无需 Main World 注入） */
export interface IsolatedSiteDriver {
  /** 当前页面是否支持展示悬浮按钮与响应采集（缺省 true） */
  isCapturablePage?: () => boolean;
  /** 不可采集页面点击 Popup 时的错误提示文案 */
  getUncapturableError?: () => string;
  /** 提取当前页原始载荷与可选内联评论 */
  extractCurrentItem: (triggerSource: CaptureTriggerSource) => Promise<{
    rawData: unknown | null;
    inlineComments?: CapturedCommentInput[];
    error?: string;
  }>;
  /** 挂载站点专属 DOM 事件、初始登录态检查等，返回清理函数 */
  setup?: (hooks: IsolatedDriverHooks) => () => void;
  /** 可选：收到全量同步触发时的自定义拉取实现 */
  startCustomFullSync?: () => Promise<void> | void;
  /** 可选：中止自定义全量同步 */
  cancelCustomFullSync?: () => void;
  /** 可选：无主动全量同步时，收到登录态决策回调（用于被动收藏页兜底） */
  onAccountSyncDecision?: (decision: {
    action: 'auto_sync' | 'prompt' | 'none';
    passiveFallbackActive: boolean;
  }) => void;
  /** 可选：直接执行远端取消收藏 */
  remoteUncollect?: (
    items: RemoteUncollectTargetInput[],
  ) => Promise<RemoteUncollectTargetOutcome[]>;
}

/** 站点内容脚本能力声明（按需开启高级特性） */
export interface BridgeRuntimeCapabilities {
  /** 登录态感知与全量收藏夹同步 */
  fullSync?: {
    platformLabelKey?: string;
    passiveSyncedKey: string;
  };
  /** 采集成功后自动拉取并离线保存前 N 条评论 */
  comments?: {
    limit: number;
    shouldCapture?: (payload: CapturedPayload) => boolean;
    parseComments: (
      rawComments: readonly unknown[],
      limit: number,
    ) => CapturedCommentInput[];
    requestTimeoutMs?: number;
  };
  /** 支持管理台后台静默取消原站收藏 */
  remoteUncollect?: {
    timeoutMessageKey?: string;
  };
  /** 可选：自定义读取超时/未就绪/无作品/解析失败文案键 */
  errorMessageKeys?: {
    readTimeout?: string;
    bridgeNotReady?: string;
    noActiveItem?: string;
    parseFailed?: string;
  };
  /** 可选：纯 Isolated World 站点驱动（配置后跳过 Main World postMessage 桥接） */
  isolatedDriver?: IsolatedSiteDriver;
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

function createOverlayStore(initialFloatingVisible: boolean): {
  store: CaptureOverlayStore;
  getState: () => CaptureOverlaySnapshot;
  updateState: (
    updater: (prev: CaptureOverlaySnapshot) => CaptureOverlaySnapshot,
  ) => void;
} {
  let snapshot: CaptureOverlaySnapshot = {
    isCapturing: false,
    floatingButtonEnabled: initialFloatingVisible,
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

export interface BridgeRuntimeHandle {
  store: CaptureOverlayStore;
  actions: CaptureOverlayActions;
  dispose: () => void;
}

export async function createBridgeContentRuntime(
  ctx: {
    onInvalidated: (cb: () => void) => void;
  },
  adapter: PlatformAdapter,
  capabilities: BridgeRuntimeCapabilities = {},
): Promise<BridgeRuntimeHandle> {
  const platform = adapter.id;
  const driver = capabilities.isolatedDriver;
  const isPageCapturable = (): boolean =>
    driver?.isCapturablePage ? driver.isCapturablePage() : true;

  const { store, getState, updateState } = createOverlayStore(
    isPageCapturable(),
  );

  let isMainBridgeReady = false;
  let prefFloatingButtonEnabled = true;
  let autoSyncAllCollections = false;
  let passiveFallbackActive = false;
  let requestCounter = 0;
  let lastManualTriggerAt = 0;
  let pendingOversizedPayload: CapturedPayload | null = null;
  let currentAccount: { accountId: string; accountName?: string } | null = null;
  let activeSyncId: string | null = null;
  let activeSyncFetched = 0;
  let activeSyncAdded = 0;
  let activeSyncDeduplicated = 0;
  let activeSyncSkippedOversized = 0;
  let activeSyncBatchQueue: Promise<void> = Promise.resolve();
  let bannerAutoCloseTimer: ReturnType<typeof setTimeout> | null = null;

  const pendingRequests = new Map<string, PendingItemRequest>();
  const pendingCommentRequests = new Map<string, PendingCommentsRequest>();
  const pendingRemoteUncollectRequests = new Map<
    string,
    PendingRemoteUncollectRequest
  >();
  const recentNativeCaptures = new Map<string, number>();
  const inlineCommentsBySourceId = new Map<string, CapturedCommentInput[]>();

  const applyFloatingVisibility = (): void => {
    updateState((prev) => ({
      ...prev,
      floatingButtonEnabled: prefFloatingButtonEnabled && isPageCapturable(),
    }));
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

  const postToMainWorld = (
    message:
      | RequestCurrentItemMessage
      | RequestItemCommentsMessage
      | RequestRemoteUncollectMessage
      | RequestLoginStateMessage
      | RequestFullCollectionSyncMessage
      | CancelFullCollectionSyncMessage,
  ): void => {
    try {
      window.postMessage(message, getBridgeTargetOrigin());
    } catch {
      // 忽略已销毁窗口 postMessage 异常
    }
  };

  const saveCommentsToBackground = async (
    itemId: string,
    sourceId: string,
    comments: CapturedCommentInput[],
    limit: number,
  ): Promise<void> => {
    if (comments.length === 0) {
      return;
    }
    try {
      await sendToBackground({
        target: 'background',
        type: 'SAVE_ITEM_COMMENTS',
        itemId,
        platform,
        sourceId,
        comments,
        limit,
      });
    } catch (error) {
      console.warn(`[Collect+] Failed to save ${platform} comments:`, error);
    }
  };

  const requestCommentsFromMainWorld = (
    sourceId: string,
    limit: number,
    timeoutMs: number,
  ): Promise<ItemCommentsResponseMessage | null> => {
    requestCounter += 1;
    const requestId = `cp-cmt-${platform}-${Date.now()}-${requestCounter}`;

    return new Promise<ItemCommentsResponseMessage | null>((resolve) => {
      const timer = setTimeout(() => {
        pendingCommentRequests.delete(requestId);
        resolve(null);
      }, timeoutMs);

      pendingCommentRequests.set(requestId, { resolve, timer });
      try {
        window.postMessage(
          {
            channel: PAGE_BRIDGE_CHANNEL,
            direction: 'content-to-main',
            type: 'REQUEST_ITEM_COMMENTS',
            requestId,
            sourceId,
            limit,
          } satisfies RequestItemCommentsMessage,
          getBridgeTargetOrigin(),
        );
      } catch {
        clearTimeout(timer);
        pendingCommentRequests.delete(requestId);
        resolve(null);
      }
    });
  };

  const fetchAndSaveMainWorldComments = async (
    itemId: string,
    sourceId: string,
  ): Promise<void> => {
    const cfg = capabilities.comments;
    if (!cfg) {
      return;
    }
    try {
      const response = await requestCommentsFromMainWorld(
        sourceId,
        cfg.limit,
        cfg.requestTimeoutMs ?? REQUEST_COMMENTS_TIMEOUT_MS,
      );
      if (!response || response.rawComments.length === 0) {
        return;
      }
      const parsed = cfg.parseComments(response.rawComments, cfg.limit);
      await saveCommentsToBackground(itemId, sourceId, parsed, cfg.limit);
    } catch (error) {
      console.warn(`[Collect+] Failed to capture ${platform} comments:`, error);
    }
  };

  const submitCapturedPayload = async (
    payload: CapturedPayload,
    options?: {
      forceSave?: boolean;
      autoSyncExclusion?: CaptureAutoSyncExclusionInput;
      folderId?: string | null;
      inlineComments?: CapturedCommentInput[];
    },
  ): Promise<
    { ok: true; deduplicated?: boolean } | { ok: false; error: string }
  > => {
    const captureResponse = await sendToBackground({
      target: 'background',
      type: 'CAPTURE_ITEM',
      payload,
      ...(options?.forceSave ? { forceSave: true } : {}),
      ...(options?.folderId !== undefined
        ? { folderId: options.folderId }
        : {}),
      ...(options?.autoSyncExclusion
        ? { autoSyncExclusion: options.autoSyncExclusion }
        : {}),
    });

    if (!captureResponse || !captureResponse.ok) {
      const error =
        captureResponse && !captureResponse.ok
          ? captureResponse.error
          : 'Background service did not acknowledge capture.';
      console.warn(`[Collect+] Failed to submit ${platform} item:`, error);
      return { ok: false, error };
    }

    if (captureResponse.skippedOversized) {
      if (captureResponse.notifyMode === 'popup') {
        requestCounter += 1;
        pendingOversizedPayload = payload;
        updateState((prev) => ({
          ...prev,
          oversizedPrompt: {
            id: `cp-${platform}-oversized-${Date.now()}-${requestCounter}`,
            title: payload.title,
            videoSizeBytes: captureResponse.videoSizeBytes,
            thresholdMb: captureResponse.thresholdMb,
          },
        }));
      }
      return { ok: true };
    }

    const canSaveComments =
      !captureResponse.deduplicated &&
      captureResponse.skippedReason !== 'auto_sync_excluded';

    if (canSaveComments) {
      const inline =
        options?.inlineComments ??
        inlineCommentsBySourceId.get(payload.sourceId);
      inlineCommentsBySourceId.delete(payload.sourceId);

      if (inline && inline.length > 0) {
        const limit = capabilities.comments?.limit ?? 100;
        void saveCommentsToBackground(
          captureResponse.itemId,
          payload.sourceId,
          inline.slice(0, limit),
          limit,
        );
      } else if (
        capabilities.comments &&
        !driver &&
        (capabilities.comments.shouldCapture
          ? capabilities.comments.shouldCapture(payload)
          : true)
      ) {
        void fetchAndSaveMainWorldComments(
          captureResponse.itemId,
          payload.sourceId,
        );
      }
    } else {
      inlineCommentsBySourceId.delete(payload.sourceId);
    }

    return { ok: true, deduplicated: captureResponse.deduplicated };
  };

  const folderController = createOverlayFolderController(updateState);

  const nativeCollectBuffer = createNativeCollectBuffer({
    initialEnabled: true,
    onToastChange: (nativeCollectToast) => {
      updateState((prev) => ({ ...prev, nativeCollectToast }));
    },
    onPreviewFolder: (payload) =>
      folderController.previewFolderForPayload(payload),
    onSubmit: async (payload, autoSyncExclusion, folderId) => {
      const inlineComments = inlineCommentsBySourceId.get(payload.sourceId);
      inlineCommentsBySourceId.delete(payload.sourceId);
      await submitCapturedPayload(payload, {
        ...(autoSyncExclusion ? { autoSyncExclusion } : {}),
        ...(folderId !== undefined ? { folderId } : {}),
        ...(inlineComments ? { inlineComments } : {}),
      });
    },
  });

  // ==========================================================================
  // 全量收藏同步与被动旁路兜底（仅当 capabilities.fullSync 开启时启用）
  // ==========================================================================

  const getPlatformDisplayLabel = (): string => {
    const customKey = capabilities.fullSync?.platformLabelKey;
    if (customKey) {
      const translated = translateOptionalKey(customKey);
      if (translated) {
        return translated;
      }
    }
    return translateOptionalKey(`platform.${platform}`) ?? adapter.displayName;
  };

  const startFullCollectionSync = (): void => {
    if (!capabilities.fullSync) {
      return;
    }
    if (driver?.startCustomFullSync) {
      void driver.startCustomFullSync();
      return;
    }
    if (activeSyncId !== null) {
      return;
    }
    requestCounter += 1;
    const syncId = `cp-sync-${platform}-${Date.now()}-${requestCounter}`;
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
    if (!capabilities.fullSync) {
      return;
    }
    try {
      const decision = await sendToBackground({
        target: 'background',
        type: 'CHECK_ACCOUNT_SYNC_ACTION',
        platform,
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
            platformLabel: getPlatformDisplayLabel(),
            ...(account.accountName !== undefined
              ? { accountName: account.accountName }
              : {}),
          },
        }));
      } else {
        driver?.onAccountSyncDecision?.(decision);
      }
    } catch (error) {
      console.warn(
        `[Collect+] Failed to check ${platform} account sync action:`,
        error,
      );
    }
  };

  const handleConfirmFullSync = async (): Promise<void> => {
    const account = currentAccount;
    updateState((prev) => ({ ...prev, syncPrompt: null }));
    if (!account || !capabilities.fullSync) {
      return;
    }
    try {
      const res = await sendToBackground({
        target: 'background',
        type: 'BEGIN_MANUAL_ACCOUNT_SYNC',
        platform,
        accountId: account.accountId,
      });
      if (res && res.ok && res.started) {
        startFullCollectionSync();
      }
    } catch (error) {
      console.warn(`[Collect+] Failed to begin ${platform} full sync:`, error);
    }
  };

  const handleDismissFullSync = async (): Promise<void> => {
    const account = currentAccount;
    updateState((prev) => ({ ...prev, syncPrompt: null }));
    if (!account || !capabilities.fullSync) {
      return;
    }
    await sendToBackground({
      target: 'background',
      type: 'REPORT_ACCOUNT_SYNC_RESULT',
      platform,
      accountId: account.accountId,
      outcome: 'dismissed',
    }).catch(() => undefined);
  };

  const handleCancelFullSync = (): void => {
    if (driver?.cancelCustomFullSync) {
      driver.cancelCustomFullSync();
      return;
    }
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
      const normalized = adapter.normalizeRawData(rawItem, 'auto_sync');
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
        console.warn(
          `[Collect+] ${platform} batch ingest failed after retry:`,
          error,
        );
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
          platform,
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
          platform,
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
        platform,
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
    const fullSync = capabilities.fullSync;
    if (!fullSync) {
      return;
    }
    if (!passiveFallbackActive && !autoSyncAllCollections) {
      return;
    }
    if (message.rawItems.length === 0) {
      return;
    }

    const { added, deduplicated, skippedOversized } = await ingestRawItemsBatch(
      message.rawItems,
    );
    if (
      passiveFallbackActive &&
      (added > 0 || deduplicated > 0 || skippedOversized > 0)
    ) {
      const passiveMsg = translateOptionalKey(fullSync.passiveSyncedKey);
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
          ...(passiveMsg ? { message: passiveMsg } : {}),
        },
      }));
      scheduleBannerAutoClose();
    }
  };

  // ==========================================================================
  // 当前作品拉取与手动采集
  // ==========================================================================

  const requestCurrentItemFromMainWorld = (
    triggerSource: CaptureTriggerSource,
  ): Promise<CurrentItemResponseMessage | null> => {
    requestCounter += 1;
    const requestId = `cp-${platform}-${Date.now()}-${requestCounter}`;

    return new Promise<CurrentItemResponseMessage | null>((resolve) => {
      const timer = setTimeout(() => {
        pendingRequests.delete(requestId);
        resolve(null);
      }, REQUEST_CURRENT_ITEM_TIMEOUT_MS);

      pendingRequests.set(requestId, { resolve, timer });
      try {
        window.postMessage(
          {
            channel: PAGE_BRIDGE_CHANNEL,
            direction: 'content-to-main',
            type: 'REQUEST_CURRENT_ITEM',
            requestId,
            triggerSource,
          } satisfies RequestCurrentItemMessage,
          getBridgeTargetOrigin(),
        );
      } catch {
        clearTimeout(timer);
        pendingRequests.delete(requestId);
        resolve(null);
      }
    });
  };

  const requestRemoteUncollectFromMainWorld = (
    items: RemoteUncollectTargetInput[],
  ): Promise<RemoteUncollectResponseMessage | null> => {
    requestCounter += 1;
    const requestId = `cp-${platform}-uncollect-${Date.now()}-${requestCounter}`;
    const timeoutMs = Math.min(60_000, 15_000 + items.length * 3000);

    return new Promise<RemoteUncollectResponseMessage | null>((resolve) => {
      const timer = setTimeout(() => {
        pendingRemoteUncollectRequests.delete(requestId);
        resolve(null);
      }, timeoutMs);

      pendingRemoteUncollectRequests.set(requestId, { resolve, timer });
      postToMainWorld({
        channel: PAGE_BRIDGE_CHANNEL,
        direction: 'content-to-main',
        type: 'REQUEST_REMOTE_UNCOLLECT',
        requestId,
        items,
      });
    });
  };

  const triggerManualCapture = async (
    triggerSource: CaptureTriggerSource,
    autoSyncExclusion?: CaptureAutoSyncExclusionInput,
    explicitFolderId?: string | null,
  ): Promise<{ ok: true } | { ok: false; error: string }> => {
    if (!isPageCapturable()) {
      return {
        ok: false,
        error:
          driver?.getUncapturableError?.() ??
          i18n.t('background.unsupportedPageForCapture'),
      };
    }

    const now = Date.now();
    if (
      !autoSyncExclusion &&
      now - lastManualTriggerAt < MANUAL_CAPTURE_THROTTLE_MS
    ) {
      return { ok: true };
    }
    if (getState().isCapturing) {
      return { ok: false, error: i18n.t('content.captureInProgress') };
    }

    lastManualTriggerAt = now;
    updateState((prev) => ({ ...prev, isCapturing: true }));

    try {
      let payload: CapturedPayload | null = null;
      let inlineComments: CapturedCommentInput[] | undefined;
      let errMsg: string | undefined;

      if (driver) {
        const extracted = await driver.extractCurrentItem(triggerSource);
        inlineComments = extracted.inlineComments;
        if (extracted.rawData !== null && extracted.rawData !== undefined) {
          payload = adapter.normalizeRawData(extracted.rawData, triggerSource);
        }
        if (!payload && extracted.error) {
          errMsg = extracted.error;
        }
      } else {
        const response = await requestCurrentItemFromMainWorld(triggerSource);
        if (
          response &&
          response.rawData !== null &&
          response.rawData !== undefined
        ) {
          payload = adapter.normalizeRawData(response.rawData, triggerSource);
        }
        if (!payload) {
          const keys = capabilities.errorMessageKeys;
          errMsg = !response
            ? isMainBridgeReady
              ? (keys?.readTimeout
                  ? translateOptionalKey(keys.readTimeout)
                  : undefined) ?? `${adapter.displayName} page data timed out.`
              : (keys?.bridgeNotReady
                  ? translateOptionalKey(keys.bridgeNotReady)
                  : undefined) ??
                `${adapter.displayName} page bridge not ready yet.`
            : response.rawData === null || response.rawData === undefined
              ? (keys?.noActiveItem
                  ? translateOptionalKey(keys.noActiveItem)
                  : undefined) ??
                `No capturable ${adapter.displayName} item found on current page.`
              : (keys?.parseFailed
                  ? translateOptionalKey(keys.parseFailed)
                  : undefined) ??
                `Failed to parse ${adapter.displayName} item metadata.`;
        }
      }

      if (!payload && autoSyncExclusion) {
        payload = nativeCollectBuffer.peekPendingPayload();
      }

      if (!payload) {
        const finalErr =
          errMsg ?? `No capturable ${adapter.displayName} item found.`;
        console.warn(`[Collect+] ${platform} capture unavailable:`, finalErr);
        return { ok: false, error: finalErr };
      }

      nativeCollectBuffer.cancelPending(payload.sourceId);
      const resolvedFolderId = folderController.resolveFolderForCapture(
        triggerSource,
        explicitFolderId,
      );
      const submitResult = await submitCapturedPayload(payload, {
        ...(autoSyncExclusion ? { autoSyncExclusion } : {}),
        ...(resolvedFolderId !== undefined
          ? { folderId: resolvedFolderId }
          : {}),
        ...(inlineComments ? { inlineComments } : {}),
      });
      return submitResult.ok ? { ok: true } : submitResult;
    } catch (error) {
      console.warn(`[Collect+] ${platform} manual capture failed:`, error);
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      updateState((prev) => ({ ...prev, isCapturing: false }));
    }
  };

  // ==========================================================================
  // 原生收藏 / 取消收藏处理
  // ==========================================================================

  const enqueueNativeCollectPayload = (
    payload: CapturedPayload,
    sourceId?: string,
    inlineComments?: CapturedCommentInput[],
  ): void => {
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

    if (inlineComments && inlineComments.length > 0) {
      inlineCommentsBySourceId.set(payload.sourceId, inlineComments);
    }
    nativeCollectBuffer.enqueue(payload);
  };

  const handleNativeCollectCaptured = (
    rawData: unknown,
    sourceId?: string,
  ): void => {
    const payload = adapter.normalizeRawData(rawData, 'native_collect');
    if (!payload) {
      return;
    }
    enqueueNativeCollectPayload(payload, sourceId);
  };

  const handleNativeUncollectCaptured = async (
    sourceIds: readonly string[],
  ): Promise<void> => {
    if (sourceIds.length === 0) {
      return;
    }
    for (const sid of sourceIds) {
      recentNativeCaptures.delete(sid);
      nativeCollectBuffer.cancelPending(sid);
      inlineCommentsBySourceId.delete(sid);
    }
    try {
      await sendToBackground({
        target: 'background',
        type: 'UNCOLLECT_ITEMS',
        platform,
        sourceIds: [...sourceIds],
      });
    } catch (error) {
      console.warn(`[Collect+] ${platform} native uncollect failed:`, error);
    }
  };

  // ==========================================================================
  // 跨上下文事件监听器（Main Bridge + Chrome Runtime + Keydown）
  // ==========================================================================

  const handleWindowMessage = (event: MessageEvent<unknown>): void => {
    if (driver) {
      return;
    }
    if (event.source !== window || !isPageBridgeMessage(event.data)) {
      return;
    }
    if (
      event.data.direction !== 'main-to-content' ||
      event.data.platform !== platform
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
        handleNativeCollectCaptured(event.data.rawData, event.data.sourceId);
        break;

      case 'NATIVE_UNCOLLECT_CAPTURED':
        isMainBridgeReady = true;
        void handleNativeUncollectCaptured(event.data.sourceIds);
        break;

      case 'LOGIN_STATE_DETECTED': {
        isMainBridgeReady = true;
        if (!capabilities.fullSync) {
          break;
        }
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
        isMainBridgeReady = true;
        handleCollectionSyncBatch(event.data);
        break;

      case 'COLLECTION_SYNC_DONE':
        isMainBridgeReady = true;
        void handleCollectionSyncDone(event.data);
        break;

      case 'PASSIVE_COLLECTION_LIST_CAPTURED':
        isMainBridgeReady = true;
        void handlePassiveCollectionListCaptured(event.data);
        break;

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

      case 'REMOTE_UNCOLLECT_RESPONSE': {
        isMainBridgeReady = true;
        const pending = pendingRemoteUncollectRequests.get(
          event.data.requestId,
        );
        if (pending) {
          clearTimeout(pending.timer);
          pendingRemoteUncollectRequests.delete(event.data.requestId);
          pending.resolve(event.data);
        }
        break;
      }
    }
  };

  const handleKeyDown = (event: KeyboardEvent): void => {
    if (event.repeat || !isPageCapturable()) {
      return;
    }
    if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
      return;
    }
    const isKeyS = event.code === 'KeyS' || event.key.toLowerCase() === 's';
    if (!isKeyS || isEditableKeyboardEvent(event)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    void triggerManualCapture('hotkey');
  };

  const handleRuntimeMessage = (
    message: unknown,
    _sender: chrome.runtime.MessageSender,
    sendResponse: (response?: unknown) => void,
  ): boolean => {
    if (!isContentMessage(message)) {
      return false;
    }

    switch (message.type) {
      case 'CONTENT_TRIGGER_CAPTURE': {
        if (!isPageCapturable()) {
          sendResponse({
            ok: false,
            error:
              driver?.getUncapturableError?.() ??
              i18n.t('background.unsupportedPageForCapture'),
          });
          return false;
        }
        void triggerManualCapture(
          message.triggerSource,
          message.autoSyncExclusion,
          message.folderId,
        ).then((result) => sendResponse(result));
        return true;
      }

      case 'CONTENT_PREFERENCES_UPDATED': {
        const prevAutoSync = autoSyncAllCollections;
        prefFloatingButtonEnabled = message.floatingButtonEnabled;
        autoSyncAllCollections = message.autoSyncAllCollections;
        nativeCollectBuffer.setEnabled(message.nativeCollectToastEnabled);
        if (message.autoClassifyEnabled !== undefined) {
          folderController.applyAutoClassifyPreference(
            message.autoClassifyEnabled,
          );
        }
        updateState((prev) => ({
          ...prev,
          floatingButtonEnabled:
            message.floatingButtonEnabled && isPageCapturable(),
          ...(message.autoSyncAllCollections ? { syncPrompt: null } : {}),
        }));
        if (
          capabilities.fullSync &&
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

      case 'CONTENT_FOLDERS_UPDATED': {
        folderController.applyFoldersSnapshot(
          message.folders,
          message.autoClassifyEnabled,
        );
        sendResponse({ ok: true });
        return false;
      }

      case 'CONTENT_REMOTE_UNCOLLECT': {
        if (driver?.remoteUncollect) {
          void driver
            .remoteUncollect(message.items)
            .then((results) => sendResponse({ ok: true, results }))
            .catch((error: unknown) =>
              sendResponse({
                ok: false,
                error: error instanceof Error ? error.message : String(error),
              }),
            );
          return true;
        }
        if (!capabilities.remoteUncollect) {
          sendResponse({
            ok: false,
            error: i18n.t('background.platformUncollectUnsupported'),
          });
          return false;
        }
        void requestRemoteUncollectFromMainWorld(message.items)
          .then((response) => {
            if (!response) {
              const timeoutKey = capabilities.remoteUncollect?.timeoutMessageKey;
              sendResponse({
                ok: false,
                error:
                  (timeoutKey ? translateOptionalKey(timeoutKey) : undefined) ??
                  `${adapter.displayName} page bridge timed out.`,
              });
              return;
            }
            sendResponse({ ok: true, results: response.results });
          })
          .catch((error: unknown) => {
            sendResponse({
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            });
          });
        return true;
      }

      default:
        return false;
    }
  };

  window.addEventListener('message', handleWindowMessage);
  window.addEventListener('keydown', handleKeyDown, true);
  chrome.runtime.onMessage.addListener(handleRuntimeMessage);

  // 初始化用户偏好
  try {
    const prefRes = await sendToBackground({
      target: 'background',
      type: 'GET_USER_PREFERENCES',
    });
    if (prefRes && prefRes.ok) {
      prefFloatingButtonEnabled = prefRes.preferences.floatingButtonEnabled;
      autoSyncAllCollections = prefRes.preferences.autoSyncAllCollections;
      nativeCollectBuffer.setEnabled(
        prefRes.preferences.nativeCollectToastEnabled,
      );
      folderController.applyAutoClassifyPreference(
        prefRes.preferences.autoClassifyEnabled,
      );
      applyFloatingVisibility();
    }
  } catch {
    // 偏好读取失败时保留默认值
  }

  void folderController.refreshFolders();

  let cleanupDriver: (() => void) | undefined;
  if (driver?.setup) {
    cleanupDriver = driver.setup({
      updateState,
      getAutoSyncAllCollections: () => autoSyncAllCollections,
      getPassiveFallbackActive: () => passiveFallbackActive,
      setPassiveFallbackActive: (active) => {
        passiveFallbackActive = active;
      },
      scheduleBannerAutoClose,
      clearBannerTimer,
      enqueueNativeCollect: (payload, inlineComments) => {
        enqueueNativeCollectPayload(payload, payload.sourceId, inlineComments);
      },
      notifyNativeUncollect: handleNativeUncollectCaptured,
      submitPayload: submitCapturedPayload,
      registerLoginAccount: (account) => {
        const isNew = currentAccount?.accountId !== account.accountId;
        currentAccount = account;
        if (isNew) {
          void evaluateAccountSync(account);
        }
      },
    });
  } else if (capabilities.fullSync) {
    // 主动向 Main World 查询登录态，避免 document_start 广播早于监听器挂载
    postToMainWorld({
      channel: PAGE_BRIDGE_CHANNEL,
      direction: 'content-to-main',
      type: 'REQUEST_LOGIN_STATE',
    });
  }

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
    onSkipNativeCollectPersistence: (reason) => {
      nativeCollectBuffer.skipWithReason(reason);
    },
    onSaveNativeCollectNow: () => {
      nativeCollectBuffer.flushNow();
    },
    onPauseNativeCollectTimer: () => {
      nativeCollectBuffer.pauseTimer();
    },
    onResumeNativeCollectTimer: () => {
      nativeCollectBuffer.resumeTimer();
    },
    onSaveNativeCollectToFolder: (folderId) => {
      nativeCollectBuffer.saveWithFolder(folderId);
    },
    onSelectSessionFolder: (folderId) => {
      folderController.setSessionFolderId(folderId);
    },
    onRefreshFolders: () => {
      void folderController.refreshFolders();
    },
  };

  const dispose = (): void => {
    window.removeEventListener('message', handleWindowMessage);
    window.removeEventListener('keydown', handleKeyDown, true);
    chrome.runtime.onMessage.removeListener(handleRuntimeMessage);
    cleanupDriver?.();
    nativeCollectBuffer.dispose();
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

    for (const pending of pendingRemoteUncollectRequests.values()) {
      clearTimeout(pending.timer);
      pending.resolve(null);
    }
    pendingRemoteUncollectRequests.clear();
  };

  ctx.onInvalidated(dispose);

  return { store, actions, dispose };
}
