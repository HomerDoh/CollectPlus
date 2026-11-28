/**
 * Main World 共享基础设施模块（供所有 Tier 2 Recipe 与 Tier 3 Deep Adapter 复用）。
 *
 * 铁律：运行于宿主网页 `world: 'MAIN'` 上下文，严禁引入 `chrome.*` API、Dexie 或 React 运行时；
 * 仅提供只读网络旁路观察、`window.postMessage` 桥接、LRU 缓存与纯工具函数。
 */

import {
  isPageBridgeMessage,
  PAGE_BRIDGE_CHANNEL,
  type CurrentItemResponseMessage,
  type PageBridgeMessage,
} from '../../types/adapter.ts';
import type { CaptureTriggerSource } from '../../types/adapter.ts';
import type { PlatformId } from '../../types/schema.ts';

export type UnknownRecord = Record<string, unknown>;

export type MainToContentBridgeMessage = Extract<
  PageBridgeMessage,
  { direction: 'main-to-content' }
>;

export type ContentToMainBridgeMessage = Extract<
  PageBridgeMessage,
  { direction: 'content-to-main' }
>;

/** 严格判断是否为普通 JSON 记录对象（排除 null 与数组） */
export function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 安全读取非空字符串属性（支持正整数转字符串） */
export function readStringProp(
  obj: UnknownRecord | undefined,
  key: string,
): string | undefined {
  if (!obj) {
    return undefined;
  }
  const value = obj[key];
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return String(Math.trunc(value));
  }
  return undefined;
}

/** 安全读取有限数值属性 */
export function readNumberProp(
  obj: UnknownRecord | undefined,
  key: string,
): number | undefined {
  if (!obj) {
    return undefined;
  }
  const value = obj[key];
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/** 获取安全的 `window.postMessage` targetOrigin */
export function getBridgeTargetOrigin(): string {
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

/** 在全局 `window` 上执行幂等单次安装锁检查，返回 `true` 表示本次获得了安装权 */
export function installMainHookOnce(lockKey: string | symbol): boolean {
  const winRecord = window as unknown as Record<string | symbol, unknown>;
  if (winRecord[lockKey]) {
    return false;
  }
  winRecord[lockKey] = true;
  return true;
}

/** 支持 `AbortSignal` 的延时等待（用于带抖动的防风控翻页节流） */
export function sleepAbortable(
  ms: number,
  signal?: AbortSignal,
): Promise<void> {
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

/** 通用 O(1) LRU 缓存 */
export interface LruCache<K, V> {
  readonly size: number;
  get(key: K): V | undefined;
  set(key: K, value: V): void;
  has(key: K): boolean;
  delete(key: K): boolean;
  clear(): void;
  values(): IterableIterator<V>;
  entries(): IterableIterator<[K, V]>;
}

export function createLruCache<K, V>(capacity: number): LruCache<K, V> {
  const maxEntries = Math.max(1, Math.floor(capacity));
  const map = new Map<K, V>();

  return {
    get size(): number {
      return map.size;
    },
    get(key: K): V | undefined {
      const value = map.get(key);
      if (value === undefined) {
        return undefined;
      }
      map.delete(key);
      map.set(key, value);
      return value;
    },
    set(key: K, value: V): void {
      if (map.has(key)) {
        map.delete(key);
      }
      map.set(key, value);
      if (map.size > maxEntries) {
        const oldestKey = map.keys().next().value;
        if (oldestKey !== undefined) {
          map.delete(oldestKey);
        }
      }
    },
    has(key: K): boolean {
      return map.has(key);
    },
    delete(key: K): boolean {
      return map.delete(key);
    },
    clear(): void {
      map.clear();
    },
    values(): IterableIterator<V> {
      return map.values();
    },
    entries(): IterableIterator<[K, V]> {
      return map.entries();
    },
  };
}

/** Main World ↔ Isolated Content Script 强类型桥接句柄 */
export interface MainWorldBridge {
  readonly platform: PlatformId;
  post(message: MainToContentBridgeMessage): void;
  notifyReady(): void;
  replyCurrentItem(
    requestId: string,
    triggerSource: CaptureTriggerSource,
    rawData: unknown | null,
    error?: string,
  ): void;
  emitNativeCollect(rawData: unknown, sourceId?: string): void;
  emitNativeUncollect(sourceIds: string[]): void;
  onContentMessage(
    handler: (message: ContentToMainBridgeMessage) => void,
  ): () => void;
}

/** 向同窗口发送跨世界桥接消息 */
export function postBridgeMessage(message: PageBridgeMessage): void {
  try {
    window.postMessage(message, getBridgeTargetOrigin());
  } catch {
    // 忽略跨窗口或已销毁上下文 postMessage 异常
  }
}

/** 创建指定平台的 Main World 桥接通道 */
export function createMainBridge(platform: PlatformId): MainWorldBridge {
  const post = (message: MainToContentBridgeMessage): void => {
    postBridgeMessage(message);
  };

  return {
    platform,
    post,
    notifyReady(): void {
      post({
        channel: PAGE_BRIDGE_CHANNEL,
        direction: 'main-to-content',
        type: 'BRIDGE_READY',
        platform,
      });
    },
    replyCurrentItem(
      requestId: string,
      triggerSource: CaptureTriggerSource,
      rawData: unknown | null,
      error?: string,
    ): void {
      const msg: CurrentItemResponseMessage = {
        channel: PAGE_BRIDGE_CHANNEL,
        direction: 'main-to-content',
        type: 'CURRENT_ITEM_RESPONSE',
        requestId,
        platform,
        rawData,
        triggerSource,
        ...(error !== undefined ? { error } : {}),
      };
      post(msg);
    },
    emitNativeCollect(rawData: unknown, sourceId?: string): void {
      post({
        channel: PAGE_BRIDGE_CHANNEL,
        direction: 'main-to-content',
        type: 'NATIVE_COLLECT_CAPTURED',
        platform,
        rawData,
        ...(sourceId !== undefined ? { sourceId } : {}),
      });
    },
    emitNativeUncollect(sourceIds: string[]): void {
      if (sourceIds.length === 0) {
        return;
      }
      post({
        channel: PAGE_BRIDGE_CHANNEL,
        direction: 'main-to-content',
        type: 'NATIVE_UNCOLLECT_CAPTURED',
        platform,
        sourceIds,
      });
    },
    onContentMessage(
      handler: (message: ContentToMainBridgeMessage) => void,
    ): () => void {
      const listener = (event: MessageEvent<unknown>): void => {
        if (event.source !== window) {
          return;
        }
        if (!isPageBridgeMessage(event.data)) {
          return;
        }
        if (event.data.direction !== 'content-to-main') {
          return;
        }
        handler(event.data);
      };
      window.addEventListener('message', listener);
      return () => {
        window.removeEventListener('message', listener);
      };
    },
  };
}

/** 旁路观测到的单次只读网络响应事件 */
export interface ObservedNetworkEvent {
  readonly transport: 'fetch' | 'xhr';
  readonly method: string;
  readonly url: string;
  readonly status: number;
  readonly ok: boolean;
  readonly requestBodyText?: string;
  readText(): Promise<string | null>;
  readJson(): Promise<unknown | null>;
}

/** 网络旁路订阅者 */
export interface MainNetworkObserver {
  match(url: string, method: string): boolean;
  onResponse(event: ObservedNetworkEvent): void;
}

interface MainNetworkBus {
  readonly originalFetch: typeof window.fetch;
  readonly observers: Set<MainNetworkObserver>;
}

const NETWORK_BUS_KEY = Symbol.for('collect-plus:main-network-bus');

function extractFetchUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') {
    return input;
  }
  if (input instanceof URL) {
    return input.href;
  }
  return input.url;
}

function extractFetchMethod(
  input: RequestInfo | URL,
  init?: RequestInit,
): string {
  if (init?.method) {
    return init.method.toUpperCase();
  }
  if (typeof Request !== 'undefined' && input instanceof Request) {
    return input.method.toUpperCase();
  }
  return 'GET';
}

function extractBodyText(body: unknown): string | undefined {
  if (typeof body === 'string') {
    return body;
  }
  if (body instanceof URLSearchParams) {
    return body.toString();
  }
  return undefined;
}

function ensureMainNetworkBus(): MainNetworkBus {
  const winRecord = window as unknown as Record<symbol, MainNetworkBus | undefined>;
  const existing = winRecord[NETWORK_BUS_KEY];
  if (existing) {
    return existing;
  }

  const originalFetch = window.fetch.bind(window);
  const observers = new Set<MainNetworkObserver>();
  const bus: MainNetworkBus = { originalFetch, observers };
  winRecord[NETWORK_BUS_KEY] = bus;

  // 1. 只读旁路拦截 window.fetch（仅当存在匹配订阅者时才 clone Response，零阻塞）
  window.fetch = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const reqUrl = extractFetchUrl(input);
    const method = extractFetchMethod(input, init);
    const requestBodyText = extractBodyText(init?.body);
    const matched = Array.from(observers).filter((observer) => {
      try {
        return observer.match(reqUrl, method);
      } catch {
        return false;
      }
    });

    const response = await originalFetch(input, init);
    if (matched.length > 0) {
      let cloned: Response | null = null;
      try {
        cloned = response.clone();
      } catch {
        cloned = null;
      }

      let textPromise: Promise<string | null> | null = null;
      const readText = (): Promise<string | null> => {
        if (!textPromise) {
          textPromise = cloned
            ? cloned.text().catch(() => null)
            : Promise.resolve(null);
        }
        return textPromise;
      };

      const event: ObservedNetworkEvent = {
        transport: 'fetch',
        method,
        url: response.url || reqUrl,
        status: response.status,
        ok: response.ok,
        ...(requestBodyText !== undefined ? { requestBodyText } : {}),
        readText,
        async readJson(): Promise<unknown | null> {
          const text = await readText();
          if (!text) {
            return null;
          }
          try {
            return JSON.parse(text) as unknown;
          } catch {
            return null;
          }
        },
      };

      for (const observer of matched) {
        try {
          observer.onResponse(event);
        } catch {
          // 单个观察者异常不得影响宿主页面与其他观察者
        }
      }
    }

    return response;
  };

  // 2. 只读旁路拦截 XMLHttpRequest
  const xhrOpen = XMLHttpRequest.prototype.open;
  const xhrSend = XMLHttpRequest.prototype.send;
  const xhrMetaMap = new WeakMap<
    XMLHttpRequest,
    { method: string; url: string }
  >();

  XMLHttpRequest.prototype.open = function openPatched(
    method: string,
    url: string | URL,
    async?: boolean,
    username?: string | null,
    password?: string | null,
  ): void {
    const urlStr = typeof url === 'string' ? url : url.href;
    xhrMetaMap.set(this, {
      method: method.toUpperCase(),
      url: urlStr,
    });
    if (async === undefined) {
      xhrOpen.call(this, method, url, true);
    } else {
      xhrOpen.call(
        this,
        method,
        url,
        async,
        username ?? null,
        password ?? null,
      );
    }
  };

  XMLHttpRequest.prototype.send = function sendPatched(
    body?: Document | XMLHttpRequestBodyInit | null,
  ): void {
    const meta = xhrMetaMap.get(this);
    const reqUrl = meta?.url ?? '';
    const method = meta?.method ?? 'GET';
    const requestBodyText = extractBodyText(body);
    const matched = Array.from(observers).filter((observer) => {
      try {
        return observer.match(reqUrl, method);
      } catch {
        return false;
      }
    });

    if (matched.length > 0) {
      this.addEventListener('load', () => {
        const finalUrl = this.responseURL || reqUrl;
        const status = this.status;
        const ok = status >= 200 && status < 300;
        const capturedText =
          this.responseType === '' || this.responseType === 'text'
            ? typeof this.responseText === 'string'
              ? this.responseText
              : null
            : null;
        const capturedJson =
          this.responseType === 'json' ? (this.response as unknown) : undefined;

        const event: ObservedNetworkEvent = {
          transport: 'xhr',
          method,
          url: finalUrl,
          status,
          ok,
          ...(requestBodyText !== undefined ? { requestBodyText } : {}),
          async readText(): Promise<string | null> {
            return capturedText;
          },
          async readJson(): Promise<unknown | null> {
            if (capturedJson !== undefined) {
              return capturedJson;
            }
            if (!capturedText) {
              return null;
            }
            try {
              return JSON.parse(capturedText) as unknown;
            } catch {
              return null;
            }
          },
        };

        for (const observer of matched) {
          try {
            observer.onResponse(event);
          } catch {
            // 忽略单个观察者异常
          }
        }
      });
    }

    xhrSend.call(this, body ?? null);
  };

  return bus;
}

/** 订阅只读网络旁路响应，返回取消订阅函数 */
export function observeMainNetwork(observer: MainNetworkObserver): () => void {
  const bus = ensureMainNetworkBus();
  bus.observers.add(observer);
  return () => {
    bus.observers.delete(observer);
  };
}

/** 获取未被旁路补丁包装的原生 `window.fetch` */
export function getOriginalFetch(): typeof window.fetch {
  return ensureMainNetworkBus().originalFetch;
}
