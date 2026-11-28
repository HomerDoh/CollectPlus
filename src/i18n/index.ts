import { useSyncExternalStore } from 'react';
import { i18n as baseI18n } from '#i18n';
import { sendToBackground } from '../types/messages.ts';

export type SupportedLocale = 'zh_CN' | 'en';
export type UiLanguage = 'auto' | SupportedLocale;

export const UI_LANGUAGE_STORAGE_KEY = 'collect_plus_ui_language';

const NAMED_SUBSTITUTION_RE = /\\(\{)|\{([A-Za-z0-9_]+)\}/g;

const localeCache = new Map<SupportedLocale, Record<string, string>>();
let currentLanguage: UiLanguage = 'auto';
let overrideMessages: Record<string, string> | null = null;
let revision = 0;
let initialized = false;
let initPromise: Promise<void> | null = null;
const listeners = new Set<() => void>();

export function isUiLanguage(value: unknown): value is UiLanguage {
  return value === 'auto' || value === 'zh_CN' || value === 'en';
}

function notifyListeners(): void {
  revision += 1;
  for (const listener of listeners) {
    listener();
  }
}

function syncDocumentLang(): void {
  if (typeof document === 'undefined' || !document.documentElement) {
    return;
  }
  if (currentLanguage === 'zh_CN') {
    document.documentElement.lang = 'zh-CN';
  } else if (currentLanguage === 'en') {
    document.documentElement.lang = 'en';
  } else if (typeof chrome !== 'undefined' && typeof chrome.i18n?.getUILanguage === 'function') {
    document.documentElement.lang = chrome.i18n.getUILanguage();
  }
}

function parseChromeMessagesJson(raw: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  if (typeof raw !== 'object' || raw === null) {
    return result;
  }
  for (const [key, entry] of Object.entries(raw)) {
    if (
      typeof entry === 'object' &&
      entry !== null &&
      'message' in entry &&
      typeof (entry as { message: unknown }).message === 'string'
    ) {
      result[key] = (entry as { message: string }).message;
    }
  }
  return result;
}

/** 从扩展内置 `_locales/<locale>/messages.json` 读取并缓存词典（供扩展页与 Background 使用） */
export async function loadLocaleMessagesFromAsset(
  locale: SupportedLocale,
): Promise<Record<string, string>> {
  const cached = localeCache.get(locale);
  if (cached) {
    return cached;
  }
  const url = chrome.runtime.getURL(`_locales/${locale}/messages.json`);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to load locale "${locale}" (HTTP ${res.status})`);
  }
  const parsed = parseChromeMessagesJson(await res.json());
  localeCache.set(locale, parsed);
  return parsed;
}

async function fetchLocaleMessages(
  locale: SupportedLocale,
): Promise<Record<string, string>> {
  const cached = localeCache.get(locale);
  if (cached) {
    return cached;
  }

  const isExtensionOrigin =
    typeof location !== 'undefined' && location.protocol === 'chrome-extension:';
  if (isExtensionOrigin) {
    return loadLocaleMessagesFromAsset(locale);
  }

  const response = await sendToBackground({
    target: 'background',
    type: 'GET_LOCALE_MESSAGES',
    locale,
  });
  if (!response.ok) {
    throw new Error(response.error);
  }
  localeCache.set(locale, response.messages);
  return response.messages;
}

async function applyLanguage(lang: UiLanguage): Promise<void> {
  if (lang === 'auto') {
    currentLanguage = 'auto';
    overrideMessages = null;
    syncDocumentLang();
    notifyListeners();
    return;
  }

  try {
    const messages = await fetchLocaleMessages(lang);
    currentLanguage = lang;
    overrideMessages = messages;
  } catch (error) {
    console.warn(`[Collect+] Failed to load locale "${lang}":`, error);
    currentLanguage = 'auto';
    overrideMessages = null;
  }
  syncDocumentLang();
  notifyListeners();
}

/** 初始化运行时语言偏好并订阅 `chrome.storage.local` 跨上下文同步 */
export async function initI18n(): Promise<void> {
  if (initialized) {
    return;
  }
  if (initPromise) {
    return initPromise;
  }

  initPromise = (async () => {
    if (
      typeof chrome !== 'undefined' &&
      chrome.storage?.local &&
      typeof chrome.storage.local.get === 'function'
    ) {
      try {
        const stored = await chrome.storage.local.get(UI_LANGUAGE_STORAGE_KEY);
        const raw = stored[UI_LANGUAGE_STORAGE_KEY];
        const saved: UiLanguage = isUiLanguage(raw) ? raw : 'auto';
        await applyLanguage(saved);
      } catch {
        syncDocumentLang();
      }

      if (chrome.storage.onChanged) {
        chrome.storage.onChanged.addListener((changes, areaName) => {
          if (areaName !== 'local' || !(UI_LANGUAGE_STORAGE_KEY in changes)) {
            return;
          }
          const nextRaw = changes[UI_LANGUAGE_STORAGE_KEY]?.newValue;
          const nextLang: UiLanguage = isUiLanguage(nextRaw) ? nextRaw : 'auto';
          if (nextLang !== currentLanguage) {
            void applyLanguage(nextLang);
          }
        });
      }
    } else {
      syncDocumentLang();
    }
    initialized = true;
  })();

  return initPromise;
}

export function getUiLanguage(): UiLanguage {
  return currentLanguage;
}

export async function setUiLanguage(lang: UiLanguage): Promise<void> {
  await applyLanguage(lang);
  if (typeof chrome !== 'undefined' && chrome.storage?.local) {
    await chrome.storage.local.set({ [UI_LANGUAGE_STORAGE_KEY]: lang });
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getRevision(): number {
  return revision;
}

/** React 组件订阅语言变更，切换语言时立即重渲染 */
export function useI18nLocale(): UiLanguage {
  useSyncExternalStore(subscribe, getRevision, getRevision);
  return currentLanguage;
}

function formatOverrideMessage(
  rawMessage: string,
  args: readonly unknown[],
): string {
  let sub: unknown[] | undefined;
  let namedSub: Record<string, unknown> | undefined;
  let count: number | undefined;

  for (const arg of args) {
    if (arg == null) {
      continue;
    }
    if (typeof arg === 'number') {
      count = arg;
    } else if (Array.isArray(arg)) {
      sub = arg;
    } else if (typeof arg === 'object') {
      namedSub = arg as Record<string, unknown>;
    }
  }

  let message = rawMessage;
  if (count !== undefined && sub === undefined) {
    sub = [String(count)];
  }
  if (sub && sub.length > 0) {
    for (let i = 0; i < sub.length; i += 1) {
      message = message.replaceAll(`$${i + 1}`, String(sub[i]));
    }
  }
  if (count !== undefined) {
    const plural = message.split(' | ');
    if (plural.length === 2) {
      message = plural[count === 1 ? 0 : 1] ?? message;
    } else if (plural.length === 3) {
      message = plural[count === 0 || count === 1 ? count : 2] ?? message;
    }
  }
  if (namedSub) {
    message = message.replace(
      NAMED_SUBSTITUTION_RE,
      (match, escaped: string | undefined, key: string | undefined) => {
        if (escaped !== undefined) {
          return escaped;
        }
        if (
          key !== undefined &&
          Object.prototype.hasOwnProperty.call(namedSub, key)
        ) {
          return String(namedSub[key]);
        }
        return match;
      },
    );
  }
  return message;
}

const translate = ((key: string, ...args: unknown[]): string => {
  if (overrideMessages !== null) {
    const raw = overrideMessages[key.replaceAll('.', '_')];
    if (raw !== undefined) {
      return formatOverrideMessage(raw, args);
    }
  }
  return (baseI18n.t as (k: string, ...rest: unknown[]) => string)(
    key,
    ...args,
  );
}) as typeof baseI18n.t;

export const i18n: typeof baseI18n = {
  t: translate,
};

/**
 * 动态查询可选词条键（如开放平台 `platform.<id>` 或 Recipe 专属提示键）。
 * 词条缺失或返回空串时返回 `undefined`，便于调用方优雅回退。
 */
export function translateOptionalKey(key: string): string | undefined {
  const trimmedKey = key.trim();
  if (!trimmedKey) {
    return undefined;
  }
  if (overrideMessages !== null) {
    const raw = overrideMessages[trimmedKey.replaceAll('.', '_')];
    return raw && raw.length > 0 ? raw : undefined;
  }
  const translated = (baseI18n.t as (k: string) => string)(trimmedKey);
  if (!translated || translated === trimmedKey) {
    return undefined;
  }
  return translated;
}
