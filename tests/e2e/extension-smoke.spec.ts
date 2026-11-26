import { expect, test } from './fixtures/extension.ts';

interface DnrRuleSummary {
  id: number;
  urlFilter?: string;
  initiatorDomains?: string[];
}

test.describe('Collect+ 扩展启动与核心页面冒烟测试', () => {
  test('Service Worker 正常启动且 DNR 防盗链规则仅限定扩展自身 initiator', async ({
    serviceWorker,
    extensionId,
  }) => {
    expect(extensionId).toMatch(/^[a-z0-9]{32}$/i);

    await expect
      .poll(
        async () => {
          return serviceWorker.evaluate(async (): Promise<DnrRuleSummary[]> => {
            const rules = await chrome.declarativeNetRequest.getSessionRules();
            return rules.map((rule) => ({
              id: rule.id,
              urlFilter: rule.condition.urlFilter,
              initiatorDomains: rule.condition.initiatorDomains,
            }));
          });
        },
        { message: '等待 Background 同步抖音会话级 DNR 规则' },
      )
      .toHaveLength(7);

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
      popupPage.getByRole('heading', { name: 'Collect+' }),
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
});
