/**
 * 原站原生收藏 5 秒延时缓冲控制器：
 * - 开启提示时先在页面展示 5 秒可交互 Toast，期间不触发媒体下载与评论拉取；
 * - 支持在入库前 5 秒内手动指定目标文件夹（展开选择时自动暂停倒计时，选定后立即按手动归属入库）；
 * - 倒计时结束、连续收藏下一条或标签页关闭（pagehide）时以未指定目录（`undefined`）放行，交由后台自动分类；
 * - 倒计时内点击跳过原因时，直接发送带 `autoSyncExclusion` 的轻量元数据入库。
 */

import type { CapturedPayload } from '../types/adapter.ts';
import type { CaptureAutoSyncExclusionInput } from '../types/messages.ts';
import type { AutoSyncExclusionReason } from '../types/schema.ts';

/** 原站原生收藏 5 秒延时缓冲时长（毫秒） */
export const NATIVE_COLLECT_TOAST_DURATION_MS = 5000;

/** 原站原生收藏预演分类结果 */
export interface NativeCollectFolderPreview {
  folderId: string | null;
  folderName: string | null;
  autoClassifyEnabled: boolean;
}

/** 浮层展示的原生收藏 5 秒提示条只读状态 */
export interface NativeCollectToastState {
  /** 唯一实例 ID，用于连续触发时重置 5 秒倒计时与进度条动画 */
  id: string;
  title: string;
  durationMs: number;
  remainingMs: number;
  paused: boolean;
  predictedFolderId?: string | null;
  predictedFolderName?: string | null;
  autoClassifyEnabled?: boolean;
}

export interface NativeCollectBufferOptions {
  initialEnabled?: boolean;
  onToastChange: (toast: NativeCollectToastState | null) => void;
  onSubmit: (
    payload: CapturedPayload,
    autoSyncExclusion?: CaptureAutoSyncExclusionInput,
    folderId?: string | null,
  ) => Promise<void>;
  onPreviewFolder?: (
    payload: CapturedPayload,
  ) => Promise<NativeCollectFolderPreview | null>;
}

export interface NativeCollectBufferController {
  setEnabled: (enabled: boolean) => void;
  isEnabled: () => boolean;
  enqueue: (payload: CapturedPayload) => void;
  flushNow: () => void;
  pauseTimer: () => void;
  resumeTimer: () => void;
  saveWithFolder: (folderId: string | null) => void;
  skipWithReason: (reason: AutoSyncExclusionReason, detail?: string) => void;
  cancelPending: (sourceId?: string) => CapturedPayload | null;
  peekPendingPayload: () => CapturedPayload | null;
  dispose: () => void;
}

interface PendingEntry {
  id: string;
  payload: CapturedPayload;
  timer: ReturnType<typeof setTimeout> | null;
  deadline: number;
  remainingMs: number;
  paused: boolean;
  predictedFolderId?: string | null;
  predictedFolderName?: string | null;
  autoClassifyEnabled?: boolean;
}

export function createNativeCollectBuffer(
  options: NativeCollectBufferOptions,
): NativeCollectBufferController {
  let enabled = options.initialEnabled ?? true;
  let pending: PendingEntry | null = null;
  let seq = 0;

  const emitToastState = (entry: PendingEntry | null): void => {
    if (!entry) {
      options.onToastChange(null);
      return;
    }
    options.onToastChange({
      id: entry.id,
      title: entry.payload.title,
      durationMs: NATIVE_COLLECT_TOAST_DURATION_MS,
      remainingMs: entry.paused
        ? entry.remainingMs
        : Math.max(0, entry.deadline - Date.now()),
      paused: entry.paused,
      ...(entry.predictedFolderId !== undefined
        ? { predictedFolderId: entry.predictedFolderId }
        : {}),
      ...(entry.predictedFolderName !== undefined
        ? { predictedFolderName: entry.predictedFolderName }
        : {}),
      ...(entry.autoClassifyEnabled !== undefined
        ? { autoClassifyEnabled: entry.autoClassifyEnabled }
        : {}),
    });
  };

  const clearPendingEntry = (): PendingEntry | null => {
    const current = pending;
    if (!current) {
      return null;
    }
    if (current.timer !== null) {
      clearTimeout(current.timer);
    }
    pending = null;
    emitToastState(null);
    return current;
  };

  const flushNow = (): void => {
    const current = clearPendingEntry();
    if (!current) {
      return;
    }
    void options.onSubmit(current.payload);
  };

  const armTimer = (entry: PendingEntry, delayMs: number): void => {
    if (entry.timer !== null) {
      clearTimeout(entry.timer);
    }
    const safeDelay = Math.max(200, delayMs);
    entry.paused = false;
    entry.remainingMs = safeDelay;
    entry.deadline = Date.now() + safeDelay;
    const entryId = entry.id;
    entry.timer = setTimeout(() => {
      if (pending?.id !== entryId) {
        return;
      }
      flushNow();
    }, safeDelay);
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
    const entry: PendingEntry = {
      id,
      payload,
      timer: null,
      deadline: Date.now() + NATIVE_COLLECT_TOAST_DURATION_MS,
      remainingMs: NATIVE_COLLECT_TOAST_DURATION_MS,
      paused: false,
    };
    armTimer(entry, NATIVE_COLLECT_TOAST_DURATION_MS);
    pending = entry;
    emitToastState(entry);

    if (options.onPreviewFolder) {
      void options
        .onPreviewFolder(payload)
        .then((preview) => {
          if (!preview || pending?.id !== id) {
            return;
          }
          pending.predictedFolderId = preview.folderId;
          pending.predictedFolderName = preview.folderName;
          pending.autoClassifyEnabled = preview.autoClassifyEnabled;
          emitToastState(pending);
        })
        .catch(() => undefined);
    }
  };

  const pauseTimer = (): void => {
    if (!pending || pending.paused) {
      return;
    }
    if (pending.timer !== null) {
      clearTimeout(pending.timer);
      pending.timer = null;
    }
    pending.remainingMs = Math.max(1000, pending.deadline - Date.now());
    pending.paused = true;
    emitToastState(pending);
  };

  const resumeTimer = (): void => {
    if (!pending || !pending.paused) {
      return;
    }
    armTimer(pending, pending.remainingMs);
    emitToastState(pending);
  };

  const saveWithFolder = (folderId: string | null): void => {
    const current = clearPendingEntry();
    if (!current) {
      return;
    }
    void options.onSubmit(current.payload, undefined, folderId);
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
    pauseTimer,
    resumeTimer,
    saveWithFolder,
    skipWithReason,
    cancelPending,
    peekPendingPayload: () => pending?.payload ?? null,
    dispose: () => {
      window.removeEventListener('pagehide', handlePageHide);
      clearPendingEntry();
    },
  };
}
