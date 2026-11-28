/**
 * 本地文件系统（File System Access API）Vault 存储驱动实现。
 *
 * 将 `FileSystemDirectoryHandle` 封装为标准的 `VaultStorageBackend`，
 * 保持与现有 CollectVault 本地离线存储逻辑 100% 兼容。
 */

import type {
  ScannedVaultMetaEntry,
  VaultAccessMode,
  VaultPermissionStatus,
  VaultStorageBackend,
} from '../../../types/storage-provider.ts';
import { splitRelativePath } from '../../path.ts';

const ITEMS_DIRNAME = 'items';

function isNotFoundError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'NotFoundError';
}

function toWritableBuffer(chunk: Uint8Array): Uint8Array<ArrayBuffer> {
  if (chunk.buffer instanceof ArrayBuffer) {
    return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  }
  const copy = new Uint8Array(chunk.byteLength);
  copy.set(chunk);
  return copy;
}

async function resolveTarget(
  root: FileSystemDirectoryHandle,
  relativePath: string,
  createDirs: boolean,
): Promise<{ parentDir: FileSystemDirectoryHandle; fileName: string } | null> {
  const segments = splitRelativePath(relativePath);
  if (segments.length === 0) {
    throw new Error(`Vault relative path cannot be empty: "${relativePath}"`);
  }

  const fileName = segments[segments.length - 1];
  if (!fileName) {
    throw new Error(`Invalid vault relative path: "${relativePath}"`);
  }

  let currentDir = root;
  try {
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

async function resolveDirectory(
  root: FileSystemDirectoryHandle,
  relativeDir: string,
  createDirs: boolean,
): Promise<FileSystemDirectoryHandle | null> {
  const segments = splitRelativePath(relativeDir);
  let currentDir = root;
  try {
    for (const seg of segments) {
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
  return currentDir;
}

async function readFileFromDir(
  dir: FileSystemDirectoryHandle,
  relativePath: string,
): Promise<File | null> {
  const target = await resolveTarget(dir, relativePath, false);
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

async function scanMetaFilesRecursively(
  dir: FileSystemDirectoryHandle,
  currentRelativeDir: string,
  results: ScannedVaultMetaEntry[],
): Promise<void> {
  for await (const [name, handle] of dir.entries()) {
    if (handle.kind === 'file' && name === 'meta.json') {
      const fileHandle = handle;
      const dirHandle = dir;
      results.push({
        relativeDir: currentRelativeDir,
        readMetaText: async () => {
          const file = await fileHandle.getFile();
          return file.text();
        },
        readRelativeFile: (assetRelativePath: string) =>
          readFileFromDir(dirHandle, assetRelativePath),
      });
    } else if (handle.kind === 'directory') {
      const nextRelativeDir = currentRelativeDir
        ? `${currentRelativeDir}/${name}`
        : name;
      await scanMetaFilesRecursively(handle, nextRelativeDir, results);
    }
  }
}

/** 基于 `FileSystemDirectoryHandle` 的本地目录存储驱动 */
export class LocalFsVaultBackend implements VaultStorageBackend {
  readonly providerId = 'local_fs' as const;
  readonly isRemote = false;
  readonly handle: FileSystemDirectoryHandle;

  constructor(handle: FileSystemDirectoryHandle) {
    this.handle = handle;
  }

  get displayName(): string {
    return this.handle.name || 'CollectVault';
  }

  async queryPermission(
    mode: VaultAccessMode = 'readwrite',
  ): Promise<VaultPermissionStatus> {
    return this.handle.queryPermission({ mode });
  }

  async requestPermission(
    mode: VaultAccessMode = 'readwrite',
  ): Promise<boolean> {
    const current = await this.handle.queryPermission({ mode });
    if (current === 'granted') {
      return true;
    }
    const requested = await this.handle.requestPermission({ mode });
    return requested === 'granted';
  }

  async readFile(relativePath: string): Promise<File | null> {
    return readFileFromDir(this.handle, relativePath);
  }

  async hasFile(relativePath: string): Promise<boolean> {
    const target = await resolveTarget(this.handle, relativePath, false);
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

  async writeTextFile(relativePath: string, content: string): Promise<void> {
    const target = await resolveTarget(this.handle, relativePath, true);
    if (!target) {
      throw new Error(`Failed to resolve vault path: "${relativePath}"`);
    }

    const { parentDir, fileName } = target;
    const fileHandle = await parentDir.getFileHandle(fileName, { create: true });
    const writable = await fileHandle.createWritable();

    try {
      await writable.write(content);
      await writable.close();
    } catch (error) {
      await writable.abort().catch(() => undefined);
      throw error;
    }
  }

  async writeFile(
    relativePath: string,
    sourceFile: File,
    onProgress?: (loadedBytes: number, totalBytes: number) => void,
  ): Promise<void> {
    const target = await resolveTarget(this.handle, relativePath, true);
    if (!target) {
      throw new Error(`Failed to resolve vault path: "${relativePath}"`);
    }

    const { parentDir, fileName } = target;
    const fileHandle = await parentDir.getFileHandle(fileName, { create: true });
    const writable = await fileHandle.createWritable();
    const reader = sourceFile.stream().getReader();
    let closed = false;
    let written = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        if (value && value.byteLength > 0) {
          await writable.write(toWritableBuffer(value));
          written += value.byteLength;
          onProgress?.(written, sourceFile.size);
        }
      }
      await writable.close();
      closed = true;
    } catch (error) {
      await reader.cancel().catch(() => undefined);
      if (!closed) {
        await writable.abort().catch(() => undefined);
      }
      await parentDir.removeEntry(fileName).catch(() => undefined);
      throw error;
    } finally {
      reader.releaseLock();
    }
  }

  async ensureDirectory(relativeDir: string): Promise<void> {
    await resolveDirectory(this.handle, relativeDir, true);
  }

  async hasAnyEntry(relativeDir: string): Promise<boolean> {
    const dir = await resolveDirectory(this.handle, relativeDir, false);
    if (!dir) {
      return false;
    }
    for await (const _entry of dir.entries()) {
      void _entry;
      return true;
    }
    return false;
  }

  async removeDirectory(relativeDir: string): Promise<void> {
    const segments = splitRelativePath(relativeDir);
    if (segments.length === 0) {
      return;
    }
    const leafName = segments[segments.length - 1];
    if (!leafName) {
      return;
    }

    let parentDir = this.handle;
    try {
      for (let i = 0; i < segments.length - 1; i += 1) {
        const seg = segments[i];
        if (!seg) {
          continue;
        }
        parentDir = await parentDir.getDirectoryHandle(seg, { create: false });
      }
      await parentDir.removeEntry(leafName, { recursive: true });
    } catch (error) {
      if (!isNotFoundError(error)) {
        throw error;
      }
    }
  }

  async purgeDirectoryExcept(
    relativeDir: string,
    keepFileNames: ReadonlySet<string>,
  ): Promise<void> {
    const targetDir = await resolveDirectory(this.handle, relativeDir, false);
    if (!targetDir) {
      return;
    }

    const entriesToRemove: Array<{ name: string; kind: 'file' | 'directory' }> =
      [];
    for await (const [name, entry] of targetDir.entries()) {
      if (keepFileNames.has(name)) {
        continue;
      }
      entriesToRemove.push({ name, kind: entry.kind });
    }

    for (const entry of entriesToRemove) {
      try {
        await targetDir.removeEntry(entry.name, {
          recursive: entry.kind === 'directory',
        });
      } catch (error) {
        if (!isNotFoundError(error)) {
          throw error;
        }
      }
    }
  }

  async scanItemMetaFiles(): Promise<ScannedVaultMetaEntry[]> {
    const results: ScannedVaultMetaEntry[] = [];
    try {
      const itemsDir = await this.handle.getDirectoryHandle(ITEMS_DIRNAME, {
        create: false,
      });
      await scanMetaFilesRecursively(itemsDir, ITEMS_DIRNAME, results);
    } catch (error) {
      if (!isNotFoundError(error)) {
        throw error;
      }
    }
    return results;
  }
}

/** 将 `FileSystemDirectoryHandle` 包装为 `LocalFsVaultBackend` */
export function createLocalFsVaultBackend(
  handle: FileSystemDirectoryHandle,
): LocalFsVaultBackend {
  return new LocalFsVaultBackend(handle);
}
