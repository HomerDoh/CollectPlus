import { expect, test } from './fixtures/extension.ts';

interface SeedVaultItemSpec {
  id: string;
  sourceId: string;
  title: string;
  updatedAt: number;
  folderId: string | null;
  tags: string[];
  relativeDir: string;
  videoContent: string;
}

interface SeedVaultFolderSpec {
  id: string;
  name: string;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
}

interface SeedVaultInput {
  dirName: string;
  vaultId: string;
  folders: SeedVaultFolderSpec[];
  tags: Array<{ name: string; color: string; createdAt: number }>;
  items: SeedVaultItemSpec[];
}

function buildMetaJson(item: SeedVaultItemSpec): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: item.id,
    dedupeKey: `douyin:${item.sourceId}`,
    platform: 'douyin',
    sourceId: item.sourceId,
    sourceUrl: `https://www.douyin.com/video/${item.sourceId}`,
    kind: 'video',
    title: item.title,
    description: `${item.title} 描述`,
    author: {
      id: `author-${item.sourceId}`,
      name: '测试作者',
    },
    collectedAt: item.updatedAt - 1000,
    updatedAt: item.updatedAt,
    folderId: item.folderId,
    tags: item.tags,
    note: '',
    relativeDir: item.relativeDir,
    assets: [
      {
        id: 'video',
        kind: 'video',
        strategy: 'direct',
        sourceUrl: 'https://example.com/video.mp4',
        relativePath: 'video.mp4',
        mimeType: 'video/mp4',
        downloaded: true,
        sizeBytes: item.videoContent.length,
      },
    ],
    syncStatus: 'vault_synced',
    totalSizeBytes: item.videoContent.length,
    deletedAt: null,
  };
}

/** 在浏览器 OPFS 中构造一个合法的已初始化 CollectVault 目录 */
async function seedInitializedVaultInOpfs(
  page: import('@playwright/test').Page,
  spec: SeedVaultInput,
): Promise<void> {
  const metas = spec.items.map((item) => ({
    relativeDir: item.relativeDir,
    metaText: JSON.stringify(buildMetaJson(item), null, 2),
    videoContent: item.videoContent,
  }));

  await page.evaluate(
    async ({ dirName, vaultId, folders, tags, itemPayloads }) => {
      const writeText = async (
        root: FileSystemDirectoryHandle,
        relativePath: string,
        text: string,
      ) => {
        const parts = relativePath.split('/').filter(Boolean);
        let dir = root;
        for (let i = 0; i < parts.length - 1; i += 1) {
          const seg = parts[i];
          if (seg) {
            dir = await dir.getDirectoryHandle(seg, { create: true });
          }
        }
        const fileName = parts[parts.length - 1];
        if (!fileName) {
          return;
        }
        const fh = await dir.getFileHandle(fileName, { create: true });
        const writable = await fh.createWritable();
        await writable.write(text);
        await writable.close();
      };

      const opfsRoot = await navigator.storage.getDirectory();
      const vaultRoot = await opfsRoot.getDirectoryHandle(dirName, {
        create: true,
      });

      const now = Date.now();
      await writeText(
        vaultRoot,
        'README.txt',
        'Collect+ Local Offline Vault - 请勿手动重命名或删除目录内文件。\n',
      );
      await writeText(
        vaultRoot,
        '.collect-vault.json',
        JSON.stringify(
          {
            schemaVersion: 1,
            vaultId,
            name: dirName,
            createdAt: now - 10_000,
            updatedAt: now,
          },
          null,
          2,
        ),
      );
      await writeText(
        vaultRoot,
        'taxonomy.json',
        JSON.stringify(
          {
            schemaVersion: 1,
            updatedAt: now,
            folders: folders.map((f) => ({ ...f, parentId: null })),
            tags,
          },
          null,
          2,
        ),
      );
      await vaultRoot.getDirectoryHandle('items', { create: true });
      await vaultRoot.getDirectoryHandle('.trash', { create: true });

      for (const payload of itemPayloads) {
        await writeText(
          vaultRoot,
          `${payload.relativeDir}/meta.json`,
          payload.metaText,
        );
        await writeText(
          vaultRoot,
          `${payload.relativeDir}/video.mp4`,
          payload.videoContent,
        );
      }
    },
    {
      dirName: spec.dirName,
      vaultId: spec.vaultId,
      folders: spec.folders,
      tags: spec.tags,
      itemPayloads: metas,
    },
  );
}

/** 安装可控的 showDirectoryPicker 队列，按顺序返回指定的 OPFS 目录或模拟磁盘根目录 */
async function installPickerQueue(
  page: import('@playwright/test').Page,
  targets: Array<
    | { kind: 'opfs'; dirName: string; create?: boolean }
    | { kind: 'mock_root'; name: string }
    | { kind: 'security_error' }
  >,
): Promise<void> {
  await page.evaluate((queue) => {
    const win = window as unknown as {
      showDirectoryPicker?: () => Promise<FileSystemDirectoryHandle>;
    };
    let cursor = 0;

    win.showDirectoryPicker = async () => {
      const next = queue[cursor];
      cursor += 1;
      if (!next) {
        throw new DOMException('User cancelled', 'AbortError');
      }
      if (next.kind === 'security_error') {
        throw new DOMException(
          "Can't open system directory.",
          'SecurityError',
        );
      }
      if (next.kind === 'mock_root') {
        const fakeRoot = {
          kind: 'directory',
          name: next.name,
          queryPermission: async () => 'granted',
          requestPermission: async () => 'granted',
          isSameEntry: async () => false,
          entries: async function* () {
            // 磁盘根目录在进入遍历前即应被拦截
          },
        };
        return fakeRoot as unknown as FileSystemDirectoryHandle;
      }

      const opfsRoot = await navigator.storage.getDirectory();
      return opfsRoot.getDirectoryHandle(next.dirName, {
        create: next.create ?? true,
      });
    };
  }, targets);
}

async function listTopLevelNamesInOpfsDir(
  page: import('@playwright/test').Page,
  dirName: string,
): Promise<string[]> {
  return page.evaluate(async (name) => {
    const opfsRoot = await navigator.storage.getDirectory();
    const dir = await opfsRoot.getDirectoryHandle(name, { create: false });
    const names: string[] = [];
    for await (const [entryName] of dir.entries()) {
      names.push(entryName);
    }
    names.sort();
    return names;
  }, dirName);
}

async function collectMetaTitlesInOpfsVault(
  page: import('@playwright/test').Page,
  dirName: string,
): Promise<string[]> {
  return page.evaluate(async (name) => {
    const opfsRoot = await navigator.storage.getDirectory();
    const vaultRoot = await opfsRoot.getDirectoryHandle(name, {
      create: false,
    });
    const titles: string[] = [];

    let itemsDir: FileSystemDirectoryHandle;
    try {
      itemsDir = await vaultRoot.getDirectoryHandle('items', { create: false });
    } catch {
      return titles;
    }

    const walk = async (dir: FileSystemDirectoryHandle): Promise<void> => {
      for await (const [entryName, handle] of dir.entries()) {
        if (handle.kind === 'directory') {
          await walk(handle);
        } else if (handle.kind === 'file' && entryName === 'meta.json') {
          const file = await handle.getFile();
          const parsed: unknown = JSON.parse(await file.text());
          if (
            typeof parsed === 'object' &&
            parsed !== null &&
            'title' in parsed &&
            typeof (parsed as { title?: unknown }).title === 'string'
          ) {
            titles.push((parsed as { title: string }).title);
          }
        }
      }
    };

    await walk(itemsDir);
    titles.sort();
    return titles;
  }, dirName);
}

test.describe('Collect+ 本地同步目录校验与迁移管理 E2E 验证', () => {
  test('拒绝磁盘根目录与非空未初始化文件夹（零文件写入），空目录正常绑定', async ({
    context,
    extensionUrl,
    pageErrors,
  }) => {
    const libraryPage = await context.newPage();
    await libraryPage.goto(extensionUrl('library.html'));

    // 预置两个非法目录：1) 含 $RECYCLE.BIN 的模拟卷根 2) 含普通文件的非空目录
    await libraryPage.evaluate(async () => {
      const opfsRoot = await navigator.storage.getDirectory();

      const fakeVolumeRoot = await opfsRoot.getDirectoryHandle(
        'MountedVolume',
        { create: true },
      );
      await fakeVolumeRoot.getDirectoryHandle('$RECYCLE.BIN', { create: true });

      const userDocs = await opfsRoot.getDirectoryHandle('UserNonEmptyFolder', {
        create: true,
      });
      const noteHandle = await userDocs.getFileHandle('notes.txt', {
        create: true,
      });
      const writable = await noteHandle.createWritable();
      await writable.write('personal document');
      await writable.close();
    });

    await libraryPage.getByRole('button', { name: '设置', exact: true }).click();
    const vaultSection = libraryPage.getByTestId('settings-vault-section');
    await expect(vaultSection).toBeVisible();

    await installPickerQueue(libraryPage, [
      { kind: 'mock_root', name: 'D:\\' },
      { kind: 'mock_root', name: '/' },
      { kind: 'security_error' },
      { kind: 'opfs', dirName: 'MountedVolume', create: false },
      { kind: 'opfs', dirName: 'UserNonEmptyFolder', create: false },
      { kind: 'opfs', dirName: 'CleanVault', create: true },
    ]);

    const pickButton = vaultSection.getByRole('button', {
      name: '选择本地同步目录',
    });

    // 1. Windows 盘符根目录 D:\ -> 拒绝
    await pickButton.click();
    await expect(
      vaultSection.getByText(/不允许选择磁盘根目录/),
    ).toBeVisible();
    await expect(vaultSection.getByText('尚未绑定')).toBeVisible();

    // 2. POSIX 根目录 / -> 拒绝
    await pickButton.click();
    await expect(
      vaultSection.getByText(/不允许选择磁盘根目录/),
    ).toBeVisible();
    await expect(vaultSection.getByText('尚未绑定')).toBeVisible();

    // 3. 浏览器拦截系统根目录（SecurityError） -> 友好提示拒绝
    await pickButton.click();
    await expect(
      vaultSection.getByText(/不允许选择磁盘根目录/),
    ).toBeVisible();
    await expect(vaultSection.getByText('尚未绑定')).toBeVisible();

    // 4. 包含 $RECYCLE.BIN 的卷根目录 -> 拒绝且未写入插件文件
    await pickButton.click();
    await expect(
      vaultSection.getByText(/不允许选择磁盘根目录/),
    ).toBeVisible();
    expect(
      await listTopLevelNamesInOpfsDir(libraryPage, 'MountedVolume'),
    ).toEqual(['$RECYCLE.BIN']);

    // 5. 非空未初始化文件夹 -> 拒绝且零污染
    await pickButton.click();
    await expect(
      vaultSection.getByText(/不为空且未被 Collect\+ 初始化/),
    ).toBeVisible();
    await expect(vaultSection.getByText('尚未绑定')).toBeVisible();
    expect(
      await listTopLevelNamesInOpfsDir(libraryPage, 'UserNonEmptyFolder'),
    ).toEqual(['notes.txt']);

    // 6. 选择空目录 CleanVault -> 成功绑定并初始化结构
    await vaultSection.getByRole('button', { name: '重新选择目录' }).click();
    await expect(vaultSection.getByText('已授权就绪')).toBeVisible();
    await expect(vaultSection.getByText('CleanVault')).toBeVisible();
    expect(await listTopLevelNamesInOpfsDir(libraryPage, 'CleanVault')).toEqual(
      ['.collect-vault.json', '.trash', 'README.txt', 'items', 'taxonomy.json'],
    );

    expect(pageErrors).toEqual([]);
  });

  test('首次绑定已初始化目录时直接自动重建索引，并保留未落盘的 OPFS 暂存条目', async ({
    context,
    extensionUrl,
    pageErrors,
  }) => {
    const libraryPage = await context.newPage();
    await libraryPage.goto(extensionUrl('library.html'));

    const now = Date.now();
    await seedInitializedVaultInOpfs(libraryPage, {
      dirName: 'ExistingVault',
      vaultId: '01JEXISTINGVAULT0000000001',
      folders: [
        {
          id: 'folder-existing-1',
          name: '历史收藏夹',
          sortOrder: 0,
          createdAt: now - 5000,
          updatedAt: now - 5000,
        },
      ],
      tags: [{ name: '精选教程', color: '#3b82f6', createdAt: now - 5000 }],
      items: [
        {
          id: '01JEXISTINGITEM00000000001',
          sourceId: 'existing-001',
          title: '已有目录自动恢复视频',
          updatedAt: now - 3000,
          folderId: 'folder-existing-1',
          tags: ['精选教程'],
          relativeDir: 'items/douyin/2026-11/20261125_existing-001',
          videoContent: 'existing-video-binary-payload',
        },
      ],
    });

    // 同时在 IndexedDB + OPFS 中写入 1 条尚未绑定目录前采集的暂存条目，验证自动建索引不会丢失它
    await libraryPage.evaluate(async (timestamp) => {
      const opfsRoot = await navigator.storage.getDirectory();
      const stageRoot = await opfsRoot.getDirectoryHandle(
        'collect-plus-stage',
        { create: true },
      );
      const itemStage = await stageRoot.getDirectoryHandle(
        '01JSTAGEDBEFORE00000000001',
        { create: true },
      );
      const videoFile = await itemStage.getFileHandle('video.mp4', {
        create: true,
      });
      const writable = await videoFile.createWritable();
      await writable.write('staged-before-bind-video');
      await writable.close();

      await new Promise<void>((resolve, reject) => {
        const req = indexedDB.open('CollectPlusDB');
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const idb = req.result;
          const tx = idb.transaction('items', 'readwrite');
          tx.objectStore('items').put({
            schemaVersion: 1,
            id: '01JSTAGEDBEFORE00000000001',
            dedupeKey: 'douyin:staged-before-bind',
            platform: 'douyin',
            sourceId: 'staged-before-bind',
            sourceUrl: 'https://www.douyin.com/video/staged-before-bind',
            kind: 'video',
            title: '绑定前暂存作品',
            description: '暂存媒体测试',
            author: { id: 'author-s1', name: '暂存作者' },
            collectedAt: timestamp,
            updatedAt: timestamp,
            folderId: null,
            tags: ['待落盘'],
            note: '',
            relativeDir: 'items/douyin/2026-11/20261125_staged-before-bind',
            assets: [
              {
                id: 'video',
                kind: 'video',
                strategy: 'direct',
                sourceUrl: 'https://example.com/staged.mp4',
                relativePath: 'video.mp4',
                mimeType: 'video/mp4',
                downloaded: true,
                sizeBytes: 24,
              },
            ],
            syncStatus: 'opfs_staged',
            totalSizeBytes: 24,
            deletedAt: null,
          });
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
    }, now);

    await libraryPage.reload();
    await libraryPage.getByRole('button', { name: '设置', exact: true }).click();
    const vaultSection = libraryPage.getByTestId('settings-vault-section');

    await installPickerQueue(libraryPage, [
      { kind: 'opfs', dirName: 'ExistingVault', create: false },
    ]);

    await vaultSection
      .getByRole('button', { name: '选择本地同步目录' })
      .click();

    // 无需点击「立即重建索引」，直接自动完成重建与暂存补齐同步
    await expect(
      vaultSection.getByText(/索引重建成功：已恢复\s*1\s*条收藏/),
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      vaultSection.getByRole('button', { name: '立即重建索引' }),
    ).toHaveCount(0);

    await libraryPage
      .locator('aside')
      .getByRole('button', { name: /全部收藏/ })
      .click();
    await expect(libraryPage.getByText('已有目录自动恢复视频')).toBeVisible();
    await expect(libraryPage.getByText('绑定前暂存作品')).toBeVisible();
    await expect(
      libraryPage.locator('aside').getByText('历史收藏夹'),
    ).toBeVisible();

    // 确认暂存作品也已自动落盘到 ExistingVault
    await expect
      .poll(() => collectMetaTitlesInOpfsVault(libraryPage, 'ExistingVault'))
      .toEqual(['已有目录自动恢复视频', '绑定前暂存作品']);

    expect(pageErrors).toEqual([]);
  });

  test('已绑定目录切换为空目录：拦截同目录切换、完整迁移文件、删除原目录文件并保持离线读取', async ({
    context,
    extensionUrl,
    pageErrors,
  }) => {
    const libraryPage = await context.newPage();
    await libraryPage.goto(extensionUrl('library.html'));

    const now = Date.now();
    await seedInitializedVaultInOpfs(libraryPage, {
      dirName: 'VaultOld',
      vaultId: '01JVAULTOLD000000000000001',
      folders: [
        {
          id: 'folder-old-1',
          name: '迁移验证夹',
          sortOrder: 0,
          createdAt: now - 5000,
          updatedAt: now - 5000,
        },
      ],
      tags: [{ name: '原标签', color: '#10b981', createdAt: now - 5000 }],
      items: [
        {
          id: '01JMIGRATEITEM000000000001',
          sourceId: 'migrate-001',
          title: '待迁移离线视频',
          updatedAt: now - 2000,
          folderId: 'folder-old-1',
          tags: ['原标签'],
          relativeDir: 'items/douyin/2026-11/20261125_migrate-001',
          videoContent: 'offline-video-content-migrated',
        },
      ],
    });

    await libraryPage.getByRole('button', { name: '设置', exact: true }).click();
    const vaultSection = libraryPage.getByTestId('settings-vault-section');

    await installPickerQueue(libraryPage, [
      { kind: 'opfs', dirName: 'VaultOld', create: false },
      { kind: 'opfs', dirName: 'VaultOld', create: false },
      { kind: 'opfs', dirName: 'VaultNewEmpty', create: true },
    ]);

    // 1. 首次绑定 VaultOld（自动建索引）
    await vaultSection
      .getByRole('button', { name: '选择本地同步目录' })
      .click();
    await expect(
      vaultSection.getByText(/索引重建成功：已恢复\s*1\s*条收藏/),
    ).toBeVisible({ timeout: 15_000 });
    await expect(vaultSection.getByText('VaultOld')).toBeVisible();

    // 2. 尝试切换为同一目录 VaultOld -> 被拦截，原目录文件不被删除
    await vaultSection.getByRole('button', { name: '切换本地目录' }).click();
    await expect(
      vaultSection.getByText(/与当前本地同步目录相同，无需切换/),
    ).toBeVisible();
    expect(
      await collectMetaTitlesInOpfsVault(libraryPage, 'VaultOld'),
    ).toEqual(['待迁移离线视频']);

    // 3. 切换为空目录 VaultNewEmpty -> 自动迁移并删除 VaultOld 文件
    await vaultSection.getByRole('button', { name: '切换本地目录' }).click();
    await expect(
      vaultSection.getByText(/目录迁移完成：已将\s*VaultOld\s*切换至\s*VaultNewEmpty/),
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      vaultSection.locator('code', { hasText: 'VaultNewEmpty' }),
    ).toBeVisible();

    // 校验原目录文件已删除、新目录文件完整
    expect(await listTopLevelNamesInOpfsDir(libraryPage, 'VaultOld')).toEqual(
      [],
    );
    expect(
      await collectMetaTitlesInOpfsVault(libraryPage, 'VaultNewEmpty'),
    ).toEqual(['待迁移离线视频']);

    // 校验管理台直接从新目录离线读取视频生成 blob: URL
    await libraryPage
      .locator('aside')
      .getByRole('button', { name: /全部收藏/ })
      .click();
    await libraryPage.locator('article').first().click();
    const dialog = libraryPage.getByRole('dialog');
    await expect(dialog).toBeVisible();
    const videoEl = dialog.locator('video');
    await expect(videoEl).toBeVisible();
    expect(await videoEl.getAttribute('src')).toMatch(
      /^blob:chrome-extension:\/\//,
    );

    expect(pageErrors).toEqual([]);
  });

  test('已绑定目录切换为已初始化目录：弹窗询问并完整验证取消、合并与覆盖流程', async ({
    context,
    extensionUrl,
    pageErrors,
  }) => {
    const libraryPage = await context.newPage();
    await libraryPage.goto(extensionUrl('library.html'));

    // 准备 3 个已初始化 Vault：
    // - VaultSource: 原绑定目录
    // - VaultTargetMerge: 用于验证「取消」和「合并文件」
    // - VaultTargetOverwrite: 用于验证「覆盖新目录」
    await seedInitializedVaultInOpfs(libraryPage, {
      dirName: 'VaultSource',
      vaultId: '01JVAULTSRC000000000000001',
      folders: [
        {
          id: 'folder-src',
          name: '源目录分类',
          sortOrder: 0,
          createdAt: 1000,
          updatedAt: 1000,
        },
      ],
      tags: [{ name: '源标签', color: '#3b82f6', createdAt: 1000 }],
      items: [
        {
          id: '01JSRCUNIQUE00000000000001',
          sourceId: 'src-only-01',
          title: '源目录独有作品',
          updatedAt: 2000,
          folderId: 'folder-src',
          tags: ['源标签'],
          relativeDir: 'items/douyin/2026-11/20261125_src-only-01',
          videoContent: 'src-only-video',
        },
        {
          id: '01JCONFLICTA00000000000001',
          sourceId: 'conflict-a',
          title: '冲突作品A-源目录新版',
          updatedAt: 4000,
          folderId: 'folder-src',
          tags: ['源标签'],
          relativeDir: 'items/douyin/2026-11/20261125_conflict-a',
          videoContent: 'conflict-a-newer-source',
        },
        {
          id: '01JCONFLICTB00000000000001',
          sourceId: 'conflict-b',
          title: '冲突作品B-源目录旧版',
          updatedAt: 2000,
          folderId: 'folder-src',
          tags: ['源标签'],
          relativeDir: 'items/douyin/2026-11/20261125_conflict-b',
          videoContent: 'conflict-b-older-source',
        },
      ],
    });

    await seedInitializedVaultInOpfs(libraryPage, {
      dirName: 'VaultTargetMerge',
      vaultId: '01JVAULTMRG000000000000001',
      folders: [
        {
          id: 'folder-tgt',
          name: '目标目录分类',
          sortOrder: 1,
          createdAt: 1500,
          updatedAt: 1500,
        },
      ],
      tags: [{ name: '目标标签', color: '#f59e0b', createdAt: 1500 }],
      items: [
        {
          id: '01JTGTUNIQUE00000000000001',
          sourceId: 'tgt-only-01',
          title: '目标目录独有作品',
          updatedAt: 2500,
          folderId: 'folder-tgt',
          tags: ['目标标签'],
          relativeDir: 'items/douyin/2026-11/20261125_tgt-only-01',
          videoContent: 'tgt-only-video',
        },
        {
          id: '01JCONFLICTA00000000000001',
          sourceId: 'conflict-a',
          title: '冲突作品A-目标目录旧版',
          updatedAt: 1500,
          folderId: 'folder-tgt',
          tags: ['目标标签'],
          relativeDir: 'items/douyin/2026-11/20261125_conflict-a',
          videoContent: 'conflict-a-older-target',
        },
        {
          id: '01JCONFLICTB00000000000001',
          sourceId: 'conflict-b',
          title: '冲突作品B-目标目录新版',
          updatedAt: 6000,
          folderId: 'folder-tgt',
          tags: ['目标标签'],
          relativeDir: 'items/douyin/2026-11/20261125_conflict-b',
          videoContent: 'conflict-b-newer-target',
        },
      ],
    });

    await seedInitializedVaultInOpfs(libraryPage, {
      dirName: 'VaultTargetOverwrite',
      vaultId: '01JVAULTOVR000000000000001',
      folders: [
        {
          id: 'folder-ovr',
          name: '将被覆盖的旧分类',
          sortOrder: 0,
          createdAt: 1000,
          updatedAt: 1000,
        },
      ],
      tags: [],
      items: [
        {
          id: '01JOVROLD00000000000000001',
          sourceId: 'ovr-old-01',
          title: '将被覆盖的旧目标作品',
          updatedAt: 9000,
          folderId: 'folder-ovr',
          tags: [],
          relativeDir: 'items/douyin/2026-11/20261125_ovr-old-01',
          videoContent: 'to-be-overwritten',
        },
      ],
    });

    await libraryPage.getByRole('button', { name: '设置', exact: true }).click();
    const vaultSection = libraryPage.getByTestId('settings-vault-section');

    await installPickerQueue(libraryPage, [
      { kind: 'opfs', dirName: 'VaultSource', create: false },
      { kind: 'opfs', dirName: 'VaultTargetMerge', create: false },
      { kind: 'opfs', dirName: 'VaultTargetMerge', create: false },
      { kind: 'opfs', dirName: 'VaultTargetOverwrite', create: false },
    ]);

    // 1. 先绑定 VaultSource
    await vaultSection
      .getByRole('button', { name: '选择本地同步目录' })
      .click();
    await expect(
      vaultSection.getByText(/索引重建成功：已恢复\s*3\s*条收藏/),
    ).toBeVisible({ timeout: 15_000 });

    // 2. 切换至已初始化目录 VaultTargetMerge -> 弹窗出现 -> 先点「取消」
    await vaultSection.getByRole('button', { name: '切换本地目录' }).click();
    const conflictDialog = libraryPage.getByTestId(
      'vault-migration-conflict-dialog',
    );
    await expect(conflictDialog).toBeVisible();
    await expect(conflictDialog).toContainText('VaultTargetMerge');
    await conflictDialog.getByRole('button', { name: '取消' }).click();
    await expect(conflictDialog).toBeHidden();
    await expect(vaultSection.getByText('VaultSource')).toBeVisible();

    // 3. 再次切换至 VaultTargetMerge -> 选择「合并文件」
    await vaultSection.getByRole('button', { name: '切换本地目录' }).click();
    await expect(conflictDialog).toBeVisible();
    await conflictDialog.getByRole('button', { name: '合并文件' }).click();

    await expect(
      vaultSection.getByText(
        /合并迁移完成：已将\s*VaultSource\s*切换至\s*VaultTargetMerge/,
      ),
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      vaultSection.getByText(/索引重建成功：已恢复\s*4\s*条收藏/),
    ).toBeVisible({ timeout: 15_000 });

    // 验证原目录 VaultSource 已被清空，且 VaultTargetMerge 包含合并后的 4 条（保留各自较新版）
    expect(
      await listTopLevelNamesInOpfsDir(libraryPage, 'VaultSource'),
    ).toEqual([]);
    expect(
      await collectMetaTitlesInOpfsVault(libraryPage, 'VaultTargetMerge'),
    ).toEqual([
      '冲突作品A-源目录新版',
      '冲突作品B-目标目录新版',
      '源目录独有作品',
      '目标目录独有作品',
    ]);

    // 验证侧边栏两个目录的分类都已合并保留
    const sidebar = libraryPage.locator('aside');
    await expect(sidebar.getByText('源目录分类')).toBeVisible();
    await expect(sidebar.getByText('目标目录分类')).toBeVisible();

    // 4. 再从 VaultTargetMerge 切换至已初始化目录 VaultTargetOverwrite -> 选择「覆盖新目录」
    await vaultSection.getByRole('button', { name: '切换本地目录' }).click();
    await expect(conflictDialog).toBeVisible();
    await conflictDialog.getByRole('button', { name: '覆盖新目录' }).click();

    await expect(
      vaultSection.getByText(
        /覆盖迁移完成：已将\s*VaultTargetMerge\s*切换至\s*VaultTargetOverwrite/,
      ),
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      vaultSection.locator('code', { hasText: 'VaultTargetOverwrite' }),
    ).toBeVisible();

    // 验证原目录 VaultTargetMerge 已清空，新目录 VaultTargetOverwrite 的旧作品已被覆盖删除
    expect(
      await listTopLevelNamesInOpfsDir(libraryPage, 'VaultTargetMerge'),
    ).toEqual([]);
    expect(
      await collectMetaTitlesInOpfsVault(libraryPage, 'VaultTargetOverwrite'),
    ).toEqual([
      '冲突作品A-源目录新版',
      '冲突作品B-目标目录新版',
      '源目录独有作品',
      '目标目录独有作品',
    ]);
    await expect(sidebar.getByText('将被覆盖的旧分类')).toHaveCount(0);

    expect(pageErrors).toEqual([]);
  });
});
