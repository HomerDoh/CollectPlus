import type { BrowserContext, CDPSession, Route } from '@playwright/test';

export const MOCK_XHS_VIDEO_NOTE_ID = '6701a0000000000000000001';
export const MOCK_XHS_GALLERY_NOTE_ID = '6701a0000000000000000002';

export const MOCK_XHS_VIDEO_TITLE = '小红书离线视频笔记验证';
export const MOCK_XHS_GALLERY_TITLE = '小红书多图穿搭灵感笔记';

const VALID_PNG_RED = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const VALID_PNG_GREEN = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

export const MOCK_XHS_MP4_BYTES = Buffer.concat([
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
  Buffer.alloc(256, 0x58),
]);

interface CdpFetchPausedEvent {
  requestId: string;
  request: {
    url: string;
    headers: Record<string, string>;
  };
}

export interface XhsMockTracker {
  requestedMediaUrls: string[];
  collectListRequests: number;
  commentListRequests: number;
  dispose: () => Promise<void>;
}

export interface XhsMockOptions {
  loggedInUser?: { userId: string; nickname: string } | null;
  simulateCollectListRiskControl?: boolean;
}

export function buildMockXhsVideoNote(
  noteId = MOCK_XHS_VIDEO_NOTE_ID,
): Record<string, unknown> {
  return {
    note_id: noteId,
    type: 'video',
    title: MOCK_XHS_VIDEO_TITLE,
    desc: `${MOCK_XHS_VIDEO_TITLE} 详细教程 #效率工具[话题]# #离线收藏[话题]#`,
    time: 1_761_000_000_000,
    ip_location: '上海',
    user: {
      user_id: 'xhs-user-001',
      nickname: '小红书视频博主A',
      avatar: 'https://sns-avatar-qc.xhscdn.com/avatar/mock-xhs-a.png',
    },
    tag_list: [{ id: 't1', name: '效率工具' }],
    interact_info: {
      liked_count: '1.2万',
      collected_count: '3400',
      comment_count: '88',
      share_count: '52',
    },
    cover: {
      url_default: 'https://sns-webpic-qc.xhscdn.com/mock-xhs-video-cover.png',
    },
    video: {
      capa: { duration: 18 },
      media: {
        video: { width: 1080, height: 1920, duration: 18_000 },
        stream: {
          h265: [
            {
              width: 1080,
              height: 1920,
              video_bitrate: 3_000_000,
              master_url: 'https://sns-video-bd.xhscdn.com/mock-hevc.mp4',
            },
          ],
          h264: [
            {
              width: 1080,
              height: 1920,
              video_bitrate: 1_800_000,
              master_url: `https://sns-video-bd.xhscdn.com/mock-h264-${noteId}.mp4`,
              backup_urls: [
                `https://sns-video-bd.xhscdn.com/mock-h264-backup-${noteId}.mp4`,
              ],
            },
          ],
        },
      },
    },
  };
}

export function buildMockXhsGalleryNote(
  noteId = MOCK_XHS_GALLERY_NOTE_ID,
): Record<string, unknown> {
  return {
    note_id: noteId,
    type: 'normal',
    title: MOCK_XHS_GALLERY_TITLE,
    desc: `${MOCK_XHS_GALLERY_TITLE} 附两张原图 #穿搭灵感[话题]#`,
    time: 1_761_100_000_000,
    user: {
      user_id: 'xhs-user-002',
      nickname: '小红书图文博主B',
      avatar: 'https://sns-avatar-qc.xhscdn.com/avatar/mock-xhs-b.png',
    },
    image_list: [
      {
        width: 1200,
        height: 1600,
        url_default: 'https://sns-webpic-qc.xhscdn.com/mock-xhs-img-01.png',
        info_list: [
          {
            image_scene: 'WB_DFT',
            url: 'https://sns-webpic-qc.xhscdn.com/mock-xhs-img-01.png',
          },
        ],
      },
      {
        width: 1200,
        height: 1600,
        url_default: 'https://sns-webpic-qc.xhscdn.com/mock-xhs-img-02.png',
      },
    ],
  };
}

function buildMockXhsHtml(
  noteId: string,
  initialNote: Record<string, unknown>,
  loggedInUser?: { userId: string; nickname: string } | null,
): string {
  const initialState = {
    note: {
      noteDetailMap: {
        [noteId]: { note: initialNote },
      },
    },
    ...(loggedInUser
      ? {
          user: {
            userInfo: {
              userId: loggedInUser.userId,
              nickname: loggedInUser.nickname,
              guest: false,
            },
          },
        }
      : {}),
  };

  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <title>Mock Xiaohongshu ${noteId}</title>
  </head>
  <body>
    <main id="noteContainer" data-note-id="${noteId}">
      <h1 id="detail-title">${String(initialNote.title ?? '')}</h1>
      <div id="detail-desc">${String(initialNote.desc ?? '')}</div>
      <button id="mock-xhs-collect" type="button">Collect Note</button>
      <button id="mock-xhs-uncollect" type="button">Uncollect Note</button>
      <button id="mock-xhs-passive-list" type="button">Load Collect Page</button>
    </main>
    <script>
      window.__INITIAL_STATE__ = ${JSON.stringify(initialState)};
      window.__mockXhsCollect = async () => {
        const res = await fetch('/api/sns/web/v1/note/collect', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ note_id: '${noteId}' }),
        });
        return res.json();
      };
      window.__mockXhsUncollect = async () => {
        const res = await fetch('/api/sns/web/v1/note/uncollect', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ note_ids: '${noteId}' }),
        });
        return res.json();
      };
      window.__mockXhsPassiveCollectList = async () => {
        const res = await fetch('/api/sns/web/v2/note/collect/page?num=30&cursor=&user_id=xhs-me-01');
        return res.json();
      };
      document.getElementById('mock-xhs-collect').addEventListener('click', () => {
        void window.__mockXhsCollect();
      });
      document.getElementById('mock-xhs-uncollect').addEventListener('click', () => {
        void window.__mockXhsUncollect();
      });
      document.getElementById('mock-xhs-passive-list').addEventListener('click', () => {
        void window.__mockXhsPassiveCollectList();
      });
    </script>
  </body>
</html>`;
}

function buildMockMediaPayload(url: string): {
  contentType: string;
  body: Buffer;
} {
  if (url.includes('sns-video-bd.xhscdn.com') || url.endsWith('.mp4')) {
    return {
      contentType: 'video/mp4',
      body: MOCK_XHS_MP4_BYTES,
    };
  }
  return {
    contentType: 'image/png',
    body: url.includes('img-02') ? VALID_PNG_GREEN : VALID_PNG_RED,
  };
}

async function attachCdpXhsCdnMock(
  context: BrowserContext,
  tracker: XhsMockTracker,
): Promise<CDPSession | null> {
  const browser = context.browser();
  if (!browser) {
    return null;
  }

  const cdp = await browser.newBrowserCDPSession();
  await cdp.send('Fetch.enable', {
    patterns: [
      { urlPattern: 'https://sns-video-bd.xhscdn.com/*' },
      { urlPattern: 'https://sns-webpic-qc.xhscdn.com/*' },
      { urlPattern: 'https://sns-avatar-qc.xhscdn.com/*' },
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

export async function installXiaohongshuMockRoutes(
  context: BrowserContext,
  options?: XhsMockOptions,
): Promise<XhsMockTracker> {
  const tracker: XhsMockTracker = {
    requestedMediaUrls: [],
    collectListRequests: 0,
    commentListRequests: 0,
    dispose: async () => undefined,
  };

  const cdp = await attachCdpXhsCdnMock(context, tracker);

  const handler = async (route: Route): Promise<void> => {
    const url = new URL(route.request().url());

    if (
      url.hostname === 'sns-video-bd.xhscdn.com' ||
      url.hostname === 'sns-webpic-qc.xhscdn.com' ||
      url.hostname === 'sns-avatar-qc.xhscdn.com'
    ) {
      tracker.requestedMediaUrls.push(url.href);
      const { contentType, body } = buildMockMediaPayload(url.href);
      await route.fulfill({
        status: 200,
        contentType,
        body,
      });
      return;
    }

    if (url.pathname === '/api/sns/web/v1/note/collect') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ code: 0, success: true, data: {} }),
      });
      return;
    }

    if (url.pathname === '/api/sns/web/v1/note/uncollect') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ code: 0, success: true, data: {} }),
      });
      return;
    }

    if (url.pathname === '/api/sns/web/v2/comment/page') {
      tracker.commentListRequests += 1;
      const noteId = url.searchParams.get('note_id') ?? MOCK_XHS_VIDEO_NOTE_ID;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          code: 0,
          success: true,
          data: {
            has_more: false,
            cursor: '',
            comments: [
              {
                id: `${noteId}-c1`,
                content: '小红书热评第一条：太实用了！',
                like_count: '238',
                create_time: 1_761_000_500_000,
                user_info: {
                  user_id: 'xhs-cmt-u1',
                  nickname: '小红薯评论员甲',
                  image: 'https://sns-avatar-qc.xhscdn.com/avatar/cmt-1.png',
                },
              },
              {
                id: `${noteId}-c2`,
                content: '小红书热评第二条：已离线归档保存',
                like_count: '66',
                create_time: 1_761_000_600_000,
                user_info: {
                  user_id: 'xhs-cmt-u2',
                  nickname: '小红薯评论员乙',
                  image: 'https://sns-avatar-qc.xhscdn.com/avatar/cmt-1.png',
                },
              },
            ],
          },
        }),
      });
      return;
    }

    if (url.pathname === '/api/sns/web/v2/note/collect/page') {
      tracker.collectListRequests += 1;
      if (options?.simulateCollectListRiskControl && tracker.collectListRequests === 1) {
        await route.fulfill({
          status: 461,
          contentType: 'application/json',
          body: JSON.stringify({ code: -100, success: false, msg: 'verify needed' }),
        });
        return;
      }

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          code: 0,
          success: true,
          data: {
            has_more: false,
            cursor: '',
            notes: [buildMockXhsGalleryNote('6701a0000000000000000099')],
          },
        }),
      });
      return;
    }

    if (url.pathname.startsWith('/explore/')) {
      const noteId = url.pathname.split('/')[2] ?? MOCK_XHS_VIDEO_NOTE_ID;
      const initialNote =
        noteId === MOCK_XHS_GALLERY_NOTE_ID
          ? buildMockXhsGalleryNote(noteId)
          : buildMockXhsVideoNote(noteId);
      await route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: buildMockXhsHtml(noteId, initialNote, options?.loggedInUser),
      });
      return;
    }

    await route.fulfill({ status: 404, body: 'Not Found' });
  };

  await context.route('https://www.xiaohongshu.com/**', handler);
  await context.route('https://sns-video-bd.xhscdn.com/**', handler);
  await context.route('https://sns-webpic-qc.xhscdn.com/**', handler);
  await context.route('https://sns-avatar-qc.xhscdn.com/**', handler);

  tracker.dispose = async () => {
    await context.unroute('https://www.xiaohongshu.com/**', handler).catch(() => undefined);
    await context.unroute('https://sns-video-bd.xhscdn.com/**', handler).catch(() => undefined);
    await context.unroute('https://sns-webpic-qc.xhscdn.com/**', handler).catch(() => undefined);
    await context.unroute('https://sns-avatar-qc.xhscdn.com/**', handler).catch(() => undefined);
    if (cdp) {
      await cdp.detach().catch(() => undefined);
    }
  };

  return tracker;
}
