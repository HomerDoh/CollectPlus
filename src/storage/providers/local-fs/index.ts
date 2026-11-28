/**
 * 本地目录（Local File System）持久化存储插件入口。
 */

import type {
  VaultProviderConnectionState,
  VaultProviderPlugin,
  VaultStorageBackend,
} from '../../../types/storage-provider.ts';
import { getSetting } from '../../db.ts';
import {
  createLocalFsVaultBackend,
  LocalFsVaultBackend,
} from './backend.ts';

export { createLocalFsVaultBackend, LocalFsVaultBackend };

export const localFsVaultProvider: VaultProviderPlugin = {
  id: 'local_fs',
  isRemote: false,

  async getConnectionState(): Promise<VaultProviderConnectionState> {
    const handle = await getSetting('vault_directory_handle');
    if (!handle) {
      return {
        providerId: 'local_fs',
        configured: false,
        permission: 'unbound',
        targetLabel: '',
      };
    }

    let permission: VaultProviderConnectionState['permission'] = 'prompt';
    try {
      permission = await handle.queryPermission({ mode: 'readwrite' });
    } catch {
      permission = 'prompt';
    }

    return {
      providerId: 'local_fs',
      configured: true,
      permission,
      targetLabel: handle.name || 'CollectVault',
    };
  },

  async getBackend(): Promise<VaultStorageBackend | null> {
    const handle = await getSetting('vault_directory_handle');
    if (!handle) {
      return null;
    }
    return createLocalFsVaultBackend(handle);
  },
};
