/**
 * Cloudflare R2 会话级凭据管理。
 *
 * 安全红线：
 * - Access Key ID 与 Secret Access Key 仅存于内存与 `chrome.storage.session`（浏览器关闭自动销毁），
 *   严禁写入 IndexedDB、`chrome.storage.local`、`meta.json` 或控制台日志；
 * - 在 Offscreen Document 等无法直连 `chrome.storage.session` 的上下文中自动经 Background SW 代理读取。
 */

import { sendToBackground } from '../../../types/messages.ts';

export interface CloudflareR2Credentials {
  accessKeyId: string;
  secretAccessKey: string;
}

export interface CloudflareR2CredentialScope {
  endpoint: string;
  bucket: string;
}

interface StoredSessionCredentials extends CloudflareR2Credentials {
  endpoint: string;
  bucket: string;
}

const SESSION_CREDENTIALS_STORAGE_KEY = 'collect_plus_r2_session_credentials';

let inMemoryCredentials: StoredSessionCredentials | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasSessionStorageApi(): boolean {
  return (
    typeof chrome !== 'undefined' &&
    Boolean(chrome.storage?.session) &&
    typeof chrome.storage.session.get === 'function'
  );
}

function parseStoredCredentials(raw: unknown): StoredSessionCredentials | null {
  if (
    !isRecord(raw) ||
    typeof raw.accessKeyId !== 'string' ||
    typeof raw.secretAccessKey !== 'string' ||
    typeof raw.endpoint !== 'string' ||
    typeof raw.bucket !== 'string'
  ) {
    return null;
  }
  const accessKeyId = raw.accessKeyId.trim();
  const secretAccessKey = raw.secretAccessKey.trim();
  if (!accessKeyId || !secretAccessKey) {
    return null;
  }
  return {
    accessKeyId,
    secretAccessKey,
    endpoint: raw.endpoint,
    bucket: raw.bucket,
  };
}

function matchesScope(
  entry: StoredSessionCredentials,
  expected?: CloudflareR2CredentialScope,
): boolean {
  if (!expected) {
    return true;
  }
  return entry.endpoint === expected.endpoint && entry.bucket === expected.bucket;
}

async function readSessionCredentialsDirect(): Promise<StoredSessionCredentials | null> {
  if (inMemoryCredentials) {
    return inMemoryCredentials;
  }
  if (!hasSessionStorageApi()) {
    return null;
  }
  try {
    const stored = await chrome.storage.session.get(
      SESSION_CREDENTIALS_STORAGE_KEY,
    );
    const parsed = parseStoredCredentials(
      stored[SESSION_CREDENTIALS_STORAGE_KEY],
    );
    if (parsed) {
      inMemoryCredentials = parsed;
    }
    return parsed;
  } catch {
    return null;
  }
}

/** 将 Cloudflare R2 凭据写入当前浏览器会话（绝不落盘） */
export async function setCloudflareR2Credentials(
  entry: StoredSessionCredentials,
): Promise<void> {
  const normalized: StoredSessionCredentials = {
    accessKeyId: entry.accessKeyId.trim(),
    secretAccessKey: entry.secretAccessKey.trim(),
    endpoint: entry.endpoint,
    bucket: entry.bucket,
  };
  if (!normalized.accessKeyId || !normalized.secretAccessKey) {
    throw new Error('Cloudflare R2 Access Key ID and Secret Access Key are required.');
  }

  inMemoryCredentials = normalized;
  if (hasSessionStorageApi()) {
    try {
      await chrome.storage.session.set({
        [SESSION_CREDENTIALS_STORAGE_KEY]: normalized,
      });
    } catch {
      // 回退仅保留内存态
    }
  }
}

/** 读取当前会话中的 Cloudflare R2 凭据（可选校验 endpoint 与 bucket 作用域） */
export async function getCloudflareR2Credentials(
  expected?: CloudflareR2CredentialScope,
): Promise<CloudflareR2Credentials | null> {
  if (inMemoryCredentials && matchesScope(inMemoryCredentials, expected)) {
    return {
      accessKeyId: inMemoryCredentials.accessKeyId,
      secretAccessKey: inMemoryCredentials.secretAccessKey,
    };
  }

  let stored: StoredSessionCredentials | null = null;
  if (hasSessionStorageApi()) {
    stored = await readSessionCredentialsDirect();
  } else {
    try {
      const res = await sendToBackground({
        target: 'background',
        type: 'STORAGE_PROVIDER_AUTH',
        providerId: 'cloudflare_r2',
        action: 'get_token',
      });
      if (res.ok && res.token) {
        stored = parseStoredCredentials(JSON.parse(res.token));
      }
    } catch {
      stored = null;
    }
  }

  if (!stored || !matchesScope(stored, expected)) {
    return null;
  }

  inMemoryCredentials = stored;
  return {
    accessKeyId: stored.accessKeyId,
    secretAccessKey: stored.secretAccessKey,
  };
}

/** 清除当前会话中缓存的 Cloudflare R2 凭据 */
export async function clearCloudflareR2Credentials(): Promise<void> {
  inMemoryCredentials = null;
  if (hasSessionStorageApi()) {
    try {
      await chrome.storage.session.remove(SESSION_CREDENTIALS_STORAGE_KEY);
    } catch {
      // 忽略
    }
    return;
  }

  await sendToBackground({
    target: 'background',
    type: 'STORAGE_PROVIDER_AUTH',
    providerId: 'cloudflare_r2',
    action: 'clear_token',
  }).catch(() => undefined);
}

/** 供 Background Service Worker 代理 Offscreen Document 获取/清理 R2 会话凭据 */
export async function handleCloudflareR2BackgroundAuthAction(
  action: 'get_token' | 'invalidate_token' | 'clear_token',
): Promise<string | null> {
  switch (action) {
    case 'get_token': {
      const stored = await readSessionCredentialsDirect();
      return stored ? JSON.stringify(stored) : null;
    }
    case 'invalidate_token':
    case 'clear_token': {
      await clearCloudflareR2Credentials();
      return null;
    }
  }
}
