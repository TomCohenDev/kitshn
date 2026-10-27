import { Schema } from "effect";
import type {
  ComposeApp as PublicComposeApp,
  DeployEntry as PublicDeployEntry,
  Recipe as PublicRecipe,
  StaticApp as PublicStaticApp,
} from "./index.ts";

const Name = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9{}-]{0,40}$/));

/** One entry of `deploy` (K-807). The first entry that matches the event wins. */
export const DeployEntry = Schema.Struct({
  on: Schema.Literals(["push", "pull_request"]),
  /** For `push`: the branch. Without it, every branch matches. */
  branch: Schema.optionalKey(Schema.String),
  /** The environment name. `{pr}` becomes the pull request number. */
  name: Name,
  /** The address, one level under a kitshn zone (K-901). Without it, kitshn picks `<repo>[-<name>].<zone>`. */
  address: Schema.optionalKey(Schema.String),
  /** A pull request environment that kitshn removes when the pull request closes (K-904). */
  ephemeral: Schema.optionalKey(Schema.Boolean),
  /** The circle that a new environment starts in (K-807). Without it, the card waits in the tray, private. */
  startsIn: Schema.optionalKey(Schema.String),
});
export type DeployEntry = typeof DeployEntry.Type;

/** K-805: a static site. Actions runs `build`, then uploads `output`. */
export const StaticApp = Schema.Struct({
  build: Schema.optionalKey(Schema.String),
  output: Schema.String,
});

/**
 * K-804, K-812: a Compose app. A machine with all `runsOn` labels builds and runs `file`. The app listens on
 * the socket `$KITSHN_DEFAULT_SOCKET` (K-607), as in KitSHn 1, and the tunnel sends the address there.
 */
export const ComposeApp = Schema.Struct({
  runsOn: Schema.optionalKey(Schema.Array(Schema.String).check(Schema.isMaxLength(10))),
  /** K-818: a path inside the repo; the daemon checks it again after symlinks. */
  file: Schema.optionalKey(
    Schema.String.check(
      Schema.makeFilter((file) =>
        file === "" || file.startsWith("/") || file.split("/").includes("..")
          ? "file must be a path inside the repo"
          : undefined,
      ),
    ),
  ),
});

const deploy = Schema.Array(DeployEntry).check(Schema.isMinLength(1), Schema.isMaxLength(20));

/** K-801, K-804: a recipe has exactly one kind. Worker apps follow later. */
export const Recipe = Schema.Union([
  Schema.Struct({ static: StaticApp, deploy }),
  Schema.Struct({ compose: ComposeApp, deploy }),
]);
export type Recipe = typeof Recipe.Type;

// The public types of index.ts and the schema accept the same recipes; a failing line names the type.
// Strict equality: plain assignability both ways misses a key that is optional on one side only.
type Same<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Keys<T> = T extends unknown ? keyof T : never;
// The schema's deploy is a plain array; the public one is non-empty, so the editor refuses `[]` too.
type Kind<T, K extends string, Never extends string> = {
  readonly [P in keyof Omit<Extract<T, Record<K, unknown>>, Never>]: P extends "deploy"
    ? ReadonlyArray<PublicDeployEntry>
    : Extract<T, Record<K, unknown>>[P];
};
type Assert<T extends true> = T;
export type PublicTypesMatch = [
  Assert<Same<typeof DeployEntry.Type, PublicDeployEntry>>,
  Assert<Same<typeof StaticApp.Type, PublicStaticApp>>,
  Assert<Same<typeof ComposeApp.Type, PublicComposeApp>>,
  Assert<Same<Keys<Recipe>, Keys<PublicRecipe>>>,
  Assert<Same<Extract<Recipe, { static: unknown }>, Kind<PublicRecipe, "static", "compose">>>,
  Assert<Same<Extract<Recipe, { compose: unknown }>, Kind<PublicRecipe, "compose", "static">>>,
  Assert<Same<Pick<Extract<PublicRecipe, { static: PublicStaticApp }>, "compose">, { readonly compose?: never }>>,
  Assert<Same<Pick<Extract<PublicRecipe, { compose: PublicComposeApp }>, "static">, { readonly static?: never }>>,
];

export const decodeRecipe = Schema.decodeUnknownSync(Recipe, { onExcessProperty: "error" });

/** The GitHub event that a deploy runs for. */
export interface DeployEvent {
  readonly name: "push" | "pull_request";
  /** For a push, the branch; for a pull request, its head branch. */
  readonly branch: string;
  readonly pr: number | null;
  /** For a pull request: opened, synchronize, reopened or closed. */
  readonly action: string | null;
}

export type Plan =
  /** Nothing to do for this event. */
  | { readonly kind: "skip"; readonly reason: string }
  /** The recipe has a mistake; the deploy fails and says why (K-006). */
  | { readonly kind: "error"; readonly reason: string }
  | {
      readonly kind: "deploy" | "teardown";
      readonly environment: string;
      readonly address: string;
      readonly ephemeral: boolean;
      readonly startsIn: string | null;
    };

const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

export const repoSlug = (repo: string) =>
  (repo.split("/")[1] ?? repo)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");

/** K-807, K-901: the environment and address of an event, or why kitshn skips it. */
export function plan(recipe: Recipe, repo: string, event: DeployEvent, zone: string): Plan {
  const entry = recipe.deploy.find(
    (item) =>
      item.on === event.name &&
      (item.on !== "push" || item.branch === undefined || item.branch === event.branch),
  );
  if (!entry) return { kind: "skip", reason: `No deploy entry matches ${event.name} on ${event.branch}.` };
  if (event.name === "pull_request" && event.pr === null)
    return { kind: "skip", reason: "The pull request has no number." };
  // A pull request touches only its own preview: the token's number names it, whatever the recipe says (K-811).
  if (event.name === "pull_request" && entry.name !== "pr-{pr}") {
    return { kind: "error", reason: `A pull_request entry must be named "pr-{pr}", not "${entry.name}".` };
  }
  const environment = entry.name.replaceAll("{pr}", String(event.pr ?? ""));
  if (!LABEL.test(environment))
    return { kind: "error", reason: `The environment name "${environment}" is not a valid name.` };
  const slug = repoSlug(repo);
  const label = entry.address?.endsWith(`.${zone}`)
    ? entry.address.slice(0, -zone.length - 1)
    : environment === "prod"
      ? slug
      : `${slug}-${environment}`;
  if (entry.address !== undefined && !entry.address.endsWith(`.${zone}`)) {
    return {
      kind: "error",
      reason: `The address ${entry.address} is not under the kitshn zone ${zone} (K-1111).`,
    };
  }
  // K-901: one level under the zone, so the free Universal SSL certificate covers it.
  if (!LABEL.test(label))
    return {
      kind: "error",
      reason: `The address ${label}.${zone} must be one name of at most 63 letters, digits or dashes under ${zone} (K-901).`,
    };
  const ephemeral = entry.ephemeral === true;
  const closing = event.name === "pull_request" && event.action === "closed";
  if (closing && !ephemeral)
    return { kind: "skip", reason: "The pull request closed; its environment is not ephemeral." };
  return {
    kind: closing ? "teardown" : "deploy",
    environment,
    address: `${label}.${zone}`,
    ephemeral,
    // K-907: a preview starts in Owner unless the recipe names another circle.
    startsIn: entry.startsIn ?? (ephemeral ? "Owner" : null),
  };
}
