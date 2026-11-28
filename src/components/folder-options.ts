/**
 * 文件夹树扁平化选项辅助工具（供 Popup、页面浮层与设置页下拉框共用）。
 */

import type { FolderNode } from '../types/schema.ts';

export interface FlatFolderOption {
  id: string;
  name: string;
  label: string;
  depth: number;
}

/** 将树形 FolderNode 列表按层级缩进展平为下拉选项 */
export function flattenFolderOptions(
  folders: readonly FolderNode[],
): FlatFolderOption[] {
  const sorted = [...folders].sort(
    (a, b) => a.sortOrder - b.sortOrder || a.createdAt - b.createdAt,
  );
  const idSet = new Set(sorted.map((folder) => folder.id));
  const childrenByParent = new Map<string | null, FolderNode[]>();

  for (const folder of sorted) {
    const parentKey =
      folder.parentId !== null && idSet.has(folder.parentId)
        ? folder.parentId
        : null;
    const list = childrenByParent.get(parentKey);
    if (list) {
      list.push(folder);
    } else {
      childrenByParent.set(parentKey, [folder]);
    }
  }

  const options: FlatFolderOption[] = [];
  const visit = (parentId: string | null, depth: number) => {
    const list = childrenByParent.get(parentId);
    if (!list) {
      return;
    }
    for (const folder of list) {
      const indent = depth > 0 ? `${'  '.repeat(depth)}└ ` : '';
      options.push({
        id: folder.id,
        name: folder.name,
        label: `${indent}${folder.name}`,
        depth,
      });
      visit(folder.id, depth + 1);
    }
  };

  visit(null, 0);
  return options;
}
