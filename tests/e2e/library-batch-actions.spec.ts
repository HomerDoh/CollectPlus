import { expect, test } from './fixtures/extension.ts';
import type { Page } from '@playwright/test';

interface SeedItemSpec {
  id: string;
  platform: 'douyin' | 'bilibili' | 'xiaohongshu' | 'zhihu' | 'v2ex' | 'youtube';
  sourceId: string;
  title: string;
  collectedAt: number;
  folderIds?: string[];
  platformExtra?: Record<string, string | number | boolean | null>;
}

function makeSeedRecord(spec: SeedItemSpec): Record<string, unknown> {
  const folderIds = spec.folderIds ?? [];
  return {
    schemaVersion: 1,
    id: spec.id,
    dedupeKey: `${spec.platform}:${spec.sourceId}`,
    platform: spec.platform,
    sourceId: spec.sourceId,
    sourceUrl: `https://example.com/${spec.platform}/${spec.sourceId}`,
    kind: 'video',
    title: spec.title,
    description: `${spec.title} 描述`,
    author: {
      id: `author-${spec.sourceId}`,
      name: `作者_${spec.sourceId}`,
    },
    collectedAt: spec.collectedAt,
    updatedAt: spec.collectedAt,
    folderId: folderIds[0] ?? null,
    folderIds,
    tags: [],
    note: '',
    relativeDir: `items/${spec.platform}/2026-11/20261127_${spec.sourceId}`,
    assets: [],
    syncStatus: 'opfs_staged',
    totalSizeBytes: 1024 * 512,
    deletedAt: null,
    ...(spec.platformExtra ? { platformExtra: spec.platformExtra } : {}),
  };
}

async function seedLibraryDb(
  page: Page,
  items: readonly Record<string, unknown>[],
  folders: readonly Record<string, unknown>[] = [],
): Promise<void> {
  await page.evaluate(
    async ({ itemList, folderList }) => {
      await new Promise<void>((resolve, reject) => {
        const req = indexedDB.open('CollectPlusDB');
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const idb = req.result;
          const tx = idb.transaction(['items', 'folders'], 'readwrite');
          const itemStore = tx.objectStore('items');
          const folderStore = tx.objectStore('folders');
          for (const folder of folderList) {
            folderStore.put(folder);
          }
          for (const item of itemList) {
            itemStore.put(item);
          }
          tx.oncomplete = () => {
            idb.close();
            resolve();
          };
          tx.onerror = () => {
            idb.close();
            reject(tx.error);
          };
        };
      });
    },
    { itemList: items, folderList: folders },
  );
}

test.describe('Collect+ 媒体控制台批量选择、多分类文件夹与同步取消收藏验证', () => {
  test('多分类文件夹归属、去重计数、移出当前文件夹、删除文件夹保留其他归属及详情多选编辑', async ({
    context,
    extensionUrl,
    pageErrors,
  }) => {
    const libraryPage = await context.newPage();
    await libraryPage.goto(extensionUrl('library.html'));

    const now = Date.now();
    const seedFolders = [
      {
        id: 'folder-parent',
        parentId: null,
        name: '设计素材',
        sortOrder: 0,
        createdAt: now - 3000,
        updatedAt: now - 3000,
      },
      {
        id: 'folder-child',
        parentId: 'folder-parent',
        name: '动效灵感',
        sortOrder: 0,
        createdAt: now - 2000,
        updatedAt: now - 2000,
      },
      {
        id: 'folder-sibling',
        parentId: null,
        name: '后期剪辑',
        sortOrder: 1,
        createdAt: now - 1000,
        updatedAt: now - 1000,
      },
    ];
    const seedItems = [
      makeSeedRecord({
        id: '01JBATCHMULTI0000000000001',
        platform: 'douyin',
        sourceId: 'dy-m1',
        title: '多文件夹样本A',
        collectedAt: now - 1000,
      }),
      makeSeedRecord({
        id: '01JBATCHMULTI0000000000002',
        platform: 'bilibili',
        sourceId: 'BV1BATCH00002',
        title: '多文件夹样本B',
        collectedAt: now - 2000,
      }),
      makeSeedRecord({
        id: '01JBATCHMULTI0000000000003',
        platform: 'zhihu',
        sourceId: 'article:3003',
        title: '多文件夹样本C',
        collectedAt: now - 3000,
      }),
    ];

    await seedLibraryDb(libraryPage, seedItems, seedFolders);
    await libraryPage.reload();
    await expect(libraryPage.locator('article')).toHaveCount(3);

    // 1. 进入批量选择，使用 Shift 连选前 2 项并同时加入「设计素材」「动效灵感」「后期剪辑」3 个文件夹
    await libraryPage.getByTestId('toggle-selection-mode').click();
    await expect(libraryPage.getByTestId('batch-action-bar')).toBeVisible();

    await libraryPage
      .locator('article')
      .filter({ hasText: '多文件夹样本A' })
      .click();
    await libraryPage
      .locator('article')
      .filter({ hasText: '多文件夹样本B' })
      .click({ modifiers: ['Shift'] });
    await expect(libraryPage.getByTestId('batch-selected-count')).toHaveText('2');

    await libraryPage.getByTestId('batch-add-folder-btn').click();
    const folderModal = libraryPage.getByTestId('folder-assign-modal');
    await expect(folderModal).toBeVisible();

    await folderModal.getByLabel('设计素材').check();
    await folderModal.getByLabel('动效灵感').check();
    await folderModal.getByLabel('后期剪辑').check();
    await folderModal.getByTestId('folder-assign-submit').click();
    await expect(folderModal).toBeHidden();
    await expect(libraryPage.getByTestId('library-action-notice')).toContainText(
      '已将 2 项加入文件夹',
    );

    // 2. 验证去重计数：样本A/B 同时在父文件夹「设计素材」与子文件夹「动效灵感」中，父文件夹计数必须为 2（而非 4）
    const sidebar = libraryPage.locator('aside');
    const parentFolderRow = sidebar
      .locator('div')
      .filter({ has: libraryPage.getByRole('button', { name: '设计素材', exact: true }) })
      .first();
    await expect(parentFolderRow).toContainText('2');

    // 验证「未分类」仅剩样本C（1 条）
    await sidebar.getByRole('button', { name: /未分类/ }).click();
    await expect(libraryPage.locator('article')).toHaveCount(1);
    await expect(libraryPage.getByText('多文件夹样本C')).toBeVisible();

    // 3. 同一条目同时出现在「设计素材」与「后期剪辑」中
    await sidebar.getByRole('button', { name: '设计素材', exact: true }).click();
    await expect(libraryPage.locator('article')).toHaveCount(2);

    await sidebar.getByRole('button', { name: '后期剪辑', exact: true }).click();
    await expect(libraryPage.locator('article')).toHaveCount(2);

    // 4. 在「后期剪辑」中批量选择样本A 并点击「移出当前文件夹」-> 仅移出「后期剪辑」，「设计素材」中仍保留样本A
    await libraryPage.getByTestId('toggle-selection-mode').click();
    await libraryPage
      .locator('article')
      .filter({ hasText: '多文件夹样本A' })
      .click();
    await libraryPage.getByTestId('batch-remove-folder-btn').click();
    await expect(libraryPage.locator('article')).toHaveCount(1);
    await expect(libraryPage.getByText('多文件夹样本B')).toBeVisible();

    await sidebar.getByRole('button', { name: '设计素材', exact: true }).click();
    await expect(libraryPage.locator('article')).toHaveCount(2);
    await expect(libraryPage.getByText('多文件夹样本A')).toBeVisible();

    // 5. 切换文件夹后已自动退出批量选择模式，直接点击打开样本B 详情抽屉，验证多文件夹勾选框并取消勾选「设计素材」「动效灵感」保留「后期剪辑」
    await expect(libraryPage.getByTestId('batch-action-bar')).toHaveCount(0);
    await libraryPage
      .locator('article')
      .filter({ hasText: '多文件夹样本B' })
      .click();
    const detailDialog = libraryPage.getByRole('dialog');
    await expect(detailDialog).toBeVisible();
    const detailFolderList = detailDialog.getByTestId('detail-folder-list');
    await expect(detailFolderList.getByLabel('设计素材')).toBeChecked();
    await expect(detailFolderList.getByLabel(/动效灵感/)).toBeChecked();
    await expect(detailFolderList.getByLabel('后期剪辑')).toBeChecked();

    await detailFolderList.getByLabel('设计素材').uncheck();
    await detailFolderList.getByLabel(/动效灵感/).uncheck();
    await detailDialog.getByRole('button', { name: '保存修改' }).click();
    await expect(detailDialog.getByText(/已保存到浏览器索引/)).toBeVisible();
    await libraryPage.keyboard.press('Escape');
    await expect(detailDialog).toBeHidden();

    // 刷新页面验证持久化
    await libraryPage.reload();
    await sidebar.getByRole('button', { name: '设计素材', exact: true }).click();
    await expect(libraryPage.locator('article')).toHaveCount(1);
    await expect(libraryPage.getByText('多文件夹样本A')).toBeVisible();

    await sidebar.getByRole('button', { name: '后期剪辑', exact: true }).click();
    await expect(libraryPage.locator('article')).toHaveCount(1);
    await expect(libraryPage.getByText('多文件夹样本B')).toBeVisible();

    expect(pageErrors).toEqual([]);
  });

  test('统一删除弹窗（默认勾选同步取消账号收藏）、复用标签页与后台临时标签页取消收藏、回收站批量恢复与彻底删除', async ({
    context,
    extensionUrl,
    pageErrors,
  }) => {
    const douyinUncollectRequests: string[] = [];
    const biliDealRequests: string[] = [];

    // Mock 抖音页面及取消收藏 API
    await context.route('https://www.douyin.com/**', async (route) => {
      const url = route.request().url();
      if (url.includes('/aweme/v1/web/aweme/collect/')) {
        const postData = route.request().postData() ?? '';
        douyinUncollectRequests.push(`${url}|${postData}`);
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ status_code: 0 }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: '<!doctype html><html><head><title>Mock Douyin</title></head><body>Mock Douyin</body></html>',
      });
    });

    // Mock B站首页与收藏夹/取消收藏 API（使用浏览器级 CDP Fetch，确保后台新建临时标签页 100% 离线拦截）
    await context.addCookies([
      {
        name: 'bili_jct',
        value: 'mock_csrf_token_e2e',
        domain: '.bilibili.com',
        path: '/',
      },
    ]);

    const browser = context.browser();
    if (!browser) {
      throw new Error('Browser instance unavailable for CDP interception.');
    }
    const cdp = await browser.newBrowserCDPSession();
    await cdp.send('Fetch.enable', {
      patterns: [
        { urlPattern: 'https://www.bilibili.com/*' },
        { urlPattern: 'https://api.bilibili.com/*' },
      ],
    });
    const onCdpRequestPaused = async (event: {
      requestId: string;
      request: { url: string; postData?: string };
    }): Promise<void> => {
      const url = event.request.url;
      const postData = event.request.postData ?? '';
      try {
        if (url.startsWith('https://www.bilibili.com/')) {
          await cdp.send('Fetch.fulfillRequest', {
            requestId: event.requestId,
            responseCode: 200,
            responseHeaders: [
              { name: 'content-type', value: 'text/html; charset=utf-8' },
            ],
            body: Buffer.from(
              '<!doctype html><html><head><title>Mock Bilibili</title></head><body>Mock Bilibili</body></html>',
              'utf-8',
            ).toString('base64'),
          });
          return;
        }

        const corsHeaders = [
          { name: 'content-type', value: 'application/json; charset=utf-8' },
          {
            name: 'access-control-allow-origin',
            value: 'https://www.bilibili.com',
          },
          { name: 'access-control-allow-credentials', value: 'true' },
        ];
        let payload: Record<string, unknown> = { code: 0, data: {} };
        if (url.includes('/x/web-interface/nav')) {
          payload = {
            code: 0,
            data: { isLogin: true, mid: 123456, uname: '测试UP' },
          };
        } else if (url.includes('/x/v3/fav/folder/created/list-all')) {
          payload = {
            code: 0,
            data: {
              list: [
                { id: 99001, title: '默认收藏夹', fav_state: 1 },
                { id: 99002, title: '未收藏夹', fav_state: 0 },
              ],
            },
          };
        } else if (url.includes('/x/v3/fav/resource/deal')) {
          biliDealRequests.push(postData);
          payload = { code: 0, message: '0' };
        }

        await cdp.send('Fetch.fulfillRequest', {
          requestId: event.requestId,
          responseCode: 200,
          responseHeaders: corsHeaders,
          body: Buffer.from(JSON.stringify(payload), 'utf-8').toString(
            'base64',
          ),
        });
      } catch {
        await cdp
          .send('Fetch.continueRequest', { requestId: event.requestId })
          .catch(() => undefined);
      }
    };
    cdp.on('Fetch.requestPaused', (ev) => {
      void onCdpRequestPaused(ev);
    });

    try {

    // 先打开一个抖音标签页（用于验证优先复用已有标签页），不打开 B站标签页（用于验证后台临时标签页自动打开并关闭）
    const douyinTab = await context.newPage();
    await douyinTab.goto('https://www.douyin.com/', {
      waitUntil: 'domcontentloaded',
    });

    const libraryPage = await context.newPage();
    await libraryPage.goto(extensionUrl('library.html'));

    const now = Date.now();
    const seedItems = [
      makeSeedRecord({
        id: '01JBATCHDEL000000000000001',
        platform: 'douyin',
        sourceId: '7499999000000000001',
        title: '抖音待删视频',
        collectedAt: now - 1000,
      }),
      makeSeedRecord({
        id: '01JBATCHDEL000000000000002',
        platform: 'bilibili',
        sourceId: 'BV1TESTDEL002',
        title: 'B站待删视频',
        collectedAt: now - 2000,
        platformExtra: { aid: '88776655', bvid: 'BV1TESTDEL002' },
      }),
      makeSeedRecord({
        id: '01JBATCHDEL000000000000003',
        platform: 'douyin',
        sourceId: '7499999000000000003',
        title: '抖音仅本地删除视频',
        collectedAt: now - 3000,
      }),
    ];
    await seedLibraryDb(libraryPage, seedItems);
    await libraryPage.reload();
    await expect(libraryPage.locator('article')).toHaveCount(3);

    // 1. 单条删除「抖音仅本地删除视频」，取消勾选「同步取消账号的收藏」-> 仅本地移入回收站，不发网络请求
    const localOnlyCard = libraryPage
      .locator('article')
      .filter({ hasText: '抖音仅本地删除视频' });
    await localOnlyCard.hover();
    await localOnlyCard.getByRole('button', { name: '移入回收站' }).click();

    const deleteModal = libraryPage.getByTestId('delete-confirm-modal');
    await expect(deleteModal).toBeVisible();
    const syncCheckbox = deleteModal.getByTestId('delete-sync-uncollect-checkbox');
    await expect(syncCheckbox).toBeChecked(); // 必须默认勾选
    await syncCheckbox.uncheck();
    await deleteModal.getByTestId('delete-confirm-submit').click();
    await expect(deleteModal).toBeHidden();

    await expect(libraryPage.locator('article')).toHaveCount(2);
    expect(douyinUncollectRequests).toHaveLength(0);

    // 2. 批量全选剩余 2 项（抖音 + B站），保持默认勾选「同步取消账号的收藏」执行删除
    const pagesCountBefore = context.pages().length;
    await libraryPage.getByTestId('toggle-selection-mode').click();
    await libraryPage.getByTestId('batch-select-all').check();
    await expect(libraryPage.getByTestId('batch-selected-count')).toHaveText('2');
    await libraryPage.getByTestId('batch-delete-btn').click();

    await expect(deleteModal).toBeVisible();
    await expect(syncCheckbox).toBeChecked();
    await deleteModal.getByTestId('delete-confirm-submit').click();
    await expect(deleteModal).toBeHidden({ timeout: 20_000 });

    // 验证两项均已移入回收站、抖音与 B站取消收藏请求均已发出、且临时 B站标签页已自动关闭
    await expect(libraryPage.locator('article')).toHaveCount(0);
    await expect(libraryPage.getByTestId('library-action-notice')).toContainText(
      '已同步取消原平台账号收藏 2 项',
    );
    expect(douyinUncollectRequests).toHaveLength(1);
    expect(douyinUncollectRequests[0]).toContain('7499999000000000001');
    expect(douyinUncollectRequests[0]).toContain('action=0');

    expect(biliDealRequests).toHaveLength(1);
    expect(biliDealRequests[0]).toContain('rid=88776655');
    expect(biliDealRequests[0]).toContain('del_media_ids=99001');
    expect(biliDealRequests[0]).toContain('csrf=mock_csrf_token_e2e');

    await expect.poll(() => context.pages().length).toBe(pagesCountBefore);

    // 3. 进入回收站：批量恢复 1 项，再彻底删除剩余 2 项
    await libraryPage
      .locator('aside')
      .getByRole('button', { name: /回收站/ })
      .click();
    await expect(libraryPage.locator('article')).toHaveCount(3);

    await libraryPage.getByTestId('toggle-selection-mode').click();
    await libraryPage
      .locator('article')
      .filter({ hasText: '抖音仅本地删除视频' })
      .click();
    await libraryPage.getByTestId('batch-restore-btn').click();
    await expect(libraryPage.locator('article')).toHaveCount(2);

    // 彻底删除回收站剩余 2 项（不勾选远端同步）
    await libraryPage.getByTestId('batch-select-all').check();
    await libraryPage.getByTestId('batch-permanent-delete-btn').click();
    await expect(deleteModal).toBeVisible();
    await expect(syncCheckbox).toBeChecked();
    await syncCheckbox.uncheck();
    await deleteModal.getByTestId('delete-confirm-submit').click();
    await expect(deleteModal).toBeHidden();
    await expect(libraryPage.locator('article')).toHaveCount(0);

    // 返回全部收藏确认仅剩被恢复的 1 项
    await libraryPage
      .locator('aside')
      .getByRole('button', { name: /全部收藏/ })
      .click();
    await expect(libraryPage.locator('article')).toHaveCount(1);
    await expect(libraryPage.getByText('抖音仅本地删除视频')).toBeVisible();

    expect(pageErrors).toEqual([]);
    } finally {
      await cdp.send('Fetch.disable').catch(() => undefined);
      await cdp.detach().catch(() => undefined);
    }
  });
});
