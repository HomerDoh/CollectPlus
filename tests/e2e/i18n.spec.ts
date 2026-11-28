import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium, expect, test } from '@playwright/test';

function resolveExtensionPath(): string {
  const distPath = path.resolve(process.cwd(), '.output', 'chrome-mv3');
  const manifestPath = path.join(distPath, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Missing built extension: ${manifestPath}`);
  }
  return distPath;
}

test('i18n: English locale (--lang=en-US) renders manifest, popup, library and settings in English', async ({
  headless,
}) => {
  const extensionPath = resolveExtensionPath();
  expect(
    fs.existsSync(path.join(extensionPath, '_locales', 'zh_CN', 'messages.json')),
  ).toBe(true);
  expect(
    fs.existsSync(path.join(extensionPath, '_locales', 'en', 'messages.json')),
  ).toBe(true);

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collect-plus-en-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless,
    locale: 'en-US',
    viewport: { width: 1280, height: 800 },
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      '--lang=en-US',
      '--no-first-run',
      '--no-default-browser-check',
    ],
  });

  const pageErrors: string[] = [];
  context.on('page', (page) => {
    page.on('pageerror', (error) => {
      pageErrors.push(`[${page.url()}] ${error.message}`);
    });
  });

  try {
    let worker = context.serviceWorkers()[0];
    if (!worker) {
      worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
    }

    const match = /^chrome-extension:\/\/([a-z0-9]+)\//i.exec(worker.url());
    const extensionId = match?.[1];
    expect(extensionId).toBeTruthy();

    const uiLang = await worker.evaluate(() => chrome.i18n.getUILanguage());
    expect(uiLang.toLowerCase()).toMatch(/^en/);

    const manifestDesc = await worker.evaluate(
      () => chrome.runtime.getManifest().description,
    );
    expect(manifestDesc).toContain('Local-first');

    const popupPage = await context.newPage();
    await popupPage.goto(`chrome-extension://${extensionId}/popup.html`);
    await expect(popupPage.getByText('Local-first offline archive')).toBeVisible();
    await expect(
      popupPage.getByRole('button', { name: 'Open Collect+ Library' }),
    ).toBeVisible();

    const libraryPage = await context.newPage();
    await libraryPage.goto(`chrome-extension://${extensionId}/library.html`);
    await expect(libraryPage).toHaveTitle('Collect+ Library');
    await expect(
      libraryPage.getByRole('button', { name: /All Items/ }),
    ).toBeVisible();

    await libraryPage.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(libraryPage.getByText('Extension Settings')).toBeVisible();
    await expect(
      libraryPage.getByText('Local Sync Folder (CollectVault)'),
    ).toBeVisible();

    expect(pageErrors).toEqual([]);
  } finally {
    await context.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test('i18n: Settings language selector switches Library and Popup live and persists across reload', async ({
  headless,
}) => {
  const extensionPath = resolveExtensionPath();
  const userDataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'collect-plus-lang-switch-'),
  );
  const context = await chromium.launchPersistentContext(userDataDir, {
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

  const pageErrors: string[] = [];
  context.on('page', (page) => {
    page.on('pageerror', (error) => {
      pageErrors.push(`[${page.url()}] ${error.message}`);
    });
  });

  try {
    let worker = context.serviceWorkers()[0];
    if (!worker) {
      worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
    }
    const extensionId = /^chrome-extension:\/\/([a-z0-9]+)\//i.exec(
      worker.url(),
    )?.[1];
    expect(extensionId).toBeTruthy();

    const libraryPage = await context.newPage();
    await libraryPage.goto(`chrome-extension://${extensionId}/library.html`);
    await expect(libraryPage).toHaveTitle('Collect+ 媒体库');

    const popupPage = await context.newPage();
    await popupPage.goto(`chrome-extension://${extensionId}/popup.html`);
    await expect(popupPage.getByText('本地优先防失效收藏')).toBeVisible();

    // 在设置页切换到 English，验证管理台与已打开的 Popup 即时更新
    await libraryPage.bringToFront();
    await libraryPage.getByRole('button', { name: '设置', exact: true }).click();
    const langSelect = libraryPage.getByTestId('setting-ui-language');
    await expect(langSelect).toHaveValue('auto');

    await langSelect.selectOption('en');
    await expect(libraryPage.getByText('Extension Settings')).toBeVisible();
    await expect(libraryPage).toHaveTitle('Collect+ Library');
    await expect(popupPage.getByText('Local-first offline archive')).toBeVisible();

    // 刷新管理台后仍保持 English
    await libraryPage.reload();
    await expect(libraryPage).toHaveTitle('Collect+ Library');
    await expect(
      libraryPage.getByRole('button', { name: /All Items/ }),
    ).toBeVisible();

    // 切回简体中文并验证恢复
    await libraryPage
      .getByRole('button', { name: 'Settings', exact: true })
      .click();
    await expect(libraryPage.getByTestId('setting-ui-language')).toHaveValue(
      'en',
    );
    await libraryPage.getByTestId('setting-ui-language').selectOption('zh_CN');
    await expect(libraryPage.getByText('插件设置')).toBeVisible();
    await expect(libraryPage).toHaveTitle('Collect+ 媒体库');
    await expect(popupPage.getByText('本地优先防失效收藏')).toBeVisible();

    expect(pageErrors).toEqual([]);
  } finally {
    await context.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
