/**
 * Tier 2 声明式站点规则（SiteRecipe）执行器与适配器编译器。
 *
 * 提供两部分纯 TS 能力（零 `eval`、零 `any`）：
 * 1. `compileRecipeAdapter(recipe)`：将 `SiteRecipe` 编译为标准 `PlatformAdapter`；
 * 2. `installRecipeMainHook(recipe)`：在 Main World 中按规则提取全局变量/内联脚本/DOM 并旁路监听原生收藏。
 */

import type {
  CapturedAssetInput,
  CapturedPayload,
  CaptureTriggerSource,
  DnrHeaderRuleSpec,
  PlatformAdapter,
} from '../../types/adapter.ts';
import type { AuthorInfo, PlatformExtraValue } from '../../types/schema.ts';
import {
  createMainBridge,
  getOriginalFetch,
  installMainHookOnce,
  isRecord,
  observeMainNetwork,
  readNumberProp,
  readStringProp,
  type UnknownRecord,
} from '../shared/main-bridge.ts';
import type {
  RecipeFieldSpec,
  RecipeUrlIdExtractor,
  SiteRecipe,
} from './schema.ts';

function sanitizeHttpUrl(raw: string | undefined): string | undefined {
  if (!raw) {
    return undefined;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  const normalized = trimmed.startsWith('//') ? `https:${trimmed}` : trimmed;
  try {
    const parsed = new URL(normalized);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return parsed.href;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function dedupeUrls(urls: readonly (string | undefined)[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of urls) {
    const safe = sanitizeHttpUrl(raw);
    if (safe && !seen.has(safe)) {
      seen.add(safe);
      out.push(safe);
    }
  }
  return out;
}

function parseQualityScore(quality: unknown): number {
  if (typeof quality === 'number' && Number.isFinite(quality)) {
    return quality;
  }
  if (typeof quality === 'string') {
    const match = /(\d{3,4})/.exec(quality);
    if (match?.[1]) {
      return Number(match[1]);
    }
  }
  if (Array.isArray(quality)) {
    let best = 0;
    for (const entry of quality) {
      const score = parseQualityScore(entry);
      if (score > best) {
        best = score;
      }
    }
    return best;
  }
  return 0;
}

/** 按声明式 URL 规则从页面链接提取内容唯一 ID */
export function extractIdByRecipeUrl(
  url: string,
  extractor: RecipeUrlIdExtractor,
  baseOrigin?: string,
): string | null {
  try {
    const parsed = baseOrigin ? new URL(url, baseOrigin) : new URL(url);
    const validRe = extractor.validRegex
      ? new RegExp(extractor.validRegex)
      : null;

    if (extractor.queryParam) {
      const param = parsed.searchParams.get(extractor.queryParam)?.trim();
      if (param && (!validRe || validRe.test(param))) {
        return param;
      }
    }

    if (extractor.pathRegexes) {
      for (const pattern of extractor.pathRegexes) {
        const match = new RegExp(pattern, 'i').exec(parsed.pathname);
        const candidate = match?.[1]?.trim();
        if (candidate && (!validRe || validRe.test(candidate))) {
          return candidate;
        }
      }
    }
  } catch {
    return null;
  }
  return null;
}

function matchesRecipeHost(url: string, recipe: SiteRecipe): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return false;
    }
    const host = parsed.hostname.toLowerCase();
    for (const target of recipe.matchHosts) {
      const lower = target.toLowerCase();
      if (host === lower) {
        return true;
      }
      if (recipe.matchSubdomains && host.endsWith(`.${lower}`)) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

function readDomFieldValue(
  doc: Document,
  spec: RecipeFieldSpec | undefined,
): string | undefined {
  if (!spec?.selectors) {
    return undefined;
  }
  for (const selector of spec.selectors) {
    const el = doc.querySelector(selector);
    if (!el) {
      continue;
    }
    let val: string | null | undefined;
    if (spec.attribute) {
      val = el.getAttribute(spec.attribute);
    } else if (el instanceof HTMLMetaElement) {
      val = el.content;
    } else if (el instanceof HTMLAnchorElement) {
      val = el.textContent;
    } else if (el instanceof HTMLImageElement) {
      val = el.currentSrc || el.src;
    } else {
      val = el.textContent;
    }
    const trimmed = val?.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return undefined;
}

function escapeRegExpLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractInlineSetterValue(
  scriptsText: string,
  objectName: string,
  methodName: string,
): string | undefined {
  if (!scriptsText) {
    return undefined;
  }
  const regex = new RegExp(
    `${escapeRegExpLiteral(objectName)}\\.${escapeRegExpLiteral(methodName)}\\(\\s*(['"])((?:\\\\.|(?!\\1).)+)\\1\\s*\\)`,
  );
  const match = regex.exec(scriptsText);
  if (!match?.[2]) {
    return undefined;
  }
  return match[2].replace(/\\(['"\\/])/g, '$1').trim() || undefined;
}

function resolveFieldInPage(
  spec: RecipeFieldSpec | undefined,
  globalObj: UnknownRecord | undefined,
  scriptsText: string,
  setterObject: string | undefined,
  doc: Document,
): string | undefined {
  if (!spec) {
    return undefined;
  }
  if (spec.globalKeys) {
    for (const key of spec.globalKeys) {
      const value = readStringProp(globalObj, key);
      if (value) {
        return value;
      }
    }
  }
  if (spec.setterMethods && setterObject) {
    for (const method of spec.setterMethods) {
      const value = extractInlineSetterValue(scriptsText, setterObject, method);
      if (value) {
        return value;
      }
    }
  }
  const domVal = readDomFieldValue(doc, spec);
  if (domVal) {
    return domVal;
  }
  if (spec.stripTitleSuffixRegex && doc.title) {
    const cleaned = doc.title
      .replace(new RegExp(spec.stripTitleSuffixRegex, 'i'), '')
      .trim();
    if (cleaned) {
      return cleaned;
    }
  }
  return undefined;
}

function findGlobalSourceObject(recipe: SiteRecipe): UnknownRecord | undefined {
  const cfg = recipe.globalSource;
  if (!cfg) {
    return undefined;
  }
  const winRecord = window as unknown as UnknownRecord;
  if (cfg.windowVar) {
    const candidate = winRecord[cfg.windowVar];
    if (isRecord(candidate)) {
      return candidate;
    }
  }
  if (cfg.windowKeyRegex) {
    const re = new RegExp(cfg.windowKeyRegex);
    for (const key of Object.keys(winRecord)) {
      if (!re.test(key)) {
        continue;
      }
      const candidate = winRecord[key];
      if (!isRecord(candidate)) {
        continue;
      }
      if (
        cfg.requiredArrayKey &&
        !Array.isArray(candidate[cfg.requiredArrayKey])
      ) {
        continue;
      }
      return candidate;
    }
  }
  return undefined;
}

function collectInlineScriptsText(setterObject: string | undefined): string {
  if (!setterObject) {
    return '';
  }
  const marker = `${setterObject}.`;
  let out = '';
  const scripts = Array.from(document.querySelectorAll('script:not([src])'));
  for (const script of scripts) {
    const text = script.textContent ?? '';
    if (text.includes(marker)) {
      out += `\n${text}`;
    }
  }
  return out;
}

interface ParsedMediaDef {
  url: string;
  format: 'mp4' | 'hls';
  quality: number;
}

function readFirstFromRawRecord(
  raw: UnknownRecord,
  keys: readonly string[] | undefined,
): string | undefined {
  if (!keys) {
    return undefined;
  }
  for (const key of keys) {
    const value = readStringProp(raw, key);
    if (value) {
      return value;
    }
  }
  return undefined;
}

/**
 * 将声明式 `SiteRecipe` 编译为标准 `PlatformAdapter` 实例。
 */
export function compileRecipeAdapter(recipe: SiteRecipe): PlatformAdapter {
  const dnrRules: readonly DnrHeaderRuleSpec[] = recipe.dnrRules ?? [];

  return {
    id: recipe.id,
    tier: 'recipe',
    displayName: recipe.displayName,
    hostPatterns: recipe.hostPatterns,
    ...(recipe.uiMeta ? { uiMeta: recipe.uiMeta } : {}),

    matchesUrl(url: string): boolean {
      return matchesRecipeHost(url, recipe);
    },

    getDnrRules(): readonly DnrHeaderRuleSpec[] {
      return dnrRules;
    },

    normalizeRawData(
      raw: unknown,
      triggerSource: CaptureTriggerSource,
    ): CapturedPayload | null {
      if (!isRecord(raw)) {
        return null;
      }

      const fallbackOriginUrl =
        recipe.defaultReferer ??
        recipe.uiMeta?.entryUrl ??
        `https://${recipe.matchHosts[0] ?? 'example.com'}/`;

      const sourceUrl =
        sanitizeHttpUrl(readStringProp(raw, 'sourceUrl')) ??
        sanitizeHttpUrl(
          readFirstFromRawRecord(raw, recipe.fields.sourceUrl?.globalKeys),
        ) ??
        fallbackOriginUrl;

      const sourceId =
        readStringProp(raw, 'sourceId') ??
        readFirstFromRawRecord(raw, recipe.fields.sourceId?.globalKeys) ??
        extractIdByRecipeUrl(sourceUrl, recipe.idExtractor);

      if (!sourceId) {
        return null;
      }

      const title =
        readStringProp(raw, 'title') ??
        readFirstFromRawRecord(raw, recipe.fields.title.globalKeys) ??
        `${recipe.displayName} ${sourceId}`;

      const description = readStringProp(raw, 'description') ?? '';
      const durationSec =
        readNumberProp(raw, 'durationSec') ??
        (recipe.fields.durationSec?.globalKeys
          ? recipe.fields.durationSec.globalKeys.reduce<number | undefined>(
              (acc, key) => acc ?? readNumberProp(raw, key),
              undefined,
            )
          : undefined);

      const authorName =
        readStringProp(raw, 'authorName') ??
        readFirstFromRawRecord(raw, recipe.fields.authorName?.globalKeys) ??
        recipe.fields.authorFallbackName ??
        `${recipe.displayName} Creator`;
      const authorUrl = sanitizeHttpUrl(readStringProp(raw, 'authorUrl'));

      const author: AuthorInfo = {
        id: readStringProp(raw, 'authorId') ?? authorName,
        name: authorName,
        ...(authorUrl ? { profileUrl: authorUrl } : {}),
      };

      const assets: CapturedAssetInput[] = [];
      const videoMedia = recipe.videoMedia;

      if (videoMedia) {
        const directUrls: string[] = [];
        if (Array.isArray(raw.directUrls)) {
          for (const entry of raw.directUrls) {
            if (typeof entry === 'string') {
              directUrls.push(entry);
            }
          }
        }
        const hlsUrls: string[] = [];
        if (Array.isArray(raw.hlsUrls)) {
          for (const entry of raw.hlsUrls) {
            if (typeof entry === 'string') {
              hlsUrls.push(entry);
            }
          }
        }

        // 支持直接传入原始字段键（方便单元测试或 Main World 直接透传全局对象）
        if (directUrls.length === 0 && videoMedia.directUrlFields) {
          for (const field of videoMedia.directUrlFields) {
            const val = readFirstFromRawRecord(raw, field.globalKeys);
            if (val) {
              directUrls.push(val);
            }
          }
        }
        if (hlsUrls.length === 0 && videoMedia.hlsUrlFields) {
          for (const field of videoMedia.hlsUrlFields) {
            const val = readFirstFromRawRecord(raw, field.globalKeys);
            if (val) {
              hlsUrls.push(val);
            }
          }
        }

        const parsedDefs: ParsedMediaDef[] = [];
        const defCfg = videoMedia.definitionArray;
        if (defCfg) {
          const seenDefUrls = new Set<string>();
          const pushDef = (entry: unknown): void => {
            if (!isRecord(entry)) {
              return;
            }
            const url = sanitizeHttpUrl(readStringProp(entry, defCfg.urlKey));
            if (!url || seenDefUrls.has(url)) {
              return;
            }
            if (defCfg.skipUrlContains && url.includes(defCfg.skipUrlContains)) {
              return;
            }
            const formatRaw = defCfg.formatKey
              ? (readStringProp(entry, defCfg.formatKey) ?? '').toLowerCase()
              : '';
            const isHls = formatRaw === 'hls' || url.includes('.m3u8');
            const quality = defCfg.qualityKey
              ? parseQualityScore(entry[defCfg.qualityKey])
              : 0;
            seenDefUrls.add(url);
            parsedDefs.push({
              url,
              format: isHls ? 'hls' : 'mp4',
              quality,
            });
          };

          if (Array.isArray(raw.resolvedMedia)) {
            for (const entry of raw.resolvedMedia) {
              pushDef(entry);
            }
          }
          const arrayKey = recipe.globalSource?.mediaDefinitionsKey;
          if (arrayKey && Array.isArray(raw[arrayKey])) {
            for (const entry of raw[arrayKey] as unknown[]) {
              pushDef(entry);
            }
          }
        }

        const mp4Defs = parsedDefs
          .filter((d) => d.format === 'mp4')
          .sort((a, b) => b.quality - a.quality);
        const hlsDefs = parsedDefs
          .filter((d) => d.format === 'hls')
          .sort((a, b) => b.quality - a.quality);

        const directCandidates = dedupeUrls([
          ...directUrls,
          ...mp4Defs.map((d) => d.url),
        ]);
        const hlsCandidates = dedupeUrls([
          ...hlsUrls,
          ...hlsDefs.map((d) => d.url),
        ]);

        if (directCandidates.length > 0 && directCandidates[0]) {
          const topHeight = mp4Defs[0]?.quality;
          assets.push({
            id: 'video',
            kind: 'video',
            strategy: 'direct',
            sourceUrl: directCandidates[0],
            ...(directCandidates.length > 1
              ? { fallbackUrls: directCandidates.slice(1, 4) }
              : {}),
            mimeType: 'video/mp4',
            ...(topHeight && topHeight > 0 ? { height: topHeight } : {}),
            ...(durationSec && durationSec > 0
              ? { durationSec: Math.round(durationSec) }
              : {}),
            filenameHint: 'video.mp4',
          });
        } else if (hlsCandidates.length > 0 && hlsCandidates[0]) {
          const topHeight = hlsDefs[0]?.quality;
          assets.push({
            id: 'video',
            kind: 'video',
            strategy: 'hls_mux',
            sourceUrl: hlsCandidates[0],
            ...(hlsCandidates.length > 1
              ? { fallbackUrls: hlsCandidates.slice(1, 4) }
              : {}),
            mimeType: 'video/mp4',
            ...(topHeight && topHeight > 0 ? { height: topHeight } : {}),
            ...(durationSec && durationSec > 0
              ? { durationSec: Math.round(durationSec) }
              : {}),
            filenameHint: 'video.mp4',
          });
        }
      }

      if (assets.length === 0) {
        return null;
      }

      const rawCoverCandidates: (string | undefined)[] = [];
      if (Array.isArray(raw.coverUrls)) {
        for (const entry of raw.coverUrls) {
          if (typeof entry === 'string') {
            rawCoverCandidates.push(entry);
          }
        }
      }
      if (recipe.fields.coverUrls) {
        for (const field of recipe.fields.coverUrls) {
          rawCoverCandidates.push(
            readFirstFromRawRecord(raw, field.globalKeys),
          );
        }
      }
      rawCoverCandidates.push(readStringProp(raw, 'coverUrl'));
      const coverUrls = dedupeUrls(rawCoverCandidates);

      const rawTags = Array.isArray(raw.tags) ? raw.tags : [];
      const tags: string[] = [];
      const seenTags = new Set<string>();
      for (const entry of rawTags) {
        if (typeof entry === 'string') {
          const trimmed = entry.trim();
          if (trimmed && !seenTags.has(trimmed.toLowerCase())) {
            seenTags.add(trimmed.toLowerCase());
            tags.push(trimmed);
          }
        }
      }

      const extraIdKey = recipe.fields.extraIdKey ?? 'sourceId';
      const platformExtra: Record<string, PlatformExtraValue> = {
        [extraIdKey]: sourceId,
        extractorTier: 'recipe',
      };

      const defaultReferer =
        recipe.defaultReferer ??
        (() => {
          try {
            return `${new URL(sourceUrl).origin}/`;
          } catch {
            return undefined;
          }
        })();
      const defaultOrigin =
        recipe.defaultOrigin ??
        (() => {
          try {
            return new URL(sourceUrl).origin;
          } catch {
            return undefined;
          }
        })();

      return {
        platform: recipe.id,
        sourceId,
        sourceUrl,
        kind: recipe.kind,
        title,
        description,
        author,
        hashtags: tags,
        ...(coverUrls[0] ? { coverUrl: coverUrls[0] } : {}),
        ...(coverUrls.length > 1
          ? { coverFallbackUrls: coverUrls.slice(1) }
          : {}),
        assets,
        ...(dnrRules.length === 0 && (defaultReferer || defaultOrigin)
          ? {
              defaultRequestHeaders: {
                ...(defaultReferer ? { referer: defaultReferer } : {}),
                ...(defaultOrigin ? { origin: defaultOrigin } : {}),
              },
            }
          : {}),
        platformExtra,
        triggerSource,
      };
    },
  };
}

/**
 * 在 Main World 中为指定 `SiteRecipe` 安装声明式数据提取与原生收藏旁路监听。
 */
export function installRecipeMainHook(recipe: SiteRecipe): void {
  if (!installMainHookOnce(`__COLLECT_PLUS_RECIPE_HOOK_${recipe.id}__`)) {
    return;
  }

  const bridge = createMainBridge(recipe.id);
  const resolvedMediaCache = new Map<string, unknown[]>();
  const originalFetch = getOriginalFetch();

  const extractCurrentRawData = async (): Promise<UnknownRecord | null> => {
    const globalObj = findGlobalSourceObject(recipe);
    const setterObj = recipe.globalSource?.inlineSetterObject;
    const scriptsText = collectInlineScriptsText(setterObj);

    const sourceUrlFromGlobal = resolveFieldInPage(
      recipe.fields.sourceUrl,
      globalObj,
      scriptsText,
      setterObj,
      document,
    );
    const sourceId =
      resolveFieldInPage(
        recipe.fields.sourceId,
        globalObj,
        scriptsText,
        setterObj,
        document,
      ) ??
      extractIdByRecipeUrl(
        window.location.href,
        recipe.idExtractor,
        window.location.origin,
      ) ??
      (sourceUrlFromGlobal
        ? extractIdByRecipeUrl(
            sourceUrlFromGlobal,
            recipe.idExtractor,
            window.location.origin,
          )
        : null);

    if (!sourceId) {
      return null;
    }

    const title = resolveFieldInPage(
      recipe.fields.title,
      globalObj,
      scriptsText,
      setterObj,
      document,
    );
    const description =
      resolveFieldInPage(
        recipe.fields.description,
        globalObj,
        scriptsText,
        setterObj,
        document,
      ) ?? '';

    const durationRaw = resolveFieldInPage(
      recipe.fields.durationSec,
      globalObj,
      scriptsText,
      setterObj,
      document,
    );
    const durationParsed = durationRaw ? Number(durationRaw) : NaN;
    const durationSec =
      Number.isFinite(durationParsed) && durationParsed > 0
        ? durationParsed
        : undefined;

    const authorName = resolveFieldInPage(
      recipe.fields.authorName,
      globalObj,
      scriptsText,
      setterObj,
      document,
    );
    const authorUrl = resolveFieldInPage(
      recipe.fields.authorUrl,
      globalObj,
      scriptsText,
      setterObj,
      document,
    );

    const coverUrls: string[] = [];
    if (recipe.fields.coverUrls) {
      for (const spec of recipe.fields.coverUrls) {
        const val = resolveFieldInPage(
          spec,
          globalObj,
          scriptsText,
          setterObj,
          document,
        );
        if (val) {
          coverUrls.push(val);
        }
      }
    }

    const directUrls: string[] = [];
    if (recipe.videoMedia?.directUrlFields) {
      for (const spec of recipe.videoMedia.directUrlFields) {
        const val = resolveFieldInPage(
          spec,
          globalObj,
          scriptsText,
          setterObj,
          document,
        );
        if (val) {
          directUrls.push(val);
        }
      }
    }

    const hlsUrls: string[] = [];
    if (recipe.videoMedia?.hlsUrlFields) {
      for (const spec of recipe.videoMedia.hlsUrlFields) {
        const val = resolveFieldInPage(
          spec,
          globalObj,
          scriptsText,
          setterObj,
          document,
        );
        if (val) {
          hlsUrls.push(val);
        }
      }
    }

    // 如规则声明需要展开远端媒体定义数组（如 Pornhub `/video/get_media`）
    const resolvedMedia: unknown[] = [];
    const resolveMarker = recipe.globalSource?.resolveMediaUrlContains;
    const defArrayKey = recipe.globalSource?.mediaDefinitionsKey;
    const defUrlKey = recipe.videoMedia?.definitionArray?.urlKey;
    if (
      resolveMarker &&
      defArrayKey &&
      defUrlKey &&
      globalObj &&
      Array.isArray(globalObj[defArrayKey])
    ) {
      for (const entry of globalObj[defArrayKey] as unknown[]) {
        if (!isRecord(entry)) {
          continue;
        }
        const mediaUrl = readStringProp(entry, defUrlKey);
        if (!mediaUrl || !mediaUrl.includes(resolveMarker)) {
          continue;
        }
        const cached = resolvedMediaCache.get(mediaUrl);
        if (cached) {
          resolvedMedia.push(...cached);
          continue;
        }
        try {
          const res = await originalFetch(mediaUrl, { credentials: 'include' });
          if (res.ok) {
            const json: unknown = await res.json();
            if (Array.isArray(json)) {
              resolvedMediaCache.set(mediaUrl, json);
              resolvedMedia.push(...json);
            }
          }
        } catch {
          // 拉取失败时继续回退内联媒体定义
        }
      }
    }

    const tags: string[] = [];
    if (recipe.fields.tagsSelector) {
      const ignoreSet = new Set(recipe.fields.tagsIgnoreValues ?? []);
      const els = Array.from(
        document.querySelectorAll(recipe.fields.tagsSelector),
      );
      for (const el of els) {
        const text = el.textContent?.trim() ?? '';
        if (text && !ignoreSet.has(text)) {
          tags.push(text);
        }
      }
    }

    if (
      directUrls.length === 0 &&
      hlsUrls.length === 0 &&
      resolvedMedia.length === 0 &&
      !(defArrayKey && globalObj && Array.isArray(globalObj[defArrayKey]))
    ) {
      return null;
    }

    return {
      ...(globalObj ?? {}),
      sourceId,
      sourceUrl: window.location.href,
      ...(title ? { title } : {}),
      description,
      ...(durationSec !== undefined ? { durationSec } : {}),
      ...(authorName ? { authorName } : {}),
      ...(authorUrl ? { authorUrl } : {}),
      coverUrls,
      directUrls,
      hlsUrls,
      resolvedMedia,
      tags,
    };
  };

  // 旁路监听媒体定义展开接口与原生收藏接口
  const resolveMarker = recipe.globalSource?.resolveMediaUrlContains;
  const favSpec = recipe.nativeFavorite;

  if (resolveMarker || favSpec) {
    observeMainNetwork({
      match(url: string): boolean {
        return Boolean(
          (resolveMarker && url.includes(resolveMarker)) ||
            (favSpec && url.includes(favSpec.apiUrlContains)),
        );
      },
      onResponse(event): void {
        if (!event.ok) {
          return;
        }
        if (resolveMarker && event.url.includes(resolveMarker)) {
          void event.readJson().then((json) => {
            if (Array.isArray(json)) {
              resolvedMediaCache.set(event.url, json);
            }
          });
          return;
        }
        if (favSpec && event.url.includes(favSpec.apiUrlContains)) {
          const isRemove = favSpec.removeMarkers.some(
            (marker) =>
              event.url.includes(marker) ||
              Boolean(event.requestBodyText?.includes(marker)),
          );
          const sourceId = extractIdByRecipeUrl(
            window.location.href,
            recipe.idExtractor,
            window.location.origin,
          );
          if (isRemove) {
            if (sourceId) {
              bridge.emitNativeUncollect([sourceId]);
            }
          } else {
            void extractCurrentRawData().then((data) => {
              if (data) {
                const resolvedId =
                  readStringProp(data, 'sourceId') ?? sourceId ?? undefined;
                bridge.emitNativeCollect(data, resolvedId);
              }
            });
          }
        }
      },
    });
  }

  bridge.onContentMessage((message) => {
    if (message.type === 'REQUEST_CURRENT_ITEM') {
      const { requestId, triggerSource } = message;
      void extractCurrentRawData().then((rawData) => {
        bridge.replyCurrentItem(requestId, triggerSource, rawData);
      });
    }
  });

  bridge.notifyReady();
}
