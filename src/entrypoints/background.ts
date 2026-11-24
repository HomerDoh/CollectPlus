/**
 * Collect+ Background Service Worker 事件中枢。
 *
 * 职责：
 * 1. 会话级 DNR 防盗链请求头规则幂等同步；
 * 2. SW 重启后残留下载任务异常恢复；
 * 3. 受控并发下载调度器（连接 Dexie 任务队列与 Offscreen 流式下载引擎）；
 * 4. 快捷键命令与全量 `BackgroundMessage` 强类型路由分发；
 * 5. 任务来源标签页追踪与实时采集/下载进度推送。
 */

import { ulid } from 'ulid';
import {
  collectAllPlatformDnrSpecs,
  matchAdapterByUrl,
} from '../adapters/registry.ts';
import { syncSessionDnrRules } from '../download/dnr.ts';
import {
  ensureOffscreenDocument,
  hasOffscreenDocument,
} from '../download/offscreen-manager.ts';
import {
  createFolder,
  db,
  getUserPreferences,
  updateItemClassification,
  upsertTags,
} from '../storage/db.ts';
import {
  buildItemRelativeDir,
  buildMediaAssetsFromPayload,
} from '../storage/path.ts';
import {
  isBackgroundMessage,
  sendToOffscreen,
  sendToTab,
  type BackgroundMessage,
  type BackgroundResponseMap,
  type ContentCaptureStatusState,
} from '../types/messages.ts';
import {
  SCHEMA_VERSION,
  type CollectionItemRecord,
  type DownloadTask,
  type MediaAsset,
} from '../types/schema.ts';

/** 快捷键命令 ID（与 wxt.config.ts manifest.commands 保持一致） */
const CAPTURE_COMMAND_ID = 'capture-current-item';
/** SW 重启异常恢复允许自动重新入队的最大重试次数上限 */
const MAX_STARTUP_RECOVERY_RETRIES = 3;
/** 允许的最大并发下载上限安全边界 */
const MAX_CONCURRENCY_CEILING = 6;
/** 管理台页面相对路径 */
const LIBRARY_PAGE_PATH = '/library.html';

/** 任务来源标签页追踪表：taskId -> tabId */
const taskOriginTabs = new Map<string, number>();

/** DNR 规则同步状态与并发去重锁 */
let dnrReady = false;
let dnrSyncPromise: Promise<void> | null = null;

/** 启动异常恢复去重锁 */
let startupRecoveryPromise: Promise<void> | null = null;

/** 受控并发下载队列调度锁（防止并发重入重复派发同一任务） */
let isPumpingQueue = false;
let pendingQueuePump = false;

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return String(error);
}

/**
 * 幂等确保会话级 DNR 防盗链规则已同步就绪。
 *
 * @param force 为 true 时忽略本地缓存标记，强制重新同步一次
 */
async function ensureDnrReady(force = false): Promise<void> {
  if (dnrReady && !force) {
    return;
  }

  if (dnrSyncPromise) {
    await dnrSyncPromise;
    if (dnrReady && !force) {
      return;
    }
  }

  const syncTask = (async () => {
    await syncSessionDnrRules(collectAllPlatformDnrSpecs());
    dnrReady = true;
  })();

  dnrSyncPromise = syncTask;

  try {
    await syncTask;
  } catch (error) {
    dnrReady = false;
    throw error;
  } finally {
    if (dnrSyncPromise === syncTask) {
      dnrSyncPromise = null;
    }
  }
}

/**
 * 安全向指定标签页推送采集/下载状态更新；若标签页已关闭或未注入脚本则静默吞掉异常。
 */
async function pushCaptureStatusToTab(
  tabId: number | undefined,
  payload: {
    itemId: string;
    taskId?: string;
    status: ContentCaptureStatusState;
    progress?: number;
    title?: string;
    error?: string;
  },
): Promise<void> {
  if (tabId === undefined) {
    return;
  }

  try {
    await sendToTab(tabId, {
      target: 'content',
      type: 'CONTENT_CAPTURE_STATUS',
      itemId: payload.itemId,
      status: payload.status,
      ...(payload.taskId !== undefined ? { taskId: payload.taskId } : {}),
      ...(payload.progress !== undefined ? { progress: payload.progress } : {}),
      ...(payload.title !== undefined ? { title: payload.title } : {}),
      ...(payload.error !== undefined ? { error: payload.error } : {}),
    });
  } catch {
    // 标签页可能已关闭、导航离开或尚未就绪，静默忽略
  }
}

/**
 * 按 taskId 查找来源标签页并推送状态更新。
 */
async function pushTaskStatusToOriginTab(
  taskId: string,
  payload: {
    itemId: string;
    status: ContentCaptureStatusState;
    progress?: number;
    title?: string;
    error?: string;
  },
): Promise<void> {
  const tabId = taskOriginTabs.get(taskId);
  if (tabId === undefined) {
    return;
  }
  await pushCaptureStatusToTab(tabId, {
    ...payload,
    taskId,
  });
}

/**
 * 查找当前活动标签页（优先 lastFocusedWindow，回退 currentWindow）。
 */
async function queryActiveTab(): Promise<chrome.tabs.Tab | undefined> {
  const focusedTabs = await chrome.tabs.query({
    active: true,
    lastFocusedWindow: true,
  });
  if (focusedTabs[0]) {
    return focusedTabs[0];
  }

  const currentTabs = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  });
  return currentTabs[0];
}

/**
 * 合并现有资产与 Offscreen 完成返回的资产列表，保留已完成资产状态与元数据。
 */
function mergeCompletedAssets(
  existingAssets: readonly MediaAsset[],
  incomingAssets: readonly MediaAsset[],
): MediaAsset[] {
  const incomingById = new Map<string, MediaAsset>();
  for (const asset of incomingAssets) {
    incomingById.set(asset.id, asset);
  }

  const merged: MediaAsset[] = [];
  const consumedIds = new Set<string>();

  for (const existing of existingAssets) {
    const incoming = incomingById.get(existing.id);
    if (incoming) {
      consumedIds.add(existing.id);
      if (incoming.downloaded || !existing.downloaded) {
        merged.push({ ...incoming });
      } else {
        merged.push({ ...existing });
      }
    } else {
      merged.push({ ...existing });
    }
  }

  for (const incoming of incomingAssets) {
    if (!consumedIds.has(incoming.id)) {
      merged.push({ ...incoming });
    }
  }

  return merged;
}

/**
 * 恢复因 Service Worker 休眠/重启而滞留在 `downloading` 或 `processing` 状态的历史任务。
 */
async function recoverStaleTasksOnStartup(): Promise<void> {
  if (startupRecoveryPromise) {
    return startupRecoveryPromise;
  }

  startupRecoveryPromise = (async () => {
    const staleTasks = await db.tasks
      .where('status')
      .anyOf(['downloading', 'processing'])
      .toArray();

    if (staleTasks.length > 0) {
      const now = Date.now();
      await db.transaction('rw', db.tasks, db.items, async () => {
        for (const task of staleTasks) {
          if (task.retryCount < MAX_STARTUP_RECOVERY_RETRIES) {
            await db.tasks.put({
              ...task,
              status: 'queued',
              errorMessage: undefined,
              updatedAt: now,
            });
          } else {
            await db.tasks.put({
              ...task,
              status: 'failed',
              errorMessage: '后台下载在重启时中断且已达到最大自动重试次数。',
              updatedAt: now,
            });
            const item = await db.items.get(task.itemId);
            if (item && item.syncStatus === 'pending_download') {
              await db.items.put({
                ...item,
                syncStatus: 'failed',
                updatedAt: now,
              });
            }
          }
        }
      });
    }

    const queuedCount = await db.tasks.where('status').equals('queued').count();
    if (queuedCount > 0) {
      void pumpDownloadQueue();
    }
  })();

  try {
    await startupRecoveryPromise;
  } catch (error) {
    console.warn('[Collect+] Failed to recover stale tasks on startup:', error);
  } finally {
    startupRecoveryPromise = null;
  }
}

/**
 * 标记派发失败的任务与关联条目状态，并通知来源标签页。
 */
async function markDispatchFailure(
  task: DownloadTask,
  item: CollectionItemRecord,
  error: unknown,
): Promise<void> {
  const errorMessage = formatErrorMessage(error);
  const now = Date.now();

  await db.transaction('rw', db.tasks, db.items, async () => {
    const currentTask = await db.tasks.get(task.id);
    if (currentTask && currentTask.status !== 'cancelled') {
      await db.tasks.put({
        ...currentTask,
        status: 'failed',
        errorMessage,
        updatedAt: now,
      });
    }

    const currentItem = await db.items.get(item.id);
    if (currentItem && currentItem.syncStatus === 'pending_download') {
      await db.items.put({
        ...currentItem,
        syncStatus: 'failed',
        updatedAt: now,
      });
    }
  });

  await pushTaskStatusToOriginTab(task.id, {
    itemId: item.id,
    status: 'failed',
    title: item.title,
    error: errorMessage,
  });
  taskOriginTabs.delete(task.id);
}

/**
 * 受控并发下载调度器：
 * 按 `createdAt` 升序取出 `queued` 任务并派发至 Offscreen Document，
 * 严格遵循 `UserPreferences.maxConcurrentDownloads` 上限并通过调度锁防重入。
 */
async function pumpDownloadQueue(): Promise<void> {
  if (isPumpingQueue) {
    pendingQueuePump = true;
    return;
  }

  isPumpingQueue = true;

  try {
    do {
      pendingQueuePump = false;

      const prefs = await getUserPreferences();
      const configuredLimit = Number.isFinite(prefs.maxConcurrentDownloads)
        ? Math.floor(prefs.maxConcurrentDownloads)
        : 2;
      const maxConcurrent = Math.max(
        1,
        Math.min(MAX_CONCURRENCY_CEILING, configuredLimit),
      );

      const activeCount = await db.tasks
        .where('status')
        .anyOf(['downloading', 'processing'])
        .count();

      let availableSlots = maxConcurrent - activeCount;
      if (availableSlots <= 0) {
        continue;
      }

      const queuedTasks = await db.tasks
        .where('status')
        .equals('queued')
        .sortBy('createdAt');

      if (queuedTasks.length === 0) {
        continue;
      }

      for (const task of queuedTasks) {
        if (availableSlots <= 0) {
          break;
        }

        const item = await db.items.get(task.itemId);
        if (!item || item.deletedAt != null) {
          await db.tasks.put({
            ...task,
            status: 'cancelled',
            errorMessage: '关联收藏条目不存在或已移入回收站。',
            updatedAt: Date.now(),
          });
          taskOriginTabs.delete(task.id);
          continue;
        }

        try {
          await ensureDnrReady();
          await ensureOffscreenDocument();

          // 异步等待后二次确认任务未被用户取消或重复派发
          const latestTask = await db.tasks.get(task.id);
          if (!latestTask || latestTask.status !== 'queued') {
            continue;
          }

          const now = Date.now();
          await db.tasks.put({
            ...latestTask,
            status: 'downloading',
            errorMessage: undefined,
            updatedAt: now,
          });

          const response = await sendToOffscreen({
            target: 'offscreen',
            type: 'OFFSCREEN_START_DOWNLOAD',
            taskId: latestTask.id,
            itemId: item.id,
            platform: item.platform,
            relativeDir: item.relativeDir,
            assets: item.assets,
          });

          if (!response || !response.ok) {
            const errText =
              response && !response.ok
                ? response.error
                : 'Offscreen 拒绝启动下载任务。';
            throw new Error(errText);
          }

          availableSlots -= 1;

          await pushTaskStatusToOriginTab(latestTask.id, {
            itemId: item.id,
            status: 'downloading',
            progress: latestTask.progress,
            title: item.title,
          });
        } catch (error) {
          await markDispatchFailure(task, item, error);
        }
      }
    } while (pendingQueuePump);
  } catch (error) {
    console.error('[Collect+] Download queue pump failed:', error);
  } finally {
    isPumpingQueue = false;
  }
}

// ============================================================================
// BackgroundMessage 处理器实现
// ============================================================================

async function handleCaptureItem(
  message: Extract<BackgroundMessage, { type: 'CAPTURE_ITEM' }>,
  sender: chrome.runtime.MessageSender,
): Promise<BackgroundResponseMap['CAPTURE_ITEM']> {
  const { payload } = message;
  const dedupeKey = `${payload.platform}:${payload.sourceId}`;
  const originTabId = sender.tab?.id;

  const existing = await db.items.where('dedupeKey').equals(dedupeKey).first();
  if (
    existing &&
    existing.deletedAt == null &&
    existing.syncStatus !== 'failed'
  ) {
    await pushCaptureStatusToTab(originTabId, {
      itemId: existing.id,
      status: 'deduplicated',
      title: existing.title,
    });
    return {
      ok: true,
      itemId: existing.id,
      deduplicated: true,
      item: existing,
    };
  }

  const now = Date.now();
  const itemId = existing ? existing.id : ulid();
  const relativeDir = buildItemRelativeDir(
    payload.platform,
    payload.sourceId,
    payload.title,
    now,
  );
  const { assets, coverRelativePath } = buildMediaAssetsFromPayload(payload);

  const mergedRawTags = [
    ...payload.hashtags,
    ...(message.tags ?? []),
  ];
  const upsertedTags = await upsertTags(mergedRawTags);
  const tagNames = upsertedTags.map((tag) => tag.name);

  const prefs = await getUserPreferences();
  let resolvedFolderId: string | null =
    message.folderId !== undefined ? message.folderId : prefs.defaultFolderId;
  if (resolvedFolderId !== null) {
    const existingFolder = await db.folders.get(resolvedFolderId);
    if (!existingFolder) {
      resolvedFolderId = null;
    }
  }

  const itemRecord: CollectionItemRecord = {
    schemaVersion: SCHEMA_VERSION,
    id: itemId,
    dedupeKey,
    platform: payload.platform,
    sourceId: payload.sourceId,
    sourceUrl: payload.sourceUrl,
    kind: payload.kind,
    title: payload.title,
    description: payload.description,
    author: payload.author,
    ...(payload.publishedAt !== undefined
      ? { publishedAt: payload.publishedAt }
      : {}),
    collectedAt: now,
    updatedAt: now,
    folderId: resolvedFolderId,
    tags: tagNames,
    note: existing && existing.deletedAt == null ? existing.note : '',
    relativeDir,
    ...(coverRelativePath !== undefined ? { coverRelativePath } : {}),
    assets,
    syncStatus: 'pending_download',
    totalSizeBytes: 0,
    deletedAt: null,
    ...(payload.platformExtra !== undefined
      ? { platformExtra: payload.platformExtra }
      : {}),
  };

  const taskId = ulid();
  const taskRecord: DownloadTask = {
    id: taskId,
    itemId,
    dedupeKey,
    platform: payload.platform,
    title: payload.title,
    status: 'queued',
    progress: 0,
    completedAssets: 0,
    totalAssets: assets.length,
    downloadedBytes: 0,
    totalBytes: 0,
    retryCount: 0,
    createdAt: now,
    updatedAt: now,
  };

  await db.transaction('rw', db.items, db.tasks, async () => {
    await db.items.put(itemRecord);
    await db.tasks.add(taskRecord);
  });

  if (originTabId !== undefined) {
    taskOriginTabs.set(taskId, originTabId);
  }

  void pumpDownloadQueue();

  return {
    ok: true,
    itemId,
    taskId,
    deduplicated: false,
    item: itemRecord,
  };
}

async function handleUpdateItemClassification(
  message: Extract<BackgroundMessage, { type: 'UPDATE_ITEM_CLASSIFICATION' }>,
): Promise<BackgroundResponseMap['UPDATE_ITEM_CLASSIFICATION']> {
  const patch: {
    folderId?: string | null;
    tags?: string[];
    note?: string;
  } = {};

  if (message.folderId !== undefined) {
    patch.folderId = message.folderId;
  }
  if (message.tags !== undefined) {
    patch.tags = message.tags;
  }
  if (message.note !== undefined) {
    patch.note = message.note;
  }

  const updated = await updateItemClassification(message.itemId, patch);
  if (!updated) {
    return { ok: false, error: '未找到对应的收藏条目。' };
  }

  return { ok: true, item: updated };
}

async function handleGetTaxonomy(): Promise<
  BackgroundResponseMap['GET_TAXONOMY']
> {
  const [folders, tags] = await Promise.all([
    db.folders.orderBy('sortOrder').toArray(),
    db.tags.orderBy('createdAt').toArray(),
  ]);

  return { ok: true, folders, tags };
}

async function handleCreateFolderQuick(
  message: Extract<BackgroundMessage, { type: 'CREATE_FOLDER_QUICK' }>,
): Promise<BackgroundResponseMap['CREATE_FOLDER_QUICK']> {
  const folder = await createFolder(message.name, message.parentId ?? null);
  return { ok: true, folder };
}

async function handleGetStatusSummary(
  message: Extract<BackgroundMessage, { type: 'GET_STATUS_SUMMARY' }>,
): Promise<BackgroundResponseMap['GET_STATUS_SUMMARY']> {
  const supportedPlatform = message.tabUrl
    ? (matchAdapterByUrl(message.tabUrl)?.id ?? null)
    : null;

  const [allItems, activeTaskCount] = await Promise.all([
    db.items.toArray(),
    db.tasks
      .where('status')
      .anyOf(['queued', 'downloading', 'processing'])
      .count(),
  ]);

  let totalItems = 0;
  let stagedCount = 0;
  let metaDirtyCount = 0;

  for (const item of allItems) {
    if (item.deletedAt != null) {
      continue;
    }
    totalItems += 1;
    if (item.syncStatus === 'opfs_staged') {
      stagedCount += 1;
    } else if (item.syncStatus === 'meta_dirty') {
      metaDirtyCount += 1;
    }
  }

  return {
    ok: true,
    supportedPlatform,
    totalItems,
    stagedCount,
    metaDirtyCount,
    activeTaskCount,
  };
}

async function handleTriggerActiveTabCapture(
  message: Extract<BackgroundMessage, { type: 'TRIGGER_ACTIVE_TAB_CAPTURE' }>,
): Promise<BackgroundResponseMap['TRIGGER_ACTIVE_TAB_CAPTURE']> {
  let targetTab: chrome.tabs.Tab | undefined;

  if (message.tabId !== undefined) {
    try {
      targetTab = await chrome.tabs.get(message.tabId);
    } catch {
      return { ok: false, error: '目标标签页不存在或已关闭。' };
    }
  } else {
    targetTab = await queryActiveTab();
  }

  if (!targetTab || targetTab.id === undefined) {
    return { ok: false, error: '未找到当前活动标签页。' };
  }

  if (!targetTab.url || !matchAdapterByUrl(targetTab.url)) {
    return { ok: false, error: '当前页面暂不支持一键采集。' };
  }

  try {
    const response = await sendToTab(targetTab.id, {
      target: 'content',
      type: 'CONTENT_TRIGGER_CAPTURE',
      triggerSource: 'popup',
    });
    if (response && !response.ok) {
      return { ok: false, error: response.error };
    }
    return { ok: true };
  } catch {
    return {
      ok: false,
      error: '无法连接到页面采集脚本，请刷新当前页面后重试。',
    };
  }
}

async function handleRetryDownloadTask(
  message: Extract<BackgroundMessage, { type: 'RETRY_DOWNLOAD_TASK' }>,
  sender: chrome.runtime.MessageSender,
): Promise<BackgroundResponseMap['RETRY_DOWNLOAD_TASK']> {
  const task = await db.tasks.get(message.taskId);
  if (!task) {
    return { ok: false, error: '未找到对应的下载任务。' };
  }

  const item = await db.items.get(task.itemId);
  if (!item || item.deletedAt != null) {
    return { ok: false, error: '关联收藏条目不存在或已移入回收站。' };
  }

  if (task.status === 'downloading' || task.status === 'processing') {
    return { ok: true };
  }

  const now = Date.now();
  await db.transaction('rw', db.tasks, db.items, async () => {
    await db.tasks.put({
      ...task,
      status: 'queued',
      progress: 0,
      completedAssets: 0,
      downloadedBytes: 0,
      retryCount: task.retryCount + 1,
      errorMessage: undefined,
      updatedAt: now,
    });

    await db.items.put({
      ...item,
      syncStatus: 'pending_download',
      updatedAt: now,
    });
  });

  if (sender.tab?.id !== undefined) {
    taskOriginTabs.set(task.id, sender.tab.id);
  }

  await pushTaskStatusToOriginTab(task.id, {
    itemId: item.id,
    status: 'queued',
    progress: 0,
    title: item.title,
  });

  void pumpDownloadQueue();

  return { ok: true };
}

async function handleCancelDownloadTask(
  message: Extract<BackgroundMessage, { type: 'CANCEL_DOWNLOAD_TASK' }>,
): Promise<BackgroundResponseMap['CANCEL_DOWNLOAD_TASK']> {
  const task = await db.tasks.get(message.taskId);
  if (!task) {
    return { ok: false, error: '未找到对应的下载任务。' };
  }

  if (task.status === 'completed' || task.status === 'cancelled') {
    return { ok: true };
  }

  await db.tasks.put({
    ...task,
    status: 'cancelled',
    errorMessage: '下载任务已取消。',
    updatedAt: Date.now(),
  });

  if (await hasOffscreenDocument()) {
    await sendToOffscreen({
      target: 'offscreen',
      type: 'OFFSCREEN_ABORT_DOWNLOAD',
      taskId: task.id,
    }).catch(() => undefined);
  }

  taskOriginTabs.delete(task.id);
  void pumpDownloadQueue();

  return { ok: true };
}

async function handleOpenLibraryPage(
  message: Extract<BackgroundMessage, { type: 'OPEN_LIBRARY_PAGE' }>,
): Promise<BackgroundResponseMap['OPEN_LIBRARY_PAGE']> {
  const baseUrl = chrome.runtime.getURL(LIBRARY_PAGE_PATH);
  const targetUrl = message.itemId
    ? `${baseUrl}#item=${encodeURIComponent(message.itemId)}`
    : baseUrl;

  try {
    const existingTabs = await chrome.tabs.query({ url: `${baseUrl}*` });
    const matchedTab = existingTabs.find((tab) => tab.id !== undefined);

    if (matchedTab && matchedTab.id !== undefined) {
      await chrome.tabs.update(matchedTab.id, {
        active: true,
        ...(message.itemId ? { url: targetUrl } : {}),
      });
      if (matchedTab.windowId !== undefined) {
        await chrome.windows
          .update(matchedTab.windowId, { focused: true })
          .catch(() => undefined);
      }
    } else {
      await chrome.tabs.create({ url: targetUrl });
    }
  } catch (error) {
    console.error('[Collect+] Failed to open library page:', error);
  }

  return { ok: true };
}

async function handleOffscreenProgress(
  message: Extract<BackgroundMessage, { type: 'OFFSCREEN_PROGRESS' }>,
): Promise<BackgroundResponseMap['OFFSCREEN_PROGRESS']> {
  try {
    const clampedProgress = Math.max(0, Math.min(100, Math.round(message.progress)));
    let taskTitle: string | undefined;
    let shouldPush = false;

    await db.transaction('rw', db.tasks, async () => {
      const task = await db.tasks.get(message.taskId);
      if (
        !task ||
        task.status === 'cancelled' ||
        task.status === 'completed' ||
        task.status === 'failed'
      ) {
        return;
      }

      taskTitle = task.title;
      shouldPush = true;
      await db.tasks.put({
        ...task,
        status: 'downloading',
        progress: clampedProgress,
        completedAssets: message.completedAssets,
        totalAssets: message.totalAssets,
        downloadedBytes: message.downloadedBytes,
        totalBytes: message.totalBytes,
        updatedAt: Date.now(),
      });
    });

    if (shouldPush && taskTitle !== undefined) {
      await pushTaskStatusToOriginTab(message.taskId, {
        itemId: message.itemId,
        status: 'downloading',
        progress: clampedProgress,
        title: taskTitle,
      });
    }
  } catch (error) {
    console.warn('[Collect+] Failed to handle OFFSCREEN_PROGRESS:', error);
  }

  return { ok: true };
}

async function handleOffscreenComplete(
  message: Extract<BackgroundMessage, { type: 'OFFSCREEN_COMPLETE' }>,
): Promise<BackgroundResponseMap['OFFSCREEN_COMPLETE']> {
  try {
    const now = Date.now();
    let itemTitle: string | undefined;

    await db.transaction('rw', db.items, db.tasks, async () => {
      const existingItem = await db.items.get(message.itemId);
      const existingTask = await db.tasks.get(message.taskId);

      const mergedAssets = existingItem
        ? mergeCompletedAssets(existingItem.assets, message.assets)
        : message.assets;

      if (existingItem) {
        itemTitle = existingItem.title;
        await db.items.put({
          ...existingItem,
          assets: mergedAssets,
          totalSizeBytes: message.totalSizeBytes,
          syncStatus: 'opfs_staged',
          updatedAt: now,
          ...(message.thumbnailDataUrl !== undefined
            ? { thumbnailDataUrl: message.thumbnailDataUrl }
            : {}),
        });
      }

      if (existingTask) {
        itemTitle = itemTitle ?? existingTask.title;
        const completedCount = mergedAssets.filter(
          (asset) => asset.downloaded,
        ).length;
        await db.tasks.put({
          ...existingTask,
          status: 'completed',
          progress: 100,
          completedAssets: completedCount,
          totalAssets: mergedAssets.length,
          downloadedBytes: message.totalSizeBytes,
          totalBytes: message.totalSizeBytes,
          errorMessage: undefined,
          updatedAt: now,
        });
      }
    });

    await pushTaskStatusToOriginTab(message.taskId, {
      itemId: message.itemId,
      status: 'staged',
      progress: 100,
      ...(itemTitle !== undefined ? { title: itemTitle } : {}),
    });
  } catch (error) {
    console.error('[Collect+] Failed to handle OFFSCREEN_COMPLETE:', error);
  } finally {
    taskOriginTabs.delete(message.taskId);
    void pumpDownloadQueue();
  }

  return { ok: true };
}

async function handleOffscreenError(
  message: Extract<BackgroundMessage, { type: 'OFFSCREEN_ERROR' }>,
): Promise<BackgroundResponseMap['OFFSCREEN_ERROR']> {
  try {
    const now = Date.now();
    let itemTitle: string | undefined;
    let isCancelled = false;

    await db.transaction('rw', db.items, db.tasks, async () => {
      const existingTask = await db.tasks.get(message.taskId);
      const existingItem = await db.items.get(message.itemId);

      itemTitle = existingItem?.title ?? existingTask?.title;
      isCancelled =
        existingTask?.status === 'cancelled' || !message.retryable;

      if (existingTask) {
        await db.tasks.put({
          ...existingTask,
          status: isCancelled ? 'cancelled' : 'failed',
          errorMessage: message.error,
          updatedAt: now,
        });
      }

      if (
        !isCancelled &&
        existingItem &&
        existingItem.syncStatus === 'pending_download'
      ) {
        await db.items.put({
          ...existingItem,
          syncStatus: 'failed',
          updatedAt: now,
        });
      }
    });

    if (!isCancelled) {
      await pushTaskStatusToOriginTab(message.taskId, {
        itemId: message.itemId,
        status: 'failed',
        ...(itemTitle !== undefined ? { title: itemTitle } : {}),
        error: message.error,
      });
    }
  } catch (error) {
    console.error('[Collect+] Failed to handle OFFSCREEN_ERROR:', error);
  } finally {
    taskOriginTabs.delete(message.taskId);
    void pumpDownloadQueue();
  }

  return { ok: true };
}

async function routeBackgroundMessage(
  message: BackgroundMessage,
  sender: chrome.runtime.MessageSender,
): Promise<BackgroundResponseMap[BackgroundMessage['type']]> {
  switch (message.type) {
    case 'CAPTURE_ITEM':
      return handleCaptureItem(message, sender);
    case 'UPDATE_ITEM_CLASSIFICATION':
      return handleUpdateItemClassification(message);
    case 'GET_TAXONOMY':
      return handleGetTaxonomy();
    case 'CREATE_FOLDER_QUICK':
      return handleCreateFolderQuick(message);
    case 'GET_STATUS_SUMMARY':
      return handleGetStatusSummary(message);
    case 'TRIGGER_ACTIVE_TAB_CAPTURE':
      return handleTriggerActiveTabCapture(message);
    case 'RETRY_DOWNLOAD_TASK':
      return handleRetryDownloadTask(message, sender);
    case 'CANCEL_DOWNLOAD_TASK':
      return handleCancelDownloadTask(message);
    case 'OPEN_LIBRARY_PAGE':
      return handleOpenLibraryPage(message);
    case 'OFFSCREEN_PROGRESS':
      return handleOffscreenProgress(message);
    case 'OFFSCREEN_COMPLETE':
      return handleOffscreenComplete(message);
    case 'OFFSCREEN_ERROR':
      return handleOffscreenError(message);
  }
}

export default defineBackground(() => {
  // 1. 扩展安装/更新与浏览器启动生命周期钩子
  chrome.runtime.onInstalled.addListener(() => {
    void ensureDnrReady(true).catch((error) => {
      console.error('[Collect+] Failed to sync DNR rules onInstalled:', error);
    });
  });

  chrome.runtime.onStartup.addListener(() => {
    void ensureDnrReady(true)
      .then(() => recoverStaleTasksOnStartup())
      .catch((error) => {
        console.error('[Collect+] Failed during onStartup recovery:', error);
      });
  });

  // 2. 标签页关闭时清理来源追踪映射
  chrome.tabs.onRemoved.addListener((closedTabId) => {
    for (const [taskId, tabId] of taskOriginTabs.entries()) {
      if (tabId === closedTabId) {
        taskOriginTabs.delete(taskId);
      }
    }
  });

  // 3. 全局快捷键命令监听（Alt+S -> capture-current-item）
  chrome.commands.onCommand.addListener((command) => {
    if (command !== CAPTURE_COMMAND_ID) {
      return;
    }

    void (async () => {
      const tab = await queryActiveTab();
      if (!tab || tab.id === undefined || !tab.url) {
        return;
      }
      if (!matchAdapterByUrl(tab.url)) {
        return;
      }

      await sendToTab(tab.id, {
        target: 'content',
        type: 'CONTENT_TRIGGER_CAPTURE',
        triggerSource: 'hotkey',
      }).catch(() => undefined);
    })();
  });

  // 4. 统一监听发往 Background 的强类型消息
  chrome.runtime.onMessage.addListener(
    (message: unknown, sender, sendResponse) => {
      if (!isBackgroundMessage(message)) {
        return false;
      }

      void routeBackgroundMessage(message, sender)
        .then((result) => {
          sendResponse(result);
        })
        .catch((error) => {
          console.error(
            `[Collect+] Error handling message "${message.type}":`,
            error,
          );
          sendResponse({
            ok: false,
            error: formatErrorMessage(error),
          });
        });

      return true;
    },
  );

  // 5. Service Worker 启动初始化：同步 DNR 规则并恢复残留下载任务
  void ensureDnrReady()
    .then(() => recoverStaleTasksOnStartup())
    .catch((error) => {
      console.error('[Collect+] Background initialization error:', error);
    });

  console.info('[Collect+] Background service worker initialized.');
});
