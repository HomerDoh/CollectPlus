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
  /** 媒体 MIME 类型 */
  mimeType: string;
  /** 像素宽度 */
  width?: number;
  /** 像素高度 */
  height?: number;
  /** 音视频时长（秒） */
  durationSec?: number;
  /** 文件名或扩展名提示（由路径规范化模块统一落盘命名） */
  filenameHint?: string;
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

/** Main World ↔ Isolated Content Script 强类型桥接消息判别联合 */
export type PageBridgeMessage =
  | BridgeReadyMessage
  | NativeCollectCapturedMessage
  | RequestCurrentItemMessage
  | CurrentItemResponseMessage;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
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

    default:
      return false;
  }
}
