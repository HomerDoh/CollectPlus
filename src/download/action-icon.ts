/**
 * 浏览器扩展工具栏图标（`chrome.action`）动态圆形外圈进度与多任务计数渲染器。
 *
 * 视觉规则：
 * - 统一预留外圈进度环与 1px 透明呼吸边距，保证空闲态（Idle）与活跃进度态（Active）中间 icon 尺寸和书签 1:1 保持不变、无缩放跳动；
 * - 无活跃任务（`remainingCount === 0`）：显示居中标准圆角方形默认图标与标题 `Collect+`；
 * - 有活跃进度（`remainingCount >= 1`）：图标切换为同尺寸正圆形，并在 icon 外圈（距 icon 1px 边距）顺时针绘制圆形进度环；
 *   - 单个任务下载中（`remainingCount === 1`）：内部圆形 icon 1:1 保留原书签图案；
 *   - 多任务排队/并发（`remainingCount >= 2`）：内部圆形 icon 居中显示剩余任务数（不显示 `1`）。
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

interface ActionIconGeometry {
  center: number;
  outerRadius: number;
  strokeWidth: number;
  ringRadius: number;
  ringInnerRadius: number;
  ringGap: number;
  iconRadius: number;
  iconDiameter: number;
}

/**
 * 统一计算工具栏图标在空闲态与活跃进度态共享的几何度量，确保中间 icon 尺寸完全不变。
 */
export function computeActionIconGeometry(size: number): ActionIconGeometry {
  const center = size / 2;
  const outerPad = Math.max(0.2, size * 0.008);
  const outerRadius = center - outerPad;
  const strokeWidth = Math.max(1.25, size * 0.0625);
  const ringRadius = outerRadius - strokeWidth / 2;
  const ringInnerRadius = outerRadius - strokeWidth;
  const ringGap = Math.max(1, size * 0.05);
  const iconRadius = Math.max(2, ringInnerRadius - ringGap);
  return {
    center,
    outerRadius,
    strokeWidth,
    ringRadius,
    ringInnerRadius,
    ringGap,
    iconRadius,
    iconDiameter: iconRadius * 2,
  };
}

function resolveCountFontSize(iconDiameter: number, textLength: number): number {
  if (textLength >= 3) {
    return Math.max(5.2, iconDiameter * 0.39);
  }
  if (textLength === 2) {
    return Math.max(6.4, iconDiameter * 0.51);
  }
  return Math.max(7.5, iconDiameter * 0.62);
}

/**
 * 渲染空闲态工具栏图标：使用与活跃态完全一致的 `iconDiameter` 尺寸，外圈预留透明进度环区域，切换进度时 icon 大小零跳动。
 */
export function renderIdleIconFrame(
  size: number,
  baseBitmap: ImageBitmap | null,
): ImageData {
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('2D context unavailable on OffscreenCanvas');
  }

  const { center, iconRadius, iconDiameter } = computeActionIconGeometry(size);
  const left = center - iconRadius;
  const cornerRadius = iconDiameter * 0.24;

  ctx.clearRect(0, 0, size, size);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  const bgGradient = ctx.createLinearGradient(0, left, 0, left + iconDiameter);
  bgGradient.addColorStop(0, '#3a359e');
  bgGradient.addColorStop(1, '#463fc8');

  ctx.beginPath();
  ctx.roundRect(left, left, iconDiameter, iconDiameter, cornerRadius);
  ctx.fillStyle = bgGradient;
  ctx.fill();

  if (baseBitmap) {
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(left, left, iconDiameter, iconDiameter, cornerRadius);
    ctx.clip();
    ctx.drawImage(baseBitmap, 0, 0, size, size);
    ctx.restore();
  }

  return ctx.getImageData(0, 0, size, size);
}

/**
 * 渲染带外圈圆形进度环（与内部圆形图标保留 1px 透明边距，且 icon 大小与空闲态完全一致）与可选多任务计数的激活态扩展图标。
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

  const {
    center,
    outerRadius,
    strokeWidth,
    ringRadius,
    iconRadius,
    iconDiameter,
  } = computeActionIconGeometry(size);

  ctx.clearRect(0, 0, size, size);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  // 1. 绘制内部圆形渐变底盘（直径与空闲态 icon 完全一致，外圈自然留出 1px 透明边距）
  const bgGradient = ctx.createLinearGradient(
    0,
    center - iconRadius,
    0,
    center + iconRadius,
  );
  bgGradient.addColorStop(0, '#3a359e');
  bgGradient.addColorStop(1, '#463fc8');

  ctx.beginPath();
  ctx.arc(center, center, iconRadius, 0, Math.PI * 2);
  ctx.fillStyle = bgGradient;
  ctx.fill();

  // 2. 内部圆形内容：多任务显示剩余数量；单任务 1:1 保持原书签图案并裁切在内部圆内
  if (countLabel !== null) {
    const fontSize = resolveCountFontSize(iconDiameter, countLabel.length);
    ctx.font = `700 ${fontSize}px system-ui, -apple-system, "Segoe UI", Arial, sans-serif`;
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(countLabel, center, center + iconDiameter * 0.025);
  } else if (baseBitmap) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(center, center, iconRadius, 0, Math.PI * 2);
    ctx.clip();
    ctx.drawImage(baseBitmap, 0, 0, size, size);
    ctx.restore();
  }

  // 3. 在 icon 外圈绘制 360° 正圆形底轨（中性半透明灰蓝，兼顾深色与浅色浏览器工具栏）
  ctx.save();
  ctx.beginPath();
  ctx.arc(center, center, ringRadius, 0, Math.PI * 2);
  ctx.lineWidth = strokeWidth;
  ctx.strokeStyle = 'rgba(128, 140, 165, 0.34)';
  ctx.stroke();

  // 4. 从 12 点钟方向顺时针绘制高对比度外圈圆形进度弧（0% 时保留 6% 起始短弧以即时提示激活）
  const visualRatio = Math.max(0.06, Math.min(1, progress / 100));
  const startAngle = -Math.PI / 2;
  const endAngle = startAngle + Math.PI * 2 * visualRatio;

  const arcGradient = ctx.createLinearGradient(
    center - outerRadius,
    center - outerRadius,
    center + outerRadius,
    center + outerRadius,
  );
  arcGradient.addColorStop(0, '#0ea5e9');
  arcGradient.addColorStop(0.5, '#06b6d4');
  arcGradient.addColorStop(1, '#10b981');

  ctx.beginPath();
  ctx.arc(center, center, ringRadius, startAngle, endAngle, false);
  ctx.lineWidth = strokeWidth;
  ctx.lineCap = visualRatio >= 0.995 ? 'butt' : 'round';
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

  const [bmp16, bmp32, bmp48] = await Promise.all([
    loadBaseIconBitmap(16),
    loadBaseIconBitmap(32),
    loadBaseIconBitmap(48),
  ]);

  if (state.mode === 'idle') {
    if (bmp16 || bmp32 || bmp48) {
      await chrome.action.setIcon({
        imageData: {
          16: renderIdleIconFrame(16, bmp16),
          32: renderIdleIconFrame(32, bmp32),
          48: renderIdleIconFrame(48, bmp48),
        },
      });
    } else {
      await chrome.action.setIcon({ path: DEFAULT_ICON_PATHS });
    }
    await chrome.action.setBadgeText({ text: '' });
    await chrome.action.setTitle({ title: state.title });
    lastAppliedSignature = signature;
    return;
  }

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
