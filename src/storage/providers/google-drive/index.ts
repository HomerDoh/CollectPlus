/**
 * Google Drive 远程持久化插件独立入口。
 *
 * 导出标准 `VaultProviderPlugin` 实例及 Google Drive 专属的连接/断开操作，
 * 其余核心模块仅通过 `VaultStorageBackend` 与 `VaultProviderPlugin` 契约交互。
 */

import type {
  VaultProviderConnectionState,
  VaultProviderPlugin,
  VaultStorageBackend,
} from '../../../types/storage-provider.ts';
import {
  createDriveFolder,
  DRIVE_FOLDER_MIME,
  findDriveChild,
  getDriveFileMetadata,
} from './api.ts';
import {
  clearGoogleDriveToken,
  fetchGoogleAccountProfile,
  getGoogleDriveAccessToken,
  handleGoogleDriveBackgroundAuthAction,
} from './auth.ts';
import {
  clearGoogleDrivePathCache,
  GoogleDriveVaultBackend,
} from './backend.ts';
import {
  clearGoogleDriveConnection,
  DEFAULT_GOOGLE_DRIVE_ROOT_FOLDER,
  getGoogleDriveConfig,
  getGoogleDriveRedirectUrl,
  hasManifestGoogleOAuthClientId,
  normalizeGoogleDriveRootFolderName,
  saveGoogleDriveConfig,
  type GoogleDriveAuthMode,
  type GoogleDriveConfig,
} from './config.ts';

export {
  clearGoogleDrivePathCache,
  DEFAULT_GOOGLE_DRIVE_ROOT_FOLDER,
  getGoogleDriveConfig,
  getGoogleDriveRedirectUrl,
  GoogleDriveVaultBackend,
  handleGoogleDriveBackgroundAuthAction,
  hasManifestGoogleOAuthClientId,
  normalizeGoogleDriveRootFolderName,
  saveGoogleDriveConfig,
  type GoogleDriveAuthMode,
  type GoogleDriveConfig,
};

export interface ConnectGoogleDriveInput {
  authMode: GoogleDriveAuthMode;
  clientId: string;
  rootFolderName: string;
}

export interface ConnectGoogleDriveResult {
  backend: GoogleDriveVaultBackend;
  config: GoogleDriveConfig;
  isExistingRootFolder: boolean;
}

/**
 * 交互式连接 Google Drive：
 * 1. 保存非敏感配置（授权模式、公开 Client ID、根目录名）；
 * 2. 执行 OAuth 2.0 授权（仅 `drive.file` + `userinfo.email`）；
 * 3. 在 Google Drive 根目录查找或创建同名 `CollectVault` 文件夹；
 * 4. 持久化非敏感绑定状态并返回就绪的 `GoogleDriveVaultBackend`。
 */
export async function connectGoogleDrive(
  input: ConnectGoogleDriveInput,
): Promise<ConnectGoogleDriveResult> {
  const normalizedFolderName = normalizeGoogleDriveRootFolderName(
    input.rootFolderName,
  );
  await saveGoogleDriveConfig({
    authMode: input.authMode,
    clientId: input.clientId,
    rootFolderName: normalizedFolderName,
  });

  const accessToken = await getGoogleDriveAccessToken(true);
  if (!accessToken) {
    throw new Error('Google Drive authorization was cancelled or denied.');
  }

  const [profile, existingConfig] = await Promise.all([
    fetchGoogleAccountProfile(accessToken),
    getGoogleDriveConfig(),
  ]);

  let rootFolderId: string | null = null;
  let isExistingRootFolder = false;

  // 若此前已绑定过同名文件夹且在云端仍存在，直接复用
  if (
    existingConfig.rootFolderId &&
    existingConfig.rootFolderName === normalizedFolderName
  ) {
    const existingMeta = await getDriveFileMetadata(
      existingConfig.rootFolderId,
      'id, name, mimeType',
    );
    if (existingMeta && existingMeta.mimeType === DRIVE_FOLDER_MIME) {
      rootFolderId = existingMeta.id;
      isExistingRootFolder = true;
    }
  }

  if (!rootFolderId) {
    const found = await findDriveChild(
      'root',
      normalizedFolderName,
      DRIVE_FOLDER_MIME,
    );
    if (found) {
      rootFolderId = found.id;
      isExistingRootFolder = true;
    } else {
      const created = await createDriveFolder('root', normalizedFolderName, {
        collectVaultRoot: '1',
      });
      rootFolderId = created.id;
      isExistingRootFolder = false;
    }
  }

  await clearGoogleDrivePathCache();

  const updatedConfig = await saveGoogleDriveConfig({
    authMode: input.authMode,
    clientId: input.clientId,
    rootFolderName: normalizedFolderName,
    rootFolderId,
    ...(profile.email !== undefined ? { accountEmail: profile.email } : {}),
    ...(profile.name !== undefined ? { accountName: profile.name } : {}),
    connectedAt: Date.now(),
  });

  const backend = new GoogleDriveVaultBackend(
    rootFolderId,
    updatedConfig.rootFolderName,
  );

  return {
    backend,
    config: updatedConfig,
    isExistingRootFolder,
  };
}

/** 断开 Google Drive 绑定并清理本地会话 Token 与路径缓存（绝不删除云端文件） */
export async function disconnectGoogleDrive(): Promise<void> {
  await clearGoogleDriveToken();
  await clearGoogleDrivePathCache();
  await clearGoogleDriveConnection();
}

export const googleDriveVaultProvider: VaultProviderPlugin = {
  id: 'google_drive',
  isRemote: true,

  async getConnectionState(): Promise<VaultProviderConnectionState> {
    const config = await getGoogleDriveConfig();
    if (!config.rootFolderId) {
      return {
        providerId: 'google_drive',
        configured: false,
        permission: 'unbound',
        targetLabel: config.rootFolderName,
      };
    }

    const token = await getGoogleDriveAccessToken(false).catch(() => null);
    return {
      providerId: 'google_drive',
      configured: true,
      permission: token ? 'granted' : 'prompt',
      targetLabel: config.rootFolderName,
      ...(config.accountEmail
        ? { accountLabel: config.accountEmail }
        : config.accountName
          ? { accountLabel: config.accountName }
          : {}),
    };
  },

  async getBackend(): Promise<VaultStorageBackend | null> {
    const config = await getGoogleDriveConfig();
    if (!config.rootFolderId) {
      return null;
    }
    return new GoogleDriveVaultBackend(
      config.rootFolderId,
      config.rootFolderName,
    );
  },

  async disconnect(): Promise<void> {
    await disconnectGoogleDrive();
  },
};
