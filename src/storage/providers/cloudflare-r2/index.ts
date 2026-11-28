/**
 * Cloudflare R2 对象存储持久化插件独立入口。
 *
 * 导出标准 `VaultProviderPlugin` 实例及 R2 专属连接/断开操作，
 * 其余核心模块仅通过 `VaultStorageBackend` 与 `VaultProviderPlugin` 契约交互。
 */

import type {
  VaultProviderConnectionState,
  VaultProviderPlugin,
  VaultStorageBackend,
} from '../../../types/storage-provider.ts';
import { headR2Bucket } from './api.ts';
import {
  clearCloudflareR2Credentials,
  getCloudflareR2Credentials,
  handleCloudflareR2BackgroundAuthAction,
  setCloudflareR2Credentials,
} from './auth.ts';
import { CloudflareR2VaultBackend } from './backend.ts';
import {
  clearCloudflareR2Connection,
  DEFAULT_R2_PREFIX,
  extractR2EndpointHost,
  formatR2TargetLabel,
  getCloudflareR2Config,
  normalizeR2Bucket,
  normalizeR2Endpoint,
  normalizeR2Prefix,
  saveCloudflareR2Config,
  type CloudflareR2Config,
} from './config.ts';

export {
  CloudflareR2VaultBackend,
  DEFAULT_R2_PREFIX,
  extractR2EndpointHost,
  formatR2TargetLabel,
  getCloudflareR2Config,
  handleCloudflareR2BackgroundAuthAction,
  normalizeR2Bucket,
  normalizeR2Endpoint,
  normalizeR2Prefix,
  saveCloudflareR2Config,
  type CloudflareR2Config,
};

export interface ConnectCloudflareR2Input {
  endpoint: string;
  bucket: string;
  prefix: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export interface ConnectCloudflareR2Result {
  backend: CloudflareR2VaultBackend;
  config: CloudflareR2Config;
}

/**
 * 交互式连接 Cloudflare R2：
 * 1. 校验并归一化 R2 端点、Bucket 名称与目录前缀；
 * 2. 使用输入的 Access Key ID / Secret Access Key 对 Bucket 执行 `HEAD` 连通性与权限验证；
 * 3. 凭据仅存入浏览器会话（`chrome.storage.session` + 内存），非敏感配置持久化至 `vault_provider_configs`。
 */
export async function connectCloudflareR2(
  input: ConnectCloudflareR2Input,
): Promise<ConnectCloudflareR2Result> {
  const endpoint = normalizeR2Endpoint(input.endpoint);
  if (!endpoint) {
    throw new Error('Cloudflare R2 Account ID or S3 Endpoint is required.');
  }
  const bucket = normalizeR2Bucket(input.bucket);
  if (!bucket) {
    throw new Error('Cloudflare R2 Bucket name is required.');
  }
  const prefix = normalizeR2Prefix(input.prefix);
  const accessKeyId = input.accessKeyId.trim();
  const secretAccessKey = input.secretAccessKey.trim();
  if (!accessKeyId || !secretAccessKey) {
    throw new Error('Cloudflare R2 Access Key ID and Secret Access Key are required.');
  }

  await headR2Bucket({ endpoint, bucket }, { accessKeyId, secretAccessKey });

  await setCloudflareR2Credentials({
    endpoint,
    bucket,
    accessKeyId,
    secretAccessKey,
  });

  const config = await saveCloudflareR2Config({
    endpoint,
    bucket,
    prefix,
    connected: true,
    connectedAt: Date.now(),
  });

  return {
    backend: new CloudflareR2VaultBackend(config),
    config,
  };
}

/** 断开 Cloudflare R2 连接并清空会话凭据（绝不删除桶内已保存文件） */
export async function disconnectCloudflareR2(): Promise<void> {
  await clearCloudflareR2Credentials();
  await clearCloudflareR2Connection();
}

export const cloudflareR2VaultProvider: VaultProviderPlugin = {
  id: 'cloudflare_r2',
  isRemote: true,

  async getConnectionState(): Promise<VaultProviderConnectionState> {
    const config = await getCloudflareR2Config();
    const targetLabel = formatR2TargetLabel(config);
    if (!config.connected || !config.endpoint || !config.bucket) {
      return {
        providerId: 'cloudflare_r2',
        configured: false,
        permission: 'unbound',
        targetLabel,
      };
    }

    const creds = await getCloudflareR2Credentials({
      endpoint: config.endpoint,
      bucket: config.bucket,
    });
    const host = extractR2EndpointHost(config.endpoint);
    return {
      providerId: 'cloudflare_r2',
      configured: true,
      permission: creds ? 'granted' : 'prompt',
      targetLabel,
      ...(host ? { accountLabel: host } : {}),
    };
  },

  async getBackend(): Promise<VaultStorageBackend | null> {
    const config = await getCloudflareR2Config();
    if (!config.connected || !config.endpoint || !config.bucket) {
      return null;
    }
    return new CloudflareR2VaultBackend(config);
  },

  async disconnect(): Promise<void> {
    await disconnectCloudflareR2();
  },
};
