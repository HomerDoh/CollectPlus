/**
 * Collect+ Offscreen Document 入口。
 *
 * 接收来自 Background Service Worker 的下载控制指令（PING / START / STAGE_COMMENTS / ABORT），
 * 调度 `executeDownloadJob` 与 `stageItemCommentsToOpfs` 流式落盘至 OPFS，
 * 并将实时进度、完成结果与异常回传 Background。
 */

import {
  executeDownloadJob,
  isAbortError,
  probeVideoAssetsSizeBytes,
  stageItemCommentsToOpfs,
} from '../../download/pipeline.ts';
import { tryAutoFlushToVault } from '../../storage/vault.ts';
import {
  isOffscreenMessage,
  sendToBackground,
  type OffscreenStageCommentsMessage,
  type OffscreenStartDownloadMessage,
} from '../../types/messages.ts';

/** 当前正在执行的下载任务中止控制器映射（key = taskId） */
const activeControllers = new Map<string, AbortController>();
/** 当前正在执行的评论与头像暂存任务中止控制器映射（key = itemId） */
const activeCommentControllers = new Map<string, AbortController>();

/** 下载完成后静默落盘合批锁：连续多条视频或评论下载完成时合并批次写入 CollectVault */
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
  const { taskId, itemId, assets, allowAllAssetsFailed } = message;

  try {
    const result = await executeDownloadJob({
      itemId,
      assets,
      ...(allowAllAssetsFailed !== undefined ? { allowAllAssetsFailed } : {}),
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

async function runCommentsStageTask(
  message: OffscreenStageCommentsMessage,
  controller: AbortController,
): Promise<void> {
  const { itemId, platform, sourceId, comments, limit } = message;

  try {
    const result = await stageItemCommentsToOpfs({
      itemId,
      platform,
      sourceId,
      comments,
      limit,
      signal: controller.signal,
    });

    const completeRes = await sendToBackground({
      target: 'background',
      type: 'OFFSCREEN_COMMENTS_COMPLETE',
      itemId,
      commentsRelativePath: result.commentsRelativePath,
      savedCommentCount: result.savedCommentCount,
      commentsSizeBytes: result.commentsSizeBytes,
    }).catch(() => undefined);

    if (completeRes?.ok) {
      scheduleAutoFlushToVault();
    }
  } catch (error) {
    const aborted = controller.signal.aborted || isAbortError(error);
    await sendToBackground({
      target: 'background',
      type: 'OFFSCREEN_COMMENTS_ERROR',
      itemId,
      error: aborted
        ? 'Comment staging task was cancelled.'
        : formatErrorMessage(error),
    }).catch(() => undefined);
  } finally {
    if (activeCommentControllers.get(itemId) === controller) {
      activeCommentControllers.delete(itemId);
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

      case 'OFFSCREEN_PROBE_MEDIA_SIZE': {
        void probeVideoAssetsSizeBytes(message.assets)
          .then((totalSizeBytes) => {
            sendResponse({
              ok: true,
              ...(totalSizeBytes !== undefined ? { totalSizeBytes } : {}),
            });
          })
          .catch((error: unknown) => {
            sendResponse({
              ok: false,
              error: formatErrorMessage(error),
            });
          });
        return true;
      }

      case 'OFFSCREEN_ABORT_DOWNLOAD': {
        const controller = activeControllers.get(message.taskId);
        if (controller) {
          activeControllers.delete(message.taskId);
          controller.abort(
            new DOMException(
              'Download task cancelled by background.',
              'AbortError',
            ),
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

      case 'OFFSCREEN_STAGE_COMMENTS': {
        const existing = activeCommentControllers.get(message.itemId);
        if (existing) {
          existing.abort(
            new DOMException(
              'Superseded by newer comment staging request.',
              'AbortError',
            ),
          );
        }

        const controller = new AbortController();
        activeCommentControllers.set(message.itemId, controller);

        sendResponse({ ok: true });
        void runCommentsStageTask(message, controller);
        return false;
      }
    }
  },
);

console.info('[Collect+] Offscreen document ready.');
