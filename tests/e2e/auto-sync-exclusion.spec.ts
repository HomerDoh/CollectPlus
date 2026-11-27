import { expect, test } from './fixtures/extension.ts';
import {
  buildMockVideoAweme,
  installDouyinMockRoutes,
  MOCK_VIDEO_AWEME_ID,
  MOCK_VIDEO_TITLE,
  type MockLoggedInUser,
} from './fixtures/douyin-mock.ts';

interface ExcludedVaultInspection {
  metaFilesCount: number;
  mediaFilesCount: number;
  metaHasThumbnailDataUrl: boolean;
  exclusionReason: string | null;
  exclusionDetail: string | null;
}

test.describe('Collect+ 「不自动同步」特殊分类与防重复自动采集闭环', () => {
  test('回收站条目不会被自动同步误恢复', async ({
    context,
    extensionUrl,
    pageErrors,
  }) => {
    let currentUser: MockLoggedInUser | null = null;
    const tracker = await installDouyinMockRoutes(context, {
      getLoggedInUser: () => currentUser,
      handleListCollection: () => ({
        body: {
          status_code: 0,
          aweme_list: [buildMockVideoAweme(MOCK_VIDEO_AWEME_ID, MOCK_VIDEO_TITLE)],
          has_more: 0,
          cursor: 20,
        },
      }),
    });

    try {
      // 1. 先手动采集 1 条视频
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

      // 2. 在管理台将视频移入回收站（不勾选同步取消原站收藏）
      const libraryPage = await context.newPage();
      await libraryPage.goto(extensionUrl('library.html'));
      await expect(libraryPage.getByText(MOCK_VIDEO_TITLE)).toBeVisible({
        timeout: 20_000,
      });

      const card = libraryPage
        .locator('article')
        .filter({ hasText: MOCK_VIDEO_TITLE });
      await card.hover();
      await card.getByTitle('移入回收站').click();

      const deleteModal = libraryPage.getByTestId('delete-confirm-modal');
      await expect(deleteModal).toBeVisible();
      await deleteModal.getByTestId('delete-sync-uncollect-checkbox').uncheck();
      await deleteModal.getByTestId('delete-confirm-submit').click();
      await expect(deleteModal).toBeHidden();

      const sidebar = libraryPage.locator('aside');
      await expect(
        sidebar.getByRole('button', { name: /全部收藏/ }),
      ).toContainText('0');
      await expect(
        sidebar.getByRole('button', { name: /回收站/ }),
      ).toContainText('1');

      // 3. 开启「自动同步全部收藏」并在抖音页切换为已登录账号触发全量同步 -> 回收站条目应被自动跳过、不误恢复
      await sidebar.getByRole('button', { name: '设置', exact: true }).click();
      await libraryPage
        .getByRole('switch', { name: '自动同步全部收藏' })
        .click();

      currentUser = { uid: '910001', nickname: '回收站防恢复测试' };
      await douyinPage.reload({ waitUntil: 'domcontentloaded' });
      await expect
        .poll(() => tracker.listCollectionRequests, { timeout: 15_000 })
        .toBe(1);
      await expect(douyinPage.getByTestId('cp-sync-banner')).toContainText(
        '去重 1 条',
        { timeout: 15_000 },
      );

      await sidebar.getByRole('button', { name: /全部收藏/ }).click();
      await expect(libraryPage.locator('article')).toHaveCount(0);
      await expect(
        sidebar.getByRole('button', { name: /回收站/ }),
      ).toContainText('1');

      expect(pageErrors).toEqual([]);
    } finally {
      await tracker.dispose();
    }
  });

  test('彻底删除保留原站收藏 -> 清理 Vault 媒体仅留 meta.json -> 不自动同步展示与防重复 -> 重建索引恢复 -> 手动采集解除', async ({
    context,
    extensionUrl,
    pageErrors,
  }) => {
    let currentUser: MockLoggedInUser | null = null;
    const tracker = await installDouyinMockRoutes(context, {
      getLoggedInUser: () => currentUser,
      handleListCollection: () => ({
        body: {
          status_code: 0,
          aweme_list: [buildMockVideoAweme(MOCK_VIDEO_AWEME_ID, MOCK_VIDEO_TITLE)],
          has_more: 0,
          cursor: 20,
        },
      }),
    });

    try {
      // 1. 手动采集视频
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

      // 2. 打开管理台，绑定 OPFS 模拟 CollectVault 并同步落盘
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
      await expect(
        libraryPage.locator('article').getByText('待同步'),
      ).toBeVisible({ timeout: 20_000 });

      const sidebar = libraryPage.locator('aside');
      await sidebar.getByRole('button', { name: '设置', exact: true }).click();
      await libraryPage
        .getByRole('button', { name: '选择本地同步目录' })
        .click();
      await expect(
        libraryPage.getByText(/同步完成：落盘媒体条目\s*1\s*条/),
      ).toBeVisible({ timeout: 20_000 });

      // 3. 移入回收站 -> 回收站中彻底删除（不勾选取消原站收藏）
      await sidebar.getByRole('button', { name: /全部收藏/ }).click();
      await expect(libraryPage.locator('article').getByText('已同步')).toBeVisible();

      const activeCard = libraryPage
        .locator('article')
        .filter({ hasText: MOCK_VIDEO_TITLE });
      await activeCard.hover();
      await activeCard.getByTitle('移入回收站').click();
      const softModal = libraryPage.getByTestId('delete-confirm-modal');
      await softModal.getByTestId('delete-sync-uncollect-checkbox').uncheck();
      await softModal.getByTestId('delete-confirm-submit').click();
      await expect(softModal).toBeHidden();

      await sidebar.getByRole('button', { name: /回收站/ }).click();
      const trashCard = libraryPage
        .locator('article')
        .filter({ hasText: MOCK_VIDEO_TITLE });
      await trashCard.hover();
      await trashCard.getByTitle('彻底删除').click();

      const permModal = libraryPage.getByTestId('delete-confirm-modal');
      await expect(permModal).toBeVisible();
      await permModal.getByTestId('delete-sync-uncollect-checkbox').uncheck();
      await permModal.getByTestId('delete-confirm-submit').click();
      await expect(permModal).toBeHidden();

      // 4. 校验 Vault 目录：仅剩轻量 meta.json（带 deleted_keep_remote），大媒体文件已全部清除
      const vaultInspection = await libraryPage.evaluate(
        async (): Promise<ExcludedVaultInspection> => {
          const opfsRoot = await navigator.storage.getDirectory();
          const vaultRoot = await opfsRoot.getDirectoryHandle('CollectVault', {
            create: false,
          });
          const itemsDir = await vaultRoot.getDirectoryHandle('items', {
            create: false,
          });

          let metaFilesCount = 0;
          let mediaFilesCount = 0;
          let metaHasThumbnailDataUrl = false;
          let exclusionReason: string | null = null;
          let exclusionDetail: string | null = null;

          const walk = async (dir: FileSystemDirectoryHandle): Promise<void> => {
            for await (const [name, handle] of dir.entries()) {
              if (handle.kind === 'directory') {
                await walk(handle);
              } else if (name === 'meta.json') {
                metaFilesCount += 1;
                const file = await handle.getFile();
                const parsed = JSON.parse(await file.text()) as {
                  thumbnailDataUrl?: unknown;
                  autoSyncExclusion?: { reason?: string; detail?: string } | null;
                };
                if ('thumbnailDataUrl' in parsed) {
                  metaHasThumbnailDataUrl = true;
                }
                exclusionReason = parsed.autoSyncExclusion?.reason ?? null;
                exclusionDetail = parsed.autoSyncExclusion?.detail ?? null;
              } else {
                mediaFilesCount += 1;
              }
            }
          };

          await walk(itemsDir);
          return {
            metaFilesCount,
            mediaFilesCount,
            metaHasThumbnailDataUrl,
            exclusionReason,
            exclusionDetail,
          };
        },
      );

      expect(vaultInspection.metaFilesCount).toBe(1);
      expect(vaultInspection.mediaFilesCount).toBe(0);
      expect(vaultInspection.metaHasThumbnailDataUrl).toBe(false);
      expect(vaultInspection.exclusionReason).toBe('deleted_keep_remote');
      expect(vaultInspection.exclusionDetail).toContain('保留原平台账号收藏');

      // 5. 切入「不自动同步」特殊分类，核对元数据、原因与详情抽屉
      await expect(
        sidebar.getByRole('button', { name: /全部收藏/ }),
      ).toContainText('0');
      await expect(
        sidebar.getByRole('button', { name: /回收站/ }),
      ).toContainText('0');
      await expect(
        sidebar.getByRole('button', { name: /不自动同步/ }),
      ).toContainText('1');

      await sidebar.getByRole('button', { name: /不自动同步/ }).click();
      const excludedCard = libraryPage
        .locator('article')
        .filter({ hasText: MOCK_VIDEO_TITLE });
      await expect(excludedCard).toBeVisible();
      await expect(
        excludedCard.getByTestId('item-exclusion-reason'),
      ).toContainText('管理台删除（保留原站收藏）');

      await excludedCard.click();
      const detailPanel = libraryPage.getByTestId('excluded-detail-panel');
      await expect(detailPanel).toBeVisible();
      await expect(detailPanel).toContainText('此内容已设为不自动同步');
      await expect(detailPanel).toContainText('管理台删除（保留原站收藏）');
      await libraryPage.getByRole('button', { name: '关闭详情' }).click();

      // 6. 开启自动同步并在原站切换为已登录账号触发全量同步 + 被动收藏列表同步 -> 必须自动跳过，不重新进入全部收藏
      await sidebar.getByRole('button', { name: '设置', exact: true }).click();
      await libraryPage
        .getByRole('switch', { name: '自动同步全部收藏' })
        .click();

      currentUser = { uid: '910002', nickname: '不自动同步全链路用户' };
      await douyinPage.reload({ waitUntil: 'domcontentloaded' });
      await expect
        .poll(() => tracker.listCollectionRequests, { timeout: 15_000 })
        .toBe(1);
      await expect(douyinPage.getByTestId('cp-sync-banner')).toContainText(
        '去重 1 条',
        { timeout: 15_000 },
      );

      await douyinPage.evaluate(async () => {
        const win = window as unknown as {
          __mockTriggerPassiveListCollection?: (cursor?: number) => Promise<unknown>;
        };
        await win.__mockTriggerPassiveListCollection?.(0);
      });
      await douyinPage.waitForTimeout(400);

      await expect(
        sidebar.getByRole('button', { name: /全部收藏/ }),
      ).toContainText('0');
      await expect(
        sidebar.getByRole('button', { name: /不自动同步/ }),
      ).toContainText('1');

      // 7. 清空浏览器缓存索引 -> 从本地重建索引 -> 验证「不自动同步」条目与原因无损恢复
      await sidebar.getByRole('button', { name: '设置', exact: true }).click();
      await libraryPage.getByRole('button', { name: '清空浏览器缓存' }).click();
      await libraryPage
        .getByRole('button', { name: '确认清空浏览器缓存' })
        .click();
      await expect(
        libraryPage.getByRole('button', { name: '立即重建索引' }),
      ).toBeVisible();
      await libraryPage.getByRole('button', { name: '立即重建索引' }).click();
      await expect(
        libraryPage.getByText(/索引重建成功：已恢复\s*1\s*条收藏/),
      ).toBeVisible({ timeout: 20_000 });

      await expect(
        sidebar.getByRole('button', { name: /全部收藏/ }),
      ).toContainText('0');
      await expect(
        sidebar.getByRole('button', { name: /不自动同步/ }),
      ).toContainText('1');

      // 8. 用户手动在原网页点击悬浮按钮重新采集 -> 自动解除「不自动同步」并重新下载入库
      const dismissBannerBtn = douyinPage.getByRole('button', {
        name: '关闭同步提示',
      });
      if ((await dismissBannerBtn.count()) > 0) {
        await dismissBannerBtn.click();
      }
      await douyinPage.click('#mock-load-detail');
      await douyinPage.waitForTimeout(700);
      await douyinPage.locator('button.cp-fab-btn').click();

      await expect(
        sidebar.getByRole('button', { name: /全部收藏/ }),
      ).toContainText('1', { timeout: 20_000 });
      await expect(
        sidebar.getByRole('button', { name: /不自动同步/ }),
      ).toContainText('0');

      expect(pageErrors).toEqual([]);
    } finally {
      await tracker.dispose();
    }
  });

  test('取消同步转入「不自动同步」并拦截自动同步；点击「允许再次自动同步」后可恢复采集', async ({
    context,
    extensionUrl,
    pageErrors,
  }) => {
    const libraryPage = await context.newPage();
    await libraryPage.goto(extensionUrl('library.html'));

    const sourceId = '7499000000000009999';
    const itemId = '01JAUTOSYNCEXCLTEST0000001';
    const taskId = '01JAUTOSYNCEXCLTASK0000001';
    const title = '下载中手动取消同步测试视频';
    const now = Date.now();

    // 注入一条处于 pending_download 的条目与 queued 任务，模拟收藏后正在同步中的状态
    await libraryPage.evaluate(
      async ({ record, task }) => {
        await new Promise<void>((resolve, reject) => {
          const req = indexedDB.open('CollectPlusDB');
          req.onerror = () => reject(req.error);
          req.onsuccess = () => {
            const idb = req.result;
            const tx = idb.transaction(['items', 'tasks'], 'readwrite');
            tx.objectStore('items').put(record);
            tx.objectStore('tasks').put(task);
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
      {
        record: {
          schemaVersion: 1,
          id: itemId,
          dedupeKey: `douyin:${sourceId}`,
          platform: 'douyin',
          sourceId,
          sourceUrl: `https://www.douyin.com/video/${sourceId}`,
          kind: 'video',
          title,
          description: '用于验证取消同步进入不自动同步列表',
          author: { id: 'author-test', name: '测试作者' },
          collectedAt: now,
          updatedAt: now,
          folderId: null,
          folderIds: [],
          tags: [],
          note: '',
          relativeDir: `items/douyin/2026-11/20261127_${sourceId}`,
          assets: [],
          syncStatus: 'pending_download',
          totalSizeBytes: 0,
          deletedAt: null,
          autoSyncExclusion: null,
        },
        task: {
          id: taskId,
          itemId,
          dedupeKey: `douyin:${sourceId}`,
          platform: 'douyin',
          title,
          status: 'queued',
          progress: 0,
          completedAssets: 0,
          totalAssets: 1,
          downloadedBytes: 0,
          totalBytes: 0,
          retryCount: 0,
          createdAt: now,
          updatedAt: now,
        },
      },
    );

    await libraryPage.reload();
    const pendingCard = libraryPage
      .locator('article')
      .filter({ hasText: title });
    await expect(pendingCard).toBeVisible();

    // 1. 在卡片上点击「取消同步」 -> 转入「不自动同步」分类，原因为 sync_cancelled_by_user
    await pendingCard.hover();
    await pendingCard.getByTitle('取消同步到插件').click();

    const sidebar = libraryPage.locator('aside');
    await expect(
      sidebar.getByRole('button', { name: /全部收藏/ }),
    ).toContainText('0');
    await expect(
      sidebar.getByRole('button', { name: /不自动同步/ }),
    ).toContainText('1');

    await sidebar.getByRole('button', { name: /不自动同步/ }).click();
    const excludedCard = libraryPage
      .locator('article')
      .filter({ hasText: title });
    await expect(
      excludedCard.getByTestId('item-exclusion-reason'),
    ).toContainText('收藏时取消同步到插件');

    // 2. 后台收到 auto_sync 批次采集同一 sourceId -> 必须返回 skippedReason: 'auto_sync_excluded' 且不入库
    const blockedRes = await libraryPage.evaluate(async (sid) => {
      return chrome.runtime.sendMessage({
        target: 'background',
        type: 'CAPTURE_ITEM',
        payload: {
          platform: 'douyin',
          sourceId: sid,
          sourceUrl: `https://www.douyin.com/video/${sid}`,
          kind: 'video',
          title: '下载中手动取消同步测试视频',
          description: 'auto sync attempt',
          author: { id: 'author-test', name: '测试作者' },
          hashtags: [],
          assets: [],
          triggerSource: 'auto_sync',
        },
      });
    }, sourceId);

    expect(blockedRes).toMatchObject({
      ok: true,
      deduplicated: true,
      skippedReason: 'auto_sync_excluded',
    });

    // 3. 点击「允许再次自动同步」移除忽略记录 -> 再次收到 auto_sync 可正常重新入库
    await excludedCard.hover();
    await excludedCard.getByTitle('允许再次自动同步').click();
    await expect(
      sidebar.getByRole('button', { name: /不自动同步/ }),
    ).toContainText('0');

    const allowedRes = await libraryPage.evaluate(async (sid) => {
      return chrome.runtime.sendMessage({
        target: 'background',
        type: 'CAPTURE_ITEM',
        payload: {
          platform: 'douyin',
          sourceId: sid,
          sourceUrl: `https://www.douyin.com/video/${sid}`,
          kind: 'video',
          title: '下载中手动取消同步测试视频',
          description: 'auto sync after allow',
          author: { id: 'author-test', name: '测试作者' },
          hashtags: [],
          assets: [],
          triggerSource: 'auto_sync',
        },
      });
    }, sourceId);

    expect(allowedRes).toMatchObject({
      ok: true,
      deduplicated: false,
    });
    await expect(
      sidebar.getByRole('button', { name: /全部收藏/ }),
    ).toContainText('1');

    expect(pageErrors).toEqual([]);
  });

  test('原生收藏 5 秒 Toast 跳过持久化、设置开关隐藏 Toast 与 Popup 取消本地持久化全链路', async ({
    context,
    extensionUrl,
    pageErrors,
  }) => {
    const tracker = await installDouyinMockRoutes(context);
    try {
      // 1. 打开抖音详情页并触发原生收藏 -> 弹出 5 秒 Toast -> 点击「支持作者」仅存元数据不下载媒体
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

      await douyinPage.click('#mock-native-collect');
      const nativeToast = douyinPage.getByTestId('cp-native-collect-toast');
      await expect(nativeToast).toBeVisible();

      await douyinPage.getByTestId('cp-skip-reason-support-author').click();
      await expect(nativeToast).toBeHidden();

      // 打开管理台：验证条目已归入「不自动同步」且未触发任何 CDN 视频下载
      const libraryPage = await context.newPage();
      await libraryPage.goto(extensionUrl('library.html'));
      const sidebar = libraryPage.locator('aside');
      await expect(
        sidebar.getByRole('button', { name: /不自动同步/ }),
      ).toContainText('1', { timeout: 15_000 });
      await expect(
        sidebar.getByRole('button', { name: /全部收藏/ }),
      ).toContainText('0');
      expect(tracker.requestedMediaUrls).toEqual([]);

      await sidebar.getByRole('button', { name: /不自动同步/ }).click();
      const excludedCard = libraryPage
        .locator('article')
        .filter({ hasText: MOCK_VIDEO_TITLE });
      await expect(
        excludedCard.getByTestId('item-exclusion-reason'),
      ).toContainText('支持作者');

      // 校验后续自动同步会跳过该条目
      const blockedRes = await libraryPage.evaluate(async (sid) => {
        return chrome.runtime.sendMessage({
          target: 'background',
          type: 'CAPTURE_ITEM',
          payload: {
            platform: 'douyin',
            sourceId: sid,
            sourceUrl: `https://www.douyin.com/video/${sid}`,
            kind: 'video',
            title: '自动同步防重验证',
            description: '',
            author: { id: 'author-1', name: '作者' },
            hashtags: [],
            assets: [],
            triggerSource: 'auto_sync',
          },
        });
      }, MOCK_VIDEO_AWEME_ID);
      expect(blockedRes).toMatchObject({
        ok: true,
        deduplicated: true,
        skippedReason: 'auto_sync_excluded',
      });

      // 2. 在设置页关闭「原生收藏时显示 5 秒取消保存提示」 -> 再次触发原生收藏不再弹出 5 秒 Toast 并直接本地保存
      await sidebar.getByRole('button', { name: '设置', exact: true }).click();
      const toastSwitch = libraryPage.getByRole('switch', {
        name: '原生收藏时显示 5 秒取消保存提示',
      });
      await expect(toastSwitch).toHaveAttribute('aria-checked', 'true');
      await toastSwitch.click();
      await expect(toastSwitch).toHaveAttribute('aria-checked', 'false');

      // 先等待 2.1s 跳过原生收藏防重窗口后再次原生收藏 -> 不出现 Toast 且直接开始下载保存
      await douyinPage.waitForTimeout(2100);
      await douyinPage.click('#mock-native-collect');
      await expect(douyinPage.getByTestId('cp-native-collect-toast')).toHaveCount(0);

      await sidebar.getByRole('button', { name: /全部收藏/ }).click();
      await expect(
        libraryPage.locator('article').getByText('待同步'),
      ).toBeVisible({ timeout: 20_000 });
      expect(tracker.requestedMediaUrls.length).toBeGreaterThan(0);

      // 3. 在 Popup 弹窗点击「取消当前内容本地持久化」-> 选择「稍后观看」并填写备注 -> 条目转入「不自动同步」
      const popupPage = await context.newPage();
      await popupPage.addInitScript(() => {
        const origQuery = chrome.tabs.query.bind(chrome.tabs);
        chrome.tabs.query = ((
          queryInfo: chrome.tabs.QueryInfo,
          callback?: (result: chrome.tabs.Tab[]) => void,
        ) => {
          const promise = origQuery({ url: 'https://www.douyin.com/*' }).then(
            (tabs) => (tabs.length > 0 ? [tabs[0]!] : origQuery(queryInfo)),
          );
          if (typeof callback === 'function') {
            void promise.then(callback);
            return undefined;
          }
          return promise;
        }) as typeof chrome.tabs.query;
      });
      await popupPage.goto(extensionUrl('popup.html'));

      const skipBtn = popupPage.getByTestId('popup-skip-persistence-btn');
      await expect(skipBtn).toBeVisible({ timeout: 10_000 });
      await skipBtn.click();
      await expect(
        popupPage.getByTestId('popup-skip-persistence-panel'),
      ).toBeVisible();

      await popupPage
        .getByTestId('popup-skip-detail-input')
        .fill('周末回看');
      await popupPage.getByTestId('popup-skip-reason-watch-later').click();
      await expect(
        popupPage.getByText(/已取消本地持久化（稍后观看）/),
      ).toBeVisible({ timeout: 10_000 });

      await expect(
        sidebar.getByRole('button', { name: /全部收藏/ }),
      ).toContainText('0', { timeout: 10_000 });
      await expect(
        sidebar.getByRole('button', { name: /不自动同步/ }),
      ).toContainText('1');

      await sidebar.getByRole('button', { name: /不自动同步/ }).click();
      const watchLaterCard = libraryPage
        .locator('article')
        .filter({ hasText: MOCK_VIDEO_TITLE });
      await expect(
        watchLaterCard.getByTestId('item-exclusion-reason'),
      ).toContainText('稍后观看');
      await expect(watchLaterCard).toContainText('周末回看');

      expect(pageErrors).toEqual([]);
    } finally {
      await tracker.dispose();
    }
  });
});
