/**
 * Collect+ 核心元数据 Schema 与本地存储数据结构定义。
 *
 * 铁律：所有写入本地 CollectVault（meta.json / taxonomy.json / .collect-vault.json）的
 * 元数据必须仅包含相对路径，禁止包含绝对路径或 Base64 缩略图数据。
 */

import type { VaultProviderId } from './storage-provider.ts';

/** 当前元数据 Schema 版本号 */
export const SCHEMA_VERSION = 1 as const;

/** 内置内容平台标识列表（包含通用网页 `'web'`） */
export const BUILTIN_PLATFORM_IDS = [
  'douyin',
  'bilibili',
  'v2ex',
  'zhihu',
  'youtube',
  'xiaohongshu',
  'twitter',
  'instagram',
  'xvideos',
  'pornhub',
  'web',
] as const;

/** @deprecated 请优先使用 `BUILTIN_PLATFORM_IDS`；保留以兼容外部引用 */
export const PLATFORM_IDS = BUILTIN_PLATFORM_IDS;

/** 内置内容平台 ID 联合类型 */
export type BuiltinPlatformId = (typeof BUILTIN_PLATFORM_IDS)[number];

/**
 * 开放站点平台标识（内置短 ID、通用网页 `'web'` 或自定义 Recipe slug）。
 * 必须满足安全目录命名约束 `^[a-z0-9][a-z0-9_-]{0,31}$`，严禁路径穿越或非法字符。
 */
export type PlatformId = string;

const SAFE_PLATFORM_ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const WINDOWS_RESERVED_PLATFORM_RE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

/** 运行时校验是否为合法且文件系统安全的 PlatformId */
export function isPlatformId(value: unknown): value is PlatformId {
  return (
    typeof value === 'string' &&
    SAFE_PLATFORM_ID_RE.test(value) &&
    !WINDOWS_RESERVED_PLATFORM_RE.test(value)
  );
}

/** 媒体资源下载时所需的非敏感防盗链请求头（严禁承载 Cookie/Authorization 等凭证） */
export interface AssetRequestHeaders {
  referer?: string;
  origin?: string;
}

function sanitizeHttpHeaderUrl(raw: unknown): string | undefined {
  if (typeof raw !== 'string') {
    return undefined;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return parsed.href;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/** 运行时清洗非敏感防盗链请求头（仅放行合法 http/https 的 referer 与 origin） */
export function sanitizeAssetRequestHeaders(
  raw: unknown,
): AssetRequestHeaders | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  const rec = raw as Record<string, unknown>;
  const referer = sanitizeHttpHeaderUrl(rec.referer);
  const rawOrigin = sanitizeHttpHeaderUrl(rec.origin);
  let origin: string | undefined;
  if (rawOrigin) {
    try {
      origin = new URL(rawOrigin).origin;
    } catch {
      origin = undefined;
    }
  }
  if (!referer && !origin) {
    return undefined;
  }
  return {
    ...(referer ? { referer } : {}),
    ...(origin ? { origin } : {}),
  };
}

/** 不自动同步（忽略自动采集）的原因枚举 */
export const AUTO_SYNC_EXCLUSION_REASONS = [
  'deleted_keep_remote',
  'sync_cancelled_by_user',
  'support_author',
  'watch_later',
  'skip_local_save',
] as const;

/** 不自动同步原因类型 */
export type AutoSyncExclusionReason =
  (typeof AUTO_SYNC_EXCLUSION_REASONS)[number];

/** 运行时校验是否为合法的 AutoSyncExclusionReason */
export function isAutoSyncExclusionReason(
  value: unknown,
): value is AutoSyncExclusionReason {
  return (
    typeof value === 'string' &&
    (AUTO_SYNC_EXCLUSION_REASONS as readonly string[]).includes(value)
  );
}

/** 条目被排除自动同步的轻量元数据记录（随 meta.json 落盘，支持重建索引与目录迁移） */
export interface AutoSyncExclusion {
  /** 不自动同步的原因分类 */
  reason: AutoSyncExclusionReason;
  /** 可选补充说明（如取消原站收藏失败时的具体原因） */
  detail?: string;
  /** 标记为不自动同步的时间戳（毫秒） */
  excludedAt: number;
}

/** 收藏条目的媒体形态分类 */
export type MediaKind = 'video' | 'gallery' | 'image' | 'article';

/** 媒体资源下载与混流策略 */
export type DownloadStrategy = 'direct' | 'dash_mux' | 'hls_mux';

/** 单个媒体资产的角色类型 */
export type AssetKind = 'cover' | 'video' | 'audio' | 'image';

/** 条目在本地存储链路中的同步状态 */
export type SyncStatus =
  | 'pending_download'
  | 'opfs_staged'
  | 'vault_synced'
  | 'meta_dirty'
  | 'failed';

/** 下载任务生命周期状态 */
export type DownloadTaskStatus =
  | 'queued'
  | 'downloading'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'cancelled';

/** 条目下单个可下载媒体文件描述 */
export interface MediaAsset {
  /** 资产在条目内的唯一标识，例如 'cover'、'video'、'img-01' */
  id: string;
  /** 资产类型 */
  kind: AssetKind;
  /** 下载策略（直链下载或音视频流无损混流） */
  strategy: DownloadStrategy;
  /** 主源地址 */
  sourceUrl: string;
  /** 备用源地址列表（主地址失效或限流时按序回退） */
  fallbackUrls?: string[];
  /** 预留 DASH 音视频分离流混流时的音频轨道地址 */
  audioUrl?: string;
  /** DASH 音视频分离流混流时的备用音频轨道地址列表 */
  audioFallbackUrls?: string[];
  /** 相对条目目录的路径，例如 'cover.jpg'、'video.mp4'、'media/01.jpg' */
  relativePath: string;
  /** 媒体 MIME 类型 */
  mimeType: string;
  /** 文件体积（字节） */
  sizeBytes?: number;
  /** 像素宽度 */
  width?: number;
  /** 像素高度 */
  height?: number;
  /** 音视频时长（秒） */
  durationSec?: number;
  /** 下载该资产时需动态注入的非敏感防盗链头（Referer / Origin） */
  requestHeaders?: AssetRequestHeaders;
  /** 是否已完成本地落盘（OPFS 或 Vault） */
  downloaded: boolean;
}

/** 原内容作者信息 */
export interface AuthorInfo {
  /** 平台侧作者唯一 ID */
  id: string;
  /** 作者昵称 */
  name: string;
  /** 作者账号句柄（如 @handle 或抖音号） */
  handle?: string;
  /** 作者头像远程 URL */
  avatarUrl?: string;
  /** 作者主页 URL */
  profileUrl?: string;
}

/** 平台扩展字段允许的 JSON 原始值类型 */
export type PlatformExtraValue = string | number | boolean | null;

/** 单条离线保存的评论记录（写入条目目录下的 comments.json） */
export interface SavedComment {
  /** 平台侧评论唯一 ID（如抖音 cid） */
  id: string;
  /** 评论者平台 ID（仅非敏感 uid/sec_uid，可选） */
  authorId?: string;
  /** 评论者昵称 */
  authorName: string;
  /** 评论者离线头像相对条目目录路径（如 'comments/avatars/001.jpg'） */
  avatarRelativePath?: string;
  /** 评论正文内容 */
  content: string;
  /** 评论点赞数 */
  likeCount: number;
  /** 评论发布时间戳（毫秒，可选） */
  createdAt?: number;
}

/** 落盘到 `{item.relativeDir}/comments.json` 的离线评论快照文件结构 */
export interface ItemCommentsFile {
  /** Schema 版本号 */
  schemaVersion: typeof SCHEMA_VERSION;
  /** 来源平台 */
  platform: PlatformId;
  /** 平台侧内容唯一 ID */
  sourceId: string;
  /** 评论采集时间戳（毫秒） */
  capturedAt: number;
  /** 本次最多保存的评论上限（如 100） */
  limit: number;
  /** 离线保存的评论列表 */
  comments: SavedComment[];
}

/**
 * 落盘到 `CollectVault/items/.../meta.json` 的标准收藏条目元数据。
 * 所有路径字段均为相对路径，不包含 Base64 缩略图。
 */
export interface CollectionItemMeta {
  /** Schema 版本号 */
  schemaVersion: typeof SCHEMA_VERSION;
  /** 全局唯一条目 ID（ULID） */
  id: string;
  /** 跨平台去重键，格式为 `${platform}:${sourceId}` */
  dedupeKey: string;
  /** 来源平台 */
  platform: PlatformId;
  /** 平台侧内容唯一 ID（如抖音 aweme_id） */
  sourceId: string;
  /** 原内容访问链接 */
  sourceUrl: string;
  /** 条目媒体类型 */
  kind: MediaKind;
  /** 标题 */
  title: string;
  /** 正文描述 */
  description: string;
  /** 作者信息 */
  author: AuthorInfo;
  /** 原内容发布时间戳（毫秒） */
  publishedAt?: number;
  /** 收藏时间戳（毫秒） */
  collectedAt: number;
  /** 最后更新时间戳（毫秒） */
  updatedAt: number;
  /** 主所属文件夹 ID（兼容字段，始终同步为 `folderIds[0] ?? null`） */
  folderId: string | null;
  /** 所属分类文件夹 ID 列表（去重；空数组表示未分类，支持单条目同时归属多个文件夹） */
  folderIds: string[];
  /** 文件夹归属来源：'manual' 为用户前置指定或管理台手动整理，'auto' 为本地分类器自动归类（防自学习误差漂移） */
  folderAssignedBy?: FolderAssignedBy;
  /** 标签名称列表 */
  tags: string[];
  /** 用户备注 */
  note: string;
  /** 相对 `CollectVault/` 根目录的条目目录路径 */
  relativeDir: string;
  /** 封面相对条目目录路径（如 'cover.jpg'） */
  coverRelativePath?: string;
  /** 离线评论快照相对条目目录路径（如 'comments.json'） */
  commentsRelativePath?: string;
  /** 已离线保存的评论条数 */
  savedCommentCount?: number;
  /** 评论快照与离线评论头像总字节数（独立记录，避免与主媒体资产大小相互覆盖） */
  commentsSizeBytes?: number;
  /** 条目关联的全部媒体资产 */
  assets: MediaAsset[];
  /** 当前同步状态 */
  syncStatus: SyncStatus;
  /** 条目媒体文件总字节数 */
  totalSizeBytes: number;
  /** 在管理台首次打开查看的时间戳（毫秒），null 或 undefined 表示尚未在后台打开过 */
  openedAt?: number | null;
  /** 软删除时间戳（毫秒），null 或 undefined 表示未删除 */
  deletedAt?: number | null;
  /** 不自动同步标记：非空表示网页账号仍可能收藏，但插件不再自动同步，仅保留轻量元数据 */
  autoSyncExclusion?: AutoSyncExclusion | null;
  /** 平台特有的轻量结构化扩展字段 */
  platformExtra?: Record<string, PlatformExtraValue>;
}

/** 判断条目是否处于「不自动同步」特殊分类 */
export function isAutoSyncExcluded(
  item: Pick<CollectionItemMeta, 'autoSyncExclusion'>,
): boolean {
  return item.autoSyncExclusion != null;
}

const NSFW_HOSTS = ['xvideos.com', 'pornhub.com'];

/** 判断条目是否属于 NSFW 内容（来源域名含子域名，或带 NSFW 标签，不区分大小写） */
export function isNsfwItem(
  item: Pick<CollectionItemMeta, 'sourceUrl' | 'tags'>,
): boolean {
  if (item.tags.some((tag) => tag.trim().toLowerCase() === 'nsfw')) {
    return true;
  }
  let host: string;
  try {
    host = new URL(item.sourceUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  return NSFW_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

/**
 * IndexedDB `items` 表中存储的条目记录。
 * 额外包含仅用于列表极速渲染的轻量缩略图缓存，落盘 `meta.json` 前必须通过
 * `stripRecordToMeta` 剥离。
 */
export interface CollectionItemRecord extends CollectionItemMeta {
  /** 仅缓存在 IndexedDB 中的低分辨率缩略图 Data URL */
  thumbnailDataUrl?: string;
}

/**
 * 将 IndexedDB 中的条目记录安全剥离为可写入 `meta.json` 的纯净元数据对象，
 * 确保 `thumbnailDataUrl` 永不落盘。
 */
export function stripRecordToMeta(
  record: CollectionItemRecord,
): CollectionItemMeta {
  const { thumbnailDataUrl: _thumbnailDataUrl, ...meta } = record;
  void _thumbnailDataUrl;
  return meta;
}

/** 规范化并去重文件夹 ID 列表；若未提供数组则回退兼容单值 `fallbackFolderId` */
export function normalizeFolderIds(
  folderIds?: readonly string[] | null,
  fallbackFolderId?: string | null,
): string[] {
  const rawList: readonly (string | null | undefined)[] = Array.isArray(
    folderIds,
  )
    ? folderIds
    : fallbackFolderId
      ? [fallbackFolderId]
      : [];

  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of rawList) {
    if (typeof raw !== 'string') {
      continue;
    }
    const trimmed = raw.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

/** 安全读取条目归属的全部文件夹 ID（兼容旧版仅有 `folderId` 的索引记录） */
export function getItemFolderIds(
  item: Pick<CollectionItemMeta, 'folderId'> & {
    folderIds?: readonly string[] | null;
  },
): string[] {
  return normalizeFolderIds(item.folderIds, item.folderId);
}

/** 条目文件夹归属来源（用于区分人工确认样本与自动分类结果，避免误差滚雪球） */
export type FolderAssignedBy = 'manual' | 'auto';

/** 运行时校验是否为合法的 FolderAssignedBy */
export function isFolderAssignedBy(value: unknown): value is FolderAssignedBy {
  return value === 'manual' || value === 'auto';
}

/** 文件夹自动分类显式微规则（可选，随 `taxonomy.json` 持久化，全空时省略） */
export interface FolderAutoRule {
  /** 标题 / 标签 / 正文前段关键词（英文按词边界匹配，中文按子串匹配） */
  keywords?: string[];
  /** 精确匹配的标签 / 话题 / 节点名（忽略大小写与前导 `#`） */
  tags?: string[];
  /** 精确匹配的作者 ID 或作者名（忽略大小写） */
  authors?: string[];
  /** 限定来源平台列表（与其他条件组合时作前置过滤，单独配置时按平台直通） */
  platforms?: PlatformId[];
}

function normalizeRuleStrings(
  values?: readonly string[] | null,
  stripHash = false,
): string[] {
  if (!Array.isArray(values)) {
    return [];
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of values) {
    if (typeof raw !== 'string') {
      continue;
    }
    const cleaned = (stripHash ? raw.trim().replace(/^#+/, '') : raw).trim();
    if (!cleaned) {
      continue;
    }
    const dedupe = cleaned.toLowerCase();
    if (seen.has(dedupe)) {
      continue;
    }
    seen.add(dedupe);
    result.push(cleaned);
  }
  return result;
}

/** 规范化文件夹自动分类规则；若全部维度为空则返回 `undefined` */
export function normalizeFolderAutoRule(
  raw?: FolderAutoRule | null,
): FolderAutoRule | undefined {
  if (!raw) {
    return undefined;
  }
  const keywords = normalizeRuleStrings(raw.keywords, false);
  const tags = normalizeRuleStrings(raw.tags, true);
  const authors = normalizeRuleStrings(raw.authors, false);
  const platforms: PlatformId[] = [];
  if (Array.isArray(raw.platforms)) {
    const seen = new Set<PlatformId>();
    for (const p of raw.platforms) {
      if (isPlatformId(p) && !seen.has(p)) {
        seen.add(p);
        platforms.push(p);
      }
    }
  }
  if (
    keywords.length === 0 &&
    tags.length === 0 &&
    authors.length === 0 &&
    platforms.length === 0
  ) {
    return undefined;
  }
  return {
    ...(keywords.length > 0 ? { keywords } : {}),
    ...(tags.length > 0 ? { tags } : {}),
    ...(authors.length > 0 ? { authors } : {}),
    ...(platforms.length > 0 ? { platforms } : {}),
  };
}

/** 树形文件夹节点 */
export interface FolderNode {
  /** 文件夹唯一 ID（ULID） */
  id: string;
  /** 父文件夹 ID，null 表示顶级目录 */
  parentId: string | null;
  /** 文件夹显示名称 */
  name: string;
  /** 同级排序权重 */
  sortOrder: number;
  /** 创建时间戳（毫秒） */
  createdAt: number;
  /** 更新时间戳（毫秒） */
  updatedAt: number;
  /** 可选自动分类显式微规则（随 taxonomy.json 落盘，重建索引不丢失） */
  autoRule?: FolderAutoRule;
}

/** 标签元数据 */
export interface TagMeta {
  /** 标签唯一名称 */
  name: string;
  /** 标签视觉颜色（HEX 或语义色值） */
  color: string;
  /** 创建时间戳（毫秒） */
  createdAt: number;
}

/** 后台下载队列任务状态记录 */
export interface DownloadTask {
  /** 任务唯一 ID（ULID） */
  id: string;
  /** 关联收藏条目 ID */
  itemId: string;
  /** 关联条目去重键 */
  dedupeKey: string;
  /** 来源平台 */
  platform: PlatformId;
  /** 展示用条目标题 */
  title: string;
  /** 任务当前状态 */
  status: DownloadTaskStatus;
  /** 整体进度百分比（0 - 100） */
  progress: number;
  /** 已完成下载的资产数量 */
  completedAssets: number;
  /** 需下载的总资产数量 */
  totalAssets: number;
  /** 已下载字节数 */
  downloadedBytes: number;
  /** 预计总字节数 */
  totalBytes: number;
  /** 已重试次数 */
  retryCount: number;
  /** 失败原因说明 */
  errorMessage?: string;
  /** 任务创建时间戳（毫秒） */
  createdAt: number;
  /** 任务最后更新时间戳（毫秒） */
  updatedAt: number;
}

/** `CollectVault/.collect-vault.json` 配置文件结构 */
export interface VaultConfig {
  /** Schema 版本号 */
  schemaVersion: typeof SCHEMA_VERSION;
  /** Vault 唯一标识（ULID） */
  vaultId: string;
  /** Vault 名称 */
  name: string;
  /** 创建时间戳（毫秒） */
  createdAt: number;
  /** 更新时间戳（毫秒） */
  updatedAt: number;
}

/** `CollectVault/taxonomy.json` 分类与标签索引文件结构 */
export interface TaxonomyFile {
  /** Schema 版本号 */
  schemaVersion: typeof SCHEMA_VERSION;
  /** 更新时间戳（毫秒） */
  updatedAt: number;
  /** 全部文件夹节点 */
  folders: FolderNode[];
  /** 全部标签定义 */
  tags: TagMeta[];
}

/** 控制台默认展示视图 */
export type LibraryViewMode = 'grid' | 'list';

/** 控制台默认排序方式 */
export type LibrarySortOption = 'collectedAt' | 'publishedAt' | 'totalSizeBytes';

/** 视频过大取消自动保存时的通知方式 */
export type OversizedVideoNotifyMode = 'popup' | 'silent';

/** 用户可配置的偏好设置 */
export interface UserPreferences {
  /** 打开管理库页面且已获目录权限时自动同步 OPFS 暂存内容 */
  autoSyncOnLibraryOpen: boolean;
  /** 是否在支持的平台页面显示右下角浮动收藏按钮 */
  floatingButtonEnabled: boolean;
  /** 原站原生收藏时是否显示 5 秒取消本地持久化提示 Toast（默认开启） */
  nativeCollectToastEnabled: boolean;
  /** NSFW 内容过滤（默认关闭）：开启后管理台隐藏 xvideos/pornhub 来源或带 NSFW 标签的条目 */
  nsfwFilterEnabled: boolean;
  /** 自动同步全部收藏（默认关闭，跨平台全量同步总开关） */
  autoSyncAllCollections: boolean;
  /** 取消收藏时同步至插件（默认关闭，开启后原站取消收藏自动移入回收站） */
  syncUncollectToPlugin: boolean;
  /** 视频体积超过阈值时取消自动保存（默认关闭） */
  skipOversizedVideoAutoSave: boolean;
  /** 取消自动保存的视频体积阈值（MB，默认 200） */
  oversizedVideoThresholdMb: number;
  /** 视频过大取消自动保存时的通知方式（弹窗 / 静默，默认弹窗） */
  oversizedVideoNotifyMode: OversizedVideoNotifyMode;
  /** 未手动指定文件夹时是否启用本地智能自动分类（无匹配时兜底进入未分类，默认开启） */
  autoClassifyEnabled: boolean;
  /** 快捷收藏默认归属的文件夹 ID（关闭自动分类时生效） */
  defaultFolderId: string | null;
  /** 最大并发下载任务数 */
  maxConcurrentDownloads: number;
  /** 控制台默认列表展示视图 */
  defaultViewMode: LibraryViewMode;
  /** 控制台默认排序方式 */
  defaultSortBy: LibrarySortOption;
}

/** 单个已登录平台账号的全量收藏首次同步状态 */
export type PlatformAccountSyncStatus = 'synced' | 'dismissed';

/** 按平台 + 非敏感账号 ID 持久化的全量收藏同步记录（严禁存储 Cookie/Token） */
export interface PlatformAccountSyncEntry {
  platform: PlatformId;
  accountId: string;
  status: PlatformAccountSyncStatus;
  updatedAt: number;
  lastSyncedAt?: number;
  lastSyncedCount?: number;
}

/** IndexedDB `settings` 表：已绑定的 CollectVault 目录句柄 */
export interface VaultDirectoryHandleSetting {
  key: 'vault_directory_handle';
  value: FileSystemDirectoryHandle;
  updatedAt: number;
}

/** IndexedDB `settings` 表：缓存的 Vault 配置元数据 */
export interface VaultConfigSetting {
  key: 'vault_config';
  value: VaultConfig;
  updatedAt: number;
}

/** IndexedDB `settings` 表：最近一次成功同步到 Vault 的时间戳 */
export interface LastSyncTimestampSetting {
  key: 'last_sync_at';
  value: number;
  updatedAt: number;
}

/** IndexedDB `settings` 表：用户偏好设置 */
export interface UserPreferencesSetting {
  key: 'user_preferences';
  value: UserPreferences;
  updatedAt: number;
}

/** IndexedDB `settings` 表：按 `${platform}:${accountId}` 记录的各账号全量收藏同步状态 */
export interface PlatformAccountSyncStateSetting {
  key: 'platform_account_sync_states';
  value: Record<string, PlatformAccountSyncEntry>;
  updatedAt: number;
}

/** IndexedDB `settings` 表：当前启用的持久化存储插件 ID（缺省为 `'local_fs'`） */
export interface ActiveVaultProviderSetting {
  key: 'active_vault_provider';
  value: VaultProviderId;
  updatedAt: number;
}

/**
 * IndexedDB `settings` 表：各持久化存储插件的非敏感配置映射（按插件 ID 隔离）。
 * 铁律：严禁在此存储任何 Access Token、Refresh Token、密码或 Client Secret。
 */
export interface VaultProviderConfigsSetting {
  key: 'vault_provider_configs';
  value: Partial<Record<VaultProviderId, Record<string, unknown>>>;
  updatedAt: number;
}

/**
 * IndexedDB `settings` 表的强类型判别联合记录。
 * 通过 `key` 精确区分句柄、配置及偏好值类型。
 */
export type SettingRecord =
  | VaultDirectoryHandleSetting
  | VaultConfigSetting
  | LastSyncTimestampSetting
  | UserPreferencesSetting
  | PlatformAccountSyncStateSetting
  | ActiveVaultProviderSetting
  | VaultProviderConfigsSetting;

/** 所有受支持的设置键联合类型 */
export type SettingKey = SettingRecord['key'];

/** 设置键到其对应值类型的映射 */
export type SettingValueMap = {
  [R in SettingRecord as R['key']]: R['value'];
};

/** `chrome.storage.local` 首次安装固定工具栏提示待展示标记键 */
export const PIN_HINT_PENDING_KEY = 'collect_plus_pin_hint_pending' as const;
