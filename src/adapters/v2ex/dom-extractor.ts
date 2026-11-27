/**
 * V2EX 服务端渲染（SSR HTML）DOM 提取器。
 *
 * 独立无状态模块：既可用于当前浏览器 `document`，也可用于 `DOMParser` 解析
 * `/my/topics` 与 `/t/{id}` 远端 HTML，严格零 `any`。
 */

export interface V2exRawReply {
  id: string;
  authorName: string;
  authorId?: string;
  avatarUrl?: string;
  content: string;
  likeCount: number;
  createdAt?: number;
}

export interface V2exRawTopicData {
  topicId: string;
  sourceUrl: string;
  title: string;
  description: string;
  authorName: string;
  authorId: string;
  authorAvatarUrl?: string;
  nodeName?: string;
  nodeSlug?: string;
  publishedAt?: number;
  imageUrls: string[];
  replies: V2exRawReply[];
  replyCount?: number;
  clicks?: number;
}

export interface V2exLoginAccount {
  accountId: string;
  accountName: string;
}

export interface V2exFavoriteListPage {
  topicIds: string[];
  hasNextPage: boolean;
  isChallengePage: boolean;
}

const MAX_TOPIC_IMAGES = 50;
const MAX_EXTRACTED_REPLIES = 100;

/** 从 URL 路径解析 V2EX 主题纯数字 ID（如 `/t/1088888` -> `'1088888'`） */
export function extractTopicIdFromUrl(rawUrl: string): string | null {
  try {
    const parsed = new URL(rawUrl, 'https://www.v2ex.com');
    const match = /^\/t\/(\d+)(?:\/|$)/.exec(parsed.pathname);
    return match?.[1] ?? null;
  } catch {
    const match = /\/t\/(\d+)/.exec(rawUrl);
    return match?.[1] ?? null;
  }
}

/** 规范化 V2EX 相对或协议省略的资源 URL 为 `https://` */
export function normalizeV2exResourceUrl(
  rawUrl: string | null | undefined,
  baseUrl = 'https://www.v2ex.com/',
): string | null {
  if (!rawUrl) {
    return null;
  }
  const trimmed = rawUrl.trim();
  if (!trimmed || trimmed.startsWith('data:') || trimmed.startsWith('javascript:')) {
    return null;
  }
  try {
    const candidate = trimmed.startsWith('//') ? `https:${trimmed}` : trimmed;
    const parsed = new URL(candidate, baseUrl);
    if (parsed.protocol === 'http:') {
      parsed.protocol = 'https:';
    }
    if (parsed.protocol !== 'https:') {
      return null;
    }
    return parsed.href;
  } catch {
    return null;
  }
}

/** 解析 V2EX 标准时间属性（如 `2026-11-27 10:20:30 +08:00` 或 `+0800`） */
export function parseV2exTimestamp(raw: string | null | undefined): number | undefined {
  if (!raw) {
    return undefined;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  const normalized = trimmed
    .replace(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})/, '$1T$2')
    .replace(/\s*([+-]\d{2}):?(\d{2})$/, '$1:$2');
  const ts = Date.parse(normalized);
  if (Number.isFinite(ts) && ts > 0) {
    return Math.trunc(ts);
  }
  const fallback = Date.parse(trimmed);
  return Number.isFinite(fallback) && fallback > 0
    ? Math.trunc(fallback)
    : undefined;
}

/** 检测页面是否为 Cloudflare 人机验证或风控拦截页 */
export function isV2exChallengeDocument(doc: Document): boolean {
  const title = (doc.title ?? '').trim().toLowerCase();
  if (
    title.includes('just a moment') ||
    title.includes('attention required') ||
    title.includes('checking your browser')
  ) {
    return true;
  }
  if (
    doc.querySelector('#challenge-running, #cf-wrapper, form#challenge-form') !==
    null
  ) {
    return true;
  }
  return doc.querySelector('#Main') === null;
}

/**
 * 从 V2EX 页面顶栏/右侧栏提取当前已登录账号用户名。
 * 必须检测到退出/设置/我的收藏等登录专属特征，避免误把帖子作者当成登录账号。
 */
export function extractV2exLoginAccount(doc: Document): V2exLoginAccount | null {
  const hasLoginMarker =
    doc.querySelector(
      'a[href^="/signout"], a[href="/settings"], a[href="/my/topics"], a[onclick*="signout"]',
    ) !== null;
  if (!hasLoginMarker) {
    return null;
  }

  const memberLinks = doc.querySelectorAll<HTMLAnchorElement>(
    '#Top a[href^="/member/"], #Rightbar a[href^="/member/"]',
  );
  for (const link of memberLinks) {
    const href = link.getAttribute('href') ?? '';
    const match = /^\/member\/([^/?#]+)/.exec(href.trim());
    const username = match?.[1]?.trim();
    if (username) {
      return {
        accountId: username,
        accountName: username,
      };
    }
  }
  return null;
}

function serializeElementText(root: Element): string {
  const parts: string[] = [];

  const walk = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      parts.push(node.textContent ?? '');
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) {
      return;
    }
    const el = node as Element;
    const tag = el.tagName.toUpperCase();

    if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') {
      return;
    }
    if (tag === 'BR') {
      parts.push('\n');
      return;
    }
    if (tag === 'PRE') {
      parts.push('\n', (el.textContent ?? '').trimEnd(), '\n');
      return;
    }
    if (tag === 'IMG') {
      const alt = el.getAttribute('alt')?.trim();
      if (alt) {
        parts.push(`[图片: ${alt}]`);
      }
      return;
    }

    const isBlock =
      tag === 'P' ||
      tag === 'DIV' ||
      tag === 'LI' ||
      tag === 'BLOCKQUOTE' ||
      tag === 'H1' ||
      tag === 'H2' ||
      tag === 'H3' ||
      tag === 'H4' ||
      tag === 'H5' ||
      tag === 'H6' ||
      tag === 'HR';

    if (isBlock && parts.length > 0) {
      parts.push('\n');
    }
    if (tag === 'LI') {
      parts.push('- ');
    }

    for (const child of el.childNodes) {
      walk(child);
    }

    if (isBlock) {
      parts.push('\n');
    }
  };

  walk(root);

  return parts
    .join('')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function isIgnorableTopicImage(url: string): boolean {
  try {
    const parsed = new URL(url);
    const pathname = parsed.pathname.toLowerCase();
    if (pathname.startsWith('/static/img/') || pathname.endsWith('.svg')) {
      return true;
    }
    return false;
  } catch {
    return true;
  }
}

function collectImagesFromContainer(
  container: Element,
  baseUrl: string,
  seen: Set<string>,
  out: string[],
): void {
  const imgs = container.querySelectorAll<HTMLImageElement>('img');
  for (const img of imgs) {
    if (out.length >= MAX_TOPIC_IMAGES) {
      break;
    }
    const rawSrc =
      img.getAttribute('data-src') ??
      img.getAttribute('src');
    const normalized = normalizeV2exResourceUrl(rawSrc, baseUrl);
    if (!normalized || isIgnorableTopicImage(normalized) || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    out.push(normalized);
  }
}

function parseThanksCount(cell: Element): number {
  const fadeNodes = cell.querySelectorAll('.small.fade');
  for (const node of fadeNodes) {
    const text = node.textContent ?? '';
    const match = /[♥❤]\s*(\d+)/.exec(text);
    if (match?.[1]) {
      const num = Number(match[1]);
      if (Number.isFinite(num) && num > 0) {
        return Math.trunc(num);
      }
    }
  }
  return 0;
}

function extractRepliesFromDocument(
  doc: Document,
  baseUrl: string,
): V2exRawReply[] {
  const replyCells = doc.querySelectorAll('#Main .box .cell[id^="r_"]');
  const replies: V2exRawReply[] = [];
  const seenIds = new Set<string>();

  for (const cell of replyCells) {
    if (replies.length >= MAX_EXTRACTED_REPLIES) {
      break;
    }
    const rawId = (cell.getAttribute('id') ?? '').replace(/^r_/, '').trim();
    if (!rawId || seenIds.has(rawId)) {
      continue;
    }

    const contentEl = cell.querySelector('.reply_content');
    const content = contentEl ? serializeElementText(contentEl) : '';
    if (!content) {
      continue;
    }

    seenIds.add(rawId);

    const authorLink = cell.querySelector<HTMLAnchorElement>(
      'strong a.dark[href^="/member/"], a[href^="/member/"]',
    );
    const hrefMatch = /^\/member\/([^/?#]+)/.exec(
      (authorLink?.getAttribute('href') ?? '').trim(),
    );
    const authorName =
      authorLink?.textContent?.trim() || hrefMatch?.[1] || '匿名用户';
    const authorId = hrefMatch?.[1] || authorName;

    const avatarImg = cell.querySelector<HTMLImageElement>('img.avatar');
    const avatarUrl =
      normalizeV2exResourceUrl(avatarImg?.getAttribute('src'), baseUrl) ??
      undefined;

    const agoEl = cell.querySelector('.ago');
    const createdAt = parseV2exTimestamp(agoEl?.getAttribute('title'));
    const likeCount = parseThanksCount(cell);

    replies.push({
      id: rawId,
      authorName,
      authorId,
      ...(avatarUrl ? { avatarUrl } : {}),
      content,
      likeCount,
      ...(createdAt !== undefined ? { createdAt } : {}),
    });
  }

  return replies;
}

/**
 * 从 V2EX 主题页 Document 提取结构化原始数据（标题、正文、附言、内嵌图与回复）。
 */
export function extractV2exTopicFromDocument(
  doc: Document,
  pageUrl: string,
): V2exRawTopicData | null {
  const canonicalHref =
    doc
      .querySelector<HTMLLinkElement>('link[rel="canonical"]')
      ?.getAttribute('href') ?? '';
  const topicId =
    extractTopicIdFromUrl(pageUrl) ?? extractTopicIdFromUrl(canonicalHref);
  if (!topicId) {
    return null;
  }

  const mainBox = doc.querySelector('#Main .box');
  const headerEl = mainBox?.querySelector('.header') ?? doc.querySelector('.header');
  const title =
    headerEl?.querySelector('h1')?.textContent?.trim() ??
    doc.querySelector('h1')?.textContent?.trim() ??
    '';
  if (!title) {
    return null;
  }

  const nodeLink = headerEl?.querySelector<HTMLAnchorElement>('a[href^="/go/"]');
  const nodeName = nodeLink?.textContent?.trim() || undefined;
  const nodeSlugMatch = /^\/go\/([^/?#]+)/.exec(
    (nodeLink?.getAttribute('href') ?? '').trim(),
  );
  const nodeSlug = nodeSlugMatch?.[1] || undefined;

  const authorLink =
    headerEl?.querySelector<HTMLAnchorElement>('.gray a[href^="/member/"]') ??
    headerEl?.querySelector<HTMLAnchorElement>('a[href^="/member/"]');
  const authorHrefMatch = /^\/member\/([^/?#]+)/.exec(
    (authorLink?.getAttribute('href') ?? '').trim(),
  );
  const authorName =
    authorLink?.textContent?.trim() || authorHrefMatch?.[1] || '未知作者';
  const authorId = authorHrefMatch?.[1] || authorName;

  const authorAvatarImg =
    headerEl?.querySelector<HTMLImageElement>('.fr img.avatar') ??
    headerEl?.querySelector<HTMLImageElement>('img.avatar');
  const authorAvatarUrl =
    normalizeV2exResourceUrl(authorAvatarImg?.getAttribute('src'), pageUrl) ??
    undefined;

  const headerGray = headerEl?.querySelector('.gray');
  const timeSpan = headerGray?.querySelector('span[title]');
  const publishedAt = parseV2exTimestamp(timeSpan?.getAttribute('title'));

  const headerGrayText = headerGray?.textContent ?? '';
  const clicksMatch = /(\d+)\s*次点击/.exec(headerGrayText);
  const clicks = clicksMatch?.[1] ? Number(clicksMatch[1]) : undefined;

  const bodySections: string[] = [];
  const seenImages = new Set<string>();
  const imageUrls: string[] = [];

  // 主楼正文（排除 .subtle 附言内的 .topic_content）
  const allTopicContents = (mainBox ?? doc).querySelectorAll('.topic_content');
  for (const contentEl of allTopicContents) {
    if (contentEl.closest('.subtle') !== null) {
      continue;
    }
    const text = serializeElementText(contentEl);
    if (text) {
      bodySections.push(text);
    }
    collectImagesFromContainer(contentEl, pageUrl, seenImages, imageUrls);
  }

  // 附言列表（.subtle）
  const subtleBlocks = (mainBox ?? doc).querySelectorAll('.subtle');
  let subtleIndex = 0;
  for (const subtle of subtleBlocks) {
    subtleIndex += 1;
    const fadeHeader =
      subtle.querySelector('.fade')?.textContent?.replace(/\s+/g, ' ').trim() ||
      `第 ${subtleIndex} 条附言`;
    const subtleContent = subtle.querySelector('.topic_content');
    const subtleText = subtleContent
      ? serializeElementText(subtleContent)
      : '';
    if (subtleContent) {
      collectImagesFromContainer(subtleContent, pageUrl, seenImages, imageUrls);
    }
    if (subtleText) {
      bodySections.push(`--- ${fadeHeader} ---\n${subtleText}`);
    }
  }

  const replies = extractRepliesFromDocument(doc, pageUrl);

  let replyCount: number | undefined;
  const boxCells = doc.querySelectorAll('#Main .box .cell .gray');
  for (const cell of boxCells) {
    const match = /(\d+)\s*条回复/.exec(cell.textContent ?? '');
    if (match?.[1]) {
      replyCount = Number(match[1]);
      break;
    }
  }
  if (replyCount === undefined && replies.length > 0) {
    replyCount = replies.length;
  }

  return {
    topicId,
    sourceUrl: `https://www.v2ex.com/t/${topicId}`,
    title,
    description: bodySections.join('\n\n'),
    authorName,
    authorId,
    ...(authorAvatarUrl ? { authorAvatarUrl } : {}),
    ...(nodeName ? { nodeName } : {}),
    ...(nodeSlug ? { nodeSlug } : {}),
    ...(publishedAt !== undefined ? { publishedAt } : {}),
    imageUrls,
    replies,
    ...(replyCount !== undefined && Number.isFinite(replyCount)
      ? { replyCount: Math.trunc(replyCount) }
      : {}),
    ...(clicks !== undefined && Number.isFinite(clicks)
      ? { clicks: Math.trunc(clicks) }
      : {}),
  };
}

/**
 * 解析 V2EX `/my/topics` 收藏列表页的主题 ID 与分页状态。
 */
export function extractFavoriteListFromDocument(
  doc: Document,
  currentPage = 1,
): V2exFavoriteListPage {
  if (isV2exChallengeDocument(doc)) {
    return {
      topicIds: [],
      hasNextPage: false,
      isChallengePage: true,
    };
  }

  const topicIds: string[] = [];
  const seen = new Set<string>();
  const links = doc.querySelectorAll<HTMLAnchorElement>(
    '#Main .cell.item .item_title a[href*="/t/"], #Main .item_title a[href*="/t/"]',
  );

  for (const link of links) {
    const href = link.getAttribute('href') ?? '';
    const id = extractTopicIdFromUrl(href);
    if (id && !seen.has(id)) {
      seen.add(id);
      topicIds.push(id);
    }
  }

  let hasNextPage = false;
  const pageLinks = doc.querySelectorAll<HTMLAnchorElement>(
    '#Main a.page_normal[href*="p="], #Main a[href^="/my/topics?p="]',
  );
  for (const link of pageLinks) {
    const href = link.getAttribute('href') ?? '';
    const match = /[?&]p=(\d+)/.exec(href);
    if (match?.[1]) {
      const pageNum = Number(match[1]);
      if (Number.isFinite(pageNum) && pageNum > currentPage) {
        hasNextPage = true;
        break;
      }
    }
  }

  return {
    topicIds,
    hasNextPage,
    isChallengePage: false,
  };
}
