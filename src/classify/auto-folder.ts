/**
 * Collect+ 本地高准确率四级自动分类引擎（零外部接口、零大模型、零第三方依赖）。
 *
 * 严格约束：
 * 1. 仅使用跨平台稳定的标准字段（platform / author / hashtags / title / description 前 150 字），
 *    严禁读取或依赖任何原站收藏夹名称；
 * 2. 防自学习误差滚雪球：仅使用用户手动确认样本（`folderAssignedBy !== 'auto'`），
 *    并严格排除回收站与「不自动同步」条目；
 * 3. 四级漏斗决策：
 *    Tier 1 显式微规则（FolderNode.autoRule，支持英文词边界）
 *    → Tier 2 强特征直连（同作者拉普拉斯平滑高纯度亲和 + 标签精确命中）
 *    → Tier 3 TF-IDF 文件夹原型 + L2 余弦相似度（Intl.Segmenter 原生中文分词 + 路径冷启动）
 *    → Tier 4 双门控置信度 + 树形消歧（父子选深 / 兄弟胶着上浮父目录 / 跨枝兜底未分类）。
 */

import type { CapturedPayload } from '../types/adapter.ts';
import {
  getItemFolderIds,
  isAutoSyncExcluded,
  type CollectionItemRecord,
  type FolderAutoRule,
  type FolderNode,
  type PlatformId,
} from '../types/schema.ts';

/** 自动分类命中的决策层原因 */
export type AutoClassifyReason =
  | 'explicit_rule'
  | 'author_affinity'
  | 'exact_tag'
  | 'tfidf_cosine'
  | 'parent_fallback'
  | 'cold_start_name';

/** 单次自动分类结果 */
export interface AutoClassifyResult {
  /** 命中的文件夹 ID；未达阈值或存在跨分支歧义时返回 null（兜底进入未分类） */
  folderId: string | null;
  /** 归一化参考置信分（0 ~ 1） */
  score: number;
  /** 触发归类的决策层级；兜底未分类时为 null */
  reason: AutoClassifyReason | null;
}

const DESCRIPTION_MAX_CHARS = 150;
const AUTHOR_MIN_SAMPLES = 2;
const AUTHOR_MIN_PURITY = 0.8;
const AUTHOR_MIN_POSTERIOR = 0.72;
const COSINE_MIN_SCORE = 0.24;
const MARGIN_MIN_RATIO = 1.35;
const MARGIN_MIN_DIFF = 0.06;

const SINGLE_CJK_RE = /^[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]$/;
const PURE_DIGITS_RE = /^\d+$/;
const SINGLE_ASCII_RE = /^[a-z]$/;
const ASCII_ALNUM_BOUNDARY_RE = /[a-z0-9]/i;
const ALPHA_DIGITS_RE = /^([a-z]{2,})\d+$/;
const TECH_TOKEN_RE =
  /(?<![a-z0-9])(?:c\+\+|c#|f#|\.net|[a-z0-9]+\.(?:js|ts|py|rs|go|css))(?![a-z0-9])/gi;
const FALLBACK_SEGMENT_RE =
  /[a-z0-9]+|[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]{2,}/gi;

const ANONYMOUS_AUTHOR_IDS: ReadonlySet<string> = new Set([
  '',
  '未知作者',
  '匿名用户',
  'unknown',
  'anonymous',
  'unknown author',
]);

/** 常见跨平台高频社交/泛化水词，避免污染 TF-IDF 向量 */
const STOP_WORDS: ReadonlySet<string> = new Set([
  // 中文社交内容泛词
  '视频',
  '教程',
  '分享',
  '推荐',
  '合集',
  '日常',
  '记录',
  '如何',
  '怎么',
  '什么',
  '为什么',
  '真的',
  '超级',
  '这个',
  '那个',
  '一个',
  '我们',
  '你们',
  '大家',
  '今天',
  '可以',
  '就是',
  '不是',
  '没有',
  '因为',
  '所以',
  '如果',
  '但是',
  '还是',
  '觉得',
  '感觉',
  '其实',
  '应该',
  '非常',
  '特别',
  '一下',
  '一起',
  '看看',
  '必看',
  '干货',
  '科普',
  '测评',
  '收藏',
  '点赞',
  '关注',
  '转发',
  '评论',
  '博主',
  '老师',
  '朋友',
  '自己',
  '他们',
  '这里',
  '那里',
  // 英文泛词
  'the',
  'and',
  'for',
  'with',
  'from',
  'this',
  'that',
  'how',
  'what',
  'why',
  'your',
  'about',
  'into',
  'video',
  'tutorial',
  'guide',
  'tips',
  'share',
  'new',
  'best',
  'top',
  'more',
  'you',
  'are',
  'was',
  'were',
  'have',
  'has',
]);

let cachedSegmenter: Intl.Segmenter | null | undefined;

function getWordSegmenter(): Intl.Segmenter | null {
  if (cachedSegmenter !== undefined) {
    return cachedSegmenter;
  }
  try {
    if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
      cachedSegmenter = new Intl.Segmenter('zh-CN', { granularity: 'word' });
    } else {
      cachedSegmenter = null;
    }
  } catch {
    cachedSegmenter = null;
  }
  return cachedSegmenter;
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeTagToken(raw: string): string {
  return raw.trim().replace(/^#+/, '').trim().toLowerCase();
}

function truncateDescription(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= DESCRIPTION_MAX_CHARS) {
    return trimmed;
  }
  return trimmed.slice(0, DESCRIPTION_MAX_CHARS);
}

/**
 * 边界感知关键词匹配：
 * - 英文/数字起止的关键词强制词边界，防止 `ai` 误中 `email`、`go` 误中 `google`；
 * - 中文/混合关键词做大小写不敏感子串匹配，兼容词典外新词。
 */
export function matchesBoundaryKeyword(
  normalizedHaystack: string,
  rawKeyword: string,
): boolean {
  const kw = rawKeyword.trim().toLowerCase();
  if (!kw || !normalizedHaystack) {
    return false;
  }

  const startsAscii = ASCII_ALNUM_BOUNDARY_RE.test(kw[0] ?? '');
  const endsAscii = ASCII_ALNUM_BOUNDARY_RE.test(kw[kw.length - 1] ?? '');
  if (!startsAscii && !endsAscii) {
    return normalizedHaystack.includes(kw);
  }

  const prefix = startsAscii ? '(?<![a-z0-9])' : '';
  const suffix = endsAscii ? '(?![a-z0-9])' : '';
  const pattern = new RegExp(`${prefix}${escapeRegExp(kw)}${suffix}`, 'i');
  return pattern.test(normalizedHaystack);
}

/**
 * 分类专用 0 KB 中英文分词器：
 * - 优先使用 Chrome/V8 原生 `Intl.Segmenter('zh-CN', { granularity: 'word' })`；
 * - 保留 `c++` / `c#` / `node.js` 等技术词，拆分 `react19` 类版本词前缀；
 * - 过滤中文单字、纯数字、单英文字母与跨平台高频水词。
 */
export function tokenizeForClassification(text: string): string[] {
  if (!text) {
    return [];
  }

  const normalized = text.toLowerCase();
  const tokens: string[] = [];

  // 1. 提取带符号的常见技术词，防止被分词器拆散
  const techMatches = normalized.match(TECH_TOKEN_RE);
  if (techMatches) {
    for (const m of techMatches) {
      if (!STOP_WORDS.has(m)) {
        tokens.push(m);
      }
    }
  }

  const pushCandidate = (rawWord: string): void => {
    const word = rawWord.trim();
    if (
      !word ||
      STOP_WORDS.has(word) ||
      PURE_DIGITS_RE.test(word) ||
      SINGLE_CJK_RE.test(word) ||
      SINGLE_ASCII_RE.test(word)
    ) {
      return;
    }
    tokens.push(word);

    // 兼容版本词（如 react19 -> react, vue3 -> vue, python3 -> python）
    const versionMatch = ALPHA_DIGITS_RE.exec(word);
    if (versionMatch?.[1] && !STOP_WORDS.has(versionMatch[1])) {
      tokens.push(versionMatch[1]);
    }
  };

  const segmenter = getWordSegmenter();
  if (segmenter) {
    for (const part of segmenter.segment(normalized)) {
      if (part.isWordLike) {
        pushCandidate(part.segment);
      }
    }
  } else {
    const fallbackMatches = normalized.match(FALLBACK_SEGMENT_RE);
    if (fallbackMatches) {
      for (const seg of fallbackMatches) {
        pushCandidate(seg);
      }
    }
  }

  return tokens;
}

interface AuthorDistribution {
  totalItems: number;
  folderCounts: Map<string, number>;
}

interface CompiledFolderProfile {
  folder: FolderNode;
  parentId: string | null;
  depth: number;
  normalizedName: string;
  ownNameTokens: string[];
  ancestorNames: string[];
  manualSampleCount: number;
  /** L2 归一化后的 TF-IDF 原型向量 */
  unitVector: Map<string, number>;
  rule?: FolderAutoRule;
}

/** 预编译的本地分类索引（可在批量同步与 SW 内存中复用） */
export interface ClassifierIndex {
  readonly folderCount: number;
  readonly profiles: readonly CompiledFolderProfile[];
  readonly profileById: ReadonlyMap<string, CompiledFolderProfile>;
  readonly foldersByNormalizedName: ReadonlyMap<string, readonly string[]>;
  readonly authorStats: ReadonlyMap<string, AuthorDistribution>;
  readonly idf: ReadonlyMap<string, number>;
}

function addTermWeights(
  target: Map<string, number>,
  tokens: readonly string[],
  weight: number,
): void {
  if (weight <= 0 || tokens.length === 0) {
    return;
  }
  for (const token of tokens) {
    target.set(token, (target.get(token) ?? 0) + weight);
  }
}

function toL2UnitTfIdfVector(
  rawTf: ReadonlyMap<string, number>,
  idfMap: ReadonlyMap<string, number>,
  defaultIdf: number,
): Map<string, number> {
  const weighted = new Map<string, number>();
  let sumSq = 0;

  for (const [term, tf] of rawTf.entries()) {
    if (tf <= 0) {
      continue;
    }
    const idf = idfMap.get(term) ?? defaultIdf;
    // Sublinear TF 抑制单条长标题刷词偏移
    const w = (1 + Math.log(tf)) * idf;
    weighted.set(term, w);
    sumSq += w * w;
  }

  if (sumSq <= 0) {
    return new Map();
  }

  const norm = Math.sqrt(sumSq);
  for (const [term, w] of weighted.entries()) {
    weighted.set(term, w / norm);
  }
  return weighted;
}

function dotProduct(
  a: ReadonlyMap<string, number>,
  b: ReadonlyMap<string, number>,
): number {
  const [smaller, larger] = a.size <= b.size ? [a, b] : [b, a];
  let sum = 0;
  for (const [term, val] of smaller.entries()) {
    const other = larger.get(term);
    if (other !== undefined) {
      sum += val * other;
    }
  }
  return sum;
}

function isAncestorOf(
  ancestorId: string,
  descendantId: string,
  profileById: ReadonlyMap<string, CompiledFolderProfile>,
): boolean {
  let cursor = profileById.get(descendantId)?.parentId ?? null;
  const visited = new Set<string>([descendantId]);
  while (cursor !== null) {
    if (cursor === ancestorId) {
      return true;
    }
    if (visited.has(cursor)) {
      return false;
    }
    visited.add(cursor);
    cursor = profileById.get(cursor)?.parentId ?? null;
  }
  return false;
}

function isSameLineage(
  aId: string,
  bId: string,
  profileById: ReadonlyMap<string, CompiledFolderProfile>,
): boolean {
  return (
    aId === bId ||
    isAncestorOf(aId, bId, profileById) ||
    isAncestorOf(bId, aId, profileById)
  );
}

/** 若候选集合全部位于同一条祖先-子孙链上，返回最深节点；否则返回 null */
function pickDeepestOnSingleChain(
  folderIds: readonly string[],
  profileById: ReadonlyMap<string, CompiledFolderProfile>,
): CompiledFolderProfile | null {
  if (folderIds.length === 0) {
    return null;
  }
  let deepest: CompiledFolderProfile | null = null;
  for (const id of folderIds) {
    const profile = profileById.get(id);
    if (!profile) {
      continue;
    }
    if (!deepest || profile.depth > deepest.depth) {
      deepest = profile;
    }
  }
  if (!deepest) {
    return null;
  }
  for (const id of folderIds) {
    if (id !== deepest.folder.id && !isAncestorOf(id, deepest.folder.id, profileById)) {
      return null;
    }
  }
  return deepest;
}

function buildAuthorKey(platform: PlatformId, authorId: string): string | null {
  const normalized = authorId.trim().toLowerCase();
  if (!normalized || ANONYMOUS_AUTHOR_IDS.has(normalized)) {
    return null;
  }
  return `${platform}:${normalized}`;
}

/**
 * 基于当前文件夹树与历史有效人工样本构建内存分类索引。
 * 仅采纳 `deletedAt == null`、`!isAutoSyncExcluded` 且 `folderAssignedBy !== 'auto'` 的样本。
 */
export function buildClassifierIndex(
  folders: readonly FolderNode[],
  items: readonly CollectionItemRecord[],
): ClassifierIndex {
  const folderMap = new Map<string, FolderNode>();
  for (const folder of folders) {
    folderMap.set(folder.id, folder);
  }

  // 1. 解析文件夹层级深度、祖先路径与归一化名称索引
  const parentById = new Map<string, string | null>();
  const depthById = new Map<string, number>();
  const ancestorNamesById = new Map<string, string[]>();
  const foldersByNormalizedName = new Map<string, string[]>();

  for (const folder of folders) {
    const validParent =
      folder.parentId !== null && folderMap.has(folder.parentId)
        ? folder.parentId
        : null;
    parentById.set(folder.id, validParent);

    const normalizedName = normalizeTagToken(folder.name);
    if (normalizedName) {
      const bucket = foldersByNormalizedName.get(normalizedName);
      if (bucket) {
        bucket.push(folder.id);
      } else {
        foldersByNormalizedName.set(normalizedName, [folder.id]);
      }
    }
  }

  for (const folder of folders) {
    const ancestors: string[] = [];
    const visited = new Set<string>([folder.id]);
    let cursor = parentById.get(folder.id) ?? null;
    while (cursor !== null && !visited.has(cursor)) {
      visited.add(cursor);
      const ancestorNode = folderMap.get(cursor);
      if (!ancestorNode) {
        break;
      }
      ancestors.push(ancestorNode.name);
      cursor = parentById.get(cursor) ?? null;
    }
    depthById.set(folder.id, ancestors.length);
    ancestorNamesById.set(folder.id, ancestors);
  }

  // 2. 初始化每个文件夹的原始词频与手动样本计数
  const rawTfByFolder = new Map<string, Map<string, number>>();
  const manualCountByFolder = new Map<string, number>();

  for (const folder of folders) {
    const tf = new Map<string, number>();
    const ownTokens = tokenizeForClassification(folder.name);
    addTermWeights(tf, ownTokens, 5.0);

    const ancestors = ancestorNamesById.get(folder.id) ?? [];
    for (const ancName of ancestors) {
      addTermWeights(tf, tokenizeForClassification(ancName), 2.5);
    }

    rawTfByFolder.set(folder.id, tf);
    manualCountByFolder.set(folder.id, 0);
  }

  // 3. 汇总有效人工确认样本（防误差滚雪球：跳过自动归类未确认条目）
  const authorStats = new Map<string, AuthorDistribution>();

  for (const item of items) {
    if (item.deletedAt != null || isAutoSyncExcluded(item)) {
      continue;
    }
    if (item.folderAssignedBy === 'auto') {
      continue;
    }

    const validFolderIds = getItemFolderIds(item).filter((fid) =>
      folderMap.has(fid),
    );
    if (validFolderIds.length === 0) {
      continue;
    }

    // 3a. 统计同平台同作者亲和度
    const authorKey = buildAuthorKey(item.platform, item.author.id);
    if (authorKey) {
      let dist = authorStats.get(authorKey);
      if (!dist) {
        dist = { totalItems: 0, folderCounts: new Map() };
        authorStats.set(authorKey, dist);
      }
      dist.totalItems += 1;
      for (const fid of validFolderIds) {
        dist.folderCounts.set(fid, (dist.folderCounts.get(fid) ?? 0) + 1);
      }
    }

    // 3b. 提取内容特征词（严格不读取 platformExtra 原站收藏夹名）
    const share = 1 / validFolderIds.length;
    const tagTokens = tokenizeForClassification(item.tags.join(' '));
    const authorTokens = ANONYMOUS_AUTHOR_IDS.has(
      item.author.name.trim().toLowerCase(),
    )
      ? []
      : tokenizeForClassification(item.author.name);
    const titleTokens = tokenizeForClassification(item.title);
    const descTokens = tokenizeForClassification(
      truncateDescription(item.description),
    );

    for (const fid of validFolderIds) {
      manualCountByFolder.set(fid, (manualCountByFolder.get(fid) ?? 0) + 1);
      const tf = rawTfByFolder.get(fid);
      if (!tf) {
        continue;
      }
      addTermWeights(tf, tagTokens, 3.0 * share);
      addTermWeights(tf, authorTokens, 1.8 * share);
      addTermWeights(tf, titleTokens, 1.8 * share);
      addTermWeights(tf, descTokens, 0.5 * share);
    }
  }

  // 4. 计算跨文件夹平滑 IDF 并构建各文件夹 L2 归一化原型向量
  const docFreq = new Map<string, number>();
  for (const tf of rawTfByFolder.values()) {
    for (const term of tf.keys()) {
      docFreq.set(term, (docFreq.get(term) ?? 0) + 1);
    }
  }

  const folderCount = folders.length;
  const idf = new Map<string, number>();
  for (const [term, df] of docFreq.entries()) {
    idf.set(term, Math.log((folderCount + 1) / (df + 1)) + 1);
  }
  const defaultIdf = Math.log(folderCount + 1) + 1;

  const profiles: CompiledFolderProfile[] = [];
  const profileById = new Map<string, CompiledFolderProfile>();

  for (const folder of folders) {
    const rawTf = rawTfByFolder.get(folder.id) ?? new Map<string, number>();
    const profile: CompiledFolderProfile = {
      folder,
      parentId: parentById.get(folder.id) ?? null,
      depth: depthById.get(folder.id) ?? 0,
      normalizedName: normalizeTagToken(folder.name),
      ownNameTokens: Array.from(new Set(tokenizeForClassification(folder.name))),
      ancestorNames: ancestorNamesById.get(folder.id) ?? [],
      manualSampleCount: manualCountByFolder.get(folder.id) ?? 0,
      unitVector: toL2UnitTfIdfVector(rawTf, idf, defaultIdf),
      ...(folder.autoRule ? { rule: folder.autoRule } : {}),
    };
    profiles.push(profile);
    profileById.set(folder.id, profile);
  }

  return {
    folderCount,
    profiles,
    profileById,
    foldersByNormalizedName,
    authorStats,
    idf,
  };
}

/** Tier 1：评估文件夹显式微规则（`FolderNode.autoRule`） */
function matchExplicitRules(
  payload: CapturedPayload,
  normalizedTags: ReadonlySet<string>,
  haystackLower: string,
  index: ClassifierIndex,
): AutoClassifyResult | null {
  const authorIdLower = payload.author.id.trim().toLowerCase();
  const authorNameLower = payload.author.name.trim().toLowerCase();
  const validAuthorId = !ANONYMOUS_AUTHOR_IDS.has(authorIdLower);
  const validAuthorName = !ANONYMOUS_AUTHOR_IDS.has(authorNameLower);

  const hits: Array<{ folderId: string; specificity: number }> = [];

  for (const profile of index.profiles) {
    const rule = profile.rule;
    if (!rule) {
      continue;
    }

    const hasPlatformCond = Boolean(rule.platforms && rule.platforms.length > 0);
    if (hasPlatformCond && !rule.platforms!.includes(payload.platform)) {
      continue;
    }

    const hasAuthors = Boolean(rule.authors && rule.authors.length > 0);
    const hasTags = Boolean(rule.tags && rule.tags.length > 0);
    const hasKeywords = Boolean(rule.keywords && rule.keywords.length > 0);
    const hasContentCond = hasAuthors || hasTags || hasKeywords;

    if (!hasContentCond) {
      if (hasPlatformCond) {
        hits.push({ folderId: profile.folder.id, specificity: 1 });
      }
      continue;
    }

    let specificity = 0;
    if (hasAuthors) {
      for (const ruleAuthor of rule.authors!) {
        const norm = ruleAuthor.trim().toLowerCase();
        if (!norm) {
          continue;
        }
        if (
          (validAuthorId && authorIdLower === norm) ||
          (validAuthorName && authorNameLower === norm)
        ) {
          specificity = Math.max(specificity, 4);
          break;
        }
      }
    }

    if (hasTags && specificity < 4) {
      for (const ruleTag of rule.tags!) {
        const norm = normalizeTagToken(ruleTag);
        if (norm && normalizedTags.has(norm)) {
          specificity = Math.max(specificity, 3);
          break;
        }
      }
    }

    if (hasKeywords && specificity < 3) {
      for (const kw of rule.keywords!) {
        if (matchesBoundaryKeyword(haystackLower, kw)) {
          specificity = Math.max(specificity, 2);
          break;
        }
      }
    }

    if (specificity > 0) {
      // 同时限定了平台时给予微弱特异度加成
      hits.push({
        folderId: profile.folder.id,
        specificity: specificity + (hasPlatformCond ? 0.5 : 0),
      });
    }
  }

  if (hits.length === 0) {
    return null;
  }

  const allIds = hits.map((h) => h.folderId);
  const singleChainDeepest = pickDeepestOnSingleChain(allIds, index.profileById);
  if (singleChainDeepest) {
    return {
      folderId: singleChainDeepest.folder.id,
      score: 1,
      reason: 'explicit_rule',
    };
  }

  const maxSpec = Math.max(...hits.map((h) => h.specificity));
  const topHits = hits
    .filter((h) => h.specificity === maxSpec)
    .map((h) => h.folderId);
  const topChainDeepest = pickDeepestOnSingleChain(topHits, index.profileById);
  if (topChainDeepest) {
    return {
      folderId: topChainDeepest.folder.id,
      score: 1,
      reason: 'explicit_rule',
    };
  }

  // 多个无关分支在同特异度同时命中规则时，不盲目猜，交给后续统计层消歧
  return null;
}

/** Tier 2a：同平台同作者拉普拉斯平滑高纯度亲和度 */
function matchAuthorAffinity(
  payload: CapturedPayload,
  index: ClassifierIndex,
): AutoClassifyResult | null {
  const authorKey = buildAuthorKey(payload.platform, payload.author.id);
  if (!authorKey) {
    return null;
  }

  const dist = index.authorStats.get(authorKey);
  if (!dist || dist.totalItems < AUTHOR_MIN_SAMPLES) {
    return null;
  }

  const sorted = Array.from(dist.folderCounts.entries()).sort(
    (a, b) => b[1] - a[1],
  );
  const top = sorted[0];
  if (!top) {
    return null;
  }

  const [topId, topCount] = top;
  const purity = topCount / dist.totalItems;
  const posterior = (topCount + 0.5) / (dist.totalItems + 1.0);
  if (purity < AUTHOR_MIN_PURITY || posterior < AUTHOR_MIN_POSTERIOR) {
    return null;
  }

  // 若存在并列最高或高占比的非同支竞争文件夹，放弃短路交由内容打分
  const tiedTopIds = sorted
    .filter(([, count]) => count === topCount)
    .map(([id]) => id);
  if (tiedTopIds.length > 1) {
    const deepest = pickDeepestOnSingleChain(tiedTopIds, index.profileById);
    if (!deepest) {
      return null;
    }
    return {
      folderId: deepest.folder.id,
      score: Number(posterior.toFixed(4)),
      reason: 'author_affinity',
    };
  }

  return {
    folderId: topId,
    score: Number(posterior.toFixed(4)),
    reason: 'author_affinity',
  };
}

/** Tier 2b：标签 / 话题 / 节点名与文件夹名称精确一致 */
function matchExactHashtagFolder(
  normalizedTags: ReadonlySet<string>,
  index: ClassifierIndex,
): AutoClassifyResult | null {
  if (normalizedTags.size === 0) {
    return null;
  }

  const matchedIds = new Set<string>();
  for (const tag of normalizedTags) {
    if (tag.length < 2) {
      continue;
    }
    const ids = index.foldersByNormalizedName.get(tag);
    if (ids) {
      for (const id of ids) {
        matchedIds.add(id);
      }
    }
  }

  if (matchedIds.size === 0) {
    return null;
  }

  const deepest = pickDeepestOnSingleChain(
    Array.from(matchedIds),
    index.profileById,
  );
  if (deepest) {
    return {
      folderId: deepest.folder.id,
      score: 0.92,
      reason: 'exact_tag',
    };
  }

  // 多个不同分支的文件夹同时精确命中标签（如 #前端 #摄影 混搭）时，交给 TF-IDF 综合判断
  return null;
}

interface ScoredCandidate {
  profile: CompiledFolderProfile;
  score: number;
  isColdStart: boolean;
}

function passesMarginGate(
  bestScore: number,
  competitorScore: number,
): boolean {
  if (competitorScore <= 0) {
    return true;
  }
  return (
    bestScore / competitorScore >= MARGIN_MIN_RATIO &&
    bestScore - competitorScore >= MARGIN_MIN_DIFF
  );
}

/**
 * 使用预编译索引对单个采集条目执行本地自动分类。
 * 未达置信门槛或存在跨分支歧义时严格返回 `folderId: null`（兜底未分类）。
 */
export function classifyPayloadWithIndex(
  payload: CapturedPayload,
  index: ClassifierIndex,
): AutoClassifyResult {
  if (index.folderCount === 0) {
    return { folderId: null, score: 0, reason: null };
  }

  const normalizedTags = new Set<string>();
  for (const rawTag of payload.hashtags) {
    const cleaned = normalizeTagToken(rawTag);
    if (cleaned) {
      normalizedTags.add(cleaned);
    }
  }

  const truncatedDesc = truncateDescription(payload.description);
  const tagsLower = payload.hashtags.join(' ').toLowerCase();
  const titleLower = payload.title.toLowerCase();
  const descLower = truncatedDesc.toLowerCase();
  const haystackLower = `${titleLower}\n${tagsLower}\n${descLower}`;

  // Tier 1: 显式微规则（可选，最高优先级）
  const ruleHit = matchExplicitRules(
    payload,
    normalizedTags,
    haystackLower,
    index,
  );
  if (ruleHit) {
    return ruleHit;
  }

  // Tier 2: 强特征直连（同作者高纯度亲和 → 标签精确命中）
  const authorHit = matchAuthorAffinity(payload, index);
  if (authorHit) {
    return authorHit;
  }

  const exactTagHit = matchExactHashtagFolder(normalizedTags, index);
  if (exactTagHit) {
    return exactTagHit;
  }

  // Tier 3: TF-IDF 文件夹原型 + L2 余弦相似度（含路径冷启动）
  const queryRawTf = new Map<string, number>();
  const tagTokens = tokenizeForClassification(payload.hashtags.join(' '));
  const authorTokens = ANONYMOUS_AUTHOR_IDS.has(
    payload.author.name.trim().toLowerCase(),
  )
    ? []
    : tokenizeForClassification(payload.author.name);
  const titleTokens = tokenizeForClassification(payload.title);
  const descTokens = tokenizeForClassification(truncatedDesc);

  addTermWeights(queryRawTf, tagTokens, 3.0);
  addTermWeights(queryRawTf, authorTokens, 1.5);
  addTermWeights(queryRawTf, titleTokens, 2.0);
  addTermWeights(queryRawTf, descTokens, 0.5);

  const payloadTokenSet = new Set<string>(queryRawTf.keys());
  const defaultIdf = Math.log(index.folderCount + 1) + 1;
  const queryUnit = toL2UnitTfIdfVector(queryRawTf, index.idf, defaultIdf);

  const ranked: ScoredCandidate[] = [];

  for (const profile of index.profiles) {
    const cosine =
      queryUnit.size > 0 && profile.unitVector.size > 0
        ? dotProduct(queryUnit, profile.unitVector)
        : 0;

    const nameEligible = profile.normalizedName.length >= 2;
    const exactInTags =
      nameEligible && matchesBoundaryKeyword(tagsLower, profile.normalizedName);
    const exactInTitle =
      nameEligible &&
      matchesBoundaryKeyword(titleLower, profile.normalizedName);
    const exactInDesc =
      nameEligible && matchesBoundaryKeyword(descLower, profile.normalizedName);
    const hasExactNameHit = exactInTags || exactInTitle || exactInDesc;

    if (profile.manualSampleCount === 0) {
      // 冷启动空文件夹防误伤：必须完整命中文件夹名称或覆盖文件夹全部核心词
      const fullNameTokensCovered =
        profile.ownNameTokens.length > 0 &&
        profile.ownNameTokens.every((t) => payloadTokenSet.has(t));

      if (!hasExactNameHit && !fullNameTokensCovered) {
        continue;
      }

      let coldScore = cosine;
      if (exactInTags) {
        coldScore = Math.max(coldScore, 0.56);
      } else if (exactInTitle) {
        coldScore = Math.max(coldScore, 0.46);
      } else if (fullNameTokensCovered) {
        coldScore = Math.max(coldScore, 0.36);
      } else if (exactInDesc) {
        coldScore = Math.max(coldScore, 0.28);
      }

      // 祖先目录同时命中时提供轻度层级上下文加权
      const ancestorHit = profile.ancestorNames.some(
        (anc) =>
          anc.trim().length >= 2 &&
          (matchesBoundaryKeyword(tagsLower, anc) ||
            matchesBoundaryKeyword(titleLower, anc)),
      );
      if (ancestorHit) {
        coldScore = Math.min(0.85, coldScore + 0.08);
      }

      ranked.push({
        profile,
        score: coldScore,
        isColdStart: true,
      });
      continue;
    }

    let finalScore = cosine;
    if (exactInTags) {
      finalScore = Math.min(1, finalScore + 0.18);
    } else if (exactInTitle) {
      finalScore = Math.min(1, finalScore + 0.12);
    } else if (exactInDesc) {
      finalScore = Math.min(1, finalScore + 0.04);
    }

    if (finalScore > 0) {
      ranked.push({
        profile,
        score: finalScore,
        isColdStart: false,
      });
    }
  }

  if (ranked.length === 0) {
    return { folderId: null, score: 0, reason: null };
  }

  ranked.sort((a, b) => b.score - a.score || b.profile.depth - a.profile.depth);

  // Tier 4: 双门控置信度校验 + 树形消歧
  const top = ranked[0]!;
  if (top.score < COSINE_MIN_SCORE) {
    return {
      folderId: null,
      score: Number(top.score.toFixed(4)),
      reason: null,
    };
  }

  const second = ranked[1];
  if (!second || passesMarginGate(top.score, second.score)) {
    // 若存在同链且已过阈值的更深子文件夹（紧咬父目录分数），优先更具体子目录
    const strongDescendants = ranked.filter(
      (cand) =>
        cand.profile.folder.id !== top.profile.folder.id &&
        cand.score >= COSINE_MIN_SCORE &&
        cand.score >= top.score * 0.82 &&
        isAncestorOf(
          top.profile.folder.id,
          cand.profile.folder.id,
          index.profileById,
        ),
    );
    if (strongDescendants.length > 0) {
      const deepestChild = pickDeepestOnSingleChain(
        strongDescendants.map((c) => c.profile.folder.id),
        index.profileById,
      );
      if (deepestChild) {
        const chosen = strongDescendants.find(
          (c) => c.profile.folder.id === deepestChild.folder.id,
        )!;
        return {
          folderId: chosen.profile.folder.id,
          score: Number(chosen.score.toFixed(4)),
          reason: chosen.isColdStart ? 'cold_start_name' : 'tfidf_cosine',
        };
      }
    }

    return {
      folderId: top.profile.folder.id,
      score: Number(top.score.toFixed(4)),
      reason: top.isColdStart ? 'cold_start_name' : 'tfidf_cosine',
    };
  }

  // 分数胶着情形 A：父子同链竞争 -> 选更深子目录（前提是相对链外竞争者拉开差距）
  if (
    isSameLineage(
      top.profile.folder.id,
      second.profile.folder.id,
      index.profileById,
    )
  ) {
    const deeper =
      top.profile.depth >= second.profile.depth ? top : second;
    if (deeper.score >= COSINE_MIN_SCORE) {
      const bestOutside = ranked.find(
        (cand) =>
          !isSameLineage(
            deeper.profile.folder.id,
            cand.profile.folder.id,
            index.profileById,
          ),
      );
      if (!bestOutside || passesMarginGate(deeper.score, bestOutside.score)) {
        return {
          folderId: deeper.profile.folder.id,
          score: Number(deeper.score.toFixed(4)),
          reason: deeper.isColdStart ? 'cold_start_name' : 'tfidf_cosine',
        };
      }
    }
    return {
      folderId: null,
      score: Number(top.score.toFixed(4)),
      reason: null,
    };
  }

  // 分数胶着情形 B：同父兄弟子目录胶着 -> 若相对该父子树之外拉开差距，则上浮归入共同父目录
  if (
    top.profile.parentId !== null &&
    top.profile.parentId === second.profile.parentId &&
    index.profileById.has(top.profile.parentId)
  ) {
    const sharedParentId = top.profile.parentId;
    const bestOutside = ranked.find(
      (cand) =>
        cand.profile.folder.id !== sharedParentId &&
        !isAncestorOf(
          sharedParentId,
          cand.profile.folder.id,
          index.profileById,
        ),
    );
    if (!bestOutside || passesMarginGate(top.score, bestOutside.score)) {
      return {
        folderId: sharedParentId,
        score: Number(((top.score + second.score) / 2).toFixed(4)),
        reason: 'parent_fallback',
      };
    }
  }

  // 分数胶着情形 C：跨分支语义歧义 -> 宁缺毋滥，兜底进入未分类
  return {
    folderId: null,
    score: Number(top.score.toFixed(4)),
    reason: null,
  };
}

/** 便捷入口：一次性构建索引并执行自动分类 */
export function classifyPayloadToFolder(
  payload: CapturedPayload,
  folders: readonly FolderNode[],
  items: readonly CollectionItemRecord[],
): AutoClassifyResult {
  const index = buildClassifierIndex(folders, items);
  return classifyPayloadWithIndex(payload, index);
}
