import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from '@playwright/test';
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
      popupPage.getByRole('button', { name: /打开 CollectPlus 全屏管理台/ }),
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
    await expect(vaultHint).toContainText('请设置同步文件夹');
    await expect(vaultHint).toContainText(
      '设置后，收藏内容将会保存到同步文件夹中',
    );

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

  test('首次安装、重启浏览器、打开网站未设置同步目录时自动弹窗，勾选不再提醒或设置目录后不再弹出', async ({
    extensionPath,
    headless,
  }) => {
    const userDataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'collect-plus-vault-popup-'),
    );

    const launchWithProfile = () =>
      chromium.launchPersistentContext(userDataDir, {
        channel: 'chromium',
        headless,
        viewport: { width: 1280, height: 800 },
        args: [
          `--disable-extensions-except=${extensionPath}`,
          `--load-extension=${extensionPath}`,
          '--lang=zh-CN',
          '--no-first-run',
          '--no-default-browser-check',
        ],
      });

    const getServiceWorker = async (
      ctx: Awaited<ReturnType<typeof launchWithProfile>>,
    ) => {
      let sw = ctx.serviceWorkers()[0];
      if (!sw) {
        sw = await ctx.waitForEvent('serviceworker', { timeout: 15_000 });
      }
      return sw;
    };

    const getOpenPopupUrls = async (
      sw: Awaited<ReturnType<typeof getServiceWorker>>,
    ): Promise<string[]> =>
      sw.evaluate(async () => {
        const contexts = await chrome.runtime.getContexts({
          contextTypes: ['POPUP'],
        });
        return contexts.map((c) => c.documentUrl ?? '');
      });

    try {
      // 1. 首次安装（未设置同步目录）：自动打开插件栏 Popup
      const installCtx = await launchWithProfile();
      try {
        const sw = await getServiceWorker(installCtx);
        await expect
          .poll(() => getOpenPopupUrls(sw), {
            message: '等待首次安装后自动弹出插件栏 Popup',
          })
          .toEqual([expect.stringMatching(/\/popup\.html$/)]);
      } finally {
        await installCtx.close();
      }

      // 2. 重新打开浏览器（仍未设置同步目录）：自动弹出，关闭后再打开网站也自动弹出，勾选“不再提醒”后打开网站不再弹出
      const restartUnboundCtx = await launchWithProfile();
      try {
        const sw = await getServiceWorker(restartUnboundCtx);
        await expect
          .poll(() => getOpenPopupUrls(sw), {
            message: '等待浏览器启动后自动弹出插件栏 Popup',
          })
          .toEqual([expect.stringMatching(/\/popup\.html$/)]);

        // 关闭当前弹窗（打开新标签页/模拟用户点走）并验证打开普通网站时再次自动弹窗
        await restartUnboundCtx.route('https://example.test/**', (route) =>
          route.fulfill({
            status: 200,
            contentType: 'text/html; charset=utf-8',
            body: '<!doctype html><html><head><title>Test Site</title></head><body>Hello</body></html>',
          }),
        );

        const match = /^chrome-extension:\/\/([a-z0-9]+)\//i.exec(sw.url());
        const extId = match?.[1];
        expect(extId).toBeTruthy();

        // 先切到扩展空白页让原 toolbar popup 关闭，确保后续观察到的是打开网站触发的新弹窗
        const helperPage = await restartUnboundCtx.newPage();
        await helperPage.goto(`chrome-extension://${extId}/popup.html`);
        await helperPage.close();
        await expect
          .poll(async () => (await getOpenPopupUrls(sw)).length, {
            message: '等待初始 Popup 关闭后再测试打开网站触发',
          })
          .toBe(0);

        const sitePage = await restartUnboundCtx.newPage();
        await sitePage.goto('https://example.test/page-1', {
          waitUntil: 'load',
        });
        await expect
          .poll(() => getOpenPopupUrls(sw), {
            message: '等待打开普通网站后自动弹出插件栏 Popup',
          })
          .toEqual([expect.stringMatching(/\/popup\.html$/)]);

        // 在 Popup 中勾选「不再提醒」
        const popupPage = await restartUnboundCtx.newPage();
        await popupPage.goto(`chrome-extension://${extId}/popup.html`);
        const dontRemindCheckbox = popupPage.getByTestId(
          'popup-vault-hint-dont-remind',
        );
        await expect(dontRemindCheckbox).toBeVisible();
        await expect(dontRemindCheckbox).not.toBeChecked();
        await dontRemindCheckbox.check();
        await expect(dontRemindCheckbox).toBeChecked();
        await popupPage.close();

        await expect
          .poll(async () => (await getOpenPopupUrls(sw)).length)
          .toBe(0);

        // 勾选「不再提醒」后，再打开另一个网站不再自动弹窗
        const sitePage2 = await restartUnboundCtx.newPage();
        await sitePage2.goto('https://example.test/page-2', {
          waitUntil: 'load',
        });
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 1000);
        });
        expect((await getOpenPopupUrls(sw)).length).toBe(0);
      } finally {
        await restartUnboundCtx.close();
      }

      // 3. 勾选「不再提醒」后重启浏览器（仍未设置同步目录）：不再自动弹窗；取消勾选并设置同步目录后重启也不再弹出
      const restartMutedCtx = await launchWithProfile();
      try {
        const sw = await getServiceWorker(restartMutedCtx);
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 1000);
        });
        expect((await getOpenPopupUrls(sw)).length).toBe(0);

        const match = /^chrome-extension:\/\/([a-z0-9]+)\//i.exec(sw.url());
        const extId = match?.[1];
        expect(extId).toBeTruthy();

        // 验证重启后「不再提醒」勾选状态持久化，随后取消勾选并绑定同步目录
        const popupPage = await restartMutedCtx.newPage();
        await popupPage.goto(`chrome-extension://${extId}/popup.html`);
        const dontRemindCheckbox = popupPage.getByTestId(
          'popup-vault-hint-dont-remind',
        );
        await expect(dontRemindCheckbox).toBeChecked();
        await dontRemindCheckbox.uncheck();
        await expect(dontRemindCheckbox).not.toBeChecked();
        await popupPage.close();

        const libraryPage = await restartMutedCtx.newPage();
        await libraryPage.goto(
          `chrome-extension://${extId}/library.html#settings=vault`,
        );
        const vaultSection = libraryPage.getByTestId('settings-vault-section');
        await expect(vaultSection).toBeVisible();
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
      } finally {
        await restartMutedCtx.close();
      }

      // 4. 取消“不再提醒”且已设置同步目录后重启浏览器并打开网站：均不再自动弹出
      const restartBoundCtx = await launchWithProfile();
      try {
        const sw = await getServiceWorker(restartBoundCtx);
        await restartBoundCtx.route('https://example.test/**', (route) =>
          route.fulfill({
            status: 200,
            contentType: 'text/html; charset=utf-8',
            body: '<!doctype html><html><head><title>Bound Site</title></head><body>OK</body></html>',
          }),
        );
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 1000);
        });
        expect((await getOpenPopupUrls(sw)).length).toBe(0);

        const sitePage = await restartBoundCtx.newPage();
        await sitePage.goto('https://example.test/page-3', {
          waitUntil: 'load',
        });
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 1000);
        });
        expect((await getOpenPopupUrls(sw)).length).toBe(0);
      } finally {
        await restartBoundCtx.close();
      }
    } finally {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    }
  });
});
