/**
 * 基于 MiniSearch 的本地全文检索引擎（支持中英文混合分词）。
 *
 * - 英文/数字连续串转小写作为整词，支持前缀与轻度模糊匹配；
 * - 连续 CJK 汉字串切分为单字 + 相邻双字（2-gram），保障中文任意子串高召回命中。
 */

import MiniSearch from 'minisearch';
import type { CollectionItemRecord } from '../types/schema.ts';

interface SearchDocument {
  id: string;
  title: string;
  tagsText: string;
  authorName: string;
  note: string;
  description: string;
}

const INDEX_FIELDS: Array<Exclude<keyof SearchDocument, 'id'>> = [
  'title',
  'tagsText',
  'authorName',
  'note',
  'description',
];

const FIELD_BOOSTS: Record<Exclude<keyof SearchDocument, 'id'>, number> = {
  title: 3,
  tagsText: 2.5,
  authorName: 2,
  note: 2,
  description: 1,
};

/** 匹配英文/数字连续词段或连续 CJK 汉字段 */
const TOKEN_SEGMENT_RE =
  /[a-z0-9]+|[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/gi;

const ASCII_ALNUM_RE = /^[a-z0-9]+$/;

/**
 * 中英文混合分词器：
 * - 英文/数字连续串转小写输出整词；
 * - 连续 CJK 汉字串同时输出每个单字与相邻双字（2-gram）。
 */
export function tokenizeText(text: string): string[] {
  if (!text) {
    return [];
  }

  const normalized = text.toLowerCase();
  const tokens: string[] = [];
  const matches = normalized.match(TOKEN_SEGMENT_RE);
  if (!matches) {
    return tokens;
  }

  for (const segment of matches) {
    if (ASCII_ALNUM_RE.test(segment)) {
      tokens.push(segment);
      continue;
    }

    const chars = Array.from(segment);
    for (let i = 0; i < chars.length; i += 1) {
      const ch = chars[i];
      if (!ch) {
        continue;
      }
      tokens.push(ch);
      const next = chars[i + 1];
      if (next) {
        tokens.push(ch + next);
      }
    }
  }

  return tokens;
}

function toSearchDocument(item: CollectionItemRecord): SearchDocument {
  return {
    id: item.id,
    title: item.title,
    tagsText: item.tags.join(' '),
    authorName: item.author.name,
    note: item.note,
    description: item.description,
  };
}

function createMiniSearchInstance(): MiniSearch<SearchDocument> {
  return new MiniSearch<SearchDocument>({
    idField: 'id',
    fields: INDEX_FIELDS,
    tokenize: tokenizeText,
    processTerm: (term) => (term.length > 0 ? term : null),
    searchOptions: {
      boost: FIELD_BOOSTS,
      prefix: (term) => ASCII_ALNUM_RE.test(term),
      fuzzy: (term) =>
        ASCII_ALNUM_RE.test(term) && term.length >= 4 ? 0.2 : false,
    },
  });
}

/** 收藏条目内存全文检索引擎 */
export class CollectionSearchEngine {
  private miniSearch: MiniSearch<SearchDocument>;
  private indexedIds = new Set<string>();

  constructor() {
    this.miniSearch = createMiniSearchInstance();
  }

  /** 全量重建检索索引 */
  rebuild(items: CollectionItemRecord[]): void {
    this.miniSearch = createMiniSearchInstance();
    this.indexedIds.clear();

    if (items.length === 0) {
      return;
    }

    const docs: SearchDocument[] = [];
    for (const item of items) {
      if (this.indexedIds.has(item.id)) {
        continue;
      }
      this.indexedIds.add(item.id);
      docs.push(toSearchDocument(item));
    }

    this.miniSearch.addAll(docs);
  }

  /** 增量插入或更新单个条目的索引 */
  upsert(item: CollectionItemRecord): void {
    const doc = toSearchDocument(item);
    if (this.indexedIds.has(item.id)) {
      this.miniSearch.replace(doc);
    } else {
      this.miniSearch.add(doc);
      this.indexedIds.add(item.id);
    }
  }

  /** 从索引中移除指定条目（不存在时安全忽略） */
  remove(id: string): void {
    if (!this.indexedIds.has(id)) {
      return;
    }
    this.miniSearch.discard(id);
    this.indexedIds.delete(id);
  }

  /** 执行全文检索，返回按相关度降序排列的条目 ID 列表 */
  search(query: string): string[] {
    const trimmed = query.trim();
    if (!trimmed) {
      return [];
    }

    const results = this.miniSearch.search(trimmed, {
      boost: FIELD_BOOSTS,
      prefix: (term) => ASCII_ALNUM_RE.test(term),
      fuzzy: (term) =>
        ASCII_ALNUM_RE.test(term) && term.length >= 4 ? 0.2 : false,
    });

    return results.map((result) => String(result.id));
  }
}
