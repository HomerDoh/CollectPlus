/**
 * CollectPlus 插件化持久化存储（Vault Storage Provider）核心契约。
 *
 * 所有持久化后端（本地目录、Google Drive、后续扩展的 WebDAV / S3 / OneDrive 等）
 * 均须实现本接口并注册到 `src/storage/providers/registry.ts`。
 *
 * 铁律：
 * - 所有文件路径均使用相对 Vault 根目录的 POSIX 相对路径（如 `items/douyin/2026-11/.../meta.json`）；
 * - 任何云端凭据 / OAuth Access Token 严禁写入 Vault 元数据或持久化到 IndexedDB；
 * - 各插件独立封装认证、传输协议与缓存，不向核心存储层或业务层泄漏平台细节。
 */

/** 支持的持久化存储插件标识列表（新增云存储插件时在此扩展） */
export const VAULT_PROVIDER_IDS = [
  'local_fs',
  'google_drive',
  'cloudflare_r2',
] as const;

/** 持久化存储插件 ID */
export type VaultProviderId = (typeof VAULT_PROVIDER_IDS)[number];

/** 运行时校验是否为合法的 VaultProviderId */
export function isVaultProviderId(value: unknown): value is VaultProviderId {
  return (
    typeof value === 'string' &&
    (VAULT_PROVIDER_IDS as readonly string[]).includes(value)
  );
}

/** 持久化目标访问授权状态 */
export type VaultPermissionStatus = PermissionState | 'unbound';

/** 持久化存储访问模式 */
export type VaultAccessMode = 'read' | 'readwrite';

/** 扫描 `items/` 下 `meta.json` 时的抽象条目（用于容灾重建索引） */
export interface ScannedVaultMetaEntry {
  /** 条目目录相对 Vault 根目录的 POSIX 路径，如 `items/douyin/2026-11/20261128_123_title` */
  relativeDir: string;
  /** 读取该条目 `meta.json` 文本内容 */
  readMetaText: () => Promise<string>;
  /** 读取该条目目录下的同级相对文件（如 `cover.jpg`），不存在返回 `null` */
  readRelativeFile: (assetRelativePath: string) => Promise<File | null>;
}

/** 可直接用于 `<video>` / `<img>` 播放或展示的媒体源描述符 */
export interface PlayableMediaSource {
  /** 可播放 URL（本地 `blob:` 或经扩展 DNR 鉴权的远端流式 URL） */
  url: string;
  /** 文件字节数（可选） */
  sizeBytes?: number;
  /** 视图卸载或切换条目时的资源释放钩子（如 `URL.revokeObjectURL` 或移除临时 DNR 规则） */
  dispose?: () => Promise<void> | void;
}

/** 通用持久化后端存储驱动接口 */
export interface VaultStorageBackend {
  /** 所属存储插件 ID */
  readonly providerId: VaultProviderId;
  /** 面向 UI 展示的根目录/目标名称（如 `CollectVault`） */
  readonly displayName: string;
  /** 是否为远程云存储/网络存储后端 */
  readonly isRemote: boolean;

  /** 非交互式查询当前访问授权状态 */
  queryPermission(mode?: VaultAccessMode): Promise<VaultPermissionStatus>;
  /** 交互式请求访问授权（用户手势下调用） */
  requestPermission(mode?: VaultAccessMode): Promise<boolean>;

  /** 读取相对路径文件，不存在返回 `null` */
  readFile(relativePath: string): Promise<File | null>;
  /** 判断相对路径文件是否存在 */
  hasFile(relativePath: string): Promise<boolean>;
  /** 写入 UTF-8 文本文件（自动创建父目录，已存在时覆盖更新） */
  writeTextFile(relativePath: string, content: string): Promise<void>;
  /** 写入二进制文件（自动创建父目录，大文件支持流式/分片上传，已存在时覆盖更新） */
  writeFile(
    relativePath: string,
    sourceFile: File,
    onProgress?: (loadedBytes: number, totalBytes: number) => void,
  ): Promise<void>;

  /** 确保相对目录存在 */
  ensureDirectory(relativeDir: string): Promise<void>;
  /** 判断指定相对目录下是否存在任意子项（目录不存在时返回 `false`） */
  hasAnyEntry(relativeDir: string): Promise<boolean>;
  /** 递归删除相对目录（不存在时静默忽略） */
  removeDirectory(relativeDir: string): Promise<void>;
  /** 删除相对目录下除 `keepFileNames` 外的全部文件与子目录（不存在时静默忽略） */
  purgeDirectoryExcept(
    relativeDir: string,
    keepFileNames: ReadonlySet<string>,
  ): Promise<void>;

  /** 扫描 `items/` 下全部 `meta.json` 条目用于容灾重建索引 */
  scanItemMetaFiles(): Promise<ScannedVaultMetaEntry[]>;

  /**
   * 可选：为大体积媒体（如远端视频）解析支持流式 HTTP Range 的可播放源。
   * 未实现或返回 `null` 时，调用方自动回退为 `readFile` + `URL.createObjectURL`。
   */
  resolvePlayableMedia?(relativePath: string): Promise<PlayableMediaSource | null>;
}

/** 持久化插件连接状态快照（供设置页与状态指示器统一渲染） */
export interface VaultProviderConnectionState {
  /** 插件 ID */
  providerId: VaultProviderId;
  /** 是否已完成目标绑定/配置 */
  configured: boolean;
  /** 当前授权状态 */
  permission: VaultPermissionStatus;
  /** 目标名称（如本地目录名或远端目录名） */
  targetLabel: string;
  /** 可选账号/端点摘要（仅展示用，绝不含凭据） */
  accountLabel?: string;
}

/** 独立持久化存储插件接口 */
export interface VaultProviderPlugin {
  /** 全局唯一插件标识 */
  readonly id: VaultProviderId;
  /** 是否为远程存储插件 */
  readonly isRemote: boolean;
  /** 查询当前连接与授权状态（非交互式） */
  getConnectionState(): Promise<VaultProviderConnectionState>;
  /** 实例化当前已绑定的存储后端；未配置/未绑定时返回 `null` */
  getBackend(): Promise<VaultStorageBackend | null>;
  /** 断开连接并清理本地配置与路径缓存（绝不删除远端或硬盘已保存的 CollectVault 文件） */
  disconnect?(): Promise<void>;
}
