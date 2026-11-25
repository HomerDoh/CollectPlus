/**
 * Collect+ 核心元数据 Schema 与本地存储数据结构定义。
 *
 * 铁律：所有写入本地 CollectVault（meta.json / taxonomy.json / .collect-vault.json）的
 * 元数据必须仅包含相对路径，禁止包含绝对路径或 Base64 缩略图数据。
 */

/** 当前元数据 Schema 版本号 */
export const SCHEMA_VERSION = 1 as const;

/** 支持的内容平台标识列表 */
export const PLATFORM_IDS = [
  'douyin',
  'bilibili',
  'zhihu',
  'youtube',
  'xiaohongshu',
  'twitter',
  'instagram',
] as const;

/** 支持的内容平台 ID */
export type PlatformId = (typeof PLATFORM_IDS)[number];

/** 运行时校验是否为合法的 PlatformId */
export function isPlatformId(value: unknown): value is PlatformId {
  return (
    typeof value === 'string' &&
    (PLATFORM_IDS as readonly string[]).includes(value)
  );
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
  /** 所属文件夹 ID，null 表示未归类/根目录 */
  folderId: string | null;
  /** 标签名称列表 */
  tags: string[];
  /** 用户备注 */
  note: string;
  /** 相对 `CollectVault/` 根目录的条目目录路径 */
  relativeDir: string;
  /** 封面相对条目目录路径（如 'cover.jpg'） */
  coverRelativePath?: string;
  /** 条目关联的全部媒体资产 */
  assets: MediaAsset[];
  /** 当前同步状态 */
  syncStatus: SyncStatus;
  /** 条目媒体文件总字节数 */
  totalSizeBytes: number;
  /** 软删除时间戳（毫秒），null 或 undefined 表示未删除 */
  deletedAt?: number | null;
  /** 平台特有的轻量结构化扩展字段 */
  platformExtra?: Record<string, PlatformExtraValue>;
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

/** 用户可配置的偏好设置 */
export interface UserPreferences {
  /** 打开管理库页面且已获目录权限时自动同步 OPFS 暂存内容 */
  autoSyncOnLibraryOpen: boolean;
  /** 是否在支持的平台页面显示右下角浮动收藏按钮 */
  floatingButtonEnabled: boolean;
  /** 快捷收藏默认归属的文件夹 ID */
  defaultFolderId: string | null;
  /** 最大并发下载任务数 */
  maxConcurrentDownloads: number;
  /** 控制台默认列表展示视图 */
  defaultViewMode: LibraryViewMode;
  /** 控制台默认排序方式 */
  defaultSortBy: LibrarySortOption;
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

/**
 * IndexedDB `settings` 表的强类型判别联合记录。
 * 通过 `key` 精确区分句柄、配置及偏好值类型。
 */
export type SettingRecord =
  | VaultDirectoryHandleSetting
  | VaultConfigSetting
  | LastSyncTimestampSetting
  | UserPreferencesSetting;

/** 所有受支持的设置键联合类型 */
export type SettingKey = SettingRecord['key'];

/** 设置键到其对应值类型的映射 */
export type SettingValueMap = {
  [R in SettingRecord as R['key']]: R['value'];
};
