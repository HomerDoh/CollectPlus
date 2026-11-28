import { createHash, createHmac } from 'node:crypto';
import { expect, test } from './fixtures/extension.ts';

interface StoredR2Object {
  key: string;
  contentType: string;
  body: Buffer;
}

interface MultipartUploadSession {
  key: string;
  contentType: string;
  parts: Map<number, { etag: string; body: Buffer }>;
}

/** 合法 1x1 像素 PNG（用于封面图上传与重建索引缩略图生成验证） */
const TINY_PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X2ZkAAAAASUVORK5CYII=',
  'base64',
);

function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function hmacSha256(key: string | Buffer, data: string): Buffer {
  return createHmac('sha256', key).update(data).digest();
}

function canonicalUriFromPath(pathname: string): string {
  if (!pathname || pathname === '/') {
    return '/';
  }
  return pathname
    .split('/')
    .map((seg) => (seg ? encodeRfc3986(decodeURIComponent(seg)) : ''))
    .join('/');
}

function canonicalQuery(params: URLSearchParams, excludeKey?: string): string {
  const pairs: Array<[string, string]> = [];
  for (const [k, v] of params.entries()) {
    if (excludeKey && k === excludeKey) {
      continue;
    }
    pairs.push([encodeRfc3986(k), encodeRfc3986(v)]);
  }
  pairs.sort((a, b) =>
    a[0] !== b[0] ? (a[0] < b[0] ? -1 : 1) : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0,
  );
  return pairs.map(([k, v]) => `${k}=${v}`).join('&');
}

function verifySigV4HeaderRequest(params: {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: Buffer;
  expectedAccessKeyId: string;
  expectedSecretAccessKey: string;
}): boolean {
  const auth = params.headers['authorization'] ?? '';
  const match = auth.match(
    /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/([^/]+)\/aws4_request,\s*SignedHeaders=([^,]+),\s*Signature=([0-9a-f]{64})$/,
  );
  if (!match) {
    return false;
  }
  const [, accessKeyId, dateStamp, region, service, signedHeadersRaw, signature] = match;
  if (
    accessKeyId !== params.expectedAccessKeyId ||
    region !== 'auto' ||
    service !== 's3'
  ) {
    return false;
  }

  const amzDate = params.headers['x-amz-date'] ?? '';
  const payloadHash = params.headers['x-amz-content-sha256'] ?? '';
  const expectedPayloadHash = sha256Hex(params.body);
  if (!amzDate.startsWith(dateStamp!) || payloadHash !== expectedPayloadHash) {
    return false;
  }

  const signedHeaderNames = signedHeadersRaw!.split(';');
  const canonicalHeaders = signedHeaderNames
    .map((name) => {
      const value =
        name === 'host' ? params.url.host : (params.headers[name] ?? '').trim();
      return `${name}:${value}`;
    })
    .join('\n')
    .concat('\n');

  const canonicalRequest = [
    params.method.toUpperCase(),
    canonicalUriFromPath(params.url.pathname),
    canonicalQuery(params.url.searchParams),
    canonicalHeaders,
    signedHeadersRaw!,
    payloadHash,
  ].join('\n');

  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    sha256Hex(canonicalRequest),
  ].join('\n');

  const kDate = hmacSha256(`AWS4${params.expectedSecretAccessKey}`, dateStamp!);
  const kRegion = hmacSha256(kDate, region!);
  const kService = hmacSha256(kRegion, service!);
  const kSigning = hmacSha256(kService, 'aws4_request');
  const expectedSig = hmacSha256(kSigning, stringToSign).toString('hex');

  return signature === expectedSig;
}

function verifySigV4PresignedGet(params: {
  url: URL;
  expectedAccessKeyId: string;
  expectedSecretAccessKey: string;
}): boolean {
  const sp = params.url.searchParams;
  if (sp.get('X-Amz-Algorithm') !== 'AWS4-HMAC-SHA256') {
    return false;
  }
  const credential = sp.get('X-Amz-Credential') ?? '';
  const credParts = credential.split('/');
  if (credParts.length !== 5) {
    return false;
  }
  const [accessKeyId, dateStamp, region, service, terminator] = credParts;
  if (
    accessKeyId !== params.expectedAccessKeyId ||
    region !== 'auto' ||
    service !== 's3' ||
    terminator !== 'aws4_request'
  ) {
    return false;
  }

  const amzDate = sp.get('X-Amz-Date') ?? '';
  const signedHeaders = sp.get('X-Amz-SignedHeaders') ?? '';
  const signature = sp.get('X-Amz-Signature') ?? '';
  if (!amzDate.startsWith(dateStamp!) || signedHeaders !== 'host') {
    return false;
  }

  const canonicalRequest = [
    'GET',
    canonicalUriFromPath(params.url.pathname),
    canonicalQuery(sp, 'X-Amz-Signature'),
    `host:${params.url.host}\n`,
    'host',
    'UNSIGNED-PAYLOAD',
  ].join('\n');

  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    sha256Hex(canonicalRequest),
  ].join('\n');

  const kDate = hmacSha256(`AWS4${params.expectedSecretAccessKey}`, dateStamp!);
  const kRegion = hmacSha256(kDate, region!);
  const kService = hmacSha256(kRegion, service!);
  const kSigning = hmacSha256(kService, 'aws4_request');
  const expectedSig = hmacSha256(kSigning, stringToSign).toString('hex');

  return signature === expectedSig;
}

/** 创建带独立 SigV4 密码学验签的内存 Cloudflare R2 S3 Mock 服务 */
function createMockCloudflareR2Server(config: {
  accountId: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}) {
  const objects = new Map<string, StoredR2Object>();
  const multipartSessions = new Map<string, MultipartUploadSession>();
  let nextUploadId = 1;
  let multipartUploadCount = 0;
  let verifiedPresignedGetCount = 0;
  let invalidSignatureCount = 0;

  const expectedHost = `${config.accountId}.r2.cloudflarestorage.com`;

  const attachToContext = async (
    context: import('@playwright/test').BrowserContext,
  ): Promise<void> => {
    await context.route(`https://${expectedHost}/**`, async (route) => {
      const request = route.request();
      const method = request.method().toUpperCase();
      const url = new URL(request.url());
      const headers = request.headers();
      const body = request.postDataBuffer() ?? Buffer.alloc(0);

      const isPresigned = url.searchParams.has('X-Amz-Signature');
      const sigOk = isPresigned
        ? method === 'GET' &&
          verifySigV4PresignedGet({
            url,
            expectedAccessKeyId: config.accessKeyId,
            expectedSecretAccessKey: config.secretAccessKey,
          })
        : verifySigV4HeaderRequest({
            method,
            url,
            headers,
            body,
            expectedAccessKeyId: config.accessKeyId,
            expectedSecretAccessKey: config.secretAccessKey,
          });

      if (!sigOk) {
        invalidSignatureCount += 1;
        await route.fulfill({
          status: 403,
          contentType: 'application/xml',
          body: '<Error><Code>SignatureDoesNotMatch</Code><Message>Invalid SigV4 signature</Message></Error>',
        });
        return;
      }

      if (isPresigned) {
        verifiedPresignedGetCount += 1;
      }

      const rawSegments = url.pathname.split('/').filter(Boolean);
      const reqBucket = rawSegments[0] ? decodeURIComponent(rawSegments[0]) : '';
      if (reqBucket !== config.bucket) {
        await route.fulfill({
          status: 404,
          contentType: 'application/xml',
          body: '<Error><Code>NoSuchBucket</Code><Message>Bucket not found</Message></Error>',
        });
        return;
      }

      const objectKey = rawSegments
        .slice(1)
        .map((seg) => decodeURIComponent(seg))
        .join('/');

      // 1. Bucket-level operations: HEAD bucket / ListObjectsV2
      if (!objectKey) {
        if (method === 'HEAD') {
          await route.fulfill({ status: 200, body: '' });
          return;
        }
        if (method === 'GET' && url.searchParams.get('list-type') === '2') {
          const prefix = url.searchParams.get('prefix') ?? '';
          const maxKeys = Math.max(
            1,
            Number(url.searchParams.get('max-keys') ?? '1000'),
          );
          const matched = Array.from(objects.values())
            .filter((o) => o.key.startsWith(prefix))
            .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
            .slice(0, maxKeys);

          const xml =
            '<?xml version="1.0" encoding="UTF-8"?>' +
            '<ListBucketResult>' +
            `<Name>${escapeXml(config.bucket)}</Name>` +
            `<Prefix>${escapeXml(prefix)}</Prefix>` +
            '<IsTruncated>false</IsTruncated>' +
            matched
              .map(
                (item) =>
                  `<Contents><Key>${escapeXml(item.key)}</Key><Size>${item.body.byteLength}</Size></Contents>`,
              )
              .join('') +
            '</ListBucketResult>';

          await route.fulfill({
            status: 200,
            contentType: 'application/xml',
            body: xml,
          });
          return;
        }
      }

      // 2. Multipart Upload operations
      if (method === 'POST' && url.searchParams.has('uploads')) {
        const uploadId = `r2-upload-${nextUploadId}`;
        nextUploadId += 1;
        multipartSessions.set(uploadId, {
          key: objectKey,
          contentType: headers['content-type'] ?? 'application/octet-stream',
          parts: new Map(),
        });
        await route.fulfill({
          status: 200,
          contentType: 'application/xml',
          body: `<InitiateMultipartUploadResult><UploadId>${uploadId}</UploadId></InitiateMultipartUploadResult>`,
        });
        return;
      }

      const uploadId = url.searchParams.get('uploadId');
      if (uploadId) {
        const session = multipartSessions.get(uploadId);
        if (!session) {
          await route.fulfill({
            status: 404,
            contentType: 'application/xml',
            body: '<Error><Code>NoSuchUpload</Code><Message>Upload not found</Message></Error>',
          });
          return;
        }

        if (method === 'PUT' && url.searchParams.has('partNumber')) {
          const partNumber = Number(url.searchParams.get('partNumber'));
          const etag = `"${sha256Hex(body).slice(0, 32)}"`;
          session.parts.set(partNumber, { etag, body });
          await route.fulfill({
            status: 200,
            headers: { ETag: etag },
            body: '',
          });
          return;
        }

        if (method === 'POST') {
          const ordered = Array.from(session.parts.entries())
            .sort((a, b) => a[0] - b[0])
            .map(([, part]) => part.body);
          objects.set(session.key, {
            key: session.key,
            contentType: session.contentType,
            body: Buffer.concat(ordered),
          });
          multipartSessions.delete(uploadId);
          multipartUploadCount += 1;
          await route.fulfill({
            status: 200,
            contentType: 'application/xml',
            body: `<CompleteMultipartUploadResult><Key>${escapeXml(session.key)}</Key></CompleteMultipartUploadResult>`,
          });
          return;
        }

        if (method === 'DELETE') {
          multipartSessions.delete(uploadId);
          await route.fulfill({ status: 204, body: '' });
          return;
        }
      }

      // 3. Single Object operations: PUT / HEAD / GET (with Range) / DELETE
      if (method === 'PUT') {
        objects.set(objectKey, {
          key: objectKey,
          contentType: headers['content-type'] ?? 'application/octet-stream',
          body,
        });
        await route.fulfill({
          status: 200,
          headers: { ETag: `"${sha256Hex(body).slice(0, 32)}"` },
          body: '',
        });
        return;
      }

      if (method === 'DELETE') {
        objects.delete(objectKey);
        await route.fulfill({ status: 204, body: '' });
        return;
      }

      const stored = objects.get(objectKey);
      if (!stored) {
        await route.fulfill({
          status: 404,
          contentType: 'application/xml',
          body: '<Error><Code>NoSuchKey</Code><Message>Object not found</Message></Error>',
        });
        return;
      }

      if (method === 'HEAD') {
        await route.fulfill({
          status: 200,
          headers: {
            'Content-Type': stored.contentType,
            'Content-Length': String(stored.body.byteLength),
            'Accept-Ranges': 'bytes',
          },
          body: '',
        });
        return;
      }

      if (method === 'GET') {
        const range = headers['range'];
        if (range) {
          const match = range.match(/bytes=(\d+)-(\d*)/i);
          const start = match?.[1] ? Number(match[1]) : 0;
          const end =
            match?.[2] && match[2].length > 0
              ? Math.min(stored.body.byteLength - 1, Number(match[2]))
              : stored.body.byteLength - 1;
          const slice = stored.body.subarray(start, end + 1);
          await route.fulfill({
            status: 206,
            headers: {
              'Content-Type': stored.contentType,
              'Accept-Ranges': 'bytes',
              'Content-Range': `bytes ${start}-${end}/${stored.body.byteLength}`,
              'Content-Length': String(slice.byteLength),
            },
            body: slice,
          });
          return;
        }

        await route.fulfill({
          status: 200,
          headers: {
            'Content-Type': stored.contentType,
            'Accept-Ranges': 'bytes',
            'Content-Length': String(stored.body.byteLength),
          },
          body: stored.body,
        });
        return;
      }

      await route.fulfill({ status: 405, body: '' });
    });
  };

  return {
    attachToContext,
    objects,
    getMultipartUploadCount: () => multipartUploadCount,
    getVerifiedPresignedGetCount: () => verifiedPresignedGetCount,
    getInvalidSignatureCount: () => invalidSignatureCount,
  };
}

test.describe('CollectPlus 插件化远程持久化（Cloudflare R2）全链路 E2E 验证', () => {
  test('独立 Cloudflare R2 插件：SigV4 验签连接、分片上传大视频、云端重建索引、预签名流式播放与断开隔离', async ({
    context,
    extensionUrl,
    pageErrors,
  }) => {
    const mockAccountId = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
    const mockBucket = 'collect-vault';
    const mockPrefix = 'MyR2Vault';
    const mockAccessKeyId = 'r2-test-access-key-id-001';
    const mockSecretAccessKey = 'r2-test-secret-access-key-super-secret-999';

    const r2Server = createMockCloudflareR2Server({
      accountId: mockAccountId,
      bucket: mockBucket,
      accessKeyId: mockAccessKeyId,
      secretAccessKey: mockSecretAccessKey,
    });
    await r2Server.attachToContext(context);

    const libraryPage = await context.newPage();
    await libraryPage.goto(extensionUrl('library.html'));

    // 1. 预置一条 5.25 MiB 的 OPFS 暂存视频条目（强制触发 S3 Multipart 分片上传）+ 封面图 + 文件夹与标签
    const itemId = '01JR2V00000000000000000001';
    const folderId = '01JR2VFOLDER00000000000001';
    const relativeDir = 'items/douyin/2026-11/20261128_888001_r2_video';
    const coverBase64 = TINY_PNG_BYTES.toString('base64');

    await libraryPage.evaluate(
      async ({ itemId: id, folderId: fid, relativeDir: relDir, coverB64 }) => {
        const now = Date.now();
        const opfsRoot = await navigator.storage.getDirectory();
        const stageRoot = await opfsRoot.getDirectoryHandle('collect-plus-stage', {
          create: true,
        });
        const itemDir = await stageRoot.getDirectoryHandle(id, { create: true });

        const videoBytes = new Uint8Array(5 * 1024 * 1024 + 256 * 1024);
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

        await new Promise<void>((resolve, reject) => {
          const req = indexedDB.open('CollectPlusDB');
          req.onerror = () => reject(req.error);
          req.onsuccess = () => {
            const db = req.result;
            const tx = db.transaction(['items', 'folders', 'tags'], 'readwrite');
            tx.objectStore('folders').put({
              id: fid,
              parentId: null,
              name: 'R2 精选',
              sortOrder: 0,
              createdAt: now,
              updatedAt: now,
            });
            tx.objectStore('tags').put({
              name: 'r2-test',
              color: '#f97316',
              createdAt: now,
            });
            tx.objectStore('items').put({
              schemaVersion: 1,
              id,
              dedupeKey: 'douyin:888001',
              platform: 'douyin',
              sourceId: '888001',
              sourceUrl: 'https://www.douyin.com/video/888001',
              kind: 'video',
              title: 'R2 对象存储同步测试视频',
              description: '测试 Cloudflare R2 插件化持久化、S3 分片上传与预签名播放',
              author: { id: 'author-r2', name: 'R2 测试作者' },
              collectedAt: now,
              updatedAt: now,
              folderId: fid,
              folderIds: [fid],
              tags: ['r2-test'],
              note: '验证 R2 同步备注',
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

    // 2. 切换到 Cloudflare R2 插件并填写 Account ID / Bucket / Prefix / Access Key / Secret Key 连接
    await libraryPage.getByRole('button', { name: '设置', exact: true }).click();
    const vaultSection = libraryPage.getByTestId('settings-vault-section');
    await expect(vaultSection).toBeVisible();

    await vaultSection.getByTestId('vault-provider-tab-cloudflare_r2').click();
    await expect(vaultSection.getByTestId('r2-settings-card')).toBeVisible();

    await vaultSection.getByTestId('r2-endpoint-input').fill(mockAccountId);
    await vaultSection.getByTestId('r2-bucket-input').fill(mockBucket);
    await vaultSection.getByTestId('r2-prefix-input').fill(mockPrefix);
    await vaultSection.getByTestId('r2-access-key-input').fill(mockAccessKeyId);
    await vaultSection
      .getByTestId('r2-secret-key-input')
      .fill(mockSecretAccessKey);
    await vaultSection.getByTestId('r2-connect-btn').click();

    // 3. 验证连接成功 + 自动建 Vault 结构 + 自动将 5.25 MiB 视频通过 S3 Multipart 上传到 R2
    await expect(vaultSection.getByTestId('vault-status-badge')).toHaveText(
      '已授权就绪',
    );
    await expect(
      vaultSection.getByTestId('r2-bound-target-name'),
    ).toContainText(`Cloudflare R2 / ${mockBucket}/${mockPrefix}`);
    await expect(vaultSection.getByTestId('r2-endpoint-badge')).toHaveText(
      `${mockAccountId}.r2.cloudflarestorage.com`,
    );

    await expect
      .poll(() => r2Server.getMultipartUploadCount(), {
        message: '等待 5.25 MiB 视频通过 Cloudflare R2 S3 Multipart 分片上传完成',
      })
      .toBe(1);
    expect(r2Server.getInvalidSignatureCount()).toBe(0);

    expect(r2Server.objects.has(`${mockPrefix}/README.txt`)).toBe(true);
    expect(r2Server.objects.has(`${mockPrefix}/.collect-vault.json`)).toBe(true);
    expect(r2Server.objects.has(`${mockPrefix}/taxonomy.json`)).toBe(true);
    expect(r2Server.objects.has(`${mockPrefix}/${relativeDir}/meta.json`)).toBe(
      true,
    );
    expect(r2Server.objects.has(`${mockPrefix}/${relativeDir}/cover.jpg`)).toBe(
      true,
    );
    expect(r2Server.objects.has(`${mockPrefix}/${relativeDir}/video.mp4`)).toBe(
      true,
    );
    expect(
      r2Server.objects.get(`${mockPrefix}/${relativeDir}/video.mp4`)?.body
        .byteLength,
    ).toBe(5 * 1024 * 1024 + 256 * 1024);

    // 安全红线校验：云端 meta.json 不含 thumbnailDataUrl 或密钥；IndexedDB settings 绝不持久化 AK/SK
    const uploadedMetaText =
      r2Server.objects
        .get(`${mockPrefix}/${relativeDir}/meta.json`)
        ?.body.toString('utf8') ?? '';
    expect(uploadedMetaText).not.toContain('thumbnailDataUrl');
    expect(uploadedMetaText).not.toContain(mockAccessKeyId);
    expect(uploadedMetaText).not.toContain(mockSecretAccessKey);

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
    expect(settingsJson).not.toContain(mockAccessKeyId);
    expect(settingsJson).not.toContain(mockSecretAccessKey);

    // 验证 OPFS 暂存文件已释放
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

    // 4. 验证 Popup 识别已配置的 R2 云存储，不再展示未绑定目录提示
    const popupPage = await context.newPage();
    await popupPage.goto(extensionUrl('popup.html'));
    await expect(
      popupPage.getByRole('heading', { name: 'CollectPlus' }),
    ).toBeVisible();
    await expect(popupPage.getByTestId('popup-vault-hint')).toHaveCount(0);
    await popupPage.close();

    // 5. 清空浏览器缓存索引并验证从 Cloudflare R2 容灾重建索引（ListObjectsV2）
    await libraryPage.getByRole('button', { name: '清空浏览器缓存' }).click();
    await libraryPage
      .getByRole('button', { name: '确认清空浏览器缓存' })
      .click();
    await expect(libraryPage.getByText('立即重建索引')).toBeVisible();

    await vaultSection.getByTestId('r2-rebuild-btn').click();
    await libraryPage.getByRole('button', { name: '确认重建索引' }).click();
    await expect(vaultSection.getByText(/索引重建成功：已恢复/)).toBeVisible();

    // 6. 打开条目详情：验证 R2 视频走 SigV4 预签名 GET URL 且通过服务端密码学验签
    await libraryPage.getByRole('button', { name: /全部收藏/ }).click();
    await expect(libraryPage.getByText('R2 对象存储同步测试视频')).toBeVisible();
    await libraryPage.getByText('R2 对象存储同步测试视频').click();

    const videoEl = libraryPage.locator('video');
    await expect(videoEl).toBeVisible();
    await expect
      .poll(async () => videoEl.getAttribute('src'))
      .toContain(`https://${mockAccountId}.r2.cloudflarestorage.com/${mockBucket}/${mockPrefix}/${relativeDir}/video.mp4`);
    await expect
      .poll(async () => videoEl.getAttribute('src'))
      .toContain('X-Amz-Algorithm=AWS4-HMAC-SHA256');
    await expect
      .poll(() => r2Server.getVerifiedPresignedGetCount(), {
        message: '等待 <video> 使用有效 SigV4 预签名 URL 请求 R2 视频流',
      })
      .toBeGreaterThanOrEqual(1);
    expect(r2Server.getInvalidSignatureCount()).toBe(0);

    await libraryPage.keyboard.press('Escape');
    await expect(videoEl).toHaveCount(0);

    // 7. 断开 Cloudflare R2（确认桶内文件零删除）并切回本地目录插件
    await libraryPage.getByRole('button', { name: '设置', exact: true }).click();
    await vaultSection.getByTestId('r2-disconnect-btn').click();
    await expect(vaultSection.getByTestId('vault-status-badge')).toHaveText(
      '尚未绑定',
    );
    expect(r2Server.objects.has(`${mockPrefix}/${relativeDir}/video.mp4`)).toBe(
      true,
    );

    await vaultSection.getByTestId('vault-provider-tab-local_fs').click();
    await expect(
      vaultSection.getByRole('button', { name: '选择本地同步目录' }),
    ).toBeVisible();

    expect(pageErrors).toEqual([]);
  });
});
