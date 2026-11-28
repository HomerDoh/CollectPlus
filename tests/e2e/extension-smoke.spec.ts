import { expect, test } from './fixtures/extension.ts';

interface DnrRuleSummary {
  id: number;
  urlFilter?: string;
  initiatorDomains?: string[];
}

test.describe('CollectPlus 扩展启动与核心页面冒烟测试', () => {
  test('Service Worker 正常启动且 DNR 防盗链规则仅限定扩展自身 initiator', async ({
    serviceWorker,
    extensionId,
  }) => {
    expect(extensionId).toMatch(/^[a-z0-9]{32}$/i);

    await expect
      .poll(
        async () => {
          return serviceWorker.evaluate(async (): Promise<number> => {
            const rules = await chrome.declarativeNetRequest.getSessionRules();
            return rules.length;
          });
        },
        { message: '等待 Background 同步全部已注册平台静态会话级 DNR 规则' },
      )
      .toBeGreaterThanOrEqual(20);

    const rules = await serviceWorker.evaluate(
      async (): Promise<DnrRuleSummary[]> => {
        const current = await chrome.declarativeNetRequest.getSessionRules();
        return current.map((rule) => ({
          id: rule.id,
          urlFilter: rule.condition.urlFilter,
          initiatorDomains: rule.condition.initiatorDomains,
        }));
      },
    );

    for (const rule of rules) {
      expect(rule.id).toBeGreaterThanOrEqual(1000);
      expect(rule.id).toBeLessThan(30000);
      expect(rule.initiatorDomains).toEqual([extensionId]);
      expect(rule.urlFilter).toBeTruthy();
    }
  });

  test('Popup / Library 扩展页面正常渲染且无未捕获运行时异常', async ({
    context,
    extensionUrl,
    pageErrors,
  }) => {
    const popupPage = await context.newPage();
    await popupPage.goto(extensionUrl('popup.html'));
    await expect(
      popupPage.getByRole('heading', { name: 'CollectPlus' }),
    ).toBeVisible();
    await expect(
      popupPage.getByRole('button', { name: /侧边栏/ }),
    ).toHaveCount(0);
    await expect(
      popupPage.getByRole('button', { name: /打开 Collect\+ 全屏管理台/ }),
    ).toBeVisible();

    const libraryPage = await context.newPage();
    await libraryPage.goto(extensionUrl('library.html'));
    await expect(
      libraryPage.getByPlaceholder('全文检索标题、正文、作者、标签、备注...'),
    ).toBeVisible();
    await expect(libraryPage.getByText('还没有收藏任何作品')).toBeVisible();

    expect(pageErrors).toEqual([]);
  });

  test('Popup 首次安装固定提示与未选定本地同步目录提示闭环验证', async ({
    context,
    extensionUrl,
    pageErrors,
  }) => {
    const popupPage = await context.newPage();
    await popupPage.goto(extensionUrl('popup.html'));

    // 1. 首次安装且未固定到工具栏时，展示固定提示与未选定目录提示
    const pinHint = popupPage.getByTestId('popup-pin-hint');
    await expect(pinHint).toBeVisible();
    await expect(pinHint).toContainText('固定到浏览器插件栏');

    const vaultHint = popupPage.getByTestId('popup-vault-hint');
    await expect(vaultHint).toBeVisible();
    await expect(vaultHint).toContainText('尚未选定本地同步目录');

    // 2. 点击「知道了」关闭固定提示并验证刷新后不再出现
    await pinHint.getByRole('button', { name: '关闭固定提示' }).click();
    await expect(pinHint).toBeHidden();
    await popupPage.reload();
    await expect(popupPage.getByTestId('popup-pin-hint')).toHaveCount(0);
    await expect(popupPage.getByTestId('popup-vault-hint')).toBeVisible();

    // 3. 点击「选择目录」直达管理台设置页的本地同步目录区块
    const newPagePromise = context.waitForEvent('page');
    await popupPage
      .getByTestId('popup-vault-hint')
      .getByRole('button', { name: '选择目录' })
      .click();
    const libraryPage = await newPagePromise;
    await libraryPage.waitForLoadState('domcontentloaded');

    const vaultSection = libraryPage.getByTestId('settings-vault-section');
    await expect(vaultSection).toBeVisible();
    await expect(
      vaultSection.getByRole('button', { name: '选择本地同步目录' }),
    ).toBeVisible();

    // 4. 在设置页绑定 Mock CollectVault 目录后，重新打开 Popup 确认目录提示消失
    await libraryPage.evaluate(() => {
      const win = window as unknown as {
        showDirectoryPicker?: () => Promise<FileSystemDirectoryHandle>;
      };
      win.showDirectoryPicker = async () => {
        const root = await navigator.storage.getDirectory();
        return root.getDirectoryHandle('CollectVault', { create: true });
      };
    });
    await vaultSection
      .getByRole('button', { name: '选择本地同步目录' })
      .click();
    await expect(vaultSection.getByText('已授权就绪')).toBeVisible();

    const reopenedPopup = await context.newPage();
    await reopenedPopup.goto(extensionUrl('popup.html'));
    await expect(
      reopenedPopup.getByRole('heading', { name: 'CollectPlus' }),
    ).toBeVisible();
    await expect(
      reopenedPopup.getByText('当前页面暂不支持采集'),
    ).toBeVisible();
    await expect(reopenedPopup.getByTestId('popup-vault-hint')).toHaveCount(0);
    await expect(reopenedPopup.getByTestId('popup-pin-hint')).toHaveCount(0);

    expect(pageErrors).toEqual([]);
  });
});
