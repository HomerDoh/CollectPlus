import type { BrowserContext, CDPSession, Route } from '@playwright/test';

export const MOCK_V2EX_TOPIC_ID = '1088801';
export const MOCK_V2EX_TOPIC_TITLE = 'Playwright 自动化验证：本地离线收藏架构设计';
export const MOCK_V2EX_TEXT_ONLY_ID = '1088802';
export const MOCK_V2EX_TEXT_ONLY_TITLE = '纯文本无图与失效外链容错测试帖子';
export const MOCK_V2EX_FAV_TOPIC_ID = '1088803';
export const MOCK_V2EX_FAV_TOPIC_TITLE = 'V2EX 全量收藏同步历史主题';

/** 合法 1x1 青色 PNG（V2EX 头像与内嵌图） */
const VALID_PNG_TEAL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEBgIApD5fRAAAAABJRU5ErkJggg==',
  'base64',
);

function buildTopBar(loggedInUser?: string | null): string {
  if (!loggedInUser) {
    return `<div id="Top"><a href="/">V2EX</a> <a href="/signin">登录</a></div>`;
  }
  return `<div id="Top">
    <a href="/">V2EX</a>
    <a href="/member/${loggedInUser}">${loggedInUser}</a>
    <a href="/my/topics">主题收藏</a>
    <a href="/settings">设置</a>
    <a href="/signout">登出</a>
  </div>`;
}

function buildV2exTopicHtml(params: {
  topicId: string;
  title: string;
  bodyHtml: string;
  subtleHtml?: string;
  nodeName?: string;
  nodeSlug?: string;
  author?: string;
  favorited?: boolean;
  loggedInUser?: string | null;
  includeReplies?: boolean;
}): string {
  const nodeName = params.nodeName ?? '分享创造';
  const nodeSlug = params.nodeSlug ?? 'create';
  const author = params.author ?? 'livid_tester';
  const favLink = params.favorited
    ? `<a href="/unfavorite/topic/${params.topicId}?once=12345" class="tb">取消收藏</a>`
    : `<a href="/favorite/topic/${params.topicId}?once=12345" class="tb">加入收藏</a>`;

  const repliesHtml =
    params.includeReplies === false
      ? ''
      : `<div class="box">
          <div class="cell"><span class="gray">2 条回复</span></div>
          <div id="r_50001" class="cell">
            <table><tr>
              <td><img src="https://cdn.v2ex.com/avatar/reply-u1.png" class="avatar" /></td>
              <td>
                <strong><a href="/member/dev_alice" class="dark">dev_alice</a></strong>
                <span class="ago" title="2026-11-27 10:30:00 +08:00">10 分钟前</span>
                <span class="small fade">♥ 12</span>
                <div class="reply_content">这个本地优先离线归档方案非常赞，再也不怕帖子 404 了！</div>
              </td>
            </tr></table>
          </div>
          <div id="r_50002" class="cell">
            <table><tr>
              <td><img src="https://cdn.v2ex.com/avatar/reply-u2.png" class="avatar" /></td>
              <td>
                <strong><a href="/member/ops_bob" class="dark">ops_bob</a></strong>
                <span class="ago" title="2026-11-27 10:35:00 +08:00">5 分钟前</span>
                <div class="reply_content">附言和回复一起离线保存很实用。</div>
              </td>
            </tr></table>
          </div>
        </div>`;

  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <title>${params.title} - V2EX</title>
    <link rel="canonical" href="https://www.v2ex.com/t/${params.topicId}" />
  </head>
  <body>
    ${buildTopBar(params.loggedInUser)}
    <div id="Main">
      <div class="box">
        <div class="header">
          <div class="fr">
            <a href="/member/${author}">
              <img src="https://cdn.v2ex.com/avatar/author-${author}.png" class="avatar" />
            </a>
          </div>
          <a href="/">V2EX</a> › <a href="/go/${nodeSlug}">${nodeName}</a>
          <h1>${params.title}</h1>
          <small class="gray">
            <a href="/member/${author}">${author}</a> ·
            <span title="2026-11-27 10:00:00 +08:00">1 小时前</span> · 1280 次点击
          </small>
        </div>
        <div class="cell">
          <div class="topic_content">
            ${params.bodyHtml}
          </div>
        </div>
        ${params.subtleHtml ?? ''}
        <div class="topic_buttons">
          ${favLink}
        </div>
      </div>
      ${repliesHtml}
    </div>
  </body>
</html>`;
}

function buildV2exMyTopicsHtml(loggedInUser: string): string {
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <title>V2EX › 我收藏的主题</title>
  </head>
  <body>
    ${buildTopBar(loggedInUser)}
    <div id="Main">
      <div class="box">
        <div class="cell">我收藏的主题</div>
        <div class="cell item">
          <span class="item_title">
            <a href="/t/${MOCK_V2EX_FAV_TOPIC_ID}#reply1">${MOCK_V2EX_FAV_TOPIC_TITLE}</a>
          </span>
        </div>
      </div>
    </div>
  </body>
</html>`;
}

interface CdpFetchPausedEvent {
  requestId: string;
  request: {
    url: string;
  };
}

export interface V2exMockOptions {
  loggedInUser?: string | null;
}

export interface V2exMockTracker {
  requestedMediaUrls: string[];
  myTopicsRequests: number;
  dispose: () => Promise<void>;
}

export async function installV2exMockRoutes(
  context: BrowserContext,
  options?: V2exMockOptions,
): Promise<V2exMockTracker> {
  const tracker: V2exMockTracker = {
    requestedMediaUrls: [],
    myTopicsRequests: 0,
    dispose: async () => undefined,
  };

  const favoritedTopicIds = new Set<string>();
  const browser = context.browser();
  let cdpSession: CDPSession | null = null;

  if (browser) {
    cdpSession = await browser.newBrowserCDPSession();
    await cdpSession.send('Fetch.enable', {
      patterns: [
        { urlPattern: 'https://cdn.v2ex.com/*' },
        { urlPattern: 'https://i.v2ex.co/*' },
      ],
    });

    cdpSession.on('Fetch.requestPaused', (event: CdpFetchPausedEvent) => {
      const { requestId, request } = event;
      tracker.requestedMediaUrls.push(request.url);

      void (async () => {
        if (request.url.includes('broken-image.png')) {
          await cdpSession!.send('Fetch.fulfillRequest', {
            requestId,
            responseCode: 404,
            responseHeaders: [
              { name: 'content-type', value: 'text/plain' },
              { name: 'access-control-allow-origin', value: '*' },
            ],
            body: Buffer.from('Not Found').toString('base64'),
          });
          return;
        }

        await cdpSession!.send('Fetch.fulfillRequest', {
          requestId,
          responseCode: 200,
          responseHeaders: [
            { name: 'content-type', value: 'image/png' },
            { name: 'content-length', value: String(VALID_PNG_TEAL.byteLength) },
            { name: 'access-control-allow-origin', value: '*' },
          ],
          body: VALID_PNG_TEAL.toString('base64'),
        });
      })().catch(() => undefined);
    });
  }

  tracker.dispose = async () => {
    if (cdpSession) {
      await cdpSession.detach().catch(() => undefined);
    }
  };

  await context.route('https://www.v2ex.com/**', async (route: Route) => {
    const url = new URL(route.request().url());

    const favMatch = /^\/favorite\/topic\/(\d+)/.exec(url.pathname);
    if (favMatch?.[1]) {
      favoritedTopicIds.add(favMatch[1]);
      await route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: `<!doctype html><html><head><script>window.location.replace('https://www.v2ex.com/t/${favMatch[1]}');</script></head><body></body></html>`,
      });
      return;
    }

    const unfavMatch = /^\/unfavorite\/topic\/(\d+)/.exec(url.pathname);
    if (unfavMatch?.[1]) {
      favoritedTopicIds.delete(unfavMatch[1]);
      await route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: `<!doctype html><html><head><script>window.location.replace('https://www.v2ex.com/t/${unfavMatch[1]}');</script></head><body></body></html>`,
      });
      return;
    }

    if (url.pathname.replace(/\/+$/, '') === '/my/topics') {
      tracker.myTopicsRequests += 1;
      await route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: buildV2exMyTopicsHtml(options?.loggedInUser ?? 'v2ex_member'),
      });
      return;
    }

    const topicMatch = /^\/t\/(\d+)/.exec(url.pathname);
    if (topicMatch?.[1]) {
      const topicId = topicMatch[1];
      const favorited = favoritedTopicIds.has(topicId);

      if (topicId === MOCK_V2EX_TEXT_ONLY_ID) {
        await route.fulfill({
          status: 200,
          contentType: 'text/html; charset=utf-8',
          body: buildV2exTopicHtml({
            topicId,
            title: MOCK_V2EX_TEXT_ONLY_TITLE,
            bodyHtml:
              '<p>这是一篇包含失效外链图片的 V2EX 帖子正文，即使图片 404 也应完整保留正文。</p><img src="https://i.v2ex.co/broken-image.png" />',
            favorited,
            loggedInUser: options?.loggedInUser,
            includeReplies: false,
          }),
        });
        return;
      }

      if (topicId === MOCK_V2EX_FAV_TOPIC_ID) {
        await route.fulfill({
          status: 200,
          contentType: 'text/html; charset=utf-8',
          body: buildV2exTopicHtml({
            topicId,
            title: MOCK_V2EX_FAV_TOPIC_TITLE,
            bodyHtml: '<p>来自 /my/topics 的历史收藏 V2EX 主题正文。</p>',
            favorited: true,
            loggedInUser: options?.loggedInUser,
          }),
        });
        return;
      }

      await route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: buildV2exTopicHtml({
          topicId,
          title: MOCK_V2EX_TOPIC_TITLE,
          bodyHtml:
            '<p>第一段正文：分享一下本地优先浏览器插件的架构经验。</p><p>第二段附图：<img src="https://i.v2ex.co/topic-diagram-01.png" /></p>',
          subtleHtml: `<div class="subtle">
            <span class="fade">第 1 条附言 · 20 分钟前</span>
            <div class="topic_content"><p>补充说明：所有数据仅存于本地 CollectVault 目录。</p></div>
          </div>`,
          favorited,
          loggedInUser: options?.loggedInUser,
        }),
      });
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: `<!doctype html><html><body>${buildTopBar(options?.loggedInUser)}<div id="Main">V2EX Home</div></body></html>`,
    });
  });

  return tracker;
}
