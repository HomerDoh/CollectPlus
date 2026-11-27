/**
 * 原站原生收藏 5 秒延时缓冲控制器：
 * - 开启提示时先在页面展示 5 秒可交互 Toast，期间不触发媒体下载与评论拉取；
 * - 倒计时结束、连续收藏下一条或标签页关闭（pagehide）时自动进入正常离线保存；
 * - 倒计时内点击跳过原因时，直接发送带 `autoSyncExclusion` 的轻量元数据入库。
 */

import type { CapturedPayload } from '../types/adapter.ts';
import type { CaptureAutoSyncExclusionInput } from '../types/messages.ts';
import type { AutoSyncExclusionReason } from '../types/schema.ts';

/** 原站原生收藏 5 秒延时缓冲时长（毫秒） */
export const NATIVE_COLLECT_TOAST_DURATION_MS = 5000;

/** 浮层展示的原生收藏 5 秒提示条只读状态 */
export interface NativeCollectToastState {
  /** 唯一实例 ID，用于连续触发时重置 5 秒倒计时与进度条动画 */
  id: string;
  title: string;
  durationMs: number;
}

export interface NativeCollectBufferOptions {
  initialEnabled?: boolean;
  onToastChange: (toast: NativeCollectToastState | null) => void;
  onSubmit: (
    payload: CapturedPayload,
    autoSyncExclusion?: CaptureAutoSyncExclusionInput,
  ) => Promise<void>;
}

export interface NativeCollectBufferController {
  setEnabled: (enabled: boolean) => void;
  isEnabled: () => boolean;
  enqueue: (payload: CapturedPayload) => void;
  flushNow: () => void;
  skipWithReason: (reason: AutoSyncExclusionReason, detail?: string) => void;
  cancelPending: (sourceId?: string) => CapturedPayload | null;
  peekPendingPayload: () => CapturedPayload | null;
  dispose: () => void;
}

interface PendingEntry {
  id: string;
  payload: CapturedPayload;
  timer: ReturnType<typeof setTimeout>;
}

export function createNativeCollectBuffer(
  options: NativeCollectBufferOptions,
): NativeCollectBufferController {
  let enabled = options.initialEnabled ?? true;
  let pending: PendingEntry | null = null;
  let seq = 0;

  const clearPendingEntry = (): PendingEntry | null => {
    const current = pending;
    if (!current) {
      return null;
    }
    clearTimeout(current.timer);
    pending = null;
    options.onToastChange(null);
    return current;
  };

  const flushNow = (): void => {
    const current = clearPendingEntry();
    if (!current) {
      return;
    }
    void options.onSubmit(current.payload);
  };

  const enqueue = (payload: CapturedPayload): void => {
    if (!enabled) {
      void options.onSubmit(payload);
      return;
    }

    if (pending) {
      if (pending.payload.sourceId === payload.sourceId) {
        return;
      }
      // 连续收藏新作品时先立即放行前一条进入正常保存
      flushNow();
    }

    seq += 1;
    const id = `cp-native-toast-${Date.now()}-${seq}`;
    const timer = setTimeout(() => {
      if (pending?.id !== id) {
        return;
      }
      flushNow();
    }, NATIVE_COLLECT_TOAST_DURATION_MS);

    pending = { id, payload, timer };
    options.onToastChange({
      id,
      title: payload.title,
      durationMs: NATIVE_COLLECT_TOAST_DURATION_MS,
    });
  };

  const skipWithReason = (
    reason: AutoSyncExclusionReason,
    detail?: string,
  ): void => {
    const current = clearPendingEntry();
    if (!current) {
      return;
    }
    const trimmedDetail = detail?.trim();
    void options.onSubmit(current.payload, {
      reason,
      ...(trimmedDetail ? { detail: trimmedDetail } : {}),
    });
  };

  const cancelPending = (sourceId?: string): CapturedPayload | null => {
    if (!pending) {
      return null;
    }
    if (sourceId !== undefined && pending.payload.sourceId !== sourceId) {
      return null;
    }
    const current = clearPendingEntry();
    return current?.payload ?? null;
  };

  const setEnabled = (nextEnabled: boolean): void => {
    enabled = nextEnabled;
    if (!enabled && pending) {
      flushNow();
    }
  };

  const handlePageHide = (): void => {
    flushNow();
  };

  window.addEventListener('pagehide', handlePageHide);

  return {
    setEnabled,
    isEnabled: () => enabled,
    enqueue,
    flushNow,
    skipWithReason,
    cancelPending,
    peekPendingPayload: () => pending?.payload ?? null,
    dispose: () => {
      window.removeEventListener('pagehide', handlePageHide);
      clearPendingEntry();
    },
  };
}
