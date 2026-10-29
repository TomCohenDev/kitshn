import { isPreview } from "./agent.ts";
import { type CardKind, type Resource, type State, activeShares, isPublicCircle } from "./model.ts";

const LISTED_KINDS: ReadonlySet<CardKind> = new Set(["site.static", "site.worker", "site.compose"]);
const DOWN: ReadonlySet<Resource["status"]> = new Set(["offline", "stopped", "failed"]);

/** K-1118, K-1119: anyone may open the card now. As in contentAccess: in an "all must match" circle, "everyone" adds nothing. */
export const openToEveryone = (state: State, resource: Resource, now: number) =>
  activeShares(state, resource, now).some(
    (share) => isPublicCircle(share.circle) && share.circle.match === "any",
  );

/**
 * K-1118: the app cards that anyone may open now and that are not down, for a public list such as the kitshn
 * site. `environmentOf` gives the environment of a card's last finished deploy, or null; a card without one is
 * not listed. It runs only for cards that pass every other check.
 */
export function listedApps(
  state: State,
  environmentOf: (id: string) => string | null,
  now: number,
): Array<Resource> {
  return [...state.resources.values()]
    .filter((resource) => {
      if (!LISTED_KINDS.has(resource.kind) || resource.addresses.length === 0 || DOWN.has(resource.status))
        return false;
      if (!openToEveryone(state, resource, now)) return false;
      const environment = environmentOf(resource.id);
      return environment !== null && !isPreview(environment);
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}
