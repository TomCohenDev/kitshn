/**
 * The public face of a recipe (K-801). It has no imports, so its `.d.ts` stands alone for the editor of an
 * app repository. `recipe.ts` checks at compile time that the schema accepts the same values.
 */

/** One entry of `deploy` (K-807). The first entry that matches the event wins. */
export interface DeployEntry {
  readonly on: "push" | "pull_request";
  /** For `push`: the branch. Without it, every branch matches. */
  readonly branch?: string;
  /** The environment name: lowercase letters, digits and `-`. `{pr}` becomes the pull request number. */
  readonly name: string;
  /**
   * The address, one level under a kitshn zone (K-901). Without it, kitshn picks `<repo>[-<name>].<zone>`. A `push`
   * entry may list up to 5 addresses (K-817): the first under the kitshn zone is the main one, and each other is the
   * apex or one name under a zone that kitshn publishes on. All serve the app.
   */
  readonly address?: string | ReadonlyArray<string>;
  /** A pull request environment that kitshn removes when the pull request closes (K-904). */
  readonly ephemeral?: boolean;
  /** The circle that a new environment starts in (K-807). Without it, the card waits in the tray, private. */
  readonly startsIn?: string;
}

/** K-805: a static site. Actions runs `build`, then uploads `output`. */
export interface StaticApp {
  readonly build?: string;
  readonly output: string;
}

/** K-804, K-812: a Compose app. A machine with all `runsOn` labels builds and runs `file`. */
export interface ComposeApp {
  /** At most 10 machine labels. */
  readonly runsOn?: ReadonlyArray<string>;
  /** The Compose file, a path inside the repo. Without it, kitshn takes the file names that Compose finds. */
  readonly file?: string;
}

/** 1 to 20 entries. */
type Deploy = readonly [DeployEntry, ...Array<DeployEntry>];

/** K-801, K-804: a recipe has exactly one kind: `static` or `compose`. */
export type Recipe =
  | { readonly static: StaticApp; readonly compose?: never; readonly deploy: Deploy }
  | { readonly compose: ComposeApp; readonly static?: never; readonly deploy: Deploy };

/**
 * K-801: the one export of `kitshn.config.ts`. The value is one object literal; `kitshn check` refuses
 * anything that computes (K-802), because kitshn reads the recipe without running it (K-803).
 */
export const defineApp = (recipe: Recipe): Recipe => recipe;
