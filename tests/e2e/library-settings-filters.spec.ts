import { expect, test } from './fixtures/extension.ts';
import {
  installDouyinMockRoutes,
  MOCK_VIDEO_AWEME_ID,
} from './fixtures/douyin-mock.ts';

interface SeedItemInput {
  id: string;
  platform:
    | 'douyin'
    | 'bilibili'
    | 'xiaohongshu'
    | 'zhihu'
    | 'youtube'
    | 'twitter';
  sourceId: string;
  kind: 'video' | 'gallery' | 'image' | 'article';
  title: string;
  description: string;
  authorName: string;
  collectedAt: number;
  totalSizeBytes: number;
  tags?: string[];
  sourceUrl?: string;
}

function buildSeedRecord(input: SeedItemInput): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: input.id,
    dedupeKey: `${input.platform}:${input.sourceId}`,
    platform: input.platform,
    sourceId: input.sourceId,
    sourceUrl:
      input.sourceUrl ?? `https://example.com/${input.platform}/${input.sourceId}`,
    kind: input.kind,
    title: input.title,
    description: input.description,
    author: {
      id: `author-${input.platform}`,
      name: input.authorName,
    },
    collectedAt: input.collectedAt,
    updatedAt: input.collectedAt,
    folderId: null,
    tags: input.tags ?? [],
    note: '',
    relativeDir: `items/${input.platform}/2026-11/20261125_${input.sourceId}`,
    assets: [],
    syncStatus: 'opfs_staged',
    totalSizeBytes: input.totalSizeBytes,
    deletedAt: null,
  };
}

test.describe('CollectPlus 控制台设置页、媒体类型与平台筛选验证', () => {
  test('设置页悬浮图标开关实时同步、偏好持久化、缓存统计与清空浏览器缓存', async ({
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

      const fabButton = douyinPage.locator('button.cp-fab-btn');
      await expect(fabButton).toBeVisible();

      // 打开控制台并切换到设置页
      const libraryPage = await context.newPage();
      await libraryPage.goto(extensionUrl('library.html'));

      await libraryPage.getByRole('button', { name: '设置', exact: true }).click();
      await expect(
        libraryPage.getByRole('heading', { name: '插件设置' }),
      ).toBeVisible();
      await expect(
        libraryPage.getByTestId('browser-cache-total-size'),
      ).toBeVisible();
      await expect(
        libraryPage.getByTestId('browser-cache-opfs-size'),
      ).toBeVisible();
      await expect(
        libraryPage.getByTestId('browser-cache-index-size'),
      ).toBeVisible();

      // 关闭悬浮图标开关 -> 已打开页面实时隐藏，新开页面也不显示
      const floatingSwitch = libraryPage.getByRole('switch', {
        name: '在支持的网页显示悬浮收藏图标',
      });
      await expect(floatingSwitch).toHaveAttribute('aria-checked', 'true');
      await floatingSwitch.click();
      await expect(floatingSwitch).toHaveAttribute('aria-checked', 'false');
      await expect(fabButton).toBeHidden();

      const secondDouyinPage = await context.newPage();
      await secondDouyinPage.goto(
        `https://www.douyin.com/video/${MOCK_VIDEO_AWEME_ID}`,
        { waitUntil: 'domcontentloaded' },
      );
      await secondDouyinPage.waitForTimeout(400);
      await expect(secondDouyinPage.locator('button.cp-fab-btn')).toHaveCount(0);

      // 重新开启悬浮图标开关 -> 两个已打开页面实时恢复显示
      await floatingSwitch.click();
      await expect(floatingSwitch).toHaveAttribute('aria-checked', 'true');
      await expect(fabButton).toBeVisible();
      await expect(secondDouyinPage.locator('button.cp-fab-btn')).toBeVisible();

      // 验证新增两个同步开关默认均为关闭，并切换后验证持久化
      const autoSyncAllSwitch = libraryPage.getByRole('switch', {
        name: '自动同步全部收藏',
      });
      const syncUncollectSwitch = libraryPage.getByRole('switch', {
        name: '取消收藏时同步至插件',
      });
      await expect(autoSyncAllSwitch).toHaveAttribute('aria-checked', 'false');
      await expect(syncUncollectSwitch).toHaveAttribute('aria-checked', 'false');
      await autoSyncAllSwitch.click();
      await syncUncollectSwitch.click();
      await expect(autoSyncAllSwitch).toHaveAttribute('aria-checked', 'true');
      await expect(syncUncollectSwitch).toHaveAttribute('aria-checked', 'true');

      // 修改并发数、自动同步与默认显示偏好并验证刷新后持久化
      const concurrencyGroup = libraryPage.getByRole('group', {
        name: '最大并发下载任务数',
      });
      await concurrencyGroup.getByRole('button', { name: '4', exact: true }).click();

      const autoSyncSwitch = libraryPage.getByRole('switch', {
        name: '打开控制台时自动同步暂存内容',
      });
      await autoSyncSwitch.click();
      await expect(autoSyncSwitch).toHaveAttribute('aria-checked', 'false');

      await libraryPage.getByRole('button', { name: '紧凑列表' }).click();
      await libraryPage.locator('#setting-default-sort').selectOption('totalSizeBytes');

      // 注入 1 条索引记录，验证清空缓存后索引归零且偏好保留
      const seededRecord = buildSeedRecord({
        id: '01JSETTINGSSEEDITEM00000001',
        platform: 'zhihu',
        sourceId: 'zhihu-cache-test',
        kind: 'article',
        title: '缓存清理验证文章',
        description: '用于验证清空浏览器缓存索引。',
        authorName: '测试作者',
        collectedAt: Date.now(),
        totalSizeBytes: 2048,
      });

      await libraryPage.evaluate(async (record) => {
        await new Promise<void>((resolve, reject) => {
          const req = indexedDB.open('CollectPlusDB');
          req.onerror = () => reject(req.error);
          req.onsuccess = () => {
            const idb = req.result;
            const tx = idb.transaction('items', 'readwrite');
            tx.objectStore('items').put(record);
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
      }, seededRecord);

      await libraryPage.reload();
      await expect(libraryPage.getByLabel('排序方式')).toHaveValue('totalSizeBytes');
      await libraryPage.getByRole('button', { name: '设置', exact: true }).click();
      await expect(
        libraryPage.getByTestId('browser-cache-record-counts'),
      ).toContainText('1 条');
      await expect(
        libraryPage.getByRole('switch', {
          name: '打开控制台时自动同步暂存内容',
        }),
      ).toHaveAttribute('aria-checked', 'false');

      await libraryPage.getByRole('button', { name: '清空浏览器缓存' }).click();
      const confirmDialog = libraryPage.getByRole('dialog');
      await expect(confirmDialog).toBeVisible();
      await confirmDialog
        .getByRole('button', { name: '确认清空浏览器缓存' })
        .click();

      await expect(
        libraryPage.getByTestId('browser-cache-record-counts'),
      ).toContainText('0 条 · 0 目录 · 0 标签');

      // 验证清空缓存不会清除偏好设置
      await expect(
        libraryPage.getByRole('switch', {
          name: '打开控制台时自动同步暂存内容',
        }),
      ).toHaveAttribute('aria-checked', 'false');
      await expect(
        libraryPage.getByRole('switch', {
          name: '自动同步全部收藏',
        }),
      ).toHaveAttribute('aria-checked', 'true');
      await expect(
        libraryPage.getByRole('switch', {
          name: '取消收藏时同步至插件',
        }),
      ).toHaveAttribute('aria-checked', 'true');

      expect(pageErrors).toEqual([]);
    } finally {
      await tracker.dispose();
    }
  });

  test('媒体类型三项（全部/视频/图文）与 5 平台筛选（抖音/B站/知乎/YouTube/X）及文章离线阅读', async ({
    context,
    extensionUrl,
    pageErrors,
  }) => {
    const libraryPage = await context.newPage();
    await libraryPage.goto(extensionUrl('library.html'));

    const now = Date.now();
    const seedItems = [
      buildSeedRecord({
        id: '01JFILTERITEM0000000000001',
        platform: 'douyin',
        sourceId: 'dy-01',
        kind: 'video',
        title: '抖音短视频样本',
        description: '抖音视频描述',
        authorName: '抖音创作者',
        collectedAt: now - 1000,
        totalSizeBytes: 1024 * 1024,
        tags: ['预设摄影标签'],
      }),
      buildSeedRecord({
        id: '01JFILTERITEM0000000000002',
        platform: 'bilibili',
        sourceId: 'bv-01',
        kind: 'video',
        title: 'B站教程视频样本',
        description: 'B站视频描述',
        authorName: 'B站UP主',
        collectedAt: now - 2000,
        totalSizeBytes: 2 * 1024 * 1024,
      }),
      buildSeedRecord({
        id: '01JFILTERITEM0000000000003',
        platform: 'zhihu',
        sourceId: 'zh-01',
        kind: 'article',
        title: '知乎深度专栏文章样本',
        description: '这是一篇保存在本地的知乎离线文章正文内容。',
        authorName: '知乎答主',
        collectedAt: now - 3000,
        totalSizeBytes: 4096,
      }),
      buildSeedRecord({
        id: '01JFILTERITEM0000000000004',
        platform: 'youtube',
        sourceId: 'yt-01',
        kind: 'video',
        title: 'YouTube 科技测评样本',
        description: 'YouTube 视频描述',
        authorName: 'Tech Channel',
        collectedAt: now - 4000,
        totalSizeBytes: 5 * 1024 * 1024,
      }),
      buildSeedRecord({
        id: '01JFILTERITEM0000000000005',
        platform: 'twitter',
        sourceId: 'x-01',
        kind: 'gallery',
        title: 'X 图文动态样本',
        description: 'X 动态正文',
        authorName: 'X Author',
        collectedAt: now - 5000,
        totalSizeBytes: 512 * 1024,
      }),
      buildSeedRecord({
        id: '01JFILTERITEM0000000000006',
        platform: 'xiaohongshu',
        sourceId: 'xhs-01',
        kind: 'gallery',
        title: '小红书图文笔记样本',
        description: '小红书笔记正文',
        authorName: '小红薯作者',
        collectedAt: now - 6000,
        totalSizeBytes: 256 * 1024,
      }),
    ];

    await libraryPage.evaluate(async (records) => {
      await new Promise<void>((resolve, reject) => {
        const req = indexedDB.open('CollectPlusDB');
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const idb = req.result;
          const tx = idb.transaction('items', 'readwrite');
          const store = tx.objectStore('items');
          for (const rec of records) {
            store.put(rec);
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
    }, seedItems);

    await libraryPage.reload();
    await expect(libraryPage.locator('article')).toHaveCount(6);

    // 1. 媒体类型筛选：三项（全部 / 视频 / 图文）
    const mediaKindGroup = libraryPage.getByRole('group', {
      name: '媒体类型筛选',
    });
    await expect(mediaKindGroup.getByRole('button')).toHaveText([
      '全部',
      '视频',
      '图文',
    ]);

    await mediaKindGroup.getByRole('button', { name: '视频', exact: true }).click();
    await expect(libraryPage.locator('article')).toHaveCount(3);

    await mediaKindGroup.getByRole('button', { name: '图文', exact: true }).click();
    await expect(libraryPage.locator('article')).toHaveCount(3);
    await expect(libraryPage.getByText('知乎深度专栏文章样本')).toBeVisible();
    await expect(libraryPage.getByText('X 图文动态样本')).toBeVisible();
    await expect(libraryPage.getByText('小红书图文笔记样本')).toBeVisible();

    // 打开文章详情抽屉，验证离线阅读预览正常渲染无报错
    await libraryPage
      .locator('article')
      .filter({ hasText: '知乎深度专栏文章样本' })
      .click();
    const dialog = libraryPage.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('离线文章阅读')).toBeVisible();
    await expect(
      dialog
        .locator('article')
        .getByText('这是一篇保存在本地的知乎离线文章正文内容。'),
    ).toBeVisible();
    await libraryPage.keyboard.press('Escape');
    await expect(dialog).toBeHidden();

    // 重置媒体类型为全部
    await mediaKindGroup
      .getByRole('button', { name: '全部', exact: true })
      .click();
    await expect(libraryPage.locator('article')).toHaveCount(6);

    // 2. 平台筛选：抖音 / B站 / 小红书 / 知乎 / YouTube / X
    const platformGroup = libraryPage.getByRole('group', {
      name: '来源平台筛选',
    });

    const platformChecks: Array<{ label: string; expectedTitle: string }> = [
      { label: '抖音', expectedTitle: '抖音短视频样本' },
      { label: 'B站', expectedTitle: 'B站教程视频样本' },
      { label: '小红书', expectedTitle: '小红书图文笔记样本' },
      { label: '知乎', expectedTitle: '知乎深度专栏文章样本' },
      { label: 'YouTube', expectedTitle: 'YouTube 科技测评样本' },
      { label: 'X', expectedTitle: 'X 图文动态样本' },
    ];

    for (const check of platformChecks) {
      await platformGroup
        .getByRole('button', { name: check.label, exact: true })
        .click();
      await expect(libraryPage.locator('article')).toHaveCount(1);
      await expect(libraryPage.getByText(check.expectedTitle)).toBeVisible();
    }

    await platformGroup.getByRole('button', { name: '全部', exact: true }).click();
    await expect(libraryPage.locator('article')).toHaveCount(6);

    // 3. 验证侧边栏不再展示标签栏，但视频详情保留标签编辑且搜索栏可按标签检索
    const sidebar = libraryPage.locator('aside');
    await expect(sidebar.getByText('暂无标签')).toHaveCount(0);
    await expect(sidebar.getByText('预设摄影标签')).toHaveCount(0);

    const searchInput = libraryPage.getByPlaceholder(
      '全文检索标题、正文、作者、标签、备注...',
    );
    await searchInput.fill('预设摄影标签');
    await expect(libraryPage.locator('article')).toHaveCount(1);
    await expect(libraryPage.getByText('抖音短视频样本')).toBeVisible();
    await libraryPage.getByRole('button', { name: '清除搜索' }).click();
    await expect(libraryPage.locator('article')).toHaveCount(6);

    // 打开视频详情抽屉，确认已有标签保留且可新增标签并被搜索栏检索到
    await libraryPage
      .locator('article')
      .filter({ hasText: '抖音短视频样本' })
      .click();
    const videoDialog = libraryPage.getByRole('dialog');
    await expect(videoDialog).toBeVisible();
    await expect(videoDialog.getByText('预设摄影标签')).toBeVisible();

    const tagInput = videoDialog.getByPlaceholder('输入标签后回车添加...');
    await tagInput.fill('新增剪辑标签');
    await tagInput.press('Enter');
    await expect(videoDialog.getByText('新增剪辑标签')).toBeVisible();
    await videoDialog.getByRole('button', { name: '保存修改' }).click();
    await expect(videoDialog.getByText(/已保存到浏览器索引/)).toBeVisible();
    await libraryPage.keyboard.press('Escape');
    await expect(videoDialog).toBeHidden();

    await expect(sidebar.getByText('新增剪辑标签')).toHaveCount(0);
    await searchInput.fill('新增剪辑标签');
    await expect(libraryPage.locator('article')).toHaveCount(1);
    await expect(libraryPage.getByText('抖音短视频样本')).toBeVisible();

    expect(pageErrors).toEqual([]);
  });

  test('NSFW 内容过滤开关默认关闭，开启后隐藏 NSFW 标签与 pornhub/xvideos 来源条目', async ({
    context,
    extensionUrl,
    pageErrors,
  }) => {
    const libraryPage = await context.newPage();
    await libraryPage.goto(extensionUrl('library.html'));

    const now = Date.now();
    const seedItems = [
      buildSeedRecord({
        id: '01JNSFWITEM000000000000001',
        platform: 'douyin',
        sourceId: 'nsfw-safe',
        kind: 'video',
        title: '普通安全条目',
        description: '安全',
        authorName: '作者A',
        collectedAt: now - 1000,
        totalSizeBytes: 1024,
      }),
      buildSeedRecord({
        id: '01JNSFWITEM000000000000002',
        platform: 'zhihu',
        sourceId: 'nsfw-tag',
        kind: 'article',
        title: '带标签条目',
        description: '标签',
        authorName: '作者B',
        collectedAt: now - 2000,
        totalSizeBytes: 1024,
        tags: ['nsfw'],
      }),
      buildSeedRecord({
        id: '01JNSFWITEM000000000000003',
        platform: 'twitter',
        sourceId: 'nsfw-host',
        kind: 'video',
        title: '域名来源条目',
        description: '域名',
        authorName: '作者C',
        collectedAt: now - 3000,
        totalSizeBytes: 1024,
        sourceUrl: 'https://cn.pornhub.com/view_video.php?viewkey=x',
      }),
      buildSeedRecord({
        id: '01JNSFWITEM000000000000004',
        platform: 'twitter',
        sourceId: 'nsfw-lookalike',
        kind: 'video',
        title: '相似域名条目',
        description: '不应被过滤',
        authorName: '作者D',
        collectedAt: now - 4000,
        totalSizeBytes: 1024,
        sourceUrl: 'https://notxvideos.com/x',
      }),
    ];

    await libraryPage.evaluate(async (records) => {
      await new Promise<void>((resolve, reject) => {
        const req = indexedDB.open('CollectPlusDB');
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const idb = req.result;
          const tx = idb.transaction('items', 'readwrite');
          const store = tx.objectStore('items');
          for (const rec of records) {
            store.put(rec);
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
    }, seedItems);

    await libraryPage.reload();
    await expect(libraryPage.locator('article')).toHaveCount(4);

    await libraryPage.getByRole('button', { name: '设置', exact: true }).click();
    const nsfwSwitch = libraryPage.getByRole('switch', { name: 'NSFW 内容过滤' });
    await expect(nsfwSwitch).toHaveAttribute('aria-checked', 'false');
    await nsfwSwitch.click();
    await expect(nsfwSwitch).toHaveAttribute('aria-checked', 'true');

    await libraryPage.getByRole('button', { name: '全部收藏' }).first().click();
    await expect(libraryPage.locator('article')).toHaveCount(2);
    await expect(libraryPage.getByText('普通安全条目')).toBeVisible();
    await expect(libraryPage.getByText('相似域名条目')).toBeVisible();
    await expect(libraryPage.getByText('带标签条目')).toHaveCount(0);
    await expect(libraryPage.getByText('域名来源条目')).toHaveCount(0);

    // 刷新后偏好持久化，关闭后全部恢复
    await libraryPage.reload();
    await expect(libraryPage.locator('article')).toHaveCount(2);
    await libraryPage.getByRole('button', { name: '设置', exact: true }).click();
    await nsfwSwitch.click();
    await expect(nsfwSwitch).toHaveAttribute('aria-checked', 'false');
    await libraryPage.getByRole('button', { name: '全部收藏' }).first().click();
    await expect(libraryPage.locator('article')).toHaveCount(4);

    expect(pageErrors).toEqual([]);
  });
});
