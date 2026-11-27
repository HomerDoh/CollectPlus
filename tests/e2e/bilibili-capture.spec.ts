import { expect, test } from './fixtures/extension.ts';
import {
  installBilibiliMockRoutes,
  MOCK_BILI_BVID,
  MOCK_BILI_FAV_TITLE_2,
  MOCK_BILI_TITLE,
} from './fixtures/bilibili-mock.ts';

test.describe('Collect+ Bilibili 独立收藏插件全链路 E2E 验证', () => {
  test('悬浮按钮采集 B站 DASH 视频 -> Mediabunny 无损混流 -> 管理台离线播放与评论查看', async ({
    context,
    extensionUrl,
    pageErrors,
  }) => {
    const tracker = await installBilibiliMockRoutes(context);
    try {
      const biliPage = await context.newPage();
      await biliPage.goto(`https://www.bilibili.com/video/${MOCK_BILI_BVID}`, {
        waitUntil: 'domcontentloaded',
      });

      const fabButton = biliPage.locator('button.cp-fab-btn');
      await expect(fabButton).toBeVisible();
      await fabButton.click();

      const libraryPage = await context.newPage();
      await libraryPage.goto(extensionUrl('library.html'));

      // 等待 DASH 无损混流下载完成并暂存至 OPFS
      await expect(libraryPage.getByText(MOCK_BILI_TITLE)).toBeVisible({
        timeout: 20_000,
      });
      await expect(
        libraryPage.locator('article').getByText('待同步'),
      ).toBeVisible({ timeout: 20_000 });

      // 验证优先选择 AVC/H.264 视频轨与 AAC 音轨，跳过 HEVC
      expect(
        tracker.requestedMediaUrls.some((url) =>
          url.includes(`${MOCK_BILI_BVID}-avc-1080.m4s`),
        ),
      ).toBe(true);
      expect(
        tracker.requestedMediaUrls.some((url) =>
          url.includes(`${MOCK_BILI_BVID}-aac-audio.m4s`),
        ),
      ).toBe(true);
      expect(
        tracker.requestedMediaUrls.some((url) =>
          url.includes(`${MOCK_BILI_BVID}-hevc-1080.m4s`),
        ),
      ).toBe(false);

      // 按「B站」筛选
      const platformGroup = libraryPage.getByRole('group', {
        name: '来源平台筛选',
      });
      await platformGroup.getByRole('button', { name: 'B站', exact: true }).click();
      await expect(libraryPage.locator('article')).toHaveCount(1);

      // 打开详情抽屉验证 blob: 离线播放与离线评论
      await libraryPage.locator('article').first().click();
      const dialog = libraryPage.getByRole('dialog');
      await expect(dialog).toBeVisible();

      const videoEl = dialog.locator('video');
      await expect(videoEl).toBeVisible();
      await expect(videoEl).toHaveAttribute('src', /^blob:chrome-extension:\/\//);

      const commentsTab = dialog.getByRole('tab', { name: /评论/ });
      await expect(commentsTab).toBeVisible({ timeout: 15_000 });
      await commentsTab.click();
      await expect(
        dialog.getByText('DASH 音视频混流太稳了，直接收藏！'),
      ).toBeVisible({ timeout: 15_000 });

      expect(pageErrors).toEqual([]);
    } finally {
      await tracker.dispose();
    }
  });

  test('B站原生收藏与取消收藏（syncUncollectToPlugin 开启）同步验证', async ({
    context,
    extensionUrl,
    pageErrors,
  }) => {
    const tracker = await installBilibiliMockRoutes(context);
    try {
      // 在管理台设置页开启「取消收藏时同步至插件」
      const libraryPage = await context.newPage();
      await libraryPage.goto(extensionUrl('library.html'));
      await libraryPage.getByRole('button', { name: '设置', exact: true }).click();
      const syncUncollectSwitch = libraryPage.getByRole('switch', {
        name: '取消收藏时同步至插件',
      });
      await syncUncollectSwitch.click();
      await expect(syncUncollectSwitch).toHaveAttribute('aria-checked', 'true');
      await libraryPage.getByRole('button', { name: /全部收藏/ }).click();

      const biliPage = await context.newPage();
      await biliPage.goto(`https://www.bilibili.com/video/${MOCK_BILI_BVID}`, {
        waitUntil: 'domcontentloaded',
      });
      await expect(biliPage.locator('button.cp-fab-btn')).toBeVisible();

      // 触发 B站原生收藏 POST /x/v3/fav/resource/deal (add_media_ids)
      await biliPage.click('#mock-bili-fav');
      await expect(libraryPage.getByText(MOCK_BILI_TITLE)).toBeVisible({
        timeout: 20_000,
      });

      // 触发 B站原生取消收藏 POST /x/v3/fav/resource/deal (del_media_ids) -> 自动移入回收站
      await biliPage.click('#mock-bili-unfav');
      await expect(libraryPage.getByText(MOCK_BILI_TITLE)).toHaveCount(0, {
        timeout: 15_000,
      });

      await libraryPage.getByRole('button', { name: /回收站/ }).click();
      await expect(libraryPage.getByText(MOCK_BILI_TITLE)).toBeVisible();

      expect(pageErrors).toEqual([]);
    } finally {
      await tracker.dispose();
    }
  });

  test('B站已登录账号首次同步弹窗确认全量拉取收藏夹', async ({
    context,
    extensionUrl,
    pageErrors,
  }) => {
    const tracker = await installBilibiliMockRoutes(context, {
      loggedInUser: { mid: 556677, uname: 'B站登录用户' },
    });
    try {
      const biliPage = await context.newPage();
      await biliPage.goto(`https://www.bilibili.com/video/${MOCK_BILI_BVID}`, {
        waitUntil: 'domcontentloaded',
      });

      const syncPrompt = biliPage.getByTestId('cp-sync-prompt');
      await expect(syncPrompt).toBeVisible({ timeout: 15_000 });
      await expect(syncPrompt).toContainText('检测到已登录B站账号（B站登录用户）');

      await syncPrompt.getByRole('button', { name: '立即同步' }).click();
      await expect(biliPage.getByTestId('cp-sync-banner')).toContainText(
        '新增 1 条',
        { timeout: 15_000 },
      );

      const libraryPage = await context.newPage();
      await libraryPage.goto(extensionUrl('library.html'));
      await expect(libraryPage.getByText(MOCK_BILI_FAV_TITLE_2)).toBeVisible({
        timeout: 20_000,
      });

      expect(tracker.favListRequests).toBeGreaterThanOrEqual(1);
      expect(pageErrors).toEqual([]);
    } finally {
      await tracker.dispose();
    }
  });
});
