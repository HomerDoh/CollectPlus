import { expect, test } from './fixtures/extension.ts';

interface MockDriveNode {
  id: string;
  name: string;
  mimeType: string;
  parents: string[];
  content: Buffer;
  appProperties: Record<string, string>;
}

interface ResumableSession {
  existingFileId: string | null;
  parentId: string;
  name: string;
  mimeType: string;
  appProperties: Record<string, string>;
  totalLength: number;
  chunks: Buffer[];
}

const DRIVE_FOLDER_MIME = 'application/vnd.google-apps.folder';

/** 合法 1x1 像素 PNG（用于封面图上传与重建索引缩略图生成验证） */
const TINY_PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X2ZkAAAAASUVORK5CYII=',
  'base64',
);

function parseMultipartRelated(
  body: Buffer,
  contentType: string,
): { metadata: Record<string, unknown>; media: Buffer; mediaMimeType: string } {
  const boundaryMatch = contentType.match(/boundary=([^\s;]+)/i);
  const boundary = boundaryMatch?.[1]?.replaceAll('"', '') ?? '';
  if (!boundary) {
    throw new Error(`Missing multipart boundary in "${contentType}"`);
  }

  const delimiter = Buffer.from(`--${boundary}`);
  const parts: Buffer[] = [];
  let cursor = body.indexOf(delimiter);
  while (cursor !== -1) {
    const partStart = cursor + delimiter.length;
    if (body.subarray(partStart, partStart + 2).toString('utf8') === '--') {
      break;
    }
    const nextCursor = body.indexOf(delimiter, partStart);
    if (nextCursor === -1) {
      break;
    }
    let sliceStart = partStart;
    if (body.subarray(sliceStart, sliceStart + 2).toString('utf8') === '\r\n') {
      sliceStart += 2;
    }
    let sliceEnd = nextCursor;
    if (body.subarray(sliceEnd - 2, sliceEnd).toString('utf8') === '\r\n') {
      sliceEnd -= 2;
    }
    parts.push(body.subarray(sliceStart, sliceEnd));
    cursor = nextCursor;
  }

  if (parts.length < 2) {
    throw new Error(`Expected 2 multipart sections, got ${parts.length}`);
  }

  const splitHeadersAndBody = (part: Buffer) => {
    const sep = part.indexOf('\r\n\r\n');
    const headersText = sep === -1 ? '' : part.subarray(0, sep).toString('utf8');
    const payload = sep === -1 ? part : part.subarray(sep + 4);
    return { headersText, payload };
  };

  const metaSection = splitHeadersAndBody(parts[0]!);
  const mediaSection = splitHeadersAndBody(parts[1]!);
  const metadata = JSON.parse(metaSection.payload.toString('utf8')) as Record<
    string,
    unknown
  >;
  const ctMatch = mediaSection.headersText.match(/Content-Type:\s*([^\r\n]+)/i);
  const mediaMimeType = ctMatch?.[1]?.trim() || 'application/octet-stream';

  return {
    metadata,
    media: mediaSection.payload,
    mediaMimeType,
  };
}

/** 创建状态化内存 Google Drive REST API v3 Mock，完整覆盖查询/Multipart/Resumable/Range 下载/删除 */
function createMockGoogleDriveServer(expectedToken: string) {
  let nextId = 1;
  const nodes = new Map<string, MockDriveNode>();
  const resumableSessions = new Map<string, ResumableSession>();
  let resumableUploadCount = 0;
  let mediaAuthHeaderSeenCount = 0;

  const allocId = (prefix: string): string => {
    const id = `${prefix}-${nextId}`;
    nextId += 1;
    return id;
  };

  const toJsonRecord = (node: MockDriveNode) => ({
    id: node.id,
    name: node.name,
    mimeType: node.mimeType,
    size: String(node.content.byteLength),
    parents: node.parents,
    appProperties: node.appProperties,
  });

  const deleteRecursive = (targetId: string): void => {
    nodes.delete(targetId);
    for (const [id, node] of Array.from(nodes.entries())) {
      if (node.parents.includes(targetId)) {
        deleteRecursive(id);
      }
    }
  };

  const listAllRelativePaths = (rootFolderId: string): Map<string, MockDriveNode> => {
    const out = new Map<string, MockDriveNode>();
    const walk = (parentId: string, prefix: string): void => {
      for (const node of nodes.values()) {
        if (!node.parents.includes(parentId)) {
          continue;
        }
        const rel = prefix ? `${prefix}/${node.name}` : node.name;
        out.set(rel, node);
        if (node.mimeType === DRIVE_FOLDER_MIME) {
          walk(node.id, rel);
        }
      }
    };
    walk(rootFolderId, '');
    return out;
  };

  const attachToContext = async (
    context: import('@playwright/test').BrowserContext,
  ): Promise<void> => {
    await context.route('https://www.googleapis.com/**', async (route) => {
      const request = route.request();
      const method = request.method();
      const url = new URL(request.url());
      const authHeader = request.headers()['authorization'] ?? '';

      if (authHeader !== `Bearer ${expectedToken}`) {
        await route.fulfill({
          status: 401,
          contentType: 'application/json',
          body: JSON.stringify({ error: { message: 'Invalid Credentials' } }),
        });
        return;
      }

      // 1. Userinfo
      if (url.pathname === '/oauth2/v2/userinfo' && method === 'GET') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            email: 'collector@example.com',
            name: 'Collector User',
          }),
        });
        return;
      }

      // 2. Resumable upload chunk PUT
      if (
        url.pathname.startsWith('/upload/drive/v3/resumable-session/') &&
        method === 'PUT'
      ) {
        const sessionId = url.pathname.split('/').pop() ?? '';
        const session = resumableSessions.get(sessionId);
        if (!session) {
          await route.fulfill({ status: 404, body: 'Session not found' });
          return;
        }

        const chunk = request.postDataBuffer() ?? Buffer.alloc(0);
        session.chunks.push(chunk);
        const rangeHeader = request.headers()['content-range'] ?? '';
        const rangeMatch = rangeHeader.match(/bytes (\d+)-(\d+)\/(\d+)/i);
        const rangeEnd = rangeMatch?.[2] ? Number(rangeMatch[2]) : chunk.byteLength - 1;
        const total = rangeMatch?.[3] ? Number(rangeMatch[3]) : session.totalLength;

        if (rangeEnd + 1 < total) {
          await route.fulfill({
            status: 308,
            headers: {
              Range: `bytes=0-${rangeEnd}`,
            },
            body: '',
          });
          return;
        }

        const combined = Buffer.concat(session.chunks);
        resumableSessions.delete(sessionId);
        resumableUploadCount += 1;

        let targetNode: MockDriveNode;
        if (session.existingFileId && nodes.has(session.existingFileId)) {
          const prev = nodes.get(session.existingFileId)!;
          targetNode = {
            ...prev,
            name: session.name,
            mimeType: session.mimeType,
            content: combined,
            appProperties: { ...prev.appProperties, ...session.appProperties },
          };
          nodes.set(targetNode.id, targetNode);
        } else {
          const id = allocId('file');
          targetNode = {
            id,
            name: session.name,
            mimeType: session.mimeType,
            parents: [session.parentId],
            content: combined,
            appProperties: session.appProperties,
          };
          nodes.set(id, targetNode);
        }

        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(toJsonRecord(targetNode)),
        });
        return;
      }

      // 3. Upload endpoints (multipart & resumable init)
      if (url.pathname.startsWith('/upload/drive/v3/files')) {
        const uploadType = url.searchParams.get('uploadType');
        const pathParts = url.pathname.split('/').filter(Boolean);
        const existingFileId =
          pathParts.length === 5 ? decodeURIComponent(pathParts[4]!) : null;

        if (uploadType === 'resumable' && (method === 'POST' || method === 'PATCH')) {
          const metaRaw = JSON.parse(request.postData() || '{}') as {
            name?: string;
            parents?: string[];
            appProperties?: Record<string, string>;
          };
          const sessionId = allocId('session');
          resumableSessions.set(sessionId, {
            existingFileId,
            parentId: metaRaw.parents?.[0] ?? 'root',
            name: metaRaw.name ?? 'unnamed',
            mimeType:
              request.headers()['x-upload-content-type'] ??
              'application/octet-stream',
            appProperties: metaRaw.appProperties ?? {},
            totalLength: Number(request.headers()['x-upload-content-length'] ?? '0'),
            chunks: [],
          });
          await route.fulfill({
            status: 200,
            headers: {
              Location: `https://www.googleapis.com/upload/drive/v3/resumable-session/${sessionId}`,
            },
            body: '',
          });
          return;
        }

        if (uploadType === 'multipart' && (method === 'POST' || method === 'PATCH')) {
          const bodyBuf = request.postDataBuffer() ?? Buffer.alloc(0);
          const parsed = parseMultipartRelated(
            bodyBuf,
            request.headers()['content-type'] ?? '',
          );
          const name =
            typeof parsed.metadata.name === 'string'
              ? parsed.metadata.name
              : 'unnamed';
          const parents = Array.isArray(parsed.metadata.parents)
            ? parsed.metadata.parents.filter((p): p is string => typeof p === 'string')
            : ['root'];
          const appProperties =
            typeof parsed.metadata.appProperties === 'object' &&
            parsed.metadata.appProperties !== null
              ? (parsed.metadata.appProperties as Record<string, string>)
              : {};

          let targetNode: MockDriveNode;
          if (existingFileId && nodes.has(existingFileId)) {
            const prev = nodes.get(existingFileId)!;
            targetNode = {
              ...prev,
              name,
              mimeType: parsed.mediaMimeType,
              content: parsed.media,
              appProperties: { ...prev.appProperties, ...appProperties },
            };
            nodes.set(targetNode.id, targetNode);
          } else {
            const id = allocId('file');
            targetNode = {
              id,
              name,
              mimeType: parsed.mediaMimeType,
              parents,
              content: parsed.media,
              appProperties,
            };
            nodes.set(id, targetNode);
          }

          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(toJsonRecord(targetNode)),
          });
          return;
        }
      }

      // 4. Drive v3 metadata/list/create/download/delete
      if (url.pathname === '/drive/v3/files' && method === 'GET') {
        const q = url.searchParams.get('q') ?? '';
        const parentMatch = q.match(/'([^']+)'\s+in\s+parents/);
        const nameMatch = q.match(/name\s*=\s*'((?:\\'|[^'])*)'/);
        const mimeEqMatch = q.match(/mimeType\s*=\s*'([^']+)'/);
        const mimeNeqMatch = q.match(/mimeType\s*!=\s*'([^']+)'/);

        const expectedParent = parentMatch?.[1]?.replaceAll("\\'", "'");
        const expectedName = nameMatch?.[1]?.replaceAll("\\'", "'");
        const expectedMime = mimeEqMatch?.[1];
        const excludedMime = mimeNeqMatch?.[1];

        const matched = Array.from(nodes.values())
          .filter((node) => {
            if (expectedParent && !node.parents.includes(expectedParent)) {
              return false;
            }
            if (expectedName !== undefined && node.name !== expectedName) {
              return false;
            }
            if (expectedMime && node.mimeType !== expectedMime) {
              return false;
            }
            if (excludedMime && node.mimeType === excludedMime) {
              return false;
            }
            return true;
          })
          .map(toJsonRecord);

        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ files: matched }),
        });
        return;
      }

      if (url.pathname === '/drive/v3/files' && method === 'POST') {
        const raw = JSON.parse(request.postData() || '{}') as {
          name?: string;
          mimeType?: string;
          parents?: string[];
          appProperties?: Record<string, string>;
        };
        const id = allocId(raw.mimeType === DRIVE_FOLDER_MIME ? 'folder' : 'file');
        const created: MockDriveNode = {
          id,
          name: raw.name ?? 'unnamed',
          mimeType: raw.mimeType ?? 'application/octet-stream',
          parents: raw.parents ?? ['root'],
          content: Buffer.alloc(0),
          appProperties: raw.appProperties ?? {},
        };
        nodes.set(id, created);
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(toJsonRecord(created)),
        });
        return;
      }

      if (url.pathname.startsWith('/drive/v3/files/')) {
        const fileId = decodeURIComponent(url.pathname.slice('/drive/v3/files/'.length));
        const node = nodes.get(fileId);

        if (method === 'DELETE') {
          if (node) {
            deleteRecursive(fileId);
          }
          await route.fulfill({ status: 204, body: '' });
          return;
        }

        if (!node) {
          await route.fulfill({
            status: 404,
            contentType: 'application/json',
            body: JSON.stringify({ error: { message: 'File not found' } }),
          });
          return;
        }

        if (method === 'GET' && url.searchParams.get('alt') === 'media') {
          mediaAuthHeaderSeenCount += 1;
          const range = request.headers()['range'];
          if (range) {
            const match = range.match(/bytes=(\d+)-(\d*)/i);
            const start = match?.[1] ? Number(match[1]) : 0;
            const end =
              match?.[2] && match[2].length > 0
                ? Math.min(node.content.byteLength - 1, Number(match[2]))
                : node.content.byteLength - 1;
            const slice = node.content.subarray(start, end + 1);
            await route.fulfill({
              status: 206,
              headers: {
                'Content-Type': node.mimeType,
                'Accept-Ranges': 'bytes',
                'Content-Range': `bytes ${start}-${end}/${node.content.byteLength}`,
                'Content-Length': String(slice.byteLength),
              },
              body: slice,
            });
            return;
          }

          await route.fulfill({
            status: 200,
            headers: {
              'Content-Type': node.mimeType,
              'Accept-Ranges': 'bytes',
              'Content-Length': String(node.content.byteLength),
            },
            body: node.content,
          });
          return;
        }

        if (method === 'GET') {
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(toJsonRecord(node)),
          });
          return;
        }
      }

      await route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ error: { message: `Unhandled ${method} ${url.pathname}` } }),
      });
    });
  };

  return {
    attachToContext,
    nodes,
    listAllRelativePaths,
    getResumableUploadCount: () => resumableUploadCount,
    getMediaAuthHeaderSeenCount: () => mediaAuthHeaderSeenCount,
  };
}

test.describe('CollectPlus 插件化远程持久化（Google Drive）全链路 E2E 验证', () => {
  test('独立 Google Drive 插件：连接授权、分片上传大视频、云端重建索引、DNR 流式播放与断开隔离', async ({
    context,
    serviceWorker,
    extensionId,
    extensionUrl,
    pageErrors,
  }) => {
    const mockToken = 'mock-gdrive-access-token-xyz';
    const driveServer = createMockGoogleDriveServer(mockToken);
    await driveServer.attachToContext(context);

    const libraryPage = await context.newPage();
    await libraryPage.goto(extensionUrl('library.html'));

    // 1. 预置一条 5.2 MB 的 OPFS 暂存视频条目（触发 Resumable 分片上传）+ 封面图 + 文件夹与标签
    const itemId = '01JGDV00000000000000000001';
    const folderId = '01JGDVFOLDER00000000000001';
    const relativeDir = 'items/douyin/2026-11/20261128_777001_cloud_video';
    const coverBase64 = TINY_PNG_BYTES.toString('base64');

    await libraryPage.evaluate(
      async ({ itemId: id, folderId: fid, relativeDir: relDir, coverB64 }) => {
        const now = Date.now();
        // 写入 5.2 MB 视频（超过 5 MB 阈值，强制走 Resumable 分片上传）与合法 PNG 封面到 OPFS
        const opfsRoot = await navigator.storage.getDirectory();
        const stageRoot = await opfsRoot.getDirectoryHandle('collect-plus-stage', {
          create: true,
        });
        const itemDir = await stageRoot.getDirectoryHandle(id, { create: true });

        const videoBytes = new Uint8Array(5 * 1024 * 1024 + 256 * 1024);
        // 写入简单 ftyp 头字节便于辨识
        videoBytes.set([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70], 0);
        const vf = await itemDir.getFileHandle('video.mp4', { create: true });
        const vw = await vf.createWritable();
        await vw.write(videoBytes);
        await vw.close();

        const coverBin = Uint8Array.from(atob(coverB64), (c) => c.charCodeAt(0));
        const cf = await itemDir.getFileHandle('cover.jpg', { create: true });
        const cw = await cf.createWritable();
        await cw.write(coverBin);
        await cw.close();

        // 直接写入 IndexedDB（CollectPlusDB）
        await new Promise<void>((resolve, reject) => {
          const req = indexedDB.open('CollectPlusDB');
          req.onerror = () => reject(req.error);
          req.onsuccess = () => {
            const db = req.result;
            const tx = db.transaction(['items', 'folders', 'tags'], 'readwrite');
            tx.objectStore('folders').put({
              id: fid,
              parentId: null,
              name: '云端精选',
              sortOrder: 0,
              createdAt: now,
              updatedAt: now,
            });
            tx.objectStore('tags').put({
              name: 'cloud-test',
              color: '#3b82f6',
              createdAt: now,
            });
            tx.objectStore('items').put({
              schemaVersion: 1,
              id,
              dedupeKey: 'douyin:777001',
              platform: 'douyin',
              sourceId: '777001',
              sourceUrl: 'https://www.douyin.com/video/777001',
              kind: 'video',
              title: '云端同步测试视频',
              description: '测试 Google Drive 插件化持久化与云端重建',
              author: { id: 'author-cloud', name: '云端作者' },
              collectedAt: now,
              updatedAt: now,
              folderId: fid,
              folderIds: [fid],
              tags: ['cloud-test'],
              note: '验证云端同步备注',
              relativeDir: relDir,
              coverRelativePath: 'cover.jpg',
              assets: [
                {
                  id: 'cover',
                  kind: 'cover',
                  strategy: 'direct',
                  sourceUrl: 'https://example.com/cover.jpg',
                  relativePath: 'cover.jpg',
                  mimeType: 'image/png',
                  sizeBytes: coverBin.byteLength,
                  downloaded: true,
                },
                {
                  id: 'video',
                  kind: 'video',
                  strategy: 'direct',
                  sourceUrl: 'https://example.com/video.mp4',
                  relativePath: 'video.mp4',
                  mimeType: 'video/mp4',
                  sizeBytes: videoBytes.byteLength,
                  downloaded: true,
                },
              ],
              syncStatus: 'opfs_staged',
              totalSizeBytes: videoBytes.byteLength + coverBin.byteLength,
              deletedAt: null,
              thumbnailDataUrl: `data:image/png;base64,${coverB64}`,
            });
            tx.oncomplete = () => {
              db.close();
              resolve();
            };
            tx.onerror = () => reject(tx.error);
          };
        });
      },
      { itemId, folderId, relativeDir, coverB64: coverBase64 },
    );

    // 2. 注入 chrome.identity.launchWebAuthFlow Mock，切换到 Google Drive 插件并连接
    await libraryPage.evaluate((token) => {
      const idApi = chrome.identity as unknown as {
        launchWebAuthFlow: (
          details: { url: string; interactive?: boolean },
          callback: (redirectUrl?: string) => void,
        ) => void;
      };
      idApi.launchWebAuthFlow = (details, callback) => {
        const parsed = new URL(details.url);
        const redirectUri = parsed.searchParams.get('redirect_uri') ?? 'https://mock.chromiumapp.org/';
        callback(
          `${redirectUri}#access_token=${token}&token_type=Bearer&expires_in=3600`,
        );
      };
    }, mockToken);

    await libraryPage.getByRole('button', { name: '设置', exact: true }).click();
    const vaultSection = libraryPage.getByTestId('settings-vault-section');
    await expect(vaultSection).toBeVisible();

    await vaultSection.getByTestId('vault-provider-tab-google_drive').click();
    await expect(vaultSection.getByTestId('gdrive-settings-card')).toBeVisible();

    await vaultSection
      .getByTestId('gdrive-root-folder-input')
      .fill('MyCloudVault');
    await vaultSection
      .getByTestId('gdrive-client-id-input')
      .fill('test-client-id.apps.googleusercontent.com');
    await vaultSection.getByTestId('gdrive-connect-btn').click();

    // 3. 验证连接成功 + 自动建目录结构 + 自动将 OPFS 暂存视频同步上云
    await expect(vaultSection.getByTestId('vault-status-badge')).toHaveText(
      '已授权就绪',
    );
    await expect(vaultSection.getByTestId('gdrive-bound-folder-name')).toContainText(
      'Google Drive / MyCloudVault',
    );
    await expect(vaultSection.getByTestId('gdrive-account-badge')).toHaveText(
      'collector@example.com',
    );

    // 等待自动同步完成（大视频走 Resumable 分片上传）
    await expect
      .poll(() => driveServer.getResumableUploadCount(), {
        message: '等待 5.2 MB 视频通过 Google Drive Resumable 分片上传完成',
      })
      .toBe(1);

    const rootFolder = Array.from(driveServer.nodes.values()).find(
      (n) => n.name === 'MyCloudVault' && n.mimeType === DRIVE_FOLDER_MIME,
    );
    expect(rootFolder).toBeDefined();

    const cloudFiles = driveServer.listAllRelativePaths(rootFolder!.id);
    expect(cloudFiles.has('README.txt')).toBe(true);
    expect(cloudFiles.has('.collect-vault.json')).toBe(true);
    expect(cloudFiles.has('taxonomy.json')).toBe(true);
    expect(cloudFiles.has(`${relativeDir}/meta.json`)).toBe(true);
    expect(cloudFiles.has(`${relativeDir}/cover.jpg`)).toBe(true);
    expect(cloudFiles.has(`${relativeDir}/video.mp4`)).toBe(true);
    expect(cloudFiles.get(`${relativeDir}/video.mp4`)?.content.byteLength).toBe(
      5 * 1024 * 1024 + 256 * 1024,
    );

    // 安全红线校验：云端 meta.json 不含 thumbnailDataUrl，且 IndexedDB settings 绝不持久化 Access Token
    const uploadedMetaText =
      cloudFiles.get(`${relativeDir}/meta.json`)?.content.toString('utf8') ?? '';
    expect(uploadedMetaText).not.toContain('thumbnailDataUrl');
    expect(uploadedMetaText).not.toContain(mockToken);

    const settingsJson = await libraryPage.evaluate(async () => {
      return new Promise<string>((resolve, reject) => {
        const req = indexedDB.open('CollectPlusDB');
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction(['settings'], 'readonly');
          const allReq = tx.objectStore('settings').getAll();
          allReq.onsuccess = () => {
            db.close();
            resolve(JSON.stringify(allReq.result));
          };
          allReq.onerror = () => reject(allReq.error);
        };
      });
    });
    expect(settingsJson).not.toContain(mockToken);

    // 验证 OPFS 暂存文件已自动释放
    const opfsRemainingCount = await libraryPage.evaluate(async (id) => {
      const opfsRoot = await navigator.storage.getDirectory();
      const stageRoot = await opfsRoot.getDirectoryHandle('collect-plus-stage', {
        create: true,
      });
      try {
        const dir = await stageRoot.getDirectoryHandle(id, { create: false });
        let count = 0;
        for await (const _entry of dir.entries()) {
          void _entry;
          count += 1;
        }
        return count;
      } catch {
        return 0;
      }
    }, itemId);
    expect(opfsRemainingCount).toBe(0);

    // 4. 验证 Popup 识别已配置的云存储，不再展示未绑定目录提示
    const popupPage = await context.newPage();
    await popupPage.goto(extensionUrl('popup.html'));
    await expect(popupPage.getByRole('heading', { name: 'CollectPlus' })).toBeVisible();
    await expect(popupPage.getByTestId('popup-vault-hint')).toHaveCount(0);
    await popupPage.close();

    // 5. 清空浏览器缓存索引并验证从 Google Drive 容灾重建索引
    await libraryPage.getByRole('button', { name: '清空浏览器缓存' }).click();
    await libraryPage.getByRole('button', { name: '确认清空浏览器缓存' }).click();
    await expect(libraryPage.getByText('立即重建索引')).toBeVisible();

    await vaultSection.getByTestId('gdrive-rebuild-btn').click();
    await libraryPage.getByRole('button', { name: '确认重建索引' }).click();
    await expect(vaultSection.getByText(/索引重建成功：已恢复/)).toBeVisible();

    // 6. 回到列表打开条目详情：验证 Google Drive 视频走 Session DNR 流式鉴权，关闭后自动回收规则
    await libraryPage.getByRole('button', { name: /全部收藏/ }).click();
    await expect(libraryPage.getByText('云端同步测试视频')).toBeVisible();
    await libraryPage.getByText('云端同步测试视频').click();

    const videoEl = libraryPage.locator('video');
    await expect(videoEl).toBeVisible();
    await expect
      .poll(async () => videoEl.getAttribute('src'))
      .toContain('https://www.googleapis.com/drive/v3/files/');

    // 断言临时 Session DNR 规则 50001 仅限定扩展自身 initiator 且仅限 media 资源
    const activeDriveRules = await serviceWorker.evaluate(async () => {
      const rules = await chrome.declarativeNetRequest.getSessionRules();
      return rules
        .filter((r) => r.id >= 50000)
        .map((r) => ({
          id: r.id,
          initiatorDomains: r.condition.initiatorDomains,
          resourceTypes: r.condition.resourceTypes,
        }));
    });
    expect(activeDriveRules).toEqual([
      {
        id: 50001,
        initiatorDomains: [extensionId],
        resourceTypes: ['media'],
      },
    ]);

    // 关闭详情抽屉，确认临时 DNR 规则被干净回收
    await libraryPage.keyboard.press('Escape');
    await expect(videoEl).toHaveCount(0);
    await expect
      .poll(async () =>
        serviceWorker.evaluate(async () => {
          const rules = await chrome.declarativeNetRequest.getSessionRules();
          return rules.filter((r) => r.id >= 50000).length;
        }),
      )
      .toBe(0);

    // 7. 断开 Google Drive（确认云端文件零删除）并切回本地目录插件
    await libraryPage.getByRole('button', { name: '设置', exact: true }).click();
    await vaultSection.getByTestId('gdrive-disconnect-btn').click();
    await expect(vaultSection.getByTestId('vault-status-badge')).toHaveText(
      '尚未绑定',
    );
    expect(driveServer.listAllRelativePaths(rootFolder!.id).has(`${relativeDir}/video.mp4`)).toBe(
      true,
    );

    await vaultSection.getByTestId('vault-provider-tab-local_fs').click();
    await expect(
      vaultSection.getByRole('button', { name: '选择本地同步目录' }),
    ).toBeVisible();

    expect(pageErrors).toEqual([]);
  });
});
