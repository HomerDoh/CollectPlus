import { expect, test } from './fixtures/extension.ts';
import {
  installDouyinMockRoutes,
  MOCK_GALLERY_AWEME_ID,
  MOCK_GALLERY_TITLE,
  MOCK_VIDEO_AWEME_ID,
  MOCK_VIDEO_TITLE,
} from './fixtures/douyin-mock.ts';

interface VaultInspectionResult {
  hasReadme: boolean;
  readmeHasWarning: boolean;
  hasVaultConfig: boolean;
  hasTaxonomy: boolean;
  metaFilesCount: number;
  metaHasThumbnailDataUrl: boolean;
  videoFileSize: number;
  stageStillExists: boolean;
}

test.describe('Collect+ 核心基本功能全量 E2E 验证', () => {
  test('Alt+S 快捷键采集 -> 重复采集去重 -> Popup 实时统计与打开管理台', async ({
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

      // 加载视频详情写入 Main World LRU 缓存
      await douyinPage.click('#mock-load-detail');
      await expect
        .poll(async () =>
          douyinPage.evaluate(() => {
            const win = window as unknown as { __mockDetailLoaded?: boolean };
            return Boolean(win.__mockDetailLoaded);
          }),
        )
        .toBe(true);

      // 使用页面内 Alt+S 快捷键触发采集
      await douyinPage.keyboard.press('Alt+s');

      const toastCard = douyinPage.locator('.cp-toast-card');
      await expect(toastCard).toBeVisible();
      await expect(toastCard.getByText(MOCK_VIDEO_TITLE)).toBeVisible();
      await expect(toastCard.getByText('已离线暂存')).toBeVisible({
        timeout: 20_000,
      });

      // 等待超过 600ms 节流窗口后再次点击悬浮按钮，验证去重机制（不重复创建条目）
      await douyinPage.waitForTimeout(700);
      await douyinPage.locator('button.cp-fab-btn').click();
      await expect(toastCard.getByText('已在收藏库')).toBeVisible();

      // 打开 Popup 验证统计卡（总收藏 1 / 待同步 1 / 下载中 0）
      const popupPage = await context.newPage();
      await popupPage.goto(extensionUrl('popup.html'));
      await expect(
        popupPage.getByRole('heading', { name: 'Collect+' }),
      ).toBeVisible();

      const statValues = popupPage.locator('section.grid span.text-lg');
      await expect(statValues.nth(0)).toHaveText('1');
      await expect(statValues.nth(1)).toHaveText('1');
      await expect(statValues.nth(2)).toHaveText('0');

      // 点击「打开 Collect+ 全屏管理台」验证正常拉起 library.html 且仅存在 1 条记录
      const newPagePromise = context.waitForEvent('page');
      await popupPage
        .getByRole('button', { name: /打开 Collect\+ 全屏管理台/ })
        .click();
      const openedLibraryPage = await newPagePromise;
      await openedLibraryPage.waitForLoadState('domcontentloaded');
      expect(openedLibraryPage.url()).toContain('/library.html');
      await expect(openedLibraryPage.locator('article')).toHaveCount(1);
      await expect(
        openedLibraryPage.getByText(MOCK_VIDEO_TITLE),
      ).toBeVisible();

      expect(pageErrors).toEqual([]);
    } finally {
      await tracker.dispose();
    }
  });

  test('管理台多维筛选、视图切换、软删除回收站恢复与 SidePanel 直达详情抽屉', async ({
    context,
    extensionUrl,
    pageErrors,
  }) => {
    const tracker = await installDouyinMockRoutes(context);
    try {
      // 1. 先采集 1 条视频 + 1 条图集
      const videoPage = await context.newPage();
      await videoPage.goto(
        `https://www.douyin.com/video/${MOCK_VIDEO_AWEME_ID}`,
        { waitUntil: 'domcontentloaded' },
      );
      await expect(videoPage.locator('button.cp-fab-btn')).toBeVisible();
      await videoPage.click('#mock-load-detail');
      await expect
        .poll(async () =>
          videoPage.evaluate(() => {
            const win = window as unknown as { __mockDetailLoaded?: boolean };
            return Boolean(win.__mockDetailLoaded);
          }),
        )
        .toBe(true);
      await videoPage.locator('button.cp-fab-btn').click();
      await expect(
        videoPage.locator('.cp-toast-card').getByText('已离线暂存'),
      ).toBeVisible({ timeout: 20_000 });

      const galleryPage = await context.newPage();
      await galleryPage.goto(
        `https://www.douyin.com/note/${MOCK_GALLERY_AWEME_ID}`,
        { waitUntil: 'domcontentloaded' },
      );
      await expect(galleryPage.locator('button.cp-fab-btn')).toBeVisible();
      await galleryPage.click('#mock-load-detail');
      await expect
        .poll(async () =>
          galleryPage.evaluate(() => {
            const win = window as unknown as { __mockDetailLoaded?: boolean };
            return Boolean(win.__mockDetailLoaded);
          }),
        )
        .toBe(true);
      await galleryPage.click('#mock-native-collect');
      await expect(
        galleryPage.locator('.cp-toast-card').getByText('已离线暂存'),
      ).toBeVisible({ timeout: 20_000 });

      // 2. 在 SidePanel 验证 2 条最近收藏，并点击图集直达 Library 详情抽屉
      const sidePanelPage = await context.newPage();
      await sidePanelPage.goto(extensionUrl('sidepanel.html'));
      await expect(
        sidePanelPage.getByText('2 条内容待同步至 CollectVault'),
      ).toBeVisible();
      await expect(sidePanelPage.getByText(MOCK_VIDEO_TITLE)).toBeVisible();
      await expect(sidePanelPage.getByText(MOCK_GALLERY_TITLE)).toBeVisible();

      const libraryPagePromise = context.waitForEvent('page');
      await sidePanelPage
        .getByRole('button', { name: new RegExp(MOCK_GALLERY_TITLE) })
        .click();
      const libraryPage = await libraryPagePromise;
      await libraryPage.waitForLoadState('domcontentloaded');
      expect(libraryPage.url()).toContain('/library.html#item=');

      // 验证自动弹出该图集的离线详情抽屉
      const autoDialog = libraryPage.getByRole('dialog');
      await expect(autoDialog).toBeVisible();
      await expect(autoDialog.getByText('离线图集画廊 (1 / 2)')).toBeVisible();
      await autoDialog.getByRole('button', { name: '关闭详情' }).click();
      await expect(autoDialog).toBeHidden();

      // 3. 验证媒体类型筛选（全部 2 -> 仅视频 1 -> 仅图集 1 -> 全部 2）
      await expect(libraryPage.locator('article')).toHaveCount(2);

      const sidebar = libraryPage.locator('aside');
      await sidebar.getByRole('button', { name: '视频', exact: true }).click();
      await expect(libraryPage.locator('article')).toHaveCount(1);
      await expect(libraryPage.getByText(MOCK_VIDEO_TITLE)).toBeVisible();

      await sidebar.getByRole('button', { name: '图集', exact: true }).click();
      await expect(libraryPage.locator('article')).toHaveCount(1);
      await expect(libraryPage.getByText(MOCK_GALLERY_TITLE)).toBeVisible();

      await sidebar.getByRole('button', { name: '全部', exact: true }).click();
      await expect(libraryPage.locator('article')).toHaveCount(2);

      // 4. 验证卡片网格 / 紧凑列表视图切换
      await libraryPage.getByTitle('紧凑列表视图').click();
      await expect(libraryPage.locator('article')).toHaveCount(2);
      await libraryPage.getByTitle('卡片网格视图').click();
      await expect(libraryPage.locator('article')).toHaveCount(2);

      // 5. 验证在侧边栏新建文件夹、软删除视频移入回收站并从回收站一键恢复
      await sidebar.getByTitle('新建顶级文件夹').click();
      const folderInput = sidebar.getByPlaceholder('输入文件夹名称');
      await folderInput.fill('精选素材');
      await folderInput.press('Enter');
      await expect(sidebar.getByText('精选素材')).toBeVisible();

      // 移入回收站
      const videoCard = libraryPage
        .locator('article')
        .filter({ hasText: MOCK_VIDEO_TITLE });
      await videoCard.hover();
      await videoCard.getByTitle('移入回收站').click();
      await expect(libraryPage.locator('article')).toHaveCount(1);

      // 切换至回收站视图并恢复
      await sidebar.getByRole('button', { name: /回收站/ }).click();
      await expect(libraryPage.locator('article')).toHaveCount(1);
      await expect(libraryPage.getByText(MOCK_VIDEO_TITLE)).toBeVisible();

      const trashedCard = libraryPage
        .locator('article')
        .filter({ hasText: MOCK_VIDEO_TITLE });
      await trashedCard.hover();
      await trashedCard.getByTitle('从回收站恢复').click();
      await expect(libraryPage.getByText('回收站为空')).toBeVisible();

      // 返回全部收藏确认恢复为 2 条
      await sidebar.getByRole('button', { name: /全部收藏/ }).click();
      await expect(libraryPage.locator('article')).toHaveCount(2);

      expect(pageErrors).toEqual([]);
    } finally {
      await tracker.dispose();
    }
  });

  test('CollectVault 落盘同步、README.txt 与纯净 meta.json 守护、清空缓存与容灾重建索引', async ({
    context,
    extensionUrl,
    pageErrors,
  }) => {
    const tracker = await installDouyinMockRoutes(context);
    try {
      // 1. 采集 1 条视频并在 Toast 内新建分类文件夹
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
      const toastCard = douyinPage.locator('.cp-toast-card');
      await expect(toastCard.getByText('已离线暂存')).toBeVisible({
        timeout: 20_000,
      });

      await toastCard.getByRole('button', { name: '新建' }).click();
      await toastCard
        .getByPlaceholder('输入新文件夹名称...')
        .fill('容灾验证目录');
      await toastCard.getByRole('button', { name: '确定' }).click();
      await expect(toastCard.getByText('已保存')).toBeVisible();

      // 2. 打开 Library，注入基于原生 OPFS 目录句柄的 showDirectoryPicker Mock
      const libraryPage = await context.newPage();
      await libraryPage.addInitScript(() => {
        const win = window as unknown as {
          showDirectoryPicker?: () => Promise<FileSystemDirectoryHandle>;
        };
        win.showDirectoryPicker = async () => {
          const root = await navigator.storage.getDirectory();
          return root.getDirectoryHandle('CollectVault', { create: true });
        };
      });

      await libraryPage.goto(extensionUrl('library.html'));
      await expect(libraryPage.getByText(MOCK_VIDEO_TITLE)).toBeVisible();
      await expect(
        libraryPage.getByRole('button', {
          name: '选择 / 初始化 CollectVault 目录',
        }),
      ).toBeVisible();

      // 3. 绑定 CollectVault 目录并自动落盘同步
      await libraryPage
        .getByRole('button', { name: '选择 / 初始化 CollectVault 目录' })
        .click();

      await expect(libraryPage.getByText('CollectVault 已就绪')).toBeVisible();
      await expect(
        libraryPage.getByText(/同步完成：落盘媒体条目\s*1\s*条/),
      ).toBeVisible({ timeout: 20_000 });
      await expect(libraryPage.locator('article').getByText('已同步')).toBeVisible();

      // 4. 校验 CollectVault 落盘文件结构、README.txt 守护、纯净 meta.json（无 thumbnailDataUrl）与 OPFS 暂存清理
      const inspection = await libraryPage.evaluate(
        async (): Promise<VaultInspectionResult> => {
          const opfsRoot = await navigator.storage.getDirectory();
          const vaultRoot = await opfsRoot.getDirectoryHandle('CollectVault', {
            create: false,
          });

          const readTextSafe = async (
            dir: FileSystemDirectoryHandle,
            name: string,
          ): Promise<string | null> => {
            try {
              const fh = await dir.getFileHandle(name, { create: false });
              const file = await fh.getFile();
              return await file.text();
            } catch {
              return null;
            }
          };

          const readmeText = await readTextSafe(vaultRoot, 'README.txt');
          const vaultConfigText = await readTextSafe(
            vaultRoot,
            '.collect-vault.json',
          );
          const taxonomyText = await readTextSafe(vaultRoot, 'taxonomy.json');

          let metaFilesCount = 0;
          let metaHasThumbnailDataUrl = false;
          let videoFileSize = 0;

          const walk = async (dir: FileSystemDirectoryHandle): Promise<void> => {
            for await (const [name, handle] of dir.entries()) {
              if (handle.kind === 'directory') {
                await walk(handle);
              } else if (handle.kind === 'file') {
                if (name === 'meta.json') {
                  metaFilesCount += 1;
                  const file = await handle.getFile();
                  const parsed: unknown = JSON.parse(await file.text());
                  if (
                    typeof parsed === 'object' &&
                    parsed !== null &&
                    'thumbnailDataUrl' in parsed
                  ) {
                    metaHasThumbnailDataUrl = true;
                  }
                } else if (name === 'video.mp4') {
                  const file = await handle.getFile();
                  videoFileSize = file.size;
                }
              }
            }
          };

          const itemsDir = await vaultRoot.getDirectoryHandle('items', {
            create: false,
          });
          await walk(itemsDir);

          let stageStillExists = false;
          try {
            const stageRoot = await opfsRoot.getDirectoryHandle(
              'collect-plus-stage',
              { create: false },
            );
            for await (const _entry of stageRoot.entries()) {
              void _entry;
              stageStillExists = true;
              break;
            }
          } catch {
            stageStillExists = false;
          }

          return {
            hasReadme: Boolean(readmeText && readmeText.length > 0),
            readmeHasWarning: Boolean(
              readmeText && readmeText.includes('请勿手动重命名'),
            ),
            hasVaultConfig: Boolean(vaultConfigText),
            hasTaxonomy: Boolean(
              taxonomyText && taxonomyText.includes('容灾验证目录'),
            ),
            metaFilesCount,
            metaHasThumbnailDataUrl,
            videoFileSize,
            stageStillExists,
          };
        },
      );

      expect(inspection.hasReadme).toBe(true);
      expect(inspection.readmeHasWarning).toBe(true);
      expect(inspection.hasVaultConfig).toBe(true);
      expect(inspection.hasTaxonomy).toBe(true);
      expect(inspection.metaFilesCount).toBe(1);
      expect(inspection.metaHasThumbnailDataUrl).toBe(false);
      expect(inspection.videoFileSize).toBeGreaterThan(0);
      expect(inspection.stageStillExists).toBe(false);

      // 5. 清空浏览器缓存索引（确认不删硬盘文件且保留目录绑定，触发重建引导）
      await libraryPage
        .getByRole('button', { name: '清空浏览器缓存索引' })
        .click();
      await libraryPage
        .getByRole('button', { name: '确认清空浏览器索引' })
        .click();

      await expect(libraryPage.getByText('还没有收藏任何作品')).toBeVisible();
      await expect(
        libraryPage.getByRole('button', { name: '立即重建索引' }),
      ).toBeVisible();

      // 6. 点击「立即重建索引」从 CollectVault 完整恢复条目、文件夹、标签与离线视频播放
      await libraryPage.getByRole('button', { name: '立即重建索引' }).click();
      await expect(
        libraryPage.getByText(/索引重建成功：已恢复\s*1\s*条收藏/),
      ).toBeVisible({ timeout: 20_000 });

      await expect(libraryPage.getByText(MOCK_VIDEO_TITLE)).toBeVisible();
      await expect(
        libraryPage.locator('aside').getByText('容灾验证目录'),
      ).toBeVisible();

      // 打开重建后的条目抽屉，验证直接从 CollectVault 离线读取视频生成 blob: URL
      await libraryPage.locator('article').first().click();
      const dialog = libraryPage.getByRole('dialog');
      await expect(dialog).toBeVisible();
      const videoEl = dialog.locator('video');
      await expect(videoEl).toBeVisible();
      expect(await videoEl.getAttribute('src')).toMatch(
        /^blob:chrome-extension:\/\//,
      );

      expect(pageErrors).toEqual([]);
    } finally {
      await tracker.dispose();
    }
  });
});
