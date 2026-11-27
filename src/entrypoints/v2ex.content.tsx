/**
 * Collect+ V2EX Isolated World Content Script 独立入口。
 *
 * V2EX 为服务端渲染 HTML，Isolated Content Script 可直接读取完整 DOM 与同源 Cookie，
 * 无需额外的 Main World 注入脚本：
 * 1. 通过 WXT `createShadowRootUi` 挂载样式隔离的 `CaptureOverlay`；
 * 2. 在 `/t/{id}` 主题页支持悬浮按钮、`Alt+S`、Popup 触发与原生「加入收藏/取消收藏」点击拦截；
 * 3. 在已登录页面支持 `/my/topics` 收藏列表全量同步与 Cloudflare/429 风控自动降级。
 */

import { createRoot, type Root } from 'react-dom/client';
import {
  extractFavoriteListFromDocument,
  extractTopicIdFromUrl,
  extractV2exLoginAccount,
  extractV2exTopicFromDocument,
  isV2exChallengeDocument,
  type V2exRawTopicData,
} from '../adapters/v2ex/dom-extractor.ts';
import { parseV2exComments, v2exAdapter } from '../adapters/v2ex/parser.ts';
import '../components/capture-overlay.css';
import {
  CaptureOverlay,
  type CaptureOverlayActions,
  type CaptureOverlaySnapshot,
  type CaptureOverlayStore,
} from '../components/CaptureOverlay.tsx';
import { createNativeCollectBuffer } from '../components/native-collect-buffer.ts';
import type { CaptureTriggerSource } from '../types/adapter.ts';
import {
  isContentMessage,
  sendToBackground,
  type CaptureAutoSyncExclusionInput,
} from '../types/messages.ts';

const MANUAL_CAPTURE_THROTTLE_MS = 600;
const V2EX_COMMENT_CAPTURE_LIMIT = 100;
const PENDING_FAVORITE_STORAGE_KEY = 'collect-plus:v2ex:pending-favorite';
const PENDING_FAVORITE_TTL_MS = 15_000;
const FULL_SYNC_MAX_PAGES = 30;
const FULL_SYNC_PAGE_MIN_DELAY_MS = 1500;
const FULL_SYNC_PAGE_JITTER_MS = 600;
const FULL_SYNC_TOPIC_DELAY_MS = 600;
const FULL_SYNC_TOPIC_JITTER_MS = 350;
const V2EX_FAVORITES_URL = 'https://www.v2ex.com/my/topics';

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

function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(new DOMException('Aborted', 'AbortError'));
  }
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
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

function writePendingFavoriteMarker(topicId: string): void {
  try {
    sessionStorage.setItem(
      PENDING_FAVORITE_STORAGE_KEY,
      JSON.stringify({ topicId, ts: Date.now() }),
    );
  } catch {
    // 忽略隐私模式或禁用 storage 异常
  }
}

function consumePendingFavoriteMarker(expectedTopicId: string): boolean {
  try {
    const raw = sessionStorage.getItem(PENDING_FAVORITE_STORAGE_KEY);
    if (!raw) {
      return false;
    }
    sessionStorage.removeItem(PENDING_FAVORITE_STORAGE_KEY);
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) {
      return false;
    }
    const rec = parsed as Record<string, unknown>;
    return (
      rec.topicId === expectedTopicId &&
      typeof rec.ts === 'number' &&
      Date.now() - rec.ts <= PENDING_FAVORITE_TTL_MS
    );
  } catch {
    return false;
  }
}

function extractFavoriteHrefTopicId(
  href: string,
  action: 'favorite' | 'unfavorite',
): string | null {
  const pattern =
    action === 'favorite'
      ? /\/favorite\/topic\/(\d+)/
      : /\/unfavorite\/topic\/(\d+)/;
  const match = pattern.exec(href);
  return match?.[1] ?? null;
}

export default defineContentScript({
  matches: ['https://www.v2ex.com/*', 'https://v2ex.com/*'],
  cssInjectionMode: 'ui',
  runAt: 'document_idle',

  async main(ctx) {
    const currentTopicId = extractTopicIdFromUrl(window.location.href);
    const isTopicPage = currentTopicId !== null;
    const isFavoritesListPage =
      window.location.pathname.replace(/\/+$/, '') === '/my/topics';

    const { store, getState, updateState } = createOverlayStore(isTopicPage);

    let prefFloatingButtonEnabled = true;
    let autoSyncAllCollections = false;
    let passiveFallbackActive = false;
    let lastManualTriggerAt = 0;
    let activeSyncAbortController: AbortController | null = null;
    let bannerAutoCloseTimer: ReturnType<typeof setTimeout> | null = null;
    const currentAccount = extractV2exLoginAccount(document);

    const applyFloatingVisibility = (): void => {
      updateState((prev) => ({
        ...prev,
        floatingButtonEnabled: isTopicPage && prefFloatingButtonEnabled,
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

    const topicRepliesBySourceId = new Map<string, V2exRawTopicData['replies']>();

    const submitTopicData = async (
      topicData: V2exRawTopicData,
      triggerSource: CaptureTriggerSource,
      autoSyncExclusion?: CaptureAutoSyncExclusionInput,
    ): Promise<'added' | 'deduplicated' | 'failed'> => {
      const payload = v2exAdapter.normalizeRawData(topicData, triggerSource);
      if (!payload) {
        return 'failed';
      }

      const captureResponse = await sendToBackground({
        target: 'background',
        type: 'CAPTURE_ITEM',
        payload,
        ...(autoSyncExclusion ? { autoSyncExclusion } : {}),
      });

      if (!captureResponse || !captureResponse.ok) {
        console.warn(
          '[Collect+] Failed to submit V2EX topic:',
          captureResponse && !captureResponse.ok
            ? captureResponse.error
            : 'Background service did not acknowledge capture.',
        );
        return 'failed';
      }

      if (captureResponse.skippedOversized) {
        return 'failed';
      }

      if (
        !captureResponse.deduplicated &&
        captureResponse.skippedReason !== 'auto_sync_excluded' &&
        topicData.replies.length > 0
      ) {
        const comments = parseV2exComments(
          topicData.replies,
          V2EX_COMMENT_CAPTURE_LIMIT,
        );
        if (comments.length > 0) {
          void sendToBackground({
            target: 'background',
            type: 'SAVE_ITEM_COMMENTS',
            itemId: captureResponse.itemId,
            platform: 'v2ex',
            sourceId: payload.sourceId,
            comments,
            limit: V2EX_COMMENT_CAPTURE_LIMIT,
          }).catch((error: unknown) => {
            console.warn('[Collect+] Failed to save V2EX replies:', error);
          });
        }
      }

      return captureResponse.deduplicated ? 'deduplicated' : 'added';
    };

    const nativeCollectBuffer = createNativeCollectBuffer({
      initialEnabled: true,
      onToastChange: (nativeCollectToast) => {
        updateState((prev) => ({ ...prev, nativeCollectToast }));
      },
      onSubmit: async (payload, autoSyncExclusion) => {
        const captureResponse = await sendToBackground({
          target: 'background',
          type: 'CAPTURE_ITEM',
          payload,
          ...(autoSyncExclusion ? { autoSyncExclusion } : {}),
        });
        const replies = topicRepliesBySourceId.get(payload.sourceId);
        topicRepliesBySourceId.delete(payload.sourceId);
        if (
          captureResponse &&
          captureResponse.ok &&
          !captureResponse.skippedOversized &&
          !captureResponse.deduplicated &&
          captureResponse.skippedReason !== 'auto_sync_excluded' &&
          replies &&
          replies.length > 0
        ) {
          const comments = parseV2exComments(
            replies,
            V2EX_COMMENT_CAPTURE_LIMIT,
          );
          if (comments.length > 0) {
            void sendToBackground({
              target: 'background',
              type: 'SAVE_ITEM_COMMENTS',
              itemId: captureResponse.itemId,
              platform: 'v2ex',
              sourceId: payload.sourceId,
              comments,
              limit: V2EX_COMMENT_CAPTURE_LIMIT,
            }).catch((error: unknown) => {
              console.warn('[Collect+] Failed to save V2EX replies:', error);
            });
          }
        }
      },
    });

    const enqueueNativeTopicCollect = (topicData: V2exRawTopicData): void => {
      const payload = v2exAdapter.normalizeRawData(topicData, 'native_collect');
      if (!payload) {
        return;
      }
      topicRepliesBySourceId.set(payload.sourceId, topicData.replies);
      nativeCollectBuffer.enqueue(payload);
    };

    const triggerManualCapture = async (
      triggerSource: CaptureTriggerSource,
      autoSyncExclusion?: CaptureAutoSyncExclusionInput,
    ): Promise<{ ok: true } | { ok: false; error: string }> => {
      const now = Date.now();
      if (
        !autoSyncExclusion &&
        now - lastManualTriggerAt < MANUAL_CAPTURE_THROTTLE_MS
      ) {
        return { ok: true };
      }
      if (getState().isCapturing) {
        return { ok: false, error: '当前正在处理采集请求，请稍候。' };
      }

      lastManualTriggerAt = now;
      updateState((prev) => ({ ...prev, isCapturing: true }));

      try {
        const topicData = extractV2exTopicFromDocument(
          document,
          window.location.href,
        );
        if (!topicData) {
          const errMsg = '请打开具体的 V2EX 主题页（/t/...）后再操作。';
          console.warn(
            '[Collect+] Current V2EX page is not a collectible topic page.',
          );
          return { ok: false, error: errMsg };
        }
        nativeCollectBuffer.cancelPending(topicData.topicId);
        const outcome = await submitTopicData(
          topicData,
          triggerSource,
          autoSyncExclusion,
        );
        if (outcome === 'failed') {
          return { ok: false, error: '提交 V2EX 主题元数据失败，请稍后重试。' };
        }
        return { ok: true };
      } catch (error) {
        console.warn('[Collect+] V2EX manual capture failed:', error);
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      } finally {
        updateState((prev) => ({ ...prev, isCapturing: false }));
      }
    };

    const fetchAndParseHtml = async (
      pathOrUrl: string,
      signal?: AbortSignal,
    ): Promise<{ status: number; doc: Document | null }> => {
      const response = await fetch(pathOrUrl, {
        method: 'GET',
        credentials: 'include',
        signal,
      });
      if (response.status < 200 || response.status >= 300) {
        return { status: response.status, doc: null };
      }
      const html = await response.text();
      if (!html) {
        return { status: response.status, doc: null };
      }
      const doc = new DOMParser().parseFromString(html, 'text/html');
      return { status: response.status, doc };
    };

    const syncTopicIdsList = async (
      topicIds: readonly string[],
      signal: AbortSignal,
      counters: { fetched: number; added: number; deduplicated: number },
    ): Promise<'ok' | 'rate_limited' | 'cancelled'> => {
      for (let i = 0; i < topicIds.length; i += 1) {
        if (signal.aborted) {
          return 'cancelled';
        }
        const topicId = topicIds[i];
        if (!topicId) {
          continue;
        }
        if (i > 0) {
          const delay =
            FULL_SYNC_TOPIC_DELAY_MS +
            Math.floor(Math.random() * FULL_SYNC_TOPIC_JITTER_MS);
          await sleepAbortable(delay, signal);
        }

        const topicUrl = `https://www.v2ex.com/t/${encodeURIComponent(topicId)}`;
        const { status, doc } = await fetchAndParseHtml(
          `/t/${encodeURIComponent(topicId)}`,
          signal,
        );
        if (status === 403 || status === 429) {
          return 'rate_limited';
        }
        if (!doc || isV2exChallengeDocument(doc)) {
          return 'rate_limited';
        }

        const topicData = extractV2exTopicFromDocument(doc, topicUrl);
        if (!topicData) {
          continue;
        }
        const outcome = await submitTopicData(topicData, 'auto_sync');
        counters.fetched += 1;
        if (outcome === 'added') {
          counters.added += 1;
        } else if (outcome === 'deduplicated') {
          counters.deduplicated += 1;
        }

        updateState((prev) => ({
          ...prev,
          syncBanner: {
            phase: 'syncing',
            fetchedCount: counters.fetched,
            addedCount: counters.added,
            deduplicatedCount: counters.deduplicated,
          },
        }));
      }
      return 'ok';
    };

    const startFullCollectionSync = async (): Promise<void> => {
      if (activeSyncAbortController !== null || !currentAccount) {
        return;
      }

      const controller = new AbortController();
      activeSyncAbortController = controller;
      clearBannerTimer();

      const counters = { fetched: 0, added: 0, deduplicated: 0 };
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

      const finishWithFallback = async (reason: string): Promise<void> => {
        passiveFallbackActive = true;
        await sendToBackground({
          target: 'background',
          type: 'REPORT_ACCOUNT_SYNC_RESULT',
          platform: 'v2ex',
          accountId: currentAccount.accountId,
          outcome: 'fallback_needed',
        }).catch(() => undefined);
        updateState((prev) => ({
          ...prev,
          syncBanner: {
            phase: 'fallback',
            fetchedCount: counters.fetched,
            addedCount: counters.added,
            deduplicatedCount: counters.deduplicated,
            message: reason,
            fallbackUrl: V2EX_FAVORITES_URL,
          },
        }));
      };

      try {
        const seenTopicIds = new Set<string>();

        for (let page = 1; page <= FULL_SYNC_MAX_PAGES; page += 1) {
          if (controller.signal.aborted) {
            break;
          }
          if (page > 1) {
            const delay =
              FULL_SYNC_PAGE_MIN_DELAY_MS +
              Math.floor(Math.random() * FULL_SYNC_PAGE_JITTER_MS);
            await sleepAbortable(delay, controller.signal);
          }

          const { status, doc } = await fetchAndParseHtml(
            `/my/topics?p=${page}`,
            controller.signal,
          );
          if (status === 403 || status === 429) {
            await finishWithFallback(
              `V2EX 收藏列表触发限流（HTTP ${status}），请前往「我的主题收藏」页浏览被动同步。`,
            );
            return;
          }
          if (!doc) {
            await finishWithFallback('无法读取 V2EX 收藏列表，已切入被动同步模式。');
            return;
          }

          const parsedList = extractFavoriteListFromDocument(doc, page);
          if (parsedList.isChallengePage) {
            await finishWithFallback(
              'V2EX 触发访问校验，已安全中止主动拉取。请前往「我的主题收藏」页浏览。',
            );
            return;
          }

          const batchTopicIds = parsedList.topicIds.filter((id) => {
            if (seenTopicIds.has(id)) {
              return false;
            }
            seenTopicIds.add(id);
            return true;
          });

          if (batchTopicIds.length > 0) {
            const syncOutcome = await syncTopicIdsList(
              batchTopicIds,
              controller.signal,
              counters,
            );
            if (syncOutcome === 'rate_limited') {
              await finishWithFallback(
                '抓取主题正文时触发 V2EX 限流，已保留已同步条目并切入被动模式。',
              );
              return;
            }
            if (syncOutcome === 'cancelled') {
              break;
            }
          }

          if (!parsedList.hasNextPage || parsedList.topicIds.length === 0) {
            break;
          }
        }

        if (controller.signal.aborted) {
          await sendToBackground({
            target: 'background',
            type: 'REPORT_ACCOUNT_SYNC_RESULT',
            platform: 'v2ex',
            accountId: currentAccount.accountId,
            outcome: 'failed',
          }).catch(() => undefined);
          updateState((prev) => ({ ...prev, syncBanner: null }));
          return;
        }

        await sendToBackground({
          target: 'background',
          type: 'REPORT_ACCOUNT_SYNC_RESULT',
          platform: 'v2ex',
          accountId: currentAccount.accountId,
          outcome: 'synced',
          syncedCount: counters.added,
        }).catch(() => undefined);

        updateState((prev) => ({
          ...prev,
          syncBanner: {
            phase: 'completed',
            fetchedCount: counters.fetched,
            addedCount: counters.added,
            deduplicatedCount: counters.deduplicated,
          },
        }));
        scheduleBannerAutoClose();
      } catch (error) {
        if (
          controller.signal.aborted ||
          (error instanceof DOMException && error.name === 'AbortError')
        ) {
          updateState((prev) => ({ ...prev, syncBanner: null }));
        } else {
          await sendToBackground({
            target: 'background',
            type: 'REPORT_ACCOUNT_SYNC_RESULT',
            platform: 'v2ex',
            accountId: currentAccount.accountId,
            outcome: 'failed',
          }).catch(() => undefined);
          updateState((prev) => ({
            ...prev,
            syncBanner: {
              phase: 'error',
              fetchedCount: counters.fetched,
              addedCount: counters.added,
              deduplicatedCount: counters.deduplicated,
              message: error instanceof Error ? error.message : String(error),
            },
          }));
        }
      } finally {
        if (activeSyncAbortController === controller) {
          activeSyncAbortController = null;
        }
      }
    };

    const runPassiveFavoritesPageSync = async (): Promise<void> => {
      if (!isFavoritesListPage || activeSyncAbortController !== null) {
        return;
      }
      const parsed = extractFavoriteListFromDocument(document);
      if (parsed.isChallengePage || parsed.topicIds.length === 0) {
        return;
      }
      const controller = new AbortController();
      activeSyncAbortController = controller;
      const counters = { fetched: 0, added: 0, deduplicated: 0 };
      try {
        const outcome = await syncTopicIdsList(
          parsed.topicIds,
          controller.signal,
          counters,
        );
        if (outcome === 'ok' && (counters.added > 0 || counters.deduplicated > 0)) {
          updateState((prev) => ({
            ...prev,
            syncBanner: {
              phase: 'completed',
              fetchedCount: counters.fetched,
              addedCount: counters.added,
              deduplicatedCount: counters.deduplicated,
              message: '已通过被动模式同步本页 V2EX 主题收藏',
            },
          }));
          scheduleBannerAutoClose();
        }
      } catch {
        // 被动模式静默降级
      } finally {
        if (activeSyncAbortController === controller) {
          activeSyncAbortController = null;
        }
      }
    };

    const evaluateAccountSync = async (): Promise<void> => {
      if (!currentAccount) {
        return;
      }
      try {
        const decision = await sendToBackground({
          target: 'background',
          type: 'CHECK_ACCOUNT_SYNC_ACTION',
          platform: 'v2ex',
          accountId: currentAccount.accountId,
        });
        if (!decision || !decision.ok) {
          return;
        }
        passiveFallbackActive = decision.passiveFallbackActive;

        if (decision.action === 'auto_sync') {
          void startFullCollectionSync();
        } else if (decision.action === 'prompt') {
          updateState((prev) => ({
            ...prev,
            syncPrompt: {
              platformLabel: 'V2EX',
              accountName: currentAccount.accountName,
            },
          }));
        } else if (
          isFavoritesListPage &&
          (passiveFallbackActive || autoSyncAllCollections)
        ) {
          void runPassiveFavoritesPageSync();
        }
      } catch (error) {
        console.warn('[Collect+] Failed to check V2EX account sync:', error);
      }
    };

    const handleConfirmFullSync = async (): Promise<void> => {
      updateState((prev) => ({ ...prev, syncPrompt: null }));
      if (!currentAccount) {
        return;
      }
      try {
        const res = await sendToBackground({
          target: 'background',
          type: 'BEGIN_MANUAL_ACCOUNT_SYNC',
          platform: 'v2ex',
          accountId: currentAccount.accountId,
        });
        if (res && res.ok && res.started) {
          void startFullCollectionSync();
        }
      } catch (error) {
        console.warn('[Collect+] Failed to begin V2EX full sync:', error);
      }
    };

    const handleDismissFullSync = async (): Promise<void> => {
      updateState((prev) => ({ ...prev, syncPrompt: null }));
      if (!currentAccount) {
        return;
      }
      await sendToBackground({
        target: 'background',
        type: 'REPORT_ACCOUNT_SYNC_RESULT',
        platform: 'v2ex',
        accountId: currentAccount.accountId,
        outcome: 'dismissed',
      }).catch(() => undefined);
    };

    // 1. 监听 V2EX 原生「加入收藏 / 取消收藏」按钮点击（不阻断原站导航）
    ctx.addEventListener(
      document,
      'click',
      (event: Event) => {
        const target = event.target;
        if (!(target instanceof Element)) {
          return;
        }
        const anchor = target.closest<HTMLAnchorElement>(
          'a[href*="/favorite/topic/"], a[href*="/unfavorite/topic/"]',
        );
        if (!anchor) {
          return;
        }

        const href = anchor.getAttribute('href') ?? '';
        const favId = extractFavoriteHrefTopicId(href, 'favorite');
        if (favId) {
          writePendingFavoriteMarker(favId);
          const topicData = extractV2exTopicFromDocument(
            document,
            window.location.href,
          );
          if (topicData && topicData.topicId === favId) {
            enqueueNativeTopicCollect(topicData);
          }
          return;
        }

        const unfavId = extractFavoriteHrefTopicId(href, 'unfavorite');
        if (unfavId) {
          nativeCollectBuffer.cancelPending(unfavId);
          void sendToBackground({
            target: 'background',
            type: 'UNCOLLECT_ITEMS',
            platform: 'v2ex',
            sourceIds: [unfavId],
          }).catch((error: unknown) => {
            console.warn('[Collect+] V2EX native uncollect failed:', error);
          });
        }
      },
      true,
    );

    // 1b. 若刚经由原站「加入收藏」302 跳转回当前主题页，做一次幂等补确认（后台按 v2ex:{id} 自动去重）
    if (
      currentTopicId &&
      consumePendingFavoriteMarker(currentTopicId) &&
      document.querySelector(`a[href*="/unfavorite/topic/${currentTopicId}"]`) !==
        null
    ) {
      const topicData = extractV2exTopicFromDocument(
        document,
        window.location.href,
      );
      if (topicData) {
        enqueueNativeTopicCollect(topicData);
      }
    }

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
        if (!isTopicPage) {
          sendResponse({
            ok: false,
            error: '请打开具体的 V2EX 主题页（/t/...）后再采集。',
          });
          return false;
        }
        if (message.autoSyncExclusion) {
          void triggerManualCapture(
            message.triggerSource,
            message.autoSyncExclusion,
          ).then(sendResponse);
          return true;
        }
        void triggerManualCapture(message.triggerSource);
        sendResponse({ ok: true });
        return false;
      }

      if (message.type === 'CONTENT_PREFERENCES_UPDATED') {
        prefFloatingButtonEnabled = message.floatingButtonEnabled;
        autoSyncAllCollections = message.autoSyncAllCollections;
        nativeCollectBuffer.setEnabled(message.nativeCollectToastEnabled);
        applyFloatingVisibility();
        if (message.autoSyncAllCollections && currentAccount) {
          void evaluateAccountSync();
        }
        sendResponse({ ok: true });
        return false;
      }

      if (message.type === 'CONTENT_REMOTE_UNCOLLECT') {
        void (async () => {
          const results: Array<{
            sourceId: string;
            ok: boolean;
            reason?: string;
          }> = [];
          const parser = new DOMParser();

          for (let i = 0; i < message.items.length; i += 1) {
            const target = message.items[i];
            if (!target) {
              continue;
            }
            const topicId = target.sourceId.trim();
            if (!/^\d+$/.test(topicId)) {
              results.push({
                sourceId: target.sourceId,
                ok: false,
                reason: '无效 V2EX 主题 ID',
              });
              continue;
            }
            if (i > 0) {
              await new Promise<void>((resolve) => setTimeout(resolve, 260));
            }

            try {
              const topicRes = await fetch(
                `${window.location.origin}/t/${encodeURIComponent(topicId)}`,
                { method: 'GET', credentials: 'include' },
              );
              if (!topicRes.ok) {
                results.push({
                  sourceId: topicId,
                  ok: false,
                  reason: `无法读取 V2EX 主题页（HTTP ${topicRes.status}）`,
                });
                continue;
              }
              const html = await topicRes.text();
              const doc = parser.parseFromString(html, 'text/html');
              const unfavLink = doc.querySelector<HTMLAnchorElement>(
                `a[href*="/unfavorite/topic/${topicId}"]`,
              );
              if (!unfavLink) {
                const favLink = doc.querySelector<HTMLAnchorElement>(
                  `a[href*="/favorite/topic/${topicId}"]`,
                );
                if (favLink) {
                  results.push({ sourceId: topicId, ok: true });
                } else {
                  results.push({
                    sourceId: topicId,
                    ok: false,
                    reason: '未检测到 V2EX 登录态或主题不可访问',
                  });
                }
                continue;
              }

              const unfavHref = unfavLink.getAttribute('href') ?? '';
              const unfavUrl = new URL(
                unfavHref,
                window.location.origin,
              ).toString();
              const unfavRes = await fetch(unfavUrl, {
                method: 'GET',
                credentials: 'include',
              });
              if (unfavRes.ok) {
                results.push({ sourceId: topicId, ok: true });
              } else {
                results.push({
                  sourceId: topicId,
                  ok: false,
                  reason: `V2EX 取消收藏失败（HTTP ${unfavRes.status}）`,
                });
              }
            } catch (error) {
              results.push({
                sourceId: topicId,
                ok: false,
                reason: error instanceof Error ? error.message : String(error),
              });
            }
          }

          sendResponse({ ok: true, results });
        })();
        return true;
      }

      return false;
    };

    chrome.runtime.onMessage.addListener(handleRuntimeMessage);

    // 3. 页面内 Alt+S 快捷键（仅在主题页生效，避开输入框）
    ctx.addEventListener(window, 'keydown', (event: KeyboardEvent) => {
      if (
        !isTopicPage ||
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

    // 4. 初始化用户偏好并检查已登录账号同步状态
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
        applyFloatingVisibility();
      }
    } catch {
      // 保留默认值
    }

    if (currentAccount) {
      void evaluateAccountSync();
    }

    // 5. 通过 Shadow DOM 挂载独立悬浮浮层
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
        activeSyncAbortController?.abort();
      },
      onOpenFallbackPage: (url: string) => {
        window.open(url, '_blank', 'noopener,noreferrer');
      },
      onDismissSyncBanner: () => {
        clearBannerTimer();
        updateState((prev) => ({ ...prev, syncBanner: null }));
      },
      onSkipNativeCollectPersistence: (reason) => {
        nativeCollectBuffer.skipWithReason(reason);
      },
      onSaveNativeCollectNow: () => {
        nativeCollectBuffer.flushNow();
      },
    };

    const ui = await createShadowRootUi(ctx, {
      name: 'collect-plus-v2ex-overlay',
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
      nativeCollectBuffer.dispose();
      activeSyncAbortController?.abort();
      clearBannerTimer();
      ui.remove();
    });
  },
});
