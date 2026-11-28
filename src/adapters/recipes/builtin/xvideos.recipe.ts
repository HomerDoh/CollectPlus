/**
 * XVideos 声明式站点规则（Tier 2 SiteRecipe）。
 *
 * 替代原 573 行的独立 `xvideos/main-hook.ts` 与 `xvideos/parser.ts`，
 * 支持 `window.html5player`、内联脚本 `html5player.setVideoUrl*`、直链高画质优先与 HLS 回退。
 */

import type { SiteRecipe } from '../schema.ts';

export const xvideosRecipe: SiteRecipe = {
  id: 'xvideos',
  displayName: 'XVideos',
  hostPatterns: ['https://www.xvideos.com/*', 'https://xvideos.com/*'],
  matchHosts: ['www.xvideos.com', 'xvideos.com'],
  kind: 'video',
  uiMeta: {
    entryUrl: 'https://www.xvideos.com/',
    badgeClass: 'bg-red-700/85 text-white backdrop-blur-xs',
  },
  defaultReferer: 'https://www.xvideos.com/',
  defaultOrigin: 'https://www.xvideos.com',
  dnrRules: [
    {
      idOffset: 1,
      urlFilter: '||xvideos-cdn.com/',
      referer: 'https://www.xvideos.com/',
      origin: 'https://www.xvideos.com',
    },
    {
      idOffset: 2,
      urlFilter: '||xnxx-cdn.com/',
      referer: 'https://www.xvideos.com/',
      origin: 'https://www.xvideos.com',
    },
  ],
  idExtractor: {
    pathRegexes: ['\\/video\\.([a-z0-9]+)', '\\/video(\\d+)'],
  },
  globalSource: {
    windowVar: 'html5player',
    inlineSetterObject: 'html5player',
  },
  fields: {
    sourceId: { globalKeys: ['videoId', 'id_video'] },
    title: {
      globalKeys: ['title', 'video_title'],
      setterMethods: ['setVideoTitle'],
      selectors: ['meta[property="og:title"]'],
      stripTitleSuffixRegex: '\\s*-\\s*XVIDEOS\\.COM.*$',
    },
    description: {
      selectors: ['meta[property="og:description"]'],
    },
    durationSec: {
      globalKeys: ['durationSec', 'video_duration'],
      selectors: ['meta[property="og:duration"]'],
    },
    authorName: {
      globalKeys: ['uploaderName', 'uploader_name'],
      setterMethods: ['setUploaderName'],
      selectors: ['.video-metadata a.uploader-tag', '.main-uploader a'],
    },
    authorUrl: {
      selectors: ['.video-metadata a.uploader-tag', '.main-uploader a'],
      attribute: 'href',
    },
    authorFallbackName: 'XVideos Uploader',
    coverUrls: [
      {
        globalKeys: ['thumbUrl169', 'url_thumb169'],
        setterMethods: ['setThumbUrl169'],
      },
      {
        globalKeys: ['thumbUrl', 'url_thumb'],
        setterMethods: ['setThumbUrl'],
        selectors: ['meta[property="og:image"]'],
      },
    ],
    tagsSelector: '.video-tags-list a[href*="/tags/"], .is-keyword',
    tagsIgnoreValues: ['+'],
    extraIdKey: 'videoId',
  },
  videoMedia: {
    directUrlFields: [
      {
        globalKeys: ['urlHigh', 'url_high'],
        setterMethods: ['setVideoUrlHigh'],
      },
      {
        globalKeys: ['urlLow', 'url_low'],
        setterMethods: ['setVideoUrlLow'],
      },
    ],
    hlsUrlFields: [
      {
        globalKeys: ['urlHls', 'url_hls'],
        setterMethods: ['setVideoHLS'],
      },
    ],
  },
  nativeFavorite: {
    apiUrlContains: '/video-favorites/',
    removeMarkers: ['remove'],
  },
};
