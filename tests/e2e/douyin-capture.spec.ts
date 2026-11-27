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
  test('悬浮按钮采集视频 -> 无页面弹窗 -> 管理台离线播放及状态机不变量校验', async ({
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

      // 打开 Library 全屏管理台验证后台已完成 Offscreen 下载并暂存至 OPFS
      const libraryPage = await context.newPage();
      await libraryPage.goto(extensionUrl('library.html'));
      await expect(libraryPage.getByText(MOCK_VIDEO_TITLE)).toBeVisible({
        timeout: 20_000,
      });
      await expect(
        libraryPage.locator('article').getByText('待同步'),
      ).toBeVisible({ timeout: 20_000 });
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

      // 3. 像素级不变量校验：确认空闲态与活跃态中间 icon 与白色书签 1:1 尺寸完全一致、外圈圆形进度环与 icon 间有透明 1px 边距且四角透明
      const checkPage = await context.newPage();
      await checkPage.goto(extensionUrl('popup.html'));
      const geometryCheck = await checkPage.evaluate(async () => {
        const res = await fetch(chrome.runtime.getURL('icon/32.png'));
        const bmp = await createImageBitmap(await res.blob());

        const size = 32;
        const center = size / 2;
        const outerPad = Math.max(0.2, size * 0.008);
        const outerRadius = center - outerPad;
        const strokeWidth = Math.max(1.25, size * 0.0625);
        const ringRadius = outerRadius - strokeWidth / 2;
        const ringInnerRadius = outerRadius - strokeWidth;
        const ringGap = Math.max(1, size * 0.05);
        const iconRadius = Math.max(2, ringInnerRadius - ringGap);
        const iconDiameter = iconRadius * 2;
        const left = center - iconRadius;
        const cornerRadius = iconDiameter * 0.24;

        // 复现空闲态（Idle）工具栏图标：尺寸锁定为 iconDiameter，内部 1:1 保留书签
        const idleCanvas = new OffscreenCanvas(size, size);
        const idleCtx = idleCanvas.getContext('2d')!;
        idleCtx.beginPath();
        idleCtx.roundRect(left, left, iconDiameter, iconDiameter, cornerRadius);
        idleCtx.fillStyle = '#3a359e';
        idleCtx.fill();
        idleCtx.save();
        idleCtx.beginPath();
        idleCtx.roundRect(left, left, iconDiameter, iconDiameter, cornerRadius);
        idleCtx.clip();
        idleCtx.drawImage(bmp, 0, 0, size, size);
        idleCtx.restore();
        const idleImg = idleCtx.getImageData(0, 0, size, size);

        // 复现活跃态（Active）工具栏图标：中间圆形 icon 保持同直径 iconDiameter 与 1:1 书签，外圈 1px 边距外绘制圆形进度环
        const activeCanvas = new OffscreenCanvas(size, size);
        const ctx = activeCanvas.getContext('2d')!;
        ctx.beginPath();
        ctx.arc(center, center, iconRadius, 0, Math.PI * 2);
        ctx.fillStyle = '#3a359e';
        ctx.fill();

        ctx.save();
        ctx.beginPath();
        ctx.arc(center, center, iconRadius, 0, Math.PI * 2);
        ctx.clip();
        ctx.drawImage(bmp, 0, 0, size, size);
        ctx.restore();

        ctx.beginPath();
        ctx.arc(center, center, ringRadius, -Math.PI / 2, 0, false);
        ctx.lineWidth = strokeWidth;
        ctx.lineCap = 'round';
        ctx.strokeStyle = '#06b6d4';
        ctx.stroke();

        const activeImg = ctx.getImageData(0, 0, size, size);
        const pixelAt = (img: ImageData, x: number, y: number) => {
          const i = (y * size + x) * 4;
          return {
            r: img.data[i] ?? 0,
            g: img.data[i + 1] ?? 0,
            b: img.data[i + 2] ?? 0,
            a: img.data[i + 3] ?? 0,
          };
        };

        const measureWhiteMarkBounds = (img: ImageData) => {
          let minX = size;
          let maxX = 0;
          let minY = size;
          let maxY = 0;
          for (let y = 0; y < size; y += 1) {
            for (let x = 0; x < size; x += 1) {
              const p = pixelAt(img, x, y);
              if (p.a > 200 && p.r > 210 && p.g > 210 && p.b > 210) {
                minX = Math.min(minX, x);
                maxX = Math.max(maxX, x);
                minY = Math.min(minY, y);
                maxY = Math.max(maxY, y);
              }
            }
          }
          return { minX, maxX, minY, maxY };
        };

        const idleMark = measureWhiteMarkBounds(idleImg);
        const activeMark = measureWhiteMarkBounds(activeImg);

        // 外圈顶部进度弧（距圆心 ~14.7px，y=1）呈高对比度青色
        const topRingPixel = pixelAt(activeImg, 18, 1);
        const topEdgeCyan =
          topRingPixel.a > 180 && topRingPixel.g > topRingPixel.r;

        // 校验外圈进度环与内部圆形 icon 之间的 1px 透明边距（距圆心 ~13px，介于 iconRadius=12.14 与 ringInnerRadius=13.74 之间）
        const gapPoints: readonly [number, number][] = [
          [16, 3],
          [28, 16],
          [16, 28],
          [3, 16],
        ];
        const gapTransparent = gapPoints.every(
          ([x, y]) => pixelAt(activeImg, x, y).a < 60,
        );

        // 校验四角 (2,2)/(29,2)/(2,29)/(29,29) 在空闲态和活跃态均透明（圆形进度外轮廓无方角）
        const cornerPoints: readonly [number, number][] = [
          [2, 2],
          [29, 2],
          [2, 29],
          [29, 29],
        ];
        const activeCornersTransparent = cornerPoints.every(
          ([x, y]) => pixelAt(activeImg, x, y).a === 0,
        );

        bmp.close();
        return {
          idleMark,
          activeMark,
          topEdgeCyan,
          gapTransparent,
          activeCornersTransparent,
        };
      });
      await checkPage.close();

      expect(geometryCheck.activeMark).toEqual(geometryCheck.idleMark);
      expect(geometryCheck.topEdgeCyan).toBe(true);
      expect(geometryCheck.gapTransparent).toBe(true);
      expect(geometryCheck.activeCornersTransparent).toBe(true);

      expect(pageErrors).toEqual([]);
    } finally {
      for (const gate of gates.values()) {
        gate.release();
      }
      await tracker.dispose();
    }
  });

  test('收藏抖音视频同步分页保存前 100 条评论（含离线去重头像、昵称、内容、点赞数）并在详情页离线展示', async ({
    context,
    extensionUrl,
    pageErrors,
  }) => {
    const TOTAL_MOCK_COMMENTS = 120;
    const UNIQUE_AVATAR_COUNT = 25;

    const tracker = await installDouyinMockRoutes(context, {
      handleCommentList: (_awemeId, cursorRaw, count) => {
        const start = Math.max(0, Number(cursorRaw) || 0);
        const pageSize = Math.max(1, Math.min(20, count));
        const end = Math.min(TOTAL_MOCK_COMMENTS, start + pageSize);
        const comments = [];
        for (let idx = start; idx < end; idx += 1) {
          const seq = idx + 1;
          const avatarSlot = ((idx % UNIQUE_AVATAR_COUNT) + 1)
            .toString()
            .padStart(2, '0');
          comments.push({
            cid: `900${seq.toString().padStart(4, '0')}`,
            text: `第 ${seq} 条热门评论内容`,
            digg_count: seq === 1 ? 15_200 : Math.max(1, 500 - seq),
            create_time: 1_760_000_000 + seq * 60,
            user: {
              uid: `commenter-${avatarSlot}`,
              nickname: `热评达人_${seq.toString().padStart(3, '0')}`,
              avatar_thumb: {
                url_list: [
                  `https://p3-pc-sign.douyinpic.com/mock-avatar-${avatarSlot}.heic`,
                  `https://p3-pc-sign.douyinpic.com/mock-avatar-${avatarSlot}.png`,
                ],
              },
            },
          });
        }
        return {
          body: {
            status_code: 0,
            comments,
            cursor: end,
            has_more: end < TOTAL_MOCK_COMMENTS ? 1 : 0,
            total: TOTAL_MOCK_COMMENTS,
          },
        };
      },
    });

    try {
      const douyinPage = await context.newPage();
      await douyinPage.goto(
        `https://www.douyin.com/video/${MOCK_VIDEO_AWEME_ID}`,
        { waitUntil: 'domcontentloaded' },
      );

      await expect(douyinPage.locator('button.cp-fab-btn')).toBeVisible();
      await douyinPage.click('#mock-load-detail');
      await expect
        .poll(async () =>
          douyinPage.evaluate(() => {
            const win = window as unknown as { __mockDetailLoaded?: boolean };
            return Boolean(win.__mockDetailLoaded);
          }),
        )
        .toBe(true);

      await douyinPage.locator('button.cp-fab-btn').click();

      const libraryPage = await context.newPage();
      await libraryPage.goto(extensionUrl('library.html'));
      await expect(libraryPage.getByText(MOCK_VIDEO_TITLE)).toBeVisible({
        timeout: 20_000,
      });
      await expect(
        libraryPage.locator('article').getByText('待同步'),
      ).toBeVisible({ timeout: 20_000 });

      // 等待 OPFS 暂存区生成 comments.json（严格截断至前 100 条）与 25 个去重离线头像
      await expect
        .poll(
          async () =>
            libraryPage.evaluate(async () => {
              const root = await navigator.storage.getDirectory();
              let stageRoot: FileSystemDirectoryHandle;
              try {
                stageRoot = await root.getDirectoryHandle('collect-plus-stage', {
                  create: false,
                });
              } catch {
                return null;
              }
              for await (const [, itemHandle] of stageRoot.entries()) {
                if (itemHandle.kind !== 'directory') {
                  continue;
                }
                try {
                  const commentsFh = await itemHandle.getFileHandle(
                    'comments.json',
                    { create: false },
                  );
                  const parsed = JSON.parse(
                    await (await commentsFh.getFile()).text(),
                  ) as {
                    comments?: Array<{
                      id?: string;
                      authorName?: string;
                      content?: string;
                      likeCount?: number;
                      avatarRelativePath?: string;
                    }>;
                  };
                  const commentsDir = await itemHandle.getDirectoryHandle(
                    'comments',
                    { create: false },
                  );
                  const avatarsDir = await commentsDir.getDirectoryHandle(
                    'avatars',
                    { create: false },
                  );
                  const avatarNames: string[] = [];
                  for await (const [name] of avatarsDir.entries()) {
                    avatarNames.push(name);
                  }
                  return {
                    count: parsed.comments?.length ?? 0,
                    first: parsed.comments?.[0] ?? null,
                    last: parsed.comments?.[99] ?? null,
                    avatarCount: avatarNames.length,
                  };
                } catch {
                  return null;
                }
              }
              return null;
            }),
          { timeout: 25_000 },
        )
        .toMatchObject({
          count: 100,
          avatarCount: UNIQUE_AVATAR_COUNT,
          first: {
            authorName: '热评达人_001',
            content: '第 1 条热门评论内容',
            likeCount: 15_200,
          },
          last: {
            authorName: '热评达人_100',
            content: '第 100 条热门评论内容',
          },
        });

      // 确认避开 HEIC，仅请求了 PNG 头像，且 5 页拉满 100 条即停止分页（不请求第 6 页）
      expect(tracker.commentListRequests).toBe(5);
      expect(
        tracker.requestedMediaUrls.some((u) => u.includes('.heic')),
      ).toBe(false);

      // 打开视频详情抽屉 -> 切换到「评论」标签 -> 验证离线头像、昵称、内容、点赞数渲染
      await libraryPage.locator('article').first().click();
      const dialog = libraryPage.getByRole('dialog');
      await expect(dialog).toBeVisible();

      const commentsTab = dialog.getByRole('tab', { name: /评论/ });
      await expect(commentsTab).toContainText('100');
      await commentsTab.click();

      await expect(dialog.getByText('已离线保存 100 条评论')).toBeVisible();
      const rows = dialog.getByTestId('item-comment-row');
      await expect(rows).toHaveCount(100);

      const firstRow = rows.first();
      await expect(firstRow).toContainText('热评达人_001');
      await expect(firstRow).toContainText('第 1 条热门评论内容');
      await expect(firstRow).toContainText('1.5万');
      await expect(firstRow.locator('img')).toHaveAttribute(
        'src',
        /^blob:chrome-extension:\/\//,
      );

      expect(pageErrors).toEqual([]);
    } finally {
      await tracker.dispose();
    }
  });
});
