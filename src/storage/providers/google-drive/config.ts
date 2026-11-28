/**
 * Google Drive 远程持久化插件配置管理。
 *
 * 仅存储非敏感配置（授权模式、公开的 OAuth Client ID、根目录名/ID、展示用账号邮箱），
 * 严禁持久化任何 Access Token、Refresh Token 或 Client Secret。
 */

import { db, getSetting, setSetting } from '../../db.ts';

export type GoogleDriveAuthMode = 'chrome_identity' | 'web_auth_flow';

export interface GoogleDriveConfig {
  /** OAuth 授权方式：Chrome 原生 getAuthToken 或跨浏览器 launchWebAuthFlow */
  authMode: GoogleDriveAuthMode;
  /** web_auth_flow 模式下用户配置的 Google Cloud OAuth 公开 Client ID（非密钥） */
  clientId: string;
  /** Google Drive 根目录名称（默认 CollectVault） */
  rootFolderName: string;
  /** 已绑定的 Google Drive 根目录 ID（未连接时为 null） */
  rootFolderId: string | null;
  /** 已连接的 Google 账号邮箱（仅展示用） */
  accountEmail?: string;
  /** 已连接的 Google 账号昵称（仅展示用） */
  accountName?: string;
  /** 最近一次成功连接时间戳（毫秒） */
  connectedAt?: number;
}

export const DEFAULT_GOOGLE_DRIVE_ROOT_FOLDER = 'CollectVault';

export const GOOGLE_DRIVE_SCOPES = [
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/userinfo.email',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 检测扩展 Manifest 是否在构建时内置了 `oauth2.client_id`（支持原生 `chrome.identity.getAuthToken`） */
export function hasManifestGoogleOAuthClientId(): boolean {
  if (
    typeof chrome === 'undefined' ||
    !chrome.runtime ||
    typeof chrome.runtime.getManifest !== 'function'
  ) {
    return false;
  }
  try {
    const manifest: unknown = chrome.runtime.getManifest();
    if (!isRecord(manifest) || !isRecord(manifest.oauth2)) {
      return false;
    }
    const clientId = manifest.oauth2.client_id;
    return typeof clientId === 'string' && clientId.trim().length > 0;
  } catch {
    return false;
  }
}

/** 清洗 Google Drive 根目录名（剔除路径分隔符，空值回退为 CollectVault） */
export function normalizeGoogleDriveRootFolderName(name: string): string {
  const cleaned = name
    .replaceAll('/', ' ')
    .replaceAll('\\', ' ')
    .trim();
  return cleaned || DEFAULT_GOOGLE_DRIVE_ROOT_FOLDER;
}

/** 获取当前扩展的 OAuth Redirect URL（用于 Google Cloud Console 配置） */
export function getGoogleDriveRedirectUrl(): string {
  if (
    typeof chrome !== 'undefined' &&
    chrome.identity &&
    typeof chrome.identity.getRedirectURL === 'function'
  ) {
    try {
      return chrome.identity.getRedirectURL();
    } catch {
      // 回退到基于 runtime.id 拼接
    }
  }
  if (typeof chrome !== 'undefined' && chrome.runtime?.id) {
    return `https://${chrome.runtime.id}.chromiumapp.org/`;
  }
  return 'https://<extension-id>.chromiumapp.org/';
}

function parseGoogleDriveConfig(raw: unknown): GoogleDriveConfig {
  const defaultAuthMode: GoogleDriveAuthMode = hasManifestGoogleOAuthClientId()
    ? 'chrome_identity'
    : 'web_auth_flow';

  if (!isRecord(raw)) {
    return {
      authMode: defaultAuthMode,
      clientId: '',
      rootFolderName: DEFAULT_GOOGLE_DRIVE_ROOT_FOLDER,
      rootFolderId: null,
    };
  }

  const rawAuthMode = raw.authMode;
  let authMode: GoogleDriveAuthMode =
    rawAuthMode === 'chrome_identity' || rawAuthMode === 'web_auth_flow'
      ? rawAuthMode
      : defaultAuthMode;

  if (authMode === 'chrome_identity' && !hasManifestGoogleOAuthClientId()) {
    authMode = 'web_auth_flow';
  }

  const clientId = typeof raw.clientId === 'string' ? raw.clientId.trim() : '';
  const rootFolderName =
    typeof raw.rootFolderName === 'string'
      ? normalizeGoogleDriveRootFolderName(raw.rootFolderName)
      : DEFAULT_GOOGLE_DRIVE_ROOT_FOLDER;
  const rootFolderId =
    typeof raw.rootFolderId === 'string' && raw.rootFolderId.trim()
      ? raw.rootFolderId.trim()
      : null;

  const accountEmail =
    typeof raw.accountEmail === 'string' && raw.accountEmail.trim()
      ? raw.accountEmail.trim()
      : undefined;
  const accountName =
    typeof raw.accountName === 'string' && raw.accountName.trim()
      ? raw.accountName.trim()
      : undefined;
  const connectedAt =
    typeof raw.connectedAt === 'number' && Number.isFinite(raw.connectedAt)
      ? raw.connectedAt
      : undefined;

  return {
    authMode,
    clientId,
    rootFolderName,
    rootFolderId,
    ...(accountEmail !== undefined ? { accountEmail } : {}),
    ...(accountName !== undefined ? { accountName } : {}),
    ...(connectedAt !== undefined ? { connectedAt } : {}),
  };
}

/** 读取 Google Drive 插件配置 */
export async function getGoogleDriveConfig(): Promise<GoogleDriveConfig> {
  const allConfigs = await getSetting('vault_provider_configs');
  return parseGoogleDriveConfig(allConfigs?.google_drive);
}

/** 局部更新 Google Drive 插件配置 */
export async function saveGoogleDriveConfig(
  patch: Partial<GoogleDriveConfig>,
): Promise<GoogleDriveConfig> {
  return db.transaction('rw', db.settings, async () => {
    const allConfigs = (await getSetting('vault_provider_configs')) ?? {};
    const current = parseGoogleDriveConfig(allConfigs.google_drive);
    const next: GoogleDriveConfig = {
      ...current,
      ...patch,
      clientId:
        patch.clientId !== undefined ? patch.clientId.trim() : current.clientId,
      rootFolderName:
        patch.rootFolderName !== undefined
          ? normalizeGoogleDriveRootFolderName(patch.rootFolderName)
          : current.rootFolderName,
    };

    const serialized: Record<string, unknown> = {
      authMode: next.authMode,
      clientId: next.clientId,
      rootFolderName: next.rootFolderName,
      rootFolderId: next.rootFolderId,
      ...(next.accountEmail !== undefined
        ? { accountEmail: next.accountEmail }
        : {}),
      ...(next.accountName !== undefined
        ? { accountName: next.accountName }
        : {}),
      ...(next.connectedAt !== undefined
        ? { connectedAt: next.connectedAt }
        : {}),
    };

    await setSetting('vault_provider_configs', {
      ...allConfigs,
      google_drive: serialized,
    });
    return next;
  });
}

/** 清除 Google Drive 连接绑定状态（保留用户已填写的 Client ID 与根目录名以便重连） */
export async function clearGoogleDriveConnection(): Promise<GoogleDriveConfig> {
  return db.transaction('rw', db.settings, async () => {
    const allConfigs = (await getSetting('vault_provider_configs')) ?? {};
    const current = parseGoogleDriveConfig(allConfigs.google_drive);
    const next: GoogleDriveConfig = {
      authMode: current.authMode,
      clientId: current.clientId,
      rootFolderName: current.rootFolderName,
      rootFolderId: null,
    };
    await setSetting('vault_provider_configs', {
      ...allConfigs,
      google_drive: {
        authMode: next.authMode,
        clientId: next.clientId,
        rootFolderName: next.rootFolderName,
        rootFolderId: null,
      },
    });
    return next;
  });
}
