import { deflateSync } from 'node:zlib';
import type { BrowserContext, CDPSession, Route, Worker } from '@playwright/test';
import {
  BufferTarget,
  EncodedPacket,
  EncodedVideoPacketSource,
  Mp4OutputFormat,
  Output,
} from 'mediabunny';
import { expect, test } from './fixtures/extension.ts';

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    crc ^= buf[i] ?? 0;
    for (let j = 0; j < 8; j += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function makePngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

/** 生成指定像素尺寸的合法纯色 PNG（确保通过 >=120px 正文配图过滤与 createImageBitmap 缩略图生成） */
function buildSolidPng(width: number, height: number): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const rowSize = 1 + width * 3;
  const raw = Buffer.alloc(rowSize * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * rowSize;
    raw[rowStart] = 0; // filter none
    for (let x = 0; x < width; x += 1) {
      raw[rowStart + 1 + x * 3] = 0x0d;
      raw[rowStart + 2 + x * 3] = 0x94;
      raw[rowStart + 3 + x * 3] = 0x88;
    }
  }
  const idat = deflateSync(raw);
  return Buffer.concat([
    sig,
    makePngChunk('IHDR', ihdr),
    makePngChunk('IDAT', idat),
    makePngChunk('IEND', Buffer.alloc(0)),
  ]);
}

const VALID_CONTENT_PNG = buildSolidPng(160, 120);

const MINIMAL_AVCC_DESCRIPTION = new Uint8Array([
  0x01, 0x42, 0xc0, 0x0a, 0xff, 0xe1, 0x00, 0x0a, 0x67, 0x42, 0xc0, 0x0a, 0xd9,
  0x00, 0x80, 0x04, 0x00, 0x00, 0x01, 0x00, 0x04, 0x68, 0xce, 0x3c, 0x80,
]);
const MINIMAL_AVC_KEYFRAME = new Uint8Array([
  0x00, 0x00, 0x00, 0x06, 0x65, 0x88, 0x84, 0x00, 0x10, 0xff,
]);

let cachedMp4Promise: Promise<Buffer> | null = null;

async function buildMinimalMp4(): Promise<Buffer> {
  if (cachedMp4Promise) {
    return cachedMp4Promise;
  }
  cachedMp4Promise = (async () => {
    const target = new BufferTarget();
    const output = new Output({
      format: new Mp4OutputFormat({ fastStart: 'in-memory' }),
      target,
    });
    const source = new EncodedVideoPacketSource('avc');
    output.addVideoTrack(source);
    await output.start();
    await source.add(new EncodedPacket(MINIMAL_AVC_KEYFRAME, 'key', 0, 0.5), {
      decoderConfig: {
        codec: 'avc1.42c00a',
        codedWidth: 16,
        codedHeight: 16,
        description: MINIMAL_AVCC_DESCRIPTION,
      },
    });
    source.close();
    await output.finalize();
    if (!target.buffer) {
      throw new Error('Failed to generate minimal MP4 buffer.');
    }
    return Buffer.from(target.buffer);
  })();
  return cachedMp4Promise;
}

interface DynamicDnrRuleSnapshot {
  id: number;
  urlFilter?: string;
  initiatorDomains?: string[];
  referer?: string;
}

async function readDynamicTaskDnrRules(
  serviceWorker: Worker,
): Promise<DynamicDnrRuleSnapshot[]> {
  return serviceWorker.evaluate(async (): Promise<DynamicDnrRuleSnapshot[]> => {
    const rules = await chrome.declarativeNetRequest.getSessionRules();
    return rules
      .filter((rule) => rule.id >= 30000 && rule.id < 50000)
      .map((rule) => {
        const refererHeader = rule.action.requestHeaders?.find(
          (h) => h.header.toLowerCase() === 'referer',
        );
        return {
          id: rule.id,
          urlFilter: rule.condition.urlFilter,
          initiatorDomains: rule.condition.initiatorDomains,
          ...(refererHeader?.value !== undefined
            ? { referer: refererHeader.value }
            : {}),
        };
      });
  });
}

async function attachCdpMediaInspector(
  context: BrowserContext,
  serviceWorker: Worker,
  patterns: string[],
  resolver: (url: string) => { contentType: string; body: Buffer } | null,
): Promise<{
  requestedUrls: string[];
  inFlightDynamicRules: DynamicDnrRuleSnapshot[];
  dispose: () => Promise<void>;
}> {
  const browser = context.browser();
  if (!browser) {
    throw new Error('Browser instance unavailable for CDP mock.');
  }
  const cdp: CDPSession = await browser.newBrowserCDPSession();
  const requestedUrls: string[] = [];
  const inFlightDynamicRules: DynamicDnrRuleSnapshot[] = [];

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
    // 在下载请求暂停期间采样任务级动态 DNR 规则，验证 Referer 与 initiatorDomains 安全红线
    const activeRules = await readDynamicTaskDnrRules(serviceWorker).catch(
      () => [],
    );
    inFlightDynamicRules.push(...activeRules);

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
    inFlightDynamicRules,
    dispose: async () => {
      await cdp.send('Fetch.disable').catch(() => undefined);
      await cdp.detach().catch(() => undefined);
    },
  };
}

test.describe('Tier 1 通用全网采集引擎与任务级动态 DNR 闭环 E2E', () => {
  test('任意未注册博客页：按需提取文章与防盗链配图 -> 动态 DNR 注入 Referer 并自动回收 -> 管理台离线阅读', async ({
    context,
    serviceWorker,
    extensionId,
    extensionUrl,
    pageErrors,
  }) => {
    const articleTitle = 'Playwright Universal Web Article E2E';
    const articleUrl = 'https://blog.example.org/posts/universal-arch-e2e';
    const imageUrl = 'https://cdn.example-assets.org/images/arch-diagram.png';

    const routeHandler = async (route: Route) => {
      const url = route.request().url();
      if (url.startsWith(articleUrl)) {
        await route.fulfill({
          status: 200,
          contentType: 'text/html; charset=utf-8',
          body: `<!DOCTYPE html>
            <html lang="zh-CN">
              <head>
                <title>${articleTitle} - Example Tech Blog</title>
                <meta property="og:site_name" content="Example Tech Blog" />
                <meta property="og:title" content="${articleTitle}" />
                <meta property="og:description" content="Zero-config universal extraction test." />
                <meta property="article:tag" content="Architecture" />
                <script type="application/ld+json">
                  {
                    "@context": "https://schema.org",
                    "@type": "BlogPosting",
                    "headline": "${articleTitle}",
                    "author": { "@type": "Person", "name": "Universal Author" },
                    "datePublished": "2026-11-28T08:00:00Z"
                  }
                </script>
              </head>
              <body>
                <nav><a href="/">Home</a></nav>
                <article>
                  <h1>${articleTitle}</h1>
                  <p>这是第一段用于验证通用网页提取引擎的完整正文内容，不依赖任何站点专属适配器。</p>
                  <p>这是第二段正文内容，同时附带一张托管在独立防盗链 CDN 上的高分辨率架构配图。</p>
                  <img src="${imageUrl}" width="640" height="360" alt="Architecture Diagram" />
                </article>
                <footer>Copyright Example</footer>
              </body>
            </html>`,
        });
        return;
      }
      await route.abort();
    };

    await context.route('https://blog.example.org/**', routeHandler);
    const cdp = await attachCdpMediaInspector(
      context,
      serviceWorker,
      ['https://cdn.example-assets.org/*'],
      (url) => {
        if (url === imageUrl) {
          return { contentType: 'image/png', body: VALID_CONTENT_PNG };
        }
        return null;
      },
    );

    try {
      const page = await context.newPage();
      await page.goto(articleUrl, { waitUntil: 'domcontentloaded' });

      // 1. 确认未注册站点平时零常驻注入（无 Shadow DOM 悬浮球污染页面）
      await expect(page.locator('button.cp-fab-btn')).toHaveCount(0);

      // 2. 校验 GET_STATUS_SUMMARY 返回 universal 模式与 siteHost，并触发按需采集
      const captureOutcome = await serviceWorker.evaluate(async (targetUrl) => {
        const tabs = await chrome.tabs.query({});
        const tab = tabs.find((t) => t.url === targetUrl);
        if (!tab?.id) {
          return { ok: false, error: 'Tab not found' };
        }
        return { ok: true, tabId: tab.id };
      }, articleUrl);
      expect(captureOutcome.ok).toBe(true);
      const targetTabId = (captureOutcome as { ok: true; tabId: number }).tabId;

      const popupPage = await context.newPage();
      await popupPage.goto(extensionUrl('popup.html'));
      const summaryRes = await popupPage.evaluate(async (url) => {
        return chrome.runtime.sendMessage({
          target: 'background',
          type: 'GET_STATUS_SUMMARY',
          tabUrl: url,
        });
      }, articleUrl);
      expect(summaryRes.ok).toBe(true);
      expect(summaryRes.supportedPlatform).toBe('web');
      expect(summaryRes.captureMode).toBe('universal');
      expect(summaryRes.siteHost).toBe('blog.example.org');

      const triggerRes = await popupPage.evaluate(async (tabId) => {
        return chrome.runtime.sendMessage({
          target: 'background',
          type: 'TRIGGER_ACTIVE_TAB_CAPTURE',
          tabId,
        });
      }, targetTabId);
      expect(triggerRes).toEqual({ ok: true });
      await popupPage.close();

      // 3. 验证管理台出现条目、展示站点名徽标、支持按「通用网页」筛选并可离线打开
      const libraryPage = await context.newPage();
      await libraryPage.goto(extensionUrl('library.html'));
      await expect(libraryPage.getByText(articleTitle)).toBeVisible({
        timeout: 20_000,
      });
      await expect(
        libraryPage.locator('article').getByText('待同步'),
      ).toBeVisible({ timeout: 20_000 });
      await expect(
        libraryPage.locator('article').getByText('Example Tech Blog'),
      ).toBeVisible();

      const platformGroup = libraryPage.getByRole('group', {
        name: '来源平台筛选',
      });
      await platformGroup
        .getByRole('button', { name: '通用网页', exact: true })
        .click();
      await expect(libraryPage.locator('article')).toHaveCount(1);

      await libraryPage.locator('article').first().click();
      const dialog = libraryPage.getByTestId('item-detail-dialog');
      await expect(dialog).toHaveAttribute('data-platform', 'web');
      await expect(
        dialog
          .getByText('这是第一段用于验证通用网页提取引擎的完整正文内容')
          .first(),
      ).toBeVisible();

      // 4. 验证下载期间任务级动态 DNR 注入了正确 Referer 且严格限定扩展自身 initiator，完成后自动释放
      expect(cdp.requestedUrls).toContain(imageUrl);
      const matchedRule = cdp.inFlightDynamicRules.find(
        (r) => r.urlFilter === '||cdn.example-assets.org/',
      );
      expect(matchedRule).toBeDefined();
      expect(matchedRule?.referer).toBe('https://blog.example.org/');
      expect(matchedRule?.initiatorDomains).toEqual([extensionId]);

      await expect
        .poll(async () => (await readDynamicTaskDnrRules(serviceWorker)).length)
        .toBe(0);

      expect(pageErrors).toEqual([]);
    } finally {
      await cdp.dispose();
      await context.unroute('https://blog.example.org/**', routeHandler);
    }
  });

  test('任意未注册 HTML5 视频页：自动嗅探 <video> 直链 MP4 -> 离线暂存并在管理台播放', async ({
    context,
    serviceWorker,
    extensionId,
    extensionUrl,
    pageErrors,
  }) => {
    const mp4Body = await buildMinimalMp4();
    const videoPageUrl = 'https://media.randomsite.test/watch/demo-clip';
    const mp4Url = 'https://video-cdn.randomsite.test/files/demo-clip.mp4';
    const videoTitle = 'Playwright Universal HTML5 Video Clip';

    const routeHandler = async (route: Route) => {
      if (route.request().url().startsWith(videoPageUrl)) {
        await route.fulfill({
          status: 200,
          contentType: 'text/html; charset=utf-8',
          body: `<!DOCTYPE html>
            <html>
              <head>
                <title>${videoTitle}</title>
                <meta property="og:type" content="video.other" />
                <meta property="og:site_name" content="RandomVideo" />
              </head>
              <body>
                <video controls preload="none">
                  <source src="${mp4Url}" type="video/mp4" />
                </video>
              </body>
            </html>`,
        });
        return;
      }
      await route.abort();
    };

    await context.route('https://media.randomsite.test/**', routeHandler);
    const cdp = await attachCdpMediaInspector(
      context,
      serviceWorker,
      ['https://video-cdn.randomsite.test/*'],
      (url) => {
        if (url === mp4Url) {
          return { contentType: 'video/mp4', body: mp4Body };
        }
        return null;
      },
    );

    try {
      const page = await context.newPage();
      await page.goto(videoPageUrl, { waitUntil: 'domcontentloaded' });

      const tabInfo = await serviceWorker.evaluate(async (targetUrl) => {
        const tabs = await chrome.tabs.query({});
        const tab = tabs.find((t) => t.url === targetUrl);
        return tab?.id ?? null;
      }, videoPageUrl);
      expect(tabInfo).not.toBeNull();

      const popupPage = await context.newPage();
      await popupPage.goto(extensionUrl('popup.html'));
      const triggerRes = await popupPage.evaluate(async (tabId) => {
        return chrome.runtime.sendMessage({
          target: 'background',
          type: 'TRIGGER_ACTIVE_TAB_CAPTURE',
          tabId,
        });
      }, tabInfo as number);
      expect(triggerRes).toEqual({ ok: true });
      await popupPage.close();

      const libraryPage = await context.newPage();
      await libraryPage.goto(extensionUrl('library.html'));
      await expect(libraryPage.getByText(videoTitle)).toBeVisible({
        timeout: 20_000,
      });
      await expect(
        libraryPage.locator('article').getByText('待同步'),
      ).toBeVisible({ timeout: 20_000 });

      await libraryPage.locator('article').first().click();
      const videoEl = libraryPage.getByRole('dialog').locator('video');
      await expect(videoEl).toBeVisible();
      await expect(videoEl).toHaveAttribute('src', /^blob:chrome-extension:\/\//);

      expect(cdp.requestedUrls).toContain(mp4Url);
      const matchedRule = cdp.inFlightDynamicRules.find(
        (r) => r.urlFilter === '||video-cdn.randomsite.test/',
      );
      expect(matchedRule).toBeDefined();
      expect(matchedRule?.referer).toBe('https://media.randomsite.test/');
      expect(matchedRule?.initiatorDomains).toEqual([extensionId]);

      await expect
        .poll(async () => (await readDynamicTaskDnrRules(serviceWorker)).length)
        .toBe(0);

      expect(pageErrors).toEqual([]);
    } finally {
      await cdp.dispose();
      await context.unroute('https://media.randomsite.test/**', routeHandler);
    }
  });
});
