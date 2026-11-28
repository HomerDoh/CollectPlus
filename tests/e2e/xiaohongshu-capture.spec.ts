import { expect, test } from './fixtures/extension.ts';
import {
  installXiaohongshuMockRoutes,
  MOCK_XHS_GALLERY_NOTE_ID,
  MOCK_XHS_GALLERY_TITLE,
  MOCK_XHS_VIDEO_NOTE_ID,
  MOCK_XHS_VIDEO_TITLE,
} from './fixtures/xiaohongshu-mock.ts';

test.describe('Collect+ 小红书独立插件全链路 E2E 验证', () => {
  test('小红书视频笔记悬浮按钮采集、H.264 下载、离线评论与管理台离线播放', async ({
    context,
    extensionUrl,
    pageErrors,
  }) => {
    const tracker = await installXiaohongshuMockRoutes(context);
    try {
      const xhsPage = await context.newPage();
      await xhsPage.goto(
        `https://www.xiaohongshu.com/explore/${MOCK_XHS_VIDEO_NOTE_ID}`,
        { waitUntil: 'domcontentloaded' },
      );

      const fabBtn = xhsPage.locator('button.cp-fab-btn');
      await expect(fabBtn).toBeVisible();
      await fabBtn.click();

      // 等待 H.264 视频优先下载（非 HEVC）及评论拉取
      await expect
        .poll(() =>
          tracker.requestedMediaUrls.some((u) =>
            u.includes(`mock-h264-${MOCK_XHS_VIDEO_NOTE_ID}.mp4`),
          ),
        )
        .toBe(true);
      expect(
        tracker.requestedMediaUrls.some((u) => u.includes('mock-hevc.mp4')),
      ).toBe(false);

      const libraryPage = await context.newPage();
      await libraryPage.goto(extensionUrl('library.html'));

      // 按「小红书」平台筛选命中
      const platformGroup = libraryPage.getByRole('group', {
        name: '来源平台筛选',
      });
      await platformGroup.getByRole('button', { name: '小红书', exact: true }).click();

      const card = libraryPage
        .locator('article')
        .filter({ hasText: MOCK_XHS_VIDEO_TITLE });
      await expect(card).toBeVisible();
      await expect(card.getByText('待同步')).toBeVisible({ timeout: 15_000 });

      // 打开详情抽屉验证离线视频播放与离线评论
      await card.click();
      const dialog = libraryPage.getByRole('dialog');
      await expect(dialog).toBeVisible();
      const videoEl = dialog.locator('video');
      await expect(videoEl).toBeVisible();
      await expect(videoEl).toHaveAttribute('src', /^blob:/);

      const commentsTab = dialog.getByRole('tab', { name: /评论/ });
      await expect(commentsTab).toBeVisible({ timeout: 15_000 });
      await commentsTab.click();
      await expect(
        dialog.getByText('小红书热评第一条：太实用了！'),
      ).toBeVisible({ timeout: 15_000 });
      await expect(
        dialog.getByText('小红书热评第二条：已离线归档保存'),
      ).toBeVisible();

      expect(pageErrors).toEqual([]);
    } finally {
      await tracker.dispose();
    }
  });

  test('小红书图文笔记原生收藏/取消收藏拦截、图集画廊离线浏览与风控被动同步', async ({
    context,
    extensionUrl,
    pageErrors,
  }) => {
    const tracker = await installXiaohongshuMockRoutes(context, {
      loggedInUser: { userId: 'xhs-me-01', nickname: '测试小红薯' },
      simulateCollectListRiskControl: true,
    });

    try {
      // 先在设置页开启「取消收藏时同步至插件」
      const libraryPage = await context.newPage();
      await libraryPage.goto(extensionUrl('library.html'));
      await libraryPage.getByRole('button', { name: '设置', exact: true }).click();
      const uncollectSwitch = libraryPage.getByRole('switch', {
        name: '取消收藏时同步至插件',
      });
      await uncollectSwitch.click();
      await expect(uncollectSwitch).toHaveAttribute('aria-checked', 'true');

      // 打开小红书图文笔记页，确认首次登录同步提示并触发风控降级被动同步
      const xhsPage = await context.newPage();
      await xhsPage.goto(
        `https://www.xiaohongshu.com/explore/${MOCK_XHS_GALLERY_NOTE_ID}`,
        { waitUntil: 'domcontentloaded' },
      );

      const syncPrompt = xhsPage.getByTestId('cp-sync-prompt');
      await expect(syncPrompt).toBeVisible();
      await expect(syncPrompt).toContainText('小红书');
      await syncPrompt.getByRole('button', { name: '立即同步' }).click();

      const syncBanner = xhsPage.getByTestId('cp-sync-banner');
      await expect(syncBanner).toContainText('已切换为被动旁路同步模式', {
        timeout: 10_000,
      });

      // 被动加载一页收藏列表，验证自动旁路入库
      await xhsPage.click('#mock-xhs-passive-list');
      await expect(syncBanner).toContainText('已通过被动旁路同步本页小红书收藏', {
        timeout: 10_000,
      });

      // 原生收藏当前图文笔记
      await xhsPage.click('#mock-xhs-collect');

      await libraryPage.getByRole('button', { name: /全部收藏/ }).click();
      const galleryCards = libraryPage
        .locator('article')
        .filter({ hasText: MOCK_XHS_GALLERY_TITLE });
      await expect(galleryCards).toHaveCount(2, { timeout: 15_000 });
      const galleryCard = galleryCards.first();
      await expect(galleryCard.getByText('待同步')).toBeVisible({
        timeout: 15_000,
      });

      // 打开图集验证 2 张离线原图切换
      await galleryCard.click();
      const dialog = libraryPage.getByRole('dialog');
      await expect(dialog.getByText('1 / 2', { exact: true })).toBeVisible();
      await dialog.getByRole('button', { name: '下一张' }).click();
      await expect(dialog.getByText('2 / 2', { exact: true })).toBeVisible();
      await libraryPage.keyboard.press('Escape');

      // 原生取消收藏 -> 移入回收站
      await xhsPage.click('#mock-xhs-uncollect');
      await libraryPage.getByTestId('sidebar-more-toggle').click();
      await expect(
        libraryPage.locator('aside').getByRole('button', { name: /^回收站/ }),
      ).toContainText('1', { timeout: 10_000 });

      expect(pageErrors).toEqual([]);
    } finally {
      await tracker.dispose();
    }
  });
});
