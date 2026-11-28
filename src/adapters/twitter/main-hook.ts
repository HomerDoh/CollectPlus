/**
 * X / Twitter Main World 旁路 GraphQL 拦截与活跃推文定位器（基于 `shared/main-bridge.ts`）。
 *
 * 铁律：运行于网页 MAIN World，严禁引入 `chrome.*` API、Dexie 或 React 运行时；
 * 仅通过 `window.postMessage` + `PAGE_BRIDGE_CHANNEL` 与 Isolated Content Script 通信。
 */

import {
  createLruCache,
  createMainBridge,
  installMainHookOnce,
  isRecord,
  observeMainNetwork,
  type UnknownRecord,
} from '../shared/main-bridge.ts';

const HOOK_GUARD_KEY = '__COLLECT_PLUS_TWITTER_MAIN_HOOK__';
const MAX_CACHE_SIZE = 200;

function extractStatusIdFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url, window.location.origin);
    const match = /\/status\/(\d+)/.exec(parsed.pathname);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

function findViewportTweetId(): string | null {
  const articles = Array.from(
    document.querySelectorAll('article[data-testid="tweet"]'),
  );
  if (articles.length === 0) {
    return null;
  }
  const viewportCenter = window.innerHeight / 2;
  let bestId: string | null = null;
  let bestDist = Number.POSITIVE_INFINITY;

  for (const article of articles) {
    const rect = article.getBoundingClientRect();
    if (rect.height <= 0) {
      continue;
    }
    const center = rect.top + rect.height / 2;
    const dist = Math.abs(center - viewportCenter);
    if (dist >= bestDist) {
      continue;
    }
    const links = article.querySelectorAll<HTMLAnchorElement>(
      'a[href*="/status/"]',
    );
    for (const link of links) {
      const id = extractStatusIdFromUrl(link.href);
      if (id) {
        bestId = id;
        bestDist = dist;
        break;
      }
    }
  }
  return bestId;
}

function extractTweetFromDom(tweetId: string): UnknownRecord | null {
  const articles = Array.from(
    document.querySelectorAll('article[data-testid="tweet"]'),
  );
  for (const article of articles) {
    const link = article.querySelector<HTMLAnchorElement>(
      `a[href*="/status/${tweetId}"]`,
    );
    if (!link) {
      continue;
    }
    const textEl = article.querySelector('[data-testid="tweetText"]');
    const text = textEl?.textContent?.trim() ?? '';
    const imgs = Array.from(
      article.querySelectorAll<HTMLImageElement>(
        '[data-testid="tweetPhoto"] img[src*="pbs.twimg.com"]',
      ),
    );
    const media = imgs.map((img) => ({
      type: 'photo',
      media_url_https: img.src,
    }));
    return {
      rest_id: tweetId,
      sourceUrl: link.href,
      legacy: {
        id_str: tweetId,
        full_text: text,
        extended_entities: { media },
      },
    };
  }
  return null;
}

export function installTwitterMainHook(): void {
  if (!installMainHookOnce(HOOK_GUARD_KEY)) {
    return;
  }

  const bridge = createMainBridge('twitter');
  const tweetCache = createLruCache<string, UnknownRecord>(MAX_CACHE_SIZE);

  const putTweet = (tweet: UnknownRecord): void => {
    const unwrapped = isRecord(tweet.tweet) ? tweet.tweet : tweet;
    const restId =
      typeof unwrapped.rest_id === 'string'
        ? unwrapped.rest_id.trim()
        : isRecord(unwrapped.legacy) &&
            typeof unwrapped.legacy.id_str === 'string'
          ? unwrapped.legacy.id_str.trim()
          : '';
    if (!restId || !isRecord(unwrapped.legacy)) {
      return;
    }
    tweetCache.set(restId, unwrapped);
  };

  const harvestTweetsFromJson = (node: unknown, depth = 0): void => {
    if (depth > 18 || node === null || typeof node !== 'object') {
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) {
        harvestTweetsFromJson(item, depth + 1);
      }
      return;
    }
    const rec = node as UnknownRecord;
    const typename = rec.__typename;
    if (
      (typename === 'Tweet' || typename === 'TweetWithVisibilityResults') &&
      (typeof rec.rest_id === 'string' || isRecord(rec.tweet))
    ) {
      putTweet(rec);
    } else if (
      typeof rec.rest_id === 'string' &&
      isRecord(rec.legacy) &&
      typeof rec.legacy.full_text === 'string'
    ) {
      putTweet(rec);
    }
    for (const val of Object.values(rec)) {
      if (val !== null && typeof val === 'object') {
        harvestTweetsFromJson(val, depth + 1);
      }
    }
  };

  const resolveActiveTweet = (): UnknownRecord | null => {
    const urlId = extractStatusIdFromUrl(window.location.href);
    const targetId = urlId ?? findViewportTweetId();
    if (targetId) {
      const cached = tweetCache.get(targetId);
      if (cached) {
        return { ...cached, sourceUrl: window.location.href };
      }
      const domFallback = extractTweetFromDom(targetId);
      if (domFallback) {
        return domFallback;
      }
    }
    return null;
  };

  const parseBookmarkTweetId = (bodyText: string): string | null => {
    try {
      const parsed: unknown = JSON.parse(bodyText);
      if (isRecord(parsed) && isRecord(parsed.variables)) {
        const tid = parsed.variables.tweet_id;
        if (typeof tid === 'string' && tid.trim()) {
          return tid.trim();
        }
      }
    } catch {
      // 忽略非 JSON 请求体
    }
    return null;
  };

  const handleBookmarkMutation = (url: string, bodyText?: string): void => {
    if (!bodyText) {
      return;
    }
    const tweetId = parseBookmarkTweetId(bodyText);
    if (!tweetId) {
      return;
    }
    if (url.includes('CreateBookmark')) {
      const data = tweetCache.get(tweetId) ?? extractTweetFromDom(tweetId);
      if (data) {
        bridge.emitNativeCollect(data, tweetId);
      }
    } else if (url.includes('DeleteBookmark')) {
      bridge.emitNativeUncollect([tweetId]);
    }
  };

  observeMainNetwork({
    match(url: string): boolean {
      return url.includes('/i/api/graphql/');
    },
    onResponse(event): void {
      if (!event.ok) {
        return;
      }
      const isBookmarkOp =
        event.url.includes('CreateBookmark') ||
        event.url.includes('DeleteBookmark');
      if (isBookmarkOp) {
        handleBookmarkMutation(event.url, event.requestBodyText);
      } else {
        void event.readJson().then((json) => {
          if (json !== null) {
            harvestTweetsFromJson(json);
          }
        });
      }
    },
  });

  bridge.onContentMessage((message) => {
    if (message.type === 'REQUEST_CURRENT_ITEM') {
      bridge.replyCurrentItem(
        message.requestId,
        message.triggerSource,
        resolveActiveTweet(),
      );
    }
  });

  bridge.notifyReady();
}
