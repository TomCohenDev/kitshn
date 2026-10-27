import type { Recipe } from "./recipe.ts";

export type { DeployEntry, Recipe } from "./recipe.ts";

/**
 * K-801: the one export of `kitshn.config.ts`. The value is one object literal; `kitshn check` refuses
 * anything that computes (K-802), because kitshn reads the recipe without running it (K-803).
 */
export const defineApp = (recipe: Recipe): Recipe => recipe;
