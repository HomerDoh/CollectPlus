import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  chromium,
  test as base,
  type BrowserContext,
  type Page,
  type Worker,
} from '@playwright/test';

export interface ExtensionFixtures {
  extensionPath: string;
  context: BrowserContext;
  serviceWorker: Worker;
  extensionId: string;
  extensionUrl: (pagePath: string) => string;
  pageErrors: string[];
}

function resolveExtensionPath(): string {
  const distPath = path.resolve(process.cwd(), '.output', 'chrome-mv3');
  const manifestPath = path.join(distPath, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(
      `未找到构建后的扩展产物：${manifestPath}。请先运行 "pnpm build" 生成 .output/chrome-mv3/。`,
    );
  }
  return distPath;
}

function parseExtensionId(serviceWorkerUrl: string): string {
  const match = /^chrome-extension:\/\/([a-z0-9]+)\//i.exec(serviceWorkerUrl);
  const id = match?.[1];
  if (!id) {
    throw new Error(
      `无法从 Service Worker URL 解析 extensionId：${serviceWorkerUrl}`,
    );
  }
  return id;
}

export const test = base.extend<ExtensionFixtures>({
  extensionPath: async ({}, use) => {
    await use(resolveExtensionPath());
  },

  context: async ({ extensionPath, headless }, use) => {
    const configuredProfile = process.env.E2E_USER_DATA_DIR?.trim();
    const isPersistentCustomProfile = Boolean(configuredProfile);
    const userDataDir = configuredProfile
      ? path.resolve(process.cwd(), configuredProfile)
      : fs.mkdtempSync(path.join(os.tmpdir(), 'collect-plus-pw-'));

    if (isPersistentCustomProfile) {
      fs.mkdirSync(userDataDir, { recursive: true });
    }

    const context = await chromium.launchPersistentContext(userDataDir, {
      channel: 'chromium',
      headless,
      viewport: { width: 1280, height: 800 },
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
        '--no-first-run',
        '--no-default-browser-check',
      ],
    });

    try {
      await use(context);
    } finally {
      await context.close();
      if (!isPersistentCustomProfile) {
        fs.rmSync(userDataDir, { recursive: true, force: true });
      }
    }
  },

  serviceWorker: async ({ context }, use) => {
    let worker = context.serviceWorkers()[0];
    if (!worker) {
      worker = await context.waitForEvent('serviceworker', {
        timeout: 15_000,
      });
    }
    await use(worker);
  },

  extensionId: async ({ serviceWorker }, use) => {
    await use(parseExtensionId(serviceWorker.url()));
  },

  extensionUrl: async ({ extensionId }, use) => {
    await use((pagePath: string) => {
      const normalized = pagePath.replace(/^\/+/, '');
      return `chrome-extension://${extensionId}/${normalized}`;
    });
  },

  pageErrors: async ({ context }, use) => {
    const errors: string[] = [];
    const attach = (page: Page): void => {
      page.on('pageerror', (error) => {
        errors.push(`[${page.url()}] ${error.message}`);
      });
    };

    for (const existingPage of context.pages()) {
      attach(existingPage);
    }
    context.on('page', attach);

    await use(errors);
  },
});

export { expect } from '@playwright/test';
