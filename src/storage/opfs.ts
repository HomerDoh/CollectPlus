/**
 * OPFS（Origin Private File System）流式暂存引擎。
 *
 * 用于后台静默下载（Offscreen Document）时将大体积视频与图集流式落盘到
 * `collect-plus-stage/{itemId}/...`，避免整文件常驻内存，等待同步到 CollectVault 后自动释放。
 */

import { splitRelativePath } from './path.ts';

const OPFS_STAGE_DIRNAME = 'collect-plus-stage';

function isNotFoundError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'NotFoundError';
}

function assertValidItemId(itemId: string): string {
  const trimmed = itemId.trim();
  if (
    !trimmed ||
    trimmed === '.' ||
    trimmed === '..' ||
    trimmed.includes('/') ||
    trimmed.includes('\\') ||
    trimmed.includes('\0')
  ) {
    throw new Error(`Invalid OPFS itemId: "${itemId}"`);
  }
  return trimmed;
}

function createAbortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) {
    return signal.reason;
  }
  return new DOMException('The operation was aborted.', 'AbortError');
}

/** 确保传入 `FileSystemWritableFileStream.write` 的视图底层为标准 `ArrayBuffer` */
function toWritableBuffer(chunk: Uint8Array): Uint8Array<ArrayBuffer> {
  if (chunk.buffer instanceof ArrayBuffer) {
    return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  }
  const copy = new Uint8Array(chunk.byteLength);
  copy.set(chunk);
  return copy;
}

/** 获取 OPFS 根目录下的专用暂存根目录 `collect-plus-stage/` */
export async function getOpfsStageRoot(): Promise<FileSystemDirectoryHandle> {
  if (
    typeof navigator === 'undefined' ||
    !navigator.storage ||
    typeof navigator.storage.getDirectory !== 'function'
  ) {
    throw new Error('OPFS (navigator.storage.getDirectory) is unavailable.');
  }

  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(OPFS_STAGE_DIRNAME, { create: true });
}

interface ResolvedFileTarget {
  parentDir: FileSystemDirectoryHandle;
  fileName: string;
}

async function resolveItemFileTarget(
  itemId: string,
  relativePath: string,
  createDirs: boolean,
): Promise<ResolvedFileTarget | null> {
  const safeItemId = assertValidItemId(itemId);
  const segments = splitRelativePath(relativePath);
  if (segments.length === 0) {
    throw new Error(`Relative file path cannot be empty: "${relativePath}"`);
  }

  const fileName = segments[segments.length - 1];
  if (!fileName) {
    throw new Error(`Invalid relative file path: "${relativePath}"`);
  }

  const stageRoot = await getOpfsStageRoot();
  let currentDir: FileSystemDirectoryHandle;
  try {
    currentDir = await stageRoot.getDirectoryHandle(safeItemId, {
      create: createDirs,
    });
    for (let i = 0; i < segments.length - 1; i += 1) {
      const seg = segments[i];
      if (!seg) {
        continue;
      }
      currentDir = await currentDir.getDirectoryHandle(seg, {
        create: createDirs,
      });
    }
  } catch (error) {
    if (!createDirs && isNotFoundError(error)) {
      return null;
    }
    throw error;
  }

  return { parentDir: currentDir, fileName };
}

/**
 * 将 `ReadableStream<Uint8Array>` 流式写入 OPFS `collect-plus-stage/{itemId}/{relativePath}`。
 *
 * - 支持增量字节进度回调与 `AbortSignal` 中止；
 * - 中止或发生 I/O 异常时主动 abort 写入流并清理残缺文件，绝不保留损坏脏文件。
 */
export async function writeStreamToOpfs(
  itemId: string,
  relativePath: string,
  stream: ReadableStream<Uint8Array>,
  onProgressBytes?: (deltaBytes: number) => void,
  signal?: AbortSignal,
): Promise<number> {
  if (signal?.aborted) {
    throw createAbortError(signal);
  }

  const target = await resolveItemFileTarget(itemId, relativePath, true);
  if (!target) {
    throw new Error(`Failed to create OPFS directory for ${relativePath}`);
  }

  const { parentDir, fileName } = target;
  const fileHandle = await parentDir.getFileHandle(fileName, { create: true });
  const writable = await fileHandle.createWritable();
  const reader = stream.getReader();

  let totalBytes = 0;
  let closed = false;

  const onAbort = (): void => {
    void reader.cancel(signal?.reason).catch(() => undefined);
  };
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    while (true) {
      if (signal?.aborted) {
        throw createAbortError(signal);
      }

      const { done, value } = await reader.read();

      if (signal?.aborted) {
        throw createAbortError(signal);
      }

      if (done) {
        break;
      }

      if (value && value.byteLength > 0) {
        await writable.write(toWritableBuffer(value));
        totalBytes += value.byteLength;
        onProgressBytes?.(value.byteLength);
      }
    }

    await writable.close();
    closed = true;
    return totalBytes;
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    if (!closed) {
      await writable.abort().catch(() => undefined);
    }
    await parentDir.removeEntry(fileName).catch(() => undefined);
    throw error;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }
}

/** 将 `Blob` 写入 OPFS `collect-plus-stage/{itemId}/{relativePath}` */
export async function writeBlobToOpfs(
  itemId: string,
  relativePath: string,
  blob: Blob,
): Promise<number> {
  const target = await resolveItemFileTarget(itemId, relativePath, true);
  if (!target) {
    throw new Error(`Failed to create OPFS directory for ${relativePath}`);
  }

  const { parentDir, fileName } = target;
  const fileHandle = await parentDir.getFileHandle(fileName, { create: true });
  const writable = await fileHandle.createWritable();

  try {
    await writable.write(blob);
    await writable.close();
    return blob.size;
  } catch (error) {
    await writable.abort().catch(() => undefined);
    await parentDir.removeEntry(fileName).catch(() => undefined);
    throw error;
  }
}

/** 从 OPFS 读取指定条目的暂存文件，不存在时返回 `null` */
export async function readFileFromOpfs(
  itemId: string,
  relativePath: string,
): Promise<File | null> {
  const target = await resolveItemFileTarget(itemId, relativePath, false);
  if (!target) {
    return null;
  }

  try {
    const fileHandle = await target.parentDir.getFileHandle(target.fileName, {
      create: false,
    });
    return await fileHandle.getFile();
  } catch (error) {
    if (isNotFoundError(error)) {
      return null;
    }
    throw error;
  }
}

/** 判断指定条目的暂存文件是否存在于 OPFS 中 */
export async function hasFileInOpfs(
  itemId: string,
  relativePath: string,
): Promise<boolean> {
  const target = await resolveItemFileTarget(itemId, relativePath, false);
  if (!target) {
    return false;
  }

  try {
    await target.parentDir.getFileHandle(target.fileName, { create: false });
    return true;
  } catch (error) {
    if (isNotFoundError(error)) {
      return false;
    }
    throw error;
  }
}

/** 递归删除指定条目在 OPFS 暂存区中的全部文件（不存在时静默忽略） */
export async function removeItemFromOpfs(itemId: string): Promise<void> {
  const safeItemId = assertValidItemId(itemId);
  const stageRoot = await getOpfsStageRoot();

  try {
    await stageRoot.removeEntry(safeItemId, { recursive: true });
  } catch (error) {
    if (!isNotFoundError(error)) {
      throw error;
    }
  }
}

async function computeDirectoryBytes(
  dir: FileSystemDirectoryHandle,
): Promise<number> {
  let total = 0;
  for await (const [, handle] of dir.entries()) {
    if (handle.kind === 'file') {
      const file = await handle.getFile();
      total += file.size;
    } else if (handle.kind === 'directory') {
      total += await computeDirectoryBytes(handle);
    }
  }
  return total;
}

/** 计算指定条目在 OPFS 暂存区占用的总字节数 */
export async function getOpfsItemUsageBytes(itemId: string): Promise<number> {
  const safeItemId = assertValidItemId(itemId);
  const stageRoot = await getOpfsStageRoot();

  try {
    const itemDir = await stageRoot.getDirectoryHandle(safeItemId, {
      create: false,
    });
    return await computeDirectoryBytes(itemDir);
  } catch (error) {
    if (isNotFoundError(error)) {
      return 0;
    }
    throw error;
  }
}

/** 计算整个 OPFS 暂存根目录 `collect-plus-stage/` 占用的总字节数 */
export async function getOpfsTotalUsageBytes(): Promise<number> {
  try {
    const stageRoot = await getOpfsStageRoot();
    return await computeDirectoryBytes(stageRoot);
  } catch (error) {
    if (isNotFoundError(error)) {
      return 0;
    }
    return 0;
  }
}

/** 浏览器侧存储空间占用统计 */
export interface BrowserStorageEstimate {
  /** 浏览器为当前扩展源估算的总占用（IndexedDB + OPFS 等，字节） */
  totalUsageBytes: number;
  /** 浏览器为当前扩展源分配的总配额（字节，不可用时为 0） */
  quotaBytes: number;
  /** OPFS 暂存区媒体文件精确占用（字节） */
  opfsBytes: number;
  /** 扣除 OPFS 后估算的 IndexedDB 索引与缩略图缓存占用（字节） */
  indexCacheBytes: number;
}

/** 获取浏览器侧总存储占用、OPFS 暂存体积与估算索引缓存大小 */
export async function getBrowserStorageEstimate(): Promise<BrowserStorageEstimate> {
  const [estimate, opfsBytes] = await Promise.all([
    typeof navigator !== 'undefined' &&
    navigator.storage &&
    typeof navigator.storage.estimate === 'function'
      ? navigator.storage.estimate().catch(() => ({ usage: 0, quota: 0 }))
      : Promise.resolve({ usage: 0, quota: 0 }),
    getOpfsTotalUsageBytes(),
  ]);

  const rawUsage =
    typeof estimate.usage === 'number' && Number.isFinite(estimate.usage)
      ? Math.max(0, estimate.usage)
      : 0;
  const quotaBytes =
    typeof estimate.quota === 'number' && Number.isFinite(estimate.quota)
      ? Math.max(0, estimate.quota)
      : 0;
  const totalUsageBytes = Math.max(rawUsage, opfsBytes);
  const indexCacheBytes = Math.max(0, totalUsageBytes - opfsBytes);

  return {
    totalUsageBytes,
    quotaBytes,
    opfsBytes,
    indexCacheBytes,
  };
}
