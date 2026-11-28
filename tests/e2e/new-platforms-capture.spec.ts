import type { BrowserContext, CDPSession, Route } from '@playwright/test';
import {
  BufferTarget,
  EncodedAudioPacketSource,
  EncodedPacket,
  EncodedVideoPacketSource,
  Mp4OutputFormat,
  Output,
} from 'mediabunny';
import { expect, test } from './fixtures/extension.ts';

const VALID_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const MINIMAL_AVCC_DESCRIPTION = new Uint8Array([
  0x01, 0x42, 0xc0, 0x0a, 0xff, 0xe1, 0x00, 0x0a, 0x67, 0x42, 0xc0, 0x0a, 0xd9,
  0x00, 0x80, 0x04, 0x00, 0x00, 0x01, 0x00, 0x04, 0x68, 0xce, 0x3c, 0x80,
]);
const MINIMAL_AVC_KEYFRAME = new Uint8Array([
  0x00, 0x00, 0x00, 0x06, 0x65, 0x88, 0x84, 0x00, 0x10, 0xff,
]);
const MINIMAL_AAC_DESCRIPTION = new Uint8Array([0x12, 0x10]);
const MINIMAL_AAC_FRAME = new Uint8Array([0x21, 0x10, 0x04, 0x60, 0x8c, 0x1c]);

let cachedMediaPromise: Promise<{
  videoMp4: Buffer;
  audioMp4: Buffer;
}> | null = null;

async function buildTestMp4Buffers(): Promise<{
  videoMp4: Buffer;
  audioMp4: Buffer;
}> {
  if (cachedMediaPromise) {
    return cachedMediaPromise;
  }
  cachedMediaPromise = (async () => {
    const vTarget = new BufferTarget();
    const vOutput = new Output({
      format: new Mp4OutputFormat({ fastStart: 'in-memory' }),
      target: vTarget,
    });
    const vSource = new EncodedVideoPacketSource('avc');
    vOutput.addVideoTrack(vSource);
    await vOutput.start();
    await vSource.add(new EncodedPacket(MINIMAL_AVC_KEYFRAME, 'key', 0, 0.5), {
      decoderConfig: {
        codec: 'avc1.42c00a',
        codedWidth: 16,
        codedHeight: 16,
        description: MINIMAL_AVCC_DESCRIPTION,
      },
    });
    vSource.close();
    await vOutput.finalize();

    const aTarget = new BufferTarget();
    const aOutput = new Output({
      format: new Mp4OutputFormat({ fastStart: 'in-memory' }),
      target: aTarget,
    });
    const aSource = new EncodedAudioPacketSource('aac');
    aOutput.addAudioTrack(aSource);
    await aOutput.start();
    await aSource.add(new EncodedPacket(MINIMAL_AAC_FRAME, 'key', 0, 0.5), {
      decoderConfig: {
        codec: 'mp4a.40.2',
        numberOfChannels: 2,
        sampleRate: 44_100,
        description: MINIMAL_AAC_DESCRIPTION,
      },
    });
    aSource.close();
    await aOutput.finalize();

    if (!vTarget.buffer || !aTarget.buffer) {
      throw new Error('Failed to build test MP4 buffers.');
    }
    return {
      videoMp4: Buffer.from(vTarget.buffer),
      audioMp4: Buffer.from(aTarget.buffer),
    };
  })();
  return cachedMediaPromise;
}

interface CdpMockHandle {
  requestedUrls: string[];
  dispose: () => Promise<void>;
}

async function attachCdpMediaMock(
  context: BrowserContext,
  patterns: string[],
  resolver: (url: string) => { contentType: string; body: Buffer } | null,
): Promise<CdpMockHandle> {
  const browser = context.browser();
  if (!browser) {
    throw new Error('Browser instance unavailable for CDP mock.');
  }
  const cdp: CDPSession = await browser.newBrowserCDPSession();
  const requestedUrls: string[] = [];

  await cdp.send('Fetch.enable', {
    patterns: patterns.map((urlPattern) => ({
      urlPattern,
      requestStage: 'Request' as const,
    })),
  });

  cdp.on('Fetch.requestPaused', async (event) => {
    const reqUrl = event.request.url;
    const match = resolver(reqUrl);
    if (!match) {
      await cdp
        .send('Fetch.continueRequest', { requestId: event.requestId })
        .catch(() => undefined);
      return;
    }
    requestedUrls.push(reqUrl);
    await cdp
      .send('Fetch.fulfillRequest', {
        requestId: event.requestId,
        responseCode: 200,
        responseHeaders: [
          { name: 'Content-Type', value: match.contentType },
          { name: 'Content-Length', value: String(match.body.byteLength) },
          { name: 'Access-Control-Allow-Origin', value: '*' },
        ],
        body: match.body.toString('base64'),
      })
      .catch(() => undefined);
  });

  return {
    requestedUrls,
    dispose: async () => {
      await cdp.send('Fetch.disable').catch(() => undefined);
      await cdp.detach().catch(() => undefined);
    },
  };
}

test.describe('YouTube / X / XVideos / Pornhub 独立收藏插件全链路 E2E 验证', () => {
  test('YouTube：悬浮按钮采集 DASH 视频 -> 无损混流暂存 -> 管理台离线播放', async ({
    context,
    extensionUrl,
    pageErrors,
  }) => {
    const { videoMp4, audioMp4 } = await buildTestMp4Buffers();
    const videoId = 'dQw4w9WgXcQ';
    const title = 'Playwright YouTube DASH E2E Video';

    const routeHandler = async (route: Route) => {
      const url = route.request().url();
      if (url.startsWith('https://www.youtube.com/watch')) {
        await route.fulfill({
          status: 200,
          contentType: 'text/html; charset=utf-8',
          body: `<!DOCTYPE html><html><head><title>${title} - YouTube</title></head><body>
            <script>
              window.ytInitialPlayerResponse = {
                videoDetails: {
                  videoId: '${videoId}',
                  title: '${title}',
                  shortDescription: 'Test description #youtube #e2e',
                  author: 'YT Test Channel',
                  channelId: 'UCtest123',
                  lengthSeconds: '42',
                  thumbnail: { thumbnails: [{ url: 'https://i.ytimg.com/vi/${videoId}/hqdefault.jpg', width: 480, height: 360 }] }
                },
                streamingData: {
                  adaptiveFormats: [
                    { url: 'https://rr1---sn.googlevideo.com/videoplayback?mime=video&id=${videoId}-avc', mimeType: 'video/mp4; codecs="avc1.640028"', width: 1920, height: 1080, bitrate: 2000000 },
                    { url: 'https://rr1---sn.googlevideo.com/videoplayback?mime=audio&id=${videoId}-aac', mimeType: 'audio/mp4; codecs="mp4a.40.2"', bitrate: 128000 }
                  ]
                }
              };
            </script>
          </body></html>`,
        });
        return;
      }
      await route.abort();
    };
    await context.route('https://www.youtube.com/**', routeHandler);

    const cdp = await attachCdpMediaMock(
      context,
      ['https://*.googlevideo.com/*', 'https://i.ytimg.com/*'],
      (url) => {
        if (url.includes('mime=video')) {
          return { contentType: 'video/mp4', body: videoMp4 };
        }
        if (url.includes('mime=audio')) {
          return { contentType: 'audio/mp4', body: audioMp4 };
        }
        if (url.includes('ytimg.com')) {
          return { contentType: 'image/png', body: VALID_PNG };
        }
        return null;
      },
    );

    try {
      const page = await context.newPage();
      await page.goto(`https://www.youtube.com/watch?v=${videoId}`, {
        waitUntil: 'domcontentloaded',
      });
      const fab = page.locator('button.cp-fab-btn');
      await expect(fab).toBeVisible();
      await fab.click();

      const libraryPage = await context.newPage();
      await libraryPage.goto(extensionUrl('library.html'));
      await expect(libraryPage.getByText(title)).toBeVisible({
        timeout: 20_000,
      });
      await expect(
        libraryPage.locator('article').getByText('待同步'),
      ).toBeVisible({ timeout: 20_000 });

      const platformGroup = libraryPage.getByRole('group', {
        name: '来源平台筛选',
      });
      await platformGroup
        .getByRole('button', { name: 'YouTube', exact: true })
        .click();
      await expect(libraryPage.locator('article')).toHaveCount(1);

      await libraryPage.locator('article').first().click();
      const videoEl = libraryPage.getByRole('dialog').locator('video');
      await expect(videoEl).toBeVisible();
      await expect(videoEl).toHaveAttribute('src', /^blob:chrome-extension:\/\//);

      expect(
        cdp.requestedUrls.some((u) => u.includes(`${videoId}-avc`)),
      ).toBe(true);
      expect(
        cdp.requestedUrls.some((u) => u.includes(`${videoId}-aac`)),
      ).toBe(true);
      expect(pageErrors).toEqual([]);
    } finally {
      await cdp.dispose();
      await context.unroute('https://www.youtube.com/**', routeHandler);
    }
  });

  test('X / Twitter：旁路 GraphQL 捕获视频推文 -> 最高码率 MP4 离线保存与播放', async ({
    context,
    extensionUrl,
    pageErrors,
  }) => {
    const { videoMp4 } = await buildTestMp4Buffers();
    const tweetId = '1899001122334455667';
    const tweetText = 'Playwright X Video Tweet E2E #xcom';

    const routeHandler = async (route: Route) => {
      const url = route.request().url();
      if (url.includes('/i/api/graphql/mock/TweetDetail')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            data: {
              tweetResult: {
                result: {
                  __typename: 'Tweet',
                  rest_id: tweetId,
                  core: {
                    user_results: {
                      result: {
                        rest_id: '42',
                        legacy: {
                          name: 'X Demo Author',
                          screen_name: 'xdemo',
                        },
                      },
                    },
                  },
                  legacy: {
                    id_str: tweetId,
                    full_text: tweetText,
                    created_at: 'Fri Nov 28 12:00:00 +0000 2025',
                    extended_entities: {
                      media: [
                        {
                          type: 'video',
                          media_url_https: 'https://pbs.twimg.com/ext_tw_video_thumb/demo.jpg',
                          video_info: {
                            duration_millis: 15_000,
                            variants: [
                              {
                                content_type: 'video/mp4',
                                bitrate: 256_000,
                                url: 'https://video.twimg.com/ext_tw_video/low.mp4',
                              },
                              {
                                content_type: 'video/mp4',
                                bitrate: 2_176_000,
                                url: 'https://video.twimg.com/ext_tw_video/high.mp4',
                              },
                            ],
                          },
                        },
                      ],
                    },
                  },
                },
              },
            },
          }),
        });
        return;
      }
      if (url.startsWith('https://x.com/xdemo/status/')) {
        await route.fulfill({
          status: 200,
          contentType: 'text/html; charset=utf-8',
          body: `<!DOCTYPE html><html><head><title>X Demo</title></head><body>
            <article data-testid="tweet">
              <a href="/xdemo/status/${tweetId}">status</a>
              <div data-testid="tweetText">${tweetText}</div>
            </article>
            <script>
              window.addEventListener('DOMContentLoaded', () => {
                fetch('/i/api/graphql/mock/TweetDetail?id=${tweetId}');
              });
            </script>
          </body></html>`,
        });
        return;
      }
      await route.abort();
    };
    await context.route('https://x.com/**', routeHandler);

    const cdp = await attachCdpMediaMock(
      context,
      ['https://video.twimg.com/*', 'https://pbs.twimg.com/*'],
      (url) => {
        if (url.includes('video.twimg.com')) {
          return { contentType: 'video/mp4', body: videoMp4 };
        }
        if (url.includes('pbs.twimg.com')) {
          return { contentType: 'image/png', body: VALID_PNG };
        }
        return null;
      },
    );

    try {
      const page = await context.newPage();
      await page.goto(`https://x.com/xdemo/status/${tweetId}`, {
        waitUntil: 'networkidle',
      });
      const fab = page.locator('button.cp-fab-btn');
      await expect(fab).toBeVisible();
      await fab.click();

      const libraryPage = await context.newPage();
      await libraryPage.goto(extensionUrl('library.html'));
      await expect(libraryPage.getByText(tweetText)).toBeVisible({
        timeout: 20_000,
      });
      await expect(
        libraryPage.locator('article').getByText('待同步'),
      ).toBeVisible({ timeout: 20_000 });

      const platformGroup = libraryPage.getByRole('group', {
        name: '来源平台筛选',
      });
      await platformGroup
        .getByRole('button', { name: 'X', exact: true })
        .click();
      await expect(libraryPage.locator('article')).toHaveCount(1);

      expect(cdp.requestedUrls.some((u) => u.includes('/high.mp4'))).toBe(true);
      expect(cdp.requestedUrls.some((u) => u.includes('/low.mp4'))).toBe(false);
      expect(pageErrors).toEqual([]);
    } finally {
      await cdp.dispose();
      await context.unroute('https://x.com/**', routeHandler);
    }
  });

  test('XVideos：解析 html5player 直链高画质 MP4 -> 离线保存与平台筛选', async ({
    context,
    extensionUrl,
    pageErrors,
  }) => {
    const { videoMp4 } = await buildTestMp4Buffers();
    const videoId = 'e2exv01';
    const title = 'Playwright XVideos E2E Sample';

    const routeHandler = async (route: Route) => {
      if (route.request().url().startsWith('https://www.xvideos.com/video.')) {
        await route.fulfill({
          status: 200,
          contentType: 'text/html; charset=utf-8',
          body: `<!DOCTYPE html><html><head><title>${title} - XVIDEOS.COM</title></head><body>
            <script>
              window.html5player = {
                id_video: '${videoId}',
                video_title: '${title}',
                url_high: 'https://cdn77-vid.xvideos-cdn.com/videos/mp4/${videoId}-high.mp4',
                url_low: 'https://cdn77-vid.xvideos-cdn.com/videos/mp4/${videoId}-low.mp4',
                url_thumb169: 'https://cdn77-pic.xvideos-cdn.com/videos/thumbs169/${videoId}.jpg',
                uploader_name: 'XV Demo Channel',
                video_duration: 180
              };
            </script>
          </body></html>`,
        });
        return;
      }
      await route.abort();
    };
    await context.route('https://www.xvideos.com/**', routeHandler);

    const cdp = await attachCdpMediaMock(
      context,
      ['https://*.xvideos-cdn.com/*'],
      (url) => {
        if (url.endsWith('.mp4')) {
          return { contentType: 'video/mp4', body: videoMp4 };
        }
        if (url.endsWith('.jpg')) {
          return { contentType: 'image/png', body: VALID_PNG };
        }
        return null;
      },
    );

    try {
      const page = await context.newPage();
      await page.goto(`https://www.xvideos.com/video.${videoId}/sample`, {
        waitUntil: 'domcontentloaded',
      });
      const fab = page.locator('button.cp-fab-btn');
      await expect(fab).toBeVisible();
      await fab.click();

      const libraryPage = await context.newPage();
      await libraryPage.goto(extensionUrl('library.html'));
      await expect(libraryPage.getByText(title)).toBeVisible({
        timeout: 20_000,
      });
      await expect(
        libraryPage.locator('article').getByText('待同步'),
      ).toBeVisible({ timeout: 20_000 });

      const platformGroup = libraryPage.getByRole('group', {
        name: '来源平台筛选',
      });
      await platformGroup
        .getByRole('button', { name: 'XVideos', exact: true })
        .click();
      await expect(libraryPage.locator('article')).toHaveCount(1);

      expect(
        cdp.requestedUrls.some((u) => u.includes(`${videoId}-high.mp4`)),
      ).toBe(true);
      expect(pageErrors).toEqual([]);
    } finally {
      await cdp.dispose();
      await context.unroute('https://www.xvideos.com/**', routeHandler);
    }
  });

  test('Pornhub：解析 flashvars + /video/get_media 最高画质 MP4 -> 离线保存与平台筛选', async ({
    context,
    extensionUrl,
    pageErrors,
  }) => {
    const { videoMp4 } = await buildTestMp4Buffers();
    const viewkey = 'ph_e2e_demo_01';
    const title = 'Playwright Pornhub E2E Sample';

    const routeHandler = async (route: Route) => {
      const url = route.request().url();
      if (url.includes('/video/get_media')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify([
            {
              format: 'mp4',
              quality: '480',
              videoUrl: `https://ev-h.phncdn.com/videos/${viewkey}-480p.mp4`,
            },
            {
              format: 'mp4',
              quality: '1080',
              videoUrl: `https://ev-h.phncdn.com/videos/${viewkey}-1080p.mp4`,
            },
          ]),
        });
        return;
      }
      if (url.startsWith('https://www.pornhub.com/view_video.php')) {
        await route.fulfill({
          status: 200,
          contentType: 'text/html; charset=utf-8',
          body: `<!DOCTYPE html><html><head><title>${title} - Pornhub</title></head><body>
            <div class="video-info-row"><div class="usernameWrap"><a href="/channels/demo">PH Demo Creator</a></div></div>
            <script>
              window.flashvars_9001 = {
                video_title: '${title}',
                video_duration: 210,
                image_url: 'https://ei.phncdn.com/videos/${viewkey}-cover.jpg',
                link_url: 'https://www.pornhub.com/view_video.php?viewkey=${viewkey}',
                mediaDefinitions: [
                  { format: 'mp4', quality: [480, 1080], videoUrl: 'https://www.pornhub.com/video/get_media?s=demo' }
                ]
              };
            </script>
          </body></html>`,
        });
        return;
      }
      await route.abort();
    };
    await context.route('https://www.pornhub.com/**', routeHandler);

    const cdp = await attachCdpMediaMock(
      context,
      ['https://*.phncdn.com/*'],
      (url) => {
        if (url.endsWith('.mp4')) {
          return { contentType: 'video/mp4', body: videoMp4 };
        }
        if (url.endsWith('.jpg')) {
          return { contentType: 'image/png', body: VALID_PNG };
        }
        return null;
      },
    );

    try {
      const page = await context.newPage();
      await page.goto(
        `https://www.pornhub.com/view_video.php?viewkey=${viewkey}`,
        { waitUntil: 'domcontentloaded' },
      );
      const fab = page.locator('button.cp-fab-btn');
      await expect(fab).toBeVisible();
      await fab.click();

      const libraryPage = await context.newPage();
      await libraryPage.goto(extensionUrl('library.html'));
      await expect(libraryPage.getByText(title)).toBeVisible({
        timeout: 20_000,
      });
      await expect(
        libraryPage.locator('article').getByText('待同步'),
      ).toBeVisible({ timeout: 20_000 });

      const platformGroup = libraryPage.getByRole('group', {
        name: '来源平台筛选',
      });
      await platformGroup
        .getByRole('button', { name: 'Pornhub', exact: true })
        .click();
      await expect(libraryPage.locator('article')).toHaveCount(1);

      expect(
        cdp.requestedUrls.some((u) => u.includes(`${viewkey}-1080p.mp4`)),
      ).toBe(true);
      expect(
        cdp.requestedUrls.some((u) => u.includes(`${viewkey}-480p.mp4`)),
      ).toBe(false);
      expect(pageErrors).toEqual([]);
    } finally {
      await cdp.dispose();
      await context.unroute('https://www.pornhub.com/**', routeHandler);
    }
  });
});
