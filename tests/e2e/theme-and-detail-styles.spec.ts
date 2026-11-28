import { expect, test } from './fixtures/extension.ts';

function buildSeedItem(
  id: string,
  platform: 'douyin' | 'zhihu' | 'bilibili',
  title: string,
): Record<string, unknown> {
  const now = Date.now();
  return {
    schemaVersion: 1,
    id,
    dedupeKey: `${platform}:${id}`,
    platform,
    sourceId: id,
    sourceUrl: `https://example.com/${platform}/${id}`,
    kind: 'article',
    title,
    description: `${title} 正文内容`,
    author: { id: `author-${platform}`, name: `作者-${platform}` },
    collectedAt: now,
    updatedAt: now,
    folderId: null,
    folderIds: [],
    tags: ['测试'],
    note: '',
    relativeDir: `items/${platform}/2026-11/20261128_${id}`,
    assets: [],
    syncStatus: 'opfs_staged',
    totalSizeBytes: 1024,
    deletedAt: null,
  };
}

test.describe('Collect+ 瑞士极简主题切换与平台详情页原生配色', () => {
  test('侧边栏默认跟随系统，切换明暗主题持久化并同步至 Popup，且不同平台详情页应用各自配色', async ({
    context,
    extensionUrl,
    pageErrors,
  }) => {
    const libraryPage = await context.newPage();
    await libraryPage.goto(extensionUrl('library.html'), {
      waitUntil: 'domcontentloaded',
    });

    // 1. 侧边栏底部设置按钮与主题切换胶囊同一行排列，且默认选中 system
    const settingsBtn = libraryPage.getByTestId('sidebar-settings-btn');
    const switcher = libraryPage.getByTestId('sidebar-theme-switcher');
    await expect(settingsBtn).toBeVisible();
    await expect(switcher).toBeVisible();
    const [settingsBox, switcherBox] = await Promise.all([
      settingsBtn.boundingBox(),
      switcher.boundingBox(),
    ]);
    expect(settingsBox).not.toBeNull();
    expect(switcherBox).not.toBeNull();
    if (settingsBox && switcherBox) {
      const settingsCenterY = settingsBox.y + settingsBox.height / 2;
      const switcherCenterY = switcherBox.y + switcherBox.height / 2;
      expect(Math.abs(settingsCenterY - switcherCenterY)).toBeLessThan(6);
      expect(switcherBox.x).toBeGreaterThanOrEqual(
        settingsBox.x + settingsBox.width - 1,
      );
    }
    await expect(libraryPage.getByTestId('theme-option-system')).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    // 2. 切换为暗色并验证 DOM 属性与刷新持久化
    await libraryPage.getByTestId('theme-option-dark').click();
    await expect(libraryPage.locator('html')).toHaveAttribute(
      'data-theme',
      'dark',
    );
    await expect(libraryPage.locator('html')).toHaveAttribute(
      'data-theme-mode',
      'dark',
    );

    await libraryPage.reload({ waitUntil: 'domcontentloaded' });
    await expect(libraryPage.locator('html')).toHaveAttribute(
      'data-theme',
      'dark',
    );
    await expect(libraryPage.getByTestId('theme-option-dark')).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    // 3. 验证扩展 Popup 同步应用暗色主题
    const popupPage = await context.newPage();
    await popupPage.goto(extensionUrl('popup.html'), {
      waitUntil: 'domcontentloaded',
    });
    await expect(popupPage.locator('html')).toHaveAttribute(
      'data-theme',
      'dark',
    );

    // 4. 在 Library 切回亮色，验证 Popup 实时同步
    await libraryPage.getByTestId('theme-option-light').click();
    await expect(libraryPage.locator('html')).toHaveAttribute(
      'data-theme',
      'light',
    );
    await expect(popupPage.locator('html')).toHaveAttribute(
      'data-theme',
      'light',
    );
    await popupPage.close();

    // 5. 写入抖音、B站与知乎三条记录，验证详情页挂载各自平台独立样式与增强令牌
    const seedItems = [
      buildSeedItem('dy-theme-1', 'douyin', '抖音配色测试条目'),
      buildSeedItem('bili-theme-1', 'bilibili', 'B站配色测试条目'),
      buildSeedItem('zh-theme-1', 'zhihu', '知乎配色测试条目'),
    ];
    await libraryPage.evaluate(async (records) => {
      await new Promise<void>((resolve, reject) => {
        const req = indexedDB.open('CollectPlusDB');
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction('items', 'readwrite');
          const store = tx.objectStore('items');
          for (const rec of records) {
            store.put(rec);
          }
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
      });
    }, seedItems);

    await libraryPage.reload({ waitUntil: 'domcontentloaded' });

    // 打开抖音详情页（曜石黑 + 抖音红，与 B 站粉蓝明确区分）
    await libraryPage.getByText('抖音配色测试条目').click();
    const detailDialog = libraryPage.getByTestId('item-detail-dialog');
    await expect(detailDialog).toHaveAttribute('data-platform', 'douyin');
    const douyinLightTokens = await detailDialog.evaluate((el) => {
      const style = getComputedStyle(el);
      return {
        accent: style.getPropertyValue('--pd-accent').trim().toLowerCase(),
        secondary: style
          .getPropertyValue('--pd-accent-secondary')
          .trim()
          .toLowerCase(),
        pillRadius: style.getPropertyValue('--pd-radius-pill').trim(),
      };
    });
    expect(douyinLightTokens.accent).toBe('#fe2c55');
    expect(douyinLightTokens.secondary).toBe('#161823');
    expect(douyinLightTokens.pillRadius).toBe('4px');
    await libraryPage.keyboard.press('Escape');

    // 打开 B 站详情页（验证亮色主/副强调色与胶囊圆角令牌）
    await libraryPage.getByText('B站配色测试条目').click();
    await expect(detailDialog).toHaveAttribute('data-platform', 'bilibili');
    const biliLightTokens = await detailDialog.evaluate((el) => {
      const style = getComputedStyle(el);
      return {
        accent: style.getPropertyValue('--pd-accent').trim().toLowerCase(),
        secondary: style
          .getPropertyValue('--pd-accent-secondary')
          .trim()
          .toLowerCase(),
        pillRadius: style.getPropertyValue('--pd-radius-pill').trim(),
      };
    });
    expect(biliLightTokens.accent).toBe('#fb7299');
    expect(biliLightTokens.secondary).toBe('#00aeec');
    expect(biliLightTokens.pillRadius).toBe('9999px');
    await libraryPage.keyboard.press('Escape');

    // 打开知乎详情页（亮色与暗色）
    await libraryPage.getByText('知乎配色测试条目').click();
    await expect(detailDialog).toHaveAttribute('data-platform', 'zhihu');
    const zhihuLightAccent = await detailDialog.evaluate((el) =>
      getComputedStyle(el).getPropertyValue('--pd-accent').trim().toLowerCase(),
    );
    expect(['#0066ff', '#06f']).toContain(zhihuLightAccent);
    await libraryPage.keyboard.press('Escape');

    await libraryPage.getByTestId('theme-option-dark').click();
    await libraryPage.getByText('知乎配色测试条目').click();
    const zhihuDarkAccent = await detailDialog.evaluate((el) =>
      getComputedStyle(el).getPropertyValue('--pd-accent').trim().toLowerCase(),
    );
    expect(zhihuDarkAccent).toBe('#3b82f6');
    await libraryPage.keyboard.press('Escape');

    // 暗色模式下再次验证 B 站副强调色自动切换
    await libraryPage.getByText('B站配色测试条目').click();
    const biliDarkSecondary = await detailDialog.evaluate((el) =>
      getComputedStyle(el)
        .getPropertyValue('--pd-accent-secondary')
        .trim()
        .toLowerCase(),
    );
    expect(biliDarkSecondary).toBe('#33c1f2');

    expect(pageErrors).toEqual([]);
  });
});
