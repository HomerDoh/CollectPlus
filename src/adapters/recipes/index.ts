/**
 * Tier 2 声明式站点规则汇总导出。
 *
 * 新增中轻度站点仅需在 `builtin/` 下添加一份 `*.recipe.ts` 并加入 `BUILTIN_SITE_RECIPES`，
 * 即可自动获得适配器注册、Main World 提取、防盗链 DNR 与管理台展示能力。
 */

import type { PlatformAdapter } from '../../types/adapter.ts';
import { pornhubRecipe } from './builtin/pornhub.recipe.ts';
import { xvideosRecipe } from './builtin/xvideos.recipe.ts';
import { compileRecipeAdapter } from './executor.ts';
import type { SiteRecipe } from './schema.ts';

export type { SiteRecipe } from './schema.ts';
export { compileRecipeAdapter, installRecipeMainHook } from './executor.ts';
export { pornhubRecipe, xvideosRecipe };

export const BUILTIN_SITE_RECIPES: readonly SiteRecipe[] = [
  xvideosRecipe,
  pornhubRecipe,
];

export const BUILTIN_RECIPE_ADAPTERS: readonly PlatformAdapter[] =
  BUILTIN_SITE_RECIPES.map((recipe) => compileRecipeAdapter(recipe));

export function matchBuiltinRecipeByUrl(url: string): SiteRecipe | undefined {
  for (let i = 0; i < BUILTIN_SITE_RECIPES.length; i += 1) {
    const adapter = BUILTIN_RECIPE_ADAPTERS[i];
    if (adapter?.matchesUrl(url)) {
      return BUILTIN_SITE_RECIPES[i];
    }
  }
  return undefined;
}
