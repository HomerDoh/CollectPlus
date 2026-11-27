/**
 * Collect+ Background Service Worker 事件中枢。
 *
 * 职责：
 * 1. 会话级 DNR 防盗链请求头规则幂等同步；
 * 2. SW 重启后残留下载任务异常恢复；
 * 3. 受控并发下载调度器（连接 Dexie 任务队列与 Offscreen 流式下载引擎）；
 * 4. 快捷键命令与全量 `BackgroundMessage` 强类型路由分发；
 * 5. 浏览器扩展图标（`chrome.action`）环形下载进度与多任务计数实时渲染。
 */

import { ulid } from 'ulid';
import {
  collectAllPlatformDnrSpecs,
  matchAdapterByUrl,
} from '../adapters/registry.ts';
import {
  scheduleActionIconSync,
  startActionIconLiveSync,
} from '../download/action-icon.ts';
import { syncSessionDnrRules } from '../download/dnr.ts';
import {
  ensureOffscreenDocument,
  hasOffscreenDocument,
} from '../download/offscreen-manager.ts';
import {
  buildPlatformAccountKey,
  clampOversizedVideoThresholdMb,
  db,
  getPlatformAccountSyncState,
  getUserPreferences,
  markItemsAutoSyncExcluded,
  setPlatformAccountSyncState,
  upsertTags,
} from '../storage/db.ts';
import { removeItemFromOpfs } from '../storage/opfs.ts';
import {
  buildItemRelativeDir,
  buildMediaAssetsFromPayload,
  isSafeVaultRelativeDir,
} from '../storage/path.ts';
import type { CaptureTriggerSource } from '../types/adapter.ts';
import {
  isBackgroundMessage,
  sendToOffscreen,
  sendToTab,
  type BackgroundMessage,
  type BackgroundResponseMap,
} from '../types/messages.ts';
import type {
  CollectionItemRecord,
  DownloadTask,
  MediaAsset,
  PlatformId,
} from '../types/schema.ts';
import {
  isAutoSyncExcluded,
  isAutoSyncExclusionReason,
  PIN_HINT_PENDING_KEY,
  SCHEMA_VERSION,
} from '../types/schema.ts';

/** 快捷键命令 ID（与 wxt.config.ts manifest.commands 保持一致） */
const CAPTURE_COMMAND_ID = 'capture-current-item';
/** SW 重启异常恢复允许自动重新入队的最大重试次数上限 */
const MAX_STARTUP_RECOVERY_RETRIES = 3;
/** 允许的最大并发下载上限安全边界 */
const MAX_CONCURRENCY_CEILING = 6;
/** 管理台页面相对路径 */
const LIBRARY_PAGE_PATH = '/library.html';

/** DNR 规则同步状态与并发去重锁 */
let dnrReady = false;
let dnrSyncPromise: Promise<void> | null = null;

/** 启动异常恢复去重锁 */
let startupRecoveryPromise: Promise<void> | null = null;

/** 受控并发下载队列调度锁（防止并发重入重复派发同一任务） */
let isPumpingQueue = false;
let pendingQueuePump = false;

/** 正在执行全量收藏同步的账号集合（`${platform}:${accountId}`），防止多标签页重复触发 */
const inFlightAccountSyncs = new Set<string>();
/** 已触发风控进入被动旁路采集兜底的账号集合（`${platform}:${accountId}`） */
const passiveFallbackAccounts = new Set<string>();
/** 正在 Offscreen 中暂存评论与头像的条目 ID 集合 */
const inFlightCommentItemIds = new Set<string>();

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

    void scheduleActionIconSync();

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
 * 标记派发失败的任务与关联条目状态，并刷新扩展图标。
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

  void scheduleActionIconSync();
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
        if (!item || item.deletedAt != null || isAutoSyncExcluded(item)) {
          await db.tasks.put({
            ...task,
            status: 'cancelled',
            errorMessage: '关联收藏条目不存在、已移入回收站或已设为不自动同步。',
            updatedAt: Date.now(),
          });
          void scheduleActionIconSync();
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
          void scheduleActionIconSync();

          const response = await sendToOffscreen({
            target: 'offscreen',
            type: 'OFFSCREEN_START_DOWNLOAD',
            taskId: latestTask.id,
            itemId: item.id,
            platform: item.platform,
            relativeDir: item.relativeDir,
            assets: item.assets,
            ...(item.kind === 'article' ? { allowAllAssetsFailed: true } : {}),
          });

          if (!response || !response.ok) {
            const errText =
              response && !response.ok
                ? response.error
                : 'Offscreen 拒绝启动下载任务。';
            throw new Error(errText);
          }

          availableSlots -= 1;
        } catch (error) {
          await markDispatchFailure(task, item, error);
        }
      }
    } while (pendingQueuePump);
  } catch (error) {
    console.error('[Collect+] Download queue pump failed:', error);
  } finally {
    isPumpingQueue = false;
    void scheduleActionIconSync();
  }
}

// ============================================================================
// BackgroundMessage 处理器实现
// ============================================================================

const BYTES_PER_MIB = 1024 * 1024;

function isAutoSaveTrigger(source: CaptureTriggerSource): boolean {
  return source === 'native_collect' || source === 'auto_sync';
}

async function resolveVideoAssetsSizeBytes(
  videoAssets: readonly MediaAsset[],
): Promise<number | undefined> {
  if (videoAssets.length === 0) {
    return undefined;
  }

  // 快路径：平台接口元数据已提供全部视频资产的精确字节数，无需唤醒 Offscreen
  const allKnownInMeta = videoAssets.every(
    (asset) =>
      typeof asset.sizeBytes === 'number' &&
      Number.isFinite(asset.sizeBytes) &&
      asset.sizeBytes > 0,
  );
  if (allKnownInMeta) {
    return videoAssets.reduce(
      (sum, asset) => sum + Math.floor(asset.sizeBytes ?? 0),
      0,
    );
  }

  try {
    await ensureDnrReady();
    await ensureOffscreenDocument();
    const probeRes = await sendToOffscreen({
      target: 'offscreen',
      type: 'OFFSCREEN_PROBE_MEDIA_SIZE',
      assets: [...videoAssets],
    });
    if (probeRes && probeRes.ok && probeRes.totalSizeBytes !== undefined) {
      return probeRes.totalSizeBytes;
    }
  } catch (error) {
    console.warn('[Collect+] Failed to probe video size before auto-save:', error);
  }

  return undefined;
}

async function handleCaptureItem(
  message: Extract<BackgroundMessage, { type: 'CAPTURE_ITEM' }>,
): Promise<BackgroundResponseMap['CAPTURE_ITEM']> {
  const { payload } = message;
  const dedupeKey = `${payload.platform}:${payload.sourceId}`;
  const isAutoSync = payload.triggerSource === 'auto_sync';

  const existing = await db.items.where('dedupeKey').equals(dedupeKey).first();

  // 0. 显式取消/跳过本地持久化：仅记录轻量元数据与原因，中止已有下载并清理 OPFS，防止后续自动同步
  if (message.autoSyncExclusion) {
    const { reason, detail } = message.autoSyncExclusion;
    if (!isAutoSyncExclusionReason(reason)) {
      return { ok: false, error: '无效的取消本地持久化原因。' };
    }

    const trimmedDetail = detail?.trim();

    if (existing) {
      const relatedTasks = await db.tasks
        .where('itemId')
        .equals(existing.id)
        .toArray();
      const activeTaskIdsToAbort = relatedTasks
        .filter(
          (task) =>
            task.status === 'downloading' || task.status === 'processing',
        )
        .map((task) => task.id);

      const updatedList = await markItemsAutoSyncExcluded([
        {
          itemId: existing.id,
          reason,
          ...(trimmedDetail ? { detail: trimmedDetail } : {}),
        },
      ]);

      if (activeTaskIdsToAbort.length > 0 && (await hasOffscreenDocument())) {
        await Promise.all(
          activeTaskIdsToAbort.map((taskId) =>
            sendToOffscreen({
              target: 'offscreen',
              type: 'OFFSCREEN_ABORT_DOWNLOAD',
              taskId,
            }).catch(() => undefined),
          ),
        );
      }

      await removeItemFromOpfs(existing.id).catch(() => undefined);
      void scheduleActionIconSync();
      void pumpDownloadQueue();

      const updatedItem = updatedList[0] ?? existing;
      return {
        ok: true,
        itemId: updatedItem.id,
        deduplicated: false,
        skippedReason: 'auto_sync_excluded',
        item: updatedItem,
      };
    }

    const now = Date.now();
    const itemId = ulid();
    const relativeDir = buildItemRelativeDir(
      payload.platform,
      payload.sourceId,
      payload.title,
      now,
    );
    const { assets, coverRelativePath } = buildMediaAssetsFromPayload(payload);
    const resetAssets: MediaAsset[] = assets.map((asset) => {
      const { sizeBytes: _sizeBytes, ...rest } = asset;
      void _sizeBytes;
      return { ...rest, downloaded: false };
    });

    const mergedRawTags = [...payload.hashtags, ...(message.tags ?? [])];
    const upsertedTags = await upsertTags(mergedRawTags);
    const tagNames = upsertedTags.map((tag) => tag.name);

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
      folderId: null,
      folderIds: [],
      tags: tagNames,
      note: '',
      relativeDir,
      ...(coverRelativePath !== undefined ? { coverRelativePath } : {}),
      assets: resetAssets,
      syncStatus: 'meta_dirty',
      totalSizeBytes: 0,
      deletedAt: null,
      autoSyncExclusion: {
        reason,
        ...(trimmedDetail ? { detail: trimmedDetail } : {}),
        excludedAt: now,
      },
      ...(payload.platformExtra !== undefined
        ? { platformExtra: payload.platformExtra }
        : {}),
    };

    await db.items.put(itemRecord);
    return {
      ok: true,
      itemId,
      deduplicated: false,
      skippedReason: 'auto_sync_excluded',
      item: itemRecord,
    };
  }

  // 1. 已处于「不自动同步」分类：自动同步严格跳过；手动触发（悬浮按钮/Alt+S/Popup/原站重收藏）允许解除忽略并重新下载
  if (existing && isAutoSyncExcluded(existing)) {
    if (isAutoSync) {
      return {
        ok: true,
        itemId: existing.id,
        deduplicated: true,
        skippedReason: 'auto_sync_excluded',
        item: existing,
      };
    }
  } else if (existing && existing.deletedAt != null) {
    // 2. 回收站中的条目：自动同步不得错误恢复；手动触发沿用原地恢复或重下载逻辑
    if (isAutoSync) {
      return {
        ok: true,
        itemId: existing.id,
        deduplicated: true,
        skippedReason: 'in_trash',
        item: existing,
      };
    }

    const now = Date.now();
    if (
      existing.syncStatus === 'opfs_staged' ||
      existing.syncStatus === 'vault_synced' ||
      existing.syncStatus === 'meta_dirty'
    ) {
      const restored: CollectionItemRecord = {
        ...existing,
        deletedAt: null,
        updatedAt: now,
        syncStatus:
          existing.syncStatus === 'vault_synced'
            ? 'meta_dirty'
            : existing.syncStatus,
      };
      await db.items.put(restored);
      return {
        ok: true,
        itemId: restored.id,
        deduplicated: false,
        item: restored,
      };
    }
  } else if (
    existing &&
    existing.deletedAt == null &&
    existing.syncStatus !== 'failed'
  ) {
    return {
      ok: true,
      itemId: existing.id,
      deduplicated: true,
      item: existing,
    };
  }

  const { assets, coverRelativePath } = buildMediaAssetsFromPayload(payload);
  const prefs = await getUserPreferences();

  // 视频过大取消自动保存拦截：仅作用于自动保存（原站收藏 / 全量同步），手动收藏或弹窗“继续保存”直接放行
  if (
    !message.forceSave &&
    prefs.skipOversizedVideoAutoSave &&
    payload.kind === 'video' &&
    isAutoSaveTrigger(payload.triggerSource)
  ) {
    const videoAssets = assets.filter((asset) => asset.kind === 'video');
    const videoSizeBytes = await resolveVideoAssetsSizeBytes(videoAssets);
    const thresholdMb = clampOversizedVideoThresholdMb(
      prefs.oversizedVideoThresholdMb,
    );
    const thresholdBytes = thresholdMb * BYTES_PER_MIB;
    if (videoSizeBytes !== undefined && videoSizeBytes > thresholdBytes) {
      return {
        ok: true,
        skippedOversized: true,
        videoSizeBytes,
        thresholdMb,
        notifyMode: prefs.oversizedVideoNotifyMode,
      };
    }
  }

  const now = Date.now();
  const itemId = existing ? existing.id : ulid();
  // 复用已有合法 relativeDir（特别是从「不自动同步」手动重采集时，避免 Vault 遗留旧目录）
  const relativeDir =
    existing && isSafeVaultRelativeDir(existing.relativeDir)
      ? existing.relativeDir
      : buildItemRelativeDir(
          payload.platform,
          payload.sourceId,
          payload.title,
          now,
        );

  const mergedRawTags = [
    ...payload.hashtags,
    ...(message.tags ?? []),
  ];
  const upsertedTags = await upsertTags(mergedRawTags);
  const tagNames = upsertedTags.map((tag) => tag.name);

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
    folderIds: resolvedFolderId ? [resolvedFolderId] : [],
    tags: tagNames,
    note: existing && existing.deletedAt == null ? existing.note : '',
    relativeDir,
    ...(coverRelativePath !== undefined ? { coverRelativePath } : {}),
    assets,
    syncStatus: 'pending_download',
    totalSizeBytes: 0,
    deletedAt: null,
    autoSyncExclusion: null,
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

  // 入队后立即同步图标状态，使快速连续收藏时扩展图标计数与进度环即时更新
  void scheduleActionIconSync();
  void pumpDownloadQueue();

  return {
    ok: true,
    itemId,
    taskId,
    deduplicated: false,
    item: itemRecord,
  };
}

async function handleCaptureBatchItems(
  message: Extract<BackgroundMessage, { type: 'CAPTURE_BATCH_ITEMS' }>,
): Promise<BackgroundResponseMap['CAPTURE_BATCH_ITEMS']> {
  let capturedCount = 0;
  let deduplicatedCount = 0;
  let skippedOversizedCount = 0;

  for (const payload of message.payloads) {
    const res = await handleCaptureItem({
      target: 'background',
      type: 'CAPTURE_ITEM',
      payload,
    });
    if (res.ok) {
      if (res.skippedOversized) {
        skippedOversizedCount += 1;
      } else if (res.deduplicated) {
        deduplicatedCount += 1;
      } else {
        capturedCount += 1;
      }
    }
  }

  return {
    ok: true,
    capturedCount,
    deduplicatedCount,
    skippedOversizedCount,
  };
}

async function handleUncollectItems(
  message: Extract<BackgroundMessage, { type: 'UNCOLLECT_ITEMS' }>,
): Promise<BackgroundResponseMap['UNCOLLECT_ITEMS']> {
  const prefs = await getUserPreferences();
  if (!prefs.syncUncollectToPlugin) {
    return { ok: true, removedItemIds: [], skipped: true };
  }

  const uniqueSourceIds = Array.from(
    new Set(
      message.sourceIds
        .map((id) => id.trim())
        .filter((id) => id.length > 0),
    ),
  );
  if (uniqueSourceIds.length === 0) {
    return { ok: true, removedItemIds: [], skipped: false };
  }

  const now = Date.now();
  const removedItemIds: string[] = [];
  const activeTaskIdsToAbort: string[] = [];

  await db.transaction('rw', db.items, db.tasks, async () => {
    for (const sourceId of uniqueSourceIds) {
      const dedupeKey = `${message.platform}:${sourceId}`;
      const existing = await db.items
        .where('dedupeKey')
        .equals(dedupeKey)
        .first();
      if (!existing || existing.deletedAt != null || isAutoSyncExcluded(existing)) {
        continue;
      }

      await db.items.put({
        ...existing,
        deletedAt: now,
        updatedAt: now,
        syncStatus:
          existing.syncStatus === 'vault_synced'
            ? 'meta_dirty'
            : existing.syncStatus,
      });
      removedItemIds.push(existing.id);

      const relatedTasks = await db.tasks
        .where('itemId')
        .equals(existing.id)
        .toArray();
      for (const task of relatedTasks) {
        if (
          task.status === 'queued' ||
          task.status === 'downloading' ||
          task.status === 'processing'
        ) {
          if (task.status === 'downloading' || task.status === 'processing') {
            activeTaskIdsToAbort.push(task.id);
          }
          await db.tasks.put({
            ...task,
            status: 'cancelled',
            errorMessage: '原站已取消收藏，任务已取消。',
            updatedAt: now,
          });
        }
      }
    }
  });

  if (activeTaskIdsToAbort.length > 0 && (await hasOffscreenDocument())) {
    await Promise.all(
      activeTaskIdsToAbort.map((taskId) =>
        sendToOffscreen({
          target: 'offscreen',
          type: 'OFFSCREEN_ABORT_DOWNLOAD',
          taskId,
        }).catch(() => undefined),
      ),
    );
  }

  if (removedItemIds.length > 0) {
    void scheduleActionIconSync();
    void pumpDownloadQueue();
  }

  return {
    ok: true,
    removedItemIds,
    skipped: false,
  };
}

/** 支持后台同步取消原平台账号收藏的平台及其入口 URL */
const REMOTE_UNCOLLECT_ENTRY_URLS: Partial<Record<PlatformId, string>> = {
  douyin: 'https://www.douyin.com/',
  bilibili: 'https://www.bilibili.com/',
  xiaohongshu: 'https://www.xiaohongshu.com/',
  zhihu: 'https://www.zhihu.com/',
  v2ex: 'https://www.v2ex.com/',
};

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitForTabComplete(
  tabId: number,
  timeoutMs = 15_000,
): Promise<boolean> {
  try {
    const initial = await chrome.tabs.get(tabId);
    if (initial.status === 'complete') {
      return true;
    }
  } catch {
    return false;
  }

  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      resolve(ok);
    };

    const onUpdated = (
      updatedTabId: number,
      changeInfo: { status?: string },
    ): void => {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        finish(true);
      }
    };

    const onRemoved = (removedTabId: number): void => {
      if (removedTabId === tabId) {
        finish(false);
      }
    };

    const timer = setTimeout(() => finish(true), timeoutMs);
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
  });
}

async function sendRemoteUncollectToTabWithRetry(
  tabId: number,
  items: Array<{
    sourceId: string;
    platformExtra?: Record<string, string | number | boolean | null>;
  }>,
  maxAttempts = 8,
): Promise<
  | { ok: true; results: Array<{ sourceId: string; ok: boolean; reason?: string }> }
  | { ok: false; error: string; connectionError: boolean }
> {
  let lastError = '无法连接到平台页面脚本';
  let connectionError = false;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (attempt > 0) {
      await sleepMs(350);
    }
    try {
      const response = await sendToTab(tabId, {
        target: 'content',
        type: 'CONTENT_REMOTE_UNCOLLECT',
        items,
      });
      if (response && response.ok) {
        return { ok: true, results: response.results };
      }
      return {
        ok: false,
        error:
          response && !response.ok
            ? response.error
            : '平台页面未能处理取消收藏请求',
        connectionError: false,
      };
    } catch (error) {
      lastError = formatErrorMessage(error);
      connectionError =
        /Receiving end does not exist|Could not establish connection|message port closed/i.test(
          lastError,
        );
      if (!connectionError) {
        break;
      }
    }
  }

  return { ok: false, error: lastError, connectionError };
}

async function handleCancelItemDownloadTasks(
  message: Extract<BackgroundMessage, { type: 'CANCEL_ITEM_DOWNLOAD_TASKS' }>,
): Promise<BackgroundResponseMap['CANCEL_ITEM_DOWNLOAD_TASKS']> {
  const uniqueIds = Array.from(new Set(message.itemIds.filter(Boolean)));
  if (uniqueIds.length === 0) {
    return { ok: true, cancelledCount: 0 };
  }

  const now = Date.now();
  const activeTaskIdsToAbort: string[] = [];
  let cancelledCount = 0;

  await db.transaction('rw', db.tasks, async () => {
    const relatedTasks = await db.tasks
      .where('itemId')
      .anyOf(uniqueIds)
      .toArray();
    for (const task of relatedTasks) {
      if (
        task.status === 'queued' ||
        task.status === 'downloading' ||
        task.status === 'processing'
      ) {
        if (task.status === 'downloading' || task.status === 'processing') {
          activeTaskIdsToAbort.push(task.id);
        }
        cancelledCount += 1;
        await db.tasks.put({
          ...task,
          status: 'cancelled',
          errorMessage: '关联条目已删除，下载任务已取消。',
          updatedAt: now,
        });
      }
    }
  });

  if (activeTaskIdsToAbort.length > 0 && (await hasOffscreenDocument())) {
    await Promise.all(
      activeTaskIdsToAbort.map((taskId) =>
        sendToOffscreen({
          target: 'offscreen',
          type: 'OFFSCREEN_ABORT_DOWNLOAD',
          taskId,
        }).catch(() => undefined),
      ),
    );
  }

  if (cancelledCount > 0) {
    void scheduleActionIconSync();
    void pumpDownloadQueue();
  }

  return { ok: true, cancelledCount };
}

async function executePlatformRemoteUncollect(
  platform: PlatformId,
  targets: Array<{
    sourceId: string;
    platformExtra?: Record<string, string | number | boolean | null>;
  }>,
): Promise<
  Array<{
    platform: PlatformId;
    sourceId: string;
    ok: boolean;
    reason?: string;
  }>
> {
  const entryUrl = REMOTE_UNCOLLECT_ENTRY_URLS[platform];
  if (!entryUrl) {
    return targets.map((t) => ({
      platform,
      sourceId: t.sourceId,
      ok: false,
      reason: '暂不支持该平台自动取消账号收藏',
    }));
  }

  // 1. 优先查找已打开的同平台标签页（优先 status === 'complete'）
  let existingTabId: number | null = null;
  try {
    const allTabs = await chrome.tabs.query({});
    const matchingTabs = allTabs.filter(
      (tab) =>
        tab.id !== undefined &&
        typeof tab.url === 'string' &&
        matchAdapterByUrl(tab.url)?.id === platform,
    );
    const readyTab =
      matchingTabs.find((tab) => tab.status === 'complete') ?? matchingTabs[0];
    if (readyTab?.id !== undefined) {
      existingTabId = readyTab.id;
    }
  } catch {
    existingTabId = null;
  }

  if (existingTabId !== null) {
    const res = await sendRemoteUncollectToTabWithRetry(
      existingTabId,
      targets,
      3,
    );
    if (res.ok) {
      return res.results.map((r) => ({ platform, ...r }));
    }
    if (!res.connectionError) {
      return targets.map((t) => ({
        platform,
        sourceId: t.sourceId,
        ok: false,
        reason: res.error,
      }));
    }
    // 已打开标签页无法连接时，降级创建临时后台标签页重试
  }

  // 2. 当前无可用标签页：创建静默临时非激活标签页并在结束后自动关闭
  let tempTabId: number | null = null;
  try {
    const created = await chrome.tabs.create({
      url: entryUrl,
      active: false,
    });
    if (created.id === undefined) {
      return targets.map((t) => ({
        platform,
        sourceId: t.sourceId,
        ok: false,
        reason: '无法创建后台临时标签页',
      }));
    }
    tempTabId = created.id;

    const loaded = await waitForTabComplete(tempTabId, 15_000);
    if (!loaded) {
      return targets.map((t) => ({
        platform,
        sourceId: t.sourceId,
        ok: false,
        reason: '后台临时标签页在完成前被关闭',
      }));
    }

    const res = await sendRemoteUncollectToTabWithRetry(tempTabId, targets, 10);
    if (res.ok) {
      return res.results.map((r) => ({ platform, ...r }));
    }
    return targets.map((t) => ({
      platform,
      sourceId: t.sourceId,
      ok: false,
      reason: res.error,
    }));
  } catch (error) {
    const reason = formatErrorMessage(error);
    return targets.map((t) => ({
      platform,
      sourceId: t.sourceId,
      ok: false,
      reason,
    }));
  } finally {
    if (tempTabId !== null) {
      await chrome.tabs.remove(tempTabId).catch(() => undefined);
    }
  }
}

async function handleRemoteUncollectItems(
  message: Extract<BackgroundMessage, { type: 'REMOTE_UNCOLLECT_ITEMS' }>,
): Promise<BackgroundResponseMap['REMOTE_UNCOLLECT_ITEMS']> {
  if (message.items.length === 0) {
    return { ok: true, results: [] };
  }

  const grouped = new Map<
    PlatformId,
    Array<{
      sourceId: string;
      platformExtra?: Record<string, string | number | boolean | null>;
    }>
  >();

  for (const item of message.items) {
    const sourceId = item.sourceId.trim();
    if (!sourceId) {
      continue;
    }
    const list = grouped.get(item.platform);
    const entry = {
      sourceId,
      ...(item.platformExtra !== undefined
        ? { platformExtra: item.platformExtra }
        : {}),
    };
    if (list) {
      if (!list.some((existing) => existing.sourceId === sourceId)) {
        list.push(entry);
      }
    } else {
      grouped.set(item.platform, [entry]);
    }
  }

  const perPlatformResults = await Promise.all(
    Array.from(grouped.entries()).map(([platform, targets]) =>
      executePlatformRemoteUncollect(platform, targets),
    ),
  );

  return {
    ok: true,
    results: perPlatformResults.flat(),
  };
}

async function handleCheckAccountSyncAction(
  message: Extract<BackgroundMessage, { type: 'CHECK_ACCOUNT_SYNC_ACTION' }>,
): Promise<BackgroundResponseMap['CHECK_ACCOUNT_SYNC_ACTION']> {
  const accountId = message.accountId.trim();
  if (!accountId) {
    return { ok: true, action: 'none', passiveFallbackActive: false };
  }

  const accountKey = buildPlatformAccountKey(message.platform, accountId);
  const passiveFallbackActive = passiveFallbackAccounts.has(accountKey);

  if (inFlightAccountSyncs.has(accountKey)) {
    return { ok: true, action: 'none', passiveFallbackActive };
  }

  const [prefs, existingState] = await Promise.all([
    getUserPreferences(),
    getPlatformAccountSyncState(message.platform, accountId),
  ]);

  if (prefs.autoSyncAllCollections) {
    if (existingState?.status === 'synced') {
      return { ok: true, action: 'none', passiveFallbackActive };
    }
    inFlightAccountSyncs.add(accountKey);
    return { ok: true, action: 'auto_sync', passiveFallbackActive };
  }

  if (existingState !== null) {
    return { ok: true, action: 'none', passiveFallbackActive };
  }

  return { ok: true, action: 'prompt', passiveFallbackActive };
}

async function handleBeginManualAccountSync(
  message: Extract<BackgroundMessage, { type: 'BEGIN_MANUAL_ACCOUNT_SYNC' }>,
): Promise<BackgroundResponseMap['BEGIN_MANUAL_ACCOUNT_SYNC']> {
  const accountId = message.accountId.trim();
  if (!accountId) {
    return { ok: true, started: false };
  }
  const accountKey = buildPlatformAccountKey(message.platform, accountId);
  if (inFlightAccountSyncs.has(accountKey)) {
    return { ok: true, started: false };
  }
  inFlightAccountSyncs.add(accountKey);
  return { ok: true, started: true };
}

async function handleReportAccountSyncResult(
  message: Extract<BackgroundMessage, { type: 'REPORT_ACCOUNT_SYNC_RESULT' }>,
): Promise<BackgroundResponseMap['REPORT_ACCOUNT_SYNC_RESULT']> {
  const accountId = message.accountId.trim();
  if (!accountId) {
    return { ok: true };
  }

  const accountKey = buildPlatformAccountKey(message.platform, accountId);
  inFlightAccountSyncs.delete(accountKey);
  const now = Date.now();

  switch (message.outcome) {
    case 'synced': {
      passiveFallbackAccounts.delete(accountKey);
      await setPlatformAccountSyncState({
        platform: message.platform,
        accountId,
        status: 'synced',
        updatedAt: now,
        lastSyncedAt: now,
        ...(message.syncedCount !== undefined
          ? { lastSyncedCount: message.syncedCount }
          : {}),
      });
      break;
    }

    case 'dismissed': {
      await setPlatformAccountSyncState({
        platform: message.platform,
        accountId,
        status: 'dismissed',
        updatedAt: now,
      });
      break;
    }

    case 'fallback_needed': {
      passiveFallbackAccounts.add(accountKey);
      break;
    }

    case 'failed': {
      break;
    }
  }

  return { ok: true };
}

async function handleGetStatusSummary(
  message: Extract<BackgroundMessage, { type: 'GET_STATUS_SUMMARY' }>,
): Promise<BackgroundResponseMap['GET_STATUS_SUMMARY']> {
  const supportedPlatform = message.tabUrl
    ? (matchAdapterByUrl(message.tabUrl)?.id ?? null)
    : null;

  const [allItems, activeTaskCount, vaultHandleCount] = await Promise.all([
    db.items.toArray(),
    db.tasks
      .where('status')
      .anyOf(['queued', 'downloading', 'processing'])
      .count(),
    db.settings.where('key').equals('vault_directory_handle').count(),
  ]);

  let totalItems = 0;
  let stagedCount = 0;
  let metaDirtyCount = 0;

  for (const item of allItems) {
    if (item.deletedAt != null || isAutoSyncExcluded(item)) {
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
    activeTaskCount: activeTaskCount + inFlightCommentItemIds.size,
    hasVaultDirectory: vaultHandleCount > 0,
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
      ...(message.autoSyncExclusion !== undefined
        ? { autoSyncExclusion: message.autoSyncExclusion }
        : {}),
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
): Promise<BackgroundResponseMap['RETRY_DOWNLOAD_TASK']> {
  const task = await db.tasks.get(message.taskId);
  if (!task) {
    return { ok: false, error: '未找到对应的下载任务。' };
  }

  const item = await db.items.get(task.itemId);
  if (!item || item.deletedAt != null || isAutoSyncExcluded(item)) {
    return {
      ok: false,
      error: '关联收藏条目不存在、已移入回收站或已设为不自动同步。',
    };
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

  void scheduleActionIconSync();
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

  const relatedItem = await db.items.get(task.itemId);
  if (
    relatedItem &&
    relatedItem.deletedAt == null &&
    !isAutoSyncExcluded(relatedItem) &&
    (relatedItem.syncStatus === 'pending_download' ||
      relatedItem.syncStatus === 'failed')
  ) {
    await removeItemFromOpfs(relatedItem.id).catch(() => undefined);
    await markItemsAutoSyncExcluded([
      {
        itemId: relatedItem.id,
        reason: 'sync_cancelled_by_user',
        detail: '下载同步过程中已手动取消同步到插件',
      },
    ]);
  }

  void scheduleActionIconSync();
  void pumpDownloadQueue();

  return { ok: true };
}

async function handleOpenLibraryPage(
  message: Extract<BackgroundMessage, { type: 'OPEN_LIBRARY_PAGE' }>,
): Promise<BackgroundResponseMap['OPEN_LIBRARY_PAGE']> {
  const baseUrl = chrome.runtime.getURL(LIBRARY_PAGE_PATH);
  const targetUrl = message.itemId
    ? `${baseUrl}#item=${encodeURIComponent(message.itemId)}`
    : message.section === 'vault'
      ? `${baseUrl}#settings=vault`
      : baseUrl;
  const shouldUpdateUrl =
    message.itemId !== undefined || message.section !== undefined;

  try {
    const existingTabs = await chrome.tabs.query({ url: `${baseUrl}*` });
    const matchedTab = existingTabs.find((tab) => tab.id !== undefined);

    if (matchedTab && matchedTab.id !== undefined) {
      await chrome.tabs.update(matchedTab.id, {
        active: true,
        ...(shouldUpdateUrl ? { url: targetUrl } : {}),
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

async function handleGetUserPreferences(): Promise<
  BackgroundResponseMap['GET_USER_PREFERENCES']
> {
  const preferences = await getUserPreferences();
  return { ok: true, preferences };
}

async function handleNotifyPreferencesUpdated(): Promise<
  BackgroundResponseMap['NOTIFY_PREFERENCES_UPDATED']
> {
  const preferences = await getUserPreferences();

  try {
    const tabs = await chrome.tabs.query({});
    await Promise.all(
      tabs.map(async (tab) => {
        if (tab.id === undefined || !tab.url || !matchAdapterByUrl(tab.url)) {
          return;
        }
        await sendToTab(tab.id, {
          target: 'content',
          type: 'CONTENT_PREFERENCES_UPDATED',
          floatingButtonEnabled: preferences.floatingButtonEnabled,
          nativeCollectToastEnabled: preferences.nativeCollectToastEnabled,
          autoSyncAllCollections: preferences.autoSyncAllCollections,
          syncUncollectToPlugin: preferences.syncUncollectToPlugin,
        }).catch(() => undefined);
      }),
    );
  } catch {
    // 忽略标签页广播异常
  }

  void pumpDownloadQueue();
  return { ok: true };
}

async function handleOffscreenProgress(
  message: Extract<BackgroundMessage, { type: 'OFFSCREEN_PROGRESS' }>,
): Promise<BackgroundResponseMap['OFFSCREEN_PROGRESS']> {
  try {
    const clampedProgress = Math.max(
      0,
      Math.min(100, Math.round(message.progress)),
    );
    let updated = false;

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

      updated = true;
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

    if (updated) {
      void scheduleActionIconSync();
    }
  } catch (error) {
    console.warn('[Collect+] Failed to handle OFFSCREEN_PROGRESS:', error);
  }

  return { ok: true };
}

async function handleOffscreenComplete(
  message: Extract<BackgroundMessage, { type: 'OFFSCREEN_COMPLETE' }>,
): Promise<BackgroundResponseMap['OFFSCREEN_COMPLETE']> {
  let shouldDiscardStagedOpfs = false;

  try {
    const now = Date.now();

    await db.transaction('rw', db.items, db.tasks, async () => {
      const existingItem = await db.items.get(message.itemId);
      const existingTask = await db.tasks.get(message.taskId);

      // 竞态防护：若任务在完成回调前已被取消、或条目已删除/转入「不自动同步」，丢弃本次落盘结果
      const discarded =
        !existingItem ||
        existingItem.deletedAt != null ||
        isAutoSyncExcluded(existingItem) ||
        existingTask?.status === 'cancelled';

      if (discarded) {
        shouldDiscardStagedOpfs = true;
        return;
      }

      const mergedAssets = mergeCompletedAssets(
        existingItem.assets,
        message.assets,
      );

      const nextTotalSizeBytes =
        message.totalSizeBytes + (existingItem.commentsSizeBytes ?? 0);
      await db.items.put({
        ...existingItem,
        assets: mergedAssets,
        totalSizeBytes: nextTotalSizeBytes,
        syncStatus: 'opfs_staged',
        updatedAt: now,
        ...(message.thumbnailDataUrl !== undefined
          ? { thumbnailDataUrl: message.thumbnailDataUrl }
          : {}),
      });

      if (existingTask) {
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

    if (shouldDiscardStagedOpfs) {
      await removeItemFromOpfs(message.itemId).catch(() => undefined);
    }
  } catch (error) {
    console.error('[Collect+] Failed to handle OFFSCREEN_COMPLETE:', error);
  } finally {
    void scheduleActionIconSync();
    void pumpDownloadQueue();
  }

  return { ok: true };
}

async function handleOffscreenError(
  message: Extract<BackgroundMessage, { type: 'OFFSCREEN_ERROR' }>,
): Promise<BackgroundResponseMap['OFFSCREEN_ERROR']> {
  try {
    const now = Date.now();

    await db.transaction('rw', db.items, db.tasks, async () => {
      const existingTask = await db.tasks.get(message.taskId);
      const existingItem = await db.items.get(message.itemId);

      const isCancelled =
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
  } catch (error) {
    console.error('[Collect+] Failed to handle OFFSCREEN_ERROR:', error);
  } finally {
    void scheduleActionIconSync();
    void pumpDownloadQueue();
  }

  return { ok: true };
}

async function handleSaveItemComments(
  message: Extract<BackgroundMessage, { type: 'SAVE_ITEM_COMMENTS' }>,
): Promise<BackgroundResponseMap['SAVE_ITEM_COMMENTS']> {
  if (message.comments.length === 0) {
    return { ok: true };
  }

  const item = await db.items.get(message.itemId);
  if (!item || item.deletedAt != null || isAutoSyncExcluded(item)) {
    return { ok: true };
  }

  inFlightCommentItemIds.add(item.id);
  try {
    await ensureDnrReady();
    await ensureOffscreenDocument();

    const response = await sendToOffscreen({
      target: 'offscreen',
      type: 'OFFSCREEN_STAGE_COMMENTS',
      itemId: item.id,
      platform: message.platform,
      sourceId: message.sourceId,
      comments: message.comments,
      limit: message.limit,
    });

    if (!response || !response.ok) {
      inFlightCommentItemIds.delete(item.id);
      return {
        ok: false,
        error:
          response && !response.ok
            ? response.error
            : 'Offscreen 拒绝启动评论暂存任务。',
      };
    }

    return { ok: true };
  } catch (error) {
    inFlightCommentItemIds.delete(item.id);
    return { ok: false, error: formatErrorMessage(error) };
  }
}

async function handleOffscreenCommentsComplete(
  message: Extract<BackgroundMessage, { type: 'OFFSCREEN_COMMENTS_COMPLETE' }>,
): Promise<BackgroundResponseMap['OFFSCREEN_COMMENTS_COMPLETE']> {
  try {
    const now = Date.now();
    await db.transaction('rw', db.items, async () => {
      const existingItem = await db.items.get(message.itemId);
      if (
        !existingItem ||
        existingItem.deletedAt != null ||
        isAutoSyncExcluded(existingItem)
      ) {
        return;
      }
      const mediaBytes = existingItem.assets.reduce(
        (sum, asset) => sum + (asset.downloaded ? (asset.sizeBytes ?? 0) : 0),
        0,
      );
      // 严守同步状态机不变量：仅已落盘条目置为 meta_dirty 触发二次同步，opfs_staged / pending_download 保持原态
      const nextSyncStatus =
        existingItem.syncStatus === 'vault_synced'
          ? 'meta_dirty'
          : existingItem.syncStatus;

      await db.items.put({
        ...existingItem,
        commentsRelativePath: message.commentsRelativePath,
        savedCommentCount: message.savedCommentCount,
        commentsSizeBytes: message.commentsSizeBytes,
        totalSizeBytes: mediaBytes + message.commentsSizeBytes,
        syncStatus: nextSyncStatus,
        updatedAt: now,
      });
    });
  } catch (error) {
    console.error(
      '[Collect+] Failed to handle OFFSCREEN_COMMENTS_COMPLETE:',
      error,
    );
  } finally {
    inFlightCommentItemIds.delete(message.itemId);
  }

  return { ok: true };
}

async function handleOffscreenCommentsError(
  message: Extract<BackgroundMessage, { type: 'OFFSCREEN_COMMENTS_ERROR' }>,
): Promise<BackgroundResponseMap['OFFSCREEN_COMMENTS_ERROR']> {
  inFlightCommentItemIds.delete(message.itemId);
  console.warn(
    `[Collect+] Comment staging failed for item ${message.itemId}:`,
    message.error,
  );
  return { ok: true };
}

async function routeBackgroundMessage(
  message: BackgroundMessage,
): Promise<BackgroundResponseMap[BackgroundMessage['type']]> {
  switch (message.type) {
    case 'CAPTURE_ITEM':
      return handleCaptureItem(message);
    case 'CAPTURE_BATCH_ITEMS':
      return handleCaptureBatchItems(message);
    case 'SAVE_ITEM_COMMENTS':
      return handleSaveItemComments(message);
    case 'UNCOLLECT_ITEMS':
      return handleUncollectItems(message);
    case 'REMOTE_UNCOLLECT_ITEMS':
      return handleRemoteUncollectItems(message);
    case 'CANCEL_ITEM_DOWNLOAD_TASKS':
      return handleCancelItemDownloadTasks(message);
    case 'CHECK_ACCOUNT_SYNC_ACTION':
      return handleCheckAccountSyncAction(message);
    case 'BEGIN_MANUAL_ACCOUNT_SYNC':
      return handleBeginManualAccountSync(message);
    case 'REPORT_ACCOUNT_SYNC_RESULT':
      return handleReportAccountSyncResult(message);
    case 'GET_STATUS_SUMMARY':
      return handleGetStatusSummary(message);
    case 'TRIGGER_ACTIVE_TAB_CAPTURE':
      return handleTriggerActiveTabCapture(message);
    case 'RETRY_DOWNLOAD_TASK':
      return handleRetryDownloadTask(message);
    case 'CANCEL_DOWNLOAD_TASK':
      return handleCancelDownloadTask(message);
    case 'OPEN_LIBRARY_PAGE':
      return handleOpenLibraryPage(message);
    case 'GET_USER_PREFERENCES':
      return handleGetUserPreferences();
    case 'NOTIFY_PREFERENCES_UPDATED':
      return handleNotifyPreferencesUpdated();
    case 'OFFSCREEN_PROGRESS':
      return handleOffscreenProgress(message);
    case 'OFFSCREEN_COMPLETE':
      return handleOffscreenComplete(message);
    case 'OFFSCREEN_ERROR':
      return handleOffscreenError(message);
    case 'OFFSCREEN_COMMENTS_COMPLETE':
      return handleOffscreenCommentsComplete(message);
    case 'OFFSCREEN_COMMENTS_ERROR':
      return handleOffscreenCommentsError(message);
  }
}

export default defineBackground(() => {
  startActionIconLiveSync();

  // 1. 扩展安装/更新与浏览器启动生命周期钩子
  chrome.runtime.onInstalled.addListener((details) => {
    if (details.reason === 'install') {
      void chrome.storage.local
        .set({ [PIN_HINT_PENDING_KEY]: true })
        .catch(() => undefined);
    }
    void scheduleActionIconSync();
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

  // 2. 全局快捷键命令监听（Alt+S -> capture-current-item）
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

  // 3. 统一监听发往 Background 的强类型消息
  chrome.runtime.onMessage.addListener(
    (message: unknown, _sender, sendResponse) => {
      if (!isBackgroundMessage(message)) {
        return false;
      }

      void routeBackgroundMessage(message)
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

  // 4. Service Worker 启动初始化：同步 DNR 规则并恢复残留下载任务与图标状态
  void ensureDnrReady()
    .then(() => recoverStaleTasksOnStartup())
    .catch((error) => {
      console.error('[Collect+] Background initialization error:', error);
    });

  console.info('[Collect+] Background service worker initialized.');
});
