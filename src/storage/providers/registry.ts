/**
 * Collect+ 持久化存储插件注册中心。
 *
 * 新增云存储持久化插件（如 WebDAV / S3 / OneDrive 等）时，
 * 只需在 `src/storage/providers/<provider>/` 下实现 `VaultProviderPlugin`
 * 并在此处加入 `REGISTERED_VAULT_PROVIDERS` 即可自动接入核心存储与后台同步链路。
 */

import {
  isVaultProviderId,
  type VaultProviderId,
  type VaultProviderPlugin,
  type VaultStorageBackend,
} from '../../types/storage-provider.ts';
import { getSetting, setSetting } from '../db.ts';
import { cloudflareR2VaultProvider } from './cloudflare-r2/index.ts';
import { googleDriveVaultProvider } from './google-drive/index.ts';
import { localFsVaultProvider } from './local-fs/index.ts';

/** 所有已注册的持久化存储插件列表 */
export const REGISTERED_VAULT_PROVIDERS: readonly VaultProviderPlugin[] = [
  localFsVaultProvider,
  googleDriveVaultProvider,
  cloudflareR2VaultProvider,
];

const PROVIDER_BY_ID: ReadonlyMap<VaultProviderId, VaultProviderPlugin> =
  new Map(REGISTERED_VAULT_PROVIDERS.map((p) => [p.id, p]));

/** 默认持久化存储插件（向后兼容现有本地目录模式） */
export const DEFAULT_VAULT_PROVIDER_ID: VaultProviderId = 'local_fs';

/** 按 ID 获取已注册的存储插件 */
export function getVaultProvider(id: VaultProviderId): VaultProviderPlugin {
  const found = PROVIDER_BY_ID.get(id);
  if (!found) {
    throw new Error(`Vault storage provider "${id}" is not registered.`);
  }
  return found;
}

/** 列出全部已注册的持久化存储插件 */
export function listVaultProviders(): readonly VaultProviderPlugin[] {
  return REGISTERED_VAULT_PROVIDERS;
}

/** 读取当前启用的持久化存储插件 ID（缺省返回 `'local_fs'`） */
export async function getActiveVaultProviderId(): Promise<VaultProviderId> {
  const saved = await getSetting('active_vault_provider');
  return isVaultProviderId(saved) ? saved : DEFAULT_VAULT_PROVIDER_ID;
}

/** 切换当前启用的持久化存储插件 ID */
export async function setActiveVaultProviderId(
  providerId: VaultProviderId,
): Promise<void> {
  await setSetting('active_vault_provider', providerId);
}

/** 获取当前启用的存储插件实例 */
export async function getActiveVaultProvider(): Promise<VaultProviderPlugin> {
  const id = await getActiveVaultProviderId();
  return getVaultProvider(id);
}

/** 获取当前启用存储插件对应的后端实例（未绑定/未配置时返回 `null`） */
export async function getActiveVaultBackend(): Promise<VaultStorageBackend | null> {
  const provider = await getActiveVaultProvider();
  return provider.getBackend();
}

/** 判断当前启用的持久化目标是否已完成绑定/配置（用于 Popup 未配置提示判断） */
export async function hasConfiguredActiveVault(): Promise<boolean> {
  const provider = await getActiveVaultProvider();
  const state = await provider.getConnectionState();
  return state.configured;
}
