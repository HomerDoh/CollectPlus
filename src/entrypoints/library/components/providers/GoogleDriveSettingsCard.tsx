/**
 * Google Drive 远程持久化插件独立设置面板。
 *
 * 将 Google Drive 的认证模式、Client ID、Redirect URI 与根目录名配置
 * 完全隔离在独立组件内，便于后续横向新增 WebDAV / S3 / OneDrive 等插件卡片。
 */

import { useEffect, useState } from 'react';
import {
  Check,
  Cloud,
  Copy,
  DatabaseBackup,
  FolderSync,
  Loader2,
  LogOut,
  ShieldCheck,
} from 'lucide-react';
import { i18n } from '@/i18n/index.ts';
import {
  DEFAULT_GOOGLE_DRIVE_ROOT_FOLDER,
  getGoogleDriveConfig,
  getGoogleDriveRedirectUrl,
  hasManifestGoogleOAuthClientId,
  type ConnectGoogleDriveInput,
  type GoogleDriveAuthMode,
  type GoogleDriveConfig,
} from '@/storage/providers/google-drive/index.ts';
import type { VaultPermissionStatus } from '@/storage/vault.ts';
import { formatDateTime, formatRelativeTime } from '../../utils/format.ts';

export interface GoogleDriveSettingsCardProps {
  permissionState: VaultPermissionStatus;
  lastSyncAt: number | undefined;
  stagedCount: number;
  metaDirtyCount: number;
  isBusy: boolean;
  isFlushing: boolean;
  isRebuilding: boolean;
  onConnect: (input: ConnectGoogleDriveInput) => Promise<void>;
  onDisconnect: () => Promise<void>;
  onRequestPermissionAndSync: () => Promise<void>;
  onFlushToVault: () => Promise<void>;
  onOpenRebuildConfirm: () => void;
}

export function GoogleDriveSettingsCard({
  permissionState,
  lastSyncAt,
  stagedCount,
  metaDirtyCount,
  isBusy,
  isFlushing,
  isRebuilding,
  onConnect,
  onDisconnect,
  onRequestPermissionAndSync,
  onFlushToVault,
  onOpenRebuildConfirm,
}: GoogleDriveSettingsCardProps) {
  const hasManifestOAuth = hasManifestGoogleOAuthClientId();
  const redirectUrl = getGoogleDriveRedirectUrl();

  const [config, setConfig] = useState<GoogleDriveConfig | null>(null);
  const [authMode, setAuthMode] = useState<GoogleDriveAuthMode>(
    hasManifestOAuth ? 'chrome_identity' : 'web_auth_flow',
  );
  const [clientIdDraft, setClientIdDraft] = useState('');
  const [rootFolderDraft, setRootFolderDraft] = useState(
    DEFAULT_GOOGLE_DRIVE_ROOT_FOLDER,
  );
  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [copiedRedirect, setCopiedRedirect] = useState(false);

  const reloadConfig = async () => {
    const loaded = await getGoogleDriveConfig();
    setConfig(loaded);
    setAuthMode(loaded.authMode);
    setClientIdDraft(loaded.clientId);
    setRootFolderDraft(loaded.rootFolderName);
  };

  useEffect(() => {
    void reloadConfig();
  }, [permissionState]);

  const isConnected = Boolean(config?.rootFolderId);
  const pendingSyncCount = stagedCount + metaDirtyCount;
  const effectiveBusy = isBusy || connecting || disconnecting;

  const handleCopyRedirect = async () => {
    try {
      await navigator.clipboard.writeText(redirectUrl);
      setCopiedRedirect(true);
      window.setTimeout(() => setCopiedRedirect(false), 1800);
    } catch {
      // 剪贴板不可用时静默忽略
    }
  };

  const handleSubmitConnect = async () => {
    setConnecting(true);
    try {
      await onConnect({
        authMode,
        clientId: clientIdDraft.trim(),
        rootFolderName: rootFolderDraft.trim() || DEFAULT_GOOGLE_DRIVE_ROOT_FOLDER,
      });
      await reloadConfig();
    } finally {
      setConnecting(false);
    }
  };

  const handleDisconnect = async () => {
    setDisconnecting(true);
    try {
      await onDisconnect();
      await reloadConfig();
    } finally {
      setDisconnecting(false);
    }
  };

  return (
    <div
      data-testid="gdrive-settings-card"
      className="flex flex-col gap-3.5 rounded border border-[var(--cp-border)] bg-[var(--cp-canvas)] p-4"
    >
      {/* 顶部连接概览与主操作 */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs text-[var(--cp-text-muted)]">
            {i18n.t('settings.gdriveTargetLabel')}
          </p>
          <p className="mt-1 flex flex-wrap items-center gap-2 text-sm font-semibold text-[var(--cp-text)]">
            <code
              data-testid="gdrive-bound-folder-name"
              className="inline-flex items-center gap-1.5 rounded border border-[var(--cp-border)] bg-[var(--cp-surface)] px-2 py-0.5 text-xs font-semibold text-[var(--cp-text-active)]"
            >
              <Cloud className="h-3.5 w-3.5 text-[var(--cp-accent)]" />
              <span>
                {isConnected
                  ? `Google Drive / ${config?.rootFolderName ?? DEFAULT_GOOGLE_DRIVE_ROOT_FOLDER}`
                  : i18n.t('settings.gdriveUnboundName')}
              </span>
            </code>
            {isConnected && (config?.accountEmail || config?.accountName) && (
              <span
                data-testid="gdrive-account-badge"
                className="truncate text-xs font-normal text-[var(--cp-text-secondary)]"
              >
                {config.accountEmail ?? config.accountName}
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
            data-testid="gdrive-connect-btn"
            onClick={() => void handleSubmitConnect()}
            disabled={
              effectiveBusy ||
              (authMode === 'web_auth_flow' && clientIdDraft.trim().length === 0)
            }
            className="inline-flex items-center gap-1.5 rounded bg-[var(--cp-accent)] px-3 py-1.5 text-xs font-semibold text-[var(--cp-on-accent)] transition hover:bg-[var(--cp-accent-hover)] disabled:cursor-not-allowed disabled:opacity-60"
          >
            {connecting ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Cloud className="h-3.5 w-3.5" />
            )}
            <span>
              {connecting
                ? i18n.t('settings.gdriveConnecting')
                : isConnected
                  ? i18n.t('settings.gdriveReconnectBtn')
                  : i18n.t('settings.gdriveConnectBtn')}
            </span>
          </button>

          {isConnected && permissionState !== 'granted' && (
            <button
              type="button"
              onClick={() => void onRequestPermissionAndSync()}
              disabled={effectiveBusy}
              className="inline-flex items-center gap-1.5 rounded border border-[var(--cp-border-strong)] bg-[var(--cp-active)] px-3 py-1.5 text-xs font-semibold text-[var(--cp-text-active)] transition hover:border-[var(--cp-accent)] disabled:opacity-60"
            >
              <ShieldCheck className="h-3.5 w-3.5" />
              <span>{i18n.t('settings.authorizeAndSync')}</span>
            </button>
          )}

          {isConnected && permissionState === 'granted' && (
            <button
              type="button"
              data-testid="gdrive-sync-now-btn"
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

          {isConnected && (
            <button
              type="button"
              data-testid="gdrive-rebuild-btn"
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
                  : i18n.t('settings.gdriveRebuildIndexBtn')}
              </span>
            </button>
          )}

          {isConnected && (
            <button
              type="button"
              data-testid="gdrive-disconnect-btn"
              onClick={() => void handleDisconnect()}
              disabled={effectiveBusy}
              className="inline-flex items-center gap-1.5 rounded border border-rose-200 bg-rose-50 px-2.5 py-1.5 text-xs font-medium text-rose-700 transition hover:bg-rose-100 disabled:opacity-60 dark:border-rose-900 dark:bg-rose-950/60 dark:text-rose-300"
            >
              {disconnecting ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <LogOut className="h-3.5 w-3.5" />
              )}
              <span>{i18n.t('settings.gdriveDisconnectBtn')}</span>
            </button>
          )}
        </div>
      </div>

      {/* 独立插件配置表单 */}
      <div className="grid grid-cols-1 gap-3 border-t border-[var(--cp-divider)] pt-3 sm:grid-cols-2">
        {hasManifestOAuth && (
          <div className="sm:col-span-2">
            <p className="text-[11px] font-semibold text-[var(--cp-text)]">
              {i18n.t('settings.gdriveAuthModeLabel')}
            </p>
            <div className="mt-1.5 inline-flex rounded border border-[var(--cp-border)] bg-[var(--cp-muted)] p-0.5">
              {(
                [
                  {
                    value: 'chrome_identity',
                    label: i18n.t('settings.gdriveAuthModeChrome'),
                  },
                  {
                    value: 'web_auth_flow',
                    label: i18n.t('settings.gdriveAuthModeWebFlow'),
                  },
                ] as const
              ).map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setAuthMode(opt.value)}
                  disabled={effectiveBusy}
                  className={`rounded px-2.5 py-1 text-xs font-medium transition ${
                    authMode === opt.value
                      ? 'bg-[var(--cp-surface)] font-semibold text-[var(--cp-text-active)]'
                      : 'text-[var(--cp-text-secondary)] hover:text-[var(--cp-text)]'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
        )}

        <div>
          <label
            htmlFor="gdrive-root-folder-input"
            className="block text-[11px] font-semibold text-[var(--cp-text)]"
          >
            {i18n.t('settings.gdriveRootFolderLabel')}
          </label>
          <input
            id="gdrive-root-folder-input"
            data-testid="gdrive-root-folder-input"
            type="text"
            value={rootFolderDraft}
            onChange={(e) => setRootFolderDraft(e.target.value)}
            disabled={effectiveBusy}
            placeholder={DEFAULT_GOOGLE_DRIVE_ROOT_FOLDER}
            className="mt-1 w-full rounded border border-[var(--cp-border)] bg-[var(--cp-surface)] px-2.5 py-1.5 text-xs text-[var(--cp-text)] placeholder:text-[var(--cp-text-muted)] focus:border-[var(--cp-accent)] focus:outline-none disabled:opacity-60"
          />
        </div>

        {authMode === 'web_auth_flow' && (
          <div>
            <label
              htmlFor="gdrive-client-id-input"
              className="block text-[11px] font-semibold text-[var(--cp-text)]"
            >
              {i18n.t('settings.gdriveClientIdLabel')}
            </label>
            <input
              id="gdrive-client-id-input"
              data-testid="gdrive-client-id-input"
              type="text"
              value={clientIdDraft}
              onChange={(e) => setClientIdDraft(e.target.value)}
              disabled={effectiveBusy}
              placeholder={i18n.t('settings.gdriveClientIdPlaceholder')}
              className="mt-1 w-full rounded border border-[var(--cp-border)] bg-[var(--cp-surface)] px-2.5 py-1.5 font-mono text-xs text-[var(--cp-text)] placeholder:font-sans placeholder:text-[var(--cp-text-muted)] focus:border-[var(--cp-accent)] focus:outline-none disabled:opacity-60"
            />
          </div>
        )}

        {authMode === 'web_auth_flow' && (
          <div className="sm:col-span-2">
            <div className="flex flex-wrap items-center justify-between gap-2 rounded border border-[var(--cp-border)] bg-[var(--cp-surface)] px-2.5 py-1.5">
              <div className="min-w-0 flex-1">
                <span className="block text-[10px] font-medium text-[var(--cp-text-muted)]">
                  {i18n.t('settings.gdriveRedirectUriLabel')}
                </span>
                <code className="block truncate font-mono text-[11px] text-[var(--cp-text-secondary)]">
                  {redirectUrl}
                </code>
              </div>
              <button
                type="button"
                onClick={() => void handleCopyRedirect()}
                className="inline-flex shrink-0 items-center gap-1 rounded border border-[var(--cp-border)] bg-[var(--cp-canvas)] px-2 py-1 text-[11px] font-medium text-[var(--cp-text-secondary)] transition hover:border-[var(--cp-accent)] hover:text-[var(--cp-text)]"
              >
                {copiedRedirect ? (
                  <>
                    <Check className="h-3 w-3 text-emerald-600" />
                    <span>{i18n.t('settings.gdriveCopied')}</span>
                  </>
                ) : (
                  <>
                    <Copy className="h-3 w-3" />
                    <span>{i18n.t('settings.gdriveCopyBtn')}</span>
                  </>
                )}
              </button>
            </div>
          </div>
        )}
      </div>

      <p className="text-[11px] leading-relaxed text-[var(--cp-text-muted)]">
        {i18n.t('settings.gdriveScopeNotice')}
      </p>
    </div>
  );
}
