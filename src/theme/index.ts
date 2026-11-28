/**
 * CollectPlus 全局主题状态管理（瑞士极简 · 亮色 / 暗色 / 跟随系统）。
 *
 * - 默认 `'system'`，自动响应系统 `prefers-color-scheme` 变化；
 * - 通过 `chrome.storage.local` 跨扩展页面（Library / Popup）实时同步；
 * - 辅以 `localStorage` 同步首屏读取，避免页面挂载时闪烁。
 */

import { useSyncExternalStore } from 'react';

export type ThemeMode = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

export const UI_THEME_STORAGE_KEY = 'collect_plus_ui_theme' as const;

export interface ThemeSnapshot {
  mode: ThemeMode;
  resolved: ResolvedTheme;
}

const DARK_MEDIA_QUERY = '(prefers-color-scheme: dark)';

let currentMode: ThemeMode = readCachedThemeMode();
let currentResolved: ResolvedTheme = resolveThemeMode(currentMode);
let currentSnapshot: ThemeSnapshot = {
  mode: currentMode,
  resolved: currentResolved,
};
let initialized = false;
let initPromise: Promise<void> | null = null;
const listeners = new Set<() => void>();

export function isThemeMode(value: unknown): value is ThemeMode {
  return value === 'system' || value === 'light' || value === 'dark';
}

function getSystemTheme(): ResolvedTheme {
  if (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia(DARK_MEDIA_QUERY).matches
  ) {
    return 'dark';
  }
  return 'light';
}

export function resolveThemeMode(mode: ThemeMode): ResolvedTheme {
  return mode === 'system' ? getSystemTheme() : mode;
}

function readCachedThemeMode(): ThemeMode {
  try {
    if (typeof localStorage !== 'undefined') {
      const raw = localStorage.getItem(UI_THEME_STORAGE_KEY);
      if (isThemeMode(raw)) {
        return raw;
      }
    }
  } catch {
    // 忽略不可用或受限的 localStorage
  }
  return 'system';
}

function writeCachedThemeMode(mode: ThemeMode): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(UI_THEME_STORAGE_KEY, mode);
    }
  } catch {
    // 忽略写入异常
  }
}

function applyThemeToDocument(mode: ThemeMode, resolved: ResolvedTheme): void {
  if (typeof document === 'undefined' || !document.documentElement) {
    return;
  }
  document.documentElement.dataset.themeMode = mode;
  document.documentElement.dataset.theme = resolved;
  document.documentElement.style.colorScheme = resolved;
}

function commitTheme(mode: ThemeMode): void {
  const resolved = resolveThemeMode(mode);
  const changed = mode !== currentMode || resolved !== currentResolved;
  currentMode = mode;
  currentResolved = resolved;
  applyThemeToDocument(mode, resolved);
  if (changed) {
    currentSnapshot = { mode, resolved };
    for (const listener of listeners) {
      listener();
    }
  }
}

/** 同步将当前缓存主题写入 DOM（在 React 渲染前调用以防首屏闪烁） */
applyThemeToDocument(currentMode, currentResolved);

/** 初始化主题状态并绑定系统配色与跨页面 storage 监听 */
export function initTheme(): Promise<void> {
  if (initialized) {
    return Promise.resolve();
  }
  if (initPromise) {
    return initPromise;
  }

  initPromise = (async () => {
    try {
      if (
        typeof chrome !== 'undefined' &&
        chrome.storage?.local &&
        typeof chrome.storage.local.get === 'function'
      ) {
        const stored = await chrome.storage.local.get(UI_THEME_STORAGE_KEY);
        const saved = stored[UI_THEME_STORAGE_KEY];
        if (isThemeMode(saved)) {
          writeCachedThemeMode(saved);
          commitTheme(saved);
        } else {
          commitTheme(currentMode);
        }
      }
    } catch {
      commitTheme(currentMode);
    }

    if (
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function'
    ) {
      const media = window.matchMedia(DARK_MEDIA_QUERY);
      const handleMediaChange = () => {
        if (currentMode === 'system') {
          commitTheme('system');
        }
      };
      if (typeof media.addEventListener === 'function') {
        media.addEventListener('change', handleMediaChange);
      }
    }

    if (
      typeof chrome !== 'undefined' &&
      chrome.storage?.onChanged &&
      typeof chrome.storage.onChanged.addListener === 'function'
    ) {
      chrome.storage.onChanged.addListener((changes, areaName) => {
        if (areaName !== 'local') {
          return;
        }
        const change = changes[UI_THEME_STORAGE_KEY];
        if (change && isThemeMode(change.newValue)) {
          writeCachedThemeMode(change.newValue);
          commitTheme(change.newValue);
        }
      });
    }

    initialized = true;
  })();

  return initPromise;
}

/** 切换并持久化主题模式（立即生效并广播到所有扩展页面） */
export async function setThemeMode(mode: ThemeMode): Promise<void> {
  writeCachedThemeMode(mode);
  commitTheme(mode);
  try {
    if (
      typeof chrome !== 'undefined' &&
      chrome.storage?.local &&
      typeof chrome.storage.local.set === 'function'
    ) {
      await chrome.storage.local.set({ [UI_THEME_STORAGE_KEY]: mode });
    }
  } catch {
    // 降级为仅本地缓存生效
  }
}

export function getThemeSnapshot(): ThemeSnapshot {
  return currentSnapshot;
}

function subscribeTheme(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** React Hook：订阅当前主题模式与解析后的明暗状态 */
export function useTheme(): ThemeSnapshot {
  return useSyncExternalStore(
    subscribeTheme,
    getThemeSnapshot,
    getThemeSnapshot,
  );
}
