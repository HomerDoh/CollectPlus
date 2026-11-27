/**
 * Offscreen Document 生命周期管理器（供 Background Service Worker 使用）。
 *
 * 负责安全检测、串行化创建、PING 就绪握手及幂等关闭 Offscreen Document，
 * 避免多并发下载任务同时触发 `chrome.offscreen.createDocument` 引发冲突错误。
 */

import { sendToOffscreen } from '../types/messages.ts';
import { withActionIconRenderLock } from './action-icon.ts';

/** Offscreen Document 的相对路径（用于 `chrome.runtime.getURL` 匹配） */
export const OFFSCREEN_DOCUMENT_PATH = '/offscreen.html';

const OFFSCREEN_CREATE_URL = 'offscreen.html';
const OFFSCREEN_PING_MAX_ATTEMPTS = 5;
const OFFSCREEN_PING_RETRY_DELAY_MS = 100;

/** 模块级并发创建锁，防止多个调用方同时创建 Offscreen Document */
let creatingPromise: Promise<void> | null = null;

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

/**
 * 检测当前扩展是否已有存活的目标 Offscreen Document。
 */
export async function hasOffscreenDocument(): Promise<boolean> {
  const offscreenUrl = chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH);
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [offscreenUrl],
  });
  return contexts.length > 0;
}

/**
 * 通过带重试的 `OFFSCREEN_PING` 握手确认 Offscreen 脚本消息监听器已就绪。
 */
async function waitForOffscreenReady(): Promise<void> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= OFFSCREEN_PING_MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await sendToOffscreen({
        target: 'offscreen',
        type: 'OFFSCREEN_PING',
      });
      if (response && response.ok && response.ready) {
        return;
      }
      lastError = new Error('Unexpected OFFSCREEN_PING response.');
    } catch (error) {
      lastError = error;
    }

    if (attempt < OFFSCREEN_PING_MAX_ATTEMPTS) {
      await delay(OFFSCREEN_PING_RETRY_DELAY_MS);
    }
  }

  throw new Error(
    `Offscreen document did not respond to OFFSCREEN_PING after ${OFFSCREEN_PING_MAX_ATTEMPTS} attempts: ${getErrorMessage(lastError)}`,
  );
}

/**
 * 确保 Offscreen Document 已创建且内部消息监听器就绪。
 *
 * 并发调用将共享同一份 `creatingPromise` 锁，避免重复调用 `createDocument`。
 */
export async function ensureOffscreenDocument(): Promise<void> {
  if (creatingPromise) {
    return creatingPromise;
  }

  creatingPromise = (async () => {
    const exists = await hasOffscreenDocument();
    if (!exists) {
      await withActionIconRenderLock(async () => {
        try {
          await chrome.offscreen.createDocument({
            url: OFFSCREEN_CREATE_URL,
            reasons: ['BLOBS', 'WORKERS'],
            justification:
              'Stream media downloads to OPFS and generate offline cover thumbnails',
          });
        } catch (error) {
          // 极端竞态下可能已由其他上下文创建，复查存在性后继续握手
          const existsAfterError = await hasOffscreenDocument();
          if (!existsAfterError) {
            throw error;
          }
        }
        await waitForOffscreenReady();
      });
      return;
    }

    await waitForOffscreenReady();
  })();

  try {
    await creatingPromise;
  } finally {
    creatingPromise = null;
  }
}

/**
 * 安全关闭当前存在的 Offscreen Document；若不存在则静默返回。
 */
export async function closeOffscreenDocument(): Promise<void> {
  if (creatingPromise) {
    await creatingPromise.catch(() => undefined);
  }

  const exists = await hasOffscreenDocument();
  if (!exists) {
    return;
  }

  try {
    await chrome.offscreen.closeDocument();
  } catch (error) {
    const stillExists = await hasOffscreenDocument();
    if (stillExists) {
      throw error;
    }
  }
}
