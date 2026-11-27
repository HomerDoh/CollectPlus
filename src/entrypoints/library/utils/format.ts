import { i18n } from '#i18n';
import type {
  AutoSyncExclusionReason,
  MediaKind,
  PlatformId,
  SyncStatus,
} from '@/types/schema.ts';

/** 格式化字节数为人类可读体积（如 12.4 MB） */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0 B';
  }

  const units = ['B', 'KB', 'MB', 'GB', 'TB'] as const;
  let value = bytes;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  const unit = units[unitIndex] ?? 'B';
  if (unitIndex === 0) {
    return `${Math.round(value)} ${unit}`;
  }
  const decimals = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(decimals)} ${unit}`;
}

/** 格式化视频/音频时长（秒）为 MM:SS 或 HH:MM:SS */
export function formatDuration(seconds?: number): string {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) {
    return '00:00';
  }

  const totalSec = Math.floor(seconds);
  const hours = Math.floor(totalSec / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;

  const pad = (n: number): string => String(n).padStart(2, '0');
  if (hours > 0) {
    return `${hours}:${pad(minutes)}:${pad(secs)}`;
  }
  return `${pad(minutes)}:${pad(secs)}`;
}

/** 格式化时间戳为完整日期时间（YYYY-MM-DD HH:mm） */
export function formatDateTime(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) {
    return '-';
  }

  const date = new Date(ts);
  const pad = (n: number): string => String(n).padStart(2, '0');
  const y = date.getFullYear();
  const m = pad(date.getMonth() + 1);
  const d = pad(date.getDate());
  const hh = pad(date.getHours());
  const mm = pad(date.getMinutes());
  return `${y}-${m}-${d} ${hh}:${mm}`;
}

/** 格式化时间戳为友好相对时间（刚刚、X 分钟前、X 小时前、X 天前或日期） */
export function formatRelativeTime(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) {
    return '-';
  }

  const diffMs = Date.now() - ts;
  if (diffMs < 0) {
    return formatDateTime(ts);
  }

  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) {
    return i18n.t('format.justNow');
  }

  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) {
    return i18n.t('format.minutesAgo', { count: diffMin });
  }

  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) {
    return i18n.t('format.hoursAgo', { count: diffHour });
  }

  const diffDay = Math.floor(diffHour / 24);
  if (diffDay < 30) {
    return i18n.t('format.daysAgo', { count: diffDay });
  }

  const date = new Date(ts);
  const now = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  if (date.getFullYear() === now.getFullYear()) {
    return `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export interface SyncStatusVisual {
  label: string;
  shortLabel: string;
  badgeClass: string;
  dotClass: string;
}

/** 返回同步状态对应的中文文案与 Tailwind 配色类名 */
export function syncStatusMeta(status: SyncStatus): SyncStatusVisual {
  switch (status) {
    case 'vault_synced':
      return {
        label: '已落盘同步',
        shortLabel: '已同步',
        badgeClass: 'bg-emerald-50 text-emerald-700 ring-1 ring-inset ring-emerald-200',
        dotClass: 'bg-emerald-500',
      };
    case 'opfs_staged':
      return {
        label: '已暂存待落盘',
        shortLabel: '待同步',
        badgeClass: 'bg-amber-50 text-amber-700 ring-1 ring-inset ring-amber-200',
        dotClass: 'bg-amber-500',
      };
    case 'meta_dirty':
      return {
        label: '元数据待回写',
        shortLabel: '待回写',
        badgeClass: 'bg-sky-50 text-sky-700 ring-1 ring-inset ring-sky-200',
        dotClass: 'bg-sky-500',
      };
    case 'pending_download':
      return {
        label: '后台下载中',
        shortLabel: '下载中',
        badgeClass: 'bg-indigo-50 text-indigo-700 ring-1 ring-inset ring-indigo-200',
        dotClass: 'bg-indigo-500',
      };
    case 'failed':
      return {
        label: '下载失败',
        shortLabel: '失败',
        badgeClass: 'bg-rose-50 text-rose-700 ring-1 ring-inset ring-rose-200',
        dotClass: 'bg-rose-500',
      };
  }
}

export interface AutoSyncExclusionVisual {
  label: string;
  shortLabel: string;
  badgeClass: string;
  dotClass: string;
}

/** 返回「不自动同步」原因对应的中文文案与视觉样式 */
export function autoSyncExclusionMeta(
  reason: AutoSyncExclusionReason,
): AutoSyncExclusionVisual {
  switch (reason) {
    case 'deleted_keep_remote':
      return {
        label: '管理台删除（保留原站收藏）',
        shortLabel: '已删保留原站',
        badgeClass:
          'bg-amber-50 text-amber-800 ring-1 ring-inset ring-amber-200',
        dotClass: 'bg-amber-500',
      };
    case 'sync_cancelled_by_user':
      return {
        label: '收藏时取消同步到插件',
        shortLabel: '已取消同步',
        badgeClass:
          'bg-slate-100 text-slate-700 ring-1 ring-inset ring-slate-200',
        dotClass: 'bg-slate-500',
      };
    case 'support_author':
      return {
        label: '支持作者 / 冲数据（未存本地）',
        shortLabel: '支持作者',
        badgeClass:
          'bg-pink-50 text-pink-700 ring-1 ring-inset ring-pink-200',
        dotClass: 'bg-pink-500',
      };
    case 'watch_later':
      return {
        label: '稍后观看（未存本地）',
        shortLabel: '稍后观看',
        badgeClass:
          'bg-sky-50 text-sky-700 ring-1 ring-inset ring-sky-200',
        dotClass: 'bg-sky-500',
      };
    case 'skip_local_save':
      return {
        label: '取消本地持久化（仅存元数据）',
        shortLabel: '仅存元数据',
        badgeClass:
          'bg-violet-50 text-violet-700 ring-1 ring-inset ring-violet-200',
        dotClass: 'bg-violet-500',
      };
  }
}

export interface PlatformVisual {
  label: string;
  badgeClass: string;
}

/** 平台中文名称与视觉样式 */
export function platformMeta(platform: PlatformId): PlatformVisual {
  switch (platform) {
    case 'douyin':
      return {
        label: '抖音',
        badgeClass: 'bg-slate-900/80 text-white backdrop-blur-xs',
      };
    case 'bilibili':
      return {
        label: 'B站',
        badgeClass: 'bg-pink-600/85 text-white backdrop-blur-xs',
      };
    case 'v2ex':
      return {
        label: 'V2EX',
        badgeClass: 'bg-teal-700/85 text-white backdrop-blur-xs',
      };
    case 'zhihu':
      return {
        label: '知乎',
        badgeClass: 'bg-sky-600/85 text-white backdrop-blur-xs',
      };
    case 'youtube':
      return {
        label: 'YouTube',
        badgeClass: 'bg-red-600/85 text-white backdrop-blur-xs',
      };
    case 'xiaohongshu':
      return {
        label: '小红书',
        badgeClass: 'bg-rose-600/85 text-white backdrop-blur-xs',
      };
    case 'twitter':
      return {
        label: 'X',
        badgeClass: 'bg-slate-800/85 text-white backdrop-blur-xs',
      };
    case 'instagram':
      return {
        label: 'Instagram',
        badgeClass: 'bg-fuchsia-600/85 text-white backdrop-blur-xs',
      };
  }
}

/** 媒体形态中文名称 */
export function mediaKindLabel(kind: MediaKind): string {
  switch (kind) {
    case 'video':
      return '视频';
    case 'gallery':
      return '图集';
    case 'image':
      return '图片';
    case 'article':
      return '文章';
  }
}

/** 格式化点赞/评论等整数计数为紧凑可读文本（如 128、1.2万） */
export function formatCompactCount(count: number): string {
  if (!Number.isFinite(count) || count <= 0) {
    return '0';
  }
  const safe = Math.trunc(count);
  if (safe < 10_000) {
    return String(safe);
  }
  const wan = safe / 10_000;
  const formatted = wan >= 100 ? String(Math.round(wan)) : wan.toFixed(1).replace(/\.0$/, '');
  return `${formatted}万`;
}

/** 安全提取任意异常的人类可读错误信息 */
export function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return String(error);
}
