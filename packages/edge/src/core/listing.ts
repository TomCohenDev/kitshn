import { isPreview } from "./agent.ts";
import { type Resource, type ResourceKind, type State, activeShares, isPublicCircle } from "./model.ts";

const LISTED_KINDS: ReadonlySet<ResourceKind> = new Set(["site.static", "site.worker", "site.compose"]);

/**
 * K-1116: the app cards that anyone may open now, for a public list such as the kitshn site. `environments`
 * holds the environment of each card's last finished deploy; a card without one is not listed.
 */
export function listedApps(
  state: State,
  environments: ReadonlyMap<string, string>,
  now: number,
): Array<Resource> {
  return [...state.resources.values()]
    .filter((resource) => {
      const environment = environments.get(resource.id);
      return (
        LISTED_KINDS.has(resource.kind) &&
        environment !== undefined &&
        !isPreview(environment) &&
        resource.addresses.length > 0 &&
        // As in contentAccess: in an "all must match" circle, "everyone" adds nothing.
        activeShares(state, resource, now).some(
          (share) => isPublicCircle(share.circle) && share.circle.match === "any",
        )
      );
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}
