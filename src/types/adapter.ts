/**
 * 多平台插件化适配器契约与 Main World ↔ Isolated Content Script 桥接协议定义。
 */

import {
  isPlatformId,
  type AssetKind,
  type AuthorInfo,
  type DownloadStrategy,
  type MediaKind,
  type PlatformExtraValue,
  type PlatformId,
} from './schema.ts';

/** 触发采集的来源通道列表 */
export const CAPTURE_TRIGGER_SOURCES = [
  'native_collect',
  'hotkey',
  'floating_button',
  'popup',
  'auto_sync',
] as const;

/** 触发采集的来源通道 */
export type CaptureTriggerSource = (typeof CAPTURE_TRIGGER_SOURCES)[number];

/** 运行时校验是否为合法的 CaptureTriggerSource */
export function isCaptureTriggerSource(
  value: unknown,
): value is CaptureTriggerSource {
  return (
    typeof value === 'string' &&
    (CAPTURE_TRIGGER_SOURCES as readonly string[]).includes(value)
  );
}

/** 适配器提取出的单个原始媒体资产输入（尚未分配最终本地相对路径） */
export interface CapturedAssetInput {
  /** 资产在条目内的逻辑标识，例如 'video'、'img-01' */
  id: string;
  /** 资产类型 */
  kind: AssetKind;
  /** 下载与混流策略 */
  strategy: DownloadStrategy;
  /** 主源地址 */
  sourceUrl: string;
  /** 备用源地址列表 */
  fallbackUrls?: string[];
  /** DASH 音视频分离流混流时的音频轨道地址 */
  audioUrl?: string;
  /** DASH 音视频分离流混流时的备用音频轨道地址列表 */
  audioFallbackUrls?: string[];
  /** 媒体 MIME 类型 */
  mimeType: string;
  /** 像素宽度 */
  width?: number;
  /** 像素高度 */
  height?: number;
  /** 音视频时长（秒） */
  durationSec?: number;
  /** 平台接口明确提供的精确文件体积（字节，可选） */
  sizeBytes?: number;
  /** 文件名或扩展名提示（由路径规范化模块统一落盘命名） */
  filenameHint?: string;
}

/** 适配器归一化后的单条原始评论输入（尚未离线下载评论者头像） */
export interface CapturedCommentInput {
  /** 平台侧评论唯一 ID */
  id: string;
  /** 评论者平台 ID（非敏感 uid/sec_uid，可选） */
  authorId?: string;
  /** 评论者昵称 */
  authorName: string;
  /** 评论者头像主远程地址 */
  avatarUrl?: string;
  /** 评论者头像备用远程地址列表 */
  avatarFallbackUrls?: string[];
  /** 评论正文内容 */
  content: string;
  /** 评论点赞数 */
  likeCount: number;
  /** 评论发布时间戳（毫秒，可选） */
  createdAt?: number;
}

/** 经由平台适配器归一化后的跨平台统一采集载荷 */
export interface CapturedPayload {
  /** 来源平台 */
  platform: PlatformId;
  /** 平台侧唯一内容 ID */
  sourceId: string;
  /** 原内容页面链接 */
  sourceUrl: string;
  /** 媒体形态分类 */
  kind: MediaKind;
  /** 标题 */
  title: string;
  /** 正文描述 */
  description: string;
  /** 原内容作者信息 */
  author: AuthorInfo;
  /** 原内容发布时间戳（毫秒） */
  publishedAt?: number;
  /** 从正文提取的话题标签列表 */
  hashtags: string[];
  /** 封面主图远程地址 */
  coverUrl?: string;
  /** 封面备用远程地址列表 */
  coverFallbackUrls?: string[];
  /** 主体媒体资产列表 */
  assets: CapturedAssetInput[];
  /** 平台特有扩展字段 */
  platformExtra?: Record<string, PlatformExtraValue>;
  /** 本次采集的触发方式 */
  triggerSource: CaptureTriggerSource;
}

/** declarativeNetRequest 动态请求头改写规则声明 */
export interface DnrHeaderRuleSpec {
  /** 相对平台基础规则 ID 的偏移量，用于稳定分配唯一 rule id */
  idOffset: number;
  /** DNR URL 过滤表达式（如 '||douyinvod.com/'） */
  urlFilter: string;
  /** 需注入的 Referer 请求头 */
  referer: string;
  /** 可选需注入的 Origin 请求头 */
  origin?: string;
  /** 生效的资源类型列表，缺省时由注册器应用默认下载类型集合 */
  resourceTypes?: chrome.declarativeNetRequest.ResourceType[];
}

/**
 * 平台适配器统一接口契约。
 * 每个支持的内容平台实现该接口并在全局注册表中注册，保证采集链路与核心存储引擎解耦。
 */
export interface PlatformAdapter {
  /** 平台唯一标识 */
  readonly id: PlatformId;
  /** 平台中文/可读展示名称 */
  readonly displayName: string;
  /** 匹配的域名模式列表 */
  readonly hostPatterns: readonly string[];
  /** 判断给定页面 URL 是否属于该平台 */
  matchesUrl(url: string): boolean;
  /** 返回该平台防盗链所需的 DNR 请求头规则声明 */
  getDnrRules(): readonly DnrHeaderRuleSpec[];
  /** 将页面拦截或提取的原始平台数据归一化为统一 CapturedPayload */
  normalizeRawData(
    raw: unknown,
    triggerSource: CaptureTriggerSource,
  ): CapturedPayload | null;
}

/** Main World 脚本与 Isolated Content Script 之间 `window.postMessage` 的专用频道名 */
export const PAGE_BRIDGE_CHANNEL = 'collect-plus:page-bridge' as const;

/** Main World 注入桥接就绪通知 */
export interface BridgeReadyMessage {
  channel: typeof PAGE_BRIDGE_CHANNEL;
  direction: 'main-to-content';
  type: 'BRIDGE_READY';
  platform: PlatformId;
}

/** Main World 捕获到用户在原站触发收藏动作 */
export interface NativeCollectCapturedMessage {
  channel: typeof PAGE_BRIDGE_CHANNEL;
  direction: 'main-to-content';
  type: 'NATIVE_COLLECT_CAPTURED';
  platform: PlatformId;
  rawData: unknown;
  sourceId?: string;
}

/** Isolated Content Script 主动向 Main World 请求当前视口活跃条目数据 */
export interface RequestCurrentItemMessage {
  channel: typeof PAGE_BRIDGE_CHANNEL;
  direction: 'content-to-main';
  type: 'REQUEST_CURRENT_ITEM';
  requestId: string;
  triggerSource: CaptureTriggerSource;
}

/** Main World 响应当前视口活跃条目数据 */
export interface CurrentItemResponseMessage {
  channel: typeof PAGE_BRIDGE_CHANNEL;
  direction: 'main-to-content';
  type: 'CURRENT_ITEM_RESPONSE';
  requestId: string;
  platform: PlatformId;
  rawData: unknown | null;
  error?: string;
  triggerSource: CaptureTriggerSource;
}

/** Main World 捕获到用户在原站触发取消收藏动作 */
export interface NativeUncollectCapturedMessage {
  channel: typeof PAGE_BRIDGE_CHANNEL;
  direction: 'main-to-content';
  type: 'NATIVE_UNCOLLECT_CAPTURED';
  platform: PlatformId;
  sourceIds: string[];
}

/** Isolated Content Script 主动查询当前页面是否已检测到登录账号 */
export interface RequestLoginStateMessage {
  channel: typeof PAGE_BRIDGE_CHANNEL;
  direction: 'content-to-main';
  type: 'REQUEST_LOGIN_STATE';
}

/** Main World 上报当前页面已登录账号（仅非敏感 ID 与可选昵称） */
export interface LoginStateDetectedMessage {
  channel: typeof PAGE_BRIDGE_CHANNEL;
  direction: 'main-to-content';
  type: 'LOGIN_STATE_DETECTED';
  platform: PlatformId;
  accountId: string;
  accountName?: string;
}

/** Isolated Content Script 请求 Main World 启动全量收藏分页拉取 */
export interface RequestFullCollectionSyncMessage {
  channel: typeof PAGE_BRIDGE_CHANNEL;
  direction: 'content-to-main';
  type: 'REQUEST_FULL_COLLECTION_SYNC';
  syncId: string;
}

/** Isolated Content Script 请求中止进行中的全量收藏拉取 */
export interface CancelFullCollectionSyncMessage {
  channel: typeof PAGE_BRIDGE_CHANNEL;
  direction: 'content-to-main';
  type: 'CANCEL_FULL_COLLECTION_SYNC';
  syncId: string;
}

/** Main World 向上游推送一页全量收藏原始数据 */
export interface CollectionSyncBatchMessage {
  channel: typeof PAGE_BRIDGE_CHANNEL;
  direction: 'main-to-content';
  type: 'COLLECTION_SYNC_BATCH';
  syncId: string;
  platform: PlatformId;
  rawItems: unknown[];
  pageIndex: number;
  hasMore: boolean;
}

/** 全量收藏同步结束状态 */
export type CollectionSyncDoneStatus =
  | 'completed'
  | 'fallback_needed'
  | 'cancelled'
  | 'error';

/** Main World 通知全量收藏拉取结束（正常完成、触发风控需被动兜底、取消或异常） */
export interface CollectionSyncDoneMessage {
  channel: typeof PAGE_BRIDGE_CHANNEL;
  direction: 'main-to-content';
  type: 'COLLECTION_SYNC_DONE';
  syncId: string;
  platform: PlatformId;
  totalFetched: number;
  status: CollectionSyncDoneStatus;
  error?: string;
  fallbackUrl?: string;
}

/** Main World 被动旁路捕获到宿主页面自然加载的收藏列表响应 */
export interface PassiveCollectionListCapturedMessage {
  channel: typeof PAGE_BRIDGE_CHANNEL;
  direction: 'main-to-content';
  type: 'PASSIVE_COLLECTION_LIST_CAPTURED';
  platform: PlatformId;
  rawItems: unknown[];
  hasMore: boolean;
}

/** Isolated Content Script 请求 Main World 获取指定作品的前 N 条原始评论 */
export interface RequestItemCommentsMessage {
  channel: typeof PAGE_BRIDGE_CHANNEL;
  direction: 'content-to-main';
  type: 'REQUEST_ITEM_COMMENTS';
  requestId: string;
  sourceId: string;
  limit: number;
}

/** Main World 返回指定作品的原始评论列表 */
export interface ItemCommentsResponseMessage {
  channel: typeof PAGE_BRIDGE_CHANNEL;
  direction: 'main-to-content';
  type: 'ITEM_COMMENTS_RESPONSE';
  requestId: string;
  platform: PlatformId;
  sourceId: string;
  rawComments: unknown[];
  error?: string;
}

/** 远端取消平台账号收藏的单条请求目标 */
export interface RemoteUncollectTargetInput {
  /** 平台侧唯一内容 ID */
  sourceId: string;
  /** 可选平台扩展字段（如 B站 aid，减少额外接口查询） */
  platformExtra?: Record<string, PlatformExtraValue>;
}

/** 远端取消平台账号收藏的单条执行结果 */
export interface RemoteUncollectTargetOutcome {
  /** 平台侧唯一内容 ID */
  sourceId: string;
  /** 是否取消收藏成功（或原平台已未收藏） */
  ok: boolean;
  /** 失败或跳过原因说明 */
  reason?: string;
}

/** Isolated Content Script 请求 Main World 在原平台执行取消收藏 */
export interface RequestRemoteUncollectMessage {
  channel: typeof PAGE_BRIDGE_CHANNEL;
  direction: 'content-to-main';
  type: 'REQUEST_REMOTE_UNCOLLECT';
  requestId: string;
  items: RemoteUncollectTargetInput[];
}

/** Main World 返回在原平台执行取消收藏的结果列表 */
export interface RemoteUncollectResponseMessage {
  channel: typeof PAGE_BRIDGE_CHANNEL;
  direction: 'main-to-content';
  type: 'REMOTE_UNCOLLECT_RESPONSE';
  requestId: string;
  platform: PlatformId;
  results: RemoteUncollectTargetOutcome[];
}

/** Main World ↔ Isolated Content Script 强类型桥接消息判别联合 */
export type PageBridgeMessage =
  | BridgeReadyMessage
  | NativeCollectCapturedMessage
  | NativeUncollectCapturedMessage
  | RequestCurrentItemMessage
  | CurrentItemResponseMessage
  | RequestLoginStateMessage
  | LoginStateDetectedMessage
  | RequestFullCollectionSyncMessage
  | CancelFullCollectionSyncMessage
  | CollectionSyncBatchMessage
  | CollectionSyncDoneMessage
  | PassiveCollectionListCapturedMessage
  | RequestItemCommentsMessage
  | ItemCommentsResponseMessage
  | RequestRemoteUncollectMessage
  | RemoteUncollectResponseMessage;

const COLLECTION_SYNC_DONE_STATUSES: ReadonlySet<string> = new Set<
  CollectionSyncDoneStatus
>(['completed', 'fallback_needed', 'cancelled', 'error']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === 'string')
  );
}

/**
 * 运行时类型守卫：校验 `window.postMessage` 收到的未知负载是否为合法的 `PageBridgeMessage`。
 */
export function isPageBridgeMessage(data: unknown): data is PageBridgeMessage {
  if (!isRecord(data)) {
    return false;
  }

  if (data.channel !== PAGE_BRIDGE_CHANNEL) {
    return false;
  }

  const { direction, type } = data;
  if (typeof direction !== 'string' || typeof type !== 'string') {
    return false;
  }

  switch (type) {
    case 'BRIDGE_READY':
      return direction === 'main-to-content' && isPlatformId(data.platform);

    case 'NATIVE_COLLECT_CAPTURED':
      return (
        direction === 'main-to-content' &&
        isPlatformId(data.platform) &&
        'rawData' in data &&
        (data.sourceId === undefined || typeof data.sourceId === 'string')
      );

    case 'NATIVE_UNCOLLECT_CAPTURED':
      return (
        direction === 'main-to-content' &&
        isPlatformId(data.platform) &&
        isStringArray(data.sourceIds)
      );

    case 'REQUEST_CURRENT_ITEM':
      return (
        direction === 'content-to-main' &&
        typeof data.requestId === 'string' &&
        isCaptureTriggerSource(data.triggerSource)
      );

    case 'CURRENT_ITEM_RESPONSE':
      return (
        direction === 'main-to-content' &&
        typeof data.requestId === 'string' &&
        isPlatformId(data.platform) &&
        'rawData' in data &&
        (data.error === undefined || typeof data.error === 'string') &&
        isCaptureTriggerSource(data.triggerSource)
      );

    case 'REQUEST_LOGIN_STATE':
      return direction === 'content-to-main';

    case 'LOGIN_STATE_DETECTED':
      return (
        direction === 'main-to-content' &&
        isPlatformId(data.platform) &&
        typeof data.accountId === 'string' &&
        data.accountId.trim().length > 0 &&
        (data.accountName === undefined || typeof data.accountName === 'string')
      );

    case 'REQUEST_FULL_COLLECTION_SYNC':
      return (
        direction === 'content-to-main' && typeof data.syncId === 'string'
      );

    case 'CANCEL_FULL_COLLECTION_SYNC':
      return (
        direction === 'content-to-main' && typeof data.syncId === 'string'
      );

    case 'COLLECTION_SYNC_BATCH':
      return (
        direction === 'main-to-content' &&
        typeof data.syncId === 'string' &&
        isPlatformId(data.platform) &&
        Array.isArray(data.rawItems) &&
        typeof data.pageIndex === 'number' &&
        typeof data.hasMore === 'boolean'
      );

    case 'COLLECTION_SYNC_DONE':
      return (
        direction === 'main-to-content' &&
        typeof data.syncId === 'string' &&
        isPlatformId(data.platform) &&
        typeof data.totalFetched === 'number' &&
        typeof data.status === 'string' &&
        COLLECTION_SYNC_DONE_STATUSES.has(data.status) &&
        (data.error === undefined || typeof data.error === 'string') &&
        (data.fallbackUrl === undefined || typeof data.fallbackUrl === 'string')
      );

    case 'PASSIVE_COLLECTION_LIST_CAPTURED':
      return (
        direction === 'main-to-content' &&
        isPlatformId(data.platform) &&
        Array.isArray(data.rawItems) &&
        typeof data.hasMore === 'boolean'
      );

    case 'REQUEST_ITEM_COMMENTS':
      return (
        direction === 'content-to-main' &&
        typeof data.requestId === 'string' &&
        typeof data.sourceId === 'string' &&
        data.sourceId.trim().length > 0 &&
        typeof data.limit === 'number' &&
        Number.isFinite(data.limit) &&
        data.limit > 0
      );

    case 'ITEM_COMMENTS_RESPONSE':
      return (
        direction === 'main-to-content' &&
        typeof data.requestId === 'string' &&
        isPlatformId(data.platform) &&
        typeof data.sourceId === 'string' &&
        Array.isArray(data.rawComments) &&
        (data.error === undefined || typeof data.error === 'string')
      );

    case 'REQUEST_REMOTE_UNCOLLECT':
      return (
        direction === 'content-to-main' &&
        typeof data.requestId === 'string' &&
        Array.isArray(data.items) &&
        data.items.every(
          (entry) =>
            isRecord(entry) &&
            typeof entry.sourceId === 'string' &&
            entry.sourceId.trim().length > 0,
        )
      );

    case 'REMOTE_UNCOLLECT_RESPONSE':
      return (
        direction === 'main-to-content' &&
        typeof data.requestId === 'string' &&
        isPlatformId(data.platform) &&
        Array.isArray(data.results) &&
        data.results.every(
          (entry) =>
            isRecord(entry) &&
            typeof entry.sourceId === 'string' &&
            typeof entry.ok === 'boolean' &&
            (entry.reason === undefined || typeof entry.reason === 'string'),
        )
      );

    default:
      return false;
  }
}
