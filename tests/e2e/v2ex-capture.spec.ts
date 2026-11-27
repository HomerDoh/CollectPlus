import { expect, test } from './fixtures/extension.ts';
import {
  installV2exMockRoutes,
  MOCK_V2EX_FAV_TOPIC_TITLE,
  MOCK_V2EX_TEXT_ONLY_ID,
  MOCK_V2EX_TEXT_ONLY_TITLE,
  MOCK_V2EX_TOPIC_ID,
  MOCK_V2EX_TOPIC_TITLE,
} from './fixtures/v2ex-mock.ts';

test.describe('Collect+ V2EX 独立收藏插件全链路 E2E 验证', () => {
  test('悬浮按钮采集 V2EX 主题（含附言、内嵌图与回复）-> 管理台离线阅读与筛选', async ({
    context,
    extensionUrl,
    pageErrors,
  }) => {
    const tracker = await installV2exMockRoutes(context);
    try {
      const v2exPage = await context.newPage();
      await v2exPage.goto(`https://www.v2ex.com/t/${MOCK_V2EX_TOPIC_ID}`, {
        waitUntil: 'domcontentloaded',
      });

      const fabButton = v2exPage.locator('button.cp-fab-btn');
      await expect(fabButton).toBeVisible();
      await fabButton.click();

      const libraryPage = await context.newPage();
      await libraryPage.goto(extensionUrl('library.html'));

      await expect(libraryPage.getByText(MOCK_V2EX_TOPIC_TITLE)).toBeVisible({
        timeout: 20_000,
      });
      await expect(
        libraryPage.locator('article').getByText('待同步'),
      ).toBeVisible({ timeout: 20_000 });

      // 按「V2EX」平台筛选与「图文」媒体类型筛选
      const platformGroup = libraryPage.getByRole('group', {
        name: '来源平台筛选',
      });
      await platformGroup
        .getByRole('button', { name: 'V2EX', exact: true })
        .click();
      await expect(libraryPage.locator('article')).toHaveCount(1);

      const mediaKindGroup = libraryPage.getByRole('group', {
        name: '媒体类型筛选',
      });
      await mediaKindGroup
        .getByRole('button', { name: '图文', exact: true })
        .click();
      await expect(libraryPage.locator('article')).toHaveCount(1);

      // 打开详情抽屉验证正文、附言、内嵌图与离线回复
      await libraryPage.locator('article').first().click();
      const dialog = libraryPage.getByRole('dialog');
      await expect(dialog).toBeVisible();
      await expect(dialog.getByText('离线文章阅读')).toBeVisible();
      await expect(
        dialog.locator('article').getByText(/分享一下本地优先浏览器插件的架构经验/),
      ).toBeVisible();
      await expect(
        dialog.locator('article').getByText(/所有数据仅存于本地 CollectVault 目录/),
      ).toBeVisible();
      await expect(dialog.locator('article img')).toHaveAttribute(
        'src',
        /^blob:chrome-extension:\/\//,
      );

      const commentsTab = dialog.getByRole('tab', { name: /评论/ });
      await expect(commentsTab).toBeVisible({ timeout: 15_000 });
      await commentsTab.click();
      await expect(
        dialog.getByText('这个本地优先离线归档方案非常赞，再也不怕帖子 404 了！'),
      ).toBeVisible({ timeout: 15_000 });

      expect(
        tracker.requestedMediaUrls.some((url) =>
          url.includes('topic-diagram-01.png'),
        ),
      ).toBe(true);
      expect(pageErrors).toEqual([]);
    } finally {
      await tracker.dispose();
    }
  });

  test('V2EX 外链图片 404 容错：正文仍成功暂存为 opfs_staged 不误标失败', async ({
    context,
    extensionUrl,
    pageErrors,
  }) => {
    const tracker = await installV2exMockRoutes(context);
    try {
      const v2exPage = await context.newPage();
      await v2exPage.goto(`https://www.v2ex.com/t/${MOCK_V2EX_TEXT_ONLY_ID}`, {
        waitUntil: 'domcontentloaded',
      });

      const fabButton = v2exPage.locator('button.cp-fab-btn');
      await expect(fabButton).toBeVisible();
      await fabButton.click();

      const libraryPage = await context.newPage();
      await libraryPage.goto(extensionUrl('library.html'));

      await expect(libraryPage.getByText(MOCK_V2EX_TEXT_ONLY_TITLE)).toBeVisible({
        timeout: 20_000,
      });
      await expect(
        libraryPage.locator('article').getByText('待同步'),
      ).toBeVisible({ timeout: 20_000 });
      expect(pageErrors).toEqual([]);
    } finally {
      await tracker.dispose();
    }
  });

  test('V2EX 原生点击「加入收藏」与「取消收藏」静默同步与回收站联动', async ({
    context,
    extensionUrl,
    pageErrors,
  }) => {
    const tracker = await installV2exMockRoutes(context);
    try {
      // 开启「取消收藏时同步至插件」
      const libraryPage = await context.newPage();
      await libraryPage.goto(extensionUrl('library.html'));
      await libraryPage.getByRole('button', { name: '设置', exact: true }).click();
      await libraryPage
        .getByRole('switch', { name: '取消收藏时同步至插件' })
        .click();
      await libraryPage.getByRole('button', { name: /全部收藏/ }).click();

      const v2exPage = await context.newPage();
      await v2exPage.goto(`https://www.v2ex.com/t/${MOCK_V2EX_TOPIC_ID}`, {
        waitUntil: 'domcontentloaded',
      });
      await expect(v2exPage.locator('button.cp-fab-btn')).toBeVisible();

      // 点击原生「加入收藏」（触发 302 重定向回 /t/{id}）
      await v2exPage.getByRole('link', { name: '加入收藏' }).click();
      await expect(v2exPage.getByRole('link', { name: '取消收藏' })).toBeVisible();

      await expect(libraryPage.getByText(MOCK_V2EX_TOPIC_TITLE)).toBeVisible({
        timeout: 20_000,
      });

      // 点击原生「取消收藏」-> 条目自动移入回收站
      await v2exPage.getByRole('link', { name: '取消收藏' }).click();
      await expect(v2exPage.getByRole('link', { name: '加入收藏' })).toBeVisible();
      await expect(libraryPage.getByText(MOCK_V2EX_TOPIC_TITLE)).toHaveCount(0, {
        timeout: 15_000,
      });

      await libraryPage.getByRole('button', { name: /回收站/ }).click();
      await expect(libraryPage.getByText(MOCK_V2EX_TOPIC_TITLE)).toBeVisible();

      expect(pageErrors).toEqual([]);
    } finally {
      await tracker.dispose();
    }
  });

  test('V2EX 已登录态首次弹窗确认全量同步 /my/topics 主题收藏', async ({
    context,
    extensionUrl,
    pageErrors,
  }) => {
    const tracker = await installV2exMockRoutes(context, {
      loggedInUser: 'v2ex_tester',
    });
    try {
      const v2exPage = await context.newPage();
      await v2exPage.goto(`https://www.v2ex.com/t/${MOCK_V2EX_TOPIC_ID}`, {
        waitUntil: 'domcontentloaded',
      });

      const syncPrompt = v2exPage.getByTestId('cp-sync-prompt');
      await expect(syncPrompt).toBeVisible({ timeout: 15_000 });
      await expect(syncPrompt).toContainText('检测到已登录V2EX账号（v2ex_tester）');

      await syncPrompt.getByRole('button', { name: '立即同步' }).click();
      await expect(v2exPage.getByTestId('cp-sync-banner')).toContainText(
        '新增 1 条',
        { timeout: 15_000 },
      );

      const libraryPage = await context.newPage();
      await libraryPage.goto(extensionUrl('library.html'));
      await expect(libraryPage.getByText(MOCK_V2EX_FAV_TOPIC_TITLE)).toBeVisible({
        timeout: 20_000,
      });

      expect(tracker.myTopicsRequests).toBeGreaterThanOrEqual(1);
      expect(pageErrors).toEqual([]);
    } finally {
      await tracker.dispose();
    }
  });
});
