import { expect, test } from './fixtures/extension.ts';
import {
  installZhihuMockRoutes,
  MOCK_ZHIHU_ANSWER_ID,
  MOCK_ZHIHU_ANSWER_TITLE,
  MOCK_ZHIHU_ARTICLE_ID,
  MOCK_ZHIHU_ARTICLE_TITLE,
  MOCK_ZHIHU_QUESTION_ID,
  MOCK_ZHIHU_ZVIDEO_ID,
  MOCK_ZHIHU_ZVIDEO_TITLE,
} from './fixtures/zhihu-mock.ts';

test.describe('Collect+ 知乎独立插件全链路 E2E 验证', () => {
  test('知乎回答采集（js-initialData + 多张原图 + 离线文章阅读 + 离线评论）', async ({
    context,
    extensionUrl,
    pageErrors,
  }) => {
    const tracker = await installZhihuMockRoutes(context);
    try {
      const answerPage = await context.newPage();
      await answerPage.goto(
        `https://www.zhihu.com/question/${MOCK_ZHIHU_QUESTION_ID}/answer/${MOCK_ZHIHU_ANSWER_ID}`,
        { waitUntil: 'domcontentloaded' },
      );

      const fabBtn = answerPage.locator('button.cp-fab-btn');
      await expect(fabBtn).toBeVisible();
      await fabBtn.click();

      // 验证下载了 data-original 与 data-actualsrc 两张高清原图（未回退缩略图）
      await expect
        .poll(() =>
          tracker.requestedMediaUrls.some((u) =>
            u.includes('mock-answer-img-01.png'),
          ),
        )
        .toBe(true);
      await expect
        .poll(() =>
          tracker.requestedMediaUrls.some((u) =>
            u.includes('mock-answer-img-02.png'),
          ),
        )
        .toBe(true);
      expect(
        tracker.requestedMediaUrls.some((u) =>
          u.includes('mock-answer-thumb-01.png'),
        ),
      ).toBe(false);

      const libraryPage = await context.newPage();
      await libraryPage.goto(extensionUrl('library.html'));
      await libraryPage
        .getByRole('group', { name: '来源平台筛选' })
        .getByRole('button', { name: '知乎', exact: true })
        .click();

      const card = libraryPage
        .locator('article')
        .filter({ hasText: MOCK_ZHIHU_ANSWER_TITLE });
      await expect(card).toBeVisible();
      await expect(card.getByText('待同步')).toBeVisible({ timeout: 15_000 });

      await card.click();
      const dialog = libraryPage.getByRole('dialog');
      await expect(dialog).toBeVisible();
      await expect(dialog.getByText('离线文章阅读')).toBeVisible();
      await expect(
        dialog.locator('article').getByText(/本地优先架构核心在于把硬盘目录作为唯一真相源/),
      ).toBeVisible();
      // 底部应展示 2 张离线原图缩略图切换条
      await expect(dialog.getByAltText('缩略图 2')).toBeVisible();

      // 切换评论标签页验证离线评论
      const commentsTab = dialog.getByRole('tab', { name: /评论/ });
      await expect(commentsTab).toBeVisible({ timeout: 15_000 });
      await commentsTab.click();
      await expect(
        dialog.getByText('知乎高赞评论：思路非常清晰！'),
      ).toBeVisible({ timeout: 15_000 });

      expect(pageErrors).toEqual([]);
    } finally {
      await tracker.dispose();
    }
  });

  test('知乎专栏原生收藏/取消收藏拦截 + 知乎视频（ZVideo）高清 MP4 离线播放', async ({
    context,
    extensionUrl,
    pageErrors,
  }) => {
    const tracker = await installZhihuMockRoutes(context);
    try {
      // 1. 开启「取消收藏时同步至插件」
      const libraryPage = await context.newPage();
      await libraryPage.goto(extensionUrl('library.html'));
      await libraryPage.getByRole('button', { name: '设置', exact: true }).click();
      const uncollectSwitch = libraryPage.getByRole('switch', {
        name: '取消收藏时同步至插件',
      });
      await uncollectSwitch.click();
      await expect(uncollectSwitch).toHaveAttribute('aria-checked', 'true');

      // 2. 知乎专栏页原生收藏与取消收藏
      const articlePage = await context.newPage();
      await articlePage.goto(
        `https://zhuanlan.zhihu.com/p/${MOCK_ZHIHU_ARTICLE_ID}`,
        { waitUntil: 'domcontentloaded' },
      );
      await expect(articlePage.locator('button.cp-fab-btn')).toBeVisible();
      await articlePage.click('#mock-zhihu-collect');

      await libraryPage.getByRole('button', { name: /全部收藏/ }).click();
      const articleCard = libraryPage
        .locator('article')
        .filter({ hasText: MOCK_ZHIHU_ARTICLE_TITLE });
      await expect(articleCard).toBeVisible({ timeout: 15_000 });
      await expect(articleCard.getByText('待同步')).toBeVisible({
        timeout: 15_000,
      });

      await articlePage.click('#mock-zhihu-uncollect');
      await expect(
        libraryPage.locator('aside').getByRole('button', { name: /^回收站/ }),
      ).toContainText('1', { timeout: 10_000 });

      // 3. 知乎视频页（ZVideo）采集，验证优先选择 FHD MP4 并离线播放
      const zvideoPage = await context.newPage();
      await zvideoPage.goto(
        `https://www.zhihu.com/zvideo/${MOCK_ZHIHU_ZVIDEO_ID}`,
        { waitUntil: 'domcontentloaded' },
      );
      await zvideoPage.locator('button.cp-fab-btn').click();

      await expect
        .poll(() =>
          tracker.requestedMediaUrls.some((u) =>
            u.includes('mock-zhihu-fhd.mp4'),
          ),
        )
        .toBe(true);

      const zvideoCard = libraryPage
        .locator('article')
        .filter({ hasText: MOCK_ZHIHU_ZVIDEO_TITLE });
      await expect(zvideoCard).toBeVisible({ timeout: 15_000 });
      await expect(zvideoCard.getByText('待同步')).toBeVisible({
        timeout: 15_000,
      });

      await zvideoCard.click();
      const dialog = libraryPage.getByRole('dialog');
      const videoEl = dialog.locator('video');
      await expect(videoEl).toBeVisible();
      await expect(videoEl).toHaveAttribute('src', /^blob:/);

      expect(pageErrors).toEqual([]);
    } finally {
      await tracker.dispose();
    }
  });
});
