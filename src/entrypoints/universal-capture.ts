/**
 * Tier 1 通用全网采集按需注入脚本（WXT Unlisted Script -> `universal-capture.js`）。
 *
 * 零 React、零常驻开销：仅在用户在任意未注册网页触发采集时，
 * 由 Background 通过 `chrome.scripting.executeScript` 按需注入并调用全局提取函数。
 */

import {
  extractUniversalPageData,
  type UniversalRawPageData,
} from '../adapters/universal/extractor.ts';

export const UNIVERSAL_EXTRACT_GLOBAL_KEY =
  '__COLLECT_PLUS_EXTRACT_UNIVERSAL__' as const;

interface UniversalExtractGlobal {
  [UNIVERSAL_EXTRACT_GLOBAL_KEY]?: () => UniversalRawPageData | null;
}

export default defineUnlistedScript(() => {
  const globalObj = globalThis as unknown as UniversalExtractGlobal;
  globalObj[UNIVERSAL_EXTRACT_GLOBAL_KEY] = () =>
    extractUniversalPageData(document, window.location.href);
});
