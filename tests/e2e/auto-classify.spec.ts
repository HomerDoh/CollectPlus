import { expect, test } from './fixtures/extension.ts';
import {
  installDouyinMockRoutes,
  MOCK_VIDEO_AWEME_ID,
  MOCK_VIDEO_TITLE,
} from './fixtures/douyin-mock.ts';

interface StoredItemSummary {
  id: string;
  sourceId: string;
  title: string;
  folderId: string | null;
  folderIds: string[];
  folderAssignedBy?: 'manual' | 'auto';
}

test.describe('Collect+ 前置手动指定文件夹与本地高准确率自动分类 E2E', () => {
  test('前置手动指定（悬浮按钮 / 原生收藏 5s Toast / Popup）优先，未指定时按规则与历史学习自动分类并安全兜底未分类', async ({
    context,
    extensionUrl,
    pageErrors,
  }) => {
    const tracker = await installDouyinMockRoutes(context);
    try {
      // 1. 打开管理台，创建 3 个测试文件夹：「摄影」、「抽象灵感」、「前端」
      const libraryPage = await context.newPage();
      await libraryPage.goto(extensionUrl('library.html'));

      const sidebar = libraryPage.locator('aside');
      const createFolderViaSidebar = async (name: string): Promise<void> => {
        await sidebar.getByTitle('新建顶级文件夹').click();
        const input = sidebar.getByPlaceholder('输入文件夹名称');
        await input.fill(name);
        await input.press('Enter');
        await expect(sidebar.getByText(name, { exact: true })).toBeVisible();
      };

      await createFolderViaSidebar('摄影');
      await createFolderViaSidebar('抽象灵感');
      await createFolderViaSidebar('前端');

      // 读取新建文件夹 ID 映射
      const folderIdByName = await libraryPage.evaluate(async () => {
        return new Promise<Record<string, string>>((resolve, reject) => {
          const req = indexedDB.open('CollectPlusDB');
          req.onerror = () => reject(req.error);
          req.onsuccess = () => {
            const idb = req.result;
            const tx = idb.transaction('folders', 'readonly');
            const getAllReq = tx.objectStore('folders').getAll();
            getAllReq.onsuccess = () => {
              const map: Record<string, string> = {};
              for (const f of getAllReq.result as Array<{ id: string; name: string }>) {
                map[f.name] = f.id;
              }
              idb.close();
              resolve(map);
            };
            getAllReq.onerror = () => {
              idb.close();
              reject(getAllReq.error);
            };
          };
        });
      });

      const photoFolderId = folderIdByName['摄影']!;
      const abstractFolderId = folderIdByName['抽象灵感']!;
      const frontendFolderId = folderIdByName['前端']!;
      expect(photoFolderId).toBeTruthy();
      expect(abstractFolderId).toBeTruthy();
      expect(frontendFolderId).toBeTruthy();

      // 2. 为「抽象灵感」文件夹配置 Tier 1 显式关键词规则（书单, 纪录片）
      const abstractRow = sidebar
        .locator('div.group')
        .filter({ hasText: '抽象灵感' })
        .first();
      await abstractRow.hover();
      await sidebar.getByTestId(`sidebar-folder-rule-${abstractFolderId}`).click();
      const ruleModal = libraryPage.getByTestId('folder-rule-modal');
      await expect(ruleModal).toBeVisible();
      await ruleModal.getByTestId('folder-rule-keywords-input').fill('书单, 纪录片');
      await ruleModal.getByTestId('folder-rule-save-btn').click();
      await expect(ruleModal).toBeHidden();

      // 3. 在抖音页面使用悬浮按钮前置锁定「摄影」文件夹，覆盖自动分类（即使标题含「纪录片」也应进入手动指定的「摄影」）
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

      const fabFolderBtn = douyinPage.getByTestId('cp-fab-folder-btn');
      await expect(fabFolderBtn).toBeVisible();
      await fabFolderBtn.click();
      const fabPopover = douyinPage.getByTestId('cp-fab-folder-popover');
      await expect(fabPopover).toBeVisible();
      await douyinPage
        .getByTestId(`cp-fab-folder-opt-${photoFolderId}`)
        .click();
      await expect(fabFolderBtn).toContainText('摄影');

      await douyinPage.locator('button.cp-fab-btn').click();
      await expect(libraryPage.getByText(MOCK_VIDEO_TITLE)).toBeVisible({
        timeout: 20_000,
      });

      const readItems = async (): Promise<StoredItemSummary[]> =>
        libraryPage.evaluate(async () => {
          return new Promise<StoredItemSummary[]>((resolve, reject) => {
            const req = indexedDB.open('CollectPlusDB');
            req.onerror = () => reject(req.error);
            req.onsuccess = () => {
              const idb = req.result;
              const tx = idb.transaction('items', 'readonly');
              const getAllReq = tx.objectStore('items').getAll();
              getAllReq.onsuccess = () => {
                idb.close();
                resolve(
                  (getAllReq.result as StoredItemSummary[]).map((it) => ({
                    id: it.id,
                    sourceId: it.sourceId,
                    title: it.title,
                    folderId: it.folderId,
                    folderIds: it.folderIds,
                    ...(it.folderAssignedBy
                      ? { folderAssignedBy: it.folderAssignedBy }
                      : {}),
                  })),
                );
              };
              getAllReq.onerror = () => {
                idb.close();
                reject(getAllReq.error);
              };
            };
          });
        });

      const afterFabCapture = await readItems();
      const fabItem = afterFabCapture.find(
        (it) => it.sourceId === MOCK_VIDEO_AWEME_ID,
      );
      expect(fabItem?.folderId).toBe(photoFolderId);
      expect(fabItem?.folderAssignedBy).toBe('manual');

      // 4. 原站原生收藏 5 秒 Toast 前置选择目标目录 -> 立即归入「前端」且标记 manual
      await douyinPage.evaluate(() => {
        const aweme = {
          aweme_id: '7900000000000000099',
          desc: '年度精选纪录片书单推荐 #纪录片',
          create_time: Math.floor(Date.now() / 1000),
          author: { uid: 'u-native-toast', nickname: '原生收藏作者' },
          video: {
            duration: 10000,
            play_addr: { url_list: ['https://v26-web.douyinvod.com/test/video-native.mp4'] },
            cover: { url_list: ['https://p3-pc.douyinpic.com/img/test/cover.png'] },
          },
        };
        window.postMessage(
          {
            channel: 'collect-plus:page-bridge',
            direction: 'main-to-content',
            type: 'NATIVE_COLLECT_CAPTURED',
            platform: 'douyin',
            sourceId: aweme.aweme_id,
            rawData: aweme,
          },
          '*',
        );
      });

      const nativeToast = douyinPage.getByTestId('cp-native-collect-toast');
      await expect(nativeToast).toBeVisible({ timeout: 10_000 });
      const toastSelect = douyinPage.getByTestId('cp-native-folder-select');
      // 预演应命中「抽象灵感」（Tier 1 规则），但用户前置手动改选为「前端」
      await expect(toastSelect).toContainText('自动分类 → 抽象灵感', {
        timeout: 10_000,
      });
      await toastSelect.selectOption(frontendFolderId);
      await expect(nativeToast).toBeHidden();

      await expect
        .poll(async () => {
          const items = await readItems();
          return items.find((i) => i.sourceId === '7900000000000000099');
        })
        .toMatchObject({
          folderId: frontendFolderId,
          folderAssignedBy: 'manual',
        });

      // 5. 未手动指定 folderId 时：
      //    5a. 命中 Tier 1 规则 -> 自动归入「抽象灵感」(auto)
      //    5b. 携带原站收藏夹名但正文完全无关 -> 绝不参考原站收藏夹名，严格兜底进未分类 (null)
      const autoResponses = await libraryPage.evaluate(async () => {
        const send = (payload: Record<string, unknown>) =>
          chrome.runtime.sendMessage({
            target: 'background',
            type: 'CAPTURE_ITEM',
            payload,
          });
        const rRule = await send({
          platform: 'zhihu',
          sourceId: 'zh-rule-hit-1',
          sourceUrl: 'https://www.zhihu.com/question/1',
          kind: 'article',
          title: '豆瓣高分纪录片推荐清单',
          description: '值得收藏的深度人文纪录片整理',
          author: { id: 'zh-u1', name: '影评人' },
          hashtags: ['影视'],
          assets: [],
          triggerSource: 'native_collect',
        });
        const rUnrelated = await send({
          platform: 'bilibili',
          sourceId: 'bv-unrelated-1',
          sourceUrl: 'https://www.bilibili.com/video/BV1unrelated',
          kind: 'video',
          title: '今天天气不错随便录一段',
          description: '哈哈哈',
          author: { id: 'b-u-new', name: '路人甲' },
          hashtags: [],
          assets: [],
          platformExtra: {
            favFolderTitle: '前端',
            favoriteFolderName: '摄影',
          },
          triggerSource: 'native_collect',
        });
        return { rRule, rUnrelated };
      });

      expect(autoResponses.rRule).toMatchObject({
        ok: true,
        item: {
          folderId: abstractFolderId,
          folderAssignedBy: 'auto',
        },
      });
      expect(autoResponses.rUnrelated).toMatchObject({
        ok: true,
        item: {
          folderId: null,
          folderIds: [],
        },
      });

      // 6. Popup 前置选择目标文件夹下拉可见且包含全部已建目录
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
      const popupFolderSelect = popupPage.getByTestId('popup-folder-select');
      await expect(popupFolderSelect).toBeVisible({ timeout: 10_000 });
      await expect(popupFolderSelect).toHaveValue('__auto__');
      await popupFolderSelect.selectOption(photoFolderId);
      await expect(popupFolderSelect).toHaveValue(photoFolderId);

      // 7. 设置页「未手动指定文件夹时的归类方式」默认选中智能自动分类，切换后持久化
      await sidebar.getByRole('button', { name: '设置', exact: true }).click();
      const defaultFolderSelect = libraryPage.locator('#setting-default-folder');
      await expect(defaultFolderSelect).toHaveValue('__auto__');
      await defaultFolderSelect.selectOption('');
      await expect(defaultFolderSelect).toHaveValue('');
      await defaultFolderSelect.selectOption('__auto__');
      await expect(defaultFolderSelect).toHaveValue('__auto__');

      expect(pageErrors).toEqual([]);
    } finally {
      await tracker.dispose();
    }
  });
});
