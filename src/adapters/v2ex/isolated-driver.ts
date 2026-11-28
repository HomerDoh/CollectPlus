/**
 * V2EX Isolated World 站点驱动（接入统一 `bridge-content-runtime.ts`）。
 *
 * 相比原先 1,100 行的独立入口，本模块仅保留 V2EX 特有的 SSR HTML 能力：
 * 1. `/t/{id}` 主题页提取与内联回复收集；
 * 2. 原生「加入收藏 / 取消收藏」点击监听与 302 跳转后幂等补确认；
 * 3. `/my/topics` 分页全量同步（含 Cloudflare/429 风控自动降级）与远端取消收藏。
 */

import type {
  IsolatedDriverHooks,
  IsolatedSiteDriver,
} from '../../components/bridge-content-runtime.ts';
import { i18n } from '../../i18n/index.ts';
import type {
  RemoteUncollectTargetInput,
  RemoteUncollectTargetOutcome,
} from '../../types/adapter.ts';
import { sendToBackground } from '../../types/messages.ts';
import {
  extractFavoriteListFromDocument,
  extractTopicIdFromUrl,
  extractV2exLoginAccount,
  extractV2exTopicFromDocument,
  isV2exChallengeDocument,
  type V2exRawTopicData,
} from './dom-extractor.ts';
import { parseV2exComments, v2exAdapter } from './parser.ts';

const V2EX_COMMENT_CAPTURE_LIMIT = 100;
const PENDING_FAVORITE_STORAGE_KEY = 'collect-plus:v2ex:pending-favorite';
const PENDING_FAVORITE_TTL_MS = 15_000;
const FULL_SYNC_MAX_PAGES = 30;
const FULL_SYNC_PAGE_MIN_DELAY_MS = 1500;
const FULL_SYNC_PAGE_JITTER_MS = 600;
const FULL_SYNC_TOPIC_DELAY_MS = 600;
const FULL_SYNC_TOPIC_JITTER_MS = 350;
const V2EX_FAVORITES_URL = 'https://www.v2ex.com/my/topics';

function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(new DOMException('Aborted', 'AbortError'));
  }
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function writePendingFavoriteMarker(topicId: string): void {
  try {
    sessionStorage.setItem(
      PENDING_FAVORITE_STORAGE_KEY,
      JSON.stringify({ topicId, ts: Date.now() }),
    );
  } catch {
    // 忽略隐私模式或禁用 storage 异常
  }
}

function consumePendingFavoriteMarker(expectedTopicId: string): boolean {
  try {
    const raw = sessionStorage.getItem(PENDING_FAVORITE_STORAGE_KEY);
    if (!raw) {
      return false;
    }
    sessionStorage.removeItem(PENDING_FAVORITE_STORAGE_KEY);
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) {
      return false;
    }
    const rec = parsed as Record<string, unknown>;
    return (
      rec.topicId === expectedTopicId &&
      typeof rec.ts === 'number' &&
      Date.now() - rec.ts <= PENDING_FAVORITE_TTL_MS
    );
  } catch {
    return false;
  }
}

function extractFavoriteHrefTopicId(
  href: string,
  action: 'favorite' | 'unfavorite',
): string | null {
  const pattern =
    action === 'favorite'
      ? /\/favorite\/topic\/(\d+)/
      : /\/unfavorite\/topic\/(\d+)/;
  const match = pattern.exec(href);
  return match?.[1] ?? null;
}

async function fetchAndParseHtml(
  pathOrUrl: string,
  signal?: AbortSignal,
): Promise<{ status: number; doc: Document | null }> {
  const response = await fetch(pathOrUrl, {
    method: 'GET',
    credentials: 'include',
    signal,
  });
  if (response.status < 200 || response.status >= 300) {
    return { status: response.status, doc: null };
  }
  const html = await response.text();
  if (!html) {
    return { status: response.status, doc: null };
  }
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return { status: response.status, doc };
}

export function createV2exIsolatedDriver(): IsolatedSiteDriver {
  const currentTopicId = extractTopicIdFromUrl(window.location.href);
  const isTopicPage = currentTopicId !== null;
  const isFavoritesListPage =
    window.location.pathname.replace(/\/+$/, '') === '/my/topics';
  const currentAccount = extractV2exLoginAccount(document);

  let activeSyncAbortController: AbortController | null = null;
  let hooksRef: IsolatedDriverHooks | null = null;

  const submitAutoSyncTopic = async (
    topicData: V2exRawTopicData,
  ): Promise<'added' | 'deduplicated' | 'failed'> => {
    const hooks = hooksRef;
    const payload = v2exAdapter.normalizeRawData(topicData, 'auto_sync');
    if (!hooks || !payload) {
      return 'failed';
    }
    const inlineComments =
      topicData.replies.length > 0
        ? parseV2exComments(topicData.replies, V2EX_COMMENT_CAPTURE_LIMIT)
        : undefined;
    const result = await hooks.submitPayload(payload, {
      ...(inlineComments ? { inlineComments } : {}),
    });
    if (!result.ok) {
      return 'failed';
    }
    return result.deduplicated ? 'deduplicated' : 'added';
  };

  const syncTopicIdsList = async (
    topicIds: readonly string[],
    signal: AbortSignal,
    counters: { fetched: number; added: number; deduplicated: number },
  ): Promise<'ok' | 'rate_limited' | 'cancelled'> => {
    const hooks = hooksRef;
    for (let i = 0; i < topicIds.length; i += 1) {
      if (signal.aborted) {
        return 'cancelled';
      }
      const topicId = topicIds[i];
      if (!topicId) {
        continue;
      }
      if (i > 0) {
        const delay =
          FULL_SYNC_TOPIC_DELAY_MS +
          Math.floor(Math.random() * FULL_SYNC_TOPIC_JITTER_MS);
        await sleepAbortable(delay, signal);
      }

      const topicUrl = `https://www.v2ex.com/t/${encodeURIComponent(topicId)}`;
      const { status, doc } = await fetchAndParseHtml(
        `/t/${encodeURIComponent(topicId)}`,
        signal,
      );
      if (status === 403 || status === 429 || !doc || isV2exChallengeDocument(doc)) {
        return 'rate_limited';
      }

      const topicData = extractV2exTopicFromDocument(doc, topicUrl);
      if (!topicData) {
        continue;
      }
      const outcome = await submitAutoSyncTopic(topicData);
      counters.fetched += 1;
      if (outcome === 'added') {
        counters.added += 1;
      } else if (outcome === 'deduplicated') {
        counters.deduplicated += 1;
      }

      hooks?.updateState((prev) => ({
        ...prev,
        syncBanner: {
          phase: 'syncing',
          fetchedCount: counters.fetched,
          addedCount: counters.added,
          deduplicatedCount: counters.deduplicated,
        },
      }));
    }
    return 'ok';
  };

  const startCustomFullSync = async (): Promise<void> => {
    const hooks = hooksRef;
    if (!hooks || activeSyncAbortController !== null || !currentAccount) {
      return;
    }

    const controller = new AbortController();
    activeSyncAbortController = controller;
    hooks.clearBannerTimer();

    const counters = { fetched: 0, added: 0, deduplicated: 0 };
    hooks.updateState((prev) => ({
      ...prev,
      syncPrompt: null,
      syncBanner: {
        phase: 'syncing',
        fetchedCount: 0,
        addedCount: 0,
        deduplicatedCount: 0,
      },
    }));

    const finishWithFallback = async (reason: string): Promise<void> => {
      hooks.setPassiveFallbackActive(true);
      await sendToBackground({
        target: 'background',
        type: 'REPORT_ACCOUNT_SYNC_RESULT',
        platform: 'v2ex',
        accountId: currentAccount.accountId,
        outcome: 'fallback_needed',
      }).catch(() => undefined);
      hooks.updateState((prev) => ({
        ...prev,
        syncBanner: {
          phase: 'fallback',
          fetchedCount: counters.fetched,
          addedCount: counters.added,
          deduplicatedCount: counters.deduplicated,
          message: reason,
          fallbackUrl: V2EX_FAVORITES_URL,
        },
      }));
    };

    try {
      const seenTopicIds = new Set<string>();

      for (let page = 1; page <= FULL_SYNC_MAX_PAGES; page += 1) {
        if (controller.signal.aborted) {
          break;
        }
        if (page > 1) {
          const delay =
            FULL_SYNC_PAGE_MIN_DELAY_MS +
            Math.floor(Math.random() * FULL_SYNC_PAGE_JITTER_MS);
          await sleepAbortable(delay, controller.signal);
        }

        const { status, doc } = await fetchAndParseHtml(
          `/my/topics?p=${page}`,
          controller.signal,
        );
        if (status === 403 || status === 429) {
          await finishWithFallback(
            i18n.t('content.v2exRateLimitedList', { status }),
          );
          return;
        }
        if (!doc) {
          await finishWithFallback(i18n.t('content.v2exListReadFailed'));
          return;
        }

        const parsedList = extractFavoriteListFromDocument(doc, page);
        if (parsedList.isChallengePage) {
          await finishWithFallback(i18n.t('content.v2exChallengeDetected'));
          return;
        }

        const batchTopicIds = parsedList.topicIds.filter((id) => {
          if (seenTopicIds.has(id)) {
            return false;
          }
          seenTopicIds.add(id);
          return true;
        });

        if (batchTopicIds.length > 0) {
          const syncOutcome = await syncTopicIdsList(
            batchTopicIds,
            controller.signal,
            counters,
          );
          if (syncOutcome === 'rate_limited') {
            await finishWithFallback(i18n.t('content.v2exRateLimitedTopic'));
            return;
          }
          if (syncOutcome === 'cancelled') {
            break;
          }
        }

        if (!parsedList.hasNextPage || parsedList.topicIds.length === 0) {
          break;
        }
      }

      if (controller.signal.aborted) {
        await sendToBackground({
          target: 'background',
          type: 'REPORT_ACCOUNT_SYNC_RESULT',
          platform: 'v2ex',
          accountId: currentAccount.accountId,
          outcome: 'failed',
        }).catch(() => undefined);
        hooks.updateState((prev) => ({ ...prev, syncBanner: null }));
        return;
      }

      await sendToBackground({
        target: 'background',
        type: 'REPORT_ACCOUNT_SYNC_RESULT',
        platform: 'v2ex',
        accountId: currentAccount.accountId,
        outcome: 'synced',
        syncedCount: counters.added,
      }).catch(() => undefined);

      hooks.updateState((prev) => ({
        ...prev,
        syncBanner: {
          phase: 'completed',
          fetchedCount: counters.fetched,
          addedCount: counters.added,
          deduplicatedCount: counters.deduplicated,
        },
      }));
      hooks.scheduleBannerAutoClose();
    } catch (error) {
      if (
        controller.signal.aborted ||
        (error instanceof DOMException && error.name === 'AbortError')
      ) {
        hooks.updateState((prev) => ({ ...prev, syncBanner: null }));
      } else {
        await sendToBackground({
          target: 'background',
          type: 'REPORT_ACCOUNT_SYNC_RESULT',
          platform: 'v2ex',
          accountId: currentAccount.accountId,
          outcome: 'failed',
        }).catch(() => undefined);
        hooks.updateState((prev) => ({
          ...prev,
          syncBanner: {
            phase: 'error',
            fetchedCount: counters.fetched,
            addedCount: counters.added,
            deduplicatedCount: counters.deduplicated,
            message: error instanceof Error ? error.message : String(error),
          },
        }));
      }
    } finally {
      if (activeSyncAbortController === controller) {
        activeSyncAbortController = null;
      }
    }
  };

  const runPassiveFavoritesPageSync = async (): Promise<void> => {
    const hooks = hooksRef;
    if (!hooks || !isFavoritesListPage || activeSyncAbortController !== null) {
      return;
    }
    const parsed = extractFavoriteListFromDocument(document);
    if (parsed.isChallengePage || parsed.topicIds.length === 0) {
      return;
    }
    const controller = new AbortController();
    activeSyncAbortController = controller;
    const counters = { fetched: 0, added: 0, deduplicated: 0 };
    try {
      const outcome = await syncTopicIdsList(
        parsed.topicIds,
        controller.signal,
        counters,
      );
      if (outcome === 'ok' && (counters.added > 0 || counters.deduplicated > 0)) {
        hooks.updateState((prev) => ({
          ...prev,
          syncBanner: {
            phase: 'completed',
            fetchedCount: counters.fetched,
            addedCount: counters.added,
            deduplicatedCount: counters.deduplicated,
            message: i18n.t('content.v2exPassiveSynced'),
          },
        }));
        hooks.scheduleBannerAutoClose();
      }
    } catch {
      // 被动模式静默降级
    } finally {
      if (activeSyncAbortController === controller) {
        activeSyncAbortController = null;
      }
    }
  };

  return {
    isCapturablePage: () => isTopicPage,
    getUncapturableError: () => i18n.t('content.v2exNeedTopicPage'),

    async extractCurrentItem() {
      const topicData = extractV2exTopicFromDocument(
        document,
        window.location.href,
      );
      if (!topicData) {
        return {
          rawData: null,
          error: i18n.t('content.v2exNeedTopicPageAction'),
        };
      }
      const inlineComments =
        topicData.replies.length > 0
          ? parseV2exComments(topicData.replies, V2EX_COMMENT_CAPTURE_LIMIT)
          : undefined;
      return {
        rawData: topicData,
        ...(inlineComments ? { inlineComments } : {}),
      };
    },

    setup(hooks) {
      hooksRef = hooks;

      const enqueueTopic = (topicData: V2exRawTopicData): void => {
        const payload = v2exAdapter.normalizeRawData(
          topicData,
          'native_collect',
        );
        if (!payload) {
          return;
        }
        const inlineComments =
          topicData.replies.length > 0
            ? parseV2exComments(topicData.replies, V2EX_COMMENT_CAPTURE_LIMIT)
            : undefined;
        hooks.enqueueNativeCollect(payload, inlineComments);
      };

      const onClick = (event: Event): void => {
        const target = event.target;
        if (!(target instanceof Element)) {
          return;
        }
        const anchor = target.closest<HTMLAnchorElement>(
          'a[href*="/favorite/topic/"], a[href*="/unfavorite/topic/"]',
        );
        if (!anchor) {
          return;
        }

        const href = anchor.getAttribute('href') ?? '';
        const favId = extractFavoriteHrefTopicId(href, 'favorite');
        if (favId) {
          writePendingFavoriteMarker(favId);
          const topicData = extractV2exTopicFromDocument(
            document,
            window.location.href,
          );
          if (topicData && topicData.topicId === favId) {
            enqueueTopic(topicData);
          }
          return;
        }

        const unfavId = extractFavoriteHrefTopicId(href, 'unfavorite');
        if (unfavId) {
          void hooks.notifyNativeUncollect([unfavId]);
        }
      };

      document.addEventListener('click', onClick, true);

      // 若刚经由原站「加入收藏」302 跳转回主题页，执行幂等补确认
      if (
        currentTopicId &&
        consumePendingFavoriteMarker(currentTopicId) &&
        document.querySelector(
          `a[href*="/unfavorite/topic/${currentTopicId}"]`,
        ) !== null
      ) {
        const topicData = extractV2exTopicFromDocument(
          document,
          window.location.href,
        );
        if (topicData) {
          enqueueTopic(topicData);
        }
      }

      if (currentAccount) {
        hooks.registerLoginAccount(currentAccount);
      }

      return () => {
        document.removeEventListener('click', onClick, true);
        activeSyncAbortController?.abort();
        activeSyncAbortController = null;
        hooksRef = null;
      };
    },

    startCustomFullSync,

    cancelCustomFullSync() {
      activeSyncAbortController?.abort();
    },

    onAccountSyncDecision(decision) {
      if (
        isFavoritesListPage &&
        (decision.passiveFallbackActive ||
          hooksRef?.getAutoSyncAllCollections())
      ) {
        void runPassiveFavoritesPageSync();
      }
    },

    async remoteUncollect(
      items: RemoteUncollectTargetInput[],
    ): Promise<RemoteUncollectTargetOutcome[]> {
      const results: RemoteUncollectTargetOutcome[] = [];
      const parser = new DOMParser();

      for (let i = 0; i < items.length; i += 1) {
        const target = items[i];
        if (!target) {
          continue;
        }
        const topicId = target.sourceId.trim();
        if (!/^\d+$/.test(topicId)) {
          results.push({
            sourceId: target.sourceId,
            ok: false,
            reason: i18n.t('content.v2exInvalidTopicId'),
          });
          continue;
        }
        if (i > 0) {
          await new Promise<void>((resolve) => setTimeout(resolve, 260));
        }

        try {
          const topicRes = await fetch(
            `${window.location.origin}/t/${encodeURIComponent(topicId)}`,
            { method: 'GET', credentials: 'include' },
          );
          if (!topicRes.ok) {
            results.push({
              sourceId: topicId,
              ok: false,
              reason: i18n.t('content.v2exReadTopicFailed', {
                status: topicRes.status,
              }),
            });
            continue;
          }
          const html = await topicRes.text();
          const doc = parser.parseFromString(html, 'text/html');
          const unfavLink = doc.querySelector<HTMLAnchorElement>(
            `a[href*="/unfavorite/topic/${topicId}"]`,
          );
          if (!unfavLink) {
            const favLink = doc.querySelector<HTMLAnchorElement>(
              `a[href*="/favorite/topic/${topicId}"]`,
            );
            if (favLink) {
              results.push({ sourceId: topicId, ok: true });
            } else {
              results.push({
                sourceId: topicId,
                ok: false,
                reason: i18n.t('content.v2exNotLoggedIn'),
              });
            }
            continue;
          }

          const unfavHref = unfavLink.getAttribute('href') ?? '';
          const unfavUrl = new URL(
            unfavHref,
            window.location.origin,
          ).toString();
          const unfavRes = await fetch(unfavUrl, {
            method: 'GET',
            credentials: 'include',
          });
          if (unfavRes.ok) {
            results.push({ sourceId: topicId, ok: true });
          } else {
            results.push({
              sourceId: topicId,
              ok: false,
              reason: i18n.t('content.v2exUncollectFailed', {
                status: unfavRes.status,
              }),
            });
          }
        } catch (error) {
          results.push({
            sourceId: topicId,
            ok: false,
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      }

      return results;
    },
  };
}
