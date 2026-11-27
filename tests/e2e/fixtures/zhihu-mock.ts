import type { BrowserContext, CDPSession, Route } from '@playwright/test';

export const MOCK_ZHIHU_QUESTION_ID = '600000001';
export const MOCK_ZHIHU_ANSWER_ID = '3200000001';
export const MOCK_ZHIHU_ARTICLE_ID = '710000001';
export const MOCK_ZHIHU_ZVIDEO_ID = '1800000001';

export const MOCK_ZHIHU_ANSWER_TITLE = '如何评价本地优先的跨平台防失效收藏架构？';
export const MOCK_ZHIHU_ARTICLE_TITLE = '知乎专栏深度解析：OPFS 与 FSA 双层离线存储实践';
export const MOCK_ZHIHU_ZVIDEO_TITLE = '知乎视频演示：浏览器内离线媒体归档';

const VALID_PNG_BLUE = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkWPjfDwAEfQHzbpFsPDAAAAAElFTkSuQmCC',
  'base64',
);

const VALID_PNG_GREEN = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

export const MOCK_ZHIHU_MP4_BYTES = Buffer.concat([
  Buffer.from([
    0x00, 0x00, 0x00, 0x18,
    0x66, 0x74, 0x79, 0x70,
    0x69, 0x73, 0x6f, 0x6d,
    0x00, 0x00, 0x02, 0x00,
    0x69, 0x73, 0x6f, 0x6d,
    0x6d, 0x70, 0x34, 0x31,
  ]),
  Buffer.from([
    0x00, 0x00, 0x01, 0x08,
    0x6d, 0x64, 0x61, 0x74,
  ]),
  Buffer.alloc(256, 0x5a),
]);

interface CdpFetchPausedEvent {
  requestId: string;
  request: {
    url: string;
    headers: Record<string, string>;
  };
}

export interface ZhihuMockTracker {
  requestedMediaUrls: string[];
  commentRequests: number;
  dispose: () => Promise<void>;
}

function buildAnswerInitialData(): Record<string, unknown> {
  return {
    initialState: {
      currentUser: 'zhihu-tester',
      entities: {
        users: {
          'zhihu-tester': {
            id: 'zh-me-001',
            urlToken: 'zhihu-tester',
            name: '知乎测试账号',
          },
          'answer-author': {
            id: 'zh-author-01',
            urlToken: 'answer-author',
            name: '知乎架构答主',
            avatarUrl: 'https://pic1.zhimg.com/mock-author-avatar.png',
          },
        },
        questions: {
          [MOCK_ZHIHU_QUESTION_ID]: {
            id: Number(MOCK_ZHIHU_QUESTION_ID),
            title: MOCK_ZHIHU_ANSWER_TITLE,
            topics: [{ id: '1', name: '前端架构' }],
          },
        },
        answers: {
          [MOCK_ZHIHU_ANSWER_ID]: {
            id: Number(MOCK_ZHIHU_ANSWER_ID),
            type: 'answer',
            author: 'answer-author',
            question: { id: Number(MOCK_ZHIHU_QUESTION_ID) },
            createdTime: 1_762_000_000,
            voteupCount: 2048,
            commentCount: 56,
            content:
              '<p>本地优先架构核心在于把硬盘目录作为唯一真相源。</p>' +
              '<figure><img data-original="https://pic1.zhimg.com/mock-answer-img-01.png" src="https://pic1.zhimg.com/mock-answer-thumb-01.png" /></figure>' +
              '<p>第二段补充：支持无网离线阅读与多图归档。</p>' +
              '<figure><img data-actualsrc="https://pic1.zhimg.com/mock-answer-img-02.png" /></figure>',
          },
        },
      },
    },
  };
}

function buildArticleInitialData(): Record<string, unknown> {
  return {
    initialState: {
      entities: {
        articles: {
          [MOCK_ZHIHU_ARTICLE_ID]: {
            id: Number(MOCK_ZHIHU_ARTICLE_ID),
            type: 'article',
            title: MOCK_ZHIHU_ARTICLE_TITLE,
            title_image: 'https://pic1.zhimg.com/mock-article-cover.png',
            created: 1_762_100_000,
            voteup_count: 512,
            author: {
              id: 'zh-author-02',
              url_token: 'column-author',
              name: '专栏技术作者',
            },
            content:
              '<p>知乎专栏离线正文第一段：OPFS 流式暂存避免阻塞。</p>' +
              '<p>知乎专栏离线正文第二段：CollectVault 一键落盘。</p>',
          },
        },
      },
    },
  };
}

function buildZVideoInitialData(): Record<string, unknown> {
  return {
    initialState: {
      entities: {
        zvideos: {
          [MOCK_ZHIHU_ZVIDEO_ID]: {
            id: MOCK_ZHIHU_ZVIDEO_ID,
            type: 'zvideo',
            title: MOCK_ZHIHU_ZVIDEO_TITLE,
            description: '知乎视频离线归档测试描述',
            published_at: 1_762_200_000,
            image_url: 'https://pic1.zhimg.com/mock-zvideo-cover.png',
            author: {
              id: 'zh-author-03',
              url_token: 'zvideo-author',
              name: '知乎视频创作者',
            },
            video: {
              duration: 24,
              playlist: {
                sd: {
                  width: 640,
                  height: 360,
                  format: 'mp4',
                  play_url: 'https://vdn.vzuu.com/mock-zhihu-sd.mp4',
                },
                fhd: {
                  width: 1920,
                  height: 1080,
                  format: 'mp4',
                  play_url: 'https://vdn.vzuu.com/mock-zhihu-fhd.mp4',
                },
              },
            },
          },
        },
      },
    },
  };
}

function buildZhihuHtml(
  title: string,
  initialData: Record<string, unknown>,
  extraScript = '',
): string {
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <title>${title} - 知乎</title>
  </head>
  <body>
    <main>
      <h1>${title}</h1>
      <button id="mock-zhihu-collect" type="button">Native Collect</button>
      <button id="mock-zhihu-uncollect" type="button">Native Uncollect</button>
    </main>
    <script id="js-initialData" type="text/json">${JSON.stringify(initialData)}</script>
    <script>
      ${extraScript}
    </script>
  </body>
</html>`;
}

function buildMockMediaPayload(url: string): {
  contentType: string;
  body: Buffer;
} {
  if (url.includes('vdn.vzuu.com') || url.endsWith('.mp4')) {
    return {
      contentType: 'video/mp4',
      body: MOCK_ZHIHU_MP4_BYTES,
    };
  }
  return {
    contentType: 'image/png',
    body: url.includes('img-02') ? VALID_PNG_GREEN : VALID_PNG_BLUE,
  };
}

async function attachCdpZhihuCdnMock(
  context: BrowserContext,
  tracker: ZhihuMockTracker,
): Promise<CDPSession | null> {
  const browser = context.browser();
  if (!browser) {
    return null;
  }

  const cdp = await browser.newBrowserCDPSession();
  await cdp.send('Fetch.enable', {
    patterns: [
      { urlPattern: 'https://pic1.zhimg.com/*' },
      { urlPattern: 'https://vdn.vzuu.com/*' },
    ],
  });

  cdp.on('Fetch.requestPaused', (event: CdpFetchPausedEvent) => {
    const { requestId, request } = event;
    tracker.requestedMediaUrls.push(request.url);
    const { contentType, body } = buildMockMediaPayload(request.url);
    void cdp
      .send('Fetch.fulfillRequest', {
        requestId,
        responseCode: 200,
        responseHeaders: [
          { name: 'content-type', value: contentType },
          { name: 'content-length', value: String(body.byteLength) },
          { name: 'access-control-allow-origin', value: '*' },
        ],
        body: body.toString('base64'),
      })
      .catch(() => undefined);
  });

  return cdp;
}

export async function installZhihuMockRoutes(
  context: BrowserContext,
): Promise<ZhihuMockTracker> {
  const tracker: ZhihuMockTracker = {
    requestedMediaUrls: [],
    commentRequests: 0,
    dispose: async () => undefined,
  };

  const cdp = await attachCdpZhihuCdnMock(context, tracker);

  const handler = async (route: Route): Promise<void> => {
    const url = new URL(route.request().url());
    const method = route.request().method().toUpperCase();

    if (url.hostname === 'pic1.zhimg.com' || url.hostname === 'vdn.vzuu.com') {
      tracker.requestedMediaUrls.push(url.href);
      const { contentType, body } = buildMockMediaPayload(url.href);
      await route.fulfill({ status: 200, contentType, body });
      return;
    }

    if (/^\/api\/v4\/collections\/\d+\/contents(?:\/\d+)?$/.test(url.pathname)) {
      if (method === 'DELETE') {
        await route.fulfill({ status: 204, body: '' });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true }),
      });
      return;
    }

    if (/^\/api\/v4\/comment_v5\/(answers|articles|zvideos|pins)\/\d+\/root_comment$/.test(url.pathname)) {
      tracker.commentRequests += 1;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          paging: { is_end: true, next: '' },
          data: [
            {
              id: 'zh-cmt-001',
              content: '<p>知乎高赞评论：思路非常清晰！</p>',
              like_count: 168,
              created_time: 1_762_001_000,
              author: {
                member: {
                  id: 'zh-cmt-u1',
                  name: '知乎评论者甲',
                  avatar_url: 'https://pic1.zhimg.com/mock-cmt-avatar-1.png',
                },
              },
            },
          ],
        }),
      });
      return;
    }

    if (
      url.hostname === 'www.zhihu.com' &&
      url.pathname === `/question/${MOCK_ZHIHU_QUESTION_ID}/answer/${MOCK_ZHIHU_ANSWER_ID}`
    ) {
      await route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: buildZhihuHtml(MOCK_ZHIHU_ANSWER_TITLE, buildAnswerInitialData()),
      });
      return;
    }

    if (
      url.hostname === 'zhuanlan.zhihu.com' &&
      url.pathname === `/p/${MOCK_ZHIHU_ARTICLE_ID}`
    ) {
      const script = `
        document.getElementById('mock-zhihu-collect').addEventListener('click', () => {
          void fetch('/api/v4/collections/99901/contents', {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: 'content_id=${MOCK_ZHIHU_ARTICLE_ID}&content_type=article',
          });
        });
        document.getElementById('mock-zhihu-uncollect').addEventListener('click', () => {
          void fetch('/api/v4/collections/99901/contents/${MOCK_ZHIHU_ARTICLE_ID}?content_type=article', {
            method: 'DELETE',
          });
        });
      `;
      await route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: buildZhihuHtml(
          MOCK_ZHIHU_ARTICLE_TITLE,
          buildArticleInitialData(),
          script,
        ),
      });
      return;
    }

    if (
      url.hostname === 'www.zhihu.com' &&
      url.pathname === `/zvideo/${MOCK_ZHIHU_ZVIDEO_ID}`
    ) {
      await route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: buildZhihuHtml(MOCK_ZHIHU_ZVIDEO_TITLE, buildZVideoInitialData()),
      });
      return;
    }

    await route.fulfill({ status: 404, body: 'Not Found' });
  };

  await context.route('https://www.zhihu.com/**', handler);
  await context.route('https://zhuanlan.zhihu.com/**', handler);
  await context.route('https://pic1.zhimg.com/**', handler);
  await context.route('https://vdn.vzuu.com/**', handler);

  tracker.dispose = async () => {
    await context.unroute('https://www.zhihu.com/**', handler).catch(() => undefined);
    await context.unroute('https://zhuanlan.zhihu.com/**', handler).catch(() => undefined);
    await context.unroute('https://pic1.zhimg.com/**', handler).catch(() => undefined);
    await context.unroute('https://vdn.vzuu.com/**', handler).catch(() => undefined);
    if (cdp) {
      await cdp.detach().catch(() => undefined);
    }
  };

  return tracker;
}
