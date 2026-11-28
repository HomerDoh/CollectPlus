/**
 * YouTube Main World 旁路数据拦截与活跃视频解析器（基于 `shared/main-bridge.ts`）。
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

const HOOK_GUARD_KEY = '__COLLECT_PLUS_YOUTUBE_MAIN_HOOK__';
const MAX_CACHE_SIZE = 200;

interface YoutubeGlobalWindow extends Window {
  ytInitialPlayerResponse?: unknown;
}

function extractVideoIdFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url, window.location.origin);
    const v = parsed.searchParams.get('v')?.trim();
    if (v && /^[A-Za-z0-9_-]{6,32}$/.test(v)) {
      return v;
    }
    const m = /^\/(?:shorts|embed|live)\/([A-Za-z0-9_-]{6,32})/.exec(
      parsed.pathname,
    );
    return m?.[1] ?? null;
  } catch {
    return null;
  }
}

function extractPlayerVideoId(payload: unknown): string | null {
  if (!isRecord(payload)) {
    return null;
  }
  const details = payload.videoDetails;
  if (isRecord(details) && typeof details.videoId === 'string') {
    const id = details.videoId.trim();
    return id.length > 0 ? id : null;
  }
  return null;
}

function readMoviePlayerResponse(): unknown {
  try {
    const playerEl = document.getElementById('movie_player') as
      | (HTMLElement & { getPlayerResponse?: () => unknown })
      | null;
    if (playerEl && typeof playerEl.getPlayerResponse === 'function') {
      return playerEl.getPlayerResponse();
    }
  } catch {
    // 忽略播放器方法调用异常
  }
  return null;
}

export function installYoutubeMainHook(): void {
  if (!installMainHookOnce(HOOK_GUARD_KEY)) {
    return;
  }

  const win = window as YoutubeGlobalWindow;
  const bridge = createMainBridge('youtube');
  const playerCache = createLruCache<string, UnknownRecord>(MAX_CACHE_SIZE);

  const cachePlayerResponse = (payload: unknown): void => {
    if (!isRecord(payload)) {
      return;
    }
    const videoId = extractPlayerVideoId(payload);
    if (!videoId || !isRecord(payload.streamingData)) {
      return;
    }
    playerCache.set(videoId, payload);
  };

  const harvestGlobals = (): void => {
    cachePlayerResponse(win.ytInitialPlayerResponse);
    cachePlayerResponse(readMoviePlayerResponse());
  };

  const resolveActiveVideoData = (): UnknownRecord | null => {
    harvestGlobals();
    const activeId = extractVideoIdFromUrl(window.location.href);
    if (activeId) {
      const cached = playerCache.get(activeId);
      if (cached) {
        return { ...cached, sourceUrl: window.location.href };
      }
    }

    const fromMoviePlayer = readMoviePlayerResponse();
    if (isRecord(fromMoviePlayer) && extractPlayerVideoId(fromMoviePlayer)) {
      return { ...fromMoviePlayer, sourceUrl: window.location.href };
    }

    if (
      isRecord(win.ytInitialPlayerResponse) &&
      extractPlayerVideoId(win.ytInitialPlayerResponse)
    ) {
      return { ...win.ytInitialPlayerResponse, sourceUrl: window.location.href };
    }

    return null;
  };

  const handleEditPlaylistRequest = (bodyText: string): void => {
    try {
      const parsed: unknown = JSON.parse(bodyText);
      if (!isRecord(parsed) || !Array.isArray(parsed.actions)) {
        return;
      }
      const addedIds: string[] = [];
      const removedIds: string[] = [];
      for (const action of parsed.actions) {
        if (!isRecord(action)) {
          continue;
        }
        const actionType =
          typeof action.action === 'string' ? action.action : '';
        if (
          actionType === 'ACTION_ADD_VIDEO' &&
          typeof action.addedVideoId === 'string' &&
          action.addedVideoId.trim()
        ) {
          addedIds.push(action.addedVideoId.trim());
        } else if (
          (actionType === 'ACTION_REMOVE_VIDEO_BY_VIDEO_ID' ||
            actionType === 'ACTION_REMOVE_VIDEO') &&
          typeof action.removedVideoId === 'string' &&
          action.removedVideoId.trim()
        ) {
          removedIds.push(action.removedVideoId.trim());
        }
      }

      if (addedIds.length > 0) {
        harvestGlobals();
        for (const vid of addedIds) {
          const data = playerCache.get(vid) ?? resolveActiveVideoData();
          if (data) {
            bridge.emitNativeCollect(
              { ...data, sourceUrl: `https://www.youtube.com/watch?v=${vid}` },
              vid,
            );
          }
        }
      }

      if (removedIds.length > 0) {
        bridge.emitNativeUncollect(removedIds);
      }
    } catch {
      // 忽略非 JSON 请求体
    }
  };

  observeMainNetwork({
    match(url: string): boolean {
      return (
        url.includes('/youtubei/v1/player') ||
        url.includes('/youtubei/v1/playlist/edit_playlist')
      );
    },
    onResponse(event): void {
      if (!event.ok) {
        return;
      }
      if (event.url.includes('/youtubei/v1/player')) {
        void event.readJson().then((json) => {
          if (json !== null) {
            cachePlayerResponse(json);
          }
        });
      } else if (
        event.url.includes('/youtubei/v1/playlist/edit_playlist') &&
        event.requestBodyText
      ) {
        handleEditPlaylistRequest(event.requestBodyText);
      }
    },
  });

  bridge.onContentMessage((message) => {
    if (message.type === 'REQUEST_CURRENT_ITEM') {
      bridge.replyCurrentItem(
        message.requestId,
        message.triggerSource,
        resolveActiveVideoData(),
      );
    }
  });

  harvestGlobals();
  bridge.notifyReady();
}
