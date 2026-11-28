/**
 * Pornhub 声明式站点规则（Tier 2 SiteRecipe）。
 *
 * 替代原 619 行的独立 `pornhub/main-hook.ts` 与 `pornhub/parser.ts`，
 * 支持 `window.flashvars_*`、`/video/get_media` JSON 展开、最高画质直链 MP4 优先与 HLS 回退。
 */

import type { SiteRecipe } from '../schema.ts';

export const pornhubRecipe: SiteRecipe = {
  id: 'pornhub',
  displayName: 'Pornhub',
  hostPatterns: [
    'https://www.pornhub.com/*',
    'https://*.pornhub.com/*',
    'https://pornhub.com/*',
  ],
  matchHosts: ['pornhub.com'],
  matchSubdomains: true,
  kind: 'video',
  uiMeta: {
    entryUrl: 'https://www.pornhub.com/',
    badgeClass: 'bg-amber-600/90 text-white backdrop-blur-xs',
  },
  defaultReferer: 'https://www.pornhub.com/',
  defaultOrigin: 'https://www.pornhub.com',
  dnrRules: [
    {
      idOffset: 1,
      urlFilter: '||phncdn.com/',
      referer: 'https://www.pornhub.com/',
      origin: 'https://www.pornhub.com',
    },
  ],
  idExtractor: {
    queryParam: 'viewkey',
    pathRegexes: ['^\\/embed\\/([A-Za-z0-9_-]+)'],
    validRegex: '^[A-Za-z0-9_-]+$',
  },
  globalSource: {
    windowKeyRegex: '^flashvars_\\d+$',
    requiredArrayKey: 'mediaDefinitions',
    mediaDefinitionsKey: 'mediaDefinitions',
    resolveMediaUrlContains: '/video/get_media',
  },
  fields: {
    sourceId: { globalKeys: ['viewkey', 'video_id'] },
    sourceUrl: { globalKeys: ['link_url'] },
    title: {
      globalKeys: ['video_title', 'title'],
      selectors: ['meta[property="og:title"]'],
      stripTitleSuffixRegex: '\\s*-\\s*Pornhub.*$',
    },
    description: {
      selectors: ['meta[property="og:description"]'],
    },
    durationSec: {
      globalKeys: ['video_duration', 'durationSec'],
    },
    authorName: {
      selectors: [
        '.video-info-row .usernameWrap a',
        '.userInfo a[href*="/model/"]',
        '.userInfo a[href*="/channels/"]',
        '.userInfo a[href*="/pornstar/"]',
      ],
    },
    authorUrl: {
      selectors: [
        '.video-info-row .usernameWrap a',
        '.userInfo a[href*="/model/"]',
        '.userInfo a[href*="/channels/"]',
        '.userInfo a[href*="/pornstar/"]',
      ],
      attribute: 'href',
    },
    authorFallbackName: 'Pornhub Creator',
    coverUrls: [
      {
        globalKeys: ['image_url', 'coverUrl'],
        selectors: ['meta[property="og:image"]'],
      },
    ],
    tagsSelector: '.tagsWrapper a.item, .categoriesWrapper a.item',
    tagsIgnoreValues: ['+'],
    extraIdKey: 'viewkey',
  },
  videoMedia: {
    definitionArray: {
      urlKey: 'videoUrl',
      formatKey: 'format',
      qualityKey: 'quality',
      skipUrlContains: '/video/get_media',
    },
  },
  nativeFavorite: {
    apiUrlContains: '/video/favourite',
    removeMarkers: ['toggle=0'],
  },
};
