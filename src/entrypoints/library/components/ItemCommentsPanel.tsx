import { useEffect, useState } from 'react';
import {
  FolderKey,
  Loader2,
  MessageSquare,
  RotateCcw,
  ThumbsUp,
} from 'lucide-react';
import {
  readItemAssetFile,
  readItemComments,
  type VaultPermissionStatus,
} from '@/storage/vault.ts';
import type {
  CollectionItemRecord,
  ItemCommentsFile,
} from '@/types/schema.ts';
import { formatCompactCount, formatDateTime } from '../utils/format.ts';

const AVATAR_LOAD_CONCURRENCY = 8;

export interface ItemCommentsPanelProps {
  item: CollectionItemRecord;
  vaultHandle: FileSystemDirectoryHandle | null;
  permissionState: VaultPermissionStatus;
  onRequestVaultAccess: () => Promise<boolean>;
}

function getAvatarInitial(name: string): string {
  const first = Array.from(name.trim())[0];
  return first ? first.toUpperCase() : '?';
}

export function ItemCommentsPanel({
  item,
  vaultHandle,
  permissionState,
  onRequestVaultAccess,
}: ItemCommentsPanelProps) {
  const [loading, setLoading] = useState(true);
  const [needsVaultAuth, setNeedsVaultAuth] = useState(false);
  const [commentsFile, setCommentsFile] = useState<ItemCommentsFile | null>(
    null,
  );
  const [avatarUrlByPath, setAvatarUrlByPath] = useState<
    Readonly<Record<string, string>>
  >({});
  const [reloadTick, setReloadTick] = useState(0);
  const [authorizing, setAuthorizing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const createdUrls: string[] = [];

    const loadCommentsAndAvatars = async () => {
      setLoading(true);
      setNeedsVaultAuth(false);
      setCommentsFile(null);
      setAvatarUrlByPath({});

      try {
        const loaded = await readItemComments(item, vaultHandle);
        if (cancelled) {
          return;
        }

        if (!loaded) {
          const authBlocked =
            Boolean(item.commentsRelativePath) &&
            permissionState !== 'granted' &&
            (vaultHandle !== null || item.syncStatus === 'vault_synced');
          setNeedsVaultAuth(authBlocked);
          return;
        }

        setCommentsFile(loaded);

        const uniqueAvatarPaths = Array.from(
          new Set(
            loaded.comments
              .map((c) => c.avatarRelativePath)
              .filter((p): p is string => typeof p === 'string' && p.length > 0),
          ),
        );

        if (uniqueAvatarPaths.length === 0) {
          return;
        }

        const resolvedMap: Record<string, string> = {};
        let cursor = 0;

        const worker = async (): Promise<void> => {
          while (!cancelled) {
            const idx = cursor;
            cursor += 1;
            const relPath = uniqueAvatarPaths[idx];
            if (!relPath) {
              return;
            }
            try {
              const file = await readItemAssetFile(item, relPath, vaultHandle);
              if (cancelled || !file || file.size === 0) {
                continue;
              }
              const objectUrl = URL.createObjectURL(file);
              createdUrls.push(objectUrl);
              resolvedMap[relPath] = objectUrl;
            } catch {
              // 单个离线头像读取失败时回退至昵称首字占位
            }
          }
        };

        const workers = Array.from(
          { length: Math.min(AVATAR_LOAD_CONCURRENCY, uniqueAvatarPaths.length) },
          () => worker(),
        );
        await Promise.all(workers);

        if (!cancelled) {
          setAvatarUrlByPath(resolvedMap);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    void loadCommentsAndAvatars();

    return () => {
      cancelled = true;
      for (const url of createdUrls) {
        URL.revokeObjectURL(url);
      }
    };
  }, [
    item.id,
    item.relativeDir,
    item.commentsRelativePath,
    item.savedCommentCount,
    item.syncStatus,
    vaultHandle,
    permissionState,
    reloadTick,
  ]);

  const handleAuthorizeAndReload = async () => {
    setAuthorizing(true);
    try {
      const granted = await onRequestVaultAccess();
      if (granted) {
        setReloadTick((prev) => prev + 1);
      }
    } finally {
      setAuthorizing(false);
    }
  };

  if (loading) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2.5 px-5 py-10 text-xs text-slate-400">
        <Loader2 className="h-5 w-5 animate-spin text-indigo-500" />
        <span>正在加载离线评论...</span>
      </div>
    );
  }

  if (needsVaultAuth) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-10 text-center">
        <span className="inline-flex h-11 w-11 items-center justify-center rounded-2xl bg-indigo-50 text-indigo-600">
          <FolderKey className="h-5 w-5" />
        </span>
        <p className="text-xs font-semibold text-slate-800">
          需要授权本地 CollectVault 目录
        </p>
        <p className="max-w-xs text-[11px] leading-relaxed text-slate-500">
          评论与头像已保存在本地同步目录中，授予读取权限后即可离线查看。
        </p>
        <button
          type="button"
          onClick={() => void handleAuthorizeAndReload()}
          disabled={authorizing}
          className="inline-flex items-center gap-1.5 rounded-xl bg-indigo-600 px-3.5 py-2 text-xs font-semibold text-white transition hover:bg-indigo-700 disabled:opacity-60"
        >
          {authorizing ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <FolderKey className="h-3.5 w-3.5" />
          )}
          <span>授权本地目录并加载</span>
        </button>
      </div>
    );
  }

  if (!commentsFile || commentsFile.comments.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 py-12 text-center">
        <span className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-slate-100 text-slate-400">
          <MessageSquare className="h-5 w-5" />
        </span>
        <p className="text-xs font-medium text-slate-600">暂无已保存的离线评论</p>
        <p className="text-[11px] text-slate-400">
          支持离线评论的平台在收藏时将自动同步保存前 100 条评论或回复。
        </p>
        <button
          type="button"
          onClick={() => setReloadTick((prev) => prev + 1)}
          className="mt-1 inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-[11px] font-medium text-slate-600 hover:bg-slate-50"
        >
          <RotateCcw className="h-3 w-3" />
          <span>刷新</span>
        </button>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-slate-100 bg-slate-50/70 px-5 py-2 text-[11px] text-slate-500">
        <span className="font-medium text-slate-700">
          已离线保存 {commentsFile.comments.length} 条评论
        </span>
        {commentsFile.capturedAt > 0 && (
          <span className="tabular-nums text-slate-400">
            抓取于 {formatDateTime(commentsFile.capturedAt)}
          </span>
        )}
      </div>

      <ul
        data-testid="item-comments-list"
        className="flex flex-1 flex-col divide-y divide-slate-100 overflow-y-auto px-5 py-2"
      >
        {commentsFile.comments.map((comment) => {
          const avatarSrc = comment.avatarRelativePath
            ? avatarUrlByPath[comment.avatarRelativePath]
            : undefined;
          return (
            <li
              key={comment.id}
              data-testid="item-comment-row"
              className="flex items-start gap-2.5 py-3"
            >
              {avatarSrc ? (
                <img
                  src={avatarSrc}
                  alt={comment.authorName}
                  className="h-8 w-8 shrink-0 rounded-full border border-slate-200 bg-slate-100 object-cover"
                />
              ) : (
                <span
                  aria-hidden="true"
                  className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-indigo-50 text-xs font-semibold text-indigo-600 ring-1 ring-inset ring-indigo-100"
                >
                  {getAvatarInitial(comment.authorName)}
                </span>
              )}

              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-xs font-semibold text-slate-800">
                    {comment.authorName}
                  </span>
                  <span className="inline-flex shrink-0 items-center gap-1 text-[11px] tabular-nums text-slate-400">
                    <ThumbsUp className="h-3 w-3" />
                    <span>{formatCompactCount(comment.likeCount)}</span>
                  </span>
                </div>

                <p className="mt-1 whitespace-pre-wrap break-words text-xs leading-relaxed text-slate-700">
                  {comment.content}
                </p>

                {comment.createdAt !== undefined && comment.createdAt > 0 && (
                  <p className="mt-1 text-[10px] tabular-nums text-slate-400">
                    {formatDateTime(comment.createdAt)}
                  </p>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
