/**
 * Cloudflare R2 对象存储持久化插件独立设置面板。
 *
 * 将 R2 端点、Bucket、前缀与会话级 Access Key / Secret Key 配置表单
 * 完全隔离在独立组件内，凭据仅写入浏览器内存会话（不落盘、不写 IndexedDB）。
 */

import { useEffect, useState } from 'react';
import {
  Cloud,
  DatabaseBackup,
  FolderSync,
  Loader2,
  LogOut,
} from 'lucide-react';
import { i18n } from '@/i18n/index.ts';
import {
  DEFAULT_R2_PREFIX,
  extractR2EndpointHost,
  formatR2TargetLabel,
  getCloudflareR2Config,
  type CloudflareR2Config,
  type ConnectCloudflareR2Input,
} from '@/storage/providers/cloudflare-r2/index.ts';
import type { VaultPermissionStatus } from '@/storage/vault.ts';
import { formatDateTime, formatRelativeTime } from '../../utils/format.ts';

export interface CloudflareR2SettingsCardProps {
  permissionState: VaultPermissionStatus;
  lastSyncAt: number | undefined;
  stagedCount: number;
  metaDirtyCount: number;
  isBusy: boolean;
  isFlushing: boolean;
  isRebuilding: boolean;
  onConnect: (input: ConnectCloudflareR2Input) => Promise<void>;
  onDisconnect: () => Promise<void>;
  onFlushToVault: () => Promise<void>;
  onOpenRebuildConfirm: () => void;
}

export function CloudflareR2SettingsCard({
  permissionState,
  lastSyncAt,
  stagedCount,
  metaDirtyCount,
  isBusy,
  isFlushing,
  isRebuilding,
  onConnect,
  onDisconnect,
  onFlushToVault,
  onOpenRebuildConfirm,
}: CloudflareR2SettingsCardProps) {
  const [config, setConfig] = useState<CloudflareR2Config | null>(null);
  const [endpointDraft, setEndpointDraft] = useState('');
  const [bucketDraft, setBucketDraft] = useState('');
  const [prefixDraft, setPrefixDraft] = useState(DEFAULT_R2_PREFIX);
  const [accessKeyIdDraft, setAccessKeyIdDraft] = useState('');
  const [secretAccessKeyDraft, setSecretAccessKeyDraft] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);

  const reloadConfig = async () => {
    const loaded = await getCloudflareR2Config();
    setConfig(loaded);
    setEndpointDraft(loaded.endpoint);
    setBucketDraft(loaded.bucket);
    setPrefixDraft(loaded.prefix);
  };

  useEffect(() => {
    void reloadConfig();
  }, [permissionState]);

  const isConnected = Boolean(config?.connected && config.endpoint && config.bucket);
  const pendingSyncCount = stagedCount + metaDirtyCount;
  const effectiveBusy = isBusy || connecting || disconnecting;
  const endpointHost = config?.endpoint
    ? extractR2EndpointHost(config.endpoint)
    : undefined;
  const canSubmitConnect =
    !effectiveBusy &&
    endpointDraft.trim().length > 0 &&
    bucketDraft.trim().length > 0 &&
    accessKeyIdDraft.trim().length > 0 &&
    secretAccessKeyDraft.trim().length > 0;

  const handleSubmitConnect = async () => {
    setConnecting(true);
    try {
      await onConnect({
        endpoint: endpointDraft.trim(),
        bucket: bucketDraft.trim(),
        prefix: prefixDraft.trim(),
        accessKeyId: accessKeyIdDraft.trim(),
        secretAccessKey: secretAccessKeyDraft.trim(),
      });
      setAccessKeyIdDraft('');
      setSecretAccessKeyDraft('');
      await reloadConfig();
    } finally {
      setConnecting(false);
    }
  };

  const handleDisconnect = async () => {
    setDisconnecting(true);
    try {
      await onDisconnect();
      setAccessKeyIdDraft('');
      setSecretAccessKeyDraft('');
      await reloadConfig();
    } finally {
      setDisconnecting(false);
    }
  };

  return (
    <div
      data-testid="r2-settings-card"
      className="flex flex-col gap-3.5 rounded border border-[var(--cp-border)] bg-[var(--cp-canvas)] p-4"
    >
      {/* 顶部连接概览与主操作 */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs text-[var(--cp-text-muted)]">
            {i18n.t('settings.r2TargetLabel')}
          </p>
          <p className="mt-1 flex flex-wrap items-center gap-2 text-sm font-semibold text-[var(--cp-text)]">
            <code
              data-testid="r2-bound-target-name"
              className="inline-flex items-center gap-1.5 rounded border border-[var(--cp-border)] bg-[var(--cp-surface)] px-2 py-0.5 text-xs font-semibold text-[var(--cp-text-active)]"
            >
              <Cloud className="h-3.5 w-3.5 text-[var(--cp-accent)]" />
              <span>
                {isConnected && config
                  ? `Cloudflare R2 / ${formatR2TargetLabel(config)}`
                  : i18n.t('settings.r2UnboundName')}
              </span>
            </code>
            {isConnected && endpointHost && (
              <span
                data-testid="r2-endpoint-badge"
                className="truncate font-mono text-xs font-normal text-[var(--cp-text-secondary)]"
              >
                {endpointHost}
              </span>
            )}
          </p>
          <p
            className="mt-1.5 text-[11px] text-[var(--cp-text-muted)]"
            title={
              lastSyncAt
                ? formatDateTime(lastSyncAt)
                : i18n.t('settings.notSyncedYet')
            }
          >
            {i18n.t('settings.lastSyncPrefix')}
            {lastSyncAt
              ? formatRelativeTime(lastSyncAt)
              : i18n.t('settings.notSyncedYet')}
            {i18n.t('settings.pendingSyncPrefix')}
            <strong
              className={
                pendingSyncCount > 0
                  ? 'text-amber-700 dark:text-amber-300'
                  : 'text-emerald-700 dark:text-emerald-300'
              }
            >
              {pendingSyncCount}
            </strong>
            {pendingSyncCount > 0
              ? i18n.t('settings.pendingSyncBreakdown', {
                  staged: stagedCount,
                  metaDirty: metaDirtyCount,
                })
              : ''}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            data-testid="r2-connect-btn"
            onClick={() => void handleSubmitConnect()}
            disabled={!canSubmitConnect}
            className="inline-flex items-center gap-1.5 rounded bg-[var(--cp-accent)] px-3 py-1.5 text-xs font-semibold text-[var(--cp-on-accent)] transition hover:bg-[var(--cp-accent-hover)] disabled:cursor-not-allowed disabled:opacity-60"
          >
            {connecting ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Cloud className="h-3.5 w-3.5" />
            )}
            <span>
              {connecting
                ? i18n.t('settings.r2Connecting')
                : isConnected
                  ? i18n.t('settings.r2ReconnectBtn')
                  : i18n.t('settings.r2ConnectBtn')}
            </span>
          </button>

          {isConnected && permissionState === 'granted' && (
            <button
              type="button"
              data-testid="r2-sync-now-btn"
              onClick={() => void onFlushToVault()}
              disabled={effectiveBusy}
              className="inline-flex items-center gap-1.5 rounded border border-[var(--cp-border)] bg-[var(--cp-surface)] px-3 py-1.5 text-xs font-medium text-[var(--cp-text-secondary)] transition hover:border-[var(--cp-border-strong)] hover:text-[var(--cp-text)] disabled:opacity-60"
            >
              {isFlushing ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <FolderSync className="h-3.5 w-3.5 text-[var(--cp-accent)]" />
              )}
              <span>
                {isFlushing
                  ? i18n.t('settings.syncing')
                  : i18n.t('settings.syncNow')}
              </span>
            </button>
          )}

          {isConnected && permissionState === 'granted' && (
            <button
              type="button"
              data-testid="r2-rebuild-btn"
              onClick={onOpenRebuildConfirm}
              disabled={effectiveBusy}
              className="inline-flex items-center gap-1.5 rounded border border-[var(--cp-border)] bg-[var(--cp-surface)] px-3 py-1.5 text-xs font-medium text-[var(--cp-text-secondary)] transition hover:border-[var(--cp-border-strong)] hover:text-[var(--cp-text)] disabled:opacity-60"
            >
              {isRebuilding ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <DatabaseBackup className="h-3.5 w-3.5 text-[var(--cp-text-muted)]" />
              )}
              <span>
                {isRebuilding
                  ? i18n.t('settings.rebuilding')
                  : i18n.t('settings.r2RebuildIndexBtn')}
              </span>
            </button>
          )}

          {isConnected && (
            <button
              type="button"
              data-testid="r2-disconnect-btn"
              onClick={() => void handleDisconnect()}
              disabled={effectiveBusy}
              className="inline-flex items-center gap-1.5 rounded border border-rose-200 bg-rose-50 px-2.5 py-1.5 text-xs font-medium text-rose-700 transition hover:bg-rose-100 disabled:opacity-60 dark:border-rose-900 dark:bg-rose-950/60 dark:text-rose-300"
            >
              {disconnecting ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <LogOut className="h-3.5 w-3.5" />
              )}
              <span>{i18n.t('settings.r2DisconnectBtn')}</span>
            </button>
          )}
        </div>
      </div>

      {/* 独立插件配置表单 */}
      <div className="grid grid-cols-1 gap-3 border-t border-[var(--cp-divider)] pt-3 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <label
            htmlFor="r2-endpoint-input"
            className="block text-[11px] font-semibold text-[var(--cp-text)]"
          >
            {i18n.t('settings.r2EndpointLabel')}
          </label>
          <input
            id="r2-endpoint-input"
            data-testid="r2-endpoint-input"
            type="text"
            value={endpointDraft}
            onChange={(e) => setEndpointDraft(e.target.value)}
            disabled={effectiveBusy}
            placeholder={i18n.t('settings.r2EndpointPlaceholder')}
            className="mt-1 w-full rounded border border-[var(--cp-border)] bg-[var(--cp-surface)] px-2.5 py-1.5 font-mono text-xs text-[var(--cp-text)] placeholder:font-sans placeholder:text-[var(--cp-text-muted)] focus:border-[var(--cp-accent)] focus:outline-none disabled:opacity-60"
          />
        </div>

        <div>
          <label
            htmlFor="r2-bucket-input"
            className="block text-[11px] font-semibold text-[var(--cp-text)]"
          >
            {i18n.t('settings.r2BucketLabel')}
          </label>
          <input
            id="r2-bucket-input"
            data-testid="r2-bucket-input"
            type="text"
            value={bucketDraft}
            onChange={(e) => setBucketDraft(e.target.value)}
            disabled={effectiveBusy}
            placeholder={i18n.t('settings.r2BucketPlaceholder')}
            className="mt-1 w-full rounded border border-[var(--cp-border)] bg-[var(--cp-surface)] px-2.5 py-1.5 font-mono text-xs text-[var(--cp-text)] placeholder:font-sans placeholder:text-[var(--cp-text-muted)] focus:border-[var(--cp-accent)] focus:outline-none disabled:opacity-60"
          />
        </div>

        <div>
          <label
            htmlFor="r2-prefix-input"
            className="block text-[11px] font-semibold text-[var(--cp-text)]"
          >
            {i18n.t('settings.r2PrefixLabel')}
          </label>
          <input
            id="r2-prefix-input"
            data-testid="r2-prefix-input"
            type="text"
            value={prefixDraft}
            onChange={(e) => setPrefixDraft(e.target.value)}
            disabled={effectiveBusy}
            placeholder={DEFAULT_R2_PREFIX}
            className="mt-1 w-full rounded border border-[var(--cp-border)] bg-[var(--cp-surface)] px-2.5 py-1.5 font-mono text-xs text-[var(--cp-text)] placeholder:font-sans placeholder:text-[var(--cp-text-muted)] focus:border-[var(--cp-accent)] focus:outline-none disabled:opacity-60"
          />
        </div>

        <div>
          <label
            htmlFor="r2-access-key-input"
            className="block text-[11px] font-semibold text-[var(--cp-text)]"
          >
            {i18n.t('settings.r2AccessKeyLabel')}
          </label>
          <input
            id="r2-access-key-input"
            data-testid="r2-access-key-input"
            type="text"
            autoComplete="off"
            value={accessKeyIdDraft}
            onChange={(e) => setAccessKeyIdDraft(e.target.value)}
            disabled={effectiveBusy}
            placeholder={i18n.t('settings.r2AccessKeyPlaceholder')}
            className="mt-1 w-full rounded border border-[var(--cp-border)] bg-[var(--cp-surface)] px-2.5 py-1.5 font-mono text-xs text-[var(--cp-text)] placeholder:font-sans placeholder:text-[var(--cp-text-muted)] focus:border-[var(--cp-accent)] focus:outline-none disabled:opacity-60"
          />
        </div>

        <div>
          <label
            htmlFor="r2-secret-key-input"
            className="block text-[11px] font-semibold text-[var(--cp-text)]"
          >
            {i18n.t('settings.r2SecretKeyLabel')}
          </label>
          <input
            id="r2-secret-key-input"
            data-testid="r2-secret-key-input"
            type="password"
            autoComplete="new-password"
            value={secretAccessKeyDraft}
            onChange={(e) => setSecretAccessKeyDraft(e.target.value)}
            disabled={effectiveBusy}
            placeholder={i18n.t('settings.r2SecretKeyPlaceholder')}
            className="mt-1 w-full rounded border border-[var(--cp-border)] bg-[var(--cp-surface)] px-2.5 py-1.5 font-mono text-xs text-[var(--cp-text)] placeholder:font-sans placeholder:text-[var(--cp-text-muted)] focus:border-[var(--cp-accent)] focus:outline-none disabled:opacity-60"
          />
        </div>
      </div>

      <p className="text-[11px] leading-relaxed text-[var(--cp-text-muted)]">
        {i18n.t('settings.r2SecurityNotice')}
      </p>
    </div>
  );
}
