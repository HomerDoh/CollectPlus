/**
 * Tier 2 声明式站点规则（SiteRecipe）纯数据契约定义。
 *
 * 设计红线：
 * - 全部规则为可序列化的纯数据声明（严禁 `eval` / `new Function` / 任意可执行脚本），天然兼容 MV3 CSP；
 * - 适用于具有清晰全局变量、内联脚本赋值或标准 DOM/Meta 结构的中轻度视频/图文站点；
 * - 遇到强反爬签名、React Fiber 遍历或全量账号同步的头部站点，应直接归入 Tier 3 Deep Adapter。
 */

import type { DnrHeaderRuleSpec, SiteUiMeta } from '../../types/adapter.ts';
import type { MediaKind, PlatformId } from '../../types/schema.ts';

/** 声明式从 URL 提取唯一内容 ID 的规则 */
export interface RecipeUrlIdExtractor {
  /** 从 query string 读取（如 Pornhub 的 `viewkey`） */
  readonly queryParam?: string;
  /** 从 pathname 匹配首个捕获组（按序尝试） */
  readonly pathRegexes?: readonly string[];
  /** 提取结果需满足的合法性校验正则 */
  readonly validRegex?: string;
}

/** 从全局变量或内联 `<script>` 读取播放器原始数据的声明 */
export interface RecipeGlobalSourceSpec {
  /** 固定 `window.<name>` 属性名（如 `html5player`） */
  readonly windowVar?: string;
  /** 按正则扫描 `window` 顶层键（如 `^flashvars_\\d+$`），要求命中对象包含 `requiredArrayKey` */
  readonly windowKeyRegex?: string;
  /** 配合 `windowKeyRegex` 校验对象内须存在的数组属性名（如 `mediaDefinitions`） */
  readonly requiredArrayKey?: string;
  /** 内联脚本方法调用前缀（如 `html5player` 匹配 `html5player.setVideoUrlHigh('...')`） */
  readonly inlineSetterObject?: string;
  /** 若某个媒体定义数组的 URL 包含此子串，需同源 fetch JSON 数组展开（如 `/video/get_media`） */
  readonly resolveMediaUrlContains?: string;
  /** 媒体定义数组属性名（如 `mediaDefinitions`） */
  readonly mediaDefinitionsKey?: string;
}

/** 单个字段的提取来源（按数组顺序回退） */
export interface RecipeFieldSpec {
  /** 全局对象属性名候选（按序尝试） */
  readonly globalKeys?: readonly string[];
  /** 内联脚本 setter 方法名候选（配合 `inlineSetterObject` 使用） */
  readonly setterMethods?: readonly string[];
  /** CSS 选择器（读取 `content` / `textContent` / `src` / `href`） */
  readonly selectors?: readonly string[];
  /** 指定读取 DOM 属性名（缺省自动根据 `<meta>`/`<a>`/`<img>` 选择） */
  readonly attribute?: string;
  /** 兜底清洗 `document.title` 时要剥离的后缀正则 */
  readonly stripTitleSuffixRegex?: string;
}

/** 媒体流数组与直链/HLS 字段提取声明 */
export interface RecipeVideoMediaSpec {
  /** 明确标注高/低清直链 MP4 的字段来源（如 XVideos `url_high`/`url_low`） */
  readonly directUrlFields?: readonly RecipeFieldSpec[];
  /** 明确标注 HLS `.m3u8` 流的字段来源 */
  readonly hlsUrlFields?: readonly RecipeFieldSpec[];
  /** 结构化媒体定义数组中单个条目的字段映射（如 Pornhub `mediaDefinitions`） */
  readonly definitionArray?: {
    readonly urlKey: string;
    readonly formatKey?: string;
    readonly qualityKey?: string;
    readonly skipUrlContains?: string;
  };
}

/** 站点原生收藏 / 取消收藏接口旁路匹配规则 */
export interface RecipeNativeFavoriteSpec {
  /** 请求 URL 必须包含的子串（如 `/video/favourite`、`/video-favorites/`） */
  readonly apiUrlContains: string;
  /** URL 或请求体包含任一子串时判定为「取消收藏」 */
  readonly removeMarkers: readonly string[];
}

/** 完整的声明式站点规则 */
export interface SiteRecipe {
  /** 平台唯一安全 slug（需满足 `isPlatformId`） */
  readonly id: PlatformId;
  /** 展示名称 */
  readonly displayName: string;
  /** WXT/Manifest 主机匹配模式 */
  readonly hostPatterns: readonly string[];
  /** 允许精确匹配的主机名（支持子域名后缀，设置 `matchSubdomains: true`） */
  readonly matchHosts: readonly string[];
  readonly matchSubdomains?: boolean;
  /** 内容默认媒体形态 */
  readonly kind: MediaKind;
  /** 可选 UI 展示元数据 */
  readonly uiMeta?: SiteUiMeta;
  /** 可选静态防盗链 DNR 规则（未配置时自动走任务级动态 Referer DNR） */
  readonly dnrRules?: readonly DnrHeaderRuleSpec[];
  /** 默认来源 Referer / Origin（写入资产 `requestHeaders` 或回退当前页 origin） */
  readonly defaultReferer?: string;
  readonly defaultOrigin?: string;
  /** 唯一内容 ID 提取规则 */
  readonly idExtractor: RecipeUrlIdExtractor;
  /** 全局对象 / 内联脚本数据源声明（非空时需要运行于 Main World） */
  readonly globalSource?: RecipeGlobalSourceSpec;
  /** 字段提取配置 */
  readonly fields: {
    readonly sourceId?: RecipeFieldSpec;
    readonly sourceUrl?: RecipeFieldSpec;
    readonly title: RecipeFieldSpec;
    readonly description?: RecipeFieldSpec;
    readonly durationSec?: RecipeFieldSpec;
    readonly authorName?: RecipeFieldSpec;
    readonly authorUrl?: RecipeFieldSpec;
    readonly authorFallbackName?: string;
    readonly coverUrls?: readonly RecipeFieldSpec[];
    readonly tagsSelector?: string;
    readonly tagsIgnoreValues?: readonly string[];
    /** 写入 `platformExtra` 时使用的主键名（默认 `sourceId`） */
    readonly extraIdKey?: string;
  };
  /** 视频类媒体流提取配置 */
  readonly videoMedia?: RecipeVideoMediaSpec;
  /** 可选原生收藏/取消收藏旁路监听配置 */
  readonly nativeFavorite?: RecipeNativeFavoriteSpec;
}
