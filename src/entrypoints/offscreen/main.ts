/**
 * Collect+ Offscreen Document 入口。
 *
 * 接收来自 Background Service Worker 的下载控制指令（PING / START / ABORT），
 * 调度 `executeDownloadJob` 流式落盘至 OPFS，并将实时进度、完成结果与异常回传 Background。
 */

import { executeDownloadJob, isAbortError } from '../../download/pipeline.ts';
import { tryAutoFlushToVault } from '../../storage/vault.ts';
import {
  isOffscreenMessage,
  sendToBackground,
  type OffscreenStartDownloadMessage,
} from '../../types/messages.ts';

/** 当前正在执行的下载任务中止控制器映射（key = taskId） */
const activeControllers = new Map<string, AbortController>();

/** 下载完成后静默落盘合批锁：连续多条视频下载完成时合并批次写入 CollectVault */
let isAutoFlushing = false;
let pendingAutoFlush = false;

function scheduleAutoFlushToVault(): void {
  if (isAutoFlushing) {
    pendingAutoFlush = true;
    return;
  }

  isAutoFlushing = true;
  void (async () => {
    try {
      do {
        pendingAutoFlush = false;
        try {
          await tryAutoFlushToVault();
        } catch (error) {
          console.warn('[Collect+] Auto flush to CollectVault skipped:', error);
        }
      } while (pendingAutoFlush);
    } finally {
      isAutoFlushing = false;
    }
  })();
}

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return String(error);
}

async function runDownloadTask(
  message: OffscreenStartDownloadMessage,
  controller: AbortController,
): Promise<void> {
  const { taskId, itemId, assets } = message;

  try {
    const result = await executeDownloadJob({
      itemId,
      assets,
      signal: controller.signal,
      onProgress: (snapshot) => {
        void sendToBackground({
          target: 'background',
          type: 'OFFSCREEN_PROGRESS',
          taskId,
          itemId,
          progress: snapshot.progress,
          completedAssets: snapshot.completedAssets,
          totalAssets: snapshot.totalAssets,
          downloadedBytes: snapshot.downloadedBytes,
          totalBytes: snapshot.totalBytes,
        }).catch(() => undefined);
      },
    });

    const completeRes = await sendToBackground({
      target: 'background',
      type: 'OFFSCREEN_COMPLETE',
      taskId,
      itemId,
      assets: result.assets,
      totalSizeBytes: result.totalSizeBytes,
      ...(result.thumbnailDataUrl !== undefined
        ? { thumbnailDataUrl: result.thumbnailDataUrl }
        : {}),
    }).catch(() => undefined);

    if (completeRes?.ok) {
      scheduleAutoFlushToVault();
    }
  } catch (error) {
    const aborted = controller.signal.aborted || isAbortError(error);
    await sendToBackground({
      target: 'background',
      type: 'OFFSCREEN_ERROR',
      taskId,
      itemId,
      error: aborted
        ? 'Download task was cancelled.'
        : formatErrorMessage(error),
      retryable: !aborted,
    }).catch(() => undefined);
  } finally {
    if (activeControllers.get(taskId) === controller) {
      activeControllers.delete(taskId);
    }
  }
}

chrome.runtime.onMessage.addListener(
  (message: unknown, _sender, sendResponse) => {
    if (!isOffscreenMessage(message)) {
      return false;
    }

    switch (message.type) {
      case 'OFFSCREEN_PING': {
        sendResponse({ ok: true, ready: true });
        return false;
      }

      case 'OFFSCREEN_ABORT_DOWNLOAD': {
        const controller = activeControllers.get(message.taskId);
        if (controller) {
          activeControllers.delete(message.taskId);
          controller.abort(
            new DOMException('Download task cancelled by background.', 'AbortError'),
          );
        }
        sendResponse({ ok: true });
        return false;
      }

      case 'OFFSCREEN_START_DOWNLOAD': {
        if (activeControllers.has(message.taskId)) {
          sendResponse({ ok: true });
          return false;
        }

        const controller = new AbortController();
        activeControllers.set(message.taskId, controller);

        // 立即释放消息通道，后台异步执行流式下载并通过消息回传状态
        sendResponse({ ok: true });
        void runDownloadTask(message, controller);
        return false;
      }
    }
  },
);

console.info('[Collect+] Offscreen document ready.');
