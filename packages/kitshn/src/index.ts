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

/**
 * K-806: a Worker app. kitshn bundles `main` with esbuild and gives each environment its own name, addresses and
 * storage, so the recipe names none of them. A binding name is a JavaScript identifier, unique in the app.
 */
export interface WorkerApp {
  /** The entry module, a path inside the repo. */
  readonly main: string;
  /** `YYYY-MM-DD`. */
  readonly compatibilityDate: string;
  /** At most 20. */
  readonly compatibilityFlags?: ReadonlyArray<string>;
  /** Runs before the bundle, as for a static site. */
  readonly build?: string;
  /** Static files that the Worker serves through the binding `ASSETS` (K-805 rules for `_headers` and `_redirects`). */
  readonly assets?: {
    /** A folder inside the repo. */
    readonly folder: string;
    /** `true`, or path patterns such as `/api/*`, that reach the Worker before the files. */
    readonly runWorkerFirst?: boolean | ReadonlyArray<string>;
  };
  /** KV binding names, at most 10. Each environment gets its own namespace. */
  readonly kv?: ReadonlyArray<string>;
  /** Durable Object binding names to the class that `main` exports, at most 10. Each class uses SQLite storage. */
  readonly durableObjects?: { readonly [binding: string]: string };
  /** Cron expressions, at most 3. Only push environments run them, never previews. */
  readonly crons?: ReadonlyArray<string>;
  /** Plain text values, at most 50. Secrets come from `KITSHN_<NAME>` (K-808), never from the recipe. */
  readonly vars?: { readonly [name: string]: string };
}

/** 1 to 20 entries. */
type Deploy = readonly [DeployEntry, ...Array<DeployEntry>];

/** K-801, K-804: a recipe has exactly one kind: `static`, `compose` or `worker`. */
export type Recipe =
  | { readonly static: StaticApp; readonly compose?: never; readonly worker?: never; readonly deploy: Deploy }
  | {
      readonly compose: ComposeApp;
      readonly static?: never;
      readonly worker?: never;
      readonly deploy: Deploy;
    }
  | {
      readonly worker: WorkerApp;
      readonly static?: never;
      readonly compose?: never;
      readonly deploy: Deploy;
    };

/**
 * K-801: the one export of `kitshn.config.ts`. The value is one object literal; `kitshn check` refuses
 * anything that computes (K-802), because kitshn reads the recipe without running it (K-803).
 */
export const defineApp = (recipe: Recipe): Recipe => recipe;
