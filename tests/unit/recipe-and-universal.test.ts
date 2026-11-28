import assert from 'node:assert/strict';
import test from 'node:test';
import {
  compileRecipeAdapter,
  pornhubRecipe,
  xvideosRecipe,
} from '../../src/adapters/recipes/index.ts';
import {
  buildUniversalSourceId,
  canonicalizePageUrl,
} from '../../src/adapters/universal/extractor.ts';
import { universalWebAdapter } from '../../src/adapters/universal/parser.ts';
import { buildItemRelativeDir, buildMediaAssetsFromPayload } from '../../src/storage/path.ts';
import {
  isPlatformId,
  sanitizeAssetRequestHeaders,
} from '../../src/types/schema.ts';

test('open PlatformId validates safe slugs and rejects unsafe path traversal / reserved names', () => {
  assert.equal(isPlatformId('douyin'), true);
  assert.equal(isPlatformId('web'), true);
  assert.equal(isPlatformId('my_custom-site1'), true);

  assert.equal(isPlatformId(''), false);
  assert.equal(isPlatformId('../etc'), false);
  assert.equal(isPlatformId('a/b'), false);
  assert.equal(isPlatformId('UpperCase'), false);
  assert.equal(isPlatformId('con'), false);
  assert.equal(isPlatformId('nul'), false);
  assert.equal(isPlatformId('a'.repeat(33)), false);
  assert.equal(isPlatformId(null), false);
});

test('sanitizeAssetRequestHeaders accepts http(s) Referer/Origin and drops invalid protocols', () => {
  assert.deepEqual(
    sanitizeAssetRequestHeaders({
      referer: 'https://blog.example.org/post/1',
      origin: 'https://blog.example.org/subpath',
    }),
    {
      referer: 'https://blog.example.org/post/1',
      origin: 'https://blog.example.org',
    },
  );
  assert.equal(
    sanitizeAssetRequestHeaders({
      referer: 'javascript:alert(1)',
      origin: 'file:///etc/passwd',
    }),
    undefined,
  );
});

test('Tier 2 Recipe compiler normalizes XVideos direct MP4 with fallback and HLS fallback', () => {
  const adapter = compileRecipeAdapter(xvideosRecipe);
  assert.equal(adapter.id, 'xvideos');
  assert.equal(adapter.tier, 'recipe');
  assert.equal(adapter.matchesUrl('https://www.xvideos.com/video.abc123/demo'), true);
  assert.equal(adapter.matchesUrl('https://example.com/video.abc123'), false);

  const directPayload = adapter.normalizeRawData(
    {
      videoId: 'abc123',
      sourceUrl: 'https://www.xvideos.com/video.abc123/demo',
      title: 'Recipe XV Demo',
      url_high: 'https://cdn.xvideos-cdn.com/high.mp4',
      url_low: 'https://cdn.xvideos-cdn.com/low.mp4',
      url_thumb169: 'https://cdn.xvideos-cdn.com/thumb.jpg',
      uploader_name: 'Creator A',
      video_duration: 125,
      tags: ['tag1', 'Tag1', 'tag2'],
    },
    'floating_button',
  );
  assert.ok(directPayload);
  assert.equal(directPayload.platform, 'xvideos');
  assert.equal(directPayload.sourceId, 'abc123');
  assert.equal(directPayload.assets[0]?.strategy, 'direct');
  assert.equal(directPayload.assets[0]?.sourceUrl, 'https://cdn.xvideos-cdn.com/high.mp4');
  assert.deepEqual(directPayload.assets[0]?.fallbackUrls, ['https://cdn.xvideos-cdn.com/low.mp4']);
  assert.deepEqual(directPayload.hashtags, ['tag1', 'tag2']);

  const hlsPayload = adapter.normalizeRawData(
    {
      sourceUrl: 'https://www.xvideos.com/video.hls99/demo',
      title: 'Recipe HLS Only',
      url_hls: 'https://cdn.xvideos-cdn.com/master.m3u8',
    },
    'hotkey',
  );
  assert.ok(hlsPayload);
  assert.equal(hlsPayload.sourceId, 'hls99');
  assert.equal(hlsPayload.assets[0]?.strategy, 'hls_mux');
});

test('Tier 2 Recipe compiler normalizes Pornhub highest-quality MP4 from resolvedMedia', () => {
  const adapter = compileRecipeAdapter(pornhubRecipe);
  assert.equal(adapter.id, 'pornhub');
  assert.equal(adapter.matchesUrl('https://cn.pornhub.com/view_video.php?viewkey=ph01'), true);

  const payload = adapter.normalizeRawData(
    {
      viewkey: 'ph01',
      video_title: 'Recipe PH Demo',
      video_duration: 210,
      image_url: 'https://ei.phncdn.com/cover.jpg',
      sourceUrl: 'https://www.pornhub.com/view_video.php?viewkey=ph01',
      mediaDefinitions: [
        { format: 'mp4', quality: [480, 1080], videoUrl: 'https://www.pornhub.com/video/get_media?s=x' },
      ],
      resolvedMedia: [
        { format: 'mp4', quality: '480', videoUrl: 'https://ev.phncdn.com/480.mp4' },
        { format: 'mp4', quality: '1080', videoUrl: 'https://ev.phncdn.com/1080.mp4' },
      ],
    },
    'floating_button',
  );
  assert.ok(payload);
  assert.equal(payload.sourceId, 'ph01');
  assert.equal(payload.assets[0]?.strategy, 'direct');
  assert.equal(payload.assets[0]?.sourceUrl, 'https://ev.phncdn.com/1080.mp4');
  assert.equal(payload.assets[0]?.height, 1080);
  assert.deepEqual(payload.assets[0]?.fallbackUrls, ['https://ev.phncdn.com/480.mp4']);
});

test('Tier 1 Universal canonicalization, sourceId determinism, and article/video normalization', () => {
  const u1 = canonicalizePageUrl(
    'https://blog.example.org/posts/hello/?b=2&utm_source=twitter&a=1#section-1',
  );
  const u2 = canonicalizePageUrl(
    'https://blog.example.org/posts/hello?a=1&b=2&fbclid=xyz',
  );
  assert.equal(u1, u2);
  assert.equal(buildUniversalSourceId(u1), buildUniversalSourceId(u2));
  assert.match(buildUniversalSourceId(u1), /^blog-example-org_[0-9a-f]{16}$/);

  const articlePayload = universalWebAdapter.normalizeRawData(
    {
      sourceUrl: 'https://blog.example.org/posts/universal?utm_medium=rss',
      pageOrigin: 'https://blog.example.org',
      siteHost: 'blog.example.org',
      siteName: 'Example Tech Blog',
      title: 'Universal Architecture Deep Dive',
      description: 'Short summary',
      bodyText: 'Paragraph one.\n\nParagraph two with enough content.',
      authorName: 'Alice',
      tags: ['Architecture', 'architecture', 'MV3'],
      coverUrl: 'https://cdn.example.org/cover.png',
      imageUrls: ['https://cdn.example.org/diagram.webp'],
      videos: [],
    },
    'popup',
  );
  assert.ok(articlePayload);
  assert.equal(articlePayload.platform, 'web');
  assert.equal(articlePayload.kind, 'article');
  assert.equal(articlePayload.platformExtra?.siteName, 'Example Tech Blog');
  assert.equal(articlePayload.platformExtra?.siteHost, 'blog.example.org');
  assert.equal(articlePayload.defaultRequestHeaders?.referer, 'https://blog.example.org/');
  assert.deepEqual(articlePayload.hashtags, ['Architecture', 'MV3']);

  // 验证资产相对路径构造自动继承 defaultRequestHeaders 与安全路径
  const built = buildMediaAssetsFromPayload(articlePayload);
  assert.equal(built.coverRelativePath, 'cover.png');
  assert.equal(built.assets[0]?.requestHeaders?.referer, 'https://blog.example.org/');
  assert.equal(built.assets[1]?.requestHeaders?.referer, 'https://blog.example.org/');
  const dir = buildItemRelativeDir(
    articlePayload.platform,
    articlePayload.sourceId,
    articlePayload.title,
    1_700_000_000_000,
  );
  assert.ok(dir.startsWith('items/web/'));

  // 验证视频页优先归类为 video 并支持 HLS 混流策略
  const videoPayload = universalWebAdapter.normalizeRawData(
    {
      sourceUrl: 'https://media.randomsite.test/v/42',
      pageOrigin: 'https://media.randomsite.test',
      siteHost: 'media.randomsite.test',
      title: 'Random HLS Video',
      description: 'Clip desc',
      bodyText: 'Watch clip',
      videos: [
        {
          url: 'https://stream.randomsite.test/live/master.m3u8',
          strategy: 'hls_mux',
          mimeType: 'video/mp4',
          durationSec: 95,
        },
      ],
      imageUrls: [],
      tags: [],
    },
    'hotkey',
  );
  assert.ok(videoPayload);
  assert.equal(videoPayload.kind, 'video');
  assert.equal(videoPayload.assets[0]?.strategy, 'hls_mux');
  assert.equal(videoPayload.assets[0]?.sourceUrl, 'https://stream.randomsite.test/live/master.m3u8');
});
