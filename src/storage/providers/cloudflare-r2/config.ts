/**
 * Cloudflare R2 对象存储持久化插件配置管理。
 *
 * 仅存储非敏感配置（S3 端点、Bucket 名称、根目录前缀、连接状态与时间），
 * 严禁将 Access Key ID 或 Secret Access Key 持久化到 IndexedDB 或任何 Vault 元数据文件。
 */

import { db, getSetting, setSetting } from '../../db.ts';
import { splitRelativePath } from '../../path.ts';

export interface CloudflareR2Config {
  /** R2 S3 API 端点（如 `https://<account-id>.r2.cloudflarestorage.com`） */
  endpoint: string;
  /** R2 存储桶名称 */
  bucket: string;
  /** 桶内 Vault 根目录前缀（默认 `CollectVault`，留空表示桶根） */
  prefix: string;
  /** 是否已完成连接绑定 */
  connected: boolean;
  /** 最近一次成功连接时间戳（毫秒） */
  connectedAt?: number;
}

export const DEFAULT_R2_PREFIX = 'CollectVault';

const R2_ENDPOINT_HOST_SUFFIX = '.r2.cloudflarestorage.com';
const ACCOUNT_ID_RE = /^[a-zA-Z0-9_-]{8,64}$/;
const BUCKET_NAME_RE = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 归一化并校验 Cloudflare R2 S3 端点。
 * 支持直接填写 Account ID（自动补全为 `https://<account-id>.r2.cloudflarestorage.com`）
 * 或填写完整 R2 端点（含区域管辖域名如 `.eu.r2.cloudflarestorage.com`）。
 */
export function normalizeR2Endpoint(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return '';
  }

  const candidate =
    !trimmed.includes('://') && !trimmed.includes('.') && ACCOUNT_ID_RE.test(trimmed)
      ? `https://${trimmed}${R2_ENDPOINT_HOST_SUFFIX}`
      : trimmed.includes('://')
        ? trimmed
        : `https://${trimmed}`;

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error('Invalid Cloudflare R2 endpoint URL.');
  }

  const host = parsed.hostname.toLowerCase();
  if (
    parsed.protocol !== 'https:' ||
    !host.endsWith(R2_ENDPOINT_HOST_SUFFIX) ||
    host.length <= R2_ENDPOINT_HOST_SUFFIX.length
  ) {
    throw new Error(
      'Cloudflare R2 endpoint must be an https://*.r2.cloudflarestorage.com URL or valid Account ID.',
    );
  }

  return `${parsed.protocol}//${parsed.host}`;
}

function tryNormalizeR2Endpoint(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim()) {
    return '';
  }
  try {
    return normalizeR2Endpoint(raw);
  } catch {
    return '';
  }
}

/** 归一化并校验 Cloudflare R2 Bucket 名称（3-63 位小写字母、数字或连字符） */
export function normalizeR2Bucket(raw: string): string {
  const trimmed = raw.trim().replace(/^\/+|\/+$/g, '');
  if (!trimmed) {
    return '';
  }
  if (!BUCKET_NAME_RE.test(trimmed)) {
    throw new Error(
      'Cloudflare R2 bucket name must be 3-63 lowercase letters, numbers, or hyphens.',
    );
  }
  return trimmed;
}

function tryNormalizeR2Bucket(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim()) {
    return '';
  }
  try {
    return normalizeR2Bucket(raw);
  } catch {
    return '';
  }
}

/** 归一化 R2 对象前缀（空字符串表示直接存放在桶根；拦截 `..` 路径穿越） */
export function normalizeR2Prefix(raw: string): string {
  const trimmed = raw.trim().replaceAll('\\', '/');
  if (!trimmed) {
    return '';
  }
  return splitRelativePath(trimmed).join('/');
}

/** 生成用于 UI 展示的目标名称（如 `my-bucket/CollectVault` 或 `my-bucket`） */
export function formatR2TargetLabel(
  config: Pick<CloudflareR2Config, 'bucket' | 'prefix'>,
): string {
  if (!config.bucket) {
    return config.prefix || DEFAULT_R2_PREFIX;
  }
  return config.prefix ? `${config.bucket}/${config.prefix}` : config.bucket;
}

/** 从 R2 端点提取脱敏后的主机摘要（仅用于 UI 展示） */
export function extractR2EndpointHost(endpoint: string): string | undefined {
  if (!endpoint) {
    return undefined;
  }
  try {
    return new URL(endpoint).host;
  } catch {
    return undefined;
  }
}

function parseCloudflareR2Config(raw: unknown): CloudflareR2Config {
  if (!isRecord(raw)) {
    return {
      endpoint: '',
      bucket: '',
      prefix: DEFAULT_R2_PREFIX,
      connected: false,
    };
  }

  const endpoint = tryNormalizeR2Endpoint(raw.endpoint);
  const bucket = tryNormalizeR2Bucket(raw.bucket);
  let prefix = DEFAULT_R2_PREFIX;
  if (typeof raw.prefix === 'string') {
    try {
      prefix = normalizeR2Prefix(raw.prefix);
    } catch {
      prefix = DEFAULT_R2_PREFIX;
    }
  }
  const connected = Boolean(raw.connected && endpoint && bucket);
  const connectedAt =
    typeof raw.connectedAt === 'number' && Number.isFinite(raw.connectedAt)
      ? raw.connectedAt
      : undefined;

  return {
    endpoint,
    bucket,
    prefix,
    connected,
    ...(connectedAt !== undefined ? { connectedAt } : {}),
  };
}

/** 读取 Cloudflare R2 非敏感配置 */
export async function getCloudflareR2Config(): Promise<CloudflareR2Config> {
  const allConfigs = await getSetting('vault_provider_configs');
  return parseCloudflareR2Config(allConfigs?.cloudflare_r2);
}

/** 局部更新 Cloudflare R2 非敏感配置 */
export async function saveCloudflareR2Config(
  patch: Partial<CloudflareR2Config>,
): Promise<CloudflareR2Config> {
  return db.transaction('rw', db.settings, async () => {
    const allConfigs = (await getSetting('vault_provider_configs')) ?? {};
    const current = parseCloudflareR2Config(allConfigs.cloudflare_r2);

    const endpoint =
      patch.endpoint !== undefined
        ? normalizeR2Endpoint(patch.endpoint)
        : current.endpoint;
    const bucket =
      patch.bucket !== undefined
        ? normalizeR2Bucket(patch.bucket)
        : current.bucket;
    const prefix =
      patch.prefix !== undefined
        ? normalizeR2Prefix(patch.prefix)
        : current.prefix;
    const connected =
      patch.connected !== undefined ? patch.connected : current.connected;
    const connectedAt =
      patch.connectedAt !== undefined ? patch.connectedAt : current.connectedAt;

    const next: CloudflareR2Config = {
      endpoint,
      bucket,
      prefix,
      connected: Boolean(connected && endpoint && bucket),
      ...(connectedAt !== undefined ? { connectedAt } : {}),
    };

    const serialized: Record<string, unknown> = {
      endpoint: next.endpoint,
      bucket: next.bucket,
      prefix: next.prefix,
      connected: next.connected,
      ...(next.connectedAt !== undefined
        ? { connectedAt: next.connectedAt }
        : {}),
    };

    await setSetting('vault_provider_configs', {
      ...allConfigs,
      cloudflare_r2: serialized,
    });
    return next;
  });
}

/** 断开连接时清除绑定状态（保留端点、Bucket 与前缀方便下次快速重连） */
export async function clearCloudflareR2Connection(): Promise<CloudflareR2Config> {
  return db.transaction('rw', db.settings, async () => {
    const allConfigs = (await getSetting('vault_provider_configs')) ?? {};
    const current = parseCloudflareR2Config(allConfigs.cloudflare_r2);
    const next: CloudflareR2Config = {
      endpoint: current.endpoint,
      bucket: current.bucket,
      prefix: current.prefix,
      connected: false,
    };
    await setSetting('vault_provider_configs', {
      ...allConfigs,
      cloudflare_r2: {
        endpoint: next.endpoint,
        bucket: next.bucket,
        prefix: next.prefix,
        connected: false,
      },
    });
    return next;
  });
}
