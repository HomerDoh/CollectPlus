import type { BrowserContext, CDPSession, Route } from '@playwright/test';
import {
  BufferTarget,
  EncodedAudioPacketSource,
  EncodedPacket,
  EncodedVideoPacketSource,
  Mp4OutputFormat,
  Output,
} from 'mediabunny';

export const MOCK_BILI_BVID = 'BV1CollectPlusE2E';
export const MOCK_BILI_AID = '113000000001';
export const MOCK_BILI_CID = '226000000001';
export const MOCK_BILI_TITLE = 'Playwright B站 DASH 无损混流验证视频';

export const MOCK_BILI_FAV_BVID_2 = 'BV1CollectSync002';
export const MOCK_BILI_FAV_AID_2 = '113000000002';
export const MOCK_BILI_FAV_CID_2 = '226000000002';
export const MOCK_BILI_FAV_TITLE_2 = 'B站全量同步历史收藏视频';

/** 合法 1x1 粉色 PNG（B站封面与评论头像） */
const VALID_PNG_PINK = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/** 最小合法 AVC/H.264 AVCDecoderConfigurationRecord（Baseline 16x16）与单帧负载 */
const MINIMAL_AVCC_DESCRIPTION = new Uint8Array([
  0x01, 0x42, 0xc0, 0x0a, 0xff, 0xe1, 0x00, 0x0a, 0x67, 0x42, 0xc0, 0x0a, 0xd9,
  0x00, 0x80, 0x04, 0x00, 0x00, 0x01, 0x00, 0x04, 0x68, 0xce, 0x3c, 0x80,
]);
const MINIMAL_AVC_KEYFRAME = new Uint8Array([
  0x00, 0x00, 0x00, 0x06, 0x65, 0x88, 0x84, 0x00, 0x10, 0xff,
]);

/** 最小合法 AAC-LC AudioSpecificConfig（44.1kHz stereo）与静音帧 */
const MINIMAL_AAC_DESCRIPTION = new Uint8Array([0x12, 0x10]);
const MINIMAL_AAC_FRAME = new Uint8Array([0x21, 0x10, 0x04, 0x60, 0x8c, 0x1c]);

let cachedDashStreamsPromise: Promise<{
  videoMp4: Buffer;
  audioMp4: Buffer;
}> | null = null;

async function buildValidDashTestStreams(): Promise<{
  videoMp4: Buffer;
  audioMp4: Buffer;
}> {
  if (cachedDashStreamsPromise) {
    return cachedDashStreamsPromise;
  }

  cachedDashStreamsPromise = (async () => {
    const videoTarget = new BufferTarget();
    const videoOutput = new Output({
      format: new Mp4OutputFormat({ fastStart: 'in-memory' }),
      target: videoTarget,
    });
    const videoSource = new EncodedVideoPacketSource('avc');
    videoOutput.addVideoTrack(videoSource);
    await videoOutput.start();
    await videoSource.add(
      new EncodedPacket(MINIMAL_AVC_KEYFRAME, 'key', 0, 0.5),
      {
        decoderConfig: {
          codec: 'avc1.42c00a',
          codedWidth: 16,
          codedHeight: 16,
          description: MINIMAL_AVCC_DESCRIPTION,
        },
      },
    );
    videoSource.close();
    await videoOutput.finalize();

    const audioTarget = new BufferTarget();
    const audioOutput = new Output({
      format: new Mp4OutputFormat({ fastStart: 'in-memory' }),
      target: audioTarget,
    });
    const audioSource = new EncodedAudioPacketSource('aac');
    audioOutput.addAudioTrack(audioSource);
    await audioOutput.start();
    await audioSource.add(
      new EncodedPacket(MINIMAL_AAC_FRAME, 'key', 0, 0.5),
      {
        decoderConfig: {
          codec: 'mp4a.40.2',
          numberOfChannels: 2,
          sampleRate: 44_100,
          description: MINIMAL_AAC_DESCRIPTION,
        },
      },
    );
    audioSource.close();
    await audioOutput.finalize();

    if (!videoTarget.buffer || !audioTarget.buffer) {
      throw new Error('Failed to synthesize valid DASH MP4 fixtures.');
    }

    return {
      videoMp4: Buffer.from(videoTarget.buffer),
      audioMp4: Buffer.from(audioTarget.buffer),
    };
  })();

  return cachedDashStreamsPromise;
}

function buildMockBiliVideoData(
  bvid: string,
  aid: string,
  cid: string,
  title: string,
): Record<string, unknown> {
  return {
    bvid,
    aid: Number(aid),
    cid: Number(cid),
    title,
    desc: `${title} 的简介说明`,
    pic: `https://i0.hdslb.com/bfs/archive/${bvid}-cover.png`,
    pubdate: 1_760_200_000,
    duration: 125,
    tname: '科技数码',
    owner: {
      mid: 998877,
      name: 'B站测试UP主',
      face: 'https://i0.hdslb.com/bfs/face/up-avatar.png',
    },
    stat: {
      view: 54_321,
      danmaku: 320,
      reply: 88,
      favorite: 1_024,
      coin: 512,
      share: 64,
      like: 2_048,
    },
    pages: [{ cid: Number(cid), page: 1, part: title, duration: 125 }],
  };
}

function buildMockPlayinfoData(bvid: string): Record<string, unknown> {
  return {
    dash: {
      duration: 125,
      video: [
        {
          id: 80,
          codecid: 12,
          codecs: 'hev1.1.6.L120.90',
          width: 1920,
          height: 1080,
          bandwidth: 3_000_000,
          baseUrl: `https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/${bvid}-hevc-1080.m4s`,
        },
        {
          id: 80,
          codecid: 7,
          codecs: 'avc1.640032',
          width: 1920,
          height: 1080,
          bandwidth: 2_000_000,
          baseUrl: `https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/${bvid}-avc-1080.m4s`,
          backupUrl: [
            `https://upos-sz-mirrorali.bilivideo.com/upgcxcode/${bvid}-avc-1080-bak.m4s`,
          ],
        },
      ],
      audio: [
        {
          id: 30280,
          codecs: 'mp4a.40.2',
          bandwidth: 192_000,
          baseUrl: `https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/${bvid}-aac-audio.m4s`,
          backupUrl: [
            `https://upos-sz-mirrorali.bilivideo.com/upgcxcode/${bvid}-aac-audio-bak.m4s`,
          ],
        },
      ],
    },
  };
}

function buildMockBiliVideoHtml(
  bvid: string,
  aid: string,
  cid: string,
  title: string,
): string {
  const initialState = {
    bvid,
    aid: Number(aid),
    p: 1,
    videoData: buildMockBiliVideoData(bvid, aid, cid, title),
    tags: [{ tag_name: '离线归档' }, { tag_name: 'DASH混流' }],
  };
  const playinfo = {
    code: 0,
    data: buildMockPlayinfoData(bvid),
  };

  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <title>${title} - 哔哩哔哩</title>
    <script>
      window.__INITIAL_STATE__ = ${JSON.stringify(initialState)};
      window.__playinfo__ = ${JSON.stringify(playinfo)};
    </script>
  </head>
  <body>
    <main id="app">
      <h1>${title}</h1>
      <button id="mock-bili-fav" type="button">原生收藏</button>
      <button id="mock-bili-unfav" type="button">原生取消收藏</button>
    </main>
    <script>
      document.getElementById('mock-bili-fav').addEventListener('click', () => {
        void fetch('https://api.bilibili.com/x/v3/fav/resource/deal', {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: 'rid=${aid}&type=2&add_media_ids=88001&del_media_ids=&csrf=mock_csrf'
        });
      });
      document.getElementById('mock-bili-unfav').addEventListener('click', () => {
        void fetch('https://api.bilibili.com/x/v3/fav/resource/deal', {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: 'rid=${aid}&type=2&add_media_ids=&del_media_ids=88001&csrf=mock_csrf'
        });
      });
    </script>
  </body>
</html>`;
}

interface CdpFetchPausedEvent {
  requestId: string;
  request: {
    url: string;
    headers: Record<string, string>;
  };
}

function sliceForRangeHeader(
  body: Buffer,
  headers: Record<string, string>,
): {
  responseCode: number;
  slice: Buffer;
  extraHeaders: Array<{ name: string; value: string }>;
} {
  const rangeKey = Object.keys(headers).find(
    (k) => k.toLowerCase() === 'range',
  );
  const rangeVal = rangeKey ? headers[rangeKey] : undefined;
  const total = body.byteLength;
  if (!rangeVal) {
    return {
      responseCode: 200,
      slice: body,
      extraHeaders: [{ name: 'accept-ranges', value: 'bytes' }],
    };
  }
  const match = /bytes=(\d+)-(\d*)/i.exec(rangeVal);
  if (!match?.[1]) {
    return {
      responseCode: 200,
      slice: body,
      extraHeaders: [{ name: 'accept-ranges', value: 'bytes' }],
    };
  }
  const start = Math.max(0, Number(match[1]));
  const end = match[2] ? Math.min(total - 1, Number(match[2])) : total - 1;
  const slice = body.subarray(start, end + 1);
  return {
    responseCode: 206,
    slice,
    extraHeaders: [
      { name: 'accept-ranges', value: 'bytes' },
      { name: 'content-range', value: `bytes ${start}-${end}/${total}` },
    ],
  };
}

export interface BilibiliMockOptions {
  loggedInUser?: { mid: number; uname: string } | null;
  rateLimitFavList?: boolean;
}

export interface BilibiliMockTracker {
  requestedMediaUrls: string[];
  favListRequests: number;
  replyRequests: number;
  dispose: () => Promise<void>;
}

export async function installBilibiliMockRoutes(
  context: BrowserContext,
  options?: BilibiliMockOptions,
): Promise<BilibiliMockTracker> {
  const tracker: BilibiliMockTracker = {
    requestedMediaUrls: [],
    favListRequests: 0,
    replyRequests: 0,
    dispose: async () => undefined,
  };

  const dashStreams = await buildValidDashTestStreams();
  const browser = context.browser();
  let cdpSession: CDPSession | null = null;

  if (browser) {
    cdpSession = await browser.newBrowserCDPSession();
    await cdpSession.send('Fetch.enable', {
      patterns: [
        { urlPattern: 'https://*.bilivideo.com/*' },
        { urlPattern: 'https://*.hdslb.com/*' },
      ],
    });

    cdpSession.on('Fetch.requestPaused', (event: CdpFetchPausedEvent) => {
      const { requestId, request } = event;
      tracker.requestedMediaUrls.push(request.url);

      void (async () => {
        const isImage = request.url.includes('hdslb.com');
        const fullBody = isImage
          ? VALID_PNG_PINK
          : request.url.includes('-aac-audio')
            ? dashStreams.audioMp4
            : dashStreams.videoMp4;
        const contentType = isImage
          ? 'image/png'
          : request.url.includes('-aac-audio')
            ? 'audio/mp4'
            : 'video/mp4';

        const { responseCode, slice, extraHeaders } = isImage
          ? { responseCode: 200, slice: fullBody, extraHeaders: [] }
          : sliceForRangeHeader(fullBody, request.headers);

        await cdpSession!.send('Fetch.fulfillRequest', {
          requestId,
          responseCode,
          responseHeaders: [
            { name: 'content-type', value: contentType },
            { name: 'content-length', value: String(slice.byteLength) },
            { name: 'access-control-allow-origin', value: '*' },
            ...extraHeaders,
          ],
          body: slice.toString('base64'),
        });
      })().catch(() => undefined);
    });
  }

  tracker.dispose = async () => {
    if (cdpSession) {
      await cdpSession.detach().catch(() => undefined);
    }
  };

  await context.route('https://www.bilibili.com/**', async (route: Route) => {
    const url = new URL(route.request().url());
    const bvMatch = /^\/video\/(BV[0-9A-Za-z]+)/i.exec(url.pathname);
    if (bvMatch?.[1]) {
      const bvid = bvMatch[1];
      const isSecond = bvid === MOCK_BILI_FAV_BVID_2;
      const html = buildMockBiliVideoHtml(
        bvid,
        isSecond ? MOCK_BILI_FAV_AID_2 : MOCK_BILI_AID,
        isSecond ? MOCK_BILI_FAV_CID_2 : MOCK_BILI_CID,
        isSecond ? MOCK_BILI_FAV_TITLE_2 : MOCK_BILI_TITLE,
      );
      await route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: html,
      });
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: '<!doctype html><html><body>Bilibili Mock Home</body></html>',
    });
  });

  await context.route('https://api.bilibili.com/**', async (route: Route) => {
    const url = new URL(route.request().url());
    const corsHeaders = {
      'access-control-allow-origin': 'https://www.bilibili.com',
      'access-control-allow-credentials': 'true',
      'content-type': 'application/json; charset=utf-8',
    };

    if (url.pathname.includes('/x/web-interface/nav')) {
      const user = options?.loggedInUser;
      await route.fulfill({
        status: 200,
        headers: corsHeaders,
        body: JSON.stringify({
          code: 0,
          data: user
            ? { isLogin: true, mid: user.mid, uname: user.uname }
            : { isLogin: false },
        }),
      });
      return;
    }

    if (url.pathname.includes('/x/v3/fav/resource/deal')) {
      await route.fulfill({
        status: 200,
        headers: corsHeaders,
        body: JSON.stringify({ code: 0, message: '0', data: { prompt: true } }),
      });
      return;
    }

    if (url.pathname.includes('/x/v2/reply')) {
      tracker.replyRequests += 1;
      await route.fulfill({
        status: 200,
        headers: corsHeaders,
        body: JSON.stringify({
          code: 0,
          data: {
            page: { num: 1, size: 20, count: 2 },
            replies: [
              {
                rpid_str: '900001',
                like: 520,
                ctime: 1_760_200_100,
                member: {
                  mid: '40001',
                  uname: 'B站课代表',
                  avatar: 'https://i0.hdslb.com/bfs/face/comment-1.png',
                },
                content: { message: 'DASH 音视频混流太稳了，直接收藏！' },
              },
              {
                rpid_str: '900002',
                like: 66,
                ctime: 1_760_200_200,
                member: {
                  mid: '40002',
                  uname: '路人观众',
                  avatar: 'https://i0.hdslb.com/bfs/face/comment-2.png',
                },
                content: { message: '感谢UP主分享，已三连。' },
              },
            ],
          },
        }),
      });
      return;
    }

    if (url.pathname.includes('/x/v3/fav/folder/created/list-all')) {
      if (options?.rateLimitFavList) {
        await route.fulfill({
          status: 412,
          headers: corsHeaders,
          body: JSON.stringify({ code: -412, message: 'rate limited' }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        headers: corsHeaders,
        body: JSON.stringify({
          code: 0,
          data: {
            count: 1,
            list: [{ id: 88001, title: '默认收藏夹', media_count: 1 }],
          },
        }),
      });
      return;
    }

    if (url.pathname.includes('/x/v3/fav/resource/list')) {
      tracker.favListRequests += 1;
      await route.fulfill({
        status: 200,
        headers: corsHeaders,
        body: JSON.stringify({
          code: 0,
          data: {
            has_more: false,
            medias: [
              {
                id: Number(MOCK_BILI_FAV_AID_2),
                type: 2,
                attr: 0,
                bvid: MOCK_BILI_FAV_BVID_2,
                title: MOCK_BILI_FAV_TITLE_2,
                intro: '来自B站默认收藏夹的历史视频',
                cover: `https://i0.hdslb.com/bfs/archive/${MOCK_BILI_FAV_BVID_2}-cover.png`,
                pubtime: 1_760_150_000,
                duration: 90,
                upper: {
                  mid: 998877,
                  name: 'B站测试UP主',
                  face: 'https://i0.hdslb.com/bfs/face/up-avatar.png',
                },
                ugc: { first_cid: Number(MOCK_BILI_FAV_CID_2) },
              },
            ],
          },
        }),
      });
      return;
    }

    if (url.pathname.includes('/x/player/playurl')) {
      const bvid = url.searchParams.get('bvid') ?? MOCK_BILI_BVID;
      await route.fulfill({
        status: 200,
        headers: corsHeaders,
        body: JSON.stringify({
          code: 0,
          data: buildMockPlayinfoData(bvid),
        }),
      });
      return;
    }

    if (url.pathname.includes('/x/web-interface/view')) {
      const bvid = url.searchParams.get('bvid') ?? MOCK_BILI_BVID;
      const isSecond = bvid === MOCK_BILI_FAV_BVID_2;
      await route.fulfill({
        status: 200,
        headers: corsHeaders,
        body: JSON.stringify({
          code: 0,
          data: buildMockBiliVideoData(
            bvid,
            isSecond ? MOCK_BILI_FAV_AID_2 : MOCK_BILI_AID,
            isSecond ? MOCK_BILI_FAV_CID_2 : MOCK_BILI_CID,
            isSecond ? MOCK_BILI_FAV_TITLE_2 : MOCK_BILI_TITLE,
          ),
        }),
      });
      return;
    }

    await route.fulfill({
      status: 200,
      headers: corsHeaders,
      body: JSON.stringify({ code: 0, data: {} }),
    });
  });

  return tracker;
}
