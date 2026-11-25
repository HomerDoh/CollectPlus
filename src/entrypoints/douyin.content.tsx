/**
 * Collect+ 抖音 Isolated World Content Script 入口。
 *
 * 职责：
 * 1. 通过 WXT `createShadowRootUi` 挂载样式完全隔离的 React `CaptureOverlay`（仅轻悬浮采集按钮，无页面弹窗）；
 * 2. 桥接 Main World（`douyin-main.content.ts`）的原生收藏捕获与主动请求当前作品响应；
 * 3. 提供静默采集触发：抖音原生收藏拦截 + 页面内 `Alt+S` 兜底热键 + 悬浮按钮 + Popup/Command 指令。
 */

import { createRoot, type Root } from 'react-dom/client';
import { douyinAdapter } from '../adapters/douyin/parser.ts';
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
  type CapturedPayload,
  type CaptureTriggerSource,
  type CurrentItemResponseMessage,
  type RequestCurrentItemMessage,
} from '../types/adapter.ts';
import { isContentMessage, sendToBackground } from '../types/messages.ts';

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

    const pendingRequests = new Map<string, PendingItemRequest>();
    const recentNativeCaptures = new Map<string, number>();

    const submitCapturedPayload = async (
      payload: CapturedPayload,
    ): Promise<void> => {
      const captureResponse = await sendToBackground({
        target: 'background',
        type: 'CAPTURE_ITEM',
        payload,
      });

      if (!captureResponse || !captureResponse.ok) {
        console.warn(
          '[Collect+] Failed to submit captured item:',
          captureResponse && !captureResponse.ok
            ? captureResponse.error
            : 'Background service did not acknowledge capture.',
        );
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
          updateState((prev) => ({
            ...prev,
            floatingButtonEnabled: message.floatingButtonEnabled,
          }));
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
    };

    try {
      const prefResponse = await sendToBackground({
        target: 'background',
        type: 'GET_USER_PREFERENCES',
      });
      if (prefResponse && prefResponse.ok) {
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
  },
});
