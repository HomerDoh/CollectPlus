/**
 * 各平台内容详情页原生明暗主题注册表。
 *
 * 对应样式变量持久化保存在 `src/styles/platforms/<platform>.css`（经
 * `src/styles/platform-detail-themes.css` 统一汇总打包进插件），
 * 由 `ItemDetailDrawer` 与 `ItemCommentsPanel` 通过 `data-platform={item.platform}`
 * 自动挂载并随 `html[data-theme="light" | "dark"]` 联动切换。
 */

import type { PlatformId } from '@/types/schema.ts';

export interface PlatformDetailThemeMeta {
  readonly id: PlatformId;
  /** 亮色主强调色 */
  readonly lightAccent: string;
  /** 暗色主强调色 */
  readonly darkAccent: string;
  /** 亮色副强调色（用于作者链接与次级高亮） */
  readonly lightSecondaryAccent: string;
  /** 暗色副强调色 */
  readonly darkSecondaryAccent: string;
  /** 对应的独立样式文件路径（相对于 src/styles/） */
  readonly stylesheet: string;
}

export const DEFAULT_PLATFORM_DETAIL_THEME: PlatformDetailThemeMeta = {
  id: 'web',
  lightAccent: '#0D9488',
  darkAccent: '#2DD4BF',
  lightSecondaryAccent: '#0F766E',
  darkSecondaryAccent: '#5EEAD4',
  stylesheet: 'platform-detail-themes.css',
};

export const PLATFORM_DETAIL_THEMES: Readonly<
  Record<string, PlatformDetailThemeMeta>
> = {
  douyin: {
    id: 'douyin',
    lightAccent: '#FE2C55',
    darkAccent: '#FE2C55',
    lightSecondaryAccent: '#161823',
    darkSecondaryAccent: '#F1F1F2',
    stylesheet: 'platforms/douyin.css',
  },
  bilibili: {
    id: 'bilibili',
    lightAccent: '#FB7299',
    darkAccent: '#FB7299',
    lightSecondaryAccent: '#00AEEC',
    darkSecondaryAccent: '#33C1F2',
    stylesheet: 'platforms/bilibili.css',
  },
  xiaohongshu: {
    id: 'xiaohongshu',
    lightAccent: '#FF2442',
    darkAccent: '#FF2E4D',
    lightSecondaryAccent: '#13386C',
    darkSecondaryAccent: '#7AA7E8',
    stylesheet: 'platforms/xiaohongshu.css',
  },
  zhihu: {
    id: 'zhihu',
    lightAccent: '#0066FF',
    darkAccent: '#3B82F6',
    lightSecondaryAccent: '#1772F6',
    darkSecondaryAccent: '#60A5FA',
    stylesheet: 'platforms/zhihu.css',
  },
  v2ex: {
    id: 'v2ex',
    lightAccent: '#4D5256',
    darkAccent: '#60A5FA',
    lightSecondaryAccent: '#778087',
    darkSecondaryAccent: '#93C5FD',
    stylesheet: 'platforms/v2ex.css',
  },
  youtube: {
    id: 'youtube',
    lightAccent: '#CC0000',
    darkAccent: '#FF4E45',
    lightSecondaryAccent: '#065FD4',
    darkSecondaryAccent: '#3EA6FF',
    stylesheet: 'platforms/youtube.css',
  },
  twitter: {
    id: 'twitter',
    lightAccent: '#1D9BF0',
    darkAccent: '#1D9BF0',
    lightSecondaryAccent: '#1D9BF0',
    darkSecondaryAccent: '#78C2F8',
    stylesheet: 'platforms/twitter.css',
  },
  instagram: {
    id: 'instagram',
    lightAccent: '#E1306C',
    darkAccent: '#F56040',
    lightSecondaryAccent: '#0095F6',
    darkSecondaryAccent: '#38A8FF',
    stylesheet: 'platforms/instagram.css',
  },
  xvideos: {
    id: 'xvideos',
    lightAccent: '#DE2600',
    darkAccent: '#FF4522',
    lightSecondaryAccent: '#1F2937',
    darkSecondaryAccent: '#E5E7EB',
    stylesheet: 'platforms/xvideos.css',
  },
  pornhub: {
    id: 'pornhub',
    lightAccent: '#E07B00',
    darkAccent: '#FF9000',
    lightSecondaryAccent: '#1B1B1B',
    darkSecondaryAccent: '#F5F5F5',
    stylesheet: 'platforms/pornhub.css',
  },
};

export function getPlatformDetailTheme(
  platform: PlatformId,
): PlatformDetailThemeMeta {
  return PLATFORM_DETAIL_THEMES[platform] ?? DEFAULT_PLATFORM_DETAIL_THEME;
}
