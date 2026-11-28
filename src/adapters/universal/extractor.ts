/**
 * Tier 1 通用网页与媒体提取器（零外部依赖、纯 DOM + 标准浏览器 API）。
 *
 * 适用范围：任意 `http://` / `https://` 网页（无需站点专属插件），
 * 仅在用户主动触发采集时按需注入执行，平时零内存占用与零 DOM 污染。
 *
 * 提取能力：
 * 1. 规范化 URL（优先 `<link rel="canonical">`，剥离追踪参数）与稳定 ASCII `sourceId`；
 * 2. JSON-LD（`Article` / `BlogPosting` / `NewsArticle` / `VideoObject`）+ OpenGraph + Twitter Card + Meta；
 * 3. HTML5 `<video>`/`<source>` + `PerformanceResourceTiming`（`.mp4`/`.webm`/`.m3u8`/`.mpd`）媒体嗅探；
 * 4. 语义主容器正文清洗与高分辨率配图收集。
 */

export interface UniversalVideoCandidate {
  url: string;
  strategy: 'direct' | 'hls_mux' | 'dash_mux';
  mimeType: string;
  width?: number;
  height?: number;
  durationSec?: number;
}

export interface UniversalRawPageData {
  sourceId: string;
  sourceUrl: string;
  pageOrigin: string;
  siteHost: string;
  siteName?: string;
  title: string;
  description: string;
  bodyText: string;
  authorName?: string;
  authorUrl?: string;
  publishedAt?: number;
  tags: string[];
  coverUrl?: string;
  imageUrls: string[];
  videos: UniversalVideoCandidate[];
  ogType?: string;
  isDirectImageDocument?: boolean;
}

type UnknownRecord = Record<string, unknown>;

const MAX_BODY_CHARS = 100_000;
const MAX_CONTENT_IMAGES = 40;
const MIN_CONTENT_IMAGE_PX = 120;

const TRACKING_QUERY_PARAMS: ReadonlySet<string> = new Set([
  'fbclid',
  'gclid',
  'dclid',
  'msclkid',
  'mc_cid',
  'mc_eid',
  'spm',
  'spm_id_from',
  'vd_source',
  'ref_src',
  'ref_url',
  'igshid',
]);

const BOILERPLATE_SELECTORS =
  'script, style, noscript, template, iframe, nav, footer, aside, form, button, svg, canvas, [aria-hidden="true"], [role="navigation"], [role="banner"], [role="contentinfo"], [role="complementary"]';

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(obj: UnknownRecord, key: string): string | undefined {
  const val = obj[key];
  if (typeof val === 'string') {
    const trimmed = val.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  return undefined;
}

function resolveHttpUrl(raw: string | null | undefined, baseUrl: string): string | undefined {
  if (!raw) {
    return undefined;
  }
  const trimmed = raw.trim();
  if (
    !trimmed ||
    trimmed.startsWith('data:') ||
    trimmed.startsWith('blob:') ||
    trimmed.startsWith('javascript:')
  ) {
    return undefined;
  }
  try {
    const parsed = new URL(trimmed, baseUrl);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return parsed.href;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/** 规范化网页 URL：移除常见追踪参数与锚点，保证同一页面稳定去重 */
export function canonicalizePageUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return rawUrl;
    }
    parsed.hash = '';
    const keysToDelete: string[] = [];
    for (const key of parsed.searchParams.keys()) {
      const lower = key.toLowerCase();
      if (lower.startsWith('utm_') || TRACKING_QUERY_PARAMS.has(lower)) {
        keysToDelete.push(key);
      }
    }
    for (const key of keysToDelete) {
      parsed.searchParams.delete(key);
    }
    parsed.searchParams.sort();
    // 标准化非根路径尾部斜杠
    if (parsed.pathname.length > 1 && parsed.pathname.endsWith('/')) {
      parsed.pathname = parsed.pathname.replace(/\/+$/, '');
    }
    return parsed.href;
  } catch {
    return rawUrl;
  }
}

/** 64 位双通道 FNV-1a 哈希（纯 JS、零依赖、用于稳定生成 ASCII sourceId） */
function hashStringHex16(input: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x050c5d1f;
  for (let i = 0; i < input.length; i += 1) {
    const code = input.charCodeAt(i);
    h1 ^= code;
    h1 = Math.imul(h1, 0x01000193);
    h2 ^= (code + i) & 0xff;
    h2 = Math.imul(h2, 0x01000193);
  }
  const p1 = (h1 >>> 0).toString(16).padStart(8, '0');
  const p2 = (h2 >>> 0).toString(16).padStart(8, '0');
  return `${p1}${p2}`;
}

/** 基于规范化 URL 生成确定且跨平台文件系统安全的通用网页 sourceId */
export function buildUniversalSourceId(canonicalUrl: string): string {
  let hostSlug = 'page';
  try {
    const host = new URL(canonicalUrl).hostname
      .toLowerCase()
      .replace(/^www\./, '');
    const cleaned = host.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    if (cleaned) {
      hostSlug = cleaned.slice(0, 20);
    }
  } catch {
    // 保留默认 hostSlug
  }
  return `${hostSlug}_${hashStringHex16(canonicalUrl)}`;
}

function parseIsoDurationSec(raw: string | undefined): number | undefined {
  if (!raw) {
    return undefined;
  }
  const match =
    /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i.exec(
      raw.trim(),
    );
  if (!match) {
    const numeric = Number(raw.trim());
    return Number.isFinite(numeric) && numeric > 0
      ? Math.round(numeric)
      : undefined;
  }
  const days = Number(match[1] ?? 0);
  const hours = Number(match[2] ?? 0);
  const mins = Number(match[3] ?? 0);
  const secs = Number(match[4] ?? 0);
  const total = days * 86400 + hours * 3600 + mins * 60 + secs;
  return total > 0 ? Math.round(total) : undefined;
}

function parseTimestampMs(raw: string | undefined): number | undefined {
  if (!raw) {
    return undefined;
  }
  const parsed = Date.parse(raw.trim());
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function readMeta(doc: Document, selectors: readonly string[]): string | undefined {
  for (const selector of selectors) {
    const el = doc.querySelector<HTMLMetaElement>(selector);
    const content = el?.content?.trim();
    if (content) {
      return content;
    }
  }
  return undefined;
}

interface ParsedJsonLd {
  title?: string;
  description?: string;
  articleBody?: string;
  authorName?: string;
  authorUrl?: string;
  publishedAt?: number;
  imageUrl?: string;
  tags: string[];
  videoUrl?: string;
  durationSec?: number;
  isVideoObject?: boolean;
}

function extractImageFromJsonLdField(
  field: unknown,
  baseUrl: string,
): string | undefined {
  if (typeof field === 'string') {
    return resolveHttpUrl(field, baseUrl);
  }
  if (Array.isArray(field)) {
    for (const entry of field) {
      const resolved = extractImageFromJsonLdField(entry, baseUrl);
      if (resolved) {
        return resolved;
      }
    }
    return undefined;
  }
  if (isRecord(field)) {
    return resolveHttpUrl(readString(field, 'url'), baseUrl);
  }
  return undefined;
}

function extractAuthorFromJsonLdField(
  field: unknown,
  baseUrl: string,
): { name?: string; url?: string } {
  if (typeof field === 'string') {
    const trimmed = field.trim();
    return trimmed ? { name: trimmed } : {};
  }
  if (Array.isArray(field)) {
    for (const entry of field) {
      const res = extractAuthorFromJsonLdField(entry, baseUrl);
      if (res.name) {
        return res;
      }
    }
    return {};
  }
  if (isRecord(field)) {
    const name = readString(field, 'name');
    const url = resolveHttpUrl(readString(field, 'url'), baseUrl);
    return {
      ...(name ? { name } : {}),
      ...(url ? { url } : {}),
    };
  }
  return {};
}

function parseJsonLd(doc: Document, baseUrl: string): ParsedJsonLd {
  const result: ParsedJsonLd = { tags: [] };
  const scripts = Array.from(
    doc.querySelectorAll('script[type="application/ld+json"]'),
  );

  const nodes: UnknownRecord[] = [];
  const collectNode = (candidate: unknown): void => {
    if (Array.isArray(candidate)) {
      for (const item of candidate) {
        collectNode(item);
      }
      return;
    }
    if (!isRecord(candidate)) {
      return;
    }
    nodes.push(candidate);
    if (Array.isArray(candidate['@graph'])) {
      collectNode(candidate['@graph']);
    }
  };

  for (const script of scripts) {
    const text = script.textContent?.trim();
    if (!text) {
      continue;
    }
    try {
      collectNode(JSON.parse(text) as unknown);
    } catch {
      // 忽略格式损坏的 JSON-LD 块
    }
  }

  for (const node of nodes) {
    const rawType = node['@type'];
    const types = Array.isArray(rawType)
      ? rawType.filter((t): t is string => typeof t === 'string')
      : typeof rawType === 'string'
        ? [rawType]
        : [];
    const lowerTypes = types.map((t) => t.toLowerCase());
    const isVideo = lowerTypes.some((t) => t.includes('video'));
    const isArticle = lowerTypes.some(
      (t) =>
        t.includes('article') ||
        t.includes('posting') ||
        t.includes('webpage'),
    );
    if (!isVideo && !isArticle) {
      continue;
    }

    if (isVideo) {
      result.isVideoObject = true;
    }
    result.title ??= readString(node, 'headline') ?? readString(node, 'name');
    result.description ??= readString(node, 'description');
    result.articleBody ??= readString(node, 'articleBody');
    result.publishedAt ??=
      parseTimestampMs(readString(node, 'datePublished')) ??
      parseTimestampMs(readString(node, 'uploadDate'));
    result.imageUrl ??=
      extractImageFromJsonLdField(node.image, baseUrl) ??
      extractImageFromJsonLdField(node.thumbnailUrl, baseUrl);
    result.videoUrl ??= resolveHttpUrl(readString(node, 'contentUrl'), baseUrl);
    result.durationSec ??= parseIsoDurationSec(readString(node, 'duration'));

    if (!result.authorName) {
      const author = extractAuthorFromJsonLdField(node.author, baseUrl);
      if (author.name) {
        result.authorName = author.name;
      }
      if (author.url) {
        result.authorUrl = author.url;
      }
    }

    const keywords = node.keywords;
    if (typeof keywords === 'string') {
      for (const kw of keywords.split(/[,，]/)) {
        const trimmed = kw.trim();
        if (trimmed) {
          result.tags.push(trimmed);
        }
      }
    } else if (Array.isArray(keywords)) {
      for (const kw of keywords) {
        if (typeof kw === 'string' && kw.trim()) {
          result.tags.push(kw.trim());
        }
      }
    }
  }

  return result;
}

function classifyVideoUrl(
  url: string,
  mimeHint?: string,
): { strategy: 'direct' | 'hls_mux' | 'dash_mux'; mimeType: string } | null {
  let pathname = url.toLowerCase();
  try {
    pathname = new URL(url).pathname.toLowerCase();
  } catch {
    // 使用原小写字符串回退
  }
  const mime = (mimeHint ?? '').toLowerCase();

  if (
    pathname.endsWith('.m3u8') ||
    mime.includes('mpegurl') ||
    url.toLowerCase().includes('.m3u8?')
  ) {
    return { strategy: 'hls_mux', mimeType: 'video/mp4' };
  }
  if (
    pathname.endsWith('.mpd') ||
    mime.includes('dash+xml') ||
    url.toLowerCase().includes('.mpd?')
  ) {
    return { strategy: 'dash_mux', mimeType: 'video/mp4' };
  }
  if (pathname.endsWith('.mp4') || mime.startsWith('video/mp4')) {
    return { strategy: 'direct', mimeType: 'video/mp4' };
  }
  if (pathname.endsWith('.webm') || mime.startsWith('video/webm')) {
    return { strategy: 'direct', mimeType: 'video/webm' };
  }
  if (pathname.endsWith('.mov') || mime.startsWith('video/quicktime')) {
    return { strategy: 'direct', mimeType: 'video/quicktime' };
  }
  return null;
}

function collectVideoCandidates(
  doc: Document,
  baseUrl: string,
  jsonLd: ParsedJsonLd,
): { videos: UniversalVideoCandidate[]; posterUrl?: string } {
  const candidates: UniversalVideoCandidate[] = [];
  const seen = new Set<string>();
  let posterUrl: string | undefined;

  const pushCandidate = (
    rawUrl: string | null | undefined,
    opts?: {
      mimeType?: string;
      width?: number;
      height?: number;
      durationSec?: number;
    },
  ): void => {
    const resolved = resolveHttpUrl(rawUrl, baseUrl);
    if (!resolved || seen.has(resolved)) {
      return;
    }
    const classified = classifyVideoUrl(resolved, opts?.mimeType);
    if (!classified) {
      return;
    }
    seen.add(resolved);
    candidates.push({
      url: resolved,
      strategy: classified.strategy,
      mimeType: classified.mimeType,
      ...(opts?.width && opts.width > 0 ? { width: Math.round(opts.width) } : {}),
      ...(opts?.height && opts.height > 0
        ? { height: Math.round(opts.height) }
        : {}),
      ...(opts?.durationSec &&
      Number.isFinite(opts.durationSec) &&
      opts.durationSec > 0
        ? { durationSec: Math.round(opts.durationSec) }
        : {}),
    });
  };

  // 1. 扫描 DOM <video> 与 <source>
  const videoEls = Array.from(doc.querySelectorAll('video'));
  for (const video of videoEls) {
    if (!posterUrl && video.poster) {
      posterUrl = resolveHttpUrl(video.poster, baseUrl);
    }
    const meta = {
      width: video.videoWidth || undefined,
      height: video.videoHeight || undefined,
      durationSec:
        Number.isFinite(video.duration) && video.duration > 0
          ? video.duration
          : undefined,
    };
    pushCandidate(video.currentSrc || video.getAttribute('src'), meta);
    const sources = Array.from(video.querySelectorAll('source'));
    for (const source of sources) {
      pushCandidate(source.getAttribute('src'), {
        ...meta,
        mimeType: source.getAttribute('type') ?? undefined,
      });
    }
  }

  // 2. JSON-LD VideoObject 与 og:video
  if (jsonLd.videoUrl) {
    pushCandidate(jsonLd.videoUrl, {
      ...(jsonLd.durationSec ? { durationSec: jsonLd.durationSec } : {}),
    });
  }
  const ogVideo = readMeta(doc, [
    'meta[property="og:video:secure_url"]',
    'meta[property="og:video:url"]',
    'meta[property="og:video"]',
  ]);
  const ogVideoType = readMeta(doc, ['meta[property="og:video:type"]']);
  if (ogVideo) {
    pushCandidate(ogVideo, { mimeType: ogVideoType });
  }

  // 3. 零侵入扫描浏览器 PerformanceResourceTiming 中已加载的流媒体资源（.m3u8 / .mpd / .mp4）
  if (
    typeof performance !== 'undefined' &&
    typeof performance.getEntriesByType === 'function'
  ) {
    try {
      const entries = performance.getEntriesByType('resource');
      for (const entry of entries) {
        if (typeof entry.name === 'string') {
          pushCandidate(entry.name);
        }
      }
    } catch {
      // 忽略受限上下文性能条目异常
    }
  }

  // 优先直链 MP4/WebM，其次 HLS，最后 DASH
  const priority: Record<UniversalVideoCandidate['strategy'], number> = {
    direct: 0,
    hls_mux: 1,
    dash_mux: 2,
  };
  candidates.sort((a, b) => priority[a.strategy] - priority[b.strategy]);

  return {
    videos: candidates,
    ...(posterUrl ? { posterUrl } : {}),
  };
}

function pickBestSrcsetUrl(srcset: string, baseUrl: string): string | undefined {
  let bestUrl: string | undefined;
  let bestWeight = -1;
  for (const part of srcset.split(',')) {
    const tokens = part.trim().split(/\s+/);
    const rawUrl = tokens[0];
    if (!rawUrl) {
      continue;
    }
    const resolved = resolveHttpUrl(rawUrl, baseUrl);
    if (!resolved) {
      continue;
    }
    const descriptor = tokens[1] ?? '';
    let weight = 1;
    if (descriptor.endsWith('w')) {
      const w = Number(descriptor.slice(0, -1));
      if (Number.isFinite(w)) {
        weight = w;
      }
    } else if (descriptor.endsWith('x')) {
      const x = Number(descriptor.slice(0, -1));
      if (Number.isFinite(x)) {
        weight = x * 1000;
      }
    }
    if (weight > bestWeight) {
      bestWeight = weight;
      bestUrl = resolved;
    }
  }
  return bestUrl;
}

function findPrimaryContentElement(doc: Document): Element | null {
  const semanticCandidates = [
    'article',
    'main',
    '[role="main"]',
    '.markdown-body',
    '.article-content',
    '.post-content',
    '.entry-content',
    '.prose',
  ];

  for (const selector of semanticCandidates) {
    const nodes = Array.from(doc.querySelectorAll(selector));
    if (nodes.length === 0) {
      continue;
    }
    let best: Element | null = null;
    let bestLen = 0;
    for (const node of nodes) {
      const len = (node.textContent ?? '').trim().length;
      if (len > bestLen) {
        bestLen = len;
        best = node;
      }
    }
    if (best && bestLen >= 80) {
      return best;
    }
  }

  // 回退：启发式查找段落文本密度最高的容器
  if (doc.body) {
    const blocks = Array.from(doc.body.querySelectorAll('section, div'));
    let bestBlock: Element | null = null;
    let bestScore = 0;
    for (const block of blocks) {
      const paragraphs = block.querySelectorAll('p');
      if (paragraphs.length < 2) {
        continue;
      }
      let score = 0;
      for (const p of paragraphs) {
        const len = (p.textContent ?? '').trim().length;
        if (len >= 25) {
          score += len;
        }
      }
      if (score > bestScore) {
        bestScore = score;
        bestBlock = block;
      }
    }
    if (bestBlock && bestScore >= 160) {
      return bestBlock;
    }
  }

  return doc.body;
}

function extractReadableText(root: Element): string {
  const clone = root.cloneNode(true) as Element;
  const noisy = Array.from(clone.querySelectorAll(BOILERPLATE_SELECTORS));
  for (const el of noisy) {
    el.remove();
  }

  const chunks: string[] = [];
  const blockNodes = Array.from(
    clone.querySelectorAll('h1, h2, h3, h4, p, li, blockquote, pre'),
  );

  if (blockNodes.length > 0) {
    let lastText = '';
    for (const node of blockNodes) {
      // 跳过被已提取祖先 block 包裹的重复子节点（如 li > p）
      if (node.parentElement?.closest('li, blockquote, pre')) {
        continue;
      }
      const tag = node.tagName.toLowerCase();
      const raw =
        tag === 'pre'
          ? (node.textContent ?? '').trim()
          : (node.textContent ?? '').replace(/\s+/g, ' ').trim();
      if (!raw || raw === lastText) {
        continue;
      }
      lastText = raw;
      if (tag === 'li') {
        chunks.push(`- ${raw}`);
      } else if (tag === 'blockquote') {
        chunks.push(`> ${raw}`);
      } else if (tag === 'pre') {
        chunks.push(`\`\`\`\n${raw}\n\`\`\``);
      } else {
        chunks.push(raw);
      }
    }
  }

  const joined =
    chunks.length > 0
      ? chunks.join('\n\n')
      : (clone.textContent ?? '')
          .replace(/\r\n/g, '\n')
          .replace(/[ \t]+/g, ' ')
          .replace(/\n{3,}/g, '\n\n')
          .trim();

  return joined.length > MAX_BODY_CHARS
    ? joined.slice(0, MAX_BODY_CHARS)
    : joined;
}

function collectContentImages(root: Element, baseUrl: string): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();
  const imgs = Array.from(root.querySelectorAll('img'));

  for (const img of imgs) {
    if (urls.length >= MAX_CONTENT_IMAGES) {
      break;
    }
    if (img.closest('nav, footer, aside, [aria-hidden="true"]')) {
      continue;
    }

    const naturalW = img.naturalWidth || 0;
    const naturalH = img.naturalHeight || 0;
    const attrW = Number(img.getAttribute('width') ?? 0);
    const attrH = Number(img.getAttribute('height') ?? 0);
    const effectiveW = naturalW || attrW;
    const effectiveH = naturalH || attrH;

    // 过滤明显的小图标、头像或 1x1 追踪像素（仅当维度明确可读时）
    if (
      (effectiveW > 0 && effectiveW < MIN_CONTENT_IMAGE_PX) ||
      (effectiveH > 0 && effectiveH < MIN_CONTENT_IMAGE_PX)
    ) {
      continue;
    }

    const srcset =
      img.getAttribute('data-srcset') ?? img.getAttribute('srcset') ?? '';
    const candidate =
      (srcset ? pickBestSrcsetUrl(srcset, baseUrl) : undefined) ??
      resolveHttpUrl(img.getAttribute('data-original'), baseUrl) ??
      resolveHttpUrl(img.getAttribute('data-src'), baseUrl) ??
      resolveHttpUrl(img.currentSrc || img.getAttribute('src'), baseUrl);

    if (!candidate || seen.has(candidate)) {
      continue;
    }

    // 跳过常见 SVG 装饰图标
    try {
      if (new URL(candidate).pathname.toLowerCase().endsWith('.svg')) {
        continue;
      }
    } catch {
      continue;
    }

    seen.add(candidate);
    urls.push(candidate);
  }

  return urls;
}

function cleanPageTitle(
  rawTitle: string,
  siteName: string | undefined,
): string {
  const trimmed = rawTitle.replace(/\s+/g, ' ').trim();
  if (!trimmed || !siteName) {
    return trimmed;
  }
  const escaped = siteName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const stripped = trimmed
    .replace(new RegExp(`\\s*[-|–—·]\\s*${escaped}\\s*$`, 'i'), '')
    .trim();
  return stripped.length >= 2 ? stripped : trimmed;
}

/**
 * 从当前浏览器文档提取通用网页原始载荷（Tier 1 Universal Extractor）。
 */
export function extractUniversalPageData(
  doc: Document = document,
  href: string = window.location.href,
): UniversalRawPageData | null {
  let parsedHref: URL;
  try {
    parsedHref = new URL(href);
  } catch {
    return null;
  }
  if (parsedHref.protocol !== 'http:' && parsedHref.protocol !== 'https:') {
    return null;
  }

  const canonicalHref =
    resolveHttpUrl(
      doc.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.getAttribute(
        'href',
      ),
      href,
    ) ?? href;
  const sourceUrl = canonicalizePageUrl(canonicalHref);
  const sourceId = buildUniversalSourceId(sourceUrl);
  const pageOrigin = parsedHref.origin;
  const siteHost = parsedHref.hostname.toLowerCase().replace(/^www\./, '');

  const jsonLd = parseJsonLd(doc, href);
  const siteName = readMeta(doc, [
    'meta[property="og:site_name"]',
    'meta[name="application-name"]',
  ]);
  const ogType = readMeta(doc, ['meta[property="og:type"]']);

  const h1Text = doc.querySelector('h1')?.textContent?.replace(/\s+/g, ' ').trim();
  const rawTitle =
    readMeta(doc, [
      'meta[property="og:title"]',
      'meta[name="twitter:title"]',
    ]) ??
    jsonLd.title ??
    (h1Text && h1Text.length >= 2 && h1Text.length <= 200 ? h1Text : undefined) ??
    doc.title ??
    siteHost;
  const title = cleanPageTitle(rawTitle, siteName) || siteHost;

  const metaDescription =
    readMeta(doc, [
      'meta[property="og:description"]',
      'meta[name="description"]',
      'meta[name="twitter:description"]',
    ]) ??
    jsonLd.description ??
    '';

  const authorName =
    jsonLd.authorName ??
    readMeta(doc, ['meta[name="author"]', 'meta[property="article:author"]']) ??
    doc
      .querySelector('[rel="author"], .author-name, .byline')
      ?.textContent?.trim() ??
    siteName ??
    siteHost;

  const authorUrl =
    jsonLd.authorUrl ??
    resolveHttpUrl(
      doc.querySelector<HTMLAnchorElement>('a[rel="author"]')?.getAttribute(
        'href',
      ),
      href,
    );

  const publishedAt =
    jsonLd.publishedAt ??
    parseTimestampMs(
      readMeta(doc, [
        'meta[property="article:published_time"]',
        'meta[name="publish-date"]',
        'meta[name="pubdate"]',
      ]) ??
        doc.querySelector('time[datetime]')?.getAttribute('datetime') ??
        undefined,
    );

  const tagSet = new Set<string>();
  const tags: string[] = [];
  const pushTag = (raw: string | undefined): void => {
    const cleaned = raw?.trim().replace(/^#+/, '');
    if (!cleaned || cleaned.length > 40) {
      return;
    }
    const key = cleaned.toLowerCase();
    if (!tagSet.has(key)) {
      tagSet.add(key);
      tags.push(cleaned);
    }
  };
  for (const t of jsonLd.tags) {
    pushTag(t);
  }
  const articleTags = Array.from(
    doc.querySelectorAll<HTMLMetaElement>('meta[property="article:tag"]'),
  );
  for (const el of articleTags) {
    pushTag(el.content);
  }
  const metaKeywords = readMeta(doc, ['meta[name="keywords"]']);
  if (metaKeywords) {
    for (const kw of metaKeywords.split(/[,，]/)) {
      pushTag(kw);
      if (tags.length >= 12) {
        break;
      }
    }
  }

  const isDirectImageDocument =
    typeof doc.contentType === 'string' &&
    doc.contentType.toLowerCase().startsWith('image/');

  const { videos, posterUrl } = collectVideoCandidates(doc, href, jsonLd);

  const primaryRoot = findPrimaryContentElement(doc);
  const extractedText = primaryRoot ? extractReadableText(primaryRoot) : '';
  const bodyText =
    extractedText.length >= (jsonLd.articleBody?.length ?? 0)
      ? extractedText
      : (jsonLd.articleBody ?? extractedText);

  const imageUrls = isDirectImageDocument
    ? [href]
    : primaryRoot
      ? collectContentImages(primaryRoot, href)
      : [];

  const coverUrl =
    posterUrl ??
    resolveHttpUrl(
      readMeta(doc, [
        'meta[property="og:image"]',
        'meta[name="twitter:image"]',
      ]),
      href,
    ) ??
    jsonLd.imageUrl ??
    imageUrls[0];

  return {
    sourceId,
    sourceUrl,
    pageOrigin,
    siteHost,
    ...(siteName ? { siteName } : {}),
    title,
    description: metaDescription,
    bodyText,
    ...(authorName ? { authorName } : {}),
    ...(authorUrl ? { authorUrl } : {}),
    ...(publishedAt !== undefined ? { publishedAt } : {}),
    tags: tags.slice(0, 12),
    ...(coverUrl ? { coverUrl } : {}),
    imageUrls,
    videos,
    ...(ogType ? { ogType } : {}),
    ...(isDirectImageDocument ? { isDirectImageDocument: true } : {}),
  };
}
