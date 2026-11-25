import type { BrowserContext, CDPSession, Route } from '@playwright/test';

export const MOCK_VIDEO_AWEME_ID = '7490000000000000001';
export const MOCK_GALLERY_AWEME_ID = '7490000000000000002';

export const MOCK_VIDEO_TITLE = 'Playwright 自动化验证视频作品';
export const MOCK_GALLERY_TITLE = 'Playwright 原生收藏图集作品';

/** 合法 1x1 蓝色 PNG（供 createImageBitmap / OffscreenCanvas 生成离线 WebP 缩略图） */
const VALID_PNG_BLUE = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkWPjfDwAEfQHzbpFsPDAAAAAElFTkSuQmCC',
  'base64',
);

/** 合法 1x1 绿色 PNG（图集第二张） */
const VALID_PNG_GREEN = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

/** 含合法 ISO-BMFF `ftyp` 与 `mdat` 盒结构的最小 MP4 二进制负载 */
export const MOCK_MP4_BYTES = Buffer.concat([
  Buffer.from([
    0x00, 0x00, 0x00, 0x18, // box size = 24
    0x66, 0x74, 0x79, 0x70, // 'ftyp'
    0x69, 0x73, 0x6f, 0x6d, // 'isom'
    0x00, 0x00, 0x02, 0x00, // minor_version
    0x69, 0x73, 0x6f, 0x6d, // 'isom'
    0x6d, 0x70, 0x34, 0x31, // 'mp41'
  ]),
  Buffer.from([
    0x00, 0x00, 0x01, 0x08, // box size = 264
    0x6d, 0x64, 0x61, 0x74, // 'mdat'
  ]),
  Buffer.alloc(256, 0x42),
]);

const MOCK_CDN_HOST_RE =
  /^https:\/\/(?:v26-web\.douyinvod\.com|p3-pc-sign\.douyinpic\.com)\//;

function buildMockVideoDetailResponse(awemeId: string): Record<string, unknown> {
  const isDefaultVideo = awemeId === MOCK_VIDEO_AWEME_ID;
  const title = isDefaultVideo
    ? `${MOCK_VIDEO_TITLE} #前端工程 #离线归档`
    : `连刷测试视频_${awemeId} #批量收藏`;
  const coverName = isDefaultVideo
    ? 'mock-cover-video.png'
    : `mock-cover-${awemeId}.png`;
  const videoId = isDefaultVideo ? 'h264_primary' : `h264_${awemeId}`;

  return {
    status_code: 0,
    aweme_detail: {
      aweme_id: awemeId,
      aweme_type: 0,
      desc: title,
      create_time: 1_760_000_000,
      author: {
        uid: '10086001',
        sec_uid: 'MS4wLjABAAAA_mock_author_video',
        nickname: '自动化测试作者A',
        unique_id: 'mock_author_a',
      },
      statistics: {
        digg_count: 1280,
        collect_count: 320,
        comment_count: 45,
        share_count: 19,
      },
      video: {
        width: 1080,
        height: 1920,
        duration: 15_200,
        origin_cover: {
          url_list: [
            'https://p3-pc-sign.douyinpic.com/mock-cover-video.heic',
            `https://p3-pc-sign.douyinpic.com/${coverName}`,
          ],
        },
        bit_rate: [
          {
            gear_name: 'hevc_1080p',
            is_h265: 1,
            bit_rate: 3_200_000,
            play_addr: {
              width: 1080,
              height: 1920,
              url_list: [
                'https://v26-web.douyinvod.com/aweme/v1/playwm/?video_id=hevc_should_not_be_first',
              ],
            },
          },
          {
            gear_name: 'normal_1080p',
            is_h265: 0,
            bit_rate: 1_800_000,
            play_addr: {
              width: 1080,
              height: 1920,
              url_list: [
                `https://v26-web.douyinvod.com/aweme/v1/playwm/?video_id=${videoId}`,
              ],
            },
          },
        ],
      },
    },
  };
}

const MOCK_GALLERY_DETAIL_RESPONSE = {
  status_code: 0,
  aweme_detail: {
    aweme_id: MOCK_GALLERY_AWEME_ID,
    aweme_type: 68,
    desc: `${MOCK_GALLERY_TITLE} #图集灵感`,
    create_time: 1_760_100_000,
    author: {
      uid: '10086002',
      sec_uid: 'MS4wLjABAAAA_mock_author_gallery',
      nickname: '图集测试作者B',
      unique_id: 'mock_author_b',
    },
    images: [
      {
        width: 1200,
        height: 1600,
        download_url_list: [
          'https://p3-pc-sign.douyinpic.com/mock-gallery-01.heic',
          'https://p3-pc-sign.douyinpic.com/mock-gallery-01.png',
        ],
      },
      {
        width: 1200,
        height: 1600,
        download_url_list: [
          'https://p3-pc-sign.douyinpic.com/mock-gallery-02.png',
        ],
      },
    ],
  },
};

function buildMockDouyinHtml(awemeId: string, kind: 'video' | 'note'): string {
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <title>Mock Douyin ${kind} ${awemeId}</title>
  </head>
  <body>
    <main id="root">
      <div data-e2e="feed-active-video" data-e2e-vid="${awemeId}" style="width: 360px; height: 640px;">
        <video muted playsinline style="width: 360px; height: 640px;"></video>
        <button id="mock-load-detail" type="button">Load Detail</button>
        <button id="mock-native-collect" type="button">Native Collect</button>
      </div>
    </main>
    <script>
      window.__mockDetailLoaded = false;
      window.__mockLoadDetail = async () => {
        const res = await fetch('/aweme/v1/web/aweme/detail/?aweme_id=${awemeId}');
        const json = await res.json();
        window.__mockDetailLoaded = Boolean(json && json.aweme_detail);
        return json;
      };
      window.__mockTriggerNativeCollect = async () => {
        const res = await fetch('/aweme/v1/web/aweme/collect/?aweme_id=${awemeId}&action=1', {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: 'aweme_id=${awemeId}&action=1',
        });
        return res.json();
      };
      document.getElementById('mock-load-detail').addEventListener('click', () => {
        void window.__mockLoadDetail();
      });
      document.getElementById('mock-native-collect').addEventListener('click', () => {
        void window.__mockTriggerNativeCollect();
      });
    </script>
  </body>
</html>`;
}

function buildMockMediaPayload(url: string): {
  contentType: string;
  body: Buffer;
} {
  if (url.includes('douyinvod.com')) {
    return {
      contentType: 'video/mp4',
      body: MOCK_MP4_BYTES,
    };
  }
  return {
    contentType: 'image/png',
    body: url.includes('mock-gallery-02') ? VALID_PNG_GREEN : VALID_PNG_BLUE,
  };
}

interface CdpTargetInfo {
  targetId: string;
  type: string;
  url: string;
}

interface CdpAttachedToTargetEvent {
  sessionId: string;
  targetInfo: CdpTargetInfo;
}

interface CdpFetchPausedEvent {
  requestId: string;
  request: {
    url: string;
    headers: Record<string, string>;
  };
}

export interface DouyinMockOptions {
  /** 可选钩子：在返回 CDN 媒体二进制前挂起等待，用于验证并发队列与图标进度状态 */
  beforeFulfillMedia?: (url: string) => Promise<void>;
}

/**
 * 浏览器级 CDP `Fetch` 拦截器：
 * Playwright 的 `context.route()` 无法自动挂接到 Chrome MV3 的 Offscreen Document target，
 * 因此通过浏览器级 CDP `Fetch.enable` 拦截 Offscreen Document 发出的 Mock CDN 下载请求。
 */
async function attachBrowserCdpCdnMock(
  context: BrowserContext,
  tracker: DouyinMockTracker,
  options?: DouyinMockOptions,
): Promise<CDPSession | null> {
  const browser = context.browser();
  if (!browser) {
    return null;
  }

  const cdp = await browser.newBrowserCDPSession();

  await cdp.send('Fetch.enable', {
    patterns: [
      { urlPattern: 'https://v26-web.douyinvod.com/*' },
      { urlPattern: 'https://p3-pc-sign.douyinpic.com/*' },
    ],
  });

  cdp.on('Fetch.requestPaused', (event: CdpFetchPausedEvent) => {
    const { requestId, request } = event;
    tracker.requestedMediaUrls.push(request.url);

    void (async () => {
      if (options?.beforeFulfillMedia) {
        await options.beforeFulfillMedia(request.url);
      }
      const { contentType, body } = buildMockMediaPayload(request.url);
      await cdp.send('Fetch.fulfillRequest', {
        requestId,
        responseCode: 200,
        responseHeaders: [
          { name: 'content-type', value: contentType },
          { name: 'content-length', value: String(body.byteLength) },
          { name: 'access-control-allow-origin', value: '*' },
        ],
        body: body.toString('base64'),
      });
    })().catch(() => undefined);
  });

  // 兜底：若未来 Chromium 将 Offscreen 网络层隔离到独立 Target，则同时监听 Target 附着
  cdp.on('Target.attachedToTarget', (_event: CdpAttachedToTargetEvent) => {
    // 保留钩子以便扩展调试
  });

  return cdp;
}

export interface DouyinMockTracker {
  requestedMediaUrls: string[];
  dispose: () => Promise<void>;
}

/**
 * 在 Playwright BrowserContext 上注册确定性的抖音页面、API 与媒体 CDN Mock 路由。
 * 同时覆盖页面主文档（`context.route`）与 Offscreen Document（浏览器级 CDP `Fetch`）。
 */
export async function installDouyinMockRoutes(
  context: BrowserContext,
  options?: DouyinMockOptions,
): Promise<DouyinMockTracker> {
  const tracker: DouyinMockTracker = {
    requestedMediaUrls: [],
    dispose: async () => undefined,
  };

  const cdpSession = await attachBrowserCdpCdnMock(context, tracker, options);
  tracker.dispose = async () => {
    if (cdpSession) {
      await cdpSession.detach().catch(() => undefined);
    }
  };

  await context.route('https://www.douyin.com/**', async (route: Route) => {
    const url = new URL(route.request().url());

    if (url.pathname.startsWith('/aweme/v1/web/aweme/detail')) {
      const awemeId = url.searchParams.get('aweme_id') ?? MOCK_VIDEO_AWEME_ID;
      const body =
        awemeId === MOCK_GALLERY_AWEME_ID
          ? MOCK_GALLERY_DETAIL_RESPONSE
          : buildMockVideoDetailResponse(awemeId);
      await route.fulfill({
        status: 200,
        contentType: 'application/json; charset=utf-8',
        body: JSON.stringify(body),
      });
      return;
    }

    if (url.pathname.startsWith('/aweme/v1/web/aweme/collect')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json; charset=utf-8',
        body: JSON.stringify({ status_code: 0 }),
      });
      return;
    }

    if (url.pathname.startsWith(`/note/${MOCK_GALLERY_AWEME_ID}`)) {
      await route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: buildMockDouyinHtml(MOCK_GALLERY_AWEME_ID, 'note'),
      });
      return;
    }

    if (url.pathname.startsWith(`/video/${MOCK_VIDEO_AWEME_ID}`)) {
      await route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: buildMockDouyinHtml(MOCK_VIDEO_AWEME_ID, 'video'),
      });
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: buildMockDouyinHtml(MOCK_VIDEO_AWEME_ID, 'video'),
    });
  });

  await context.route(MOCK_CDN_HOST_RE, async (route: Route) => {
    const url = route.request().url();
    tracker.requestedMediaUrls.push(url);
    if (options?.beforeFulfillMedia) {
      await options.beforeFulfillMedia(url);
    }
    const { contentType, body } = buildMockMediaPayload(url);
    await route.fulfill({
      status: 200,
      headers: {
        'content-type': contentType,
        'content-length': String(body.byteLength),
        'access-control-allow-origin': '*',
      },
      body,
    });
  });

  return tracker;
}
