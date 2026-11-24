/**
 * Extension 内部跨上下文强类型消息协议定义与发送封装。
 *
 * 通过显式 `target` 字段（'background' | 'offscreen' | 'content'）隔离各上下文监听器，
 * 防止 Background Service Worker 与 Offscreen Document 之间互相误消费广播消息。
 */

import type { CapturedPayload, CaptureTriggerSource } from './adapter.ts';
import type {
  CollectionItemRecord,
  FolderNode,
  MediaAsset,
  PlatformId,
  TagMeta,
} from './schema.ts';

/** 消息目标上下文标识 */
export type MessageTarget = 'background' | 'offscreen' | 'content';

/** 通用成功/失败响应封装 */
export type OkResult<T extends Record<string, unknown> = Record<never, never>> =
  { ok: true } & T;

export interface ErrorResult {
  ok: false;
  error: string;
}

export type ActionResult<
  T extends Record<string, unknown> = Record<never, never>,
> = OkResult<T> | ErrorResult;

// ============================================================================
// 1. 发往 Background Service Worker 的消息协议 (target: 'background')
// ============================================================================

export interface CaptureItemMessage {
  target: 'background';
  type: 'CAPTURE_ITEM';
  payload: CapturedPayload;
  folderId?: string | null;
  tags?: string[];
}

export interface UpdateItemClassificationMessage {
  target: 'background';
  type: 'UPDATE_ITEM_CLASSIFICATION';
  itemId: string;
  folderId?: string | null;
  tags?: string[];
  note?: string;
}

export interface GetTaxonomyMessage {
  target: 'background';
  type: 'GET_TAXONOMY';
}

export interface CreateFolderQuickMessage {
  target: 'background';
  type: 'CREATE_FOLDER_QUICK';
  name: string;
  parentId?: string | null;
}

export interface GetStatusSummaryMessage {
  target: 'background';
  type: 'GET_STATUS_SUMMARY';
  tabUrl?: string;
}

export interface TriggerActiveTabCaptureMessage {
  target: 'background';
  type: 'TRIGGER_ACTIVE_TAB_CAPTURE';
  tabId?: number;
}

export interface RetryDownloadTaskMessage {
  target: 'background';
  type: 'RETRY_DOWNLOAD_TASK';
  taskId: string;
}

export interface CancelDownloadTaskMessage {
  target: 'background';
  type: 'CANCEL_DOWNLOAD_TASK';
  taskId: string;
}

export interface OpenLibraryPageMessage {
  target: 'background';
  type: 'OPEN_LIBRARY_PAGE';
  itemId?: string;
}

export interface OffscreenProgressMessage {
  target: 'background';
  type: 'OFFSCREEN_PROGRESS';
  taskId: string;
  itemId: string;
  progress: number;
  completedAssets: number;
  totalAssets: number;
  downloadedBytes: number;
  totalBytes: number;
}

export interface OffscreenCompleteMessage {
  target: 'background';
  type: 'OFFSCREEN_COMPLETE';
  taskId: string;
  itemId: string;
  assets: MediaAsset[];
  totalSizeBytes: number;
  thumbnailDataUrl?: string;
}

export interface OffscreenErrorMessage {
  target: 'background';
  type: 'OFFSCREEN_ERROR';
  taskId: string;
  itemId: string;
  error: string;
  retryable: boolean;
}

/** 所有发往 Background 的消息判别联合 */
export type BackgroundMessage =
  | CaptureItemMessage
  | UpdateItemClassificationMessage
  | GetTaxonomyMessage
  | CreateFolderQuickMessage
  | GetStatusSummaryMessage
  | TriggerActiveTabCaptureMessage
  | RetryDownloadTaskMessage
  | CancelDownloadTaskMessage
  | OpenLibraryPageMessage
  | OffscreenProgressMessage
  | OffscreenCompleteMessage
  | OffscreenErrorMessage;

/** Background 消息类型名联合 */
export type BackgroundRequestType = BackgroundMessage['type'];

/** Background 各消息类型对应的响应映射表 */
export interface BackgroundResponseMap {
  CAPTURE_ITEM:
    | {
        ok: true;
        itemId: string;
        taskId?: string;
        deduplicated: boolean;
        item: CollectionItemRecord;
      }
    | ErrorResult;
  UPDATE_ITEM_CLASSIFICATION:
    | { ok: true; item: CollectionItemRecord }
    | ErrorResult;
  GET_TAXONOMY:
    | { ok: true; folders: FolderNode[]; tags: TagMeta[] }
    | ErrorResult;
  CREATE_FOLDER_QUICK: { ok: true; folder: FolderNode } | ErrorResult;
  GET_STATUS_SUMMARY:
    | {
        ok: true;
        supportedPlatform: PlatformId | null;
        totalItems: number;
        stagedCount: number;
        metaDirtyCount: number;
        activeTaskCount: number;
      }
    | ErrorResult;
  TRIGGER_ACTIVE_TAB_CAPTURE: { ok: true } | ErrorResult;
  RETRY_DOWNLOAD_TASK: { ok: true } | ErrorResult;
  CANCEL_DOWNLOAD_TASK: { ok: true } | ErrorResult;
  OPEN_LIBRARY_PAGE: { ok: true };
  OFFSCREEN_PROGRESS: { ok: true };
  OFFSCREEN_COMPLETE: { ok: true };
  OFFSCREEN_ERROR: { ok: true };
}

// ============================================================================
// 2. 发往 Offscreen Document 的消息协议 (target: 'offscreen')
// ============================================================================

export interface OffscreenStartDownloadMessage {
  target: 'offscreen';
  type: 'OFFSCREEN_START_DOWNLOAD';
  taskId: string;
  itemId: string;
  platform: PlatformId;
  relativeDir: string;
  assets: MediaAsset[];
}

export interface OffscreenAbortDownloadMessage {
  target: 'offscreen';
  type: 'OFFSCREEN_ABORT_DOWNLOAD';
  taskId: string;
}

export interface OffscreenPingMessage {
  target: 'offscreen';
  type: 'OFFSCREEN_PING';
}

/** 所有发往 Offscreen Document 的消息判别联合 */
export type OffscreenMessage =
  | OffscreenStartDownloadMessage
  | OffscreenAbortDownloadMessage
  | OffscreenPingMessage;

/** Offscreen 消息类型名联合 */
export type OffscreenRequestType = OffscreenMessage['type'];

/** Offscreen 各消息类型对应的响应映射表 */
export interface OffscreenResponseMap {
  OFFSCREEN_START_DOWNLOAD: { ok: true } | ErrorResult;
  OFFSCREEN_ABORT_DOWNLOAD: { ok: true };
  OFFSCREEN_PING: { ok: true; ready: true };
}

// ============================================================================
// 3. 发往 Content Script 的消息协议 (target: 'content')
// ============================================================================

export type ContentCaptureStatusState =
  | 'queued'
  | 'downloading'
  | 'staged'
  | 'deduplicated'
  | 'failed';

export interface ContentTriggerCaptureMessage {
  target: 'content';
  type: 'CONTENT_TRIGGER_CAPTURE';
  triggerSource: CaptureTriggerSource;
}

export interface ContentCaptureStatusMessage {
  target: 'content';
  type: 'CONTENT_CAPTURE_STATUS';
  itemId: string;
  taskId?: string;
  status: ContentCaptureStatusState;
  progress?: number;
  title?: string;
  error?: string;
}

/** 所有发往 Content Script 的消息判别联合 */
export type ContentMessage =
  | ContentTriggerCaptureMessage
  | ContentCaptureStatusMessage;

/** Content Script 消息类型名联合 */
export type ContentRequestType = ContentMessage['type'];

/** Content Script 各消息类型对应的响应映射表 */
export interface ContentResponseMap {
  CONTENT_TRIGGER_CAPTURE: { ok: true } | ErrorResult;
  CONTENT_CAPTURE_STATUS: { ok: true };
}

/** Extension 内部所有跨上下文消息总联合类型 */
export type ExtensionMessage =
  | BackgroundMessage
  | OffscreenMessage
  | ContentMessage;

// ============================================================================
// 4. 运行时类型守卫
// ============================================================================

const BACKGROUND_MESSAGE_TYPES: ReadonlySet<string> = new Set<
  BackgroundRequestType
>([
  'CAPTURE_ITEM',
  'UPDATE_ITEM_CLASSIFICATION',
  'GET_TAXONOMY',
  'CREATE_FOLDER_QUICK',
  'GET_STATUS_SUMMARY',
  'TRIGGER_ACTIVE_TAB_CAPTURE',
  'RETRY_DOWNLOAD_TASK',
  'CANCEL_DOWNLOAD_TASK',
  'OPEN_LIBRARY_PAGE',
  'OFFSCREEN_PROGRESS',
  'OFFSCREEN_COMPLETE',
  'OFFSCREEN_ERROR',
]);

const OFFSCREEN_MESSAGE_TYPES: ReadonlySet<string> = new Set<
  OffscreenRequestType
>(['OFFSCREEN_START_DOWNLOAD', 'OFFSCREEN_ABORT_DOWNLOAD', 'OFFSCREEN_PING']);

const CONTENT_MESSAGE_TYPES: ReadonlySet<string> = new Set<ContentRequestType>([
  'CONTENT_TRIGGER_CAPTURE',
  'CONTENT_CAPTURE_STATUS',
]);

function isMessageObject(
  value: unknown,
): value is { target: unknown; type: unknown } {
  return typeof value === 'object' && value !== null && 'target' in value && 'type' in value;
}

/** 校验消息是否为发往 Background 的合法消息 */
export function isBackgroundMessage(
  message: unknown,
): message is BackgroundMessage {
  return (
    isMessageObject(message) &&
    message.target === 'background' &&
    typeof message.type === 'string' &&
    BACKGROUND_MESSAGE_TYPES.has(message.type)
  );
}

/** 校验消息是否为发往 Offscreen 的合法消息 */
export function isOffscreenMessage(
  message: unknown,
): message is OffscreenMessage {
  return (
    isMessageObject(message) &&
    message.target === 'offscreen' &&
    typeof message.type === 'string' &&
    OFFSCREEN_MESSAGE_TYPES.has(message.type)
  );
}

/** 校验消息是否为发往 Content Script 的合法消息 */
export function isContentMessage(message: unknown): message is ContentMessage {
  return (
    isMessageObject(message) &&
    message.target === 'content' &&
    typeof message.type === 'string' &&
    CONTENT_MESSAGE_TYPES.has(message.type)
  );
}

// ============================================================================
// 5. 强类型跨上下文发送封装
// ============================================================================

/** 向 Background Service Worker 发送强类型请求并等待响应 */
export function sendToBackground<T extends BackgroundRequestType>(
  message: Extract<BackgroundMessage, { type: T }>,
): Promise<BackgroundResponseMap[T]> {
  return chrome.runtime.sendMessage<
    Extract<BackgroundMessage, { type: T }>,
    BackgroundResponseMap[T]
  >(message);
}

/** 向 Offscreen Document 发送强类型请求并等待响应 */
export function sendToOffscreen<T extends OffscreenRequestType>(
  message: Extract<OffscreenMessage, { type: T }>,
): Promise<OffscreenResponseMap[T]> {
  return chrome.runtime.sendMessage<
    Extract<OffscreenMessage, { type: T }>,
    OffscreenResponseMap[T]
  >(message);
}

/** 向指定标签页的 Content Script 发送强类型请求并等待响应 */
export function sendToTab<T extends ContentRequestType>(
  tabId: number,
  message: Extract<ContentMessage, { type: T }>,
): Promise<ContentResponseMap[T]> {
  return chrome.tabs.sendMessage<
    Extract<ContentMessage, { type: T }>,
    ContentResponseMap[T]
  >(tabId, message);
}
