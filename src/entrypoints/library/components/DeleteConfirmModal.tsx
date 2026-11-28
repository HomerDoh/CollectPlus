import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Loader2, Trash2 } from 'lucide-react';
import { getRemoteUncollectEntryUrl } from '@/adapters/registry.ts';
import { i18n } from '@/i18n/index.ts';
import type { CollectionItemRecord, PlatformId } from '@/types/schema.ts';
import { platformMeta } from '../utils/format.ts';

export type DeleteConfirmMode = 'soft' | 'permanent';

export interface DeleteConfirmModalProps {
  items: readonly CollectionItemRecord[];
  mode: DeleteConfirmMode;
  submitting: boolean;
  onCancel: () => void;
  onConfirm: (syncPlatformUncollect: boolean) => Promise<void>;
}

export function DeleteConfirmModal({
  items,
  mode,
  submitting,
  onCancel,
  onConfirm,
}: DeleteConfirmModalProps) {
  // 默认勾选同步取消原平台账号的收藏
  const [syncPlatformUncollect, setSyncPlatformUncollect] = useState(true);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !submitting) {
        event.preventDefault();
        onCancel();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onCancel, submitting]);

  const supportedPlatformLabels = useMemo(() => {
    const seen = new Set<PlatformId>();
    const labels: string[] = [];
    for (const item of items) {
      if (
        getRemoteUncollectEntryUrl(item.platform) !== undefined &&
        !seen.has(item.platform)
      ) {
        seen.add(item.platform);
        labels.push(platformMeta(item.platform, item.platformExtra).label);
      }
    }
    return labels;
  }, [items]);

  const count = items.length;
  const singleItem = count === 1 ? items[0] : undefined;
  const isPermanent = mode === 'permanent';

  const heading = isPermanent
    ? count === 1
      ? i18n.t('deleteModal.headingPermanentSingle')
      : i18n.t('deleteModal.headingPermanentMulti', { count })
    : count === 1
      ? i18n.t('deleteModal.headingSoftSingle')
      : i18n.t('deleteModal.headingSoftMulti', { count });

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--cp-scrim)] p-4"
      onClick={() => !submitting && onCancel()}
      role="dialog"
      aria-modal="true"
      aria-labelledby="delete-confirm-modal-title"
      data-testid="delete-confirm-modal"
    >
      <div
        className="w-full max-w-md rounded-md border border-[var(--cp-border-strong)] bg-[var(--cp-surface)] p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3">
          <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded bg-rose-50 text-rose-600 dark:bg-rose-950/70 dark:text-rose-400">
            {isPermanent ? (
              <AlertTriangle className="h-5 w-5" />
            ) : (
              <Trash2 className="h-5 w-5" />
            )}
          </span>
          <div className="min-w-0 flex-1">
            <h3
              id="delete-confirm-modal-title"
              className="text-sm font-semibold text-[var(--cp-text)]"
            >
              {heading}
            </h3>
            {singleItem && (
              <p className="mt-1 truncate text-xs font-medium text-[var(--cp-text-secondary)]">
                「{singleItem.title}」
              </p>
            )}
            <p className="mt-1.5 text-xs leading-relaxed text-[var(--cp-text-muted)]">
              {isPermanent
                ? syncPlatformUncollect
                  ? i18n.t('deleteModal.descPermanentWithUncollect')
                  : i18n.t('deleteModal.descPermanentKeepRemote')
                : i18n.t('deleteModal.descSoft')}
            </p>
          </div>
        </div>

        {/* 同步取消账号收藏复选框（默认勾选） */}
        <label className="mt-4 flex cursor-pointer items-start gap-2.5 rounded border border-[var(--cp-border)] bg-[var(--cp-muted)] p-3 transition hover:border-[var(--cp-accent)]">
          <input
            type="checkbox"
            checked={syncPlatformUncollect}
            disabled={submitting}
            onChange={(e) => setSyncPlatformUncollect(e.target.checked)}
            data-testid="delete-sync-uncollect-checkbox"
            className="mt-0.5 h-4 w-4 shrink-0 rounded border-[var(--cp-border-strong)] accent-[var(--cp-accent)]"
          />
          <div className="min-w-0 flex-1">
            <span className="block text-xs font-semibold text-[var(--cp-text)]">
              {i18n.t('deleteModal.syncUncollectLabel')}
            </span>
            <span className="mt-0.5 block text-[11px] leading-relaxed text-[var(--cp-text-muted)]">
              {supportedPlatformLabels.length > 0
                ? i18n.t('deleteModal.syncUncollectSupportedDesc', {
                    platforms: supportedPlatformLabels.join(
                      i18n.t('common.listSeparator'),
                    ),
                  })
                : i18n.t('deleteModal.syncUncollectUnsupportedDesc')}
            </span>
          </div>
        </label>

        <div className="mt-5 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={submitting}
            className="rounded border border-[var(--cp-border)] bg-[var(--cp-surface)] px-3.5 py-1.5 text-xs font-medium text-[var(--cp-text-secondary)] transition hover:border-[var(--cp-border-strong)] hover:text-[var(--cp-text)] disabled:opacity-50"
          >
            {i18n.t('common.cancel')}
          </button>
          <button
            type="button"
            onClick={() => void onConfirm(syncPlatformUncollect)}
            disabled={submitting}
            data-testid="delete-confirm-submit"
            className="inline-flex items-center gap-1.5 rounded bg-rose-600 px-3.5 py-1.5 text-xs font-semibold text-white transition hover:bg-rose-700 disabled:opacity-60"
          >
            {submitting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            <span>
              {submitting
                ? syncPlatformUncollect && supportedPlatformLabels.length > 0
                  ? i18n.t('deleteModal.submittingWithUncollect')
                  : i18n.t('deleteModal.submitting')
                : isPermanent
                  ? i18n.t('deleteModal.confirmPermanent')
                  : i18n.t('deleteModal.confirmSoft')}
            </span>
          </button>
        </div>
      </div>
    </div>
  );
}
