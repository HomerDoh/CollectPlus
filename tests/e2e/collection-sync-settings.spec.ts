import { expect, test } from './fixtures/extension.ts';
import {
  buildMockVideoAweme,
  installDouyinMockRoutes,
  MOCK_VIDEO_AWEME_ID,
  MOCK_VIDEO_TITLE,
  type MockLoggedInUser,
} from './fixtures/douyin-mock.ts';

test.describe('Collect+ 自动同步全部收藏与取消收藏同步闭环验证', () => {
  test('总开关关闭时首次进入已登录网页弹窗询问：暂不同步后不再打扰，切换账号重新弹窗并确认多页同步', async ({
    context,
    extensionUrl,
    pageErrors,
  }) => {
    let currentUser: MockLoggedInUser | null = {
      uid: '900001',
      nickname: '测试账号甲',
    };

    const page1Items = [
      buildMockVideoAweme('7490000000000001001', '全量同步第1页作品A #同步测试'),
      buildMockVideoAweme('7490000000000001002', '全量同步第1页作品B #同步测试'),
    ];
    const page2Items = [
      buildMockVideoAweme('7490000000000001003', '全量同步第2页作品C #同步测试'),
    ];

    const tracker = await installDouyinMockRoutes(context, {
      getLoggedInUser: () => currentUser,
      handleListCollection: (cursor) => {
        if (cursor === '0') {
          return {
            body: {
              status_code: 0,
              aweme_list: page1Items,
              has_more: 1,
              cursor: 20,
            },
          };
        }
        return {
          body: {
            status_code: 0,
            aweme_list: page2Items,
            has_more: 0,
            cursor: 40,
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

      // 1. 总开关默认关闭：首次进入已登录网页出现 Shadow DOM 询问弹窗
      const promptCard = douyinPage.getByTestId('cp-sync-prompt');
      await expect(promptCard).toBeVisible({ timeout: 10_000 });
      await expect(promptCard).toContainText('测试账号甲');

      // 点击「暂不同步」后弹窗消失，刷新页面不再重复弹窗，且未调用收藏列表接口
      await promptCard.getByRole('button', { name: '暂不同步', exact: true }).click();
      await expect(promptCard).toHaveCount(0);
      expect(tracker.listCollectionRequests).toBe(0);

      await douyinPage.reload({ waitUntil: 'domcontentloaded' });
      await douyinPage.waitForTimeout(500);
      await expect(douyinPage.getByTestId('cp-sync-prompt')).toHaveCount(0);

      // 2. 切换已登录账号 -> 重新弹出询问卡片 -> 点击「立即同步」拉取两页全部收藏
      currentUser = { uid: '900002', nickname: '测试账号乙' };
      await douyinPage.reload({ waitUntil: 'domcontentloaded' });

      const secondPrompt = douyinPage.getByTestId('cp-sync-prompt');
      await expect(secondPrompt).toBeVisible({ timeout: 10_000 });
      await expect(secondPrompt).toContainText('测试账号乙');

      await secondPrompt.getByRole('button', { name: '立即同步' }).click();
      await expect(secondPrompt).toHaveCount(0);

      // 等待两页拉取完成（含分页节流间隔）
      await expect
        .poll(() => tracker.listCollectionRequests, { timeout: 15_000 })
        .toBe(2);
      await expect(douyinPage.getByTestId('cp-sync-banner')).toContainText(
        '共扫描 3 条',
        { timeout: 15_000 },
      );

      // 打开管理台验证 3 条历史收藏全部落入索引并离线暂存
      const libraryPage = await context.newPage();
      await libraryPage.goto(extensionUrl('library.html'));
      await expect(libraryPage.getByText('全量同步第1页作品A')).toBeVisible({
        timeout: 20_000,
      });
      await expect(libraryPage.getByText('全量同步第1页作品B')).toBeVisible({
        timeout: 20_000,
      });
      await expect(libraryPage.getByText('全量同步第2页作品C')).toBeVisible({
        timeout: 20_000,
      });

      // 同一账号刷新不再弹窗也不再重复拉取
      await douyinPage.reload({ waitUntil: 'domcontentloaded' });
      await douyinPage.waitForTimeout(500);
      await expect(douyinPage.getByTestId('cp-sync-prompt')).toHaveCount(0);
      expect(tracker.listCollectionRequests).toBe(2);

      expect(pageErrors).toEqual([]);
    } finally {
      await tracker.dispose();
    }
  });

  test('开启「自动同步全部收藏」总开关后首次进入已登录网页直接静默自动同步，无询问弹窗', async ({
    context,
    extensionUrl,
    pageErrors,
  }) => {
    const tracker = await installDouyinMockRoutes(context, {
      getLoggedInUser: () => ({ uid: '900010', nickname: '自动同步用户' }),
      handleListCollection: () => ({
        body: {
          status_code: 0,
          aweme_list: [
            buildMockVideoAweme('7490000000000002001', '自动全量同步视频1'),
            buildMockVideoAweme('7490000000000002002', '自动全量同步视频2'),
          ],
          has_more: 0,
          cursor: 20,
        },
      }),
    });

    try {
      // 在设置页开启「自动同步全部收藏」总开关
      const libraryPage = await context.newPage();
      await libraryPage.goto(extensionUrl('library.html'));
      await libraryPage.getByRole('button', { name: '设置', exact: true }).click();

      const autoSyncAllSwitch = libraryPage.getByRole('switch', {
        name: '自动同步全部收藏',
      });
      await expect(autoSyncAllSwitch).toHaveAttribute('aria-checked', 'false');
      await autoSyncAllSwitch.click();
      await expect(autoSyncAllSwitch).toHaveAttribute('aria-checked', 'true');

      // 首次进入已登录抖音页面：不出现询问弹窗，直接自动拉取全部收藏
      const douyinPage = await context.newPage();
      await douyinPage.goto(
        `https://www.douyin.com/video/${MOCK_VIDEO_AWEME_ID}`,
        { waitUntil: 'domcontentloaded' },
      );

      await expect
        .poll(() => tracker.listCollectionRequests, { timeout: 15_000 })
        .toBe(1);
      await expect(douyinPage.getByTestId('cp-sync-prompt')).toHaveCount(0);

      // 回到管理台确认两条视频均已入库
      await libraryPage.getByRole('button', { name: /全部收藏/ }).click();
      await expect(libraryPage.getByText('自动全量同步视频1')).toBeVisible({
        timeout: 20_000,
      });
      await expect(libraryPage.getByText('自动全量同步视频2')).toBeVisible({
        timeout: 20_000,
      });

      // 再次刷新页面不会重复触发全量拉取
      await douyinPage.reload({ waitUntil: 'domcontentloaded' });
      await douyinPage.waitForTimeout(500);
      expect(tracker.listCollectionRequests).toBe(1);

      expect(pageErrors).toEqual([]);
    } finally {
      await tracker.dispose();
    }
  });

  test('主动拉取遇风控错误立即中止并提示被动旁路兜底，页面自然加载收藏列表后自动入库', async ({
    context,
    extensionUrl,
    pageErrors,
  }) => {
    let returnRiskError = true;

    const tracker = await installDouyinMockRoutes(context, {
      getLoggedInUser: () => ({ uid: '900020', nickname: '风控测试账号' }),
      handleListCollection: () => {
        if (returnRiskError) {
          return {
            body: {
              status_code: 2154,
              status_msg: 'verify required',
            },
          };
        }
        return {
          body: {
            status_code: 0,
            aweme_list: [
              buildMockVideoAweme('7490000000000003001', '被动旁路兜底同步作品'),
            ],
            has_more: 0,
            cursor: 20,
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

      const promptCard = douyinPage.getByTestId('cp-sync-prompt');
      await expect(promptCard).toBeVisible({ timeout: 10_000 });
      await promptCard.getByRole('button', { name: '立即同步' }).click();

      // 触发风控后立即中止主动拉取并展示被动旁路同步引导横幅
      const banner = douyinPage.getByTestId('cp-sync-banner');
      await expect(banner).toBeVisible({ timeout: 10_000 });
      await expect(banner).toContainText('已切换为被动旁路同步模式');
      await expect(
        banner.getByRole('button', { name: /前往「我的收藏」页被动同步/ }),
      ).toBeVisible();
      expect(tracker.listCollectionRequests).toBe(1);

      // 模拟用户在「我的收藏」页自然触发 listcollection 响应，被动旁路入库
      returnRiskError = false;
      await douyinPage.evaluate(async () => {
        const win = window as unknown as {
          __mockTriggerPassiveListCollection?: (cursor?: number) => Promise<unknown>;
        };
        await win.__mockTriggerPassiveListCollection?.(0);
      });

      const libraryPage = await context.newPage();
      await libraryPage.goto(extensionUrl('library.html'));
      await expect(libraryPage.getByText('被动旁路兜底同步作品')).toBeVisible({
        timeout: 20_000,
      });

      expect(pageErrors).toEqual([]);
    } finally {
      await tracker.dispose();
    }
  });

  test('「取消收藏时同步至插件」开关控制：关闭时忽略，开启后自动移入回收站，再收藏原地恢复', async ({
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
      await expect(douyinPage.locator('button.cp-fab-btn')).toBeVisible();

      // 先加载详情并触发原生收藏
      await douyinPage.click('#mock-load-detail');
      await expect
        .poll(async () =>
          douyinPage.evaluate(() => {
            const win = window as unknown as { __mockDetailLoaded?: boolean };
            return Boolean(win.__mockDetailLoaded);
          }),
        )
        .toBe(true);
      await douyinPage.click('#mock-native-collect');

      const libraryPage = await context.newPage();
      await libraryPage.goto(extensionUrl('library.html'));
      await expect(libraryPage.getByText(MOCK_VIDEO_TITLE)).toBeVisible({
        timeout: 20_000,
      });
      await expect(
        libraryPage.locator('article').getByText('待同步'),
      ).toBeVisible({ timeout: 20_000 });

      // 1. 开关默认关闭时：原站取消收藏（action=0），插件条目保持在「全部收藏」中
      await douyinPage.click('#mock-native-uncollect');
      await douyinPage.waitForTimeout(500);
      await expect(libraryPage.getByText(MOCK_VIDEO_TITLE)).toBeVisible();

      // 2. 在设置页开启「取消收藏时同步至插件」
      await libraryPage.getByRole('button', { name: '设置', exact: true }).click();
      const uncollectSwitch = libraryPage.getByRole('switch', {
        name: '取消收藏时同步至插件',
      });
      await expect(uncollectSwitch).toHaveAttribute('aria-checked', 'false');
      await uncollectSwitch.click();
      await expect(uncollectSwitch).toHaveAttribute('aria-checked', 'true');

      // 返回「全部收藏」视图后在原站触发取消收藏 -> 条目即时消失并进入回收站
      await libraryPage.getByRole('button', { name: /全部收藏/ }).click();
      await expect(libraryPage.getByText(MOCK_VIDEO_TITLE)).toBeVisible();

      await douyinPage.click('#mock-native-uncollect');
      await expect(libraryPage.getByText(MOCK_VIDEO_TITLE)).toHaveCount(0, {
        timeout: 10_000,
      });

      await libraryPage.getByRole('button', { name: /回收站/ }).click();
      await expect(libraryPage.getByText(MOCK_VIDEO_TITLE)).toBeVisible({
        timeout: 10_000,
      });

      // 3. 在原站重新收藏 -> 条目自动从回收站原地恢复到「全部收藏」
      await douyinPage.click('#mock-native-collect');
      await libraryPage.getByRole('button', { name: /全部收藏/ }).click();
      await expect(libraryPage.getByText(MOCK_VIDEO_TITLE)).toBeVisible({
        timeout: 10_000,
      });

      expect(pageErrors).toEqual([]);
    } finally {
      await tracker.dispose();
    }
  });
});
