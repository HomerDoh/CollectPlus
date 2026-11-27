import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Loader2, Trash2 } from 'lucide-react';
import { i18n } from '#i18n';
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

const REMOTE_UNCOLLECT_PLATFORMS: ReadonlySet<PlatformId> = new Set([
  'douyin',
  'bilibili',
  'xiaohongshu',
  'zhihu',
  'v2ex',
]);

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
        REMOTE_UNCOLLECT_PLATFORMS.has(item.platform) &&
        !seen.has(item.platform)
      ) {
        seen.add(item.platform);
        labels.push(platformMeta(item.platform).label);
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
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/55 p-4 backdrop-blur-[1px]"
      onClick={() => !submitting && onCancel()}
      role="dialog"
      aria-modal="true"
      aria-labelledby="delete-confirm-modal-title"
      data-testid="delete-confirm-modal"
    >
      <div
        className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3">
          <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-rose-50 text-rose-600">
            {isPermanent ? (
              <AlertTriangle className="h-5 w-5" />
            ) : (
              <Trash2 className="h-5 w-5" />
            )}
          </span>
          <div className="min-w-0 flex-1">
            <h3
              id="delete-confirm-modal-title"
              className="text-sm font-semibold text-slate-900"
            >
              {heading}
            </h3>
            {singleItem && (
              <p className="mt-1 truncate text-xs font-medium text-slate-700">
                「{singleItem.title}」
              </p>
            )}
            <p className="mt-1.5 text-xs leading-relaxed text-slate-500">
              {isPermanent
                ? syncPlatformUncollect
                  ? i18n.t('deleteModal.descPermanentWithUncollect')
                  : i18n.t('deleteModal.descPermanentKeepRemote')
                : i18n.t('deleteModal.descSoft')}
            </p>
          </div>
        </div>

        {/* 同步取消账号收藏复选框（默认勾选） */}
        <label className="mt-4 flex cursor-pointer items-start gap-2.5 rounded-xl border border-slate-200 bg-slate-50/80 p-3 transition hover:border-indigo-200 hover:bg-indigo-50/30">
          <input
            type="checkbox"
            checked={syncPlatformUncollect}
            disabled={submitting}
            onChange={(e) => setSyncPlatformUncollect(e.target.checked)}
            data-testid="delete-sync-uncollect-checkbox"
            className="mt-0.5 h-4 w-4 shrink-0 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
          />
          <div className="min-w-0 flex-1">
            <span className="block text-xs font-semibold text-slate-900">
              {i18n.t('deleteModal.syncUncollectLabel')}
            </span>
            <span className="mt-0.5 block text-[11px] leading-relaxed text-slate-500">
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
            className="rounded-lg border border-slate-200 bg-white px-3.5 py-1.5 text-xs font-medium text-slate-700 transition hover:bg-slate-50 disabled:opacity-50"
          >
            {i18n.t('common.cancel')}
          </button>
          <button
            type="button"
            onClick={() => void onConfirm(syncPlatformUncollect)}
            disabled={submitting}
            data-testid="delete-confirm-submit"
            className="inline-flex items-center gap-1.5 rounded-lg bg-rose-600 px-3.5 py-1.5 text-xs font-semibold text-white shadow-xs transition hover:bg-rose-700 disabled:opacity-60"
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
