/**
 * Google Drive OAuth 2.0 零后端认证模块。
 *
 * - `chrome_identity` 模式：使用 `chrome.identity.getAuthToken()`，由 Chrome 原生静默续期；
 * - `web_auth_flow` 模式：使用 `chrome.identity.launchWebAuthFlow()`，兼容 Chrome / Edge / Brave
 *   与自填 Client ID，短期 Access Token 仅存于内存与 `chrome.storage.session`（绝不落盘硬盘或 IndexedDB）；
 * - 在 Offscreen Document（无 `chrome.identity` API）中自动经 Background Service Worker 代理取 Token。
 */

import { sendToBackground } from '../../../types/messages.ts';
import {
  getGoogleDriveConfig,
  getGoogleDriveRedirectUrl,
  GOOGLE_DRIVE_SCOPES,
  hasManifestGoogleOAuthClientId,
} from './config.ts';

const SESSION_TOKEN_STORAGE_KEY = 'collect_plus_gdrive_session_token';
/** 提前 60 秒视为过期以避免请求中途 401 */
const TOKEN_EXPIRY_BUFFER_MS = 60_000;

interface CachedSessionToken {
  accessToken: string;
  expiresAt: number;
  clientId: string;
}

let inMemoryToken: CachedSessionToken | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasIdentityApi(): boolean {
  return (
    typeof chrome !== 'undefined' &&
    Boolean(chrome.identity) &&
    (typeof chrome.identity.getAuthToken === 'function' ||
      typeof chrome.identity.launchWebAuthFlow === 'function')
  );
}

function isTokenFresh(cached: CachedSessionToken, expectedClientId: string): boolean {
  return (
    cached.clientId === expectedClientId &&
    cached.accessToken.length > 0 &&
    cached.expiresAt - TOKEN_EXPIRY_BUFFER_MS > Date.now()
  );
}

async function readSessionToken(
  expectedClientId: string,
): Promise<string | null> {
  if (inMemoryToken && isTokenFresh(inMemoryToken, expectedClientId)) {
    return inMemoryToken.accessToken;
  }

  if (
    typeof chrome !== 'undefined' &&
    chrome.storage?.session &&
    typeof chrome.storage.session.get === 'function'
  ) {
    try {
      const stored = await chrome.storage.session.get(SESSION_TOKEN_STORAGE_KEY);
      const raw: unknown = stored[SESSION_TOKEN_STORAGE_KEY];
      if (
        isRecord(raw) &&
        typeof raw.accessToken === 'string' &&
        typeof raw.expiresAt === 'number' &&
        typeof raw.clientId === 'string'
      ) {
        const parsed: CachedSessionToken = {
          accessToken: raw.accessToken,
          expiresAt: raw.expiresAt,
          clientId: raw.clientId,
        };
        if (isTokenFresh(parsed, expectedClientId)) {
          inMemoryToken = parsed;
          return parsed.accessToken;
        }
      }
    } catch {
      // 忽略 session storage 不可用情况
    }
  }

  return null;
}

async function writeSessionToken(entry: CachedSessionToken): Promise<void> {
  inMemoryToken = entry;
  if (
    typeof chrome !== 'undefined' &&
    chrome.storage?.session &&
    typeof chrome.storage.session.set === 'function'
  ) {
    try {
      await chrome.storage.session.set({
        [SESSION_TOKEN_STORAGE_KEY]: entry,
      });
    } catch {
      // 仅保留内存态
    }
  }
}

async function clearSessionToken(): Promise<void> {
  inMemoryToken = null;
  if (
    typeof chrome !== 'undefined' &&
    chrome.storage?.session &&
    typeof chrome.storage.session.remove === 'function'
  ) {
    try {
      await chrome.storage.session.remove(SESSION_TOKEN_STORAGE_KEY);
    } catch {
      // 忽略
    }
  }
}

function requestChromeIdentityToken(interactive: boolean): Promise<string | null> {
  return new Promise<string | null>((resolve, reject) => {
    if (
      typeof chrome === 'undefined' ||
      !chrome.identity ||
      typeof chrome.identity.getAuthToken !== 'function'
    ) {
      reject(new Error('chrome.identity.getAuthToken is unavailable.'));
      return;
    }

    try {
      chrome.identity.getAuthToken({ interactive }, (result) => {
        const runtimeErr = chrome.runtime.lastError;
        if (runtimeErr) {
          if (!interactive) {
            resolve(null);
            return;
          }
          reject(new Error(runtimeErr.message || 'Google OAuth authorization failed.'));
          return;
        }

        if (typeof result === 'string' && result.trim()) {
          resolve(result.trim());
          return;
        }
        if (
          isRecord(result) &&
          typeof result.token === 'string' &&
          result.token.trim()
        ) {
          resolve(result.token.trim());
          return;
        }
        resolve(null);
      });
    } catch (error) {
      if (!interactive) {
        resolve(null);
      } else {
        reject(error);
      }
    }
  });
}

function removeChromeIdentityToken(token: string): Promise<void> {
  return new Promise<void>((resolve) => {
    if (
      typeof chrome === 'undefined' ||
      !chrome.identity ||
      typeof chrome.identity.removeCachedAuthToken !== 'function'
    ) {
      resolve();
      return;
    }
    try {
      chrome.identity.removeCachedAuthToken({ token }, () => {
        void chrome.runtime.lastError;
        resolve();
      });
    } catch {
      resolve();
    }
  });
}

function launchOAuthWebFlow(
  authUrl: string,
  interactive: boolean,
): Promise<string | null> {
  return new Promise<string | null>((resolve, reject) => {
    if (
      typeof chrome === 'undefined' ||
      !chrome.identity ||
      typeof chrome.identity.launchWebAuthFlow !== 'function'
    ) {
      reject(new Error('chrome.identity.launchWebAuthFlow is unavailable.'));
      return;
    }

    try {
      chrome.identity.launchWebAuthFlow({ url: authUrl, interactive }, (redirectUrl) => {
        const runtimeErr = chrome.runtime.lastError;
        if (runtimeErr) {
          if (!interactive) {
            resolve(null);
            return;
          }
          reject(new Error(runtimeErr.message || 'Google OAuth flow failed.'));
          return;
        }
        resolve(typeof redirectUrl === 'string' && redirectUrl ? redirectUrl : null);
      });
    } catch (error) {
      if (!interactive) {
        resolve(null);
      } else {
        reject(error);
      }
    }
  });
}

function parseTokenFromRedirectUrl(
  redirectUrl: string,
): { accessToken: string; expiresInSec: number } {
  const parsed = new URL(redirectUrl);
  const hashStr = parsed.hash.startsWith('#') ? parsed.hash.slice(1) : parsed.hash;
  const params = new URLSearchParams(hashStr || parsed.search);

  const error = params.get('error');
  if (error) {
    const desc = params.get('error_description');
    throw new Error(desc ? `${error}: ${desc}` : `Google OAuth error: ${error}`);
  }

  const accessToken = params.get('access_token')?.trim();
  if (!accessToken) {
    throw new Error('Google OAuth response did not contain an access token.');
  }

  const rawExpires = Number(params.get('expires_in'));
  const expiresInSec =
    Number.isFinite(rawExpires) && rawExpires > 60 ? Math.trunc(rawExpires) : 3500;

  return { accessToken, expiresInSec };
}

async function getTokenDirect(interactive: boolean): Promise<string | null> {
  const config = await getGoogleDriveConfig();

  if (config.authMode === 'chrome_identity' && hasManifestGoogleOAuthClientId()) {
    return requestChromeIdentityToken(interactive);
  }

  const clientId = config.clientId.trim();
  if (!clientId) {
    if (interactive) {
      throw new Error('Google OAuth Client ID is required before connecting.');
    }
    return null;
  }

  if (!interactive) {
    const cached = await readSessionToken(clientId);
    if (cached) {
      return cached;
    }
  }

  const redirectUri = getGoogleDriveRedirectUrl();
  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('response_type', 'token');
  authUrl.searchParams.set('scope', GOOGLE_DRIVE_SCOPES.join(' '));
  authUrl.searchParams.set('include_granted_scopes', 'true');
  authUrl.searchParams.set('prompt', interactive ? 'select_account' : 'none');

  const redirectResponse = await launchOAuthWebFlow(
    authUrl.toString(),
    interactive,
  );
  if (!redirectResponse) {
    return null;
  }

  const { accessToken, expiresInSec } =
    parseTokenFromRedirectUrl(redirectResponse);
  await writeSessionToken({
    accessToken,
    expiresAt: Date.now() + expiresInSec * 1000,
    clientId,
  });
  return accessToken;
}

/**
 * 获取有效的 Google Drive OAuth Access Token。
 *
 * - `interactive: false`：静默检查或静默刷新，未授权时返回 `null`；
 * - `interactive: true`：触发 Google 账号授权流程；
 * - 在 Offscreen Document 中自动经 Background Service Worker 代理获取。
 */
export async function getGoogleDriveAccessToken(
  interactive: boolean,
): Promise<string | null> {
  if (!hasIdentityApi()) {
    const res = await sendToBackground({
      target: 'background',
      type: 'STORAGE_PROVIDER_AUTH',
      providerId: 'google_drive',
      action: 'get_token',
      interactive,
    });
    if (!res.ok) {
      if (!interactive) {
        return null;
      }
      throw new Error(res.error);
    }
    return res.token;
  }

  return getTokenDirect(interactive);
}

/** 在收到 HTTP 401 时失效旧 Token，确保下次获取刷新 */
export async function invalidateGoogleDriveToken(token: string): Promise<void> {
  await clearSessionToken();

  if (!hasIdentityApi()) {
    await sendToBackground({
      target: 'background',
      type: 'STORAGE_PROVIDER_AUTH',
      providerId: 'google_drive',
      action: 'invalidate_token',
      token,
    }).catch(() => undefined);
    return;
  }

  const config = await getGoogleDriveConfig();
  if (config.authMode === 'chrome_identity') {
    await removeChromeIdentityToken(token);
  }
}

/** 断开连接时清空本地缓存的 Google OAuth Token */
export async function clearGoogleDriveToken(): Promise<void> {
  const existingMem = inMemoryToken?.accessToken;
  await clearSessionToken();

  if (!hasIdentityApi()) {
    await sendToBackground({
      target: 'background',
      type: 'STORAGE_PROVIDER_AUTH',
      providerId: 'google_drive',
      action: 'clear_token',
    }).catch(() => undefined);
    return;
  }

  const config = await getGoogleDriveConfig();
  if (config.authMode === 'chrome_identity') {
    const cached = await requestChromeIdentityToken(false).catch(() => null);
    if (cached) {
      await removeChromeIdentityToken(cached);
    }
  } else if (existingMem) {
    await clearSessionToken();
  }
}

/** 供 Background Service Worker 处理来自 Offscreen Document 的 Google Drive 认证代理请求 */
export async function handleGoogleDriveBackgroundAuthAction(
  action: 'get_token' | 'invalidate_token' | 'clear_token',
  interactive = false,
  token?: string,
): Promise<string | null> {
  switch (action) {
    case 'get_token':
      return getTokenDirect(interactive);
    case 'invalidate_token':
      if (token) {
        await invalidateGoogleDriveToken(token);
      } else {
        await clearSessionToken();
      }
      return null;
    case 'clear_token':
      await clearGoogleDriveToken();
      return null;
  }
}

export interface GoogleAccountProfile {
  email?: string;
  name?: string;
}

/** 拉取当前已授权 Google 账号的基础展示信息（仅 email / name） */
export async function fetchGoogleAccountProfile(
  accessToken: string,
): Promise<GoogleAccountProfile> {
  try {
    const response = await fetch(
      'https://www.googleapis.com/oauth2/v2/userinfo',
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      },
    );
    if (!response.ok) {
      return {};
    }
    const raw: unknown = await response.json();
    if (!isRecord(raw)) {
      return {};
    }
    const email =
      typeof raw.email === 'string' && raw.email.trim()
        ? raw.email.trim()
        : undefined;
    const name =
      typeof raw.name === 'string' && raw.name.trim()
        ? raw.name.trim()
        : undefined;
    return {
      ...(email !== undefined ? { email } : {}),
      ...(name !== undefined ? { name } : {}),
    };
  } catch {
    return {};
  }
}
