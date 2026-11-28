import { getAdapterById } from '@/adapters/registry.ts';
import { i18n, translateOptionalKey } from '@/i18n/index.ts';
import type {
  AutoSyncExclusionReason,
  MediaKind,
  PlatformExtraValue,
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

/** 返回同步状态对应的文案与 Tailwind 配色类名 */
export function syncStatusMeta(status: SyncStatus): SyncStatusVisual {
  switch (status) {
    case 'vault_synced':
      return {
        label: i18n.t('format.syncStatus.vaultSyncedLabel'),
        shortLabel: i18n.t('format.syncStatus.vaultSyncedShort'),
        badgeClass:
          'bg-emerald-50 text-emerald-700 ring-1 ring-inset ring-emerald-200 dark:bg-emerald-950/85 dark:text-emerald-300 dark:ring-emerald-800/80',
        dotClass: 'bg-emerald-500 dark:bg-emerald-400',
      };
    case 'opfs_staged':
      return {
        label: i18n.t('format.syncStatus.opfsStagedLabel'),
        shortLabel: i18n.t('format.syncStatus.opfsStagedShort'),
        badgeClass:
          'bg-amber-50 text-amber-800 ring-1 ring-inset ring-amber-200 dark:bg-amber-950/85 dark:text-amber-300 dark:ring-amber-800/80',
        dotClass: 'bg-amber-500 dark:bg-amber-400',
      };
    case 'meta_dirty':
      return {
        label: i18n.t('format.syncStatus.metaDirtyLabel'),
        shortLabel: i18n.t('format.syncStatus.metaDirtyShort'),
        badgeClass:
          'bg-sky-50 text-sky-700 ring-1 ring-inset ring-sky-200 dark:bg-sky-950/85 dark:text-sky-300 dark:ring-sky-800/80',
        dotClass: 'bg-sky-500 dark:bg-sky-400',
      };
    case 'pending_download':
      return {
        label: i18n.t('format.syncStatus.pendingDownloadLabel'),
        shortLabel: i18n.t('format.syncStatus.pendingDownloadShort'),
        badgeClass:
          'bg-teal-50 text-teal-700 ring-1 ring-inset ring-teal-200 dark:bg-teal-950/85 dark:text-teal-300 dark:ring-teal-800/80',
        dotClass: 'bg-teal-500 dark:bg-teal-400',
      };
    case 'failed':
      return {
        label: i18n.t('format.syncStatus.failedLabel'),
        shortLabel: i18n.t('format.syncStatus.failedShort'),
        badgeClass:
          'bg-rose-50 text-rose-700 ring-1 ring-inset ring-rose-200 dark:bg-rose-950/85 dark:text-rose-300 dark:ring-rose-800/80',
        dotClass: 'bg-rose-500 dark:bg-rose-400',
      };
  }
}

export interface AutoSyncExclusionVisual {
  label: string;
  shortLabel: string;
  badgeClass: string;
  dotClass: string;
}

/** 返回「不自动同步」原因对应的文案与视觉样式 */
export function autoSyncExclusionMeta(
  reason: AutoSyncExclusionReason,
): AutoSyncExclusionVisual {
  switch (reason) {
    case 'deleted_keep_remote':
      return {
        label: i18n.t('format.exclusion.deletedKeepRemoteLabel'),
        shortLabel: i18n.t('format.exclusion.deletedKeepRemoteShort'),
        badgeClass:
          'bg-amber-50 text-amber-800 ring-1 ring-inset ring-amber-200 dark:bg-amber-950/85 dark:text-amber-300 dark:ring-amber-800/80',
        dotClass: 'bg-amber-500 dark:bg-amber-400',
      };
    case 'sync_cancelled_by_user':
      return {
        label: i18n.t('format.exclusion.syncCancelledLabel'),
        shortLabel: i18n.t('format.exclusion.syncCancelledShort'),
        badgeClass:
          'bg-slate-100 text-slate-700 ring-1 ring-inset ring-slate-200 dark:bg-slate-800/90 dark:text-slate-300 dark:ring-slate-700',
        dotClass: 'bg-slate-500 dark:bg-slate-400',
      };
    case 'support_author':
      return {
        label: i18n.t('format.exclusion.supportAuthorLabel'),
        shortLabel: i18n.t('format.exclusion.supportAuthorShort'),
        badgeClass:
          'bg-pink-50 text-pink-700 ring-1 ring-inset ring-pink-200 dark:bg-pink-950/85 dark:text-pink-300 dark:ring-pink-800/80',
        dotClass: 'bg-pink-500 dark:bg-pink-400',
      };
    case 'watch_later':
      return {
        label: i18n.t('format.exclusion.watchLaterLabel'),
        shortLabel: i18n.t('format.exclusion.watchLaterShort'),
        badgeClass:
          'bg-sky-50 text-sky-700 ring-1 ring-inset ring-sky-200 dark:bg-sky-950/85 dark:text-sky-300 dark:ring-sky-800/80',
        dotClass: 'bg-sky-500 dark:bg-sky-400',
      };
    case 'skip_local_save':
      return {
        label: i18n.t('format.exclusion.skipLocalSaveLabel'),
        shortLabel: i18n.t('format.exclusion.skipLocalSaveShort'),
        badgeClass:
          'bg-teal-50 text-teal-700 ring-1 ring-inset ring-teal-200 dark:bg-teal-950/85 dark:text-teal-300 dark:ring-teal-800/80',
        dotClass: 'bg-teal-500 dark:bg-teal-400',
      };
  }
}

export interface PlatformVisual {
  label: string;
  badgeClass: string;
}

const DEFAULT_PLATFORM_BADGE_CLASS =
  'bg-slate-700/85 text-white backdrop-blur-xs';

const BUILTIN_FALLBACK_BADGE_CLASSES: Readonly<Record<string, string>> = {
  instagram: 'bg-fuchsia-600/85 text-white backdrop-blur-xs',
};

/** 平台名称与视觉样式（查注册中心 + 通用网页站点名回退，无硬编码 switch） */
export function platformMeta(
  platform: PlatformId,
  platformExtra?: Record<string, PlatformExtraValue>,
): PlatformVisual {
  const adapter = getAdapterById(platform);
  const badgeClass =
    adapter?.uiMeta?.badgeClass ??
    BUILTIN_FALLBACK_BADGE_CLASSES[platform] ??
    DEFAULT_PLATFORM_BADGE_CLASS;

  // 通用网页优先展示来源站点名称或主机名，缺省回退「通用网页」
  if (platform === 'web') {
    const siteName =
      typeof platformExtra?.siteName === 'string' &&
      platformExtra.siteName.trim()
        ? platformExtra.siteName.trim()
        : undefined;
    const siteHost =
      typeof platformExtra?.siteHost === 'string' &&
      platformExtra.siteHost.trim()
        ? platformExtra.siteHost.trim()
        : undefined;
    return {
      label: siteName ?? siteHost ?? i18n.t('platform.web'),
      badgeClass,
    };
  }

  const i18nKey = adapter?.uiMeta?.i18nNameKey ?? `platform.${platform}`;
  const translated = translateOptionalKey(i18nKey);
  const extraSiteName =
    typeof platformExtra?.siteName === 'string' && platformExtra.siteName.trim()
      ? platformExtra.siteName.trim()
      : undefined;

  return {
    label: translated ?? adapter?.displayName ?? extraSiteName ?? platform,
    badgeClass,
  };
}

/** 媒体形态名称 */
export function mediaKindLabel(kind: MediaKind): string {
  switch (kind) {
    case 'video':
      return i18n.t('format.mediaKind.video');
    case 'gallery':
      return i18n.t('format.mediaKind.gallery');
    case 'image':
      return i18n.t('format.mediaKind.image');
    case 'article':
      return i18n.t('format.mediaKind.article');
  }
}

/** 格式化点赞/评论等整数计数为紧凑可读文本（如 128、1.2万 / 1.2K） */
export function formatCompactCount(count: number): string {
  if (!Number.isFinite(count) || count <= 0) {
    return '0';
  }
  const safe = Math.trunc(count);
  if (i18n.t('format.compactStyle') === 'wan') {
    if (safe < 10_000) {
      return String(safe);
    }
    const wan = safe / 10_000;
    const formatted =
      wan >= 100 ? String(Math.round(wan)) : wan.toFixed(1).replace(/\.0$/, '');
    return i18n.t('format.compactWan', { value: formatted });
  }

  return new Intl.NumberFormat('en', {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(safe);
}

/** 安全提取任意异常的人类可读错误信息 */
export function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return String(error);
}
