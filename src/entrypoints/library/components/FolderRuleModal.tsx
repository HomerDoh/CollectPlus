import { useEffect, useState } from 'react';
import { Loader2, SlidersHorizontal, X } from 'lucide-react';
import { getAllAdapters } from '@/adapters/registry.ts';
import { i18n } from '@/i18n/index.ts';
import {
  normalizeFolderAutoRule,
  type FolderAutoRule,
  type FolderNode,
  type PlatformId,
} from '@/types/schema.ts';
import { platformMeta } from '../utils/format.ts';

function formatListInput(values?: readonly string[]): string {
  return values && values.length > 0 ? values.join(', ') : '';
}

function parseListInput(raw: string): string[] {
  return raw
    .split(/[\n,，、]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

export interface FolderRuleModalProps {
  folder: FolderNode;
  onClose: () => void;
  onSave: (
    folderId: string,
    autoRule: FolderAutoRule | undefined,
  ) => Promise<void>;
}

export function FolderRuleModal({
  folder,
  onClose,
  onSave,
}: FolderRuleModalProps) {
  const [keywordsText, setKeywordsText] = useState(() =>
    formatListInput(folder.autoRule?.keywords),
  );
  const [tagsText, setTagsText] = useState(() =>
    formatListInput(folder.autoRule?.tags),
  );
  const [authorsText, setAuthorsText] = useState(() =>
    formatListInput(folder.autoRule?.authors),
  );
  const [selectedPlatforms, setSelectedPlatforms] = useState<
    ReadonlySet<PlatformId>
  >(() => new Set(folder.autoRule?.platforms ?? []));
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !submitting) {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose, submitting]);

  const togglePlatform = (platform: PlatformId) => {
    setSelectedPlatforms((prev) => {
      const next = new Set(prev);
      if (next.has(platform)) {
        next.delete(platform);
      } else {
        next.add(platform);
      }
      return next;
    });
  };

  const handleSubmit = async (clear = false) => {
    if (submitting) {
      return;
    }
    setSubmitting(true);
    try {
      const rule = clear
        ? undefined
        : normalizeFolderAutoRule({
            keywords: parseListInput(keywordsText),
            tags: parseListInput(tagsText),
            authors: parseListInput(authorsText),
            platforms: Array.from(selectedPlatforms),
          });
      await onSave(folder.id, rule);
      onClose();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--cp-scrim)] p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="folder-rule-modal-title"
      data-testid="folder-rule-modal"
      onClick={() => {
        if (!submitting) {
          onClose();
        }
      }}
    >
      <div
        className="w-full max-w-lg rounded border border-[var(--cp-border)] bg-[var(--cp-surface)] shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 顶部标题 */}
        <div className="flex items-start justify-between gap-3 border-b border-[var(--cp-border)] px-5 py-4">
          <div className="flex items-start gap-2.5">
            <span className="mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded bg-[var(--cp-active)] text-[var(--cp-accent)]">
              <SlidersHorizontal className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <h2
                id="folder-rule-modal-title"
                className="text-sm font-semibold text-[var(--cp-text)]"
              >
                {i18n.t('folderRuleModal.title', { name: folder.name })}
              </h2>
              <p className="mt-0.5 text-xs text-[var(--cp-text-muted)]">
                {i18n.t('folderRuleModal.subtitle')}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            aria-label={i18n.t('folderRuleModal.closeAria')}
            className="rounded p-1 text-[var(--cp-text-muted)] transition hover:bg-[var(--cp-muted)] hover:text-[var(--cp-text)] disabled:opacity-50"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* 规则表单 */}
        <div className="flex flex-col gap-3.5 px-5 py-4">
          <div>
            <label
              htmlFor="folder-rule-keywords"
              className="block text-xs font-semibold text-[var(--cp-text)]"
            >
              {i18n.t('folderRuleModal.keywordsLabel')}
            </label>
            <textarea
              id="folder-rule-keywords"
              data-testid="folder-rule-keywords-input"
              rows={2}
              value={keywordsText}
              onChange={(e) => setKeywordsText(e.target.value)}
              placeholder={i18n.t('folderRuleModal.keywordsPlaceholder')}
              className="mt-1.5 w-full resize-none rounded border border-[var(--cp-border)] bg-[var(--cp-canvas)] px-2.5 py-2 text-xs text-[var(--cp-text)] placeholder:text-[var(--cp-text-muted)] focus:border-[var(--cp-accent)] focus:outline-none"
            />
            <p className="mt-1 text-[11px] text-[var(--cp-text-muted)]">
              {i18n.t('folderRuleModal.keywordsHint')}
            </p>
          </div>

          <div>
            <label
              htmlFor="folder-rule-tags"
              className="block text-xs font-semibold text-[var(--cp-text)]"
            >
              {i18n.t('folderRuleModal.tagsLabel')}
            </label>
            <input
              id="folder-rule-tags"
              data-testid="folder-rule-tags-input"
              type="text"
              value={tagsText}
              onChange={(e) => setTagsText(e.target.value)}
              placeholder={i18n.t('folderRuleModal.tagsPlaceholder')}
              className="mt-1.5 w-full rounded border border-[var(--cp-border)] bg-[var(--cp-canvas)] px-2.5 py-1.5 text-xs text-[var(--cp-text)] placeholder:text-[var(--cp-text-muted)] focus:border-[var(--cp-accent)] focus:outline-none"
            />
          </div>

          <div>
            <label
              htmlFor="folder-rule-authors"
              className="block text-xs font-semibold text-[var(--cp-text)]"
            >
              {i18n.t('folderRuleModal.authorsLabel')}
            </label>
            <input
              id="folder-rule-authors"
              data-testid="folder-rule-authors-input"
              type="text"
              value={authorsText}
              onChange={(e) => setAuthorsText(e.target.value)}
              placeholder={i18n.t('folderRuleModal.authorsPlaceholder')}
              className="mt-1.5 w-full rounded border border-[var(--cp-border)] bg-[var(--cp-canvas)] px-2.5 py-1.5 text-xs text-[var(--cp-text)] placeholder:text-[var(--cp-text-muted)] focus:border-[var(--cp-accent)] focus:outline-none"
            />
          </div>

          <div>
            <p className="text-xs font-semibold text-[var(--cp-text)]">
              {i18n.t('folderRuleModal.platformsLabel')}
            </p>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {getAllAdapters().map((adapter) => {
                const platform = adapter.id;
                const active = selectedPlatforms.has(platform);
                return (
                  <button
                    key={platform}
                    type="button"
                    data-testid={`folder-rule-platform-${platform}`}
                    aria-pressed={active}
                    onClick={() => togglePlatform(platform)}
                    className={`rounded border px-2 py-1 text-[11px] font-medium transition ${
                      active
                        ? 'border-[var(--cp-accent)] bg-[var(--cp-active)] text-[var(--cp-text-active)]'
                        : 'border-[var(--cp-border)] bg-[var(--cp-canvas)] text-[var(--cp-text-secondary)] hover:border-[var(--cp-border-strong)] hover:text-[var(--cp-text)]'
                    }`}
                  >
                    {platform === 'web'
                      ? i18n.t('platform.web')
                      : platformMeta(platform).label}
                  </button>
                );
              })}
            </div>
            <p className="mt-1 text-[11px] text-[var(--cp-text-muted)]">
              {i18n.t('folderRuleModal.platformsHint')}
            </p>
          </div>
        </div>

        {/* 底部操作 */}
        <div className="flex items-center justify-between gap-2 border-t border-[var(--cp-border)] bg-[var(--cp-canvas)] px-5 py-3">
          <button
            type="button"
            data-testid="folder-rule-clear-btn"
            disabled={submitting}
            onClick={() => void handleSubmit(true)}
            className="rounded px-2.5 py-1.5 text-xs font-medium text-[var(--cp-text-muted)] transition hover:bg-[var(--cp-muted)] hover:text-rose-600 disabled:opacity-50"
          >
            {i18n.t('folderRuleModal.clearRule')}
          </button>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={submitting}
              onClick={onClose}
              className="rounded border border-[var(--cp-border)] bg-[var(--cp-surface)] px-3 py-1.5 text-xs font-medium text-[var(--cp-text-secondary)] transition hover:border-[var(--cp-border-strong)] hover:text-[var(--cp-text)] disabled:opacity-50"
            >
              {i18n.t('common.cancel')}
            </button>
            <button
              type="button"
              data-testid="folder-rule-save-btn"
              disabled={submitting}
              onClick={() => void handleSubmit(false)}
              className="inline-flex items-center gap-1.5 rounded bg-[var(--cp-accent)] px-3.5 py-1.5 text-xs font-semibold text-[var(--cp-on-accent)] transition hover:bg-[var(--cp-accent-hover)] disabled:opacity-60"
            >
              {submitting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              <span>{i18n.t('folderRuleModal.saveRule')}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
