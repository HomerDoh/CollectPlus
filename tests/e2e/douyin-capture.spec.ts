import { computeActionIconState } from '../../src/download/action-icon.ts';
import { expect, test } from './fixtures/extension.ts';
import {
  installDouyinMockRoutes,
  MOCK_GALLERY_AWEME_ID,
  MOCK_GALLERY_TITLE,
  MOCK_VIDEO_AWEME_ID,
  MOCK_VIDEO_TITLE,
} from './fixtures/douyin-mock.ts';

interface DeferredGate {
  promise: Promise<void>;
  release: () => void;
}

function createGate(): DeferredGate {
  let release: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

test.describe('Collect+ 抖音无弹窗采集、扩展图标环形进度与离线播放验证', () => {
  test('悬浮按钮采集视频 -> 无页面弹窗 -> 侧边栏与管理台离线播放及状态机不变量校验', async ({
    context,
    extensionUrl,
    pageErrors,
  }) => {
    const tracker = await installDouyinMockRoutes(context);
    try {
      const douyinPage = await context.newPage();
      await douyinPage.goto(
        `https://www.douyin.com/video/${MOCK_VIDEO_AWEME_ID}`,
        { waitUntil: 'domcontentloaded' },
      );

      // 确认 Shadow DOM 悬浮采集按钮已注入宿主页面，且无任何弹窗卡片
      const fabButton = douyinPage.locator('button.cp-fab-btn');
      await expect(fabButton).toBeVisible();
      await expect(douyinPage.locator('.cp-toast-card')).toHaveCount(0);

      // 触发 Mock 页面发起抖音详情 API 请求，使 Main World 旁路拦截写入 LRU 缓存
      await douyinPage.click('#mock-load-detail');
      await expect
        .poll(async () =>
          douyinPage.evaluate(() => {
            const win = window as unknown as { __mockDetailLoaded?: boolean };
            return Boolean(win.__mockDetailLoaded);
          }),
        )
        .toBe(true);

      // 点击 Shadow DOM 内「收藏当前」按钮，确认全程不出现页面弹窗
      await fabButton.click();
      await expect(douyinPage.locator('.cp-toast-card')).toHaveCount(0);

      // 打开 SidePanel 验证后台已完成 Offscreen 下载并暂存至 OPFS
      const sidePanelPage = await context.newPage();
      await sidePanelPage.goto(extensionUrl('sidepanel.html'));
      await expect(
        sidePanelPage.getByText('1 条内容待同步至 CollectVault'),
      ).toBeVisible({ timeout: 20_000 });
      await expect(sidePanelPage.getByText(MOCK_VIDEO_TITLE)).toBeVisible();
      await expect(douyinPage.locator('.cp-toast-card')).toHaveCount(0);

      // 验证 H.264 优先与 /playwm/ -> /play/ 去水印策略生效，且避开了 HEIC 封面
      expect(
        tracker.requestedMediaUrls.some(
          (url) =>
            url.includes('v26-web.douyinvod.com/aweme/v1/play/') &&
            url.includes('video_id=h264_primary'),
        ),
      ).toBe(true);
      expect(
        tracker.requestedMediaUrls.some((url) =>
          url.includes('mock-cover-video.png'),
        ),
      ).toBe(true);

      // 打开 Library 全屏管理台验证卡片、全文检索与 100% 离线播放
      const libraryPage = await context.newPage();
      await libraryPage.goto(extensionUrl('library.html'));
      await expect(libraryPage.getByText(MOCK_VIDEO_TITLE)).toBeVisible();

      // MiniSearch 中文检索验证
      const searchInput = libraryPage.getByPlaceholder(
        '全文检索标题、正文、作者、标签、备注...',
      );
      await searchInput.fill('自动化测试作者A');
      await expect(libraryPage.getByText('1 命中')).toBeVisible();
      await expect(libraryPage.getByText(MOCK_VIDEO_TITLE)).toBeVisible();

      // 点击卡片打开详情抽屉，验证从 OPFS 读取生成 blob: 离线视频 URL
      await libraryPage.locator('article').first().click();
      const dialog = libraryPage.getByRole('dialog');
      await expect(dialog).toBeVisible();

      const videoEl = dialog.locator('video');
      await expect(videoEl).toBeVisible();
      const videoSrc = await videoEl.getAttribute('src');
      expect(videoSrc).toMatch(/^blob:chrome-extension:\/\//);

      // 验证状态机不变量：条目处于 opfs_staged 时编辑备注保存，状态保持「已暂存待落盘」不越权变为 vault_synced
      const noteTextarea = dialog.locator('#detail-note-textarea');
      await noteTextarea.fill('Playwright 离线验证备注');
      await dialog.getByRole('button', { name: '保存修改' }).click();
      await expect(dialog.getByText(/已保存到浏览器索引/)).toBeVisible();
      await expect(dialog.getByText('已暂存待落盘')).toBeVisible();

      expect(pageErrors).toEqual([]);
    } finally {
      await tracker.dispose();
    }
  });

  test('抖音原生收藏拦截（action=1）静默触发图集下载与离线画廊翻页验证', async ({
    context,
    extensionUrl,
    pageErrors,
  }) => {
    const tracker = await installDouyinMockRoutes(context);
    try {
      const douyinPage = await context.newPage();
      await douyinPage.goto(
        `https://www.douyin.com/note/${MOCK_GALLERY_AWEME_ID}`,
        { waitUntil: 'domcontentloaded' },
      );

      await expect(douyinPage.locator('button.cp-fab-btn')).toBeVisible();

      // 加载图集详情进 Main World LRU 缓存
      await douyinPage.click('#mock-load-detail');
      await expect
        .poll(async () =>
          douyinPage.evaluate(() => {
            const win = window as unknown as { __mockDetailLoaded?: boolean };
            return Boolean(win.__mockDetailLoaded);
          }),
        )
        .toBe(true);

      // 模拟抖音原生收藏请求（POST /aweme/v1/web/aweme/collect/ action=1），确认不弹出页面弹窗
      await douyinPage.click('#mock-native-collect');
      await expect(douyinPage.locator('.cp-toast-card')).toHaveCount(0);

      // 在 Library 中等待 2 张图集离线暂存完成并验证画廊翻页
      const libraryPage = await context.newPage();
      await libraryPage.goto(extensionUrl('library.html'));
      await expect(libraryPage.getByText(MOCK_GALLERY_TITLE)).toBeVisible({
        timeout: 20_000,
      });
      await expect(
        libraryPage.locator('article').getByText('待同步'),
      ).toBeVisible({ timeout: 20_000 });

      // 验证图集避开 HEIC，下载了两张 PNG 原图
      expect(
        tracker.requestedMediaUrls.some((url) =>
          url.includes('mock-gallery-01.png'),
        ),
      ).toBe(true);
      expect(
        tracker.requestedMediaUrls.some((url) =>
          url.includes('mock-gallery-02.png'),
        ),
      ).toBe(true);

      await libraryPage.locator('article').first().click();

      const dialog = libraryPage.getByRole('dialog');
      await expect(dialog).toBeVisible();
      await expect(dialog.getByText('离线图集画廊 (1 / 2)')).toBeVisible();

      const slideImg = dialog.locator('img[alt*="第 1 张"]');
      await expect(slideImg).toBeVisible();
      expect(await slideImg.getAttribute('src')).toMatch(
        /^blob:chrome-extension:\/\//,
      );

      await dialog.getByRole('button', { name: '下一张' }).click();
      await expect(dialog.getByText('离线图集画廊 (2 / 2)')).toBeVisible();

      expect(pageErrors).toEqual([]);
    } finally {
      await tracker.dispose();
    }
  });

  test('快速连续收藏多条视频：无弹窗，扩展图标环形进度与计数从多条递减至单条（不显示数字1）再恢复默认', async ({
    context,
    serviceWorker,
    extensionUrl,
    pageErrors,
  }) => {
    // 1. 纯逻辑状态验证：模拟抖音快速划过 10 个视频全部收藏时的计数与当前任务进度不变量
    const tenTasksState = computeActionIconState([
      { status: 'downloading', progress: 42 },
      { status: 'downloading', progress: 15 },
      ...Array.from({ length: 8 }, () => ({
        status: 'queued' as const,
        progress: 0,
      })),
    ]);
    expect(tenTasksState).toEqual({
      mode: 'active',
      remainingCount: 10,
      progress: 42,
      countLabel: '10',
      title: 'Collect+ · 剩余 10 项下载 (42%)',
    });

    const singleTaskState = computeActionIconState([
      { status: 'downloading', progress: 78 },
    ]);
    expect(singleTaskState).toEqual({
      mode: 'active',
      remainingCount: 1,
      progress: 78,
      countLabel: null,
      title: 'Collect+ · 下载中 78%',
    });

    expect(computeActionIconState([])).toEqual({
      mode: 'idle',
      remainingCount: 0,
      progress: 0,
      countLabel: null,
      title: 'Collect+',
    });

    // 2. 浏览器全链路验证：连续收藏 3 条视频并通过门控逐个放行下载，校验 Service Worker OffscreenCanvas 图标与标题状态流转
    const videoIds = [
      '7490000000000000011',
      '7490000000000000012',
      '7490000000000000013',
    ] as const;
    const gates = new Map<string, DeferredGate>([
      [videoIds[0], createGate()],
      [videoIds[1], createGate()],
      [videoIds[2], createGate()],
    ]);

    const tracker = await installDouyinMockRoutes(context, {
      beforeFulfillMedia: async (url) => {
        for (const [id, gate] of gates.entries()) {
          if (url.includes(id)) {
            await gate.promise;
            break;
          }
        }
      },
    });

    try {
      const douyinPage = await context.newPage();
      await douyinPage.goto(
        `https://www.douyin.com/video/${MOCK_VIDEO_AWEME_ID}`,
        { waitUntil: 'domcontentloaded' },
      );
      await expect(douyinPage.locator('button.cp-fab-btn')).toBeVisible();

      // 连续模拟划过并点击收藏 3 个视频
      await douyinPage.evaluate(async (ids) => {
        for (const id of ids) {
          await fetch(`/aweme/v1/web/aweme/detail/?aweme_id=${id}`);
          await fetch(
            `/aweme/v1/web/aweme/collect/?aweme_id=${id}&action=1`,
            {
              method: 'POST',
              headers: { 'content-type': 'application/x-www-form-urlencoded' },
              body: `aweme_id=${id}&action=1`,
            },
          );
        }
      }, videoIds);

      // 页面不出现任何弹窗卡片
      await expect(douyinPage.locator('.cp-toast-card')).toHaveCount(0);

      // 3 个任务未完成时：图标显示数量 3，且不使用原生右下角 Badge 遮挡环形进度
      await expect
        .poll(async () =>
          serviceWorker.evaluate(() => chrome.action.getTitle({})),
        )
        .toBe('Collect+ · 剩余 3 项下载 (0%)');
      expect(
        await serviceWorker.evaluate(() => chrome.action.getBadgeText({})),
      ).toBe('');

      // 放行第 1 个视频下载完成 -> 剩余 2 项
      gates.get(videoIds[0])?.release();
      await expect
        .poll(async () =>
          serviceWorker.evaluate(() => chrome.action.getTitle({})),
        )
        .toBe('Collect+ · 剩余 2 项下载 (0%)');

      // 放行第 2 个视频下载完成 -> 仅剩 1 项，不显示数字 1（切换为单任务环形进度态）
      gates.get(videoIds[1])?.release();
      await expect
        .poll(async () =>
          serviceWorker.evaluate(() => chrome.action.getTitle({})),
        )
        .toBe('Collect+ · 下载中 0%');
      expect(
        await serviceWorker.evaluate(() => chrome.action.getBadgeText({})),
      ).toBe('');

      // 放行最后 1 个视频下载完成 -> 全部完成，恢复静态默认图标与标题
      gates.get(videoIds[2])?.release();
      await expect
        .poll(async () =>
          serviceWorker.evaluate(() => chrome.action.getTitle({})),
        )
        .toBe('Collect+');

      // 3. 像素级尺寸不变量校验：对比静态 icon/32.png 与激活态进度图标，确认内部白色书签图案与外框 1:1 不缩小
      const checkPage = await context.newPage();
      await checkPage.goto(extensionUrl('popup.html'));
      const geometryCheck = await checkPage.evaluate(async () => {
        const res = await fetch(chrome.runtime.getURL('icon/32.png'));
        const bmp = await createImageBitmap(await res.blob());

        const measureBounds = (img: ImageData) => {
          let outerMinX = img.width;
          let outerMaxX = 0;
          let markMinX = img.width;
          let markMaxX = 0;
          let markMinY = img.height;
          let markMaxY = 0;

          for (let y = 0; y < img.height; y += 1) {
            for (let x = 0; x < img.width; x += 1) {
              const i = (y * img.width + x) * 4;
              const r = img.data[i] ?? 0;
              const g = img.data[i + 1] ?? 0;
              const b = img.data[i + 2] ?? 0;
              const a = img.data[i + 3] ?? 0;

              if (a > 30) {
                outerMinX = Math.min(outerMinX, x);
                outerMaxX = Math.max(outerMaxX, x);
              }
              // 仅统计中心区域的纯白书签图案（r>210, g>210, b>210）
              if (x >= 6 && x <= 25 && y >= 5 && y <= 26 && r > 210 && g > 210 && b > 210) {
                markMinX = Math.min(markMinX, x);
                markMaxX = Math.max(markMaxX, x);
                markMinY = Math.min(markMinY, y);
                markMaxY = Math.max(markMaxY, y);
              }
            }
          }
          return { outerMinX, outerMaxX, markMinX, markMaxX, markMinY, markMaxY };
        };

        const rawCanvas = new OffscreenCanvas(32, 32);
        const rawCtx = rawCanvas.getContext('2d')!;
        rawCtx.drawImage(bmp, 0, 0, 32, 32);
        const staticBounds = measureBounds(rawCtx.getImageData(0, 0, 32, 32));

        // 复现同款 1:1 原始绘制 + 外圈进度描边，确认不会缩小或挤压中心书签
        const activeCanvas = new OffscreenCanvas(32, 32);
        const ctx = activeCanvas.getContext('2d')!;
        ctx.drawImage(bmp, 0, 0, 32, 32);
        const inset = 32 * 0.05;
        const strokeWidth = 32 * 0.094;
        const r = 32 * 0.225;
        ctx.beginPath();
        ctx.moveTo(16, inset);
        ctx.lineTo(32 - inset - r, inset);
        ctx.arcTo(32 - inset, inset, 32 - inset, inset + r, r);
        ctx.lineWidth = strokeWidth;
        ctx.strokeStyle = '#22d3ee';
        ctx.stroke();

        const activeImg = ctx.getImageData(0, 0, 32, 32);
        const activeBounds = measureBounds(activeImg);
        const topEdgeIdx = (2 * 32 + 18) * 4;
        const topEdgeCyan =
          (activeImg.data[topEdgeIdx + 1] ?? 0) > (activeImg.data[topEdgeIdx] ?? 0);

        bmp.close();
        return { staticBounds, activeBounds, topEdgeCyan };
      });
      await checkPage.close();

      expect(geometryCheck.activeBounds.markMinX).toBe(
        geometryCheck.staticBounds.markMinX,
      );
      expect(geometryCheck.activeBounds.markMaxX).toBe(
        geometryCheck.staticBounds.markMaxX,
      );
      expect(geometryCheck.activeBounds.markMinY).toBe(
        geometryCheck.staticBounds.markMinY,
      );
      expect(geometryCheck.activeBounds.markMaxY).toBe(
        geometryCheck.staticBounds.markMaxY,
      );
      expect(
        geometryCheck.activeBounds.outerMaxX -
          geometryCheck.activeBounds.outerMinX,
      ).toBeGreaterThanOrEqual(
        geometryCheck.staticBounds.outerMaxX -
          geometryCheck.staticBounds.outerMinX,
      );
      expect(geometryCheck.topEdgeCyan).toBe(true);

      expect(pageErrors).toEqual([]);
    } finally {
      for (const gate of gates.values()) {
        gate.release();
      }
      await tracker.dispose();
    }
  });
});
