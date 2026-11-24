import { expect, test } from './fixtures/extension.ts';
import {
  installDouyinMockRoutes,
  MOCK_GALLERY_AWEME_ID,
  MOCK_GALLERY_TITLE,
  MOCK_VIDEO_AWEME_ID,
  MOCK_VIDEO_TITLE,
} from './fixtures/douyin-mock.ts';

test.describe('Collect+ 抖音全链路采集、OPFS 离线暂存与管理台验证', () => {
  test('悬浮按钮采集视频 -> 快捷分类标签 -> 侧边栏与管理台离线播放及状态机不变量校验', async ({
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

      // 确认 Shadow DOM 悬浮采集按钮已成功注入宿主页面
      const fabButton = douyinPage.locator('button.cp-fab-btn');
      await expect(fabButton).toBeVisible();

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

      // 点击 Shadow DOM 内「收藏当前」按钮
      await fabButton.click();

      // 验证 Toast 卡片出现并最终完成 Offscreen 下载写入 OPFS
      const toastCard = douyinPage.locator('.cp-toast-card');
      await expect(toastCard).toBeVisible();
      await expect(toastCard.getByText(MOCK_VIDEO_TITLE)).toBeVisible();
      await expect(toastCard.getByText('已离线暂存')).toBeVisible({
        timeout: 20_000,
      });

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

      // 在 Toast 内联新建分类文件夹并添加自定义标签
      await toastCard.getByRole('button', { name: '新建' }).click();
      await toastCard
        .getByPlaceholder('输入新文件夹名称...')
        .fill('自动化分类');
      await toastCard.getByRole('button', { name: '确定' }).click();
      await expect(toastCard.getByText('已保存')).toBeVisible();

      const tagInput = toastCard.getByPlaceholder('输入标签后回车添加...');
      await tagInput.fill('E2E标签');
      await tagInput.press('Enter');
      await expect(toastCard.getByText('#E2E标签')).toBeVisible();

      // 打开 SidePanel 验证最近收藏与待同步计数
      const sidePanelPage = await context.newPage();
      await sidePanelPage.goto(extensionUrl('sidepanel.html'));
      await expect(sidePanelPage.getByText(MOCK_VIDEO_TITLE)).toBeVisible();
      await expect(
        sidePanelPage.getByText('1 条内容待同步至 CollectVault'),
      ).toBeVisible();

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

  test('抖音原生收藏拦截（action=1）自动触发图集下载与离线画廊翻页验证', async ({
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

      // 模拟抖音原生收藏请求（POST /aweme/v1/web/aweme/collect/ action=1）
      await douyinPage.click('#mock-native-collect');

      // 验证自动弹出 Toast 并完成 2 张图集离线暂存
      const toastCard = douyinPage.locator('.cp-toast-card');
      await expect(toastCard).toBeVisible();
      await expect(toastCard.getByText(MOCK_GALLERY_TITLE)).toBeVisible();
      await expect(toastCard.getByText('图集 2张')).toBeVisible();
      await expect(toastCard.getByText('已离线暂存')).toBeVisible({
        timeout: 20_000,
      });

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

      // 在 Library 中打开图集抽屉验证离线图集画廊与翻页
      const libraryPage = await context.newPage();
      await libraryPage.goto(extensionUrl('library.html'));
      await expect(libraryPage.getByText(MOCK_GALLERY_TITLE)).toBeVisible();
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
});
