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

      // 使用页面内 Alt+S 快捷键触发静默采集，确认不出现页面弹窗
      await douyinPage.keyboard.press('Alt+s');
      await expect(douyinPage.locator('.cp-toast-card')).toHaveCount(0);

      // 等待超过 600ms 节流窗口后再次点击悬浮按钮，验证去重机制（不重复创建条目）
      await douyinPage.waitForTimeout(700);
      await douyinPage.locator('button.cp-fab-btn').click();
      await expect(douyinPage.locator('.cp-toast-card')).toHaveCount(0);

      // 打开 Popup 轮询等待后台静默下载完成并验证统计卡（总收藏 1 / 待同步 1 / 下载中 0）
      const popupPage = await context.newPage();
      await expect
        .poll(
          async () => {
            await popupPage.goto(extensionUrl('popup.html'));
            const statValues = popupPage.locator('section.grid span.text-lg');
            const total = await statValues.nth(0).textContent();
            const pending = await statValues.nth(1).textContent();
            const active = await statValues.nth(2).textContent();
            return `${total}:${pending}:${active}`;
          },
          { timeout: 20_000 },
        )
        .toBe('1:1:0');

      await expect(
        popupPage.getByRole('heading', { name: 'Collect+' }),
      ).toBeVisible();

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

  test('管理台多维筛选、视图切换、软删除回收站恢复与离线详情抽屉', async ({
    context,
    extensionUrl,
    pageErrors,
  }) => {
    const tracker = await installDouyinMockRoutes(context);
    try {
      // 1. 先静默采集 1 条视频 + 1 条图集
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
      await expect(videoPage.locator('.cp-toast-card')).toHaveCount(0);

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
      await expect(galleryPage.locator('.cp-toast-card')).toHaveCount(0);

      // 2. 在 Library 验证 2 条收藏全部暂存完成，并打开图集离线详情抽屉
      const libraryPage = await context.newPage();
      await libraryPage.goto(extensionUrl('library.html'));
      await expect(
        libraryPage.locator('article').getByText('待同步'),
      ).toHaveCount(2, { timeout: 20_000 });
      await expect(libraryPage.getByText(MOCK_VIDEO_TITLE)).toBeVisible();
      await expect(libraryPage.getByText(MOCK_GALLERY_TITLE)).toBeVisible();

      await libraryPage
        .locator('article')
        .filter({ hasText: MOCK_GALLERY_TITLE })
        .click();

      // 验证弹出该图集的离线详情抽屉
      const autoDialog = libraryPage.getByRole('dialog');
      await expect(autoDialog).toBeVisible();
      await expect(autoDialog.getByText('离线图集画廊 (1 / 2)')).toBeVisible();
      await autoDialog.getByRole('button', { name: '关闭详情' }).click();
      await expect(autoDialog).toBeHidden();

      // 3. 验证媒体类型筛选（全部 2 -> 仅视频 1 -> 仅图集 1 -> 全部 2）
      await expect(libraryPage.locator('article')).toHaveCount(2);

      const sidebar = libraryPage.locator('aside');
      const mediaKindGroup = sidebar.getByRole('group', {
        name: '媒体类型筛选',
      });
      await mediaKindGroup
        .getByRole('button', { name: '视频', exact: true })
        .click();
      await expect(libraryPage.locator('article')).toHaveCount(1);
      await expect(libraryPage.getByText(MOCK_VIDEO_TITLE)).toBeVisible();

      await mediaKindGroup
        .getByRole('button', { name: '图集', exact: true })
        .click();
      await expect(libraryPage.locator('article')).toHaveCount(1);
      await expect(libraryPage.getByText(MOCK_GALLERY_TITLE)).toBeVisible();

      await mediaKindGroup
        .getByRole('button', { name: '全部', exact: true })
        .click();
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
      // 1. 静默采集 1 条视频
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
      await expect(douyinPage.locator('.cp-toast-card')).toHaveCount(0);

      // 2. 打开 Library，注入基于原生 OPFS 目录句柄的 showDirectoryPicker Mock，并在侧边栏新建分类目录
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
      await expect(libraryPage.getByText(MOCK_VIDEO_TITLE)).toBeVisible({
        timeout: 20_000,
      });
      await expect(
        libraryPage.locator('article').getByText('待同步'),
      ).toBeVisible({ timeout: 20_000 });

      const sidebar = libraryPage.locator('aside');
      await sidebar.getByTitle('新建顶级文件夹').click();
      const folderInput = sidebar.getByPlaceholder('输入文件夹名称');
      await folderInput.fill('容灾验证目录');
      await folderInput.press('Enter');
      await expect(sidebar.getByText('容灾验证目录')).toBeVisible();

      // 确认内容区顶部已无旧同步横幅，且侧边栏顶部 Logo 右侧展示「同步失败」及悬停跳转链接
      await expect(
        libraryPage.getByText('尚未绑定本地 CollectVault 目录'),
      ).toHaveCount(0);
      const syncStatusBtn = sidebar.getByTestId('sidebar-sync-status');
      await expect(syncStatusBtn).toContainText('同步失败');
      await syncStatusBtn.hover();
      const syncTooltip = sidebar.getByRole('tooltip');
      await expect(syncTooltip).toContainText('请选择本地同步文件夹');
      await syncTooltip
        .getByRole('link', { name: '前往本地同步目录设置' })
        .click();

      // 3. 在设置页「本地同步目录」卡片内绑定 CollectVault 目录并自动落盘同步
      const vaultSection = libraryPage.getByTestId('settings-vault-section');
      await expect(vaultSection).toBeVisible();
      await vaultSection
        .getByRole('button', { name: '选择本地同步目录' })
        .click();

      await expect(vaultSection.getByText('已授权就绪')).toBeVisible();
      await expect(
        vaultSection.getByText(/同步完成：落盘媒体条目\s*1\s*条/),
      ).toBeVisible({ timeout: 20_000 });

      // 验证侧边栏状态点切换为「同步中」且悬停文案正确
      await expect(syncStatusBtn).toContainText('同步中');
      await syncStatusBtn.hover();
      await expect(sidebar.getByRole('tooltip')).toContainText(
        '收藏内容正在同步保存到本地文件夹',
      );

      // 切回全部收藏校验条目状态已变为「已同步」
      await sidebar.getByRole('button', { name: /全部收藏/ }).click();
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

      // 5. 前往设置页清空浏览器缓存索引（确认不删硬盘文件且保留目录绑定，触发重建引导）
      await libraryPage
        .locator('aside')
        .getByRole('button', { name: '设置', exact: true })
        .click();
      await libraryPage.getByRole('button', { name: '清空浏览器缓存' }).click();
      await libraryPage
        .getByRole('button', { name: '确认清空浏览器缓存' })
        .click();

      await expect(
        libraryPage.getByTestId('browser-cache-record-counts'),
      ).toContainText('0 条 · 0 目录 · 0 标签');
      await expect(
        libraryPage.getByRole('button', { name: '立即重建索引' }),
      ).toBeVisible();

      // 6. 点击「立即重建索引」从 CollectVault 完整恢复条目、文件夹、标签与离线视频播放
      await libraryPage.getByRole('button', { name: '立即重建索引' }).click();
      await expect(
        libraryPage.getByText(/索引重建成功：已恢复\s*1\s*条收藏/),
      ).toBeVisible({ timeout: 20_000 });

      await libraryPage
        .locator('aside')
        .getByRole('button', { name: /全部收藏/ })
        .click();
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

  test('Vault 绑定默认打开文档目录，遇到 NTFS/只读权限错误时分流并展示帮助链接与重试入口', async ({
    context,
    extensionUrl,
    pageErrors,
  }) => {
    const libraryPage = await context.newPage();

    await libraryPage.addInitScript(() => {
      interface PickerOptionsRecord {
        id?: string;
        mode?: string;
        startIn?: unknown;
      }

      const win = window as unknown as {
        __pickerCalls?: PickerOptionsRecord[];
        showDirectoryPicker?: (
          options?: PickerOptionsRecord,
        ) => Promise<FileSystemDirectoryHandle>;
      };
      win.__pickerCalls = [];

      let callCount = 0;
      win.showDirectoryPicker = async (options?: PickerOptionsRecord) => {
        win.__pickerCalls?.push({
          id: options?.id,
          mode: options?.mode,
          startIn: options?.startIn,
        });
        callCount += 1;

        if (callCount === 1) {
          const readonlyDir = {
            kind: 'directory',
            name: 'LockedVault',
            queryPermission: async () => 'granted',
            requestPermission: async () => 'granted',
            getFileHandle: async (_name: string, opts?: { create?: boolean }) => {
              if (opts?.create) {
                throw new DOMException(
                  'An attempt was made to write to a file or directory which could not be modified due to the state of the underlying filesystem.',
                  'NoModificationAllowedError',
                );
              }
              throw new DOMException('Not found', 'NotFoundError');
            },
          };
          return readonlyDir as unknown as FileSystemDirectoryHandle;
        }

        const root = await navigator.storage.getDirectory();
        return root.getDirectoryHandle('CollectVault', { create: true });
      };
    });

    await libraryPage.goto(extensionUrl('library.html'));
    const sidebar = libraryPage.locator('aside');
    const syncStatusBtn = sidebar.getByTestId('sidebar-sync-status');
    await expect(syncStatusBtn).toContainText('同步失败');
    await syncStatusBtn.hover();
    await sidebar
      .getByRole('tooltip')
      .getByRole('link', { name: '前往本地同步目录设置' })
      .click();

    const vaultSection = libraryPage.getByTestId('settings-vault-section');
    await expect(vaultSection).toBeVisible();
    await vaultSection
      .getByRole('button', { name: '选择本地同步目录' })
      .click();

    await expect(
      vaultSection.getByText(/所选目录“LockedVault”当前无法写入/),
    ).toBeVisible();

    const helpLink = vaultSection.getByRole('link', {
      name: '查看权限问题解决办法',
    });
    await expect(helpLink).toBeVisible();
    expect(await helpLink.getAttribute('href')).toMatch(/^https?:\/\//);
    expect(await helpLink.getAttribute('target')).toBe('_blank');

    const pickerCalls = await libraryPage.evaluate(() => {
      const win = window as unknown as {
        __pickerCalls?: Array<{ startIn?: unknown; mode?: string }>;
      };
      return win.__pickerCalls ?? [];
    });
    expect(pickerCalls[0]?.startIn).toBe('documents');
    expect(pickerCalls[0]?.mode).toBe('readwrite');

    // 点击错误条中的「重新选择目录」切换至可写目录后应成功绑定并清除报错
    await vaultSection.getByRole('button', { name: '重新选择目录' }).click();
    await expect(vaultSection.getByText('已授权就绪')).toBeVisible();
    await expect(helpLink).toBeHidden();
    await expect(syncStatusBtn).toContainText('同步中');

    expect(pageErrors).toEqual([]);
  });
});
