/**
 * 浏览器扩展工具栏图标（`chrome.action`）动态外圈进度与多任务计数渲染器。
 *
 * 视觉规则：
 * - 始终保持原扩展图标 1:1 原始尺寸（`0, 0, size, size`），绝不缩放变小；
 * - 无活跃任务（`remainingCount === 0`）：恢复静态默认图标与标题 `Collect+`；
 * - 单个任务下载中（`remainingCount === 1`）：保持完整原书签图标，仅沿图标外圈轮廓顺时针绘制当前任务进度；
 * - 多任务排队/并发（`remainingCount >= 2`）：保持原图标完整外框尺寸，外圈绘制当前下载任务进度，中心显示剩余任务数（不显示 `1`）。
 */

import { liveQuery } from 'dexie';
import { db } from '../storage/db.ts';
import type { DownloadTask } from '../types/schema.ts';

const DEFAULT_ACTION_TITLE = 'Collect+';

type ActiveIconSize = 16 | 32 | 48;

const DEFAULT_ICON_PATHS: Record<number, string> = {
  16: 'icon/16.png',
  32: 'icon/32.png',
  48: 'icon/48.png',
  128: 'icon/128.png',
};

export type ActionIconState =
  | {
      mode: 'idle';
      remainingCount: 0;
      progress: 0;
      countLabel: null;
      title: string;
    }
  | {
      mode: 'active';
      remainingCount: number;
      progress: number;
      /** `remainingCount >= 2` 时为数字文本（`2`~`99` 或 `99+`），仅剩 1 个时为 `null` */
      countLabel: string | null;
      title: string;
    };

const baseIconBitmapCache = new Map<
  ActiveIconSize,
  Promise<ImageBitmap | null>
>();
let lastAppliedSignature: string | null = null;
let isSyncing = false;
let pendingSync = false;
let liveSyncStarted = false;

/**
 * 根据按 `createdAt` 升序排列的未完成任务列表计算当前扩展图标展示状态。
 */
export function computeActionIconState(
  activeTasks: readonly Pick<DownloadTask, 'status' | 'progress'>[],
): ActionIconState {
  const remainingCount = activeTasks.length;
  if (remainingCount === 0) {
    return {
      mode: 'idle',
      remainingCount: 0,
      progress: 0,
      countLabel: null,
      title: DEFAULT_ACTION_TITLE,
    };
  }

  const currentTask =
    activeTasks.find(
      (task) => task.status === 'downloading' || task.status === 'processing',
    ) ?? activeTasks[0]!;

  const progress = Math.max(0, Math.min(100, Math.round(currentTask.progress)));
  const countLabel =
    remainingCount >= 2
      ? remainingCount > 99
        ? '99+'
        : String(remainingCount)
      : null;

  const title =
    remainingCount >= 2
      ? `${DEFAULT_ACTION_TITLE} · 剩余 ${remainingCount} 项下载 (${progress}%)`
      : `${DEFAULT_ACTION_TITLE} · 下载中 ${progress}%`;

  return {
    mode: 'active',
    remainingCount,
    progress,
    countLabel,
    title,
  };
}

function loadBaseIconBitmap(size: ActiveIconSize): Promise<ImageBitmap | null> {
  const cached = baseIconBitmapCache.get(size);
  if (cached) {
    return cached;
  }

  const loader = (async () => {
    try {
      const response = await fetch(chrome.runtime.getURL(`icon/${size}.png`));
      if (!response.ok) {
        return null;
      }
      const blob = await response.blob();
      return await createImageBitmap(blob);
    } catch {
      return null;
    }
  })();

  baseIconBitmapCache.set(size, loader);
  return loader;
}

function resolveCountFontSize(size: number, textLength: number): number {
  const scale = size / 32;
  if (textLength >= 3) {
    return Math.max(6, 11.5 * scale);
  }
  if (textLength === 2) {
    return Math.max(7.5, 14.5 * scale);
  }
  return Math.max(9, 17 * scale);
}

/**
 * 从 12 点钟正上方中点顺时针描绘贴合原图标圆角矩形外框的闭合路径，并返回总周长。
 */
function traceClockwiseOuterContour(
  ctx: OffscreenCanvasRenderingContext2D,
  size: number,
  inset: number,
  cornerRadius: number,
): number {
  const left = inset;
  const top = inset;
  const right = size - inset;
  const bottom = size - inset;
  const cx = size / 2;
  const r = Math.min(cornerRadius, (size - inset * 2) / 2);

  ctx.beginPath();
  ctx.moveTo(cx, top);
  ctx.lineTo(right - r, top);
  ctx.arcTo(right, top, right, top + r, r);
  ctx.lineTo(right, bottom - r);
  ctx.arcTo(right, bottom, right - r, bottom, r);
  ctx.lineTo(left + r, bottom);
  ctx.arcTo(left, bottom, left, bottom - r, r);
  ctx.lineTo(left, top + r);
  ctx.arcTo(left, top, left + r, top, r);
  ctx.lineTo(cx, top);

  const straightSide = Math.max(0, size - inset * 2 - r * 2);
  return straightSide * 4 + 2 * Math.PI * r;
}

/**
 * 在原尺寸（1:1 不缩小）扩展图标上叠加外圈环形 Progress 与可选多任务计数。
 */
export function renderActiveIconFrame(
  size: number,
  progress: number,
  countLabel: string | null,
  baseBitmap: ImageBitmap | null,
): ImageData {
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('2D context unavailable on OffscreenCanvas');
  }

  const center = size / 2;
  const strokeWidth = Math.max(1.7, size * 0.094);
  const inset = Math.max(0.85, size * 0.05);
  const cornerRadius = size * 0.225;

  ctx.clearRect(0, 0, size, size);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  // 1. 1:1 原始尺寸绘制基础图标，保证进度出现前后图标大小完全一致
  if (baseBitmap) {
    ctx.drawImage(baseBitmap, 0, 0, size, size);
  } else {
    traceClockwiseOuterContour(ctx, size, inset, cornerRadius);
    ctx.fillStyle = '#3b359e';
    ctx.fill();
  }

  // 2. 多任务（>= 2）时仅用同色纵向渐变无缝遮盖中心白色书签图案，并居中绘制数量（外框尺寸保持不变）
  if (countLabel !== null) {
    const maskLeft = size * 0.22;
    const maskTop = size * 0.19;
    const maskWidth = size * 0.56;
    const maskHeight = size * 0.62;
    const bgGradient = ctx.createLinearGradient(
      0,
      maskTop,
      0,
      maskTop + maskHeight,
    );
    bgGradient.addColorStop(0, 'rgb(55, 51, 149)');
    bgGradient.addColorStop(1, 'rgb(65, 59, 182)');

    ctx.beginPath();
    ctx.roundRect(maskLeft, maskTop, maskWidth, maskHeight, size * 0.1);
    ctx.fillStyle = bgGradient;
    ctx.fill();

    const fontSize = resolveCountFontSize(size, countLabel.length);
    ctx.font = `700 ${fontSize}px system-ui, -apple-system, "Segoe UI", Arial, sans-serif`;
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(countLabel, center, center + size * 0.015);
  }

  // 3. 沿图标外圈边缘绘制 360° 底轨（不挤压内部图案）
  ctx.save();
  traceClockwiseOuterContour(ctx, size, inset, cornerRadius);
  ctx.setLineDash([]);
  ctx.lineWidth = strokeWidth;
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.28)';
  ctx.stroke();

  // 4. 沿外圈顺时针绘制高对比度当前下载进度（0% 时保留 6% 起始短弧以即时提示激活）
  const perimeter = traceClockwiseOuterContour(ctx, size, inset, cornerRadius);
  const visualRatio = Math.max(0.06, Math.min(1, progress / 100));
  const activeLength = perimeter * visualRatio;

  const arcGradient = ctx.createLinearGradient(0, 0, size, size);
  arcGradient.addColorStop(0, '#38bdf8');
  arcGradient.addColorStop(0.5, '#22d3ee');
  arcGradient.addColorStop(1, '#34d399');

  ctx.setLineDash([activeLength, perimeter + strokeWidth * 2]);
  ctx.lineDashOffset = 0;
  ctx.lineWidth = strokeWidth;
  ctx.lineCap = visualRatio >= 0.995 ? 'butt' : 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = arcGradient;
  ctx.stroke();
  ctx.restore();

  return ctx.getImageData(0, 0, size, size);
}

async function syncOnce(): Promise<void> {
  const activeTasks = await db.tasks
    .where('status')
    .anyOf(['queued', 'downloading', 'processing'])
    .sortBy('createdAt');

  const state = computeActionIconState(activeTasks);
  const signature =
    state.mode === 'idle'
      ? 'idle'
      : `active:${state.remainingCount}:${state.progress}`;

  if (signature === lastAppliedSignature) {
    return;
  }

  if (state.mode === 'idle') {
    await chrome.action.setIcon({ path: DEFAULT_ICON_PATHS });
    await chrome.action.setBadgeText({ text: '' });
    await chrome.action.setTitle({ title: state.title });
    lastAppliedSignature = signature;
    return;
  }

  const [bmp16, bmp32, bmp48] = await Promise.all([
    loadBaseIconBitmap(16),
    loadBaseIconBitmap(32),
    loadBaseIconBitmap(48),
  ]);

  const icon16 = renderActiveIconFrame(
    16,
    state.progress,
    state.countLabel,
    bmp16,
  );
  const icon32 = renderActiveIconFrame(
    32,
    state.progress,
    state.countLabel,
    bmp32,
  );
  const icon48 = renderActiveIconFrame(
    48,
    state.progress,
    state.countLabel,
    bmp48,
  );

  await chrome.action.setIcon({
    imageData: {
      16: icon16,
      32: icon32,
      48: icon48,
    },
  });
  await chrome.action.setBadgeText({ text: '' });
  await chrome.action.setTitle({ title: state.title });
  lastAppliedSignature = signature;
}

/**
 * 单飞合并刷新扩展工具栏图标状态，防止高频进度事件并发乱序覆盖终态恢复。
 */
export async function scheduleActionIconSync(): Promise<void> {
  if (isSyncing) {
    pendingSync = true;
    return;
  }

  isSyncing = true;
  try {
    do {
      pendingSync = false;
      await syncOnce();
    } while (pendingSync);
  } catch (error) {
    console.warn('[Collect+] Failed to sync action icon state:', error);
  } finally {
    isSyncing = false;
  }
}

/**
 * 启动基于 Dexie `liveQuery` 的后台图标响应式监听，覆盖管理台清空缓存等跨上下文任务表变更。
 */
export function startActionIconLiveSync(): void {
  if (liveSyncStarted) {
    return;
  }
  liveSyncStarted = true;

  liveQuery(() =>
    db.tasks
      .where('status')
      .anyOf(['queued', 'downloading', 'processing'])
      .count(),
  ).subscribe({
    next: () => {
      void scheduleActionIconSync();
    },
    error: (error) => {
      console.warn('[Collect+] Action icon liveQuery error:', error);
    },
  });
}
