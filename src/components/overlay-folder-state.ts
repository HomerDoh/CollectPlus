/**
 * Content Script 共享前置目标文件夹状态控制器：
 * - 从后台拉取最新文件夹树与自动分类开关；
 * - 维护当前页面会话级前置锁定目录（undefined = 自动分类，null = 显式未分类，string = 指定目录）；
 * - 响应 `CONTENT_FOLDERS_UPDATED` / `CONTENT_PREFERENCES_UPDATED` 热更新，并提供 5 秒原生收藏 Toast 的分类预演。
 */

import type { CapturedPayload, CaptureTriggerSource } from '../types/adapter.ts';
import { sendToBackground } from '../types/messages.ts';
import type { FolderNode } from '../types/schema.ts';
import type { CaptureOverlaySnapshot } from './CaptureOverlay.tsx';

export interface PreviewFolderResult {
  folderId: string | null;
  folderName: string | null;
  autoClassifyEnabled: boolean;
}

export interface OverlayFolderController {
  refreshFolders: () => Promise<void>;
  applyFoldersSnapshot: (
    folders: readonly FolderNode[],
    autoClassifyEnabled: boolean,
  ) => void;
  applyAutoClassifyPreference: (autoClassifyEnabled: boolean) => void;
  setSessionFolderId: (folderId: string | null | undefined) => void;
  getSessionFolderId: () => string | null | undefined;
  /**
   * 计算本次采集应透传给 `CAPTURE_ITEM` 的三态 `folderId`：
   * - 若消息已显式传入 `explicitFolderId`（含 `null`），直接使用；
   * - Popup 触发且未传 `explicitFolderId` 时遵循 Popup 选择（自动分类），不受悬浮按钮会话锁定影响；
   * - 悬浮按钮或 `Alt+S` 触发时使用当前页会话级前置锁定目录。
   */
  resolveFolderForCapture: (
    triggerSource: CaptureTriggerSource,
    explicitFolderId?: string | null,
  ) => string | null | undefined;
  previewFolderForPayload: (
    payload: CapturedPayload,
  ) => Promise<PreviewFolderResult | null>;
}

export function createOverlayFolderController(
  updateState: (
    updater: (prev: CaptureOverlaySnapshot) => CaptureOverlaySnapshot,
  ) => void,
): OverlayFolderController {
  let sessionFolderId: string | null | undefined = undefined;
  let knownFolderIds = new Set<string>();

  const applyFoldersSnapshot = (
    folders: readonly FolderNode[],
    autoClassifyEnabled: boolean,
  ): void => {
    knownFolderIds = new Set(folders.map((f) => f.id));
    if (typeof sessionFolderId === 'string' && !knownFolderIds.has(sessionFolderId)) {
      sessionFolderId = undefined;
    }
    updateState((prev) => ({
      ...prev,
      folders,
      autoClassifyEnabled,
      sessionFolderId,
    }));
  };

  const applyAutoClassifyPreference = (autoClassifyEnabled: boolean): void => {
    updateState((prev) => ({
      ...prev,
      autoClassifyEnabled,
    }));
  };

  const refreshFolders = async (): Promise<void> => {
    try {
      const response = await sendToBackground({
        target: 'background',
        type: 'GET_CAPTURE_FOLDERS',
      });
      if (response && response.ok) {
        applyFoldersSnapshot(response.folders, response.autoClassifyEnabled);
      }
    } catch {
      // 忽略页面卸载或扩展重载期间的通信异常
    }
  };

  const setSessionFolderId = (folderId: string | null | undefined): void => {
    if (typeof folderId === 'string' && !knownFolderIds.has(folderId)) {
      sessionFolderId = undefined;
    } else {
      sessionFolderId = folderId;
    }
    updateState((prev) => ({
      ...prev,
      sessionFolderId,
    }));
  };

  const resolveFolderForCapture = (
    triggerSource: CaptureTriggerSource,
    explicitFolderId?: string | null,
  ): string | null | undefined => {
    if (explicitFolderId !== undefined) {
      return explicitFolderId;
    }
    if (triggerSource === 'popup') {
      return undefined;
    }
    if (triggerSource === 'floating_button' || triggerSource === 'hotkey') {
      return sessionFolderId;
    }
    return undefined;
  };

  const previewFolderForPayload = async (
    payload: CapturedPayload,
  ): Promise<PreviewFolderResult | null> => {
    try {
      const response = await sendToBackground({
        target: 'background',
        type: 'PREVIEW_AUTO_CLASSIFY',
        payload,
      });
      if (response && response.ok) {
        return {
          folderId: response.folderId,
          folderName: response.folderName,
          autoClassifyEnabled: response.autoClassifyEnabled,
        };
      }
    } catch {
      // 预演失败不阻断正常保存
    }
    return null;
  };

  return {
    refreshFolders,
    applyFoldersSnapshot,
    applyAutoClassifyPreference,
    setSessionFolderId,
    getSessionFolderId: () => sessionFolderId,
    resolveFolderForCapture,
    previewFolderForPayload,
  };
}
